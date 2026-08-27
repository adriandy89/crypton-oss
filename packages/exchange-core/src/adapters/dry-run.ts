import { randomUUID } from 'node:crypto';
import { Observable, Subject, Subscription } from 'rxjs';
import {
  D,
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  Decimal,
  ExchangeError,
  OrderStatus,
  liquidationOfPosition,
  type Balance,
  type CancelRequest,
  type Fill,
  type MarginAction,
  type MarginMode,
  type MarketSpec,
  type OrderAck,
  type OrderSide,
  type OrderUpdate,
  type PlaceOrderRequest,
  type Position,
  type PositionMode,
  type PositionSide,
  type Ticker,
  type Venue,
  type VenueOrder,
  type Candle,
  type CollateralPosition,
  type CandleInterval,
  type MarketTicker,
  type VenueCapabilities,
} from '@crypton/shared';
import { codecFor } from '../coid';
import type { CandleQuery, ExchangeAdapter, StreamHealth } from '../types';

export interface DryRunOptions {
  /** Saldo inicial simulado, en la quote del mercado. */
  startingBalance?: string;
  /** Comisión de maker en tanto por uno (0.0002 = 0,02 %). */
  makerFeeRate?: string;
  takerFeeRate?: string;
  /** Deslizamiento aplicado a las órdenes a mercado, en tanto por uno. */
  slippageRate?: string;
  /**
   * Margen de mantenimiento en tanto por uno. Por debajo de él, el venue
   * liquida. Ver `checkLiquidation`.
   */
  maintenanceMarginRate?: number;
  /**
   * Estado con el que arranca el simulador. Sin él empieza limpio.
   *
   * Es lo que permite que una simulación sobreviva a un reinicio del worker:
   * quien construye el adaptador lo lee de donde lo haya guardado y lo pasa
   * aquí. El simulador no sabe —ni debe saber— dónde vive ese sitio.
   */
  initialState?: DryRunState;
  /**
   * Aviso de que el estado ha cambiado y conviene volver a guardarlo.
   *
   * SOLO debe marcar sucio: se llama desde el camino de ejecución de una orden,
   * así que cualquier E/S aquí dentro pondría la latencia de una escritura en
   * medio de un fill. Quien lo recibe agrupa y persiste a su ritmo.
   */
  onStateChange?: () => void;
  /**
   * ¿Cerrar también la fuente de precios al cerrarse? Por defecto sí.
   *
   * Se pone a `false` cuando la fuente es de OTRO y se comparte entre varios
   * simuladores. Es lo que permite que cada bot simulado tenga su propio
   * sandbox sin abrir una conexión al venue por cabeza: N simuladores, una sola
   * fuente. Sin esto, el primero en apagarse le cerraba el feed a los demás.
   */
  closeSource?: boolean;
  /**
   * Reloj de la simulación. Por defecto, el del sistema.
   *
   * Existe por el backtest: al reproducir un rango histórico, las marcas de
   * tiempo de las órdenes y las ejecuciones tienen que ser las de la VELA, no
   * las de hoy. Con el reloj de pared, la edad de una cotización
   * —`ctx.now - createdAt`— salía negativa y enorme, y todas las estrategias que
   * caducan órdenes por antigüedad se comportaban de forma absurda.
   */
  now?: () => number;
  /**
   * Semilla del sufijo de `venueFillId`. Por defecto, aleatoria.
   *
   * También para el backtest: sin fijarla, dos ejecuciones idénticas producen
   * ids distintos y no se puede escribir el test que dice «el mismo rango da el
   * mismo resultado» — que es la propiedad que hace útil comparar dos
   * configuraciones.
   */
  runId?: string;
}

interface SimOrder {
  req: PlaceOrderRequest;
  venueOrderId: string;
  createdAt: number;
  filledQty: Decimal;
}

/**
 * Estado del simulador, en forma serializable.
 *
 * Todo son cadenas y números planos a propósito: esto se guarda como JSON y se
 * relee en otro proceso, y un `Decimal` o un `Map` no sobreviven al viaje.
 */
export interface DryRunState {
  balance: string;
  realizedPnl: string;
  feesPaid: string;
  seq: number;
  positions: {
    symbol: string;
    qty: string;
    entryPrice: string;
    leverage: number;
    marginMode: MarginMode;
    extraMargin: string;
  }[];
  orders: {
    clientOrderId: string;
    req: PlaceOrderRequest;
    venueOrderId: string;
    createdAt: number;
    filledQty: string;
  }[];
}

interface SimPosition {
  qty: Decimal; // firmada
  entryPrice: Decimal;
  leverage: number;
  marginMode: MarginMode;
  /**
   * Colateral aportado a mano SOBRE el que exige el apalancamiento, en quote.
   *
   * Vive aparte de `leverage` porque no es lo mismo: `leverage` sigue siendo el
   * que dimensiona las entradas nuevas, y esto solo engorda la caja de lo que
   * ya está abierto. Mezclarlos haría que un aporte encogiera el tamaño de los
   * siguientes niveles de la escalera, que es justo lo que el usuario NO pide
   * cuando aporta margen para defender la posición.
   */
  extraMargin: Decimal;
}

/**
 * Adaptador de simulación.
 *
 * Toma los precios REALES del venue a través de `source` —mercados, ticker,
 * libro— pero no manda ni una sola orden: las ejecuta contra ese precio en
 * memoria. Es lo que permite dejar corriendo las seis estrategias contra los
 * tres DEX durante horas sin arriesgar un dólar, y lo que hace que la prueba
 * de caos del motor se pueda repetir cuantas veces haga falta.
 *
 * Lo que NO simula, y conviene tener presente al leer sus resultados: la
 * profundidad del libro (una orden se ejecuta entera al tocarse el precio, sin
 * impacto de mercado) y la cola de prioridad de las post-only.
 *
 * La liquidación SÍ se simula (ver `checkLiquidation`), pero con un margen de
 * mantenimiento plano —0,5 % por defecto— en lugar de la escala por tramos que
 * aplica cada venue. Los tramos altos son peores que ese 0,5 %, así que la
 * estimación es OPTIMISTA: una posición grande revienta en el venue algo antes
 * de lo que revienta aquí.
 */
export class DryRunAdapter implements ExchangeAdapter {
  readonly venue: Venue;

  private readonly orders = new Map<string, SimOrder>();
  private readonly positions = new Map<string, SimPosition>();
  private readonly leverage = new Map<string, { value: number; mode: MarginMode }>();
  private readonly lastTicker = new Map<string, Ticker>();
  private readonly tickerSubs = new Map<string, Subscription>();

  private readonly orders$ = new Subject<OrderUpdate>();
  private readonly fills$ = new Subject<Fill>();
  /** Ejecuciones simuladas, para poder servir `getRecentFills`. */
  private readonly fillLog: Fill[] = [];

  /**
   * Sufijo único de ESTE simulador.
   *
   * El id de ejecución era `<orden>:<contador>` con un contador por adaptador,
   * así que dos bots simulados generaban los mismos ids casi de inmediato. Con
   * la unicidad de `venue_fill_id`, la segunda ejecución se descartaba en
   * silencio y la contabilidad del bot quedaba mal. Y la simulación es
   * ilimitada en el plan gratuito, así que era el caso normal, no el raro.
   */
  private readonly runId: string;

  /** Ver `DryRunOptions.now`. */
  private readonly clock: () => number;

  private balance: Decimal;
  private realizedPnl = D(0);
  private feesPaid = D(0);
  private seq = 0;

  private readonly makerFee: Decimal;
  private readonly takerFee: Decimal;
  private readonly slippage: Decimal;
  private readonly mmr: number;
  private readonly closeSource: boolean;

  /**
   * Aviso de «esto ha cambiado, vuelve a guardarlo». Ver `DryRunOptions`.
   *
   * Se llama SIEMPRE al final de la operación que cambió algo, nunca en medio:
   * quien lo recibe puede pedir `exportState()` desde dentro y tiene que
   * encontrarse un estado coherente, no uno a medio aplicar.
   */
  private readonly notifyChange: () => void;

  /**
   * El simulador habla el MISMO idioma de ids que el venue que envuelve.
   *
   * El motor reconcilia en espacio de venue —en Hyperliquid el id es un hash,
   * en Lighter un entero— y el simulador devolvía los ids canónicos tal cual.
   * Nunca casaban: en cada tick el reconciliador daba la orden real por
   * «propia y obsoleta» (la cancelaba) y la deseada por «ausente» (la
   * recolocaba). Ninguna orden limit simulada descansaba en el libro más de un
   * latido, así que casi nunca se ejecutaba, y el usuario —que prueba en
   * simulación ANTES de poner dinero— veía un motor que parecía roto.
   */
  private readonly encode: (canonical: string) => string;

  constructor(
    private readonly source: ExchangeAdapter,
    opts: DryRunOptions = {},
  ) {
    this.venue = source.venue;
    this.encode = codecFor(source.venue).encode;
    this.balance = D(opts.startingBalance ?? '10000');
    this.makerFee = D(opts.makerFeeRate ?? '0.0002');
    this.takerFee = D(opts.takerFeeRate ?? '0.0005');
    this.slippage = D(opts.slippageRate ?? '0.0005');
    this.mmr = opts.maintenanceMarginRate ?? DEFAULT_MAINTENANCE_MARGIN_RATE;
    this.closeSource = opts.closeSource !== false;
    this.runId = opts.runId ?? randomUUID().slice(0, 8);
    this.clock = opts.now ?? Date.now;
    this.notifyChange = opts.onStateChange ?? (() => undefined);
    if (opts.initialState) this.importState(opts.initialState);
  }

  // ── Estado persistible ───────────────────────────────────────────

  /**
   * Vuelca el estado para guardarlo fuera.
   *
   * Existe porque la simulación vivía SOLO en memoria: un reinicio del worker
   * —o que otro worker adoptara el bot— devolvía el saldo al de partida y
   * borraba las posiciones, mientras las órdenes y las ejecuciones seguían en la
   * base. El bot quedaba discutiendo con su propio libro, y quien estaba
   * probando la plataforma antes de poner dinero veía un motor roto.
   */
  exportState(): DryRunState {
    return {
      balance: this.balance.toFixed(),
      realizedPnl: this.realizedPnl.toFixed(),
      feesPaid: this.feesPaid.toFixed(),
      seq: this.seq,
      positions: [...this.positions].map(([symbol, p]) => ({
        symbol,
        qty: p.qty.toFixed(),
        entryPrice: p.entryPrice.toFixed(),
        leverage: p.leverage,
        marginMode: p.marginMode,
        extraMargin: p.extraMargin.toFixed(),
      })),
      orders: [...this.orders].map(([clientOrderId, o]) => ({
        clientOrderId,
        req: o.req,
        venueOrderId: o.venueOrderId,
        createdAt: o.createdAt,
        filledQty: o.filledQty.toFixed(),
      })),
    };
  }

  /**
   * Recupera un estado guardado. Reemplaza lo que hubiera, no lo mezcla.
   *
   * El apalancamiento se rehace desde las posiciones porque es lo que decide el
   * margen comprometido y la liquidación: sin él, una posición recuperada
   * parecería sostenerse con toda la cuenta detrás.
   */
  importState(state: DryRunState): void {
    this.balance = D(state.balance);
    this.realizedPnl = D(state.realizedPnl);
    this.feesPaid = D(state.feesPaid);
    this.seq = state.seq;

    this.positions.clear();
    this.leverage.clear();
    for (const p of state.positions) {
      this.positions.set(p.symbol, {
        qty: D(p.qty),
        entryPrice: D(p.entryPrice),
        leverage: p.leverage,
        marginMode: p.marginMode,
        extraMargin: D(p.extraMargin),
      });
      this.leverage.set(p.symbol, { value: p.leverage, mode: p.marginMode });
    }

    this.orders.clear();
    for (const o of state.orders) {
      this.orders.set(o.clientOrderId, {
        req: o.req,
        venueOrderId: o.venueOrderId,
        createdAt: o.createdAt,
        filledQty: D(o.filledQty),
      });
    }
  }

  // ── Datos de mercado: siempre reales ─────────────────────────────
  verify(): Promise<{ ok: boolean; publicRef: string; detail?: string }> {
    return Promise.resolve({ ok: true, publicRef: 'dry-run', detail: 'Simulación activa' });
  }

  /**
   * Las capacidades son las del venue REAL que hay debajo.
   *
   * En simulación los precios son de verdad —es todo el sentido del modo—, así
   * que un bot simulado en Lighter tiene que ver exactamente los mismos nueve
   * intervalos que uno real. Inventar aquí una lista propia haría que el
   * gráfico mintiera justo en la fase en la que el usuario decide si opera.
   */
  get capabilities(): VenueCapabilities {
    return this.source.capabilities;
  }

  getMarkets(): Promise<MarketSpec[]> {
    return this.source.getMarkets();
  }

  getTickers(): Promise<MarketTicker[]> {
    return this.source.getTickers();
  }

  getCandles(
    symbol: string,
    interval: CandleInterval,
    query: CandleQuery,
  ): Promise<Candle[]> {
    return this.source.getCandles(symbol, interval, query);
  }

  streamCandles(symbol: string, interval: CandleInterval): Observable<Candle> {
    // Si el venue real no emite velas, aquí tampoco hay nada que emitir: se
    // devuelve un Observable que no completa ni falla, y el llamante decide
    // por `capabilities.candles.live` si merece la pena suscribirse.
    return this.source.streamCandles?.(symbol, interval) ?? new Subject<Candle>().asObservable();
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const ticker = await this.source.getTicker(symbol);
    this.lastTicker.set(symbol, ticker);
    this.matchRestingOrders(symbol, ticker);
    return ticker;
  }

  streamTicker(symbol: string): Observable<Ticker> {
    // Se engancha al ticker real UNA vez por símbolo: cada tick es la
    // oportunidad de comprobar si alguna orden en reposo se ha tocado.
    if (!this.tickerSubs.has(symbol)) {
      const sub = this.source.streamTicker(symbol).subscribe((t) => {
        this.lastTicker.set(symbol, t);
        this.matchRestingOrders(symbol, t);
      });
      this.tickerSubs.set(symbol, sub);
    }
    return this.source.streamTicker(symbol);
  }

  // ── Estado simulado ──────────────────────────────────────────────

  getBalances(): Promise<Balance[]> {
    const used = [...this.positions.entries()].reduce((acc, [symbol, p]) => {
      const mark = D(this.lastTicker.get(symbol)?.mark ?? p.entryPrice);
      const lev = this.leverage.get(symbol)?.value ?? p.leverage;
      // El margen aportado a mano cuenta como comprometido: ha salido del
      // saldo libre para meterse en la caja de la posición, igual que en el
      // venue. Sin sumarlo, la simulación dejaría aportar el mismo dinero una
      // y otra vez sin que `available` bajara nunca.
      return acc.plus(p.qty.abs().mul(mark).div(lev || 1)).plus(p.extraMargin);
    }, D(0));

    return Promise.resolve([
      {
        asset: 'USDC',
        total: this.balance.plus(this.realizedPnl).toFixed(),
        available: this.balance.plus(this.realizedPnl).minus(used).toFixed(),
        used: used.toFixed(),
      },
    ]);
  }

  getPositions(symbol?: string): Promise<Position[]> {
    const out: Position[] = [];
    for (const [sym, p] of this.positions) {
      if (symbol && sym !== symbol) continue;
      if (p.qty.isZero()) continue;
      const mark = D(this.lastTicker.get(sym)?.mark ?? p.entryPrice);
      const notional = p.qty.abs().mul(p.entryPrice);
      const margin = notional.div(p.leverage || 1).plus(p.extraMargin);
      out.push({
        venue: this.venue,
        symbol: sym,
        qty: p.qty.toFixed(),
        entryPrice: p.entryPrice.toFixed(),
        markPrice: mark.toFixed(),
        unrealizedPnl: mark.minus(p.entryPrice).mul(p.qty).toFixed(),
        // El apalancamiento EFECTIVO, no el configurado: con margen aportado a
        // mano la posición sostiene el mismo notional con más caja, y eso es
        // literalmente estar menos apalancada. Se informa así porque es lo que
        // hace un venue real y porque es lo que mueve la liquidación estimada
        // río abajo — quien la calcula solo mira el apalancamiento, de modo que
        // sin esto la simulación enseñaría un aporte que no defiende de nada.
        leverage: margin.gt(0) ? notional.div(margin).toNumber() : p.leverage,
        marginMode: p.marginMode,
        // Se informa de verdad y no `null`: es el precio contra el que
        // `checkLiquidation` va a reventar esta posición, y enseñarlo vacío
        // dejaría al usuario creyendo que en simulación no se liquida —que es
        // justo lo que pasaba antes—.
        liquidationPrice: this.liquidationOf(sym, p)?.toFixed() ?? null,
        marginUsed: margin.toFixed(),
      });
    }
    return Promise.resolve(out);
  }

  getOpenOrders(symbol?: string): Promise<VenueOrder[]> {
    const out: VenueOrder[] = [];
    for (const o of this.orders.values()) {
      if (symbol && o.req.symbol !== symbol) continue;
      out.push(this.toVenueOrder(o));
    }
    return Promise.resolve(out);
  }

  // ── Ejecución simulada ───────────────────────────────────────────

  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    const ticker = this.lastTicker.get(req.symbol) ?? (await this.getTicker(req.symbol));
    const venueOrderId = 'sim-' + ++this.seq;

    if (req.type === 'MARKET') {
      // Una orden a mercado cruza el libro: paga taker y se lleva el
      // deslizamiento en contra. Simularla sin coste daría PnL de fantasía.
      const ref = D(req.side === 'BUY' ? ticker.ask : ticker.bid);
      const slip = D(1).plus(req.side === 'BUY' ? this.slippage : this.slippage.neg());
      this.executeFill(req, ref.mul(slip), D(req.qty), venueOrderId, true);
      return {
        clientOrderId: req.clientOrderId,
        venueOrderId,
        status: OrderStatus.FILLED,
        ts: this.clock(),
      };
    }

    const price = D(req.price ?? 0);
    if (price.lte(0)) {
      throw new ExchangeError('RULES', 'Una orden limit necesita precio', this.venue);
    }

    // POST_ONLY que cruzaría el libro: el venue real la rechaza, así que aquí
    // también. Si no, el simulador sería más permisivo que la realidad y las
    // estrategias parecerían funcionar mejor de lo que funcionan.
    if (req.type === 'POST_ONLY') {
      const crosses =
        req.side === 'BUY' ? price.gte(D(ticker.ask)) : price.lte(D(ticker.bid));
      if (crosses) {
        throw new ExchangeError('RULES', 'Post-only rechazada: cruzaría el libro', this.venue);
      }
    }

    this.orders.set(req.clientOrderId, {
      req,
      venueOrderId,
      createdAt: this.clock(),
      filledQty: D(0),
    });
    this.notifyChange();

    return {
      clientOrderId: req.clientOrderId,
      venueOrderId,
      status: OrderStatus.OPEN,
      ts: this.clock(),
    };
  }

  cancelOrder(req: CancelRequest): Promise<void> {
    // El id puede llegar canónico (desde el motor) o en espacio de venue (desde
    // el reconciliador): se aceptan los dos, como haría el venue real.
    if (req.clientOrderId) {
      for (const [coid] of this.orders) {
        if (coid === req.clientOrderId || this.encode(coid) === req.clientOrderId) {
          this.orders.delete(coid);
          this.notifyChange();
          return Promise.resolve();
        }
      }
    }
    for (const [coid, o] of this.orders) {
      if (o.venueOrderId === req.venueOrderId) {
        this.orders.delete(coid);
        this.notifyChange();
        break;
      }
    }
    return Promise.resolve();
  }

  cancelOwn(symbol: string, clientOrderIds: string[]): Promise<void> {
    for (const coid of clientOrderIds) {
      const order = this.orders.get(coid);
      if (order && order.req.symbol === symbol) this.orders.delete(coid);
    }
    this.notifyChange();
    return Promise.resolve();
  }

  cancelAll(symbol: string): Promise<void> {
    for (const [coid, o] of this.orders) {
      if (o.req.symbol === symbol) this.orders.delete(coid);
    }
    this.notifyChange();
    return Promise.resolve();
  }

  setLeverage(symbol: string, leverage: number, mode: MarginMode): Promise<void> {
    this.leverage.set(symbol, { value: leverage, mode });
    const pos = this.positions.get(symbol);
    if (pos) {
      pos.leverage = leverage;
      pos.marginMode = mode;
    }
    this.notifyChange();
    return Promise.resolve();
  }

  setPositionMode(_mode: PositionMode): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Aporta o retira colateral de la posición simulada.
   *
   * Se implementa de verdad —y no como un no-op— porque la simulación existe
   * para que el usuario pruebe el comportamiento ANTES de arriesgar dinero: un
   * aporte que en dry-run no moviera nada enseñaría lo contrario de lo que va a
   * pasar en el venue.
   *
   * No se puede retirar más de lo aportado a mano: por debajo de eso se estaría
   * comiendo el margen que exige el apalancamiento, y ahí el venue real
   * rechaza. Se rechaza igual aquí para que la simulación falle donde va a
   * fallar de verdad.
   */
  adjustIsolatedMargin(
    symbol: string,
    amountUsd: string,
    action: MarginAction,
    _side: PositionSide,
  ): Promise<void> {
    const pos = this.positions.get(symbol);
    if (!pos || pos.qty.isZero()) {
      return Promise.reject(
        new ExchangeError('RULES', `No hay posición abierta en ${symbol} que financiar.`, this.venue),
      );
    }
    if (pos.marginMode !== 'ISOLATED') {
      return Promise.reject(
        new ExchangeError(
          'RULES',
          'El ajuste de margen solo existe en modo aislado: en cruzado el colateral es de toda la cuenta.',
          this.venue,
        ),
      );
    }

    const amount = D(amountUsd).abs();
    if (action === 'REMOVE') {
      if (amount.gt(pos.extraMargin)) {
        return Promise.reject(
          new ExchangeError(
            'INSUFFICIENT_FUNDS',
            `Solo puedes retirar hasta ${pos.extraMargin.toFixed()} : el resto es el margen que exige el apalancamiento.`,
            this.venue,
          ),
        );
      }
      pos.extraMargin = pos.extraMargin.minus(amount);
    } else {
      pos.extraMargin = pos.extraMargin.plus(amount);
    }
    this.notifyChange();
    return Promise.resolve();
  }

  streamOrders(): Observable<OrderUpdate> {
    return this.orders$.asObservable();
  }

  streamFills(): Observable<Fill> {
    return this.fills$.asObservable();
  }

  /**
   * Salud de los streams reales: los precios de la simulación son de verdad,
   * así que si el ticker del venue se cae, al simulador le importa igual.
   */
  streamHealth(): Observable<StreamHealth> {
    return this.source.streamHealth();
  }

  /** Las ejecuciones simuladas se sirven del registro en memoria. */
  getRecentFills(symbol: string, sinceMs: number): Promise<Fill[]> {
    return Promise.resolve(this.fillLog.filter((f) => f.symbol === symbol && f.ts >= sinceMs));
  }

  async close(): Promise<void> {
    for (const s of this.tickerSubs.values()) s.unsubscribe();
    this.tickerSubs.clear();
    this.orders$.complete();
    this.fills$.complete();
    // Las suscripciones propias se sueltan siempre; la fuente, solo si es
    // nuestra. Ver `closeSource`.
    if (this.closeSource) await this.source.close();
  }

  // ── Motor de casación ────────────────────────────────────────────

  /**
   * Una compra se ejecuta cuando el ask baja hasta su precio; una venta, cuando
   * el bid sube hasta el suyo. Se usan bid/ask y no el último precio porque es
   * lo que determina de verdad si alguien cruzaría contra nuestra orden.
   */
  private matchRestingOrders(symbol: string, ticker: Ticker): void {
    // La liquidación se comprueba ANTES de casar: si el precio ha llegado tan
    // lejos que el venue habría cerrado la posición, las órdenes en reposo de
    // ese símbolo ya no existían para ejecutarse. Al revés —casar primero— la
    // simulación regalaría un rebote que en el venue no ocurre.
    if (this.checkLiquidation(symbol, ticker)) return;

    const bid = D(ticker.bid);
    const ask = D(ticker.ask);

    for (const [coid, order] of [...this.orders]) {
      if (order.req.symbol !== symbol) continue;
      const price = D(order.req.price ?? 0);
      const touched =
        order.req.side === 'BUY' ? ask.gt(0) && ask.lte(price) : bid.gt(0) && bid.gte(price);
      if (!touched) continue;

      this.orders.delete(coid);
      const remaining = D(order.req.qty).minus(order.filledQty);
      // Se ejecuta al precio LIMIT, no al de mercado: una orden en reposo que
      // se toca se llena a su propio precio, nunca mejor.
      this.executeFill(order.req, price, remaining, order.venueOrderId, false);
    }
  }

  /**
   * Las posiciones en la forma que entiende el cálculo de colateral.
   *
   * El símbolo tiene que viajar dentro porque en CRUZADO la caja de una
   * posición depende de lo que las OTRAS tengan inmovilizado, y para eso hay que
   * poder distinguirlas.
   */
  private collateralView(): CollateralPosition[] {
    return [...this.positions].map(([symbol, p]) => ({
      symbol,
      qty: p.qty,
      entryPrice: p.entryPrice,
      leverage: p.leverage,
      marginMode: p.marginMode,
      extraMargin: p.extraMargin,
    }));
  }

  /** Patrimonio de la cuenta: es lo que respalda a las posiciones cruzadas. */
  private equity(): Decimal {
    return this.balance.plus(this.realizedPnl);
  }

  /**
   * Liquidación estimada de una posición, o null si no aplica.
   *
   * Delega en `liquidationOfPosition` porque el cálculo NO es el mismo en los
   * dos modos de margen: una posición aislada la respalda solo su propio margen
   * —y aportar colateral a mano aleja la liquidación, que es justo para lo que
   * se aporta—, mientras que a una cruzada la respalda la cuenta entera. Aquí se
   * trataba todo como aislado, así que una rejilla neutral con sus ajustes por
   * defecto —que son CRUZADO— reventaba con un movimiento que un venue real ni
   * habría notado.
   */
  private liquidationOf(symbol: string, p: SimPosition): Decimal | null {
    return liquidationOfPosition(
      { symbol, qty: p.qty, entryPrice: p.entryPrice, leverage: p.leverage, marginMode: p.marginMode, extraMargin: p.extraMargin },
      this.collateralView(),
      this.equity(),
      this.mmr,
    );
  }

  /**
   * Revienta la posición si el precio de marca ha cruzado su liquidación.
   *
   * Esto faltaba, y era la mentira más cara del simulador: sin liquidación, una
   * martingala apalancada SIEMPRE acaba ganando en simulación, porque la única
   * forma real de perderlo todo —que el venue te cierre— no existía. Quien
   * probaba antes de operar veía una estrategia infalible y luego se
   * encontraba con la de verdad.
   *
   * Se usa el precio de MARCA y no el último negociado porque es el que usa el
   * venue para liquidar. Devuelve true si ha liquidado, para que quien llama
   * sepa que la posición y las órdenes de ese símbolo ya no están.
   *
   * La ejecución sale MARCADA (`Fill.liquidation`), y esa marca no es
   * decorativa: no lleva el id de ninguna orden del bot —el venue tampoco lo
   * lleva cuando liquida de verdad— así que es lo único que autoriza al motor a
   * atribuírsela por símbolo y anotarla. Sin ella, `BotStore.recordFill` no
   * encuentra fila y la descarta, que es lo que pasaba antes: la posición
   * desaparecía y `bot_cycles.realized_pnl` seguía enseñando la de antes.
   */
  private checkLiquidation(symbol: string, ticker: Ticker): boolean {
    const pos = this.positions.get(symbol);
    if (!pos || pos.qty.isZero()) return false;

    const liq = this.liquidationOf(symbol, pos);
    if (!liq) return false;

    const mark = D(ticker.mark || ticker.last || 0);
    if (mark.lte(0)) return false;
    const crossed = pos.qty.gt(0) ? mark.lte(liq) : mark.gte(liq);
    if (!crossed) return false;

    // Las órdenes en reposo mueren con la posición, igual que en el venue: una
    // liquidación deja la cuenta plana, no a medio camino con la escalera
    // todavía puesta.
    for (const [coid, o] of [...this.orders]) {
      if (o.req.symbol === symbol) this.orders.delete(coid);
    }

    const qty = pos.qty.abs();
    const side: OrderSide = pos.qty.gt(0) ? 'SELL' : 'BUY';
    const venueOrderId = 'sim-liq-' + ++this.seq;

    // El cierre se ejecuta AL PRECIO DE LIQUIDACIÓN y como taker: el venue
    // cruza el libro a la fuerza y cobra comisión por ello. Cerrar al de marca
    // y sin comisión dejaría al simulador perdiendo menos de lo que se pierde.
    this.executeFill(
      {
        symbol,
        side,
        type: 'MARKET',
        qty: qty.toFixed(),
        clientOrderId: venueOrderId,
        reduceOnly: true,
      },
      liq,
      qty,
      venueOrderId,
      true,
      true,
    );

    // No se descuenta nada más aquí, y conviene ver por qué: el margen aportado
    // a mano YA está dentro de esta pérdida.
    //
    // El precio de liquidación sale del apalancamiento EFECTIVO, que es el
    // notional entre el margen realmente comprometido —incluido el aportado—.
    // Cerrar ahí realiza exactamente `−margen + notional × mmr`, o sea la caja
    // entera de la posición menos el colchón de mantenimiento. Restar además
    // `extraMargin` lo cobraba dos veces: una posición 10× de 100 con 10
    // aportados perdía 29,5 en lugar de 19,5.
    return true;
  }

  private executeFill(
    req: PlaceOrderRequest,
    price: Decimal,
    qty: Decimal,
    venueOrderId: string,
    isTaker: boolean,
    liquidation = false,
  ): void {
    if (qty.lte(0)) return;
    const signed = req.side === 'BUY' ? qty : qty.neg();
    const fee = price.mul(qty).mul(isTaker ? this.takerFee : this.makerFee);
    this.feesPaid = this.feesPaid.plus(fee);
    this.realizedPnl = this.realizedPnl.minus(fee);

    const current = this.positions.get(req.symbol) ?? {
      qty: D(0),
      entryPrice: price,
      leverage: this.leverage.get(req.symbol)?.value ?? 1,
      marginMode: this.leverage.get(req.symbol)?.mode ?? 'ISOLATED',
      extraMargin: D(0),
    };

    const next = current.qty.plus(signed);

    if (current.qty.isZero() || current.qty.s === signed.s) {
      // Abre o aumenta: el precio medio se recalcula ponderando por cantidad.
      const totalCost = current.entryPrice.mul(current.qty.abs()).plus(price.mul(qty));
      current.entryPrice = next.isZero() ? price : totalCost.div(next.abs());
    } else {
      // Reduce o invierte: la parte que cierra realiza PnL contra el medio.
      const closing = Decimal.min(qty, current.qty.abs());
      const direction = current.qty.gt(0) ? D(1) : D(-1);
      this.realizedPnl = this.realizedPnl.plus(
        price.minus(current.entryPrice).mul(closing).mul(direction),
      );
      // Si invierte el sentido, el resto abre posición nueva a este precio.
      if (!next.isZero() && next.s !== current.qty.s) current.entryPrice = price;
    }

    current.qty = next;
    if (next.isZero()) this.positions.delete(req.symbol);
    else this.positions.set(req.symbol, current);

    this.orders$.next({
      venue: this.venue,
      symbol: req.symbol,
      clientOrderId: this.encode(req.clientOrderId),
      venueOrderId,
      side: req.side,
      type: req.type,
      price: price.toFixed(),
      qty: D(req.qty).toFixed(),
      filledQty: qty.toFixed(),
      avgPrice: price.toFixed(),
      status: OrderStatus.FILLED,
      reduceOnly: req.reduceOnly === true,
      createdAt: this.clock(),
    });

    const fill: Fill = {
      venue: this.venue,
      symbol: req.symbol,
      venueFillId: 'sim-' + this.runId + ':' + venueOrderId + ':' + ++this.seq,
      venueOrderId,
      clientOrderId: this.encode(req.clientOrderId),
      side: req.side,
      price: price.toFixed(),
      qty: qty.toFixed(),
      fee: fee.toFixed(),
      feeAsset: 'USDC',
      isTaker,
      ts: this.clock(),
      // Lo que permite que el motor la reconozca y la anote, aunque no lleve el
      // id de ninguna orden suya. Ver `Fill.liquidation`.
      ...(liquidation ? { liquidation: true } : {}),
    };
    // Se registra ANTES de emitir: si el consumidor pide `getRecentFills` como
    // reacción al evento, la ejecución ya tiene que estar en el registro.
    this.fillLog.push(fill);
    // Ventana acotada: el simulador puede correr semanas y este registro solo
    // sirve de respaldo reciente, no de histórico (para eso está `bot_fills`).
    if (this.fillLog.length > 1000) this.fillLog.splice(0, this.fillLog.length - 1000);
    // Se avisa ANTES de emitir, y por el mismo motivo por el que el registro se
    // escribe antes: quien reaccione al fill tiene que encontrarse ya un estado
    // que incluya lo que acaba de pasar.
    this.notifyChange();
    this.fills$.next(fill);
  }

  private toVenueOrder(o: SimOrder): VenueOrder {
    return {
      venue: this.venue,
      symbol: o.req.symbol,
      clientOrderId: this.encode(o.req.clientOrderId),
      venueOrderId: o.venueOrderId,
      side: o.req.side,
      type: o.req.type,
      price: D(o.req.price ?? 0).toFixed(),
      qty: D(o.req.qty).toFixed(),
      filledQty: o.filledQty.toFixed(),
      avgPrice: null,
      status: o.filledQty.isZero() ? OrderStatus.OPEN : OrderStatus.PARTIALLY_FILLED,
      reduceOnly: o.req.reduceOnly === true,
      createdAt: o.createdAt,
    };
  }

  /** Resumen de la simulación: lo que se compara contra el cálculo a mano. */
  stats(): { realizedPnl: string; feesPaid: string; openOrders: number; positions: number } {
    return {
      realizedPnl: this.realizedPnl.toFixed(),
      feesPaid: this.feesPaid.toFixed(),
      openOrders: this.orders.size,
      positions: this.positions.size,
    };
  }
}
