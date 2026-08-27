import { Observable, Subject } from 'rxjs';
import { Wallet } from 'ethers';
import {
  D,
  ExchangeError,
  firstNum,
  OrderStatus,
  Venue,
  type Balance,
  type CancelRequest,
  type Fill,
  type MarginAction,
  type MarginMode,
  type MarketSpec,
  type ModifyRequest,
  type OrderAck,
  type OrderSide,
  type OrderStatus as OrderStatusT,
  type OrderType,
  type OrderUpdate,
  type PlaceOrderRequest,
  type Position,
  type PositionMode,
  type PositionSide,
  type Ticker,
  type VenueOrder,
  type Candle,
  type CandleInterval,
  type MarketTicker,
  type VenueCapabilities,
} from '@crypton/shared';
import { checkInterval, finishCandles, num, numOrNull, resolveRange } from '../candles';
import { ASTER_INTERVALS, VENUE_CAPABILITIES } from '../capabilities';
import { asterCodec } from '../coid';
import { endpointsFor } from '../endpoints';
import { isRetryable, messageOf, toExchangeError } from '../errors';
import { MarketSpecCache, canonicalSymbol, decimalsOf } from '../market-cache';
import { RateLimiter, withRetry, withWriteRetry } from '../rate-limit';
import { NO_BUDGET, type VenueBudget } from '../venue-budget';
import { asterWeight } from '../venue-weights';
import { VenueCooldown } from '../cooldown';
import { ReconnectingSocket, sharedStream } from '../ws';
import type {
  AdapterOptions,
  CandleQuery,
  ExchangeAdapter,
  StreamHealth,
  VenueCredentials,
} from '../types';

type AsterCreds = Extract<VenueCredentials, { venue: 'ASTER' }>;

/**
 * Las URLs de las dos redes viven en `VENUE_ENDPOINTS` (`../endpoints`).
 *
 * `fapi`, no `fapi3`: ese host responde **403 a todo**, también a los endpoints
 * públicos, así que ninguna llamada a Aster llegaba a funcionar. No lo detecta
 * ni compilar ni la batería de tests —que no sale a la red—; apareció al leer
 * mercados de verdad contra los tres venues.
 */

/**
 * Dominio EIP-712 de Aster. Los cuatro valores son fijos y forman parte del
 * protocolo: cambiarlos invalida todas las firmas.
 * @see V3(Recommended)/EN/aster-finance-futures-api-v3.md en asterdex/api-docs
 */
const EIP712_DOMAIN = {
  name: 'AsterSignTransaction',
  version: '1',
  chainId: 1666,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

const EIP712_TYPES: Record<string, { name: string; type: string }[]> = {
  Message: [{ name: 'msg', type: 'string' }],
};

/**
 * Aster no publica el apalancamiento máximo en `exchangeInfo` (va en
 * `leverageBracket`, que exige firma). Se usa un tope conservador para poder
 * validar configuraciones sin credenciales; el venue rechazará cualquier valor
 * real que se pase de su bracket, y ese rechazo se traduce a un error de reglas.
 */
const ASSUMED_MAX_LEVERAGE = 50;

export class AsterAdapter implements ExchangeAdapter {
  readonly venue = Venue.ASTER;

  readonly capabilities: VenueCapabilities = VENUE_CAPABILITIES[Venue.ASTER];

  /**
   * Prefijo bajo el que responde `klines`, resuelto en la primera llamada.
   *
   * Todo lo demás en este adaptador va por `/fapi/v3`, pero los endpoints de
   * datos de mercado de Binance viven históricamente en `v1` y cada despliegue
   * compatible elige cuáles porta. Adivinar significa que la función falla
   * entera contra la mitad de los despliegues, así que se prueba v3 una vez y
   * se recuerda el que conteste. Es UNA petición de más, y solo si v3 falla.
   */
  private klinesPath: '/fapi/v3/klines' | '/fapi/v1/klines' | null = null;

  private readonly rest: string;
  /**
   * Base del WebSocket. Es un CAMPO, no la constante de módulo que se usaba
   * suelta en los tres sitios que abren socket: con la constante, un adaptador
   * de testnet pedía sus órdenes al host de testnet y leía el libro del de
   * mainnet, sin un solo error que lo delatara.
   */
  private readonly ws: string;
  /** Firmante EIP-712. Se crea al primer uso; ver el getter `wallet`. */
  private signingWallet?: Wallet;
  private readonly limiter: RateLimiter;
  private readonly budget: VenueBudget;
  /**
   * Red del venue. Se guarda porque el presupuesto de caudal lleva depósitos
   * separados por red: mainnet y testnet son hosts distintos y cada uno tiene
   * su propio contador en el venue.
   */
  private readonly testnet: boolean;
  private readonly markets: MarketSpecCache;
  /**
   * Enfriamiento tras un corte. En Aster es lo que separa un 429 de un 418:
   * «Repeatedly violating rate limits and/or failing to back off after
   * receiving 429s will result in an automated IP ban», con veto que escala
   * «from 2 minutes to 3 days».
   */
  private readonly cooldown = new VenueCooldown(Venue.ASTER);

  private readonly orders$ = new Subject<OrderUpdate>();
  private readonly fills$ = new Subject<Fill>();
  /**
   * El flujo COMPARTIDO por simbolo, no un `Subject` cacheado para siempre.
   *
   * Guardaba un `Subject` que solo se completaba en `close()`, y con el un
   * WebSocket por simbolo que tampoco se cerraba nunca: visitar cien pares
   * dejaba cien sockets abiertos hasta reiniciar el proceso. Ahora es un
   * Observable con contador de referencias — el primero que se suscribe abre,
   * el ultimo que se va cierra— y el flujo se guarda solo para que dos
   * interesados compartan uno.
   */
  private readonly tickers = new Map<string, Observable<Ticker>>();
  /** Clave `symbol|interval`: un socket por par y resolución, no por bot. */
  private readonly candles = new Map<string, Observable<Candle>>();
  /**
   * Los fallos de socket salen POR AQUÍ y nunca por `error()` sobre los Subject
   * de datos: un Subject con error queda cerrado para siempre, y con él moría
   * toda posibilidad de que la reconexión volviera a entregar fills.
   */
  private readonly health$ = new Subject<StreamHealth>();
  /**
   * Los sockets vivos. Cada uno se reengancha solo; aquí se guardan solo para
   * poder pararlos todos en `close()`.
   */
  private sockets: ReconnectingSocket[] = [];
  private keepAlive: NodeJS.Timeout | null = null;
  private closed = false;
  /**
   * Se dispara en `close()` y completa todos los flujos compartidos.
   *
   * Antes lo hacia un bucle sobre los `Subject` guardados. Con flujos
   * compartidos no hay `Subject` que completar, pero el aviso sigue haciendo
   * falta: quien este suscrito tiene que enterarse de que este adaptador ya no
   * va a entregar nada mas.
   */
  private readonly closed$ = new Subject<void>();

  /** Contador monótono: dos órdenes en el mismo microsegundo romperían el nonce. */
  private lastNonceSecond = 0;
  private nonceCounter = 0;

  constructor(
    private readonly creds: AsterCreds,
    opts: AdapterOptions = {},
  ) {
    // La red la manda `opts.testnet`; `creds.baseUrl` gana por encima solo por
    // los sobres sellados antes de que existiera la tabla de endpoints.
    this.testnet = opts.testnet === true;
    const endpoints = endpointsFor(Venue.ASTER, this.testnet);
    this.rest = creds.baseUrl ?? endpoints.rest;
    this.ws = opts.wsUrl ?? endpoints.ws;
    this.limiter = new RateLimiter(opts.rateLimitPerSecond ?? 8);
    this.budget = opts.budget ?? NO_BUDGET;
    this.markets = new MarketSpecCache(() => this.loadMarkets());
  }

  /**
   * Firmante, creado la primera vez que hace falta. Las rutas públicas de Aster
   * (`publicRequest`) no pasan por aquí, así que un adaptador público nunca
   * toca la clave.
   */
  private get wallet(): Wallet {
    if (!this.signingWallet) {
      if (!this.creds.signerPrivateKey) {
        throw new Error('Adaptador de Aster sin credenciales: no puede firmar.');
      }
      this.signingWallet = new Wallet(this.creds.signerPrivateKey);
    }
    return this.signingWallet;
  }

  // ═══════════════════════════════════════════════════════════════
  // Firma
  // ═══════════════════════════════════════════════════════════════

  /**
   * Nonce en microsegundos, estrictamente creciente.
   *
   * Aster mantiene los últimos 100 nonces POR DIRECCIÓN DE AGENTE y rechaza
   * repetidos. Como el motor puede mandar varias órdenes en el mismo
   * milisegundo, no basta con `Date.now() * 1000`: se lleva un contador dentro
   * del segundo, igual que hace el ejemplo oficial.
   */
  private nextNonce(): string {
    const second = Math.floor(Date.now() / 1000);
    if (second === this.lastNonceSecond) {
      this.nonceCounter += 1;
    } else {
      this.lastNonceSecond = second;
      this.nonceCounter = 0;
    }
    return String(second * 1_000_000 + this.nonceCounter);
  }

  /**
   * Firma EIP-712 sobre la cadena URL-encoded de los parámetros.
   *
   * El ORDEN importa y no es alfabético: se firma exactamente la misma cadena
   * que se envía, con `nonce`, `user` y `signer` añadidos al final en ese
   * orden. Reordenar los campos invalida la firma sin ningún mensaje útil por
   * parte del venue, así que aquí se construye una sola vez y se reutiliza
   * tanto para firmar como para mandar.
   */
  private async signedQuery(params: Record<string, string | number | boolean>): Promise<string> {
    const ordered = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      ordered.append(k, String(v));
    }
    ordered.append('nonce', this.nextNonce());
    ordered.append('user', this.creds.userAddress);
    ordered.append('signer', this.creds.signerAddress);

    const msg = ordered.toString();
    const signature = await this.wallet.signTypedData(EIP712_DOMAIN, EIP712_TYPES, { msg });
    return msg + '&signature=' + signature;
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    const query = await this.signedQuery(params);
    return this.call<T>(() => this.http<T>(method, path + '?' + query), asterWeight(path, params));
  }

  /**
   * Igual que `signedRequest` pero SIN reintento automático. Para escrituras:
   * el reintento lo gobierna `withWriteRetry`, que antes comprueba si la orden
   * llegó a entrar.
   */
  private async signedRequestOnce<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    const query = await this.signedQuery(params);
    // Reserva de escritura: una avalancha de lecturas no puede dejar sin caudal
    // a la cancelación de un pánico.
    this.cooldown.comprobar();
    await this.budget.take(this.venue, 1, 'write', this.testnet);
    return this.limiter.run(() => this.http<T>(method, path + '?' + query)).catch((e) => {
      this.cooldown.registrar(e);
      throw e;
    });
  }

  private async publicRequest<T>(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) search.append(k, String(v));
    const qs = search.toString();
    return this.call<T>(
      () => this.http<T>('GET', qs ? path + '?' + qs : path),
      asterWeight(path, params),
    );
  }

  private async http<T>(method: string, pathWithQuery: string): Promise<T> {
    const res = await fetch(this.rest + pathWithQuery, {
      method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'crypton/0.1',
      },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    // El ESTADO viaja hasta la clasificación. Sin él, el 429 de Aster llegaba
    // como un texto —«Too many requests…»— que casaba con el patrón RETRYABLE,
    // así que `withRetry` lo reintentaba cuatro veces. Es exactamente lo que su
    // documentación prohíbe: «When a 429 is received, it's your obligation as an
    // API to back off and not spam the API», y lo que convierte un 429 en un
    // **418** con veto de IP «from 2 minutes to 3 days».
    if (!res.ok) throw toExchangeError(body ?? res.statusText, this.venue, res.status);
    // Aster devuelve 200 con {code, msg} en algunos rechazos de negocio: sin
    // esta comprobación, una orden rechazada pasaría por buena.
    const maybe = body as { code?: number; msg?: string };
    if (maybe && typeof maybe.code === 'number' && maybe.code < 0) {
      throw toExchangeError(maybe.msg ?? 'Error ' + maybe.code, this.venue);
    }
    return body as T;
  }

  /**
   * Lecturas. Pasan por dos puertas: `limiter` acota lo que manda esta cuenta,
   * `budget` lo que manda todo lo que sale por esta IP — que es el ámbito en el
   * que el venue cuenta de verdad.
   *
   * El `weight` es OBLIGATORIO y lo calcula `asterWeight` a partir de la ruta.
   * Tenía un valor por defecto de 2 y ese defecto se aplicaba a todo: también a
   * `ticker/24hr` sin símbolo, que pesa **40** y lo pide un cron cada 30 s.
   */
  private call<T>(fn: () => Promise<T>, weight: number): Promise<T> {
    return withRetry(
      async () => {
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

  // ═══════════════════════════════════════════════════════════════
  // Metadatos y estado
  // ═══════════════════════════════════════════════════════════════

  private async loadMarkets(): Promise<MarketSpec[]> {
    const info = await this.publicRequest<AsterExchangeInfo>('/fapi/v3/exchangeInfo');
    return info.symbols
      .filter((s) => s.contractType === 'PERPETUAL')
      .map((s) => {
        const price = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
        const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
        const notional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
        const tickSize = price?.tickSize ?? '0.01';
        const stepSize = lot?.stepSize ?? '0.001';
        return {
          venue: Venue.ASTER,
          symbol: s.symbol,
          canonical: canonicalSymbol(s.baseAsset, s.quoteAsset),
          base: s.baseAsset,
          quote: s.quoteAsset,
          tickSize,
          stepSize,
          minNotional: notional?.notional ?? null,
          minQty: lot?.minQty ?? null,
          maxQty: lot?.maxQty ?? null,
          maxLeverage: ASSUMED_MAX_LEVERAGE,
          // Se derivan del filtro y NO de pricePrecision/quantityPrecision: la
          // propia documentación avisa de que esos campos no son el tick ni el
          // step, y usarlos produce órdenes rechazadas.
          priceDecimals: decimalsOf(tickSize),
          qtyDecimals: decimalsOf(stepSize),
          active: s.status === 'TRADING',
        } satisfies MarketSpec;
      });
  }

  async verify(): Promise<{ ok: boolean; publicRef: string; detail?: string }> {
    try {
      await this.signedRequest<AsterBalance[]>('GET', '/fapi/v3/balance');
      return { ok: true, publicRef: this.creds.userAddress };
    } catch (e) {
      return {
        ok: false,
        publicRef: this.creds.userAddress,
        detail: toExchangeError(e, this.venue).message,
      };
    }
  }

  getMarkets(): Promise<MarketSpec[]> {
    return this.markets.all();
  }

  async getBalances(): Promise<Balance[]> {
    const balances = await this.signedRequest<AsterBalance[]>('GET', '/fapi/v3/balance');
    return balances
      .filter((b) => !D(b.balance).isZero())
      .map((b) => ({
        asset: b.asset,
        total: D(b.balance).toFixed(),
        available: D(b.availableBalance).toFixed(),
        used: D(b.balance).minus(b.availableBalance).toFixed(),
      }));
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const positions = await this.signedRequest<AsterPosition[]>(
      'GET',
      '/fapi/v3/positionRisk',
      symbol ? { symbol } : {},
    );
    return positions
      .filter((p) => !D(p.positionAmt).isZero())
      .map((p) => ({
        venue: Venue.ASTER,
        symbol: p.symbol,
        qty: D(p.positionAmt).toFixed(),
        entryPrice: D(p.entryPrice).toFixed(),
        markPrice: D(p.markPrice).toFixed(),
        unrealizedPnl: D(p.unRealizedProfit).toFixed(),
        leverage: Number(p.leverage),
        marginMode: p.marginType?.toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSS',
        liquidationPrice:
          p.liquidationPrice && !D(p.liquidationPrice).isZero()
            ? D(p.liquidationPrice).toFixed()
            : null,
        marginUsed: firstNum(p.isolatedMargin, 0).toFixed(),
      }));
  }

  async getOpenOrders(symbol?: string): Promise<VenueOrder[]> {
    const orders = await this.signedRequest<AsterOrder[]>(
      'GET',
      '/fapi/v3/openOrders',
      symbol ? { symbol } : {},
    );
    return orders.map((o) => this.toVenueOrder(o));
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const [book, premium] = await Promise.all([
      this.publicRequest<AsterBookTicker>('/fapi/v3/ticker/bookTicker', { symbol }),
      this.publicRequest<AsterPremiumIndex>('/fapi/v3/premiumIndex', { symbol }),
    ]);
    const bid = firstNum(book.bidPrice, 0);
    const ask = firstNum(book.askPrice, 0);
    return {
      venue: Venue.ASTER,
      symbol,
      last: bid.plus(ask).div(2).toFixed(),
      bid: bid.toFixed(),
      ask: ask.toFixed(),
      mark: firstNum(premium.markPrice, bid.plus(ask).div(2)).toFixed(),
      ts: Date.now(),
    };
  }

  /**
   * Estadísticas de 24 h de TODOS los símbolos en una sola llamada.
   *
   * `ticker/24hr` sin `symbol` devuelve el mercado entero. Pedirlo por símbolo
   * costaría una petición por par: doscientas para pintar una lista.
   */
  async getTickers(): Promise<MarketTicker[]> {
    const rows = await this.publicRequest<AsterTicker24h[]>('/fapi/v3/ticker/24hr');
    const list = Array.isArray(rows) ? rows : [rows];
    return list
      .filter((r) => r && typeof r.symbol === 'string')
      .map((r) => ({
        venue: Venue.ASTER,
        symbol: r.symbol,
        last: num(r.lastPrice),
        change24h: numOrNull(r.priceChange),
        changePct24h: numOrNull(r.priceChangePercent),
        high24h: numOrNull(r.highPrice),
        low24h: numOrNull(r.lowPrice),
        // `quoteVolume` y no `volume`: el volumen en quote es el único
        // comparable entre pares, que es para lo que se ordena la lista.
        volume24h: numOrNull(r.quoteVolume),
        ts: r.closeTime ?? Date.now(),
      }));
  }

  async getCandles(
    symbol: string,
    interval: CandleInterval,
    query: CandleQuery,
  ): Promise<Candle[]> {
    const iv = checkInterval(this.venue, ASTER_INTERVALS, interval);
    const { startMs, endMs, limit } = resolveRange(
      interval,
      query,
      this.capabilities.candles.maxBars,
    );
    // SIN `startTime`, a proposito.
    //
    // Con los tres parametros, la API de Binance devuelve las primeras `limit`
    // velas DESDE `startTime` hacia adelante. Si la ventana calculada contiene
    // una vela mas de las que caben en `limit` —pasa cuando `endMs` cae justo en
    // la apertura de una vela—, la que se corta es la ULTIMA: la vela viva,
    // precisamente la que el refresco de cinco segundos viene a buscar. Con
    // solo `endTime` + `limit`, devuelve las ultimas `limit` ANTES de `endTime`,
    // que es exactamente lo que se quiere. `startTime` solo se manda cuando el
    // llamante lo ha pedido de verdad (paginacion hacia atras con rango).
    const params: Record<string, string | number> = {
      symbol,
      interval: iv,
      endTime: endMs,
      limit: Math.min(limit + 1, this.capabilities.candles.maxBars),
    };
    if (query.startMs > 0) params['startTime'] = startMs;

    let raw: AsterKline[];
    if (this.klinesPath) {
      raw = await this.publicRequest<AsterKline[]>(this.klinesPath, params);
    } else {
      try {
        raw = await this.publicRequest<AsterKline[]>('/fapi/v3/klines', params);
        this.klinesPath = '/fapi/v3/klines';
      } catch (e) {
        // Solo un rechazo DEFINITIVO —un 404, «ruta desconocida»— significa que
        // v3 no existe. Un timeout o un 503 también lanzan, y si se tratasen
        // igual, un corte de red de un segundo dejaría el adaptador clavado en
        // v1 para el resto de la vida del proceso aunque v3 fuera la buena.
        // Esos se propagan sin tocar `klinesPath` y el siguiente intento vuelve
        // a sondear.
        if (isRetryable(e)) throw e;
        raw = await this.publicRequest<AsterKline[]>('/fapi/v1/klines', params);
        this.klinesPath = '/fapi/v1/klines';
      }
    }

    return finishCandles(
      (raw ?? []).map((k) => ({
        t: Number(k[0]),
        o: num(k[1]),
        h: num(k[2]),
        l: num(k[3]),
        c: num(k[4]),
        v: numOrNull(k[5]),
      })),
      limit,
    );
  }

  /**
   * Ejecuciones posteriores a `sinceMs`. Red de seguridad del ledger cuando el
   * stream de usuario se cae o reconecta tarde.
   */
  async getRecentFills(symbol: string, sinceMs: number): Promise<Fill[]> {
    const trades = await this.signedRequest<AsterUserTrade[]>('GET', '/fapi/v3/userTrades', {
      symbol,
      startTime: String(sinceMs),
      limit: '500',
    });
    return trades.map((t) => ({
      venue: Venue.ASTER,
      symbol: t.symbol,
      // NO se marca `liquidation`: `userTrades` devuelve la ejecución, y Aster
      // —como toda la familia de perps de Binance— pone la etiqueta en la ORDEN,
      // no en el trade. Por WebSocket sí llega (`ORDER_TRADE_UPDATE` trae el
      // tipo), y ese es el camino normal; este barrido es el respaldo para
      // cuando el stream se cae, así que una liquidación que solo llegue por
      // aquí no se contabilizará. Sacarla exigiría cruzar cada `orderId` contra
      // `/fapi/v1/forceOrders`, una peticion mas por barrido.
      venueFillId: String(t.id),
      venueOrderId: String(t.orderId),
      clientOrderId: null,
      side: t.buyer ? ('BUY' as const) : ('SELL' as const),
      price: D(t.price).toFixed(),
      qty: D(t.qty).toFixed(),
      fee: firstNum(t.commission, 0).toFixed(),
      feeAsset: t.commissionAsset ?? 'USDT',
      isTaker: t.maker === false,
      ts: t.time,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // Ejecución
  // ═══════════════════════════════════════════════════════════════

  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    const params: Record<string, string> = {
      symbol: req.symbol,
      side: req.side,
      type: mapOrderType(req),
      quantity: req.qty,
      newClientOrderId: asterCodec.encode(req.clientOrderId),
    };

    if (req.type !== 'MARKET') {
      params.price = req.price ?? '';
      // POST_ONLY se expresa como GTX (good-till-crossing): el venue rechaza la
      // orden si fuera a cruzar el libro, que es exactamente el contrato de una
      // post-only y lo que mantiene al market maker del lado maker.
      params.timeInForce = req.type === 'POST_ONLY' ? 'GTX' : (req.timeInForce ?? 'GTC');
    }
    if (req.triggerPrice) {
      params.stopPrice = req.triggerPrice;
      params.workingType = 'MARK_PRICE';
    }
    if (req.reduceOnly) params.reduceOnly = 'true';

    // Sin reintento a ciegas: un timeout puede llegar con la orden ya aceptada,
    // y reenviarla dejaba la fila REJECTED con la orden viva en el libro.
    const venueCoid = asterCodec.encode(req.clientOrderId);
    return withWriteRetry(
      async () => {
        const ack = await this.signedRequestOnce<AsterOrder>('POST', '/fapi/v3/order', params);
        return {
          clientOrderId: req.clientOrderId,
          venueOrderId: String(ack.orderId),
          status: mapStatus(ack.status),
          ts: ack.updateTime ?? Date.now(),
        };
      },
      () => this.findPlaced(req.symbol, req.clientOrderId, venueCoid),
      { venue: this.venue },
    );
  }

  /**
   * ¿Llegó a entrar esta orden? Distingue «falló el envío» de «se perdió el
   * acuse».
   *
   * Se pregunta por el ESTADO de la orden, no por el libro: una MARKET que
   * entró y se ejecutó ya no está entre las abiertas, y darla por no-enviada
   * la reenviaría — posición duplicada. `GET /order` responde también para
   * órdenes ejecutadas o canceladas.
   */
  private async findPlaced(
    symbol: string,
    clientOrderId: string,
    venueCoid: string,
  ): Promise<OrderAck | null> {
    try {
      const found = await this.signedRequest<AsterOrder>('GET', '/fapi/v3/order', {
        symbol,
        origClientOrderId: venueCoid,
      });
      const status = mapStatus(found.status);
      if (status === 'REJECTED') return null;
      return {
        clientOrderId,
        venueOrderId: String(found.orderId),
        status,
        ts: Date.now(),
      };
    } catch (e) {
      if (/does not exist|not found|unknown order/i.test(messageOf(e))) return null;
      throw e;
    }
  }

  async cancelOrder(req: CancelRequest): Promise<void> {
    const params: Record<string, string> = { symbol: req.symbol };
    if (req.clientOrderId) {
      params.origClientOrderId = asterCodec.encode(req.clientOrderId);
    } else if (req.venueOrderId) {
      params.orderId = req.venueOrderId;
    } else {
      throw new ExchangeError('FATAL', 'Cancelar exige clientOrderId o venueOrderId', this.venue);
    }
    await this.signedRequest('DELETE', '/fapi/v3/order', params);
  }

  /**
   * Cancela SOLO los ids dados, uno a uno.
   *
   * Aster tiene borrado en lote (`origClientOrderIdList`), pero falla entero si
   * un id ya no existe — cosa que pasa continuamente, porque entre leer el
   * libro y cancelar puede ejecutarse cualquiera. Una a una, la que ya no está
   * es un no-op y las demás se cancelan igual.
   */
  async cancelOwn(symbol: string, clientOrderIds: string[]): Promise<void> {
    for (const coid of clientOrderIds) {
      try {
        await this.signedRequest('DELETE', '/fapi/v3/order', {
          symbol,
          origClientOrderId: asterCodec.encode(coid),
        });
      } catch (e) {
        if (!/unknown order|does not exist|not found/i.test(messageOf(e))) throw e;
      }
    }
  }

  /**
   * Alcance de CUENTA para el símbolo: se lleva por delante las órdenes de
   * otros bots y las que el usuario haya puesto a mano. Solo el kill-switch
   * global debe llamar aquí; para limpiar un bot está `cancelOwn`.
   */
  async cancelAll(symbol: string): Promise<void> {
    await this.signedRequest('DELETE', '/fapi/v3/allOpenOrders', { symbol });
  }

  // `modifyOrder` se deja SIN implementar a propósito: Aster solo permite
  // modificar en lote (PUT /fapi/v3/batchOrders) y con restricciones. Al ser
  // opcional en la interfaz, el motor cae solo en cancelar + recolocar, que
  // para una reconciliación por clientOrderId da el mismo resultado con menos
  // superficie de fallo.

  async setLeverage(symbol: string, leverage: number, mode: MarginMode): Promise<void> {
    // El orden importa: cambiar el modo de margen con posición abierta falla,
    // así que se intenta primero y se ignora el rechazo "sin cambios".
    try {
      await this.signedRequest('POST', '/fapi/v3/marginType', {
        symbol,
        marginType: mode === 'CROSS' ? 'CROSSED' : 'ISOLATED',
      });
    } catch (e) {
      const msg = toExchangeError(e, this.venue).message;
      if (!/no need to change|not change/i.test(msg)) throw e;
    }
    await this.signedRequest('POST', '/fapi/v3/leverage', { symbol, leverage });
  }

  /**
   * Aporta (`type: 1`) o retira (`type: 2`) colateral de una posición aislada.
   *
   * `signedRequestOnce` y NO `signedRequest`, al contrario que sus vecinos de
   * esta sección: `signedRequest` pasa por `call`, que reintenta lo RETRYABLE,
   * y esto NO es idempotente. Fijar el apalancamiento dos veces lo deja donde
   * ya estaba; aportar margen dos veces aporta el doble. Un timeout que llegó a
   * aplicarse y se reintenta duplica el aporte en silencio, así que aquí un
   * fallo se propaga y lo decide quien lo pidió.
   *
   * Por el mismo motivo NO se sondea `/fapi/v1` cuando `/fapi/v3` falla, aunque
   * `klines` sí lo haga: allí el sondeo cuesta una lectura de más, y aquí una
   * segunda escritura contra una ruta que quizá sí existía. Todo lo firmado de
   * este adaptador va por v3; si algún despliegue sirviera esta ruta solo en
   * v1, el arreglo es esta línea y el error del venue lo dirá sin ambigüedad.
   *
   * `positionSide` NO se envía, igual que en `placeOrder`: este adaptador opera
   * de principio a fin asumiendo modo unidireccional, donde el venue toma
   * `BOTH` por defecto. Mandarlo solo aquí sería el único punto del adaptador
   * que habla el dialecto de cobertura, y quedaría incoherente con las órdenes
   * que abrieron la posición que se está financiando.
   */
  async adjustIsolatedMargin(
    symbol: string,
    amountUsd: string,
    action: MarginAction,
    _side: PositionSide,
  ): Promise<void> {
    const amount = D(amountUsd).abs();
    if (amount.lte(0)) {
      throw new ExchangeError(
        'RULES',
        'El importe del ajuste de margen debe ser mayor que cero.',
        this.venue,
      );
    }
    await this.signedRequestOnce('POST', '/fapi/v3/positionMargin', {
      symbol,
      amount: amount.toFixed(),
      type: action === 'REMOVE' ? 2 : 1,
    });
  }

  async setPositionMode(mode: PositionMode): Promise<void> {
    try {
      await this.signedRequest('POST', '/fapi/v3/positionSide/dual', {
        dualSidePosition: mode === 'HEDGE' ? 'true' : 'false',
      });
    } catch (e) {
      const msg = toExchangeError(e, this.venue).message;
      if (!/no need to change|not change/i.test(msg)) throw e;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Tiempo real
  // ═══════════════════════════════════════════════════════════════

  streamOrders(): Observable<OrderUpdate> {
    void this.ensureUserStream();
    return this.orders$.asObservable();
  }

  streamFills(): Observable<Fill> {
    void this.ensureUserStream();
    return this.fills$.asObservable();
  }

  streamHealth(): Observable<StreamHealth> {
    return this.health$.asObservable();
  }

  streamTicker(symbol: string): Observable<Ticker> {
    let stream = this.tickers.get(symbol);
    if (stream) return stream;

    stream = this.sharedSocket<Ticker>((emit) =>
      this.openSocket(
        () => this.ws + '/ws/' + symbol.toLowerCase() + '@bookTicker',
        (raw) => {
          try {
            const ev = JSON.parse(raw) as { b?: string; a?: string; E?: number };
            const bid = firstNum(ev.b, 0);
            const ask = firstNum(ev.a, 0);
            emit({
              venue: Venue.ASTER,
              symbol,
              last: bid.plus(ask).div(2).toFixed(),
              bid: bid.toFixed(),
              ask: ask.toFixed(),
              mark: bid.plus(ask).div(2).toFixed(),
              ts: ev.E ?? Date.now(),
            });
          } catch {
            /* mensaje malformado: se ignora en vez de tumbar el stream entero */
          }
        },
        { stream: 'ticker', symbol },
      ),
    );
    this.tickers.set(symbol, stream);
    return stream;
  }

  /**
   * Vela en formación por WebSocket (`<symbol>@kline_<interval>`).
   *
   * Reutiliza `openSocket`, así que hereda la reconexión: sin ella, un cierre
   * limpio del servidor dejaba el gráfico congelado sin un solo evento.
   */
  streamCandles(symbol: string, interval: CandleInterval): Observable<Candle> {
    const iv = checkInterval(this.venue, ASTER_INTERVALS, interval);
    const key = symbol + '|' + interval;
    const existing = this.candles.get(key);
    if (existing) return existing;

    const stream = this.sharedSocket<Candle>((emit) =>
      this.openSocket(
        () => this.ws + '/ws/' + symbol.toLowerCase() + '@kline_' + iv,
        (raw) => {
          try {
            const ev = JSON.parse(raw) as { k?: AsterKlineEvent };
            const k = ev.k;
            if (!k) return;
            emit({
              t: Number(k.t),
              o: num(k.o),
              h: num(k.h),
              l: num(k.l),
              c: num(k.c),
              v: numOrNull(k.v),
            });
          } catch {
            /* mensaje malformado: se ignora en vez de tumbar el stream entero */
          }
        },
        { stream: 'candles', symbol },
      ),
    );
    this.candles.set(key, stream);
    return stream;
  }

  /**
   * Envuelve un socket en un flujo con contador de referencias: el primero que
   * se suscribe lo abre, el último que se va lo cierra de verdad. La mecánica
   * está en `sharedStream` (`../ws`); aquí solo se le pasa el aviso de cierre
   * del adaptador.
   */
  private sharedSocket<T>(
    open: (emit: (value: T) => void) => { stop: () => void },
  ): Observable<T> {
    return sharedStream<T>(open, this.closed$);
  }

  /**
   * Abre un socket de este adaptador y lo apunta para poder pararlo en
   * `close()`.
   *
   * La reconexión, el backoff con jitter y el reinicio del backoff tras una
   * conexión estable viven ahora en `ReconnectingSocket` (`../ws`), que Lighter
   * comparte. Aquí solo queda lo que es de Aster: qué stream de salud se
   * anuncia y de qué símbolo.
   */
  private openSocket(
    url: () => string | Promise<string>,
    onMessage: (raw: string) => void,
    what: { stream: StreamHealth['stream']; symbol?: string },
  ): { stop: () => void } {
    const socket = new ReconnectingSocket({
      url,
      onMessage,
      onHealth: ({ status, detail }) => this.health$.next({ ...what, status, detail }),
    });
    this.sockets.push(socket);
    // El asa SACA el socket de la lista al pararlo.
    //
    // Sin esto la lista solo crecía: cada par que alguien mira abre un socket y
    // el contador de referencias lo para al soltarlo, pero el objeto se quedaba
    // dentro para siempre. Visitar cien pares a lo largo del día dejaba cien
    // entradas muertas. La versión anterior lo hacía en el manejador de `close`
    // del propio `ws`; al mover la reconexión fuera, esa limpieza se quedó sin
    // hacer y hay que rehacerla aquí.
    return {
      stop: () => {
        socket.stop();
        this.sockets = this.sockets.filter((s) => s !== socket);
      },
    };
  }

  private userStreamStarted = false;

  /**
   * El stream de usuario de Aster va por `listenKey`, que caduca a los 60
   * minutos. Se renueva cada 30 para no depender de la precisión del reloj ni
   * de que el ping llegue: perder el listenKey significa dejar de enterarse de
   * los fills, y un bot que no ve sus fills opera a ciegas.
   */
  private async ensureUserStream(): Promise<void> {
    if (this.userStreamStarted) return;
    this.userStreamStarted = true;

    // El listenKey se pide en CADA (re)conexión, no una sola vez: al reconectar
    // tras un corte largo el anterior puede haber caducado, y volver con uno
    // muerto deja el socket abierto sin recibir jamás un evento.
    this.openSocket(
      async () => {
        const { listenKey } = await this.signedRequest<{ listenKey: string }>(
          'POST',
          '/fapi/v3/listenKey',
        );
        return this.ws + '/ws/' + listenKey;
      },
      (raw) => this.handleUserEvent(raw),
      { stream: 'fills' },
    );

    this.keepAlive = setInterval(
      () => {
        if (this.closed) return;
        void this.signedRequest('PUT', '/fapi/v3/listenKey').catch((e) => {
          // Perder el listenKey es dejar de ver los fills. Se avisa para que el
          // motor sepa que a partir de aquí depende del respaldo por REST.
          this.health$.next({ stream: 'fills', status: 'DOWN', detail: messageOf(e) });
        });
      },
      30 * 60_000,
    );
  }

  private handleUserEvent(raw: string): void {
    let ev: AsterUserEvent;
    try {
      ev = JSON.parse(raw) as AsterUserEvent;
    } catch {
      return;
    }
    if (ev.e !== 'ORDER_TRADE_UPDATE' || !ev.o) return;
    const o = ev.o;

    this.orders$.next({
      venue: Venue.ASTER,
      symbol: o.s,
      clientOrderId: o.c ?? null,
      venueOrderId: String(o.i),
      side: o.S as OrderSide,
      type: o.o === 'MARKET' ? 'MARKET' : 'LIMIT',
      price: D(o.p).toFixed(),
      qty: D(o.q).toFixed(),
      filledQty: D(o.z).toFixed(),
      avgPrice: o.ap && !D(o.ap).isZero() ? D(o.ap).toFixed() : null,
      status: mapStatus(o.X),
      reduceOnly: o.R === true,
      createdAt: ev.E,
    });

    // Aster —como toda la familia de perps de Binance— no marca la ejecución,
    // marca la ORDEN: la que abre el venue para liquidar llega con tipo
    // `LIQUIDATION`. Se miran los dos campos porque `o` es el tipo vigente y
    // `ot` el original, y según el caso la etiqueta viaja en uno o en otro.
    const liquidacion = o.o === 'LIQUIDATION' || o.ot === 'LIQUIDATION';

    // `x === 'TRADE'` es lo que distingue una ejecución real de un simple
    // cambio de estado; sin ese filtro se contarían fills que no existen.
    if (o.x === 'TRADE' && o.t && !firstNum(o.l, 0).isZero()) {
      this.fills$.next({
        venue: Venue.ASTER,
        symbol: o.s,
        venueFillId: String(o.t),
        venueOrderId: String(o.i),
        clientOrderId: o.c ?? null,
        side: o.S as OrderSide,
        price: firstNum(o.L, o.p, 0).toFixed(),
        qty: firstNum(o.l, 0).toFixed(),
        fee: firstNum(o.n, 0).toFixed(),
        feeAsset: o.N ?? 'USDT',
        isTaker: o.m === false,
        ts: ev.E,
        ...(liquidacion ? { liquidation: true } : {}),
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    // `stop()` cancela el temporizador de reconexión ANTES de cerrar el socket:
    // si no, uno que esté a punto de saltar abriría una conexión nueva justo
    // después de cerrar.
    for (const socket of this.sockets) socket.stop();
    this.sockets = [];
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

  private toVenueOrder(o: AsterOrder): VenueOrder {
    return {
      venue: Venue.ASTER,
      symbol: o.symbol,
      clientOrderId: o.clientOrderId ?? null,
      venueOrderId: String(o.orderId),
      side: o.side as OrderSide,
      type: (o.type === 'MARKET' ? 'MARKET' : 'LIMIT') as OrderType,
      price: D(o.price).toFixed(),
      qty: D(o.origQty).toFixed(),
      filledQty: D(o.executedQty).toFixed(),
      avgPrice: o.avgPrice && !D(o.avgPrice).isZero() ? D(o.avgPrice).toFixed() : null,
      status: mapStatus(o.status),
      reduceOnly: o.reduceOnly === true,
      createdAt: o.time ?? o.updateTime ?? Date.now(),
    };
  }
}

function mapOrderType(req: PlaceOrderRequest): string {
  if (req.triggerPrice) {
    // El sentido del disparo lo declara quien pide la orden. En Aster (estilo
    // Binance) un STOP de venta dispara al CAER el precio y un TAKE_PROFIT de
    // venta al SUBIR: etiquetar un TP como STOP lo dispararía al revés.
    if (req.intent === 'TP') return req.type === 'MARKET' ? 'TAKE_PROFIT_MARKET' : 'TAKE_PROFIT';
    return req.type === 'MARKET' ? 'STOP_MARKET' : 'STOP';
  }
  return req.type === 'MARKET' ? 'MARKET' : 'LIMIT';
}

function mapStatus(status?: string): OrderStatusT {
  switch (status) {
    case 'NEW':
      return OrderStatus.OPEN;
    case 'PARTIALLY_FILLED':
      return OrderStatus.PARTIALLY_FILLED;
    case 'FILLED':
      return OrderStatus.FILLED;
    case 'CANCELED':
    case 'EXPIRED_IN_MATCH':
      return OrderStatus.CANCELED;
    case 'REJECTED':
      return OrderStatus.REJECTED;
    case 'EXPIRED':
      return OrderStatus.EXPIRED;
    default:
      return OrderStatus.PENDING;
  }
}

// ── Formas de respuesta del venue (solo los campos que se usan) ──────────

interface AsterExchangeInfo {
  symbols: {
    symbol: string;
    contractType: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    filters: {
      filterType: string;
      tickSize?: string;
      stepSize?: string;
      minQty?: string;
      maxQty?: string;
      notional?: string;
    }[];
  }[];
}

interface AsterBalance {
  asset: string;
  balance: string;
  availableBalance: string;
}

interface AsterPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice?: string;
  leverage: string;
  marginType?: string;
  isolatedMargin?: string;
}

interface AsterOrder {
  symbol: string;
  orderId: number;
  clientOrderId?: string;
  price: string;
  origQty: string;
  executedQty: string;
  avgPrice?: string;
  status?: string;
  side: string;
  type: string;
  reduceOnly?: boolean;
  time?: number;
  updateTime?: number;
}

/** Ejecución devuelta por `/fapi/v3/userTrades`. */
interface AsterUserTrade {
  id: number;
  orderId: number;
  symbol: string;
  price: string;
  qty: string;
  commission?: string;
  commissionAsset?: string;
  buyer: boolean;
  maker: boolean;
  time: number;
}

/** Fila de `ticker/24hr`. Los numéricos llegan como string, como en Binance. */
interface AsterTicker24h {
  symbol: string;
  priceChange?: string;
  priceChangePercent?: string;
  lastPrice?: string;
  highPrice?: string;
  lowPrice?: string;
  volume?: string;
  quoteVolume?: string;
  closeTime?: number;
}

/**
 * Vela de `klines`: un ARRAY posicional, no un objeto.
 *   [ apertura, o, h, l, c, volumen base, cierre, volumen quote, trades, ... ]
 */
type AsterKline = [number, string, string, string, string, string, number, ...unknown[]];

/** Cuerpo `k` del evento `kline` del WebSocket. */
interface AsterKlineEvent {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  x?: boolean;
}

interface AsterBookTicker {
  bidPrice?: string;
  askPrice?: string;
}

interface AsterPremiumIndex {
  markPrice?: string;
}

interface AsterUserEvent {
  e: string;
  E: number;
  o?: {
    s: string;
    c?: string;
    S: string;
    o: string;
    p: string;
    q: string;
    z: string;
    ap?: string;
    X?: string;
    /** Tipo de orden ORIGINAL. Es donde Aster dice `LIQUIDATION`. */
    ot?: string;
    i: number;
    R?: boolean;
    x?: string;
    t?: number;
    l?: string;
    L?: string;
    n?: string;
    N?: string;
    m?: boolean;
  };
}
