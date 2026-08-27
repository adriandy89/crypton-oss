import { Observable, Subject } from 'rxjs';
import {
  AccountApi,
  Configuration,
  OrderApi,
  SignerClient,
  type Order as LighterOrder,
  type PerpsOrderBookDetail,
} from 'zklighter-sdk';
import {
  D,
  Decimal,
  ExchangeError,
  firstNum,
  isFiniteNum,
  OrderStatus,
  Venue,
  type Balance,
  type CancelRequest,
  type Fill,
  type MarginAction,
  type MarginMode,
  type MarketSpec,
  type OrderAck,
  type OrderUpdate,
  type PlaceOrderRequest,
  type Position,
  type PositionSide,
  type Ticker,
  type VenueOrder,
  type Candle,
  type CandleInterval,
  type MarketTicker,
  type VenueCapabilities,
} from '@crypton/shared';
import { changePct, checkInterval, finishCandles, num, numOrNull, resolveRange } from '../candles';
import { LIGHTER_INTERVALS, VENUE_CAPABILITIES } from '../capabilities';
import { lighterCodec } from '../coid';
import { endpointsFor } from '../endpoints';
import { isThrottled, messageOf, shortMessage, toExchangeError } from '../errors';
import { MarketSpecCache, canonicalSymbol } from '../market-cache';
import { RateLimiter, withRetry, withWriteRetry } from '../rate-limit';
import { NO_BUDGET, type VenueBudget } from '../venue-budget';
import { lighterCost } from '../venue-weights';
import { VenueCooldown } from '../cooldown';
import { ReconnectingSocket, sharedStream } from '../ws';
import type {
  AdapterOptions,
  CandleQuery,
  ExchangeAdapter,
  StreamHealth,
  VenueCredentials,
} from '../types';

type LighterCreds = Extract<VenueCredentials, { venue: 'LIGHTER' }>;

/**
 * Las URLs viven en `VENUE_ENDPOINTS` (`../endpoints`). El stream es UNA sola
 * conexión multiplexada para todos los canales, no una por stream como en
 * Aster: por eso el adaptador lleva un mapa de rutas y vuelve a pedir sus
 * suscripciones en cada reconexión.
 */

/**
 * Normaliza una marca de tiempo del venue a milisegundos.
 *
 * La unidad no está documentada y equivocarse es silencioso: con segundos
 * tratados como milisegundos, todo fill parecería de 1970 y el filtro de
 * «desde» los descartaría TODOS — el ledger se quedaría vacío creyendo que no
 * hay nada nuevo. El umbral separa sin ambigüedad: cualquier valor en segundos
 * queda muy por debajo de 1e12 y cualquier valor en milisegundos, muy por
 * encima.
 */
const normalizeTs = (ts: number): number => (ts < 1e12 ? ts * 1000 : ts);

/**
 * Respuesta de `/api/v1/candles`. Todos los campos son opcionales a propósito:
 * el endpoint omite los que valgan cero. `V` (volumen en moneda de cotización)
 * e `i` (último id de trade) llegan y no se usan.
 */
interface LighterCandles {
  code?: number;
  message?: string;
  c?: {
    t?: number;
    o?: number;
    h?: number;
    l?: number;
    c?: number;
    v?: number;
  }[];
}

/**
 * Precio del punto más antiguo de `daily_chart`, que es el de hace 24 h.
 *
 * Las claves son marcas de tiempo en texto: hay que ordenarlas como NÚMEROS.
 * Ordenadas como cadenas, '9' va después de '10' y el «más antiguo» sale mal
 * justo cuando la serie cruza una potencia de diez.
 */
export function oldestPrice(chart: Record<string, number> | undefined): string | null {
  if (!chart) return null;
  let oldestTs = Number.POSITIVE_INFINITY;
  let oldest: number | null = null;
  for (const [key, value] of Object.entries(chart)) {
    const ts = Number(key);
    if (!Number.isFinite(ts) || !Number.isFinite(value) || value <= 0) continue;
    if (ts < oldestTs) {
      oldestTs = ts;
      oldest = value;
    }
  }
  return oldest === null ? null : D(oldest).toFixed();
}

/**
 * Formas de los mensajes del stream, VERIFICADAS contra el venue.
 *
 * No salen de la documentación sino de una sonda contra
 * `wss://mainnet.zklighter.elliot.ai/stream`, porque la documentación resume
 * los campos en prosa y aquí hay tres detalles que no se deducen de ella y que
 * fallarían en silencio:
 *
 *   · El canal viaja con DOS PUNTOS en la respuesta —`candle:1:4h`— aunque se
 *     pida con barras —`candle/1/4h`—. Enrutar por el nombre pedido no casa
 *     con ninguno.
 *   · `update/market_stats` trae SOLO los mercados que han cambiado, no la
 *     tabla entera: el primer mensaje trajo 67 y el siguiente 1. Tratarlo como
 *     una foto completa borraría 900 pares en cada actualización.
 *   · Los errores llegan SIN campo `type`, como `{error:{code,message}}`. Un
 *     enrutador que mire solo `type` los tira a la basura y deja al adaptador
 *     esperando datos que no van a llegar.
 */
interface LighterWsMessage {
  type?: string;
  channel?: string;
  error?: { code?: number; message?: string };
  candles?: { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number }[];
  ticker?: {
    s?: string;
    a?: { price?: string; size?: string };
    b?: { price?: string; size?: string };
  };
  market_stats?: Record<string, LighterMarketStats>;
}

/**
 * Estadísticas de un mercado tal y como las manda el stream.
 *
 * Los tipos son MIXTOS y no es un descuido de esta interfaz: los precios llegan
 * como cadena y las cifras diarias como número. Declararlo tal cual es lo que
 * evita un `.toFixed()` sobre algo que no lo tiene.
 */
interface LighterMarketStats {
  symbol?: string;
  market_id?: number;
  mark_price?: string;
  /**
   * Precio de indice. Es el respaldo BUENO cuando el libro esta vacio.
   *
   * El stream manda `mid_price`, `best_bid_price` y `best_ask_price` como
   * CADENA VACIA en un mercado sin libro —comprobado contra testnet en BTC—,
   * mientras que `index_price` y `mark_price` siguen trayendo el precio real.
   * Sin este campo, el respaldo del `mark` acababa siendo cero.
   */
  index_price?: string;
  mid_price?: string;
  best_ask_price?: string;
  best_bid_price?: string;
  last_trade_price?: string;
  daily_base_token_volume?: number;
  daily_quote_token_volume?: number;
  daily_price_low?: number;
  daily_price_high?: number;
  /**
   * PORCENTAJE, no importe.
   *
   * Es la ambigüedad que obligaba a `getTickers` a reconstruir el cambio desde
   * `daily_chart`, y ya está resuelta midiéndola: ZRO llegó con
   * `daily_price_change: 21.0` sobre un precio de 1,229 y un mínimo diario de
   * 0,999. Como importe serían 21 dólares sobre una moneda de un dólar; como
   * porcentaje sale un mínimo de 1,016, que encaja con la serie. El stream no
   * trae `daily_chart`, así que este campo es la ÚNICA fuente aquí y saber su
   * unidad no era opcional.
   */
  daily_price_change?: number;
}

/** Cada cuánto se manda `{"type":"ping"}`. El venue exige una trama cada 2 min. */
const WS_PING_EVERY_MS = 60_000;

/**
 * A partir de aquí la tabla del stream se considera vieja y se vuelve al REST.
 *
 * Generoso a propósito: `market_stats/all` late varias veces por segundo con
 * 900 pares vivos, así que un minuto sin una sola actualización significa que
 * el socket está mudo, no que el mercado esté tranquilo.
 */
const STATS_STALE_MS = 60_000;

/**
 * Lo que se espera a la primera foto de `market_stats/all` antes de resolver un
 * `market_id` por REST. La foto llega en menos de un segundo con el socket
 * sano; tres segundos distinguen «tarda» de «no va a llegar».
 */
const STATS_WAIT_MS = 3000;

/**
 * Vida del token de autenticación cacheado. Ocho minutos contra los diez que
 * dura el del SDK (`DEFAULT_10_MIN_AUTH_EXPIRY`): el margen evita que una
 * petición salga con uno que acaba de caducar.
 */
const AUTH_TOKEN_TTL_MS = 8 * 60_000;

/**
 * Cada cuánto sondea el respaldo por REST.
 *
 * Doce segundos, no tres. Un barrido cuesta DOS llamadas por símbolo —una de
 * ellas `trades`, de peso 600—, así que a tres segundos eran cuarenta
 * peticiones por minuto y por símbolo contra un cupo de sesenta para toda la
 * IP: dos símbolos abiertos lo agotaban. A doce son diez por símbolo, y el
 * motor converge igual porque reconcilia por estado deseado.
 */
const POLL_INTERVAL_MS = 12_000;

/**
 * Lo que se espera antes de volver al sondeo cuando el socket se cae.
 *
 * Una reconexión normal tarda menos que esto, y sondear en ese hueco gasta cupo
 * justo cuando la reconexión también lo necesita.
 */
const WS_FALLBACK_AFTER_MS = 20_000;

/** Tope del backoff al reintentar resolver un canal. Ver `subscribe`. */
const SUBSCRIBE_RETRY_MAX_MS = 30_000;

/**
 * Espera a `promesa` como mucho `ms`, sin dejar temporizadores sueltos.
 *
 * `Promise.race([promesa, sleep(ms)])` haría lo mismo salvo por el detalle que
 * importa: el `setTimeout` del `sleep` sigue en pie aunque la carrera ya esté
 * decidida, y mantiene vivo el bucle de eventos hasta que salta.
 */
function esperaAcotada(promesa: Promise<void> | null, ms: number): Promise<void> {
  if (!promesa) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promesa.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * Adaptador de Lighter.
 *
 * Dos particularidades marcan todo el diseño de esta clase:
 *
 * 1. El SDK devuelve errores al estilo Go —tuplas `[valor, respuesta, error]`
 *    en lugar de excepciones—, así que cada llamada pasa por `unwrap()`, que
 *    convierte el tercer elemento en un ExchangeError. Sin eso, un fallo se
 *    colaría como éxito silencioso.
 * 2. Precios y cantidades viajan como ENTEROS escalados por los decimales del
 *    mercado (`supported_price_decimals`, `supported_size_decimals`). Mandar un
 *    decimal en crudo no da error de validación: coloca la orden a un precio
 *    equivocado por varios órdenes de magnitud.
 */
export class LighterAdapter implements ExchangeAdapter {
  readonly venue = Venue.LIGHTER;

  readonly capabilities: VenueCapabilities = VENUE_CAPABILITIES[Venue.LIGHTER];

  /** Firmante nativo. Se crea al primer uso; ver el getter `signer`. */
  private signingClient?: SignerClient;
  private readonly url: string;
  private readonly orderApi: OrderApi;
  private readonly accountApi: AccountApi;
  private readonly limiter: RateLimiter;
  private readonly pollLimiter: RateLimiter;
  private readonly budget: VenueBudget;
  /**
   * Red del venue. Se guarda porque el presupuesto de caudal lleva depósitos
   * separados por red: mainnet y testnet son hosts distintos y cada uno tiene
   * su propio contador en el venue.
   */
  private readonly testnet: boolean;
  private readonly markets: MarketSpecCache;
  /**
   * Enfriamiento tras un corte del venue. Mientras dure, no sale ni una
   * petición: insistir es lo que alarga el castigo. Ver `VenueCooldown`.
   */
  private readonly cooldown = new VenueCooldown(Venue.LIGHTER);
  private readonly marketIndex = new Map<string, number>();
  private readonly detailsBySymbol = new Map<string, PerpsOrderBookDetail>();

  private readonly orders$ = new Subject<OrderUpdate>();
  private readonly fills$ = new Subject<Fill>();
  /**
   * Flujos COMPARTIDOS por símbolo, no `Subject` sueltos.
   *
   * Con `Subject` el socket se abría en la primera llamada y no se cerraba
   * jamás salvo cerrando el adaptador entero. Ahora el primero que se suscribe
   * abre la suscripción al venue y el último que se va la suelta.
   */
  private readonly tickers = new Map<string, Observable<Ticker>>();
  /** Clave `symbol|interval`: la unidad de suscripción de velas es la pareja. */
  private readonly candleStreams = new Map<string, Observable<Candle>>();
  private readonly health$ = new Subject<StreamHealth>();

  // ── WebSocket ────────────────────────────────────────────────
  private readonly wsUrl: string;
  private socket: ReconnectingSocket | null = null;
  /** Canales vivos, para volver a pedirlos al reconectar. */
  private readonly channels = new Set<string>();
  /** Quién atiende cada canal. La clave lleva `:`, como vuelve del venue. */
  private readonly routes = new Map<string, (msg: LighterWsMessage) => void>();
  /** Última foto de `market_stats`, FUSIONADA: las updates son parciales. */
  private readonly stats = new Map<number, LighterMarketStats>();
  private readonly statsBySymbol = new Map<string, number>();
  private statsAt = 0;
  private statsSub: { stop: () => void } | null = null;
  /** Se resuelve con la PRIMERA foto de `market_stats/all`. Ver `streamMarketId`. */
  private statsReady: Promise<void> | null = null;
  private statsArrived: (() => void) | null = null;
  /**
   * Salud del canal de CUENTA (`account_all`), que todavía no se suscribe.
   *
   * Existe ya para que `shouldPoll` pregunte por lo correcto desde el primer
   * día: mezclar las dos saludes es lo que dejó a un bot sin ver sus fills.
   */
  private readonly accountStreamUp = false;
  private readonly accountStreamDownSince = 0;
  /**
   * Se dispara en `close()` y termina los flujos compartidos. Quien esté
   * suscrito tiene que enterarse de que este adaptador ya no entrega nada más.
   */
  private readonly closed$ = new Subject<void>();

  // ── Autenticación REST ───────────────────────────────────────
  /**
   * Cabeceras que el SDK mezcla en cada petición. Es un objeto MUTABLE a
   * propósito: el SDK lo lee en cada llamada, así que renovar el token aquí
   * alcanza también a lo que manda él.
   */
  private readonly sdkHeaders: Record<string, string> = { Accept: 'application/json' };
  private authCache: { token: string; until: number } | null = null;
  /** Órdenes ya notificadas, para no reemitir en cada sondeo. */
  private readonly seenOrders = new Map<number, string>();
  /**
   * Símbolos que de verdad interesan a este adaptador.
   *
   * El sondeo recorría el catálogo ENTERO —una llamada firmada por mercado, y
   * hay decenas— cada tres segundos. Con el limitador a 8/s eso son más de diez
   * segundos de trabajo encolado cada tres: la cola crecía sin límite y las
   * órdenes salían con retraso creciente detrás del sondeo. Ahora solo se
   * sondea lo que alguien está mirando.
   */
  private readonly watched = new Set<string>();
  /** Última ejecución vista por símbolo, para pedir solo lo nuevo. */
  private readonly lastFillTs = new Map<string, number>();
  /** Última forma conocida de cada orden, para poder anunciar su desaparición. */
  private readonly lastSeenOrder = new Map<number, VenueOrder>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private closed = false;

  constructor(
    private readonly creds: LighterCreds,
    opts: AdapterOptions = {},
  ) {
    // La red la manda `opts.testnet`. `creds.baseUrl` gana por encima porque los
    // sobres sellados antes de que existiera la tabla de endpoints lo llevan
    // dentro; `opts.wsUrl` gana porque la batería de tests levanta su propio
    // servidor. Ninguno de los dos lo rellena ya un cliente.
    this.testnet = opts.testnet === true;
    const endpoints = endpointsFor(Venue.LIGHTER, this.testnet);
    this.url = creds.baseUrl ?? endpoints.rest;
    this.wsUrl = opts.wsUrl ?? endpoints.ws;
    // `baseOptions.headers` es el objeto mutable de arriba: el SDK lo mezcla en
    // cada petición, así que el token viaja también en las llamadas que hace él
    // y no solo en las de `publicGet`.
    const config = new Configuration({
      basePath: this.url,
      baseOptions: { headers: this.sdkHeaders },
    });
    this.orderApi = new OrderApi(config);
    this.accountApi = new AccountApi(config);
    this.limiter = new RateLimiter(opts.rateLimitPerSecond ?? 8);
    this.budget = opts.budget ?? NO_BUDGET;
    // Limitador APARTE para el sondeo. Compartirlo con la ejecución hacía que
    // una orden —o peor, una cancelación de pánico— esperase en la cola detrás
    // de un barrido de estado que no tiene ninguna urgencia.
    this.pollLimiter = new RateLimiter(Math.max(1, Math.floor((opts.rateLimitPerSecond ?? 8) / 2)));
    this.markets = new MarketSpecCache(() => this.loadMarkets());
  }

  /**
   * Firmante nativo (koffi), creado la primera vez que hace falta.
   *
   * Aquí importa más que en los otros venues: construir el `SignerClient` carga
   * la librería nativa y abre recursos que luego hay que cerrar. Un adaptador
   * público —el que usa la sincronización de mercados— ya no paga ese coste ni
   * mantiene una clave en memoria.
   */
  private get signer(): SignerClient {
    if (!this.signingClient) {
      if (!this.creds.apiPrivateKey) {
        throw new Error('Adaptador de Lighter sin credenciales: no puede firmar.');
      }
      this.signingClient = new SignerClient(
        this.url,
        this.creds.apiPrivateKey,
        this.creds.apiKeyIndex,
        this.creds.accountIndex,
      );
    }
    return this.signingClient;
  }

  /**
   * El firmante CON su contador de nonce ya cargado del venue.
   *
   * Todo lo que firme y ENVIE tiene que pasar por aqui, no por el getter de
   * arriba. El SDK arranca ese contador a cero y lo rellena desde el venue en
   * `initialize()`, pero lo lanza sin esperarlo —`signer.js`, dentro de
   * `nonce_manager_factory`: `manager.initialize().catch(console.error)`—, asi
   * que quien construye el `SignerClient` y firma en la misma vuelta manda
   * nonce 0. Comprobado contra testnet: el nonce que tocaba lo acepta, el 0 lo
   * rechaza con `{"code":21104,"message":"invalid nonce"}`.
   *
   * Y no se arregla solo, que es lo peor del asunto. La recuperacion del SDK
   * mira `error.message` buscando «invalid nonce», pero eso en un error de
   * axios es «Request failed with status code 400»: el texto de verdad viene en
   * `response.data.message`. Como nunca casa, cae por el `else`, que llama a
   * `acknowledge_failure` y DECREMENTA el contador. Un rechazo lo devuelve a
   * cero y de ahi ya no sale: el adaptador se queda sin poder poner una orden
   * durante toda su vida.
   */
  private async signerReady(): Promise<SignerClient> {
    const client = this.signer;
    this.nonceReady ??= (
      client as unknown as { nonce_manager: { initialize(): Promise<void> } }
    ).nonce_manager
      .initialize()
      // Si la carga inicial falla, se deja reintentar en la siguiente escritura
      // en vez de dar por bueno un contador a cero para siempre.
      .catch(() => {
        this.nonceReady = null;
      });
    await this.nonceReady;
    return client;
  }

  /** La carga del contador de nonce, una sola vez. Ver `signerReady`. */
  private nonceReady: Promise<void> | null = null;

  /**
   * Una escritura firmada, con UN reintento si el venue rechaza el nonce.
   *
   * Hace falta porque el reintento general no cubre esto: «invalid nonce» no
   * casa con ningun patron de `classify`, asi que sale como FATAL y
   * `withWriteRetry` ni lo intenta. Y aunque lo intentara, sin volver a leer el
   * contador del venue el segundo envio saldria con el mismo numero malo.
   *
   * El reintento es seguro: una transaccion rechazada por nonce NO la ha visto
   * la cadena, asi que no puede haber quedado a medias. El indice de cliente es
   * el mismo, de modo que si el rechazo fuera un falso negativo, el venue
   * rechazaria el duplicado en vez de doblar la orden.
   */
  private async signedWrite<T>(fn: (signer: SignerClient) => Promise<T>): Promise<T> {
    const client = await this.signerReady();
    try {
      return await fn(client);
    } catch (e) {
      if (!/invalid nonce/i.test(messageOf(e))) throw e;
      await (
        client as unknown as {
          nonce_manager: { hard_refresh_nonce(apiKeyIndex: number): Promise<void> };
        }
      ).nonce_manager.hard_refresh_nonce(this.creds.apiKeyIndex);
      return fn(client);
    }
  }

  /** Convierte la tupla `[..., error]` del SDK en una excepción clasificada. */
  private unwrap<T>(result: [T, unknown, string | null] | [T, string | null]): T {
    const error = result[result.length - 1];
    if (typeof error === 'string' && error.length > 0) {
      throw toExchangeError(error, this.venue);
    }
    return result[0];
  }

  /**
   * Lecturas. Pasan por dos puertas: `limiter` acota lo que manda esta cuenta,
   * `budget` lo que manda todo lo que sale por esta IP — que es el ámbito en el
   * que el venue cuenta de verdad.
   */
  private call<T>(fn: () => Promise<T>, weight = lighterCost('')): Promise<T> {
    return withRetry(
      async () => {
        // Antes que el presupuesto y que la red: si el venue nos tiene
        // cortados, la mejor petición es la que no se manda.
        this.cooldown.comprobar();
        await this.budget.take(this.venue, weight, 'read', this.testnet);
        return this.limiter.run(fn).catch((e) => {
          this.cooldown.registrar(e);
          throw e;
        });
      },
      { venue: this.venue },
    );
  }

  /**
   * Sondeo: mismo reintento, pero por el limitador de baja prioridad.
   *
   * El coste lo dice el ENDPOINT. Iba fijo a 2 para todo, y el sondeo pedía
   * `trades`, que pesa el doble que una lectura normal — cada tres segundos y
   * por símbolo.
   */
  private pollCall<T>(fn: () => Promise<T>, weight = lighterCost('')): Promise<T> {
    return withRetry(
      async () => {
        this.cooldown.comprobar();
        await this.budget.take(this.venue, weight, 'read', this.testnet);
        return this.pollLimiter.run(fn).catch((e) => {
          this.cooldown.registrar(e);
          throw e;
        });
      },
      { venue: this.venue, attempts: 2 },
    );
  }

  /**
   * Token de autenticación para los GET firmados. Se genera por llamada: es
   * barato (firma local, sin red) y evita tener que gestionar su caducidad.
   */
  private authToken(): string {
    const [token, err] = this.signer.create_auth_token_with_expiry();
    if (err || !token) throw toExchangeError(err ?? 'No se pudo firmar el token', this.venue);
    return token;
  }

  // ═══════════════════════════════════════════════════════════════
  // Metadatos y estado
  // ═══════════════════════════════════════════════════════════════

  private async loadMarkets(): Promise<MarketSpec[]> {
    // `filter: 'perp'` lo resuelve el VENUE. Antes se traía el catálogo entero
    // —perps y spot— para descartar la mitad aquí: más bytes por el cable y más
    // trabajo del servidor por el mismo peso de cupo.
    const { data } = await this.call(() => this.orderApi.orderBookDetails(undefined, 'perp'));
    return data.order_book_details
      .filter((d) => d.market_type === 'perp')
      .map((d) => {
        this.marketIndex.set(d.symbol, d.market_id);
        this.detailsBySymbol.set(d.symbol, d);

        const tickSize = D(10).pow(-d.supported_price_decimals);
        const stepSize = D(10).pow(-d.supported_size_decimals);
        return {
          venue: Venue.LIGHTER,
          symbol: d.symbol,
          canonical: canonicalSymbol(d.symbol, 'USDC'),
          base: d.symbol,
          quote: 'USDC',
          tickSize: tickSize.toFixed(),
          stepSize: stepSize.toFixed(),
          minNotional: d.min_quote_amount ?? null,
          minQty: d.min_base_amount ?? null,
          maxQty: null,
          maxLeverage: maxLeverageOf(d),
          priceDecimals: d.supported_price_decimals,
          qtyDecimals: d.supported_size_decimals,
          active: d.status === 'active',
        } satisfies MarketSpec;
      });
  }

  async verify(): Promise<{ ok: boolean; publicRef: string; detail?: string }> {
    const ref = String(this.creds.accountIndex);
    try {
      const clientError = this.signer.check_client();
      if (clientError) return { ok: false, publicRef: ref, detail: clientError };
      await this.account();
      return { ok: true, publicRef: ref };
    } catch (e) {
      return { ok: false, publicRef: ref, detail: toExchangeError(e, this.venue).message };
    }
  }

  /** Cuenta memoizada: saldo y posiciones salen de UNA llamada, no de dos. */
  private accountMemo: { at: number; value: Promise<unknown> } | null = null;

  private async account() {
    // `getBalances` y `getPositions` leen el mismo endpoint y el motor las pide
    // juntas en cada tick: sin el memo eran dos llamadas idénticas por tick.
    if (this.accountMemo && Date.now() - this.accountMemo.at < 800) {
      return this.accountMemo.value as ReturnType<LighterAdapter['fetchAccount']>;
    }
    const value = this.fetchAccount();
    this.accountMemo = { at: Date.now(), value };
    void value.catch(() => {
      this.accountMemo = null;
    });
    return value;
  }

  private async fetchAccount() {
    const { data } = await this.call(() =>
      this.accountApi.account('index', String(this.creds.accountIndex)),
    );
    const account = data.accounts?.[0];
    if (!account) throw new ExchangeError('AUTH', 'Cuenta de Lighter no encontrada', this.venue);
    return account;
  }

  getMarkets(): Promise<MarketSpec[]> {
    return this.markets.all();
  }

  async getBalances(): Promise<Balance[]> {
    const account = await this.account();
    const total = firstNum(account.collateral, 0);
    const available = firstNum(account.available_balance, 0);
    return [
      {
        asset: 'USDC',
        total: total.toFixed(),
        available: available.toFixed(),
        used: total.minus(available).toFixed(),
      },
    ];
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const account = await this.account();
    return (account.positions ?? [])
      .filter((p) => !symbol || p.symbol === symbol)
      .filter((p) => !firstNum(p.position, 0).isZero())
      .map((p) => {
        // `position` viene SIEMPRE en positivo; el sentido está en `sign`.
        const size = firstNum(p.position, 0).mul(p.sign < 0 ? -1 : 1);
        const detail = this.detailsBySymbol.get(p.symbol);
        return {
          venue: Venue.LIGHTER,
          symbol: p.symbol,
          qty: size.toFixed(),
          entryPrice: firstNum(p.avg_entry_price, 0).toFixed(),
          markPrice: firstNum(detail?.last_trade_price, p.avg_entry_price, 0).toFixed(),
          unrealizedPnl: firstNum(p.unrealized_pnl, 0).toFixed(),
          leverage: leverageFromMarginFraction(p.initial_margin_fraction),
          marginMode: p.margin_mode === SignerClient.ISOLATED_MARGIN_MODE ? 'ISOLATED' : 'CROSS',
          liquidationPrice:
            isFiniteNum(p.liquidation_price) && !firstNum(p.liquidation_price, 0).isZero()
              ? firstNum(p.liquidation_price, 0).toFixed()
              : null,
          marginUsed: firstNum(p.allocated_margin, 0).toFixed(),
        };
      });
  }

  async getOpenOrders(symbol?: string): Promise<VenueOrder[]> {
    return this.fetchOpenOrders(symbol, (fn) => this.call(fn));
  }

  /**
   * Órdenes activas. El envoltorio de llamada se recibe para que el sondeo use
   * el limitador de baja prioridad y no compita con la ejecución.
   *
   * Pedir SIN símbolo recorre el catálogo entero con una llamada firmada por
   * mercado. Es correcto y a veces necesario, pero es caro: el sondeo periódico
   * nunca debe hacerlo.
   */
  private async fetchOpenOrders(
    symbol: string | undefined,
    call: <T>(fn: () => Promise<T>) => Promise<T>,
  ): Promise<VenueOrder[]> {
    const specs = await this.markets.all();
    const targets = symbol ? [symbol] : specs.filter((s) => s.active).map((s) => s.symbol);

    const batches = await Promise.all(
      targets.map(async (sym) => {
        const marketId = await this.marketIdOf(sym);
        const { data } = await call(() =>
          this.orderApi.accountActiveOrders(
            this.creds.accountIndex,
            marketId,
            undefined,
            this.authToken(),
          ),
        );
        return (data.orders ?? []).map((o) => this.toVenueOrder(o, sym));
      }),
    );
    return batches.flat();
  }

  /**
   * Ejecuciones de la cuenta posteriores a `sinceMs`.
   *
   * El SDK no trae stream de usuario. La API SÍ —`account_all/{id}` con
   * `auth`—, pero todavía no está implementado, así que hoy esta es la ÚNICA
   * fuente de ejecuciones del venue, no un respaldo. El sondeo la usa para
   * alimentar `fills$` y el motor la usa además como red de seguridad.
   */
  async getRecentFills(symbol: string, sinceMs: number): Promise<Fill[]> {
    const marketId = await this.marketIdOf(symbol);
    // Sin filtro `from` en la petición: su unidad de tiempo no está documentada
    // y un desacuerdo silencioso dejaría la respuesta vacía para siempre — que
    // es exactamente el fallo que esta función viene a arreglar. Se piden las
    // últimas 100 de la cuenta y se filtra aquí, donde la unidad la controlamos
    // nosotros.
    const { data } = await this.pollCall(
      () =>
        this.orderApi.trades(
          'timestamp',
          100,
          undefined,
          this.authToken(),
          marketId,
          this.creds.accountIndex,
          undefined,
          'desc',
        ),
      // `trades` pesa 600, el DOBLE que cualquier otra lectura: cuesta dos
      // peticiones-equivalentes contra el cupo de 60 por minuto. Se
      // contabilizaba como 2 de un peso que no era el suyo.
      lighterCost('trades'),
    );

    const mine = this.creds.accountIndex;
    return (data.trades ?? [])
      .filter((t) => t.ask_account_id === mine || t.bid_account_id === mine)
      .filter((t) => normalizeTs(t.timestamp) >= sinceMs)
      .map((t) => {
        // Somos el lado vendedor si la orden del ask es nuestra.
        const weAsk = t.ask_account_id === mine;
        const weMaker = weAsk ? t.is_maker_ask : !t.is_maker_ask;
        return {
          venue: Venue.LIGHTER,
          symbol,
          // NO se marca `liquidation`: el payload de trades de Lighter no trae
          // ningún campo que lo diga, al contrario que Hyperliquid (`dir`) y
          // Aster (tipo de orden `LIQUIDATION`). Sin la marca, una liquidación
          // aquí se comporta como siempre: la posición desaparece del venue pero
          // la contabilidad del bot no se entera. Si el campo aparece en su API,
          // añadirlo es una línea.
          //
          // El `trade_id` es del venue y único dentro de él; el ledger deduplica
          // por (orden, id), así que basta con esto.
          venueFillId: String(t.trade_id),
          venueOrderId: String(weAsk ? t.ask_id : t.bid_id),
          clientOrderId: String(weAsk ? t.ask_client_id : t.bid_client_id),
          side: weAsk ? ('SELL' as const) : ('BUY' as const),
          price: D(t.price).toFixed(),
          qty: D(t.size).toFixed(),
          fee: feeToUsdc(weMaker ? t.maker_fee : t.taker_fee),
          feeAsset: 'USDC',
          isTaker: !weMaker,
          ts: normalizeTs(t.timestamp),
        };
      })
      .sort((a, b) => a.ts - b.ts);
  }

  /**
   * Precio de un símbolo.
   *
   * Se sirve del stream SIEMPRE que esté caliente, y solo entonces se ahorra la
   * llamada. `market_stats/all` ya trae la mejor oferta y demanda de todos los
   * mercados, así que cuando el socket entrega, esta función no cuesta nada.
   *
   * El respaldo por REST no sobra: el motor pide el precio para planificar y un
   * fallo del socket no puede dejarle sin él.
   */
  async getTicker(symbol: string): Promise<Ticker> {
    const live = this.statsFresh() ? this.statsOf(symbol) : undefined;
    if (live) {
      const bid = firstNum(live.best_bid_price, 0);
      const ask = firstNum(live.best_ask_price, 0);
      const mid = bid.gt(0) && ask.gt(0) ? bid.plus(ask).div(2) : firstNum(live.mid_price, 0);
      return {
        venue: Venue.LIGHTER,
        symbol,
        last: firstNum(live.last_trade_price, mid).toFixed(),
        bid: bid.toFixed(),
        ask: ask.toFixed(),
        mark: firstNum(live.mark_price, live.index_price, mid).toFixed(),
        ts: Date.now(),
      };
    }

    const marketId = await this.marketIdOf(symbol);
    const { data } = await this.call(() => this.orderApi.orderBookOrders(marketId, 1));
    const bid = firstNum(data.bids?.[0]?.price, 0);
    const ask = firstNum(data.asks?.[0]?.price, 0);
    const detail = this.detailsBySymbol.get(symbol);
    const mid =
      bid.gt(0) && ask.gt(0) ? bid.plus(ask).div(2) : firstNum(detail?.last_trade_price, 0);
    return {
      venue: Venue.LIGHTER,
      symbol,
      last: firstNum(detail?.last_trade_price, mid).toFixed(),
      bid: bid.toFixed(),
      ask: ask.toFixed(),
      mark: mid.toFixed(),
      ts: Date.now(),
    };
  }

  /**
   * Precio y sesión de 24 h de todos los perps.
   *
   * Esta es la llamada que devolvía el CAPTCHA del firewall. Salía de
   * `orderBookDetails` —peso 300— y la disparaban a la vez el cron de precios
   * cada 30 s y CADA petición de velas, porque el adaptador se construía de
   * nuevo en cada una y tenía que releer el catálogo para traducir el símbolo a
   * `market_id`.
   *
   * Ahora se sirve de `market_stats/all`: UNA suscripción para los 900+ pares,
   * que además ya está abierta porque la comparten los tickers en vivo. El REST
   * queda de respaldo para el arranque en frío y para cuando el socket no
   * entrega.
   *
   * LEE la tabla del stream pero no lo ABRE, y la diferencia importa: quien
   * llama aquí puede ser un adaptador de una sola petición, y abrirle un socket
   * para servir una lectura sería gastar una conexión de las 255 de la IP para
   * cerrarla acto seguido. El socket lo abre quien se va a quedar escuchando
   * —`streamTicker` y `streamCandles`—, y a partir de ahí esta función es
   * gratis.
   */
  async getTickers(): Promise<MarketTicker[]> {
    if (this.statsFresh()) {
      // Sin filtrar por tipo de mercado, y comprobado contra el venue:
      // `market_stats/all` trae SOLO perps —229 símbolos desnudos, «BTC»— y el
      // spot viaja por `spot_market_stats/all` —11 símbolos con par,
      // «ETH/USDC»—, sin un solo símbolo en común. El camino por REST sí filtra
      // porque `orderBookDetails` mezcla los dos.
      const rows: MarketTicker[] = [];
      for (const stat of this.stats.values()) {
        if (!stat.symbol) continue;
        const last = num(stat.last_trade_price ?? stat.mid_price ?? 0);
        rows.push({
          venue: Venue.LIGHTER,
          symbol: stat.symbol,
          last,
          change24h: absoluteChange(last, stat.daily_price_change),
          // `daily_price_change` viene en PORCENTAJE. Aquí no hay ambigüedad
          // que esquivar —la unidad está medida contra el venue, ver
          // `LighterMarketStats`— y por eso este camino no necesita el rodeo
          // por `daily_chart` que sí hace el respaldo por REST.
          //
          // Cuatro decimales, los mismos que `changePct`: los dos caminos
          // alimentan la misma columna de la misma pantalla y una diferencia de
          // formato entre ellos se leería como un cambio de precio.
          changePct24h:
            stat.daily_price_change === undefined ? null : D(stat.daily_price_change).toFixed(4),
          high24h: numOrNull(stat.daily_price_high),
          low24h: numOrNull(stat.daily_price_low),
          volume24h: numOrNull(stat.daily_quote_token_volume),
          ts: Date.now(),
        } satisfies MarketTicker);
      }
      if (rows.length > 0) return rows;
    }

    const { data } = await this.call(() => this.orderApi.orderBookDetails(undefined, 'perp'));
    return data.order_book_details
      .filter((d) => d.market_type === 'perp')
      .map((d) => {
        this.detailsBySymbol.set(d.symbol, d);
        const last = num(d.last_trade_price);
        // El precio de hace 24 h sale de `daily_chart`, no de
        // `daily_price_change`.
        //
        // En el REST se mantiene el rodeo aunque la unidad ya esté medida en el
        // stream: `daily_chart` es una serie de precios y no admite dos
        // interpretaciones, así que sigue siendo la lectura más segura donde
        // está disponible — y el stream no la trae.
        const prev = oldestPrice(d.daily_chart);
        return {
          venue: Venue.LIGHTER,
          symbol: d.symbol,
          last,
          change24h: prev === null ? null : D(last).minus(prev).toFixed(),
          changePct24h: prev === null ? numOrNull(d.daily_price_change) : changePct(last, prev),
          high24h: numOrNull(d.daily_price_high),
          low24h: numOrNull(d.daily_price_low),
          volume24h: numOrNull(d.daily_quote_token_volume),
          ts: Date.now(),
        } satisfies MarketTicker;
      });
  }

  /**
   * Velas.
   *
   * NO usa el `CandlestickApi` del SDK. El SDK —zklighter-sdk 1.3.0, la última
   * publicada— pega contra `/api/v1/candlesticks`, y ese camino ya no existe:
   * el borde (CloudFront) lo corta con un 403 vacío antes de llegar a Lighter,
   * así que ni siquiera se recibe un mensaje que explique el rechazo. El
   * endpoint vigente es `/api/v1/candles`, con OTRA forma de respuesta
   * —`{code, r, c: [{t, o, h, l, c, v, V, i}]}` en vez de `{candlesticks: [...]}`—,
   * que es la que se lee aquí a mano.
   *
   * Documentación: https://apidocs.lighter.xyz/reference/candles.md
   *
   * Dos detalles del contrato que no se pueden deducir de la respuesta:
   *   · Las marcas de tiempo van en MILISEGUNDOS (rango 0–5e12).
   *   · «Zero values are omitted from the response»: un campo que valga cero
   *     no viene. Por eso cada uno lleva su `?? 0` — sin él, una vela sin
   *     volumen daría `undefined` y `num` lo convertiría en '0' igualmente,
   *     pero un cierre ausente pasaría a null y rompería la serie.
   */
  async getCandles(
    symbol: string,
    interval: CandleInterval,
    query: CandleQuery,
  ): Promise<Candle[]> {
    const iv = checkInterval(this.venue, LIGHTER_INTERVALS, interval);
    const marketId = await this.marketIdOf(symbol);
    const { startMs, endMs, limit } = resolveRange(
      interval,
      query,
      this.capabilities.candles.maxBars,
    );
    const body = await this.call(() =>
      this.publicGet<LighterCandles>('/api/v1/candles', {
        market_id: marketId,
        resolution: iv,
        start_timestamp: startMs,
        end_timestamp: endMs,
        count_back: Math.min(limit + 1, this.capabilities.candles.maxBars),
      }),
    );

    return finishCandles(
      (body.c ?? []).map((c) => ({
        // Lighter sirve las velas como NUMBER y aquí se convierten a string
        // decimal exacto. Sin esto un precio de dieciocho decimales se degrada
        // en silencio y deja de casar con el tick del venue.
        t: normalizeTs(c.t ?? 0),
        o: num(c.o ?? 0),
        h: num(c.h ?? 0),
        l: num(c.l ?? 0),
        c: num(c.c ?? 0),
        v: numOrNull(c.v ?? 0),
      })),
      limit,
    );
  }

  /**
   * GET público contra la REST de Lighter, sin firmar.
   *
   * Existe porque el SDK se ha quedado atrás en algún endpoint (ver
   * `getCandles`). Pasa por el mismo `call` que el resto: limitador de caudal,
   * presupuesto compartido con los bots y reintento con backoff.
   */
  /**
   * Cabeceras de toda petición REST.
   *
   * Lleva el token de autenticación SIEMPRE que haya con qué firmarlo. La
   * documentación de Lighter: «To bypass IP-based rate limits, clients can
   * authenticate each request so that only L1-based rate limits apply». Sin
   * firmar, el cupo son 60 peticiones por minuto para TODA la IP de salida, y
   * se comparte con cualquier otro que salga por ella.
   *
   * Firmar no sube el cupo por sí solo —una cuenta Standard sigue en 60/min—:
   * lo que cambia es que se cuenta por CUENTA y no por IP. La subida la da el
   * tier de la cuenta, y son dos cosas distintas que conviene no mezclar.
   */
  private restHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.authHeaderToken();
    if (token) headers.authorization = token;
    return headers;
  }

  /**
   * Token de autenticación cacheado.
   *
   * Antes se firmaba uno NUEVO en cada llamada. Es firma local y no cuesta red,
   * pero tampoco hace falta: el del SDK dura diez minutos
   * (`DEFAULT_10_MIN_AUTH_EXPIRY`) y se renueva a los ocho, con margen de sobra
   * para que ninguna petición salga con uno recién caducado.
   *
   * Devuelve null sin credenciales —el adaptador público sin cuenta de
   * servicio— en vez de lanzar: leer precios no exige firma, solo se paga con
   * el cupo más estrecho.
   */
  private authHeaderToken(): string | null {
    if (!this.creds.apiPrivateKey) return null;
    if (this.authCache && Date.now() < this.authCache.until) return this.authCache.token;
    try {
      const token = this.authToken();
      this.authCache = { token, until: Date.now() + AUTH_TOKEN_TTL_MS };
      // El SDK lee `baseOptions.headers` en CADA petición, así que mutar este
      // mismo objeto basta para que el token nuevo llegue también a las
      // llamadas que hace el SDK por su cuenta.
      this.sdkHeaders.authorization = token;
      return token;
    } catch {
      // Una credencial que no firma no puede dejar sin precios a quien solo
      // quería leer: se sigue sin token y con el cupo sin autenticar.
      return null;
    }
  }

  private async publicGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) search.append(k, String(v));
    const res = await fetch(`${this.url}${path}?${search.toString()}`, {
      method: 'GET',
      headers: this.restHeaders(),
    });
    const text = await res.text();
    let body: unknown;
    let esJson = true;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
      esJson = false;
    }

    // El cortafuegos, ANTES que el estado. Su página llega a veces con 200 y
    // cuerpo HTML, y entonces pasaba las dos comprobaciones de abajo y se
    // devolvía como si fuera la respuesta pedida: `body.c` era `undefined`,
    // `finishCandles` recibía una lista vacía y el gráfico salía en blanco sin
    // un solo error. Clasificado aquí, se distingue de un fallo del venue y no
    // se reintenta.
    if (isThrottled(text, res.status)) {
      throw new ExchangeError(
        'THROTTLED',
        `Lighter ha cortado las peticiones de esta IP (HTTP ${res.status}). ` +
          'Su cortafuegos aplica 60 s de enfriamiento.',
        this.venue,
        text,
      );
    }

    // Un 403 del borde llega SIN cuerpo: sin el `statusText` de reserva el
    // error subiría vacío y la pantalla diría «Error desconocido».
    if (!res.ok) {
      throw toExchangeError(
        (esJson && (body as { message?: string } | null)?.message) ||
          `HTTP ${res.status} ${res.statusText}`,
        this.venue,
        res.status,
      );
    }

    // Un 200 con cuerpo que no es JSON no es una respuesta: es otra cosa
    // disfrazada. Devolverlo como `T` es mentirle al que llama.
    if (!esJson) {
      throw new ExchangeError(
        'FATAL',
        `Lighter ha respondido algo que no es JSON en ${path}: ${shortMessage(text, 120)}`,
        this.venue,
        text,
      );
    }

    // Lighter responde 200 con `{code, message}` en los rechazos de parámetros
    // —un `resolution` que no sirve sale así—, no con un 4xx.
    const maybe = body as { code?: number; message?: string };
    if (typeof maybe?.code === 'number' && maybe.code !== 200) {
      throw toExchangeError(maybe.message?.trim() || `Error ${maybe.code}`, this.venue);
    }
    return body as T;
  }

  // ═══════════════════════════════════════════════════════════════
  // Ejecución
  // ═══════════════════════════════════════════════════════════════

  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    const spec = await this.markets.get(req.symbol);
    const marketId = await this.marketIdOf(req.symbol);
    const clientIndex = lighterCodec.encodeNumeric!(req.clientOrderId);

    const baseAmount = scaled(req.qty, spec.qtyDecimals);
    const price = scaled(req.price ?? '0', spec.priceDecimals);
    const isAsk = req.side === 'SELL';

    if (req.type === 'MARKET') {
      // También la rama MARKET verifica antes de reenviar. Es donde el reenvío
      // a ciegas hace más daño: una market ya ejecutada no aparece entre las
      // abiertas, así que sin mirar las ejecuciones se reenviaría y la posición
      // quedaría DOBLADA. No se confía en que el venue rechace el índice de
      // cliente repetido: tras ejecutarse, la orden ya no está activa y esa
      // protección puede no aplicar.
      return withWriteRetry(
        async () => {
          await this.budget.take(this.venue, 1, 'write', this.testnet);
          const result = await this.signedWrite((signer) =>
            this.limiter.run(() =>
              signer.create_market_order(
                marketId,
                clientIndex,
                baseAmount,
                price,
                isAsk,
                req.reduceOnly === true,
              ),
            ),
          );
          this.unwrap(result as [unknown, unknown, string | null]);
          return {
            clientOrderId: req.clientOrderId,
            venueOrderId: String(clientIndex),
            status: OrderStatus.FILLED,
            ts: Date.now(),
          };
        },
        () => this.findPlaced(req.symbol, req.clientOrderId, String(clientIndex)),
        { venue: this.venue },
      );
    }

    const timeInForce =
      req.type === 'POST_ONLY'
        ? SignerClient.ORDER_TIME_IN_FORCE_POST_ONLY
        : SignerClient.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME;

    // El sentido del disparo lo declara quien pide la orden: un take-profit
    // etiquetado como stop-loss se dispararía al revés.
    const orderType = req.triggerPrice
      ? req.intent === 'TP'
        ? SignerClient.ORDER_TYPE_TAKE_PROFIT_LIMIT
        : SignerClient.ORDER_TYPE_STOP_LOSS_LIMIT
      : SignerClient.ORDER_TYPE_LIMIT;

    return withWriteRetry(
      async () => {
        await this.budget.take(this.venue, 1, 'write', this.testnet);
        const result = await this.signedWrite((signer) =>
          this.limiter.run(() =>
            signer.create_order(
              marketId,
              clientIndex,
              baseAmount,
              price,
              isAsk,
              orderType,
              timeInForce,
              req.reduceOnly === true,
              req.triggerPrice
                ? scaled(req.triggerPrice, spec.priceDecimals)
                : SignerClient.NIL_TRIGGER_PRICE,
              SignerClient.DEFAULT_28_DAY_ORDER_EXPIRY,
            ),
          ),
        );
        this.unwrap(result as [unknown, unknown, string | null]);

        // Lighter no devuelve el `order_index` definitivo en el ack: se asigna
        // al incluir la transacción. El motor identifica la orden por su índice
        // de cliente, que sí es nuestro y determinista, y completa el id de
        // venue en el siguiente barrido de reconciliación.
        return {
          clientOrderId: req.clientOrderId,
          venueOrderId: String(clientIndex),
          status: OrderStatus.PENDING,
          ts: Date.now(),
        };
      },
      () => this.findPlaced(req.symbol, req.clientOrderId, String(clientIndex)),
      { venue: this.venue },
    );
  }

  /**
   * ¿Llegó a entrar esta orden? Distingue «falló el envío» de «se perdió el
   * acuse». Mira el libro Y las ejecuciones recientes: una market que entró ya
   * no está entre las abiertas, y darla por no-enviada la duplicaría.
   */
  private async findPlaced(
    symbol: string,
    clientOrderId: string,
    clientIndex: string,
  ): Promise<OrderAck | null> {
    const found = (await this.getOpenOrders(symbol)).find((o) => o.clientOrderId === clientIndex);
    if (found) {
      return {
        clientOrderId,
        venueOrderId: found.venueOrderId,
        status: found.status,
        ts: Date.now(),
      };
    }

    const fills = await this.getRecentFills(symbol, Date.now() - 120_000).catch(() => []);
    const filled = fills.find((f) => f.clientOrderId === clientIndex);
    if (filled) {
      return {
        clientOrderId,
        venueOrderId: filled.venueOrderId,
        status: OrderStatus.FILLED,
        ts: Date.now(),
      };
    }
    return null;
  }

  async cancelOrder(req: CancelRequest): Promise<void> {
    const marketId = await this.marketIdOf(req.symbol);

    // cancel_order exige el `order_index` del venue, no el del cliente: si solo
    // tenemos el nuestro, hay que resolverlo antes contra las órdenes activas.
    let orderIndex = req.venueOrderId;
    if (!orderIndex && req.clientOrderId) {
      const target = lighterCodec.encodeNumeric!(req.clientOrderId);
      const open = await this.getOpenOrders(req.symbol);
      orderIndex = open.find((o) => o.clientOrderId === String(target))?.venueOrderId;
    }
    if (!orderIndex) {
      // Ya no existe: cancelar algo que no está es un no-op, no un error — el
      // motor llegaría aquí también cuando la orden se acaba de ejecutar.
      return;
    }
    this.unwrap(
      (await this.signedWrite((signer) =>
        this.call(() => signer.cancel_order(marketId, BigInt(orderIndex))),
      )) as [unknown, unknown, string | null],
    );
  }

  /**
   * Cancela SOLO los ids dados.
   *
   * En Lighter esto no es una optimización, es la única forma correcta de
   * limpiar un bot: `cancelAll` tiene alcance de CUENTA y se llevaría por
   * delante las órdenes de todos los demás bots del usuario en este venue.
   */
  async cancelOwn(symbol: string, clientOrderIds: string[]): Promise<void> {
    if (clientOrderIds.length === 0) return;
    const marketId = await this.marketIdOf(symbol);
    // Una sola lectura del libro para resolver todos los índices: hacerlo por
    // orden multiplicaba las llamadas justo en el camino de un pánico.
    const open = await this.getOpenOrders(symbol);
    const byClientId = new Map(open.map((o) => [o.clientOrderId, o.venueOrderId]));

    for (const coid of clientOrderIds) {
      const target = String(lighterCodec.encodeNumeric!(coid));
      const orderIndex = byClientId.get(target);
      // Que ya no esté es un no-op, no un error: pasa cada vez que una orden se
      // ejecuta entre la lectura y la cancelación.
      if (!orderIndex) continue;
      this.unwrap(
        (await this.signedWrite((signer) =>
          this.call(() => signer.cancel_order(marketId, BigInt(orderIndex))),
        )) as [unknown, unknown, string | null],
      );
    }
  }

  /**
   * Alcance de CUENTA: se lleva por delante TODAS las órdenes del usuario en
   * Lighter, de cualquier bot y cualquier mercado. Solo el kill-switch global
   * debe llamar aquí; para limpiar un bot está `cancelOwn`.
   */
  async cancelAll(_symbol: string): Promise<void> {
    this.unwrap(
      await this.signedWrite((signer) =>
        this.call(() =>
          // El segundo argumento va a CERO, no a `Date.now()`.
          //
          // Con `CANCEL_ALL_TIF_IMMEDIATE` el venue exige que el instante venga
          // vacio y rechaza la transaccion con «CancelAllTime should be nil»:
          // el kill-switch de Lighter no cancelaba NADA y devolvia un error que
          // no se parecia en nada al problema. Comprobado contra testnet, con
          // dos ordenes abiertas y nonce explicito para aislar la causa:
          //
          //   IMMEDIATE + Date.now()  -> «CancelAllTime should be nil»
          //   IMMEDIATE + 0           -> OK, las dos canceladas
          //   SCHEDULED + ahora+60 s  -> «invalid cancel all time»
          //
          // El instante solo lo lleva la variante programada, y ni siquiera con
          // un valor en milisegundos: aqui no se usa.
          signer.cancel_all_orders(SignerClient.CANCEL_ALL_TIF_IMMEDIATE, 0),
        ),
      ),
    );
  }

  async setLeverage(symbol: string, leverage: number, mode: MarginMode): Promise<void> {
    const marketId = await this.marketIdOf(symbol);
    this.unwrap(
      await this.signedWrite((signer) =>
        this.call(() =>
          signer.update_leverage(
            marketId,
            mode === 'CROSS' ? SignerClient.CROSS_MARGIN_MODE : SignerClient.ISOLATED_MARGIN_MODE,
            leverage,
          ),
        ),
      ),
    );
  }

  /**
   * Aporta o retira colateral de una posición aislada.
   *
   * `side` no se usa: en Lighter la posición es única por mercado y cuenta, así
   * que el mercado ya la identifica sin ambigüedad. Se acepta igualmente porque
   * el parámetro pertenece a la interfaz —Hyperliquid y Aster SÍ lo necesitan—
   * y quitarlo aquí obligaría al llamante a saber contra qué venue está.
   *
   * `usdc_amount` va en USDC LEGIBLE, no escalado: el SDK multiplica por
   * `USDC_TICKER_SCALE` dentro de `update_margin`. Pasarlo ya escalado aportaba
   * un billón de veces lo pedido.
   *
   * Va por `limiter.run` directo y NO por `call`, al contrario que
   * `setLeverage`, porque esto NO es idempotente: fijar el apalancamiento dos
   * veces lo deja donde ya estaba, pero aportar margen dos veces aporta el
   * doble. `call` reintenta lo RETRYABLE, y un timeout que llegó a aplicarse
   * duplicaría el aporte en silencio. El reintento de `signedWrite` sí se
   * conserva: solo dispara con «invalid nonce», que significa que la
   * transacción NO entró.
   */
  async adjustIsolatedMargin(
    symbol: string,
    amountUsd: string,
    action: MarginAction,
    _side: PositionSide,
  ): Promise<void> {
    const marketId = await this.marketIdOf(symbol);
    const amount = D(amountUsd).abs();
    if (amount.lte(0)) {
      throw new ExchangeError(
        'RULES',
        'El importe del ajuste de margen debe ser mayor que cero.',
        this.venue,
      );
    }
    await this.budget.take(this.venue, 1, 'write', this.testnet);
    this.unwrap(
      await this.signedWrite((signer) =>
        this.limiter.run(() =>
          signer.update_margin(
            marketId,
            amount.toNumber(),
            action === 'REMOVE'
              ? SignerClient.ISOLATED_MARGIN_REMOVE_COLLATERAL
              : SignerClient.ISOLATED_MARGIN_ADD_COLLATERAL,
          ),
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Tiempo real
  // ═══════════════════════════════════════════════════════════════

  /**
   * Órdenes y ejecuciones de la cuenta, por sondeo.
   *
   * El comentario que había aquí decía «Lighter no expone un stream de usuario
   * en este SDK». Cierto del SDK y FALSO de la API: su WebSocket tiene
   * `account_all/{account_index}` con `auth`. Mientras se dio por bueno, el
   * estado de cuenta se sondeaba cada tres segundos por símbolo, y una de esas
   * dos llamadas era `trades`, que pesa 600.
   *
   * El sondeo se conserva —el motor tiene que seguir viendo sus órdenes si el
   * socket se cae— pero con dos cambios que lo sacan del camino normal:
   *
   * · El intervalo sale del cupo REAL del venue, no de un 3000 escrito a mano.
   *   Sin cuenta de servicio son 60 peticiones por minuto para toda la IP: dos
   *   llamadas cada tres segundos son cuarenta por minuto y por símbolo, o sea
   *   que DOS símbolos abiertos se lo comían entero.
   * · Cada barrido comprueba antes si el socket está entregando. Mientras lo
   *   esté, no se manda nada.
   */
  private ensurePolling(): void {
    if (this.pollTimer || this.closed) return;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    void this.poll();
  }

  /**
   * ¿Toca sondear el estado de CUENTA?
   *
   * Ojo con lo que gobierna esta decisión: el estado de cuenta —órdenes y
   * ejecuciones— y los precios viajan por canales DISTINTOS. Que el de precios
   * esté entregando no dice absolutamente nada sobre el otro.
   *
   * La primera versión de esto miraba `wsUp`, que es la salud del socket de
   * precios, y apagaba el sondeo en cuanto los precios llegaban. Como todavía
   * no hay suscripción a `account_all`, el resultado era que un bot con el
   * gráfico abierto dejaba de ver sus propias ejecuciones: sin fills no hay
   * ledger, sin ledger no hay precio medio ni cierre, y las estrategias cuyo id
   * de orden depende del número de entradas se quedaban paradas para siempre.
   * Es exactamente la avería que `pollFills` vino a arreglar en su día.
   *
   * Mientras `account_all` no esté implementado y VERIFICADO contra el venue,
   * el sondeo es la única fuente de ejecuciones de Lighter y no se apaga. Lo
   * que sí ha cambiado es lo que cuesta: doce segundos en vez de tres, y con el
   * peso real de `trades` (600) descontado del presupuesto.
   */
  private shouldPoll(): boolean {
    // `accountStreamUp` será lo que gobierne esto cuando exista el canal de
    // cuenta. Hoy es siempre false, y por tanto se sondea — que es lo correcto.
    if (!this.accountStreamUp) return true;
    if (this.accountStreamDownSince === 0) return false;
    return Date.now() - this.accountStreamDownSince > WS_FALLBACK_AFTER_MS;
  }

  /**
   * Un barrido: órdenes y ejecuciones de los símbolos vigilados.
   *
   * Está serializado. Sin el cerrojo, un barrido lento se solapaba con el
   * siguiente y ambos encolaban peticiones en el limitador, que es justo el
   * camino a que la cola no baje nunca.
   */
  private async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    // El WebSocket manda. Mientras entregue, este barrido no gasta ni una
    // petición: es un respaldo, no una segunda fuente.
    if (!this.shouldPoll()) return;
    this.polling = true;
    try {
      const symbols = [...this.watched];
      if (symbols.length === 0) return;
      for (const symbol of symbols) {
        // Ejecuciones ANTES que órdenes: si una orden acaba de ejecutarse, el
        // fill debe registrarse antes de que el diff de órdenes anuncie su
        // desaparición como CANCELED — al revés, la fila pasaba un instante por
        // CANCELED antes de que el fill la corrigiera a FILLED.
        await this.pollFills(symbol);
        await this.pollOrders(symbol);
      }
      this.health$.next({ stream: 'orders', status: 'UP' });
      this.health$.next({ stream: 'fills', status: 'UP' });
    } catch (e) {
      // Un barrido fallido no tumba el stream: se reintenta al siguiente. Pero
      // SÍ se anuncia, para que el motor sepa que su visión puede estar vieja.
      const detail = messageOf(e);
      this.health$.next({ stream: 'orders', status: 'DOWN', detail });
      this.health$.next({ stream: 'fills', status: 'DOWN', detail });
    } finally {
      this.polling = false;
    }
  }

  private async pollOrders(symbol: string): Promise<void> {
    const open = await this.fetchOpenOrders(symbol, (fn) => this.pollCall(fn));
    const alive = new Set<number>();

    for (const order of open) {
      const index = Number(order.venueOrderId);
      alive.add(index);
      this.lastSeenOrder.set(index, order);
      const signature = order.status + ':' + order.filledQty;
      if (this.seenOrders.get(index) !== signature) {
        this.seenOrders.set(index, signature);
        this.orders$.next(order);
      }
    }

    // Lo que desaparece de las activas se ha ejecutado o cancelado. Desde aquí
    // no se puede saber cuál, así que se emite como CANCELED y es la
    // reconciliación —que compara contra el libro y la posición real— quien
    // decide. El comentario decía justo esto y el código no lo hacía: se
    // limitaba a borrar del mapa, y el motor no se enteraba nunca.
    for (const [index, signature] of [...this.seenOrders]) {
      if (alive.has(index)) continue;
      this.seenOrders.delete(index);
      const previous = this.lastSeenOrder.get(index);
      if (previous && previous.symbol === symbol) {
        this.orders$.next({ ...previous, status: OrderStatus.CANCELED });
        this.lastSeenOrder.delete(index);
      }
      void signature;
    }
  }

  /**
   * Ejecuciones nuevas del símbolo.
   *
   * Esto NO existía: `fills$` se declaraba, se exponía y se completaba, pero
   * nunca recibía un `next()`. Sin fills el motor no registra nada en el
   * ledger, así que en Lighter el ciclo no avanzaba: sin precio medio, sin PnL,
   * sin cierre y sin cooldown. Las estrategias cuyo id de orden depende del
   * número de entradas —TDCA, Martingale, GridMart— colocaban la primera orden
   * y no volvían a comprar jamás.
   */
  private async pollFills(symbol: string): Promise<void> {
    const since = this.lastFillTs.get(symbol) ?? Date.now() - 60_000;
    const fills = await this.getRecentFills(symbol, since);
    for (const fill of fills) {
      this.fills$.next(fill);
      if (fill.ts > since) this.lastFillTs.set(symbol, fill.ts);
    }
  }

  streamOrders(): Observable<OrderUpdate> {
    this.ensurePolling();
    return this.orders$.asObservable();
  }

  streamFills(): Observable<Fill> {
    this.ensurePolling();
    return this.fills$.asObservable();
  }

  streamHealth(): Observable<StreamHealth> {
    return this.health$.asObservable();
  }

  /**
   * Precio en vivo por WebSocket.
   *
   * Antes esto era `interval(2000)` sondeando `orderBookOrders`: treinta
   * peticiones por minuto y por símbolo contra un cupo documentado de SESENTA
   * por minuto para toda la IP. Dos símbolos abiertos agotaban el cupo, y el
   * firewall del venue respondía con una página CAPTCHA que acababa impresa en
   * la pantalla del usuario.
   *
   * Se combinan DOS canales porque ninguno basta solo: `ticker/{id}` trae la
   * mejor oferta y demanda en cada cambio de nonce pero no el último
   * negociado, y `market_stats/all` —que ya está abierto para `getTickers`— sí
   * lo trae. La alternativa era una suscripción de estadísticas por símbolo,
   * que es la misma información pagada N veces.
   */
  streamTicker(symbol: string): Observable<Ticker> {
    // Suscribirse al ticker de un símbolo es lo que declara interés en él: a
    // partir de aquí el respaldo por REST mira sus órdenes y ejecuciones, y
    // solo las suyas.
    this.watched.add(symbol);
    this.ensureMarketStats();

    const existing = this.tickers.get(symbol);
    if (existing) return existing;

    const stream = sharedStream<Ticker>(
      (emit) =>
        this.subscribe(
          async () => `ticker/${await this.streamMarketId(symbol)}`,
          (msg) => {
            const t = msg.ticker;
            if (!t) return;
            const bid = firstNum(t.b?.price, 0);
            const ask = firstNum(t.a?.price, 0);
            const mid = bid.gt(0) && ask.gt(0) ? bid.plus(ask).div(2) : D(0);
            const stats = this.statsOf(symbol);
            emit({
              venue: Venue.LIGHTER,
              symbol,
              last: firstNum(stats?.last_trade_price, mid).toFixed(),
              bid: bid.toFixed(),
              ask: ask.toFixed(),
              mark: firstNum(stats?.mark_price, stats?.index_price, mid).toFixed(),
              ts: Date.now(),
            });
          },
        ),
      this.closed$,
    );
    this.tickers.set(symbol, stream);
    return stream;
  }

  /**
   * Vela en formación por WebSocket.
   *
   * Esto NO existía: `capabilities` declaraba `live: false` para Lighter, así
   * que el worker devolvía `false` al pedir velas en vivo y el gráfico se
   * quedaba sondeando `GET /market-data/candles` por REST. Cada una de esas
   * peticiones costaba DOS llamadas al venue —el catálogo y las velas—, y era
   * el camino por el que se agotaba el cupo.
   *
   * El canal entrega la vela viva al suscribirse (`subscribed/candle`) y luego
   * la reemite agrupada cada 500 ms. Las dos formas traen el mismo `candles`,
   * por eso el enrutado va por canal y no por tipo de mensaje.
   */
  streamCandles(symbol: string, interval: CandleInterval): Observable<Candle> {
    const iv = checkInterval(this.venue, LIGHTER_INTERVALS, interval);
    const key = symbol + '|' + interval;
    const existing = this.candleStreams.get(key);
    if (existing) return existing;

    const stream = sharedStream<Candle>(
      (emit) =>
        this.subscribe(
          async () => `candle/${await this.streamMarketId(symbol)}/${iv}`,
          (msg) => {
            // Se entrega la ÚLTIMA del lote: el mensaje trae la vela viva y, en
            // el relevo de barra, también la que acaba de cerrar. Emitirlas
            // todas es correcto y es lo que se hace — quien las consume
            // distingue una de otra por su marca de tiempo.
            for (const c of msg.candles ?? []) {
              emit({
                t: normalizeTs(c.t ?? 0),
                o: num(c.o ?? 0),
                h: num(c.h ?? 0),
                l: num(c.l ?? 0),
                c: num(c.c ?? 0),
                v: numOrNull(c.v ?? 0),
              });
            }
          },
        ),
      this.closed$,
    );
    this.candleStreams.set(key, stream);
    return stream;
  }

  /** Estadísticas vivas de un símbolo, si el stream ya las trajo. */
  private statsOf(symbol: string): LighterMarketStats | undefined {
    const id = this.statsBySymbol.get(symbol);
    return id === undefined ? undefined : this.stats.get(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // WebSocket oficial
  // ═══════════════════════════════════════════════════════════════

  /**
   * La conexión, creada al primer interesado.
   *
   * UNA sola para todos los canales. Lighter multiplexa, así que abrir una por
   * símbolo —como hace Aster, cuyo venue lo exige— sería gastar conexiones de
   * las 255 que permite la IP para nada.
   */
  private ensureSocket(): ReconnectingSocket {
    if (this.socket) return this.socket;
    this.socket = new ReconnectingSocket({
      url: () => this.wsUrl,
      // Al (re)conectar se vuelven a pedir TODOS los canales vivos. Sin esto el
      // socket vuelve pero no llega un solo dato: la avería más difícil de ver,
      // porque el canal está abierto y la salud dice UP.
      onOpen: (socket) => {
        for (const channel of this.channels) {
          socket.send(JSON.stringify({ type: 'subscribe', channel }));
        }
      },
      keepalive: {
        everyMs: WS_PING_EVERY_MS,
        payload: () => JSON.stringify({ type: 'ping' }),
      },
      onMessage: (raw) => this.route(raw),
      // La salud del socket de precios se ANUNCIA y no se guarda: quien decide
      // si hay que sondear el estado de cuenta es `shouldPoll`, y mira el canal
      // de cuenta, que es otro. Guardarla aquí invitaba justo a la confusión
      // que dejó a un bot sin ver sus ejecuciones.
      onHealth: ({ status, detail }) => this.health$.next({ stream: 'ticker', status, detail }),
    });
    return this.socket;
  }

  /**
   * Reparte un mensaje del stream a quien lo pidió.
   *
   * Enruta por `channel` y NO por `type`, con dos motivos medidos contra el
   * venue: el mismo canal manda `subscribed/x` y `update/x` —y los dos traen
   * datos que hay que entregar—, y los errores llegan sin `type` ninguno.
   */
  private route(raw: string): void {
    let msg: LighterWsMessage;
    try {
      msg = JSON.parse(raw) as LighterWsMessage;
    } catch {
      return; // mensaje malformado: se ignora en vez de tumbar el stream entero
    }

    // `{"error":{code,message}}`, sin `type`. Se anuncia por salud y no se
    // lanza: un canal mal pedido no puede tumbar los demás.
    if (msg.error) {
      this.health$.next({
        stream: 'ticker',
        status: 'DOWN',
        detail: msg.error.message ?? `Error ${msg.error.code}`,
      });
      return;
    }
    if (msg.type === 'pong' || msg.type === 'connected' || msg.type === 'unsubscribed') return;

    const handler = msg.channel ? this.routes.get(msg.channel) : undefined;
    if (handler) handler(msg);
  }

  /**
   * Declara interés en un canal y devuelve cómo soltarlo.
   *
   * El canal se resuelve de forma ASÍNCRONA porque casi todos llevan dentro el
   * `market_id`, que sale del catálogo. Entre que se pide y se resuelve, el
   * interesado puede haberse ido: por eso se comprueba `stopped` antes de
   * registrar la ruta, o quedaría una suscripción viva que nadie lee.
   */
  private subscribe(
    resolve: () => Promise<string>,
    onMessage: (msg: LighterWsMessage) => void,
  ): { stop: () => void } {
    // Por el efecto, no por el valor: hace falta que el socket exista para que
    // `onOpen` encuentre este canal en `channels` cuando conecte.
    this.ensureSocket();
    let stopped = false;
    let channel: string | null = null;
    let reintento: NodeJS.Timeout | null = null;

    /**
     * Resuelve el canal y se suscribe, REINTENTANDO si no se puede.
     *
     * El reintento no sobra. Resolver el canal necesita el `market_id`, y eso
     * puede fallar —el catálogo cortado por el cortafuegos, la tabla del stream
     * todavía sin llegar—. Sin reintento, ese fallo dejaba el flujo vivo y mudo
     * para siempre: nadie recibe un error, porque el canal de datos nunca
     * lanza, y nadie recibe un dato. Es la peor forma de fallar de todas, y es
     * justo la que este adaptador venía a quitar.
     */
    const intentar = (espera = 1000): void => {
      void resolve()
        .then((name) => {
          if (stopped || this.closed) return;
          channel = name;
          // La clave del mapa lleva DOS PUNTOS: es como vuelve el canal en la
          // respuesta, aunque se pida con barras.
          this.routes.set(name.replace(/\//g, ':'), onMessage);
          this.channels.add(name);
          // Solo si ya está abierto. Si todavía conecta, `onOpen` pedirá TODOS
          // los canales de `channels` —este incluido— y mandar aquí solo
          // serviría para lanzar «readyState 0 (CONNECTING)» y anunciar una
          // avería que no existe.
          this.send({ type: 'subscribe', channel: name });
        })
        .catch((e) => {
          if (stopped || this.closed) return;
          this.health$.next({ stream: 'ticker', status: 'DOWN', detail: messageOf(e) });
          const siguiente = Math.min(espera * 2, SUBSCRIBE_RETRY_MAX_MS);
          reintento = setTimeout(() => {
            reintento = null;
            intentar(siguiente);
          }, espera);
        });
    };
    intentar();

    return {
      stop: () => {
        stopped = true;
        if (reintento) clearTimeout(reintento);
        reintento = null;
        if (!channel) return;
        this.routes.delete(channel.replace(/\//g, ':'));
        this.channels.delete(channel);
        // La baja se manda si el socket está abierto; si no, basta con haberlo
        // sacado de `channels` para que la próxima reconexión no lo repita.
        this.send({ type: 'unsubscribe', channel });
      },
    };
  }

  /** Manda por el socket solo si está abierto. Ver `subscribe`. */
  private send(payload: unknown): void {
    const socket = this.socket?.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Un envío fallido no se propaga: el `close` que venga detrás dispara la
      // reconexión, y esta vuelve a pedir los canales de `channels`.
    }
  }

  /**
   * Mantiene al día la tabla de estadísticas de TODOS los mercados.
   *
   * Es una sola suscripción —`market_stats/all`— para los 900+ pares, y es la
   * pieza que sustituye al sondeo: alimenta a la vez `getTickers()` y la parte
   * de `streamTicker` que un libro de órdenes no trae (último negociado, precio
   * de marca y la sesión de 24 h).
   *
   * Se FUSIONA, no se reemplaza. Las actualizaciones traen solo los mercados
   * que han cambiado —se ha medido: 67 en el primer mensaje y 1 en el
   * siguiente—, así que asignar la tabla entera dejaría un mercado por ciclo y
   * borraría los demás.
   */
  private ensureMarketStats(): void {
    if (this.statsSub) return;
    this.statsReady = new Promise<void>((resolve) => {
      this.statsArrived = resolve;
    });
    this.statsSub = this.subscribe(
      () => Promise.resolve('market_stats/all'),
      (msg) => {
        if (!msg.market_stats) return;
        for (const [key, value] of Object.entries(msg.market_stats)) {
          const id = value.market_id ?? Number(key);
          if (!Number.isFinite(id)) continue;
          this.stats.set(id, { ...this.stats.get(id), ...value });
          if (value.symbol) this.statsBySymbol.set(value.symbol, id);
        }
        this.statsAt = Date.now();
        this.statsArrived?.();
        this.statsArrived = null;
      },
    );
  }

  /**
   * `market_id` de un símbolo PARA EL STREAM, sin pasar por el REST.
   *
   * Es la diferencia entre que el WebSocket funcione o no cuando el venue nos
   * tiene bloqueados. La primera versión resolvía el id con `marketIdOf`, que
   * va a `orderBookDetails` — exactamente el endpoint que el firewall estaba
   * cortando—, así que el socket conectaba y no llegaba a suscribirse a nada.
   * Se vio en la primera prueba contra el venue real y no antes: con el cupo
   * intacto los dos caminos funcionan igual.
   *
   * `market_stats/all` ya trae `symbol` y `market_id` de todos los mercados, o
   * sea que el stream se basta solo. El REST queda de último recurso, para un
   * símbolo que la tabla no conozca.
   */
  private async streamMarketId(symbol: string): Promise<number> {
    this.ensureMarketStats();
    const known = this.statsBySymbol.get(symbol);
    if (known !== undefined) return known;

    // Con tope: si la tabla no llega, hay que poder caer al REST en vez de
    // esperar para siempre por un socket que quizá no vuelva.
    //
    // El temporizador se CANCELA al ganar la otra promesa. Con un `sleep` suelto
    // dentro de un `race` el timer sobrevive a la carrera: no cambia el
    // resultado, pero mantiene vivo el bucle de eventos y un proceso que ya ha
    // cerrado sus adaptadores tarda en morirse sin que nada lo explique. Lo
    // caza `--detectOpenHandles`, y lo cazó.
    await esperaAcotada(this.statsReady, STATS_WAIT_MS);
    const arrived = this.statsBySymbol.get(symbol);
    if (arrived !== undefined) return arrived;
    return this.marketIdOf(symbol);
  }

  /** ¿Sirve ya la tabla del stream, o hay que ir por REST? */
  private statsFresh(): boolean {
    return this.stats.size > 0 && Date.now() - this.statsAt < STATS_STALE_MS;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.statsSub?.stop();
    this.statsSub = null;
    // `stop()` cancela el temporizador de reconexión antes de cerrar el socket:
    // si no, uno a punto de saltar reabriría justo después de haber cerrado.
    this.socket?.stop();
    this.socket = null;
    this.channels.clear();
    this.routes.clear();
    this.orders$.complete();
    this.fills$.complete();
    // Antes de completar `health$`: los flujos compartidos terminan por aquí y
    // el aviso tiene que poder salir con el canal de salud todavía vivo.
    this.closed$.next();
    this.closed$.complete();
    this.health$.complete();
    this.tickers.clear();
    this.candleStreams.clear();
    // `signingClient` y no el getter: si nunca se firmó, no hay nada que
    // cerrar y crearlo aquí sería justo lo contrario de lo que se busca.
    await this.signingClient?.close().catch(() => undefined);
  }

  // ═══════════════════════════════════════════════════════════════
  // Interno
  // ═══════════════════════════════════════════════════════════════

  private async marketIdOf(symbol: string): Promise<number> {
    // La tabla del stream primero. Trae `symbol` y `market_id` de los 900+
    // mercados sin gastar una petición, y sobre todo SIN depender de
    // `orderBookDetails` — que es justo el endpoint que el cortafuegos corta.
    // Mientras esto no estuvo, un cupo agotado dejaba sin velas a un adaptador
    // cuyo WebSocket funcionaba perfectamente.
    const live = this.statsFresh() ? this.statsBySymbol.get(symbol) : undefined;
    if (live !== undefined) return live;

    if (!this.marketIndex.has(symbol)) await this.markets.all();
    const id = this.marketIndex.get(symbol);
    if (id === undefined) {
      throw new ExchangeError('RULES', 'Mercado desconocido en Lighter: ' + symbol, this.venue);
    }
    return id;
  }

  private toVenueOrder(o: LighterOrder, symbol: string): VenueOrder {
    const filled = D(o.initial_base_amount).minus(o.remaining_base_amount);
    return {
      venue: Venue.LIGHTER,
      symbol,
      clientOrderId: String(o.client_order_index),
      venueOrderId: String(o.order_index),
      side: o.is_ask ? 'SELL' : 'BUY',
      type: o.type === 'market' ? 'MARKET' : 'LIMIT',
      price: D(o.price).toFixed(),
      qty: D(o.initial_base_amount).toFixed(),
      filledQty: filled.toFixed(),
      avgPrice:
        filled.gt(0) && !D(o.filled_quote_amount).isZero()
          ? D(o.filled_quote_amount).div(filled).toFixed()
          : null,
      status: filled.isZero() ? OrderStatus.OPEN : OrderStatus.PARTIALLY_FILLED,
      reduceOnly: o.reduce_only === true,
      createdAt: Date.now(),
    };
  }
}

/**
 * Cambio ABSOLUTO de 24 h a partir del porcentaje que publica el venue.
 *
 * `precio_previo = último / (1 + pct/100)`, y de ahí la diferencia. Se devuelve
 * null cuando el porcentaje no viene o cuando implicaría un precio previo de
 * cero o negativo — que no es un cambio del -100 %, es un dato roto.
 *
 * El precio previo se REDONDEA a los decimales del último antes de restar. Sin
 * eso una división exacta arrastra la precisión entera de Decimal y BTC salía
 * con «325.71094294759963641510818296582226843» — treinta y tantos decimales de
 * ruido en una cifra que el venue publica con uno. El camino por REST no lo
 * necesita porque allí los dos precios vienen ya con la precisión del venue.
 */
export function absoluteChange(last: string, pct: number | undefined): string | null {
  if (pct === undefined || !Number.isFinite(pct)) return null;
  const factor = D(pct).div(100).plus(1);
  if (factor.lte(0)) return null;
  const dot = last.indexOf('.');
  const decimals = dot < 0 ? 0 : last.length - dot - 1;
  const previous = D(last).div(factor).toDecimalPlaces(decimals);
  return D(last).minus(previous).toFixed();
}

/** Convierte un decimal al entero escalado que espera el protocolo. */
export function scaled(value: string, decimals: number): number {
  return D(value).mul(D(10).pow(decimals)).toDecimalPlaces(0, Decimal.ROUND_DOWN).toNumber();
}

/** Decimales del USDC. Los mismos con los que Lighter publica `min_quote_amount`. */
const USDC_DECIMALS = 6;

/**
 * Comision de una ejecucion, de unidades escaladas a USDC.
 *
 * La conversion INVERSA de `scaled()`, y hace falta por un motivo que costo
 * caro: en el tipo `Trade` del SDK, `size`, `price` y `usd_amount` viajan como
 * CADENAS decimales, pero `maker_fee` y `taker_fee` son `number` —enteros en
 * unidades escaladas—. Tomarlos en crudo multiplicaba cada comision por un
 * millon: una ejecucion de 0,79 $ quedaba registrada con 50 $ de comision, y la
 * tarjeta del bot decia «PnL −50,00 · ROI −10 %».
 *
 * No es cosmetico. De ese PnL salen la PERDIDA DIARIA que bloquea arrancar bots
 * y el KILL-SWITCH por drawdown que los pausa: con las comisiones infladas, los
 * dos frenos saltan solos.
 *
 * Que son importes y no tasas se comprobo contra la API: el mismo `taker_fee`
 * —196— aparece en operaciones de 22 $ y de 2.596 $, asi que no es proporcional
 * al tamano; y las comisiones de mercado de BTC, ETH y SOL son «0.0000», asi que
 * tampoco puede ser un porcentaje aplicado al notional. Son una cuota fija por
 * ejecucion, como corresponde a un rollup.
 */
export function feeToUsdc(raw: number | string | null | undefined): string {
  const n = firstNum(raw, 0);
  if (!n.isFinite()) return '0';
  return n.div(D(10).pow(USDC_DECIMALS)).toFixed();
}

/**
 * Las fracciones de margen de Lighter van en diezmilésimas (10000 = 100 %), así
 * que el apalancamiento máximo es 10000 / fracción_inicial_mínima. Se acota a
 * [1, 100] para que un valor inesperado del venue no acabe permitiendo una
 * configuración absurda en el formulario.
 */
function maxLeverageOf(detail: PerpsOrderBookDetail): number {
  const fraction = Number(detail.min_initial_margin_fraction);
  if (!Number.isFinite(fraction) || fraction <= 0) return 20;
  return Math.max(1, Math.min(100, Math.floor(10_000 / fraction)));
}

function leverageFromMarginFraction(fraction: string | number | undefined): number {
  const value = Number(fraction);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.round(10_000 / value));
}
