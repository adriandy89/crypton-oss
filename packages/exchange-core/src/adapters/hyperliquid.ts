import { setMaxListeners } from 'node:events';
import { Observable, Subject, share, takeUntil } from 'rxjs';
import { Wallet } from 'ethers';
import {
  D,
  Decimal,
  ExchangeError,
  firstNum,
  OrderStatus,
  Venue,
  type Balance,
  type Candle,
  type CandleInterval,
  type MarketTicker,
  type VenueCapabilities,
  type CancelRequest,
  type Fill,
  type MarginAction,
  type MarginMode,
  type MarketSpec,
  type ModifyRequest,
  type OrderAck,
  type OrderUpdate,
  type PlaceOrderRequest,
  type Position,
  type PositionSide,
  type Ticker,
  type VenueOrder,
  roundPriceForSide,
} from '@crypton/shared';
import { changePct, checkInterval, finishCandles, num, numOrNull, resolveRange } from '../candles';
import { HL_INTERVALS, VENUE_CAPABILITIES } from '../capabilities';
import { hyperliquidCodec } from '../coid';
import { VenueCooldown } from '../cooldown';
import { toExchangeError } from '../errors';
import { MarketSpecCache, canonicalSymbol } from '../market-cache';
import { RateLimiter, withRetry, withWriteRetry } from '../rate-limit';
import { NO_BUDGET, type BudgetPriority, type VenueBudget } from '../venue-budget';
import { hyperliquidWeight } from '../venue-weights';
import type {
  AdapterOptions,
  CandleQuery,
  ExchangeAdapter,
  StreamHealth,
  VenueCredentials,
} from '../types';

/**
 * El SDK de Hyperliquid se publica SOLO como ESM y el backend compila a
 * CommonJS, así que se carga con `require()` —que Node soporta para módulos ESM
 * sin top-level await desde la 22.12; de ahí el `engines.node` del monorepo.
 *
 * La carga es PEREZOSA, y no por optimizar: el runtime de Jest no implementa
 * `require(esm)`, de modo que hacerlo al importar el módulo rompería cualquier
 * test que solo quisiera usar los helpers puros de este fichero. Con `import
 * type` los tipos se borran en compilación y no arrastran nada en runtime.
 */
import type * as HL from '@nktkas/hyperliquid';

let sdk: typeof HL | null = null;
const hl = (): typeof HL => {
  // Carga perezosa a proposito: el SDK es ESM y el runtime de Jest no
  // implementa `require(esm)`, asi que importarlo arriba romperia todo test que
  // solo quisiera los helpers puros de este fichero. Ver la nota de cabecera.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sdk ??= require('@nktkas/hyperliquid') as typeof HL;
  return sdk;
};

type HlCreds = Extract<VenueCredentials, { venue: 'HYPERLIQUID' }>;

/**
 * Lo que devuelve el SDK al suscribirse: un asa con la que darse de baja.
 *
 * Se nombra aquí y no se escribe en línea porque ahora la usan tres sitios —el
 * registro, la lista de abiertas y el cierre por contador— y lo que importa de
 * ella es exactamente eso: que se puede soltar UNA sin cerrar el transporte.
 */
type HlSubscription = { unsubscribe: () => Promise<unknown> };
type AssetCtx = Awaited<ReturnType<HL.InfoClient['metaAndAssetCtxs']>>[1][number];

/** Cuánto vive el contexto de activos memoizado (`markPx` y compañía). */
const ASSET_CTX_TTL_MS = 2_000;
/**
 * Tope de la comisión de builder en perps: 0,1 % = 100 décimas de punto básico.
 * Un valor fuera de rango no se «corrige» en silencio ni hace rechazar la orden
 * entera: se omite el builder (001/F-16).
 */
const BUILDER_FEE_MAX_TENTH_BPS = 100;

/** Mínimo de valor por orden que impone Hyperliquid en perps. */
const MIN_NOTIONAL_USD = '10';

/**
 * Oyentes por canal que damos por normales en el bus del SDK.
 *
 * Uno por símbolo suscrito. Doscientos son muchos más pares de los que enseña
 * cualquier pantalla a la vez, así que si se supera, el aviso de Node vuelve a
 * significar algo. Ver `raiseListenerCap`.
 */
const MAX_STREAM_LISTENERS = 200;
/** Los perps admiten como mucho 6 decimales menos los del tamaño. */
const PERP_MAX_DECIMALS = 6;

/**
 * Hyperliquid no publica un tick fijo: acepta como mucho 5 cifras
 * significativas y (6 − szDecimals) decimales. El tick efectivo depende, por
 * tanto, de la MAGNITUD del precio — a 3.000 el paso mínimo es 0,1 y a 0,3 es
 * 0,00001. Se calcula aquí para poder rellenar `tickSize` con algo que el resto
 * del sistema pueda tratar como una retícula normal.
 */
export function hyperliquidTickSize(price: Decimal, szDecimals: number): Decimal {
  const maxDecimals = Math.max(0, PERP_MAX_DECIMALS - szDecimals);
  const decimalCap = D(10).pow(-maxDecimals);
  if (price.lte(0)) return decimalCap;
  const magnitude = Math.floor(Math.log10(price.toNumber()));
  const sigFigCap = D(10).pow(magnitude - 4); // 5 cifras significativas
  return Decimal.max(sigFigCap, decimalCap);
}

/**
 * ¿Esta ejecución la provocó una liquidación del venue?
 *
 * Hyperliquid lo dice en `dir`, el mismo campo que su interfaz usa para
 * etiquetar la fila: «Open Long», «Close Short», «Liquidated Isolated Long»…
 * Se lee con un cast porque el tipo del SDK no lo declara, y se compara sin
 * acentos ni mayúsculas por si cambian la redacción — lo que no va a cambiar es
 * la raíz de la palabra.
 *
 * Importa acertar: es lo único que autoriza al motor a atribuir por símbolo una
 * ejecución que no lleva id de orden nuestra. Un falso positivo le colgaría a un
 * bot un movimiento que no es suyo.
 */
export function esLiquidacionHl(fill: unknown): boolean {
  const dir = (fill as { dir?: unknown }).dir;
  return typeof dir === 'string' && dir.toLowerCase().includes('liquidat');
}

export class HyperliquidAdapter implements ExchangeAdapter {
  readonly venue = Venue.HYPERLIQUID;

  readonly capabilities: VenueCapabilities = VENUE_CAPABILITIES[Venue.HYPERLIQUID];

  private readonly info: HL.InfoClient;
  private readonly httpTransport: HL.HttpTransport;
  /**
   * Red del venue. Hyperliquid es el único de los tres que no recibe una URL:
   * su SDK conoce las dos y solo quiere un booleano. Se resuelve UNA vez, en el
   * constructor, porque lo consultan dos transportes distintos —el HTTP, ya, y
   * el de WebSocket, más tarde— y dos lecturas separadas de la fuente podrían
   * discrepar.
   */
  private readonly isTestnet: boolean;
  /**
   * El transporte de WebSocket se GUARDA. Antes era un `const` local del
   * constructor, de modo que `close()` podía dar de baja las suscripciones pero
   * no cerrar la conexión: cada reinicio de un bot filtraba un socket, y
   * Hyperliquid corta a las **10** conexiones por IP, no a las 100 que decía
   * este comentario. La documentación oficial: «Maximum of 10 websocket
   * connections», con 30 nuevas por minuto y un máximo de 10 usuarios distintos
   * entre las suscripciones de usuario. Compartir no era una optimización: con
   * el número real es la única forma de que esto funcione.
   */
  /**
   * Transporte y cliente de suscripción, creados al PRIMER stream.
   *
   * Construirlos abría ya una conexión, y eso se pagaba aunque nadie fuera a
   * suscribirse a nada: la API guarda un adaptador público por venue de forma
   * permanente y jamás usa los streams de Hyperliquid — se quedaba una de las
   * diez conexiones ocupada para siempre sin entregar un solo dato. Es el mismo
   * motivo por el que el firmante también es perezoso.
   */
  private wsTransportLazy?: HL.WebSocketTransport;
  private subsLazy?: HL.SubscriptionClient;
  /**
   * Cliente de suscripciones, creado al primer stream. Ver `wsTransportLazy`.
   */
  private get subs(): HL.SubscriptionClient {
    if (!this.subsLazy) {
      this.wsTransportLazy = new (hl().WebSocketTransport)({
        isTestnet: this.isTestnet,
      });
      this.subsLazy = new (hl().SubscriptionClient)({ transport: this.wsTransportLazy });
      this.raiseListenerCap(this.wsTransportLazy);
    }
    return this.subsLazy;
  }

  /**
   * Sube el tope de oyentes del bus de eventos del SDK.
   *
   * Sin esto, en producción aparece:
   *
   *   MaxListenersExceededWarning: Possible EventTarget memory leak detected.
   *   11 bbo listeners added to HyperliquidEventTarget.
   *
   * Y NO es una fuga. El SDK registra un oyente del canal `bbo` por cada
   * símbolo suscrito y lo quita en `unsubscribe()` —comprobado en su
   * `_subscriptionManager`—, así que once oyentes significa once pares mirados
   * a la vez. La lista de mercados de la app mira bastantes más. El diez es el
   * valor por defecto de Node para `EventTarget`, pensado como detector de
   * fugas, y aquí solo está midiendo un abanico legítimo.
   *
   * El tope no se quita, se SUBE: dejarlo en infinito convertiría el aviso en
   * ruido permanente y perderíamos el detector. Por encima de este número sí
   * habría que mirar, porque son muchos más pares de los que ninguna pantalla
   * enseña a la vez, y el propio Hyperliquid corta en 1000 suscripciones por IP.
   *
   * Se toca un campo privado del SDK a sabiendas: es la única forma de llegar a
   * su `EventTarget`. Si algún día lo renombra, esto deja de hacer efecto y
   * vuelve el aviso — molesto, pero sin romper nada.
   */
  private raiseListenerCap(transport: HL.WebSocketTransport): void {
    const bus = (transport as unknown as { _hlEvents?: EventTarget })._hlEvents;
    if (bus) setMaxListeners(MAX_STREAM_LISTENERS, bus);
  }

  /** Cliente de firma. Se crea al primer uso; ver el getter `exchange`. */
  private signingClient?: HL.ExchangeClient;
  private readonly limiter: RateLimiter;
  private readonly budget: VenueBudget;
  private readonly markets: MarketSpecCache;
  private readonly assetIndex = new Map<string, number>();

  private readonly orders$ = new Subject<OrderUpdate>();
  private readonly fills$ = new Subject<Fill>();
  /**
   * El flujo COMPARTIDO por símbolo, no un `Subject` cacheado para siempre.
   *
   * Guardaba un `Subject` que solo se completaba en `close()`, y con él una
   * suscripción `bbo` en el venue que tampoco se soltaba nunca: visitar cien
   * pares dejaba cien suscripciones vivas hasta reiniciar el proceso, contra el
   * límite que Hyperliquid cuenta por IP. Ahora es un Observable con contador
   * de referencias —el primero que se suscribe abre, el último que se va
   * cierra— y el flujo se guarda solo para que dos interesados compartan uno.
   */
  private readonly tickers = new Map<string, Observable<Ticker>>();
  /** Clave `symbol|interval`: una suscripción por par y resolución, no por bot. */
  private readonly candles = new Map<string, Observable<Candle>>();
  /**
   * Memo con vida corta para las dos lecturas de CUENTA.
   *
   * `clearinghouseState` sirve a la vez posiciones y saldo, y
   * `frontendOpenOrders` devuelve las órdenes de TODOS los símbolos: pedirlas
   * una vez por bot era pagar varias veces por el mismo dato. Importa más de lo
   * que parece: en Hyperliquid las lecturas de usuario pesan 20 de los 1200 por
   * minuto que da la IP, así que cada llamada de más aquí es ~2 % del
   * presupuesto total.
   */
  private readonly accountMemo = new Map<string, { at: number; value: Promise<unknown> }>();
  private streamRetryTimer: NodeJS.Timeout | null = null;
  /**
   * Los fallos de socket salen POR AQUÍ y nunca por `error()` sobre los
   * Subject de datos: un Subject con error queda cerrado para siempre, y con él
   * se perdía toda posibilidad de que una reconexión volviera a entregar fills.
   */
  private readonly health$ = new Subject<StreamHealth>();
  private readonly openSubs: HlSubscription[] = [];
  /** Enfriamiento tras un throttle, como en Lighter y Aster (001/F-28). */
  private readonly cooldown = new VenueCooldown(Venue.HYPERLIQUID);
  private ctxMemo: { at: number; value: Promise<Map<string, AssetCtx>> } | null = null;
  private streamsStarted = false;
  private closed = false;
  /**
   * Se dispara en `close()` y completa todos los flujos compartidos.
   *
   * Antes lo hacía un bucle sobre los `Subject` guardados. Con flujos
   * compartidos no hay `Subject` que completar, pero el aviso sigue haciendo
   * falta: quien esté suscrito tiene que enterarse de que este adaptador ya no
   * va a entregar nada más.
   */
  private readonly closed$ = new Subject<void>();

  constructor(
    private readonly creds: HlCreds,
    private readonly opts: AdapterOptions = {},
  ) {
    // La red la manda `opts.testnet`, que sale de la columna de la cuenta. El
    // `|| creds.testnet` no es redundante: las cuentas creadas antes de que la
    // red viviera en las opciones la llevan DENTRO del sobre cifrado, y volver a
    // abrirlas para migrarlo costaría descifrar la clave de todo el mundo.
    this.isTestnet = opts.testnet === true || creds.testnet === true;
    this.httpTransport = new (hl().HttpTransport)({ isTestnet: this.isTestnet });
    this.info = new (hl().InfoClient)({ transport: this.httpTransport });

    this.limiter = new RateLimiter(opts.rateLimitPerSecond ?? 10);
    this.budget = opts.budget ?? NO_BUDGET;
    this.markets = new MarketSpecCache(() => this.loadMarkets());
  }

  /**
   * Cliente que firma, creado la primera vez que hace falta.
   *
   * Antes se construía en el constructor, de modo que instanciar un adaptador
   * —aunque fuera solo para leer un precio, que es información pública— metía
   * la clave privada en memoria. Ahora un adaptador público
   * (`createPublicAdapter`) nunca llega aquí, y si algo intenta firmar sin
   * credencial falla con un motivo claro en vez de con un error críptico de la
   * librería de wallets.
   */
  private get exchange(): HL.ExchangeClient {
    if (!this.signingClient) {
      if (!this.creds.agentPrivateKey) {
        throw new Error('Adaptador de Hyperliquid sin credenciales: no puede firmar.');
      }
      // La clave que firma es la de la API WALLET (agent), nunca la principal:
      // una agent no puede retirar fondos, solo operar.
      this.signingClient = new (hl().ExchangeClient)({
        transport: this.httpTransport,
        wallet: new Wallet(this.creds.agentPrivateKey),
      });
    }
    return this.signingClient;
  }

  // ═══════════════════════════════════════════════════════════════
  // Metadatos y estado
  // ═══════════════════════════════════════════════════════════════

  private async loadMarkets(): Promise<MarketSpec[]> {
    const [meta, ctxs] = await this.call(() => this.info.metaAndAssetCtxs(), 20);
    return meta.universe.map((asset, index) => {
      this.assetIndex.set(asset.name, index);
      const ctx = ctxs[index];
      const mid = firstNum(ctx?.midPx, ctx?.markPx, 0);
      const tick = hyperliquidTickSize(mid, asset.szDecimals);
      const step = D(10).pow(-asset.szDecimals);
      return {
        venue: Venue.HYPERLIQUID,
        symbol: asset.name,
        canonical: canonicalSymbol(asset.name, 'USDC'),
        base: asset.name,
        quote: 'USDC',
        tickSize: tick.toFixed(),
        stepSize: step.toFixed(),
        minNotional: MIN_NOTIONAL_USD,
        minQty: step.toFixed(),
        maxQty: null,
        maxLeverage: asset.maxLeverage,
        // «The maintenance margin is half of the initial margin at max
        // leverage» (docs, Margining). Antes la estimación usaba un 0,5 % plano,
        // optimista en cualquier par con menos de 100x (001/F-93).
        maintenanceMarginRate: asset.maxLeverage > 0 ? 1 / (2 * asset.maxLeverage) : null,
        priceDecimals: Math.max(0, -Math.floor(Math.log10(tick.toNumber()))),
        qtyDecimals: asset.szDecimals,
        active: asset.isDelisted !== true,
        // «Prices can have up to 5 significant figures»: la regla vive en la
        // puerta de redondeo compartida, así la estrategia y este adaptador
        // calculan el mismo precio (001/F-04).
        maxSignificantDigits: 5,
      } satisfies MarketSpec;
    });
  }

  /**
   * ¿Es esta credencial la que dice ser?
   *
   * Antes era UNA llamada a `clearinghouseState`, que es información PÚBLICA:
   * acepta cualquier cosa con forma de dirección y devuelve un estado vacío sin
   * error. Así que daba por buena —y la app sellaba en verde— la dirección de la
   * propia API wallet, que no tiene saldo ni posiciones porque solo es un
   * firmante delegado. El usuario veía «Verificada · 0,00 USDC disponibles» con
   * 112 USDC dentro del exchange y ninguna pista de qué había hecho mal
   * (spec 028).
   *
   * Lo que no se veía es lo que venía después: TODAS las lecturas salen de
   * `addr()` —la dirección guardada— mientras las órdenes las resuelve el venue
   * a partir de la FIRMA. Leer y escribir habrían apuntado a cuentas distintas,
   * y un reconciliador que no ve sus propias órdenes no está protegido por la
   * idempotencia del `clientOrderId` ni por la regla de no tocar lo `foreign`.
   *
   * Ahora se le preguntan al venue las dos cosas que sabe contestar y que hasta
   * ahora no se le pedían: qué ES esa dirección (`userRole`) y qué agentes tiene
   * autorizados (`extraAgents`). Las dos son lecturas públicas del endpoint de
   * info; aquí no se firma nada, y la clave privada solo se usa en memoria para
   * derivar su dirección y no aparece en ningún mensaje.
   */
  async verify(): Promise<{
    ok: boolean;
    publicRef: string;
    detail?: string;
    agentValidUntil?: number | null;
  }> {
    const cuenta = this.creds.accountAddress;
    const no = (detail: string) => ({ ok: false, publicRef: cuenta, detail });

    if (!this.creds.agentPrivateKey) {
      return no('Falta la clave privada de la API wallet.');
    }
    let agente: string;
    try {
      agente = new Wallet(this.creds.agentPrivateKey).address.toLowerCase();
    } catch {
      return no('La clave privada de la API wallet no es válida.');
    }

    try {
      const rol = await this.call(
        () => this.info.userRole({ user: this.addr() }),
        hyperliquidWeight('userRole'),
      );

      // El caso del incidente. El venue nos dice a QUÉ cuenta pertenece el
      // agente, así que el mensaje puede darle al usuario la dirección que
      // debería haber pegado en vez de un «no se ha podido verificar».
      if (rol.role === 'agent') {
        return no(
          'Esa es la dirección de una API wallet, no de una cuenta: una API wallet solo firma, ' +
            `no tiene saldo. La dirección de tu cuenta es ${rol.data.user}.`,
        );
      }
      // Operar una subcuenta o un vault exige mandar `vaultAddress` en cada
      // orden, y el adaptador no lo hace: aceptar esto sería operar en la cuenta
      // equivocada. Mejor negarse con el motivo que enterarse con dinero puesto.
      if (rol.role === 'subAccount') {
        return no(
          'Esa es la dirección de una subcuenta de Hyperliquid y todavía no están soportadas: ' +
            `usa la dirección de la cuenta principal (${rol.data.master}).`,
        );
      }
      if (rol.role === 'vault') {
        return no('Esa dirección es un vault de Hyperliquid, no una cuenta de usuario.');
      }
      if (rol.role === 'missing') {
        return no(
          `Hyperliquid no conoce esa dirección en ${this.isTestnet ? 'testnet' : 'la red real'}. ` +
            'Comprueba que es la dirección de tu cuenta y que el depósito ya ha llegado.',
        );
      }

      const autorizados = await this.call(
        () => this.info.extraAgents({ user: this.addr() }),
        hyperliquidWeight('extraAgents'),
      );
      // En minúsculas las dos: `extraAgents` las devuelve en checksum EIP-55 y
      // una cuenta guardada hace tiempo puede traerla plana. Comparar tal cual
      // rechazaría una credencial perfectamente válida.
      const mio = autorizados.find((a) => a.address.toLowerCase() === agente);
      if (!mio) {
        return no(
          `La API wallet de esa clave no está autorizada en ${cuenta}. Autorízala en Hyperliquid ` +
            '(Más → API) o pega la clave de una que ya lo esté.',
        );
      }
      // Una caducada no puede firmar: guardarla sería dejar al usuario con un
      // bot que no coloca nada y un sello verde diciendo que todo va bien.
      if (mio.validUntil !== null && mio.validUntil <= Date.now()) {
        return no(
          `Esa API wallet caducó el ${new Date(mio.validUntil).toISOString().slice(0, 10)}. ` +
            'Autoriza una nueva en Hyperliquid (Más → API) y pega su clave.',
        );
      }

      // Se mantiene: es la comprobación de que la cuenta responde de verdad y de
      // que la red configurada es la que tiene los datos.
      await this.call(() => this.info.clearinghouseState({ user: this.addr() }));
      return { ok: true, publicRef: cuenta, agentValidUntil: mio.validUntil };
    } catch (e) {
      return { ok: false, publicRef: cuenta, detail: toExchangeError(e, this.venue).message };
    }
  }

  getMarkets(): Promise<MarketSpec[]> {
    return this.markets.all();
  }

  /** Estado de cuenta memoizado: posiciones y saldo salen de UNA llamada. */
  private clearinghouse(): Promise<Awaited<ReturnType<HL.InfoClient['clearinghouseState']>>> {
    return this.memo('clearinghouse', () =>
      this.call(() => this.info.clearinghouseState({ user: this.addr() })),
    );
  }

  private memo<T>(key: string, load: () => Promise<T>, ttlMs = 800): Promise<T> {
    const hit = this.accountMemo.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.accountMemo.set(key, { at: Date.now(), value });
    // Un fallo no se cachea: la siguiente llamada debe reintentar de verdad.
    void value.catch(() => this.accountMemo.delete(key));
    return value;
  }

  async getBalances(): Promise<Balance[]> {
    const state = await this.clearinghouse();
    const total = D(state.marginSummary.accountValue);
    const used = D(state.marginSummary.totalMarginUsed);
    const balance: Balance = {
      asset: 'USDC',
      total: total.toFixed(),
      available: D(state.withdrawable).toFixed(),
      used: used.toFixed(),
    };

    // La cuenta de perpetuos a cero es el momento —y el unico— de mirar el otro
    // bolsillo. Hyperliquid separa spot de perps y solo el segundo respalda una
    // posicion, asi que quien tenga el deposito en spot ve un cero que no sabe
    // explicar. Con equity, esta pregunta no se hace: seria una peticion de mas
    // en cada lectura de saldo de cada bot vivo (spec 028).
    if (total.isZero()) {
      const spot = await this.spotUsdc();
      if (spot && !D(spot).isZero()) balance.spot = D(spot).toFixed();
    }
    return [balance];
  }

  /**
   * USDC en la cuenta de spot. `null` si no hay o si no se pudo leer.
   *
   * Se traga el error a proposito: esto es una pista para explicar un cero, y
   * ninguna pista puede tumbar la lectura del saldo, que es el dato de verdad.
   */
  private async spotUsdc(): Promise<string | null> {
    try {
      const state = await this.call(
        () => this.info.spotClearinghouseState({ user: this.addr() }),
        hyperliquidWeight('spotClearinghouseState'),
      );
      return state.balances.find((b) => b.coin === 'USDC')?.total ?? null;
    } catch {
      return null;
    }
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const state = await this.clearinghouse();
    return state.assetPositions
      .map((ap) => ap.position)
      .filter((p) => !symbol || p.coin === symbol)
      .filter((p) => !D(p.szi).isZero())
      .map((p) => ({
        venue: Venue.HYPERLIQUID,
        symbol: p.coin,
        qty: D(p.szi).toFixed(),
        entryPrice: firstNum(p.entryPx, 0).toFixed(),
        markPrice: D(p.positionValue).div(D(p.szi).abs()).toFixed(),
        unrealizedPnl: D(p.unrealizedPnl).toFixed(),
        leverage: Number(p.leverage.value),
        marginMode: p.leverage.type === 'isolated' ? 'ISOLATED' : 'CROSS',
        liquidationPrice: p.liquidationPx ? D(p.liquidationPx).toFixed() : null,
        marginUsed: D(p.marginUsed).toFixed(),
      }));
  }

  async getOpenOrders(symbol?: string): Promise<VenueOrder[]> {
    // Devuelve TODOS los símbolos: el memo hace que N bots de la cuenta paguen
    // una sola llamada de peso 20 y filtren en local.
    const orders = await this.memo('openOrders', () =>
      this.call(() => this.info.frontendOpenOrders({ user: this.addr() }), 20),
    );
    return orders
      .filter((o) => !symbol || o.coin === symbol)
      .map((o) => ({
        venue: Venue.HYPERLIQUID,
        symbol: o.coin,
        clientOrderId: o.cloid ?? null,
        venueOrderId: String(o.oid),
        side: o.side === 'B' ? ('BUY' as const) : ('SELL' as const),
        // El tipo REAL y no «todo lo que no es Market es límite»: un stop a
        // mercado («Stop Market») es una MARKET con disparador, y para el
        // reconciliador un stop-loss y una límite al mismo precio eran la misma
        // cosa (001/F-29). `limitPx` sigue siendo el precio: en un stop es el
        // tope al que se ejecuta una vez disparado.
        type: o.orderType.endsWith('Market') ? ('MARKET' as const) : ('LIMIT' as const),
        price: D(o.limitPx).toFixed(),
        triggerPrice: o.isTrigger ? D(o.triggerPx).toFixed() : null,
        qty: D(o.origSz).toFixed(),
        filledQty: D(o.origSz).minus(o.sz).toFixed(),
        avgPrice: null,
        status: D(o.sz).eq(o.origSz) ? OrderStatus.OPEN : OrderStatus.PARTIALLY_FILLED,
        reduceOnly: o.reduceOnly === true,
        createdAt: o.timestamp,
      }));
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const [book, ctx] = await Promise.all([
      this.call(() => this.info.l2Book({ coin: symbol })),
      this.assetCtx(symbol),
    ]);
    const bid = book?.levels[0]?.[0]?.px;
    const ask = book?.levels[1]?.[0]?.px;
    const mark = ctx?.markPx;
    // Con un lado del libro vacío no se inventa la mitad del otro (001/F-26):
    // manda la marca del venue y, si tampoco la hay, RETRYABLE, que el motor
    // ya sabe tratar. Antes salía un precio falso pero verosímil que entraba en
    // las guardas de riesgo con toda convicción.
    let mid: Decimal;
    if (bid && ask) mid = D(bid).plus(ask).div(2);
    else if (mark) mid = D(mark);
    else {
      throw new ExchangeError(
        'RETRYABLE',
        `Libro de ${symbol} con un lado vacío y sin precio de marca`,
        this.venue,
      );
    }
    return {
      venue: Venue.HYPERLIQUID,
      symbol,
      last: mid.toFixed(),
      bid: (bid ? D(bid) : mid).toFixed(),
      ask: (ask ? D(ask) : mid).toFixed(),
      // La MARCA del venue, que es la que gobierna la liquidación, y no el
      // punto medio del libro (001/F-25): es lo que el tipo `Ticker` promete y
      // lo que ya hacen Aster y Lighter.
      mark: (mark ? D(mark) : mid).toFixed(),
      ts: Date.now(),
    };
  }

  /**
   * Contexto del activo (`markPx`, `oraclePx`, `midPx`…) memoizado un par de
   * segundos: `metaAndAssetCtxs` pesa 20 y trae los doscientos activos de una
   * vez, así que N bots preguntando por su marca son una petición.
   */
  private assetCtx(symbol: string): Promise<AssetCtx | undefined> {
    const now = Date.now();
    if (!this.ctxMemo || now - this.ctxMemo.at > ASSET_CTX_TTL_MS) {
      const value = this.call(() => this.info.metaAndAssetCtxs(), 20).then(([meta, ctxs]) => {
        const porSimbolo = new Map<string, AssetCtx>();
        meta.universe.forEach((asset, index) => {
          const ctx = ctxs[index];
          if (ctx) porSimbolo.set(asset.name, ctx);
        });
        return porSimbolo;
      });
      this.ctxMemo = { at: now, value };
      void value.catch(() => {
        this.ctxMemo = null;
      });
    }
    return this.ctxMemo.value.then((m) => m.get(symbol)).catch(() => undefined);
  }

  /**
   * Precio y sesión de 24 h de TODOS los perps en UNA llamada.
   *
   * Es el mismo `metaAndAssetCtxs` que ya alimenta `getMarkets`: el contexto
   * de cada activo trae `prevDayPx` y `dayNtlVlm`, así que la lista entera de
   * mercados sale de una sola petición de peso 20 en lugar de doscientas.
   */
  async getTickers(): Promise<MarketTicker[]> {
    const [meta, ctxs] = await this.call(() => this.info.metaAndAssetCtxs(), 20);
    const out: MarketTicker[] = [];
    meta.universe.forEach((asset, index) => {
      const ctx = ctxs[index];
      if (!ctx) return;
      const last = num(ctx.midPx ?? ctx.markPx);
      const prev = numOrNull(ctx.prevDayPx);
      out.push({
        venue: Venue.HYPERLIQUID,
        symbol: asset.name,
        last,
        change24h: prev === null ? null : D(last).minus(prev).toFixed(),
        changePct24h: changePct(last, prev),
        // El venue no publica máximo ni mínimo del día en este contexto, y
        // derivarlos de las velas costaría una petición por símbolo.
        high24h: null,
        low24h: null,
        volume24h: numOrNull(ctx.dayNtlVlm),
        ts: Date.now(),
      });
    });
    return out;
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    query: CandleQuery,
  ): Promise<Candle[]> {
    const iv = checkInterval(this.venue, HL_INTERVALS, interval);
    const { startMs, endMs, limit } = resolveRange(
      interval,
      query,
      this.capabilities.candles.maxBars,
    );
    const raw = await this.call(
      () =>
        this.info.candleSnapshot({
          coin: symbol,
          interval: iv,
          startTime: startMs,
          endTime: endMs,
        }),
      // 20 MÁS uno por cada 60 barras: para las 500 de un gráfico ancho son 29,
      // no 20. Aquí sí se puede cobrar exacto porque `limit` se conoce antes de
      // llamar, al revés que en las ejecuciones.
      hyperliquidWeight('candleSnapshot', limit),
    );
    return finishCandles(
      (raw ?? []).map((c) => ({
        t: c.t,
        o: num(c.o),
        h: num(c.h),
        l: num(c.l),
        c: num(c.c),
        v: numOrNull(c.v),
      })),
      limit,
    );
  }

  /**
   * Ejecuciones posteriores a `sinceMs`. Es la red de seguridad del ledger
   * cuando el WebSocket de fills se cae o llega tarde.
   */
  async getRecentFills(symbol: string, sinceMs: number): Promise<Fill[]> {
    const fills = await this.call(
      () => this.info.userFillsByTime({ user: this.addr(), startTime: sinceMs }),
      // 20, el suelo del endpoint. El venue suma además uno por cada 20
      // ejecuciones devueltas, y ese recargo NO se puede cobrar aquí: el
      // presupuesto se toma ANTES de llamar y el número de fills solo se sabe
      // después. Se deja apuntado en vez de inventarse una cifra — el margen de
      // `QUOTA_HEADROOM` está para absorber justo esto.
      hyperliquidWeight('userFillsByTime'),
    );
    return fills
      .filter((f) => f.coin === symbol)
      .map((f) => ({
        venue: Venue.HYPERLIQUID,
        symbol: f.coin,
        venueFillId: String(f.tid),
        venueOrderId: String(f.oid),
        clientOrderId: f.cloid ?? null,
        side: f.side === 'B' ? ('BUY' as const) : ('SELL' as const),
        price: D(f.px).toFixed(),
        qty: D(f.sz).toFixed(),
        fee: D(f.fee).toFixed(),
        feeAsset: f.feeToken ?? 'USDC',
        isTaker: f.crossed === true,
        ts: f.time,
        ...(esLiquidacionHl(f) ? { liquidation: true } : {}),
      }));
  }

  // ═══════════════════════════════════════════════════════════════
  // Ejecución
  // ═══════════════════════════════════════════════════════════════

  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    const asset = await this.assetIdOf(req.symbol);
    const isBuy = req.side === 'BUY';
    const cloid = hyperliquidCodec.encode(req.clientOrderId) as `0x${string}`;

    // Una MARKET en Hyperliquid es una limit IOC muy agresiva: no existe un
    // tipo "market" propio, así que se cruza el libro con un 5 % de holgura.
    const slippage = D(1).plus(isBuy ? 0.05 : -0.05);
    const price = req.type === 'MARKET' ? D(req.price ?? 0).mul(slippage) : D(req.price ?? 0);

    const orderType =
      req.triggerPrice != null
        ? {
            trigger: {
              isMarket: req.type === 'MARKET',
              triggerPx: D(req.triggerPrice).toFixed(),
              // El sentido lo dice QUIEN PIDE la orden, nunca se deduce. Aquí
              // había una fórmula sobre lado y reduce-only que etiquetaba el
              // stop-loss de un LONG como 'tp': con el disparo por debajo del
              // precio, la condición de un tp ya era cierta al colocarlo y el
              // venue cerraba la posición AL INSTANTE. Sin intent explícito se
              // asume 'sl', que es lo único que emiten las estrategias hoy y
              // el error menos caro si algo nuevo se olvida de declararlo.
              tpsl: req.intent === 'TP' ? ('tp' as const) : ('sl' as const),
            },
          }
        : {
            limit: {
              tif:
                req.type === 'POST_ONLY'
                  ? ('Alo' as const)
                  : req.type === 'MARKET'
                    ? ('Ioc' as const)
                    : ('Gtc' as const),
            },
          };

    const formattedPrice = await this.formatPrice(req.symbol, price, req.side);
    const builder = this.builder();

    // Sin reintento a ciegas: si el envío falla con algo reintentable, primero
    // se comprueba si la orden llegó a entrar (por cloid) y solo si no, se
    // reenvía. Reenviar sin comprobar dejaba filas REJECTED con la orden viva.
    return withWriteRetry(
      async () => {
        const result = await this.callWrite(() =>
          this.exchange.order({
            orders: [
              {
                a: asset,
                b: isBuy,
                p: formattedPrice,
                s: req.qty,
                r: req.reduceOnly === true,
                t: orderType,
                c: cloid,
              },
            ],
            grouping: 'na',
            ...(builder ? { builder } : {}),
          }),
        );
        const status = result.response.data.statuses?.[0];
        if (status === undefined) {
          // Sin estados no hay acuse que leer; reventar aquí con un TypeError
          // dejaba la fila sin clasificar (001/F-16). Como RETRYABLE, la
          // comprobación de `withWriteRetry` decide si la orden entró.
          throw new ExchangeError(
            'RETRYABLE',
            'Acuse de Hyperliquid sin estados: la orden puede haber entrado.',
            this.venue,
          );
        }
        return this.toAck(req.clientOrderId, status);
      },
      () => this.findPlaced(req.symbol, req.clientOrderId, cloid),
      { venue: this.venue },
    );
  }

  /** Traduce el acuse crudo de Hyperliquid al del motor. */
  private toAck(clientOrderId: string, status: unknown): OrderAck {
    // Las órdenes con disparador quedan "esperando" y todavía no tienen oid.
    // Se devuelven como PENDING sin id: la reconciliación las adoptará por
    // cloid en el siguiente barrido, que es justo para lo que sirve.
    if (typeof status === 'string') {
      return { clientOrderId, venueOrderId: '', status: OrderStatus.PENDING, ts: Date.now() };
    }
    if (status && typeof status === 'object' && 'resting' in status) {
      const oid = (status as { resting: { oid: number } }).resting.oid;
      return { clientOrderId, venueOrderId: String(oid), status: OrderStatus.OPEN, ts: Date.now() };
    }
    if (status && typeof status === 'object' && 'filled' in status) {
      const oid = (status as { filled: { oid: number } }).filled.oid;
      return {
        clientOrderId,
        venueOrderId: String(oid),
        status: OrderStatus.FILLED,
        ts: Date.now(),
      };
    }
    throw new ExchangeError('FATAL', 'Respuesta de orden no reconocida', this.venue, status);
  }

  async cancelOrder(req: CancelRequest): Promise<void> {
    const asset = await this.assetIdOf(req.symbol);
    // Se cancela por cloid siempre que se pueda: el oid puede haber cambiado si
    // la orden se modificó, pero el cloid es nuestro y no se mueve.
    if (req.clientOrderId) {
      const cloid = hyperliquidCodec.encode(req.clientOrderId) as `0x${string}`;
      await this.call(
        () => this.exchange.cancelByCloid({ cancels: [{ asset, cloid }] }),
        1,
        'write',
      );
      return;
    }
    if (!req.venueOrderId) {
      throw new ExchangeError('FATAL', 'Cancelar exige clientOrderId o venueOrderId', this.venue);
    }
    await this.call(
      () => this.exchange.cancel({ cancels: [{ a: asset, o: Number(req.venueOrderId) }] }),
      1,
      'write',
    );
  }

  /**
   * Cancela SOLO los ids dados, en un único lote.
   *
   * Se cancela por cloid y no por oid: el cloid es nuestro y no cambia, y así
   * ninguna orden ajena puede colarse en el lote ni por error de mapeo.
   */
  async cancelOwn(symbol: string, clientOrderIds: string[]): Promise<void> {
    if (clientOrderIds.length === 0) return;
    const asset = await this.assetIdOf(symbol);
    const cancels = clientOrderIds.map((coid) => ({
      asset,
      cloid: hyperliquidCodec.encode(coid) as `0x${string}`,
    }));
    await this.call(() => this.exchange.cancelByCloid({ cancels }), 1, 'write');
  }

  /**
   * Alcance de CUENTA para el símbolo: se lleva por delante las órdenes de
   * otros bots y las que el usuario haya puesto a mano. Solo el kill-switch
   * global debe llamar aquí; para limpiar un bot está `cancelOwn`.
   */
  async cancelAll(symbol: string): Promise<void> {
    const open = await this.getOpenOrders(symbol);
    if (open.length === 0) return;
    const asset = await this.assetIdOf(symbol);
    await this.call(
      () =>
        this.exchange.cancel({
          cancels: open.map((o) => ({ a: asset, o: Number(o.venueOrderId) })),
        }),
      1,
      'write',
    );
  }

  async modifyOrder(req: ModifyRequest): Promise<OrderAck> {
    const asset = await this.assetIdOf(req.symbol);
    const existing = (await this.getOpenOrders(req.symbol)).find(
      (o) => o.clientOrderId === hyperliquidCodec.encode(req.clientOrderId),
    );
    if (!existing) {
      throw new ExchangeError('RULES', 'La orden a modificar ya no existe', this.venue);
    }
    // El precio pasa por la misma puerta que en `placeOrder` y el tif se
    // conserva: una post-only modificada seguía como Gtc y podía cruzar el
    // libro y pagar taker (001/F-04b). El motor hoy reemplaza cancelando y
    // colocando, pero el camino existe y tiene que ser correcto.
    const price = await this.formatPrice(req.symbol, D(req.price ?? existing.price), existing.side);
    await this.call(
      () =>
        this.exchange.modify({
          oid: Number(existing.venueOrderId),
          order: {
            a: asset,
            b: existing.side === 'BUY',
            p: price,
            s: req.qty ?? existing.qty,
            r: existing.reduceOnly,
            t: { limit: { tif: existing.type === 'POST_ONLY' ? 'Alo' : 'Gtc' } },
            c: hyperliquidCodec.encode(req.clientOrderId),
          },
        }),
      1,
      'write',
    );
    return {
      clientOrderId: req.clientOrderId,
      venueOrderId: existing.venueOrderId,
      status: OrderStatus.OPEN,
      ts: Date.now(),
    };
  }

  async setLeverage(symbol: string, leverage: number, mode: MarginMode): Promise<void> {
    const asset = await this.assetIdOf(symbol);
    await this.call(
      () =>
        this.exchange.updateLeverage({
          asset,
          isCross: mode === 'CROSS',
          leverage,
        }),
      1,
      'write',
    );
  }

  /**
   * `updateIsolatedMargin` mueve colateral entre el saldo libre del perp y la
   * caja de UNA posición aislada.
   *
   * `ntli` va en USDC × 1e6 y ENTERO: el venue rechaza los decimales, así que
   * se trunca hacia cero en vez de redondear. Truncar aporta un microdólar de
   * menos y redondear podría aportar uno de más del que hay libre, que es un
   * rechazo del venue por una diferencia que el usuario no ha pedido.
   *
   * El signo lo lleva `ntli`: negativo retira. Se construye aquí a partir de
   * `action` y nunca se acepta ya negado desde fuera.
   *
   * Va por `callWrite` y no por `call`, al contrario que `setLeverage`, porque
   * esto NO es idempotente: fijar el apalancamiento dos veces lo deja donde ya
   * estaba, pero aportar margen dos veces aporta el doble. `call` reintenta lo
   * RETRYABLE, y un timeout que llegó a aplicarse duplicaría el aporte en
   * silencio.
   */
  async adjustIsolatedMargin(
    symbol: string,
    amountUsd: string,
    action: MarginAction,
    side: PositionSide,
  ): Promise<void> {
    const asset = await this.assetIdOf(symbol);
    const scaled = D(amountUsd).abs().mul(1e6).toDecimalPlaces(0, Decimal.ROUND_DOWN);
    if (scaled.lte(0)) {
      throw new ExchangeError(
        'RULES',
        'El importe es demasiado pequeño: Hyperliquid ajusta el margen en múltiplos de 0,000001 USDC.',
        this.venue,
      );
    }
    const ntli = action === 'REMOVE' ? scaled.neg() : scaled;
    await this.callWrite(() =>
      this.exchange.updateIsolatedMargin({
        asset,
        isBuy: side === 'LONG',
        ntli: ntli.toNumber(),
      }),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Tiempo real
  // ═══════════════════════════════════════════════════════════════

  streamOrders(): Observable<OrderUpdate> {
    void this.ensureUserStreams();
    return this.orders$.asObservable();
  }

  streamFills(): Observable<Fill> {
    void this.ensureUserStreams();
    return this.fills$.asObservable();
  }

  /**
   * Vela en formación por WebSocket.
   *
   * El intervalo de Hyperliquid ya viene en el vocabulario del sistema, así que
   * no hay traducción. Igual que el ticker: un fallo de socket sale por el
   * canal de salud y NUNCA como `error()` sobre este Subject, que quedaría
   * cerrado para siempre y dejaría el gráfico congelado tras la reconexión.
   */
  streamCandles(symbol: string, interval: CandleInterval): Observable<Candle> {
    const iv = checkInterval(this.venue, HL_INTERVALS, interval);
    const key = symbol + '|' + interval;
    let stream = this.candles.get(key);
    if (!stream) {
      stream = this.shared<Candle>(
        (emit) =>
          this.subs.candle({ coin: symbol, interval: iv }, (ev) => {
            emit({
              t: ev.t,
              o: num(ev.o),
              h: num(ev.h),
              l: num(ev.l),
              c: num(ev.c),
              v: numOrNull(ev.v),
            });
          }),
        { stream: 'candles', symbol },
      );
      this.candles.set(key, stream);
    }
    return stream;
  }

  streamHealth(): Observable<StreamHealth> {
    return this.health$.asObservable();
  }

  streamTicker(symbol: string): Observable<Ticker> {
    let stream = this.tickers.get(symbol);
    if (!stream) {
      stream = this.shared<Ticker>(
        (emit) => {
          // La marca no viaja en el bbo sino en `activeAssetCtx`: se guarda la
          // última y cada bbo la lleva (001/F-25). Hasta que llegue la primera
          // va el mid, que es lo que había.
          let mark: string | null = null;
          const ctx = this.subs.activeAssetCtx({ coin: symbol }, (ev) => {
            mark = ev.ctx.markPx ?? mark;
          });
          const bbo = this.subs.bbo({ coin: symbol }, (ev) => {
            const [bid, ask] = ev.bbo;
            const mid = firstNum(bid?.px, 0)
              .plus(ask?.px ?? 0)
              .div(2);
            emit({
              venue: Venue.HYPERLIQUID,
              symbol,
              last: mid.toFixed(),
              bid: firstNum(bid?.px, 0).toFixed(),
              ask: firstNum(ask?.px, 0).toFixed(),
              mark: mark ?? mid.toFixed(),
              ts: ev.time,
            });
          });
          return Promise.all([bbo, ctx]).then(([b, c]) => ({
            unsubscribe: () => Promise.all([b.unsubscribe(), c.unsubscribe()]),
          }));
        },
        { stream: 'ticker', symbol },
      );
      this.tickers.set(symbol, stream);
    }
    return stream;
  }

  /**
   * Un flujo compartido con CONTADOR de referencias.
   *
   * El primero que se suscribe abre la suscripción en el venue; el último que
   * se va la suelta de verdad. Es lo que faltaba: antes se abría en la primera
   * llamada y solo se cerraba cerrando el adaptador entero, así que un worker
   * que hubiera servido cien pares a lo largo del día mantenía cien
   * suscripciones vivas contra el límite que Hyperliquid cuenta por IP.
   *
   * El canal de datos NUNCA recibe `error()`: el fallo se anuncia por
   * `streamHealth` y el motor decide —cae al precio por REST—. Errarlo dejaría
   * al bot sin ticker para el resto de la vida del adaptador.
   *
   * De los tres interruptores de `share`, el que hace el trabajo es
   * `resetOnRefCountZero`. Los otros dos van explícitos y en `false` para que
   * el final sea DEFINITIVO: lo único que termina estos flujos es `close()` del
   * adaptador, y después de eso no tiene sentido que un suscriptor nuevo vuelva
   * a abrir nada. Que un fallo de socket no cierre el canal de datos no lo
   * decide este `pipe` —lo decide que aquí NUNCA se llame a `observer.error()`,
   * y no se llama: los fallos salen por `streamHealth`.
   */
  private shared<T>(
    open: (emit: (value: T) => void) => Promise<HlSubscription>,
    what: { stream: StreamHealth['stream']; symbol?: string },
  ): Observable<T> {
    return new Observable<T>((observer) => {
      let live: HlSubscription | null = null;
      let stopped = false;

      void open((value) => observer.next(value))
        .then((sub) => {
          // El alta es ASÍNCRONA y el interesado puede haberse ido mientras
          // tanto. Sin esta guarda quedaría viva una suscripción que nadie
          // escucha y que nadie va a soltar.
          if (stopped || this.closed) {
            void sub.unsubscribe().catch(() => undefined);
            return;
          }
          live = sub;
          this.openSubs.push(sub);
          this.health$.next({ status: 'UP', ...what });
        })
        .catch((e) => {
          this.health$.next({
            status: 'DOWN',
            ...what,
            detail: toExchangeError(e, this.venue).message,
          });
        });

      return () => {
        stopped = true;
        if (!live) return;
        const at = this.openSubs.indexOf(live);
        if (at >= 0) this.openSubs.splice(at, 1);
        // Si se está cerrando el adaptador entero, `close()` ya dio de baja
        // todo lo de `openSubs` antes de disparar `closed$`. Volver a darla de
        // baja aquí mandaría el mensaje por un transporte ya cerrado: no rompe
        // nada, pero es ruido que no hace falta.
        if (!this.closed) void live.unsubscribe().catch(() => undefined);
        live = null;
      };
    }).pipe(
      takeUntil(this.closed$),
      share({ resetOnRefCountZero: true, resetOnComplete: false, resetOnError: false }),
    );
  }

  /** Las suscripciones de usuario se abren UNA vez y se comparten. */
  private async ensureUserStreams(): Promise<void> {
    if (this.streamsStarted) return;
    this.streamsStarted = true;
    const user = this.addr();

    try {
      this.openSubs.push(
        await this.subs.orderUpdates({ user }, (events) => {
          for (const ev of events) {
            this.orders$.next({
              venue: Venue.HYPERLIQUID,
              symbol: ev.order.coin,
              clientOrderId: ev.order.cloid ?? null,
              venueOrderId: String(ev.order.oid),
              side: ev.order.side === 'B' ? 'BUY' : 'SELL',
              // El evento del WebSocket trae la orden «básica» (sin tipo ni
              // disparador): aquí solo importa el ESTADO, y el tipo real lo
              // conserva el barrido REST de `getOpenOrders` (001/F-29).
              type: 'LIMIT',
              price: D(ev.order.limitPx).toFixed(),
              triggerPrice: null,
              qty: D(ev.order.origSz).toFixed(),
              filledQty: D(ev.order.origSz).minus(ev.order.sz).toFixed(),
              avgPrice: null,
              status: mapOrderStatus(ev.status),
              reduceOnly: ev.order.reduceOnly === true,
              createdAt: ev.order.timestamp,
            });
          }
        }),
      );

      this.openSubs.push(
        await this.subs.userFills({ user }, (ev) => {
          for (const f of ev.fills) {
            this.fills$.next({
              venue: Venue.HYPERLIQUID,
              symbol: f.coin,
              venueFillId: String(f.tid),
              venueOrderId: String(f.oid),
              clientOrderId: f.cloid ?? null,
              side: f.side === 'B' ? 'BUY' : 'SELL',
              price: D(f.px).toFixed(),
              qty: D(f.sz).toFixed(),
              fee: D(f.fee).toFixed(),
              feeAsset: f.feeToken ?? 'USDC',
              isTaker: f.crossed === true,
              ts: f.time,
              ...(esLiquidacionHl(f) ? { liquidation: true } : {}),
            });
          }
        }),
      );
      this.health$.next({ stream: 'orders', status: 'UP' });
      this.health$.next({ stream: 'fills', status: 'UP' });
    } catch (e) {
      // NO se cierran los Subject: un `error()` sobre ellos los deja muertos
      // para siempre y el bot no vuelve a ver un fill aunque el socket se
      // recupere. Se anuncia la caída y se reintenta solo: sin el reintento,
      // la suscripción únicamente volvía si un bot nuevo llamaba a
      // streamFills(), o sea, quizá nunca.
      this.streamsStarted = false;
      const detail = toExchangeError(e, this.venue).message;
      this.health$.next({ stream: 'orders', status: 'DOWN', detail });
      this.health$.next({ stream: 'fills', status: 'DOWN', detail });
      if (!this.closed && !this.streamRetryTimer) {
        this.streamRetryTimer = setTimeout(() => {
          this.streamRetryTimer = null;
          void this.ensureUserStreams();
        }, 5000);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = null;
    await Promise.allSettled(this.openSubs.map((s) => s.unsubscribe()));
    this.openSubs.length = 0;
    // Cerrar el transporte, y no solo darse de baja: sin esto la conexión se
    // quedaba abierta y cada reinicio de bot consumía una de las DIEZ que
    // Hyperliquid permite por IP.
    // Solo si llegó a crearse: un adaptador que nunca abrió un stream no tiene
    // transporte que cerrar, y crearlo aquí sería justo lo contrario.
    if (this.wsTransportLazy) {
      await Promise.resolve(this.wsTransportLazy.close()).catch(() => undefined);
    }
    this.orders$.complete();
    this.fills$.complete();
    // Antes de completar `health$`: los flujos compartidos terminan por aquí y
    // el aviso tiene que poder salir con el canal de salud todavía vivo.
    this.closed$.next();
    this.closed$.complete();
    this.health$.complete();
    this.tickers.clear();
    this.candles.clear();
  }

  // ═══════════════════════════════════════════════════════════════
  // Interno
  // ═══════════════════════════════════════════════════════════════

  private addr(): `0x${string}` {
    return this.creds.accountAddress as `0x${string}`;
  }

  private builder(): { b: `0x${string}`; f: number } | null {
    if (!this.opts.builderAddress || !this.opts.builderFeeTenthBps) return null;
    const f = this.opts.builderFeeTenthBps;
    if (!Number.isInteger(f) || f <= 0 || f > BUILDER_FEE_MAX_TENTH_BPS) return null;
    return { b: this.opts.builderAddress as `0x${string}`, f };
  }

  private async assetIdOf(symbol: string): Promise<number> {
    if (!this.assetIndex.has(symbol)) await this.markets.all();
    const index = this.assetIndex.get(symbol);
    if (index === undefined) {
      throw new ExchangeError('RULES', 'Mercado desconocido: ' + symbol, this.venue);
    }
    return index;
  }

  /**
   * Hyperliquid rechaza precios con más de 5 cifras significativas. `toFixed`
   * a secas no basta: hay que recortar también por significativas o la orden
   * vuelve con "invalid price" sin más explicación.
   */
  private async formatPrice(symbol: string, price: Decimal, side: 'BUY' | 'SELL'): Promise<string> {
    const spec = await this.markets.get(symbol);
    // La MISMA puerta que usa la estrategia (001/F-04): retícula y cinco cifras
    // significativas hacia el lado seguro, con los enteros intactos. Antes se
    // recortaba aquí con HALF_UP y la estrategia no recortaba: dos precios
    // distintos para la misma orden y el reconciliador cancelando y
    // recolocando en cada tick.
    return roundPriceForSide(price, spec.tickSize, side, spec.maxSignificantDigits ?? 5).toFixed();
  }

  /**
   * Lecturas: reintento automático, que es inocuo.
   *
   * Pasan por dos puertas. `limiter` acota lo que manda ESTE adaptador —es
   * decir, esta cuenta—; `budget` acota lo que manda todo lo que sale por esta
   * IP, que es como cuenta Hyperliquid sus 1200 de peso por minuto.
   */
  private call<T>(
    fn: () => Promise<T>,
    weight = hyperliquidWeight('l2Book'),
    // Las cancelaciones y el apalancamiento iban por el cupo de LECTURA: un
    // pánico competía por el presupuesto con las lecturas de los demás bots,
    // que es justo lo que la reserva de escritura existe para impedir
    // (001/F-10). Se reintentan igual: son idempotentes.
    priority: BudgetPriority = 'read',
  ): Promise<T> {
    return withRetry(
      async () => {
        // Si el venue nos tiene cortados, la mejor petición es la que no se
        // manda: insistir alarga el castigo («one request every 10 seconds»).
        // Era el único adaptador sin esto (001/F-28).
        this.cooldown.comprobar();
        await this.budget.take(this.venue, weight, priority, this.isTestnet);
        return this.limiter.run(fn).catch((e) => {
          this.cooldown.registrar(e);
          throw e;
        });
      },
      { venue: this.venue },
    );
  }

  /**
   * Escrituras: pasan por el limitador pero NO se reintentan solas, y tienen
   * reservada una parte del presupuesto. Una avalancha de lecturas no puede
   * dejar sin caudal a la cancelación de un pánico.
   */
  private async callWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.cooldown.comprobar();
    await this.budget.take(this.venue, 1, 'write', this.isTestnet);
    return this.limiter.run(fn).catch((e) => {
      this.cooldown.registrar(e);
      throw e;
    });
  }

  /**
   * ¿Llegó a entrar esta orden? Distingue «el envío falló» de «el envío llegó
   * y se perdió la respuesta», que es la única pregunta que importa antes de
   * reenviar.
   *
   * Se pregunta por `orderStatus` y no por las órdenes abiertas, por dos
   * razones que pesan: responde también para órdenes YA EJECUTADAS —una MARKET
   * que entró y se ejecutó no aparece en el libro, y reenviarla sería duplicar
   * la posición— y pesa 2 en vez de 20 en el presupuesto de la IP.
   */
  private async findPlaced(
    _symbol: string,
    clientOrderId: string,
    cloid: string,
  ): Promise<OrderAck | null> {
    const result = await this.call(() => this.info.orderStatus({ user: this.addr(), oid: cloid }));
    if (result.status !== 'order') return null;
    // Un RECHAZO no cuenta como «entró»: se devuelve null para que el reenvío
    // reproduzca el error real del venue y el motor lo clasifique como toca.
    if (/ejected/.test(result.order.status)) return null;
    const inner = result.order.order;
    return {
      clientOrderId,
      venueOrderId: String(inner.oid),
      status: mapOrderStatus(result.order.status),
      ts: Date.now(),
    };
  }
}

function mapOrderStatus(status: string): OrderStatus {
  switch (status) {
    case 'open':
      return OrderStatus.OPEN;
    case 'filled':
      return OrderStatus.FILLED;
    case 'canceled':
    case 'marginCanceled':
    case 'vaultWithdrawalCanceled':
    case 'openInterestCapCanceled':
    case 'selfTradeCanceled':
    case 'reduceOnlyCanceled':
    case 'siblingFilledCanceled':
    case 'delistedCanceled':
    case 'liquidatedCanceled':
    case 'scheduledCancel':
      return OrderStatus.CANCELED;
    case 'rejected':
      return OrderStatus.REJECTED;
    case 'triggered':
      return OrderStatus.OPEN;
    default:
      return OrderStatus.OPEN;
  }
}
