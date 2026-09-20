import { Observable, Subject } from 'rxjs';
import {
  D,
  ExchangeError,
  Venue,
  type Balance,
  type CancelRequest,
  type CycleState,
  type DesiredOrder,
  type DesiredState,
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
} from '@crypton/shared';
import { hyperliquidCodec, type ExchangeAdapter, type StreamHealth } from '@crypton/exchange-core';
import { makeCoid } from '@crypton/strategy-core';
import {
  anotarConcesion,
  caudalDeVenue,
  claveCaudal,
  reiniciarCaudal,
  type MuestraCaudal,
} from '@crypton/exchange-core';
import { BotRunner, ttlDeSerie, type BotRunnerDeps } from './bot-runner';
import type { BotRecord, BotStore } from './bot-store';

const BOT_ID = '1a2b3c4d-0000-0000-0000-000000000000';

const MARKET: MarketSpec = {
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  canonical: 'BTC/USDC',
  base: 'BTC',
  quote: 'USDC',
  tickSize: '0.1',
  stepSize: '0.001',
  minNotional: '10',
  minQty: null,
  maxQty: null,
  maxLeverage: 40,
  priceDecimals: 1,
  qtyDecimals: 3,
  active: true,
};

const TICKER: Ticker = {
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  last: '100',
  bid: '99.9',
  ask: '100.1',
  mark: '100',
  ts: Date.now(),
};

/**
 * Adaptador falso que registra lo que se le pide y en qué orden.
 *
 * El orden importa más que los valores: la mayoría de estos tests comprueban
 * que algo NO ocurre después de otra cosa.
 */
class FakeAdapter implements ExchangeAdapter {
  readonly venue = Venue.HYPERLIQUID;
  readonly calls: string[] = [];
  readonly placed: string[] = [];
  /** Las peticiones enteras, para mirar CON QUE precio y tipo salio cada una. */
  readonly requests: PlaceOrderRequest[] = [];
  readonly canceledOwn: string[][] = [];

  readonly fills$ = new Subject<Fill>();
  readonly orders$ = new Subject<OrderUpdate>();
  readonly ticker$ = new Subject<Ticker>();
  readonly health$ = new Subject<StreamHealth>();

  /** Si es null, `getTicker` falla: simula un venue que no responde. */
  ticker: Ticker | null = TICKER;
  /**
   * Si se pone, `getTicker` falla con esto. Con `kind` a elegir: un RETRYABLE es
   * el venue caído y un FATAL es un fallo del propio bot (spec 050).
   */
  tickerError: ExchangeError | null = null;
  /** Retraso artificial de `getTicker`, para provocar un tick lento. */
  tickerDelayMs = 0;
  position: Position | null = null;
  placeError: ExchangeError | null = null;
  /** Falla SOLO la primera colocación: para ver si las siguientes salen igual. */
  placeErrorOnce: ExchangeError | null = null;
  /** Retraso artificial de cada colocación, para provocar solapes. */
  placeDelayMs = 0;

  verify = async () => ({ ok: true, publicRef: 'fake' });
  getMarkets = async (): Promise<MarketSpec[]> => [MARKET];
  getBalances = async (): Promise<Balance[]> => [
    { asset: 'USDC', total: '1000', available: '1000', used: '0' },
  ];
  getPositions = async (): Promise<Position[]> => (this.position ? [this.position] : []);
  getOpenOrders = async (): Promise<VenueOrder[]> => [];
  getRecentFills = async (): Promise<Fill[]> => [];

  async getTicker(): Promise<Ticker> {
    this.calls.push('getTicker');
    if (this.tickerDelayMs > 0) await new Promise((r) => setTimeout(r, this.tickerDelayMs));
    if (this.tickerError) throw this.tickerError;
    if (!this.ticker) throw new ExchangeError('RETRYABLE', 'sin precio', this.venue);
    return this.ticker;
  }

  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    this.calls.push('place:' + req.clientOrderId);
    if (this.placeDelayMs > 0) await new Promise((r) => setTimeout(r, this.placeDelayMs));
    if (this.placeErrorOnce) {
      const e = this.placeErrorOnce;
      this.placeErrorOnce = null;
      throw e;
    }
    if (this.placeError) throw this.placeError;
    this.placed.push(req.clientOrderId);
    this.requests.push(req);
    return {
      clientOrderId: req.clientOrderId,
      venueOrderId: 'v-' + req.clientOrderId,
      status: 'OPEN',
      ts: Date.now(),
    };
  }

  async cancelOrder(_req: CancelRequest): Promise<void> {
    this.calls.push('cancelOrder');
  }

  async cancelOwn(_symbol: string, clientOrderIds: string[]): Promise<void> {
    this.calls.push('cancelOwn');
    this.canceledOwn.push(clientOrderIds);
  }

  async cancelAll(): Promise<void> {
    this.calls.push('cancelAll');
  }

  /** Argumentos de cada `setLeverage`, para ver QUE se le mando al venue. */
  readonly leverageCalls: { leverage: number; mode: string }[] = [];
  /** Argumentos de cada ajuste de margen. */
  readonly marginCalls: { amount: string; action: string; side: string }[] = [];
  /** Si se pone, `adjustIsolatedMargin` falla con esto. */
  marginError: Error | null = null;

  async setLeverage(_symbol: string, leverage: number, mode: MarginMode): Promise<void> {
    this.calls.push('setLeverage');
    this.leverageCalls.push({ leverage, mode });
  }

  async adjustIsolatedMargin(
    _symbol: string,
    amountUsd: string,
    action: MarginAction,
    side: PositionSide,
  ): Promise<void> {
    this.calls.push('adjustIsolatedMargin');
    if (this.marginError) throw this.marginError;
    this.marginCalls.push({ amount: amountUsd, action, side });
  }

  streamOrders = (): Observable<OrderUpdate> => this.orders$.asObservable();
  streamFills = (): Observable<Fill> => this.fills$.asObservable();
  streamTicker = (): Observable<Ticker> => this.ticker$.asObservable();
  streamHealth = (): Observable<StreamHealth> => this.health$.asObservable();
  close = async (): Promise<void> => {
    this.calls.push('close');
  };
}

/** Store falso: solo lo que el runner llega a tocar. */
function fakeStore(over: Partial<BotStore> = {}) {
  const events: string[] = [];
  const cycleCalls: number[] = [];
  /**
   * Los eventos CON su payload. `events` se queda como estaba —solo el tipo—
   * porque es lo que comprueban casi todos los tests y basta; esto lo necesita
   * el ajuste de margen, cuya prueba de que sirvio de algo son las cifras de
   * liquidacion de antes y de despues que van dentro.
   */
  const payloads: { type: string; payload?: Record<string, unknown> }[] = [];
  /** El TEXTO de cada evento: lo que de verdad lee el usuario en Telegram. */
  const mensajes: string[] = [];
  const store = {
    events,
    payloads,
    mensajes,
    cycleCalls,
    setStatus: jest.fn().mockResolvedValue(undefined),
    setLastError: jest.fn().mockResolvedValue(undefined),
    touchTick: jest.fn().mockResolvedValue(undefined),
    event: jest.fn(
      async (
        _bot,
        type: string,
        _severity?: string,
        _message?: string,
        payload?: Record<string, unknown>,
      ) => {
        events.push(type);
        payloads.push({ type, payload });
        mensajes.push(_message ?? '');
      },
    ),
    findOrderByCoid: jest.fn().mockResolvedValue(null),
    upsertPendingOrder: jest.fn().mockResolvedValue(undefined),
    confirmOrder: jest.fn().mockResolvedValue(undefined),
    rejectOrder: jest.fn().mockResolvedValue(undefined),
    markOrderCanceled: jest.fn().mockResolvedValue(undefined),
    markCoidsCanceled: jest.fn().mockResolvedValue(undefined),
    syncOrderState: jest.fn().mockResolvedValue(undefined),
    // `sl-1` es el stop loss. Con `keepProtective` no debe salir en la lista,
    // que es lo único que separa «pausar» de «quedarse sin red».
    liveOrderCoids: jest.fn(async (_bot: string, opts?: { keepProtective?: boolean }) =>
      opts?.keepProtective ? ['mio-1', 'mio-2'] : ['mio-1', 'mio-2', 'sl-1'],
    ),
    ownVenueClientIds: jest.fn().mockResolvedValue([]),
    saveSnapshot: jest.fn().mockResolvedValue(undefined),
    saveCycleScratch: jest.fn().mockResolvedValue(undefined),
    saveCycleAnchor: jest.fn().mockResolvedValue(undefined),
    marketSpec: jest.fn().mockResolvedValue(MARKET),
    drawdownPct: jest.fn().mockReturnValue(null),
    todayRealizedPnl: jest.fn().mockResolvedValue({ lt: () => false }),
    todayRealizedPnlForBot: jest.fn().mockResolvedValue({ toFixed: () => '0' }),
    // null = el ciclo y el venue dicen lo mismo, que es el caso de casi todo
    // test. Quien pruebe la reparación lo sobreescribe.
    repairCycleFromVenue: jest.fn().mockResolvedValue(null),
    olvidarHistorial: jest.fn(),
    riskGuards: jest.fn().mockResolvedValue({
      maxNotionalPerBot: null,
      maxDailyLoss: null,
      killSwitchDrawdownPct: null,
      liquidationAlertPct: null,
      maxLeverage: null,
      maxTotalNotional: null,
    }),
    pausadoPorRiesgo: jest.fn().mockResolvedValue(false),
    recordFill: jest.fn().mockResolvedValue(makeCoid(BOT_ID, 1, 'GRID_BUY', 0)),
    recordLiquidation: jest.fn().mockResolvedValue('liq:HYPERLIQUID:f-liq'),
    applyFillToCycle: jest.fn(async (_botId: string, cycle: CycleState) => {
      cycleCalls.push(cycleCalls.length);
      // Retraso a propósito: sin el cerrojo del runner, dos fills entrarían
      // aquí a la vez y se pisarían la actualización.
      await new Promise((r) => setTimeout(r, 20));
      return cycle;
    }),
    ...over,
  };
  return store as unknown as BotStore & typeof store;
}

const CYCLE: CycleState = {
  cycleId: 'c1',
  startedAt: Date.now(),
  entriesFilled: 0,
  lastEntryAt: null,
  filledLevelIndexes: [],
  cooldownUntil: null,
  realizedPnl: '0',
  realizedPnlAcc: '0',
  averageEntry: null,
  anchorPrice: null,
  scratch: { cycleSeq: 1 },
};

const BOT = {
  id: BOT_ID,
  user_id: 'u1',
  exchange_account_id: 'acc-1',
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  strategy: 'GRID_CLASSIC',
  direction: 'LONG',
  leverage: 1,
  margin_mode: 'ISOLATED',
  config_version: 1,
  dry_run: false,
  total_investment: '1000',
} as unknown as BotRecord;

const level = (index: number, over: Partial<DesiredOrder> = {}): DesiredOrder => ({
  clientOrderId: makeCoid(BOT_ID, 1, 'GRID_BUY', index),
  levelKind: 'GRID_BUY',
  levelIndex: index,
  side: 'BUY',
  type: 'LIMIT',
  price: '95.0',
  qty: '1.000',
  reduceOnly: false,
  ...over,
});

interface Harness {
  runner: BotRunner;
  adapter: FakeAdapter;
  store: ReturnType<typeof fakeStore>;
  detached: string[];
}

function build(
  plan: DesiredState,
  storeOver: Partial<BotStore> = {},
  configOver: Record<string, unknown> = {},
  guardsOver: Record<string, string | null> = {},
  depsOver: Partial<BotRunnerDeps> = {},
): Harness {
  const adapter = new FakeAdapter();
  const store = fakeStore(storeOver);
  const detached: string[] = [];

  const runner = new BotRunner({
    bot: BOT,
    adapter,
    market: MARKET,
    config: { leverage: 1, ...configOver } as never,
    cycle: CYCLE,
    store,
    guards: {
      maxNotionalPerBot: null,
      maxDailyLoss: null,
      killSwitchDrawdownPct: null,
      liquidationAlertPct: null,
      maxLeverage: null,
      maxTotalNotional: null,
      ...guardsOver,
    },
    // Muy largo: el latido no debe dispararse solo durante un test.
    reconcileIntervalMs: 600_000,
    onDetach: (id) => detached.push(id),
    ...depsOver,
  });

  // La estrategia se sustituye para que el test controle el plan sin depender
  // de los parámetros de ninguna estrategia concreta.
  (runner as unknown as { strategy: unknown }).strategy = {
    kind: 'GRID_CLASSIC',
    plan: () => plan,
  };

  return { runner, adapter, store, detached };
}

describe('BotRunner', () => {
  describe('cerrojo entre comandos y ticks', () => {
    /**
     * El fallo que esto cubre: `handleCommand` y `tick` no compartían cerrojo.
     * Un PANIC que entraba a mitad de tick cancelaba las órdenes y acto seguido
     * el bucle de colocación —que seguía corriendo— tendía las siguientes. Se
     * podían colocar órdenes DESPUÉS de un pánico.
     */
    it('no coloca ninguna orden después de un PANIC', async () => {
      const { runner, adapter } = build({
        orders: [level(0), level(1), level(2), level(3)],
        immediate: [],
      });
      adapter.placeDelayMs = 5;

      const arranque = runner.start();
      // El PANIC entra con el primer tick a medias.
      await new Promise((r) => setTimeout(r, 8));
      const panico = runner.handleCommand('PANIC');
      await Promise.all([arranque, panico]);

      const iCancel = adapter.calls.indexOf('cancelOwn');
      expect(iCancel).toBeGreaterThanOrEqual(0);

      const colocadasDespues = adapter.calls
        .slice(iCancel)
        .filter((c) => c.startsWith('place:') && !c.includes('.TP999'));
      expect(colocadasDespues).toHaveLength(0);

      await runner.dispose();
    });

    it('serializa las ejecuciones: nunca hay dos contabilizándose a la vez', async () => {
      let enCurso = 0;
      let maximo = 0;
      const { runner, adapter } = build(
        { orders: [], immediate: [] },
        {
          applyFillToCycle: jest.fn(async (_id: string, cycle: CycleState) => {
            enCurso++;
            maximo = Math.max(maximo, enCurso);
            await new Promise((r) => setTimeout(r, 15));
            enCurso--;
            return cycle;
          }) as never,
        },
      );

      await runner.start();

      const fill = (id: string): Fill => ({
        venue: Venue.HYPERLIQUID,
        symbol: 'BTC',
        venueFillId: id,
        venueOrderId: 'o-' + id,
        clientOrderId: makeCoid(BOT_ID, 1, 'GRID_BUY', 0),
        side: 'BUY',
        price: '95',
        qty: '1',
        fee: '0.01',
        feeAsset: 'USDC',
        isTaker: false,
        ts: Date.now(),
      });

      adapter.fills$.next(fill('f1'));
      adapter.fills$.next(fill('f2'));
      adapter.fills$.next(fill('f3'));
      await new Promise((r) => setTimeout(r, 120));

      expect(maximo).toBe(1);
      await runner.dispose();
    });
  });

  describe('cancelación acotada al bot', () => {
    /**
     * `cancelAll` tiene alcance de símbolo o de CUENTA según el venue: en
     * Lighter se lleva por delante todas las órdenes del usuario. Pausar un bot
     * borraba las de los demás bots y las que el usuario hubiera puesto a mano.
     */
    it('PAUSE cancela solo los ids propios, nunca todo el símbolo', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();

      await runner.handleCommand('PAUSE');

      expect(adapter.calls).not.toContain('cancelAll');
      expect(adapter.canceledOwn).toEqual([['mio-1', 'mio-2']]);
      expect(store.markCoidsCanceled).toHaveBeenCalledWith(BOT_ID, ['mio-1', 'mio-2']);

      await runner.dispose();
    });

    it('una guarda de riesgo tampoco arrasa el símbolo', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      // Se fuerza la guarda desde dentro: lo que se comprueba es la reacción.
      (
        runner as unknown as { deps: { guards: Record<string, string> } }
      ).deps.guards.maxNotionalPerBot = '1';
      const adapterAny = adapter;
      adapterAny.position = {
        venue: Venue.HYPERLIQUID,
        symbol: 'BTC',
        qty: '10',
        entryPrice: '100',
        markPrice: '100',
        unrealizedPnl: '0',
        leverage: 1,
        marginMode: 'ISOLATED',
        liquidationPrice: null,
        marginUsed: '0',
      };

      await runner.start();

      expect(adapter.calls).not.toContain('cancelAll');
      expect(adapter.calls).toContain('cancelOwn');

      await runner.dispose();
    });
  });

  describe('cierre a mercado', () => {
    /**
     * `lastTicker` podía ser null y el código caía a la cadena '0'. En
     * Hyperliquid una orden a mercado es una limit IOC a `precio × 1,05`, así
     * que el cierre salía a cero, el venue lo rechazaba, y el usuario se
     * quedaba creyendo que su posición estaba cerrada.
     */
    it('nunca manda un cierre a precio cero', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      adapter.position = {
        venue: Venue.HYPERLIQUID,
        symbol: 'BTC',
        qty: '1',
        entryPrice: '100',
        markPrice: '100',
        unrealizedPnl: '0',
        leverage: 1,
        marginMode: 'ISOLATED',
        liquidationPrice: null,
        marginUsed: '0',
      };
      await runner.start();

      await runner.handleCommand('CLOSE_NOW');

      // Se colocó el cierre, y para ello se pidió el precio al venue.
      expect(adapter.placed.some((c) => c.endsWith('.TP999'))).toBe(true);
      expect(adapter.calls).toContain('getTicker');

      await runner.dispose();
    });

    /**
     * Spec 001, F-22. Aster acota las órdenes A MERCADO con `MARKET_LOT_SIZE`,
     * siempre más estrecho que el de las límite (120 BTC frente a 1000): un
     * cierre mayor que ese tope lo rechazaba el venue ENTERO y el motor lo
     * trataba como un fallo de acción cualquiera.
     */
    it('una posición mayor que el tope de las órdenes a mercado se cierra en varios trozos', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      adapter.position = {
        venue: Venue.HYPERLIQUID,
        symbol: 'BTC',
        qty: '2.5',
        entryPrice: '100',
        markPrice: '100',
        unrealizedPnl: '0',
        leverage: 1,
        marginMode: 'ISOLATED',
        liquidationPrice: null,
        marginUsed: '0',
      };
      await runner.start();
      (runner as unknown as { market: MarketSpec }).market = { ...MARKET, maxMarketQty: '1' };

      await runner.handleCommand('CLOSE_NOW');

      const cierres = adapter.requests.filter((r) => r.type === 'MARKET');
      expect(cierres.map((r) => r.qty)).toEqual(['1.000', '1.000', '0.500']);
      // Cada trozo con su índice, hacia abajo desde 999: ni chocan entre sí ni
      // con la escalera.
      expect(cierres.map((r) => r.clientOrderId.split('.').pop())).toEqual([
        'TP999',
        'TP998',
        'TP997',
      ]);
      expect(cierres.every((r) => r.reduceOnly === true && r.side === 'SELL')).toBe(true);
      await runner.dispose();
    });

    it('un precio viejo no vale: se vuelve a pedir antes de cerrar', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      adapter.position = {
        venue: Venue.HYPERLIQUID,
        symbol: 'BTC',
        qty: '1',
        entryPrice: '100',
        markPrice: '100',
        unrealizedPnl: '0',
        leverage: 1,
        marginMode: 'ISOLATED',
        liquidationPrice: null,
        marginUsed: '0',
      };
      await runner.start();

      // El último precio conocido es de hace un minuto: en una limit IOC con un
      // 5 % de holgura, un precio así puede no cruzar y el cierre no ejecutarse.
      (runner as unknown as { lastTicker: Ticker }).lastTicker = {
        ...TICKER,
        ts: Date.now() - 60_000,
      };
      const antes = adapter.calls.filter((c) => c === 'getTicker').length;

      await runner.handleCommand('CLOSE_NOW');

      expect(adapter.calls.filter((c) => c === 'getTicker').length).toBeGreaterThan(antes);
      await runner.dispose();
    });

    it('si el venue no da precio, falla en vez de mandar una orden inválida', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      adapter.position = {
        venue: Venue.HYPERLIQUID,
        symbol: 'BTC',
        qty: '1',
        entryPrice: '100',
        markPrice: '100',
        unrealizedPnl: '0',
        leverage: 1,
        marginMode: 'ISOLATED',
        liquidationPrice: null,
        marginUsed: '0',
      };
      await runner.start();
      adapter.ticker = null;
      (runner as unknown as { lastTicker: Ticker | null }).lastTicker = null;

      await expect(runner.handleCommand('CLOSE_NOW')).rejects.toThrow();
      expect(store.events).not.toContain('CLOSE_SKIPPED');
      expect(adapter.placed.some((c) => c.endsWith('.TP999'))).toBe(false);

      await runner.dispose();
    });
  });

  describe('el latido que se estira (spec 031)', () => {
    /**
     * El presupuesto del venue no rechaza cuando se agota: duerme. El tick no
     * falla, el cortacircuitos no salta y el bot aparece «operando» con el
     * latido estirado. Antes eso no se veía en ninguna parte.
     */
    const avisar = (runner: BotRunner, ms: number, antes = caudalDeVenue(Venue.HYPERLIQUID)) =>
      (
        runner as unknown as {
          avisarSiElLatidoSeEstira(ms: number, antes: MuestraCaudal): Promise<void>;
        }
      ).avisarSiElLatidoSeEstira(ms, antes);

    it('avisa cuando la revisión tarda más que el intervalo, y solo una vez', async () => {
      const { runner, store } = build({ orders: [], immediate: [] });
      await runner.start();

      // El harness usa un intervalo de 600 s.
      await avisar(runner, 300_000);
      expect(store.events).not.toContain('TICK_SLOW');

      await avisar(runner, 700_000);
      await avisar(runner, 700_000);
      expect(store.events.filter((e) => e === 'TICK_SLOW')).toHaveLength(1);

      await runner.dispose();
    });

    /**
     * El aviso culpaba al cupo del venue SIEMPRE, incluso cuando el cupo no
     * tenía nada que ver: fue uno de los siete defectos del incidente del spec
     * 050. Ahora o lo demuestra con la espera medida, o no lo dice (spec 065).
     */
    it('dice cuánto de la espera fue del presupuesto, y solo si lo fue', async () => {
      const { runner, store } = build({ orders: [], immediate: [] });
      await runner.start();

      reiniciarCaudal();
      const antes = caudalDeVenue(Venue.HYPERLIQUID);
      await avisar(runner, 700_000, antes);
      expect(store.mensajes.at(-1)).toMatch(/no fue el motivo/);

      // Ahora con espera de verdad anotada en el depósito.
      const runner2 = build({ orders: [], immediate: [] });
      await runner2.runner.start();
      reiniciarCaudal();
      const base = caudalDeVenue(Venue.HYPERLIQUID);
      anotarConcesion(claveCaudal(Venue.HYPERLIQUID, false, 'read'), 51_000);
      await avisar(runner2.runner, 700_000, base);
      expect(runner2.store.mensajes.at(-1)).toMatch(
        /tus bots de HYPERLIQUID acumularon 51,0 s esperando al cupo/,
      );
      expect(runner2.store.mensajes.at(-1)).toMatch(/se cuenta por IP/);

      await runner.dispose();
      await runner2.runner.dispose();
    });
  });

  describe('salud de los streams', () => {
    /**
     * `ws.ts` emite un DOWN por cada `close` y otro por cada `error`, y el flujo
     * de salud es compartido por todos los bots de la cuenta: una caída larga
     * producía un aviso por bot y por intento de reconexión, sin enfriamiento y
     * sin decir nunca que el stream había vuelto (spec 029).
     */
    const esperar = () => new Promise((r) => setTimeout(r, 20));

    it('una caída se anuncia una vez, no en cada reintento', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();

      adapter.health$.next({ stream: 'ticker', status: 'DOWN', detail: 'socket cerrado' });
      adapter.health$.next({ stream: 'ticker', status: 'DOWN', detail: 'socket cerrado' });
      adapter.health$.next({ stream: 'ticker', status: 'DOWN', detail: 'error' });
      await esperar();

      expect(store.events.filter((e) => e === 'STREAM_ERROR')).toHaveLength(1);

      await runner.dispose();
    });

    it('avisa cuando el stream vuelve', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();

      adapter.health$.next({ stream: 'ticker', status: 'DOWN', detail: 'socket cerrado' });
      await esperar();
      adapter.health$.next({ stream: 'ticker', status: 'UP' });
      await esperar();

      expect(store.events).toContain('STREAM_RECOVERED');

      await runner.dispose();
    });

    it('no anuncia la vuelta de algo que nadie sabía roto', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();

      adapter.health$.next({ stream: 'ticker', status: 'UP' });
      await esperar();

      expect(store.events).not.toContain('STREAM_RECOVERED');

      await runner.dispose();
    });
  });

  describe('cuarentena de niveles rechazados', () => {
    /**
     * Un nivel por debajo del mínimo del venue se reintentaba en CADA tick
     * durante toda la vida del bot: un rechazo cada quince segundos, una fila
     * en `bot_events` cada quince segundos, un aviso de Telegram y caudal
     * quemado para siempre.
     */
    it('un rechazo por reglas no se reintenta con la misma forma', async () => {
      const { runner, adapter, store } = build({ orders: [level(0)], immediate: [] });
      adapter.placeError = new ExchangeError('RULES', 'min notional', Venue.HYPERLIQUID);

      await runner.start();
      const primeros = adapter.calls.filter((c) => c.startsWith('place:')).length;

      await runner.handleCommand('RESUME');
      await new Promise((r) => setTimeout(r, 30));

      const total = adapter.calls.filter((c) => c.startsWith('place:')).length;
      expect(primeros).toBe(1);
      expect(total).toBe(1);
      expect(store.events.filter((e) => e === 'ORDER_REJECTED')).toHaveLength(1);

      await runner.dispose();
    });

    /**
     * La cuarentena guardaba la forma como `lado:tipo:precio:cantidad`, y una
     * MISMA capa cambia de papel: rechazada como entrada, el bot vuelve a
     * pedirla —ya en alto riesgo— como la orden que REDUCE el inventario. Con
     * el precio y la cantidad iguales quedaba bloqueada en silencio, sin
     * evento, justo cuando era la única salida (spec 029).
     */
    it('una orden que pasa a reducir no hereda la cuarentena de su entrada', async () => {
      const { runner, adapter } = build({ orders: [level(0)], immediate: [] });
      adapter.placeError = new ExchangeError('RULES', 'min notional', Venue.HYPERLIQUID);

      await runner.start();
      expect(adapter.calls.filter((c) => c.startsWith('place:'))).toHaveLength(1);

      // Misma capa, mismo precio y misma cantidad, pero ahora REDUCE.
      (runner as unknown as { strategy: { plan: () => DesiredState } }).strategy.plan = () => ({
        orders: [level(0, { reduceOnly: true })],
        immediate: [],
      });
      await runner.handleCommand('RESUME');
      await new Promise((r) => setTimeout(r, 30));

      expect(adapter.calls.filter((c) => c.startsWith('place:')).length).toBeGreaterThan(1);

      await runner.dispose();
    });

    /**
     * `placeFailures` sólo cuenta los fallos pasajeros, así que un bot al que
     * el venue le rechaza TODO por reglas no disparaba ningún cortacircuitos:
     * se quedaba sin órdenes en el libro y lo único visible era un WARN por
     * rechazo, indistinguible del rechazo corriente (spec 029).
     */
    it('muchos rechazos por reglas seguidos avisan en CRITICAL', async () => {
      const niveles = Array.from({ length: 21 }, (_, i) => level(i, { price: `9${i % 10}.5` }));
      const { runner, store, adapter } = build({ orders: niveles, immediate: [] });
      adapter.placeError = new ExchangeError('RULES', 'min notional', Venue.HYPERLIQUID);

      await runner.start();

      expect(store.events.filter((e) => e === 'ORDER_REJECTED').length).toBeGreaterThan(20);
      // El tipo de `event` en el store falso pierde la firma de jest al salir
      // del objeto; el cast es de test y no cruza ninguna frontera de dominio.
      const llamadas = (store.event as unknown as jest.Mock).mock.calls as unknown[][];
      const criticos = llamadas.filter((c) => c[2] === 'CRITICAL');
      expect(criticos).toHaveLength(1);
      expect(String(criticos[0][3])).toMatch(/no está consiguiendo colocar/);

      await runner.dispose();
    });

    it('un nivel que no cumple las reglas del mercado ni se manda', async () => {
      // 0.001 × 95 = 0,095, muy por debajo del mínimo de 10 del mercado.
      const { runner, adapter, store } = build({
        orders: [level(0, { qty: '0.001' })],
        immediate: [],
      });

      await runner.start();

      expect(adapter.calls.filter((c) => c.startsWith('place:'))).toHaveLength(0);
      expect(store.events).toContain('ORDER_UNVIABLE');

      await runner.dispose();
    });
  });

  describe('un rechazo de una orden no puede tumbar el bot', () => {
    /**
     * El fallo que pausó un bot de verdad: Lighter rechazó un take profit con
     * «invalid order base or quote amount», el clasificador no conocía esas
     * palabras y lo dio por FATAL, y `place()` relanzaba todo lo que no fuera
     * RULES. El tick moría, la escalera no llegaba a tenderse, y a los cinco
     * saltaba el cortacircuitos.
     */
    it('un rechazo desconocido se contiene: el resto de la escalera se coloca', async () => {
      const { runner, adapter, store } = build({
        orders: [level(0), level(1), level(2)],
        immediate: [],
      });
      // Solo el primero falla, y con un `kind` que el clasificador no conoce.
      adapter.placeErrorOnce = new ExchangeError(
        'FATAL',
        'invalid order base or quote amount',
        Venue.HYPERLIQUID,
      );

      await runner.start();

      // LOS TRES se intentan y los dos últimos salen. Antes, el `throw` del
      // primero abortaba el bucle y no se intentaba ni uno más.
      expect(adapter.calls.filter((c) => c.startsWith('place:'))).toHaveLength(3);
      expect(adapter.placed).toHaveLength(2);
      expect(store.events).toContain('ORDER_REJECTED');
      // Y el bot sigue vivo: ni un tick fallido, ni guarda disparada.
      expect(store.events).not.toContain('TICK_ERROR');
      expect(store.events).not.toContain('RISK_GUARD_TRIPPED');

      await runner.dispose();
    });

    it('una credencial muerta SÍ relanza: ahí hay que parar', async () => {
      const { runner, adapter, store } = build({ orders: [level(0)], immediate: [] });
      adapter.placeError = new ExchangeError('AUTH', 'clave revocada', Venue.HYPERLIQUID);

      await runner.start();

      // Contenerla sería dejar al bot dando vueltas con una clave inservible.
      expect(store.events).toContain('AUTH_ERROR');

      await runner.dispose();
    });
  });

  describe('un comando que el worker no conoce (spec 057, F-08)', () => {
    /**
     * `runCommand` no tenía rama por defecto: un comando nuevo que llegaba a un
     * worker sin desplegar no hacía nada, la bandeja lo cerraba como ejecutado
     * y la API creía que se había hecho.
     */
    it('falla con su nombre en vez de darse por hecho', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      await runner.start();
      const antes = adapter.calls.length;

      await expect(runner.handleCommand('COMANDO_DEL_FUTURO' as never)).rejects.toThrow(
        /COMANDO_DEL_FUTURO/,
      );
      // Y sin tocar nada por el camino.
      expect(adapter.calls.slice(antes)).toEqual([]);
      await runner.dispose();
    });
  });

  describe('desenganche', () => {
    it('una credencial inválida pide que el motor lo suelte', async () => {
      const { runner, adapter, detached } = build({ orders: [], immediate: [] });
      await runner.start();

      jest
        .spyOn(adapter, 'getTicker')
        .mockRejectedValue(new ExchangeError('AUTH', 'clave revocada', Venue.HYPERLIQUID));

      // RESUME pide un tick; el tick se topa con la credencial revocada.
      await runner.handleCommand('RESUME');
      await new Promise((r) => setTimeout(r, 60));

      expect(detached).toContain(BOT_ID);
      await runner.dispose();
    });

    it('una parada definitiva también', async () => {
      const { runner, detached } = build({ orders: [], immediate: [] });
      await runner.start();

      await runner.handleCommand('STOP_KEEP_POSITION');

      expect(detached).toContain(BOT_ID);
      await runner.dispose();
    });
  });
});

describe('bot pausado', () => {
  const conPosicion = (): Position => ({
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    qty: '10',
    entryPrice: '100',
    markPrice: '100',
    unrealizedPnl: '0',
    leverage: 1,
    marginMode: 'ISOLATED',
    liquidationPrice: '99',
    marginUsed: '0',
  });

  /**
   * Un bot pausado conserva su posición abierta, y pausar es justo lo que hace
   * el usuario cuando algo va mal. Si se le quitara el runner, se quedaría sin
   * el aviso de liquidación precisamente cuando importa — y un RESUME no
   * tendría a quién llegar.
   */
  it('sigue vigilando la liquidación pero no coloca nada', async () => {
    const adapter = new FakeAdapter();
    adapter.position = conPosicion();
    const store = fakeStore();

    const runner = new BotRunner({
      bot: BOT,
      adapter,
      market: MARKET,
      config: { leverage: 1 } as never,
      cycle: CYCLE,
      store,
      guards: {
        maxNotionalPerBot: null,
        maxDailyLoss: null,
        killSwitchDrawdownPct: null,
        // La liquidación está a un 1 %: por debajo del umbral del 5 %.
        liquidationAlertPct: '5',
        maxLeverage: null,
        maxTotalNotional: null,
      },
      reconcileIntervalMs: 600_000,
      startPaused: true,
      onDetach: () => undefined,
    });
    (runner as unknown as { strategy: unknown }).strategy = {
      kind: 'GRID_CLASSIC',
      plan: () => ({ orders: [level(0)], immediate: [] }),
    };

    await runner.start();

    expect(store.events).toContain('LIQUIDATION_NEAR');
    expect(store.events).toContain('BOT_ADOPTED');
    expect(store.events).not.toContain('BOT_STARTED');
    expect(adapter.calls.filter((c) => c.startsWith('place:'))).toHaveLength(0);

    await runner.dispose();
  });

  it('el aviso de liquidación no se repite en cada latido', async () => {
    const adapter = new FakeAdapter();
    adapter.position = conPosicion();
    const store = fakeStore();

    const runner = new BotRunner({
      bot: BOT,
      adapter,
      market: MARKET,
      config: { leverage: 1 } as never,
      cycle: CYCLE,
      store,
      guards: {
        maxNotionalPerBot: null,
        maxDailyLoss: null,
        killSwitchDrawdownPct: null,
        liquidationAlertPct: '5',
        maxLeverage: null,
        maxTotalNotional: null,
      },
      reconcileIntervalMs: 600_000,
      startPaused: true,
      onDetach: () => undefined,
    });
    (runner as unknown as { strategy: unknown }).strategy = {
      kind: 'GRID_CLASSIC',
      plan: () => ({ orders: [], immediate: [] }),
    };

    await runner.start();
    // Tres latidos más: una posición puede quedarse cerca de la liquidación
    // durante horas, y repetir el aviso cada quince segundos entrena al usuario
    // a silenciar el canal.
    for (let i = 0; i < 3; i++) {
      await (runner as unknown as { tick(): Promise<void> }).tick();
    }

    expect(store.events.filter((e) => e === 'LIQUIDATION_NEAR')).toHaveLength(1);
    await runner.dispose();
  });

  /**
   * Spec 060, F-15. La caída máxima del canal se mide desde la última
   * reanudación, así que el historial en caché no puede sobrevivir al RESUME: el
   * primer tick habría vuelto a pausar con el máximo de antes.
   */
  it('reanudar olvida el historial en caché', async () => {
    const { runner, store } = build({ orders: [], immediate: [] });

    await runner.start();
    await runner.handleCommand('RESUME');
    await runner.dispose();

    expect(store.olvidarHistorial).toHaveBeenCalledWith(BOT_ID);
  });
});

describe('reutilización de ids por estrategia', () => {
  /**
   * Un market maker o una retícula reutilizan el mismo id en colocaciones
   * sucesivas. La fila EJECUTADA de la colocación anterior vetaba la nueva:
   * cada cotización moría tras su primera ejecución completa y no volvía hasta
   * que la posición pasara por cero.
   */
  it('con reusesOrderSlots, una fila FILLED no veta la recolocación', async () => {
    const { runner, adapter, store } = build(
      { orders: [level(0)], immediate: [] },
      {
        findOrderByCoid: jest.fn().mockResolvedValue({ status: 'FILLED' }) as never,
      },
    );
    (runner as unknown as { strategy: { reusesOrderSlots?: boolean } }).strategy.reusesOrderSlots =
      true;

    await runner.start();

    expect(adapter.placed).toContain(makeCoid(BOT_ID, 1, 'GRID_BUY', 0));
    expect(store.upsertPendingOrder).toHaveBeenCalled();
    await runner.dispose();
  });

  it('sin la declaración, la fila FILLED sigue vetando', async () => {
    const { runner, adapter } = build(
      { orders: [level(0)], immediate: [] },
      {
        findOrderByCoid: jest.fn().mockResolvedValue({ status: 'FILLED' }) as never,
      },
    );

    await runner.start();

    expect(adapter.placed).toHaveLength(0);
    await runner.dispose();
  });

  /**
   * Las INMEDIATAS nunca recolocan un id ejecutado, declare lo que declare la
   * estrategia: son entradas a mercado cuyo fill puede no estar asimilado aún,
   * y repetirlas es duplicar posición con dinero real.
   */
  it('una inmediata con fila FILLED no se reenvía jamás', async () => {
    const { runner, adapter } = build(
      { orders: [], immediate: [level(0, { type: 'MARKET' })] },
      {
        findOrderByCoid: jest.fn().mockResolvedValue({ status: 'FILLED' }) as never,
      },
    );
    (runner as unknown as { strategy: { reusesOrderSlots?: boolean } }).strategy.reusesOrderSlots =
      true;

    await runner.start();

    expect(adapter.placed).toHaveLength(0);
    await runner.dispose();
  });

  // ═══════════════════════════════════════════════════════════════
  // Red de seguridad
  // ═══════════════════════════════════════════════════════════════

  const conPos = (qty = '10'): Position => ({
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    qty,
    entryPrice: '100',
    markPrice: '100',
    unrealizedPnl: '0',
    leverage: 1,
    marginMode: 'ISOLATED',
    liquidationPrice: '99',
    marginUsed: '0',
  });

  describe('recentrar solo aplica a las escaleras', () => {
    /**
     * Spec 001, F-84. «Recentrar la reticula» corria igual en TODAS las
     * estrategias. En la rejilla clasica las lineas salen del rango, asi que lo
     * unico que hacia era borrar la memoria de los niveles comprados: el bot
     * volvia a tender la compra de cada nivel que ya tenia y retiraba su venta.
     * Segunda compra por nivel y sin salida, con el usuario creyendo que solo
     * habia «recentrado».
     */
    it('REANCHOR_GRID en Grid Classic con inventario se rechaza y conserva la venta', async () => {
      const venta = level(1, {
        clientOrderId: makeCoid(BOT_ID, 1, 'GRID_SELL', 1),
        levelKind: 'GRID_SELL',
        side: 'SELL',
        price: '105.0',
        reduceOnly: true,
      });
      const { runner, adapter, store } = build({ orders: [venta], immediate: [] });
      adapter.position = conPos();
      await runner.start();
      const cancelacionesAntes = adapter.canceledOwn.length;
      await runner.handleCommand('REANCHOR_GRID');
      await runner.dispose();

      expect(store.saveCycleAnchor).not.toHaveBeenCalled();
      expect(store.events).toContain('ACTION_FAILED');
      expect(store.events).not.toContain('GRID_REANCHORED');
      // Nada se cancela: la venta del nivel comprado sigue en el libro.
      expect(adapter.canceledOwn.length).toBe(cancelacionesAntes);
    });

    /**
     * En la rejilla neutral el centro real es «Precio ancla», un campo de la
     * configuracion que el comando no tocaba: cancelaba, anunciaba «recentrada»
     * y las lineas volvian exactamente al mismo sitio.
     */
    it('REANCHOR_GRID en la rejilla neutral se rechaza y remite a Precio ancla', async () => {
      const eventos: { type: string; message: string }[] = [];
      const { runner, store } = build(
        { orders: [], immediate: [] },
        {
          event: jest.fn(async (_bot: unknown, type: string, _sev: string, message: string) => {
            eventos.push({ type, message });
          }) as never,
        },
      );
      (runner as unknown as { strategy: { kind: string } }).strategy.kind = 'NEUTRAL_GRID';
      await runner.start();
      await runner.handleCommand('REANCHOR_GRID');
      await runner.dispose();

      expect(store.saveCycleAnchor).not.toHaveBeenCalled();
      const rechazo = eventos.find((e) => e.type === 'ACTION_FAILED');
      expect(rechazo?.message).toContain('Precio ancla');
      expect(eventos.some((e) => e.type === 'GRID_REANCHORED')).toBe(false);
    });

    /**
     * Spec 057, F-11. La tabla no incluía Tendencia ni Seguimiento de beneficio.
     * La API ya lo impide, pero si el comando llegaba al motor, este anunciaba
     * «retícula recentrada» y borraba los niveles del ciclo.
     */
    it.each(['TREND_FOLLOW', 'TRAILING_PROFIT'])(
      'REANCHOR_GRID en %s se rechaza con su motivo',
      async (kind) => {
        const { runner, store } = build({ orders: [], immediate: [] });
        (runner as unknown as { strategy: { kind: string } }).strategy.kind = kind;
        await runner.start();
        await runner.handleCommand('REANCHOR_GRID');
        await runner.dispose();

        expect(store.saveCycleAnchor).not.toHaveBeenCalled();
        expect(store.events).toContain('ACTION_FAILED');
        expect(store.events).not.toContain('GRID_REANCHORED');
      },
    );

    /**
     * En una escalera si aplica: se vuelve a colgar todo del precio actual. Lo
     * que cambia es que el aviso dice cuanto margen nuevo se compromete, porque
     * la escalera entera se retiende con la posicion anterior aun abierta y esa
     * cifra no la enseño ninguna vista previa.
     */
    it('REANCHOR_GRID en una martingala recentra y anota el margen que compromete', async () => {
      const eventos: { type: string; message: string }[] = [];
      const { runner, adapter, store } = build(
        { orders: [], immediate: [] },
        {
          event: jest.fn(async (_bot: unknown, type: string, _sev: string, message: string) => {
            eventos.push({ type, message });
          }) as never,
        },
        { totalInvestment: '70' },
      );
      (runner as unknown as { strategy: { kind: string } }).strategy.kind = 'MARTINGALE';
      adapter.position = conPos();
      await runner.start();
      await runner.handleCommand('REANCHOR_GRID');
      await runner.dispose();

      expect(store.saveCycleAnchor).toHaveBeenCalledWith(BOT_ID, '100', []);
      const aviso = eventos.find((e) => e.type === 'GRID_REANCHORED');
      expect(aviso?.message).toContain('70 USDC');
      expect(aviso?.message).toContain('10 BTC');
    });
  });

  describe('adelantar una seguridad dice lo que paso', () => {
    const seguridad = level(1, {
      clientOrderId: makeCoid(BOT_ID, 1, 'SAFETY', 1),
      levelKind: 'SAFETY',
      type: 'POST_ONLY',
      price: '95.0',
    });
    const martingala = (storeOver: Partial<BotStore> = {}) => {
      const h = build({ orders: [seguridad], immediate: [] }, storeOver);
      (h.runner as unknown as { strategy: { kind: string } }).strategy.kind = 'MARTINGALE';
      h.adapter.position = conPos();
      return h;
    };

    /**
     * Spec 001, F-85. La seguridad manual salia a mercado con el precio del
     * escalon (95 con el mark en 100): en Hyperliquid una orden a mercado a mas
     * de ~5 % del mark se rechaza, y el usuario recibia igualmente «ejecutada
     * a mercado». Ahora se manda al precio de marca —la holgura la pone el
     * adaptador— y se anuncia lo que dijo el acuse.
     */
    it('ADD_SAFETY_NOW sale a mercado al precio de marca, no al del escalon', async () => {
      const { runner, adapter, store } = martingala();
      await runner.start();
      adapter.requests.length = 0;
      await runner.handleCommand('ADD_SAFETY_NOW');
      await runner.dispose();

      const manual = adapter.requests.find((r) => r.clientOrderId === seguridad.clientOrderId);
      expect(manual?.type).toBe('MARKET');
      expect(manual?.price).toBe(TICKER.mark);
      expect(store.events).toContain('SAFETY_ADDED');
    });

    it('ADD_SAFETY_NOW sin acuse no anuncia SAFETY_ADDED', async () => {
      const { runner, adapter, store } = martingala();
      await runner.start();
      adapter.placeError = new ExchangeError('RULES', 'rechazada por el venue', Venue.HYPERLIQUID);
      await runner.handleCommand('ADD_SAFETY_NOW');
      await runner.dispose();

      expect(store.events).not.toContain('SAFETY_ADDED');
      expect(store.events).toContain('ADD_SAFETY_SKIPPED');
    });
  });

  describe('la espera entre ciclos se lee de la configuracion vigente', () => {
    /**
     * Spec 001, F-86. `cooldownMinutes` se copiaba al scratch de la PRIMERA fila
     * de ciclo y de ahi lo leia la contabilidad para siempre: un cambio HOT del
     * campo se anunciaba como «configuracion recargada» y nunca surtia efecto.
     * El backtest, que lo lee de la config, si lo aplicaba: paridad rota.
     */
    it('reloadConfig HOT de cooldownMinutes se aplica al cerrar el ciclo', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      await runner.reloadConfig({ leverage: 1, cooldownMinutes: 30 } as never, 'HOT');

      adapter.fills$.next({
        venue: Venue.HYPERLIQUID,
        symbol: 'BTC',
        venueFillId: 'f-cooldown',
        venueOrderId: 'v-1',
        clientOrderId: makeCoid(BOT_ID, 1, 'GRID_BUY', 0),
        side: 'BUY',
        price: '100',
        qty: '1',
        fee: '0',
        feeAsset: 'USDC',
        isTaker: false,
        ts: Date.now(),
      });
      // El fill entra bajo el cerrojo y la contabilidad falsa tarda 20 ms.
      for (let i = 0; i < 100 && store.cycleCalls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await runner.dispose();

      expect(store.applyFillToCycle).toHaveBeenCalledWith(
        BOT_ID,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cooldownMinutes: 30 }),
      );
    });
  });

  describe('modo de posicion en Aster', () => {
    /**
     * Spec 001, F-71. El veto de `validate()` protege lo que se crea a partir
     * de ahora; esto protege a un bot que ya tuviera cobertura guardada. En
     * Aster el cambio de modo es de TODA la cuenta y rompe a todos sus bots.
     */
    it('un bot de Aster con cobertura guardada no cambia el modo de la cuenta', async () => {
      const eventos: { type: string; message: string }[] = [];
      const { runner, adapter } = build(
        { orders: [], immediate: [] },
        {
          event: jest.fn(async (_bot: unknown, type: string, _sev: string, message: string) => {
            eventos.push({ type, message });
          }) as never,
        },
        { positionMode: 'HEDGE' },
      );
      const setPositionMode = jest.fn().mockResolvedValue(undefined);
      (adapter as unknown as { setPositionMode: unknown }).setPositionMode = setPositionMode;
      // Sin tocar la constante BOT, que comparten todos los tests.
      const r = runner as unknown as { deps: { bot: Record<string, unknown> } };
      r.deps = { ...r.deps, bot: { ...r.deps.bot, venue: 'ASTER' } };
      await runner.start();
      await runner.dispose();

      expect(setPositionMode).not.toHaveBeenCalled();
      const aviso = eventos.find((e) => e.type === 'POSITION_MODE_SKIPPED');
      expect(aviso?.message).toMatch(/cobertura/i);
    });
  });

  describe('lo que safely() no puede tragarse (spec 001, F-06)', () => {
    /**
     * `safely()` convertía TODO en un ACTION_FAILED de nivel WARN, también una
     * credencial revocada o un castigo del venue en pleno reemplazo. El bot
     * seguía «vivo» con el lease renovándose; un market maker que solo
     * reemplaza no pasaba nunca por `toPlace`, que sí relanzaba.
     */
    it.each(['AUTH', 'THROTTLED'] as const)(
      'relanza %s en vez de convertirlo en un aviso',
      async (kind) => {
        const { runner, store } = build({ orders: [], immediate: [] });
        const safely = (
          runner as unknown as {
            safely(accion: string, ref: string, fn: () => Promise<void>): Promise<void>;
          }
        ).safely.bind(runner);

        await expect(
          safely('reemplazar', 'x', async () => {
            throw new ExchangeError(kind, 'venue', Venue.HYPERLIQUID);
          }),
        ).rejects.toThrow();
        await runner.dispose();

        expect(store.events).not.toContain('ACTION_FAILED');
      },
    );

    it('un AUTH durante un reemplazo para el bot en ese mismo tick', async () => {
      const coid = makeCoid(BOT_ID, 1, 'GRID_BUY', 0);
      const enVenue = hyperliquidCodec.encode(coid);
      const { runner, adapter, store, detached } = build(
        { orders: [level(0)], immediate: [] },
        { ownVenueClientIds: jest.fn().mockResolvedValue([enVenue]) },
      );
      // La orden está en el libro a otro precio: el plan la reemplaza.
      adapter.getOpenOrders = async () => [
        {
          venue: Venue.HYPERLIQUID,
          symbol: 'BTC',
          clientOrderId: enVenue,
          venueOrderId: 'v1',
          side: 'BUY',
          type: 'LIMIT',
          price: '90.0',
          qty: '1.000',
          filledQty: '0',
          avgPrice: null,
          status: 'OPEN',
          reduceOnly: false,
          createdAt: Date.now(),
        },
      ];
      adapter.placeError = new ExchangeError('AUTH', 'clave revocada', Venue.HYPERLIQUID);

      await runner.start();

      expect(store.events).toContain('AUTH_ERROR');
      expect(detached).toContain(BOT_ID);
      await runner.dispose();
    });
  });

  describe('promesas sueltas con acceso a la base (spec 001, F-07)', () => {
    /**
     * `acquireFairPrice` avisaba con `void this.event(...)` y `store.event`
     * escribe en la base: si la base rechazaba, la promesa quedaba sin manejar
     * y `main.ts` sale del proceso con todos los bots.
     */
    it('un fallo al registrar el aviso de la fuente de precio no queda sin manejar', async () => {
      const sueltas: unknown[] = [];
      const captura = (r: unknown): void => {
        sueltas.push(r);
      };
      process.on('unhandledRejection', captura);
      const { runner } = build(
        { orders: [], immediate: [] },
        {
          event: jest.fn(async (_bot: unknown, type: string) => {
            if (type === 'FAIR_PRICE_UNAVAILABLE') throw new Error('base caída');
          }),
        },
        { priceSource: 'COINGECKO' },
      );

      await runner.start();
      await new Promise((r) => setTimeout(r, 30));
      process.off('unhandledRejection', captura);
      await runner.dispose();

      expect(sueltas).toEqual([]);
    });
  });

  describe('cancelar lo que ya no existe es un no-op en los tres venues', () => {
    /**
     * Spec 001, F-51. La regex de `safely()` conocia «not found», «unknown
     * order» y «does not exist», pero no el vocabulario de Lighter (21600,
     * 21715, 21709, 21708, 21707): cada carrera lectura→cancelacion producia un
     * ACTION_FAILED en WARN y, en un reemplazo, saltaba la recolocacion.
     */
    it.each([
      'given order is not an active limit order',
      'given order is not an active order',
      'order is inactive',
      'order is empty',
      'account is not owner of the order',
    ])('«%s» no genera ningun aviso', async (mensaje) => {
      const { runner, store } = build({ orders: [], immediate: [] });
      const safely = (
        runner as unknown as {
          safely(accion: string, ref: string, fn: () => Promise<void>): Promise<void>;
        }
      ).safely.bind(runner);

      await safely('cancelar', 'x', async () => {
        throw new ExchangeError('FATAL', mensaje, Venue.LIGHTER);
      });
      await runner.dispose();

      expect(store.events).not.toContain('ACTION_FAILED');
    });
  });

  describe('el stop loss sobrevive a lo que no cierra la posicion', () => {
    /**
     * El fallo que esto cubre: `cancelOwnOrders` barria TODO lo vivo, stop loss
     * incluido. Las tres rutas que conservan la posicion —pausar, parar sin
     * cerrar y la guarda de riesgo— la dejaban apalancada y sin red; la de la
     * guarda, ademas, dejaba de mirarla.
     */
    it('PAUSE cancela la escalera y respeta el stop', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      await runner.start();
      await runner.handleCommand('PAUSE');

      expect(adapter.canceledOwn.at(-1)).toEqual(['mio-1', 'mio-2']);
      await runner.dispose();
    });

    it('STOP_KEEP_POSITION tambien lo respeta', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      await runner.start();
      await runner.handleCommand('STOP_KEEP_POSITION');

      expect(adapter.canceledOwn.at(-1)).not.toContain('sl-1');
      await runner.dispose();
    });

    /**
     * Aqui si se cierra la posicion, asi que el stop debe irse con ella — pero
     * DESPUES del cierre, no antes (001/F-33). Mientras el cierre no este
     * mandado, el stop es la unica red que le queda a la posicion; cancelarlo
     * primero abria una ventana en la que un fallo del cierre dejaba la
     * posicion desnuda con el bot diciendo «cerrada».
     */
    it('STOP_AND_CLOSE cancela el stop solo despues de cerrar', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      adapter.position = conPos();
      await runner.start();
      await runner.handleCommand('STOP_AND_CLOSE');

      expect(adapter.canceledOwn.at(-1)).toContain('sl-1');
      const cierre = adapter.calls.findIndex((c) => c.startsWith('place:') && c.includes('TP'));
      const ultimaCancelacion = adapter.calls.lastIndexOf('cancelOwn');
      expect(cierre).toBeGreaterThan(-1);
      expect(ultimaCancelacion).toBeGreaterThan(cierre);
      await runner.dispose();
    });

    /**
     * Spec 001, F-33. Antes: cancelar TODO (stop incluido) → mandar el cierre →
     * STOPPED → «Bot parado y posicion cerrada a mercado», sin mirar si el
     * cierre habia salido. Con el venue rechazando el cierre, el usuario
     * pulsaba el boton rojo y se quedaba con la posicion abierta, sin stop y
     * con un evento que decia lo contrario.
     */
    it('STOP_AND_CLOSE que no consigue cerrar no dice que ha cerrado', async () => {
      const eventos: { type: string; severity: string; message: string }[] = [];
      const { runner, adapter, store } = build(
        { orders: [], immediate: [] },
        {
          event: jest.fn(async (_bot: unknown, type: string, severity: string, message: string) => {
            eventos.push({ type, severity, message });
          }) as never,
        },
      );
      adapter.position = conPos();
      adapter.placeError = new ExchangeError('RULES', 'rechazada por el venue', Venue.HYPERLIQUID);
      await runner.start();
      await runner.handleCommand('STOP_AND_CLOSE');

      // El stop sigue en el libro: ninguna cancelacion se lo ha llevado.
      expect(adapter.canceledOwn.flat()).not.toContain('sl-1');
      // Nadie afirma un cierre que no ocurrio, y el usuario se entera en CRITICAL.
      expect(eventos.some((e) => e.message.includes('cerrada a mercado'))).toBe(false);
      expect(eventos.some((e) => e.severity === 'CRITICAL')).toBe(true);
      // Y el bot no pasa a parado: se queda pausado, vigilando la posicion.
      expect(store.setStatus).not.toHaveBeenCalledWith(BOT_ID, 'STOPPED');
      expect(store.setStatus).toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
      await runner.dispose();
    });

    it('la guarda de riesgo pausa sin desarmar el stop', async () => {
      const { runner, adapter, store } = build(
        { orders: [], immediate: [] },
        {},
        {},
        { maxNotionalPerBot: '100' },
      );
      adapter.position = conPos(); // 10 x 100 = 1000, muy por encima de 100.
      await runner.start();

      expect(store.events).toContain('RISK_GUARD_TRIPPED');
      expect(adapter.canceledOwn.at(-1)).not.toContain('sl-1');
      await runner.dispose();
    });
  });

  describe('el motor coloca el stop loss por su cuenta', () => {
    /**
     * `stopLossPct` lo inyecta `COMMON_FIELDS` en TODAS las estrategias, y
     * cuando esto se escribio solo martingale y tdca lo leian: en las otras
     * cinco -eran siete entonces- el campo salia en el formulario y no colocaba
     * nada. Ahora lo emite el motor, asi que da igual
     * que estrategia sea — este test usa una que no lo pide.
     */
    it('lo anade aunque la estrategia no lo pida', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] }, {}, { stopLossPct: '10' });
      adapter.position = conPos();
      await runner.start();

      expect(adapter.placed.filter((c) => c.includes('SL'))).toHaveLength(1);
      await runner.dispose();
    });

    /**
     * La direccion sale del SIGNO de la posicion, no de `cfg.direction`: un
     * market maker cambia de lado solo, y un stop calculado sobre la direccion
     * nominal saldria del lado contrario — es decir, no protegeria de nada.
     */
    it('en corto lo pone por encima de la entrada, no por debajo', async () => {
      const capturado: PlaceOrderRequest[] = [];
      const { runner, adapter } = build({ orders: [], immediate: [] }, {}, { stopLossPct: '10' });
      adapter.position = conPos('-10');
      const original = adapter.placeOrder.bind(adapter);
      adapter.placeOrder = async (req: PlaceOrderRequest) => {
        capturado.push(req);
        return original(req);
      };

      await runner.start();

      const sl = capturado.find((r) => r.clientOrderId.includes('SL'))!;
      expect(sl.price).toBe('110.0');
      expect(sl.side).toBe('BUY');
      expect(sl.reduceOnly).toBe(true);
      await runner.dispose();
    });

    it('sin posicion no coloca ninguno', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] }, {}, { stopLossPct: '10' });
      await runner.start();

      expect(adapter.placed.filter((c) => c.includes('SL'))).toHaveLength(0);
      await runner.dispose();
    });
  });

  describe('el stop vivo no se recoloca en cada tick (spec 057, F-01)', () => {
    /**
     * Hyperliquid coloca el stop a mercado con un límite un 5 % más allá del
     * disparo y lo informa así: `price` es ese límite y el disparo va aparte.
     * El motor comparaba `price` con el del stop deseado, lo daba por cambiado
     * y lo cancelaba y recolocaba en cada tick: dos escrituras por bot en cada
     * latido y la posición sin red entre la cancelación y el envío.
     */
    it('diez ticks con el stop en el libro: ni una cancelación ni un segundo envío', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] }, {}, { stopLossPct: '10' });
      adapter.position = conPos();
      const libro: VenueOrder[] = [];
      const colocar = adapter.placeOrder.bind(adapter);
      adapter.placeOrder = async (req: PlaceOrderRequest) => {
        const ack = await colocar(req);
        libro.push({
          venue: Venue.HYPERLIQUID,
          symbol: req.symbol,
          clientOrderId: hyperliquidCodec.encode(req.clientOrderId),
          venueOrderId: ack.venueOrderId,
          side: req.side,
          type: req.type,
          // Como lo informa Hyperliquid: el límite de ejecución, no el disparo.
          price: req.triggerPrice
            ? D(req.triggerPrice)
                .mul(req.side === 'SELL' ? '0.95' : '1.05')
                .toFixed(1)
            : (req.price ?? '0'),
          triggerPrice: req.triggerPrice ?? null,
          qty: req.qty,
          filledQty: '0',
          avgPrice: null,
          status: 'OPEN',
          reduceOnly: req.reduceOnly === true,
          createdAt: Date.now(),
        });
        return ack;
      };
      const cancelar = adapter.cancelOrder.bind(adapter);
      adapter.cancelOrder = async (req: CancelRequest) => {
        await cancelar(req);
        const i = libro.findIndex((o) => o.venueOrderId === req.venueOrderId);
        if (i >= 0) libro.splice(i, 1);
      };
      adapter.getOpenOrders = async () => libro;

      await runner.start();
      const tick = (runner as unknown as { tick(): Promise<void> }).tick.bind(runner);
      for (let i = 0; i < 9; i++) await tick();
      await runner.dispose();

      expect(adapter.calls.filter((c) => c === 'cancelOrder')).toHaveLength(0);
      expect(adapter.placed.filter((c) => c.includes('SL'))).toHaveLength(1);
      expect(libro).toHaveLength(1);
      expect(libro[0].price).toBe('85.5');
    });
  });

  describe('con posición, un plan sin stop no desarma el stop propio (spec 057, F-02)', () => {
    /**
     * Tendencia pone su propio stop. Un plan que no lo traía —sin velas tras un
     * reinicio— hacía que el motor cancelara el que había en el libro. La
     * estrategia ya no lo suelta, y el motor tampoco lo cancela si otra vez
     * falta: con la posición abierta, ese stop es lo único que la protege.
     */
    const SL = makeCoid(BOT_ID, 1, 'STOP_LOSS', 0);
    const stopVivo = (): VenueOrder => ({
      venue: Venue.HYPERLIQUID,
      symbol: 'BTC',
      clientOrderId: hyperliquidCodec.encode(SL),
      venueOrderId: 'v-sl',
      side: 'SELL',
      type: 'MARKET',
      price: '85.5',
      triggerPrice: '90.0',
      qty: '10.000',
      filledQty: '0',
      avgPrice: null,
      status: 'OPEN',
      reduceOnly: true,
      createdAt: Date.now(),
    });
    const montar = (stopPropio: boolean) => {
      const h = build(
        { orders: [], immediate: [] },
        {
          ownVenueClientIds: jest.fn().mockResolvedValue([hyperliquidCodec.encode(SL)]) as never,
        },
      );
      (h.runner as unknown as { strategy: { stopPropio?: boolean } }).strategy.stopPropio =
        stopPropio;
      h.adapter.position = conPos();
      h.adapter.getOpenOrders = async () => [stopVivo()];
      return h;
    };
    const tickDe = (runner: BotRunner) =>
      (runner as unknown as { tick(): Promise<void> }).tick.call(runner);

    it('una estrategia con stop propio conserva el que hay, y lo avisa una sola vez', async () => {
      const { runner, adapter, store } = montar(true);
      await runner.start();
      await tickDe(runner);
      await tickDe(runner);
      await runner.dispose();

      expect(adapter.calls).not.toContain('cancelOrder');
      expect(store.events.filter((e) => e === 'ACTION_FAILED')).toHaveLength(1);
    });

    it('sin esa declaración, el stop que el plan ya no pide se cancela, como siempre', async () => {
      // Es el usuario quitando `stopLossPct`: ya no quiere stop, y se retira.
      const { runner, adapter, store } = montar(false);
      await runner.start();
      await runner.dispose();

      expect(adapter.calls).toContain('cancelOrder');
      expect(store.events).not.toContain('ACTION_FAILED');
    });

    it('sin posición, el stop sobrante se cancela aunque sea propio', async () => {
      const { runner, adapter } = montar(true);
      adapter.position = null;
      await runner.start();
      await runner.dispose();

      expect(adapter.calls).toContain('cancelOrder');
    });
  });

  describe('un stop loss rechazado no se abandona en cuarentena', () => {
    /**
     * Spec 001, F-32. El stop loss pasa por las mismas puertas que un nivel de
     * escalera: si el venue lo rechaza por reglas, su id entra en cuarentena por
     * FORMA y, como precio y cantidad salen de la posicion, la forma no cambia
     * hasta que cambie la posicion. Resultado: posicion apalancada sin red, con
     * un solo WARN en la bitacora y sin un segundo intento. Un nivel de
     * escalera puede esperar; la red de seguridad, no.
     *
     * Hoy FALLA (un solo intento): es la confirmacion del hallazgo, en rojo
     * hasta que llegue la correccion.
     */
    it('un rechazo por reglas del stop se reintenta y avisa en CRITICAL', async () => {
      const severidades: { type: string; severity: string }[] = [];
      const { runner, adapter } = build(
        { orders: [], immediate: [] },
        {
          event: jest.fn(async (_bot: unknown, type: string, severity: string) => {
            severidades.push({ type, severity });
          }) as never,
        },
        { stopLossPct: '10' },
      );
      adapter.position = conPos();
      adapter.placeError = new ExchangeError('RULES', 'min notional', Venue.HYPERLIQUID);

      await runner.start();
      await runner.handleCommand('RESUME');
      await new Promise((r) => setTimeout(r, 30));

      const intentos = adapter.calls.filter((c) => c.startsWith('place:') && c.includes('SL'));
      // Dos ticks, dos intentos: la red de seguridad no se da por perdida.
      expect(intentos.length).toBeGreaterThanOrEqual(2);
      // Y el usuario se entera con la severidad que corresponde a «sin stop».
      expect(severidades.some((e) => e.severity === 'CRITICAL')).toBe(true);
      await runner.dispose();
    });
  });

  describe('un acuse positivo del venue nunca acaba en REJECTED', () => {
    /**
     * Spec 001, F-36. `confirmOrder` iba dentro del mismo `try` que la llamada
     * al venue: si la base fallaba al anotar el acuse, la excepcion caia en el
     * `catch` de los rechazos y la fila acababa REJECTED con la orden VIVA en
     * el libro — invisible para PAUSE, para PANIC y para la cancelacion acotada
     * al bot, que leen las filas vivas de la base.
     */
    it('una orden aceptada por el venue no se marca REJECTED porque falle la base', async () => {
      const confirmOrder = jest.fn().mockRejectedValue(new Error('base caida'));
      const { runner, adapter, store } = build(
        { orders: [level(0)], immediate: [] },
        { confirmOrder: confirmOrder as never },
      );
      await runner.start();
      // Se suelta ANTES de comprobar: un `expect` que falle no debe dejar el
      // temporizador del runner vivo y colgar a jest.
      await runner.dispose();

      expect(adapter.placed).toHaveLength(1);
      expect(store.rejectOrder).not.toHaveBeenCalled();
      // Se insiste una vez y, si tampoco, se avisa: la fila queda PENDING con
      // el id del venue conocido, nunca REJECTED.
      expect(confirmOrder).toHaveBeenCalledTimes(2);
      expect(store.events).toContain('ACTION_FAILED');
    });
  });

  describe('una fila PENDING huerfana no veta el nivel para siempre', () => {
    /**
     * Spec 001, F-37. `place()` vetaba toda fila viva, PENDING incluida. Una
     * PENDING sin id de venue es una orden que quiza nunca llego (el proceso
     * murio entre la fila y el acuse); sin vencimiento, ese nivel —incluida una
     * entrada base— no se volvia a colocar en todo el ciclo y sin una linea en
     * la bitacora que lo explicara.
     */
    it('una PENDING sin acuse de hace mas de cinco minutos vence y el nivel se recoloca', async () => {
      const vieja = {
        status: 'PENDING',
        venue_order_id: null,
        updated_at: new Date(Date.now() - 10 * 60_000),
      };
      const { runner, adapter, store } = build(
        { orders: [level(0)], immediate: [] },
        { findOrderByCoid: jest.fn().mockResolvedValue(vieja) as never },
      );
      await runner.start();
      await runner.dispose();

      expect(store.rejectOrder).toHaveBeenCalledTimes(1);
      expect(adapter.placed).toHaveLength(1);
      expect(store.events).toContain('ORDER_RETRY');
    });

    it('una PENDING reciente sigue vetando: puede estar en vuelo', async () => {
      const reciente = { status: 'PENDING', venue_order_id: null, updated_at: new Date() };
      const { runner, adapter, store } = build(
        { orders: [level(0)], immediate: [] },
        { findOrderByCoid: jest.fn().mockResolvedValue(reciente) as never },
      );
      await runner.start();
      await runner.dispose();

      expect(adapter.placed).toHaveLength(0);
      expect(store.rejectOrder).not.toHaveBeenCalled();
    });
  });

  describe('la coletilla del stop dice lo que hay en el libro (spec 057, F-09)', () => {
    /**
     * `protectionNote` decidía solo por `stopLossPct`. Tendencia lo deja vacío y
     * pone su propio stop, así que cada aviso decía «la posición queda SIN stop
     * loss» con el stop vivo. Y `stopLossVivo` solo lo encendía un acuse: tras
     * un reinicio, con el stop ya en el libro, decía que no constaba.
     */
    const SL = makeCoid(BOT_ID, 1, 'STOP_LOSS', 0);
    const enLibro = (): VenueOrder => ({
      venue: Venue.HYPERLIQUID,
      symbol: 'BTC',
      clientOrderId: hyperliquidCodec.encode(SL),
      venueOrderId: 'v-sl',
      side: 'SELL',
      type: 'MARKET',
      price: '85.5',
      triggerPrice: '90.0',
      qty: '10.000',
      filledQty: '0',
      avgPrice: null,
      status: 'OPEN',
      reduceOnly: true,
      createdAt: Date.now(),
    });
    const suStop = level(0, {
      clientOrderId: SL,
      levelKind: 'STOP_LOSS',
      side: 'SELL',
      type: 'MARKET',
      price: '90.0',
      triggerPrice: '90.0',
      qty: '10.000',
      reduceOnly: true,
    });
    const notaAlPausar = async (opts: {
      stopPropio: boolean;
      conStopEnLibro: boolean;
      config?: Record<string, unknown>;
      plan?: DesiredState;
    }) => {
      const { runner, adapter, store } = build(
        opts.plan ?? { orders: opts.stopPropio ? [suStop] : [], immediate: [] },
        {},
        opts.config ?? {},
      );
      (runner as unknown as { strategy: { stopPropio?: boolean } }).strategy.stopPropio =
        opts.stopPropio;
      adapter.position = conPos();
      adapter.getOpenOrders = async () => (opts.conStopEnLibro ? [enLibro()] : []);
      await runner.start();
      await runner.handleCommand('PAUSE');
      await runner.dispose();
      const pausa = (store.event as jest.Mock).mock.calls.find((c) => c[1] === 'BOT_PAUSED');
      return String(pausa?.[3] ?? '');
    };

    it('con stop propio en el libro, dice que sigue vivo', async () => {
      const nota = await notaAlPausar({ stopPropio: true, conStopEnLibro: true });
      expect(nota).toContain('sigue vivo');
      expect(nota).not.toContain('SIN stop');
    });

    it('con stop propio que no consta en el libro, lo dice', async () => {
      // El plan lo pide pero el venue lo rechaza: no consta.
      const { runner, adapter, store } = build({ orders: [suStop], immediate: [] });
      (runner as unknown as { strategy: { stopPropio?: boolean } }).strategy.stopPropio = true;
      adapter.position = conPos();
      adapter.placeError = new ExchangeError('RULES', 'rechazado', Venue.HYPERLIQUID);
      await runner.start();
      await runner.handleCommand('PAUSE');
      await runner.dispose();
      const pausa = (store.event as jest.Mock).mock.calls.find((c) => c[1] === 'BOT_PAUSED');
      expect(String(pausa?.[3])).toContain('NO consta');
    });

    it('con stopLossPct y el stop ya en el libro tras un reinicio, dice que sigue vivo', async () => {
      // Nadie lo coloca en este proceso: ya estaba. Lo que manda es el libro.
      const nota = await notaAlPausar({
        stopPropio: false,
        conStopEnLibro: true,
        config: { stopLossPct: '10' },
        plan: { orders: [], immediate: [] },
      });
      expect(nota).toContain('sigue vivo');
    });

    it('sin stop de ninguna clase, sigue avisando de que no hay', async () => {
      const nota = await notaAlPausar({ stopPropio: false, conStopEnLibro: false });
      expect(nota).toContain('SIN stop loss');
    });
  });

  describe('una orden en estado desconocido no se manda dos veces (spec 057, F-06)', () => {
    /**
     * El envío falló y la comprobación de si entró también: no se sabe. La
     * fila se marcaba REJECTED, que no veta, y el tick siguiente mandaba la
     * misma entrada otra vez. Una de mercado que sí entró ya no está entre las
     * abiertas, así que la segunda doblaba la posición.
     */
    const desconocido = () =>
      new ExchangeError(
        'RETRYABLE',
        'Estado desconocido tras «HTTP 503»',
        Venue.HYPERLIQUID,
        undefined,
        true,
      );

    /** Un store que recuerda las filas, como el de verdad. */
    const conFilas = () => {
      const filas = new Map<
        string,
        { status: string; venue_order_id: string | null; updated_at: Date }
      >();
      return {
        filas,
        over: {
          upsertPendingOrder: jest.fn(async (input: { order: DesiredOrder }) => {
            filas.set(input.order.clientOrderId, {
              status: 'PENDING',
              venue_order_id: null,
              updated_at: new Date(),
            });
          }) as never,
          rejectOrder: jest.fn(async (coid: string) => {
            const fila = filas.get(coid);
            if (fila) fila.status = 'REJECTED';
          }) as never,
          findOrderByCoid: jest.fn(async (coid: string) => filas.get(coid) ?? null) as never,
        },
      };
    };
    const BASE = makeCoid(BOT_ID, 1, 'BASE', 0);
    const entrada = level(0, { clientOrderId: BASE, levelKind: 'BASE', type: 'MARKET' });
    const tickDe = (runner: BotRunner) =>
      (runner as unknown as { tick(): Promise<void> }).tick.call(runner);

    it('la entrada queda pendiente y el tick siguiente no la reenvía', async () => {
      const { filas, over } = conFilas();
      const { runner, adapter, store } = build({ orders: [], immediate: [entrada] }, over);
      adapter.placeErrorOnce = desconocido();

      await runner.start();
      await tickDe(runner);
      await runner.dispose();

      expect(adapter.calls.filter((c) => c.startsWith('place:'))).toHaveLength(1);
      expect(store.rejectOrder).not.toHaveBeenCalled();
      expect(filas.get(BASE)?.status).toBe('PENDING');
      expect(store.events).toContain('ORDER_RETRY');
    });

    it('un fallo pasajero que se sabe que no entró sí se reintenta', async () => {
      const { over } = conFilas();
      const { runner, adapter } = build({ orders: [], immediate: [entrada] }, over);
      adapter.placeErrorOnce = new ExchangeError('RETRYABLE', 'timeout', Venue.HYPERLIQUID);

      await runner.start();
      await tickDe(runner);
      await runner.dispose();

      expect(adapter.calls.filter((c) => c.startsWith('place:'))).toHaveLength(2);
    });

    /**
     * Spec 060, F-07. El veto era para TODA orden que no reduce, y una en
     * reposo no lo necesita: si entró, se ve en el libro al tick siguiente. Con
     * él, una cotización en estado desconocido dejaba su lado sin cotizar cinco
     * minutos… o para siempre, porque en un hueco que reutiliza su id la fila
     * conservaba el id de venue de la anterior y `pendienteVencida` —que exige
     * no tenerlo— no la soltaba nunca.
     */
    it('una cotización en reposo en estado desconocido vuelve en el tick siguiente', async () => {
      const reloj = Date.UTC(2026, 8, 17, 10);
      jest.spyOn(Date, 'now').mockImplementation(() => reloj);
      const COTIZACION = makeCoid(BOT_ID, 1, 'QUOTE_BID', 0);
      const cotizacion = level(0, {
        clientOrderId: COTIZACION,
        levelKind: 'QUOTE_BID',
        type: 'POST_ONLY',
      });
      // La encarnación anterior se ejecutó con su id de venue.
      const filas = new Map([
        [
          COTIZACION,
          { status: 'FILLED', venue_order_id: 'v-anterior', updated_at: new Date(reloj) },
        ],
      ]);
      const { runner, adapter } = build(
        { orders: [cotizacion], immediate: [] },
        {
          // Como el `upsert` real: no toca el id de venue que ya tuviera la fila.
          upsertPendingOrder: jest.fn(async (input: { order: DesiredOrder }) => {
            const previa = filas.get(input.order.clientOrderId);
            filas.set(input.order.clientOrderId, {
              status: 'PENDING',
              venue_order_id: previa?.venue_order_id ?? null,
              updated_at: new Date(reloj),
            });
          }) as never,
          findOrderByCoid: jest.fn(async (coid: string) => filas.get(coid) ?? null) as never,
          rejectOrder: jest.fn(async (coid: string) => {
            const fila = filas.get(coid);
            if (fila) fila.status = 'REJECTED';
          }) as never,
        },
      );
      (runner as unknown as { strategy: unknown }).strategy = {
        kind: 'MARKET_MAKER',
        reusesOrderSlots: true,
        plan: () => ({ orders: [cotizacion], immediate: [] }),
      };
      adapter.placeErrorOnce = desconocido();

      try {
        await runner.start();
        await tickDe(runner);
        await runner.dispose();
        expect(adapter.calls.filter((c) => c === 'place:' + COTIZACION)).toHaveLength(2);
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('una orden que solo reduce se sigue reintentando: repetirla no abre nada', async () => {
      const { over } = conFilas();
      const cierre = level(0, {
        clientOrderId: makeCoid(BOT_ID, 1, 'TAKE_PROFIT', 999),
        levelKind: 'TAKE_PROFIT',
        side: 'SELL',
        type: 'MARKET',
        reduceOnly: true,
      });
      const { runner, adapter } = build({ orders: [], immediate: [cierre] }, over);
      adapter.position = conPos();
      adapter.placeErrorOnce = desconocido();

      await runner.start();
      await tickDe(runner);
      await runner.dispose();

      expect(adapter.calls.filter((c) => c.startsWith('place:'))).toHaveLength(2);
    });
  });

  describe('lo que el motor cancela se anota aunque el venue lo llame por otro id (spec 060 F-01)', () => {
    /**
     * Reemplazar es cancelar y volver a colocar con el MISMO id. La cancelación
     * se anotaba buscando la fila por su id de venue, y ese id no es siempre el
     * del libro: Lighter acusa con el índice de cliente y lista con su
     * `order_index`, y un disparador de Hyperliquid puede acusarse sin `oid`. La
     * fila seguía viva, `place()` vetaba la recolocación y el stop, ya
     * cancelado en el venue, no volvía: en Lighter, nunca.
     */
    const STOP = makeCoid(BOT_ID, 1, 'STOP_LOSS', 0);
    const stopEn = (disparo: string): DesiredOrder => ({
      clientOrderId: STOP,
      levelKind: 'STOP_LOSS',
      levelIndex: 0,
      side: 'SELL',
      type: 'MARKET',
      price: disparo,
      triggerPrice: disparo,
      qty: '10.000',
      reduceOnly: true,
    });
    const VIVAS = ['PENDING', 'OPEN', 'PARTIALLY_FILLED'];
    const tickDe = (runner: BotRunner) =>
      (runner as unknown as { tick(): Promise<void> }).tick.call(runner);

    /**
     * Un libro que asigna sus propios ids y unas filas que se anotan como las de
     * verdad. `acuse` decide qué id de venue trae el acuse de cada orden.
     */
    const montar = (plan: DesiredState, acuse: (coid: string) => string) => {
      const filas = new Map<
        string,
        {
          status: string;
          venue_order_id: string | null;
          venue_client_id: string;
          updated_at: Date;
        }
      >();
      const libro: VenueOrder[] = [];
      let secuencia = 0;
      const h = build(plan, {
        upsertPendingOrder: jest.fn(
          async (input: { order: DesiredOrder; venueClientId: string }) => {
            // Como el `upsert` real: el id de venue de la encarnación anterior
            // no se toca hasta el acuse.
            const previa = filas.get(input.order.clientOrderId);
            filas.set(input.order.clientOrderId, {
              status: 'PENDING',
              venue_order_id: previa?.venue_order_id ?? null,
              venue_client_id: input.venueClientId,
              updated_at: new Date(),
            });
          },
        ) as never,
        confirmOrder: jest.fn(async (coid: string, ack: OrderAck) => {
          const fila = filas.get(coid);
          if (!fila) return;
          fila.venue_order_id = ack.venueOrderId || null;
          fila.status = ack.status;
          fila.updated_at = new Date();
        }) as never,
        rejectOrder: jest.fn(async (coid: string) => {
          const fila = filas.get(coid);
          if (fila) fila.status = 'REJECTED';
        }) as never,
        findOrderByCoid: jest.fn(async (coid: string) => filas.get(coid) ?? null) as never,
        // Lo que el bot mandó, en espacio de venue: es lo que reconoce una huérfana.
        ownVenueClientIds: jest.fn(async () =>
          [...filas.values()].map((f) => f.venue_client_id),
        ) as never,
        markOrderCanceled: jest.fn(
          async (_bot: string, venueOrderId: string, venueClientId?: string | null) => {
            for (const fila of filas.values()) {
              const esa =
                fila.venue_order_id === venueOrderId ||
                (venueClientId != null && fila.venue_client_id === venueClientId);
              if (esa && VIVAS.includes(fila.status)) fila.status = 'CANCELED';
            }
          },
        ) as never,
        markCoidsCanceled: jest.fn(async (_bot: string, coids: string[]) => {
          for (const coid of coids) {
            const fila = filas.get(coid);
            if (fila && VIVAS.includes(fila.status)) fila.status = 'CANCELED';
          }
        }) as never,
      });
      h.adapter.position = { ...conPos(), liquidationPrice: null };
      h.adapter.getOpenOrders = async () => libro.map((o) => ({ ...o }));
      h.adapter.placeOrder = async (req: PlaceOrderRequest): Promise<OrderAck> => {
        h.adapter.calls.push('place:' + req.clientOrderId);
        h.adapter.placed.push(req.clientOrderId);
        libro.push({
          venue: Venue.HYPERLIQUID,
          symbol: 'BTC',
          clientOrderId: hyperliquidCodec.encode(req.clientOrderId),
          venueOrderId: `libro-${++secuencia}`,
          side: req.side,
          type: req.type,
          price: req.price ?? '0',
          qty: req.qty,
          filledQty: '0',
          avgPrice: null,
          status: 'OPEN',
          reduceOnly: req.reduceOnly === true,
          createdAt: Date.now(),
          triggerPrice: req.triggerPrice ?? null,
        });
        return {
          clientOrderId: req.clientOrderId,
          venueOrderId: acuse(req.clientOrderId),
          status: 'PENDING',
          ts: Date.now(),
        };
      };
      h.adapter.cancelOrder = async (req: CancelRequest): Promise<void> => {
        h.adapter.calls.push('cancelOrder');
        const i = libro.findIndex((o) => o.venueOrderId === req.venueOrderId);
        if (i >= 0) libro.splice(i, 1);
      };
      return { ...h, filas, libro };
    };

    it.each([
      ['Lighter: el acuse trae el índice de cliente', (coid: string) => `cliente-${coid}`],
      ['Hyperliquid: el acuse de un disparador no trae oid', () => ''],
    ])('%s y el stop que se mueve vuelve al libro', async (_caso, acuse) => {
      const plan: DesiredState = { orders: [stopEn('90.0')], immediate: [] };
      const { runner, libro } = montar(plan, acuse);

      await runner.start();
      expect(libro.map((o) => o.triggerPrice)).toEqual(['90.0']);

      // El stop se mueve (a breakeven, o lo sigue la tendencia).
      plan.orders = [stopEn('91.0')];
      await tickDe(runner);
      await runner.dispose();

      expect(libro.map((o) => o.triggerPrice)).toEqual(['91.0']);
    });

    it('una orden cancelada por huérfana se puede volver a colocar con su id', async () => {
      const nivel = level(0);
      const plan: DesiredState = { orders: [nivel], immediate: [] };
      const { runner, libro } = montar(plan, (coid) => `cliente-${coid}`);

      await runner.start();
      expect(libro).toHaveLength(1);

      // El precio sale del rango: el nivel sobra y se cancela…
      plan.orders = [];
      await tickDe(runner);
      expect(libro).toHaveLength(0);

      // …y vuelve: es el mismo nivel del mismo ciclo, con el mismo id.
      plan.orders = [nivel];
      await tickDe(runner);
      await runner.dispose();

      expect(libro).toHaveLength(1);
    });
  });

  describe('reponer el stop no espera al siguiente tick', () => {
    /**
     * Spec 001, F-35. Un fallo pasajero al colocar el stop seguia la ruta de
     * cualquier nivel: ORDER_RETRY en INFO y «se reintenta en el siguiente
     * tick». Para una seguridad de la escalera es razonable; para la red de la
     * posicion es hasta un cuarto de minuto —o mucho mas si el corte dura— sin
     * stop y sin que nadie se entere.
     */
    it('un corte pasajero al colocar el stop se reintenta en el mismo tick', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] }, {}, { stopLossPct: '10' });
      adapter.position = conPos();
      adapter.placeErrorOnce = new ExchangeError('RETRYABLE', 'timeout', Venue.HYPERLIQUID);
      await runner.start();
      await runner.dispose();

      const intentos = adapter.calls.filter((c) => c.startsWith('place:') && c.includes('SL'));
      expect(intentos).toHaveLength(2);
      expect(adapter.placed.filter((c) => c.includes('SL'))).toHaveLength(1);
    });

    it('si tampoco sale al reintentar, se avisa en CRITICAL', async () => {
      const severidades: string[] = [];
      const { runner, adapter } = build(
        { orders: [], immediate: [] },
        {
          event: jest.fn(async (_bot: unknown, _type: string, severity: string) => {
            severidades.push(severity);
          }) as never,
        },
        { stopLossPct: '10' },
      );
      adapter.position = conPos();
      adapter.placeError = new ExchangeError('RETRYABLE', 'timeout', Venue.HYPERLIQUID);
      await runner.start();
      await runner.dispose();

      expect(severidades).toContain('CRITICAL');
    });
  });

  describe('limite de perdida diaria por bot', () => {
    /**
     * `maxDailyLossPct` estaba declarado, tipado y etiquetado desde el principio
     * y no lo leia NADIE. Es distinto del tope global del usuario: aquel es en
     * valor absoluto y sobre toda la cuenta, asi que un bot podia quemarse su
     * asignacion entera sin rozarlo.
     */
    it('pausa cuando la perdida de hoy supera el porcentaje', async () => {
      const { runner, store } = build(
        { orders: [], immediate: [] },
        {
          // -250 sobre los 1000 asignados = 25 %.
          todayRealizedPnlForBot: jest.fn().mockResolvedValue({ toFixed: () => '-250' }) as never,
          drawdownPct: jest.fn(() => ({ gte: () => true, toFixed: () => '25.00' })) as never,
        },
        { maxDailyLossPct: '20' },
      );

      await runner.start();

      expect(store.events).toContain('RISK_GUARD_TRIPPED');
      expect(store.setStatus).toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
      await runner.dispose();
    });
  });

  describe('accion al acercarse la liquidacion', () => {
    /**
     * Por defecto sigue siendo avisar y no tocar nada: cambiarle la conducta a
     * un bot en marcha sin que su dueno lo pida seria peor que el hueco.
     */
    it('ALERT avisa y no pausa', async () => {
      const { runner, adapter, store } = build(
        { orders: [], immediate: [] },
        {},
        {},
        { liquidationAlertPct: '5' },
      );
      adapter.position = conPos();
      await runner.start();

      expect(store.events).toContain('LIQUIDATION_NEAR');
      expect(store.events).not.toContain('RISK_GUARD_TRIPPED');
      await runner.dispose();
    });

    it('PAUSE pausa el bot', async () => {
      const { runner, adapter, store } = build(
        { orders: [], immediate: [] },
        {},
        { liquidationAction: 'PAUSE' },
        { liquidationAlertPct: '5' },
      );
      adapter.position = conPos();
      await runner.start();

      expect(store.events).toContain('LIQUIDATION_NEAR');
      expect(store.events).toContain('RISK_GUARD_TRIPPED');
      await runner.dispose();
    });

    it('CLOSE_ALL cierra la posicion y para el bot', async () => {
      const { runner, adapter, store, detached } = build(
        { orders: [], immediate: [] },
        {},
        { liquidationAction: 'CLOSE_ALL' },
        { liquidationAlertPct: '5' },
      );
      adapter.position = conPos();
      await runner.start();

      expect(store.setStatus).toHaveBeenCalledWith(BOT_ID, 'STOPPED');
      expect(detached).toContain(BOT_ID);
      await runner.dispose();
    });
  });

  describe('cortacircuitos de ticks fallidos', () => {
    /**
     * Antes solo `AUTH` detenia a un bot: uno cuyo tick fallara siempre seguia
     * con su temporizador y su lease, escribiendo un WARN cada quince segundos
     * para siempre, mientras la app lo pintaba en verde.
     */
    it('pausa tras varios ticks seguidos fallando por un fallo propio', async () => {
      const adapter = new FakeAdapter();
      // FATAL y no RETRYABLE: desde el spec 050 una caída del venue ya no pausa.
      adapter.tickerError = new ExchangeError('FATAL', 'algo raro', Venue.HYPERLIQUID);
      const store = fakeStore();

      const runner = new BotRunner({
        bot: BOT,
        adapter,
        market: MARKET,
        config: { leverage: 1 } as never,
        cycle: CYCLE,
        store,
        guards: {
          maxNotionalPerBot: null,
          maxDailyLoss: null,
          killSwitchDrawdownPct: null,
          liquidationAlertPct: null,
          maxLeverage: null,
          maxTotalNotional: null,
        },
        reconcileIntervalMs: 10,
        onDetach: () => undefined,
      });
      (runner as unknown as { strategy: unknown }).strategy = {
        kind: 'GRID_CLASSIC',
        plan: () => ({ orders: [], immediate: [] }),
      };

      await runner.start();
      await new Promise((r) => setTimeout(r, 250));

      expect(store.events).toContain('TICK_ERROR');
      expect(store.events).toContain('RISK_GUARD_TRIPPED');
      await runner.dispose();
    });

    it('un tick bueno deja el reloj de salud a cero', async () => {
      const { runner, store } = build({ orders: [], immediate: [] });
      await runner.start();

      expect(runner.msSinceLastTick).toBeLessThan(1000);
      expect(store.events).not.toContain('RISK_GUARD_TRIPPED');
      await runner.dispose();
    });
  });

  // ─── Spec 050: la caída de Hyperliquid del 2026-09-13 ────────────────────
  //
  // Cuatro bots fallando a la vez por un 502 del venue: un TICK_ERROR por tick y
  // por bot en Telegram, los tres simulados pausados a los cinco y sin volver
  // cuando el venue se recuperó, y una alerta que decía «la posición sigue
  // abierta… SIN stop loss» a un bot que no tenía posición.

  const tickDe = (runner: BotRunner) => (runner as unknown as { tick(): Promise<void> }).tick();
  const latidoDe = (runner: BotRunner) => (runner as unknown as { latido(): void }).latido();
  const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const caidaDelVenue = () => new ExchangeError('RETRYABLE', 'HTTP 502', Venue.HYPERLIQUID);
  const falloPropio = (motivo = 'algo raro') =>
    new ExchangeError('FATAL', motivo, Venue.HYPERLIQUID);
  const lecturasDePrecio = (adapter: FakeAdapter) =>
    adapter.calls.filter((c) => c === 'getTicker').length;
  const cuantos = (store: ReturnType<typeof fakeStore>, tipo: string) =>
    store.events.filter((e) => e === tipo).length;
  const mensajesDe = (store: ReturnType<typeof fakeStore>, tipo: string): string[] =>
    (store.event as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[1] === tipo)
      .map((c: unknown[]) => c[3] as string);
  const POSICION: Position = {
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    qty: '1',
    entryPrice: '100',
    markPrice: '100',
    unrealizedPnl: '0',
    leverage: 1,
    marginMode: 'ISOLATED',
    liquidationPrice: null,
    marginUsed: '0',
  };

  describe('una caída del venue no es un fallo del bot (spec 050)', () => {
    it('no pausa: avisa UNA vez y deja el motivo a la vista sin tocar el estado', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = caidaDelVenue();

      for (let i = 0; i < 8; i++) await tickDe(runner);

      expect(store.events).not.toContain('RISK_GUARD_TRIPPED');
      expect(store.events).not.toContain('TICK_ERROR');
      expect(cuantos(store, 'VENUE_UNAVAILABLE')).toBe(1);
      expect(mensajesDe(store, 'VENUE_UNAVAILABLE')[0]).toMatch(/HYPERLIQUID.*HTTP 502/);
      expect(store.setLastError).toHaveBeenCalledWith(BOT_ID, expect.stringContaining('HTTP 502'));
      expect(store.setStatus).not.toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
      // Nada de cancelar la escalera ni el take profit por un corte del venue.
      expect(adapter.calls).not.toContain('cancelOwn');
      expect(runner.esperandoAlVenue).toBe(true);
      await runner.dispose();
    });

    it('al volver lo dice una vez y limpia el motivo que puso', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = caidaDelVenue();
      for (let i = 0; i < 4; i++) await tickDe(runner);

      adapter.tickerError = null;
      await tickDe(runner);
      await tickDe(runner);

      expect(cuantos(store, 'VENUE_RECOVERED')).toBe(1);
      expect(store.setLastError).toHaveBeenLastCalledWith(BOT_ID, null);
      expect(runner.esperandoAlVenue).toBe(false);
      await runner.dispose();
    });

    it('un hipo de dos ticks no avisa ni al caer ni al volver', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = caidaDelVenue();
      await tickDe(runner);
      await tickDe(runner);
      adapter.tickerError = null;
      await tickDe(runner);

      expect(store.events).not.toContain('VENUE_UNAVAILABLE');
      expect(store.events).not.toContain('VENUE_RECOVERED');
      expect(store.setLastError).not.toHaveBeenCalled();
      await runner.dispose();
    });

    it('con el bot pausado no pisa el motivo de la pausa', async () => {
      // `last_error` de un bot pausado dice POR QUÉ se pausó. Una caída del venue
      // que lo sobrescribiera, y una vuelta que lo borrara, se llevarían ese
      // motivo por delante.
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      await runner.handleCommand('PAUSE');
      adapter.tickerError = caidaDelVenue();
      for (let i = 0; i < 5; i++) await tickDe(runner);
      adapter.tickerError = null;
      await tickDe(runner);

      expect(store.setLastError).not.toHaveBeenCalled();
      await runner.dispose();
    });

    it('el latido no encola ticks detrás de uno lento', async () => {
      // Con ticks de 72 s y un temporizador de 15 s se amontonaban cuatro en la
      // cola del cerrojo, que corrían después uno detrás de otro.
      const { runner, adapter } = build({ orders: [], immediate: [] });
      await runner.start();
      const antes = lecturasDePrecio(adapter);
      adapter.tickerDelayMs = 50;

      latidoDe(runner);
      latidoDe(runner);
      latidoDe(runner);
      await espera(250);

      expect(lecturasDePrecio(adapter) - antes).toBe(1);
      await runner.dispose();
    });

    it('durante la caída el latido se espacia, pero lo pedido entra sin esperar', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = caidaDelVenue();
      await tickDe(runner);
      await tickDe(runner);
      const antes = lecturasDePrecio(adapter);

      latidoDe(runner);
      await espera(20);
      expect(lecturasDePrecio(adapter)).toBe(antes);

      // Un fill o un comando piden tick por su cuenta, y ese no espera nunca.
      (runner as unknown as { requestTick(): void }).requestTick();
      await espera(20);
      expect(lecturasDePrecio(adapter)).toBe(antes + 1);
      await runner.dispose();
    });

    it('un tick caído por el venue no suma el aviso de ritmo', async () => {
      // «La revisión ha tardado 72 s… Suele ser el cupo de peticiones del venue»:
      // el cupo no tenía nada que ver, y la caída ya se cuenta aparte.
      const { runner, adapter, store } = build(
        { orders: [], immediate: [] },
        {},
        {},
        {},
        { reconcileIntervalMs: 10 },
      );
      adapter.tickerDelayMs = 30;
      adapter.tickerError = caidaDelVenue();
      await tickDe(runner);
      expect(store.events).not.toContain('TICK_SLOW');

      // Y un tick lento que NO es una caída sigue avisando.
      adapter.tickerError = null;
      await tickDe(runner);
      expect(store.events).toContain('TICK_SLOW');
      await runner.dispose();
    });

    // Revisión del 050: lo que la primera versión dejaba colgado.

    it('pausar durante una caída anunciada borra el motivo de la caída (B-1)', async () => {
      // Si no, la tarjeta decía PAUSADO con «el bot espera sin pausar» debajo, y
      // nada lo borraba: la vuelta del venue no toca el motivo de un bot pausado.
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = caidaDelVenue();
      for (let i = 0; i < 3; i++) await tickDe(runner);

      await runner.handleCommand('PAUSE');

      expect(store.setStatus).toHaveBeenCalledWith(BOT_ID, 'PAUSED', { clearError: true });
      await runner.dispose();
    });

    it('la vuelta se anuncia aunque esa misma revisión acabe en una guarda (B-2)', async () => {
      // La revisión que encuentra el venue de vuelta y salta una guarda sale del
      // tick antes de su final: la vuelta no se anunciaba y el latido seguía
      // espaciado como si el venue siguiera caído.
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = caidaDelVenue();
      for (let i = 0; i < 3; i++) await tickDe(runner);

      (
        runner as unknown as { deps: { guards: { maxLeverage: number | null } } }
      ).deps.guards.maxLeverage = 0.5;
      adapter.tickerError = null;
      await tickDe(runner);

      expect(cuantos(store, 'RISK_GUARD_TRIPPED')).toBe(1);
      expect(cuantos(store, 'VENUE_RECOVERED')).toBe(1);
      expect(runner.esperandoAlVenue).toBe(false);
      await runner.dispose();
    });

    it('reanudar durante una caída vuelve a dejar el motivo a la vista (B-3)', async () => {
      // RESUME borra `last_error`, y el motivo solo se reescribía con el aviso,
      // que tiene enfriamiento de media hora: la tarjeta se quedaba en blanco.
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      await runner.handleCommand('PAUSE');
      adapter.tickerError = caidaDelVenue();
      for (let i = 0; i < 3; i++) await tickDe(runner);
      expect(store.setLastError).not.toHaveBeenCalled();

      await runner.handleCommand('RESUME');
      await espera(30);

      expect(store.setLastError).toHaveBeenCalledWith(
        BOT_ID,
        expect.stringContaining('no responde'),
      );
      await runner.dispose();
    });

    it('esperar al venue no tapa para siempre a un runner colgado (B-4)', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = caidaDelVenue();
      await tickDe(runner);
      expect(runner.esperandoAlVenue).toBe(true);

      // Diez minutos sin un fallo del venue ni un tick completo: eso ya no es
      // esperar al venue, es un runner atascado.
      (runner as unknown as { ultimoFalloVenueEn: number }).ultimoFalloVenueEn =
        Date.now() - 10 * 60_000;
      expect(runner.esperandoAlVenue).toBe(false);
      await runner.dispose();
    });
  });

  describe('un fallo propio sigue pausando, pero avisa una vez por racha (spec 050)', () => {
    it('pausa a los cinco con un solo TICK_ERROR, y ninguno más ya pausado', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = falloPropio();

      for (let i = 0; i < 5; i++) await tickDe(runner);
      expect(cuantos(store, 'RISK_GUARD_TRIPPED')).toBe(1);
      expect(cuantos(store, 'TICK_ERROR')).toBe(1);

      for (let i = 0; i < 3; i++) await tickDe(runner);
      expect(cuantos(store, 'TICK_ERROR')).toBe(1);
      expect(cuantos(store, 'RISK_GUARD_TRIPPED')).toBe(1);
      await runner.dispose();
    });

    it('un motivo distinto sí vuelve a avisar', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = falloPropio('uno');
      await tickDe(runner);
      await tickDe(runner);
      adapter.tickerError = falloPropio('otro');
      await tickDe(runner);

      expect(cuantos(store, 'TICK_ERROR')).toBe(2);
      await runner.dispose();
    });
  });

  describe('la alerta dice si había posición (spec 050)', () => {
    it('recién leída y plana, la pausa dice que no tenía posición', async () => {
      const { runner, store } = build({ orders: [], immediate: [] });
      await runner.start();

      await runner.handleCommand('PAUSE');

      const [mensaje] = mensajesDe(store, 'BOT_PAUSED');
      expect(mensaje).toContain('no tenía posición abierta');
      expect(mensaje).not.toContain('SIN stop loss');
      await runner.dispose();
    });

    it('con posición, la coletilla del stop sigue saliendo', async () => {
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      adapter.position = POSICION;
      await runner.start();

      await runner.handleCommand('PAUSE');

      const [mensaje] = mensajesDe(store, 'BOT_PAUSED');
      expect(mensaje).toContain('la posición sigue abierta');
      expect(mensaje).toContain('SIN stop loss');
      await runner.dispose();
    });

    it('tras una racha de fallos no presume que siga plano (revisión, M-1)', async () => {
      // La última lectura buena tiene más de un minuto, y el venue puede haber
      // ejecutado una entrada entretanto. Decir «no tenía posición» quitaba el
      // aviso de que no hay stop justo en el sentido peligroso.
      const { runner, adapter, store } = build({ orders: [], immediate: [] });
      await runner.start();
      adapter.tickerError = falloPropio();
      for (let i = 0; i < 5; i++) await tickDe(runner);

      const [mensaje] = mensajesDe(store, 'RISK_GUARD_TRIPPED');
      expect(mensaje).not.toContain('no tenía posición abierta');
      expect(mensaje).toContain('si tenía posición abierta, sigue abierta');
      expect(mensaje).toContain('SIN stop loss');
      await runner.dispose();
    });

    it('una ejecución deja de dar por buena la lectura plana (revisión, M-1)', async () => {
      const { runner, store } = build({ orders: [], immediate: [] });
      await runner.start();
      const fill: Fill = {
        venue: Venue.HYPERLIQUID,
        symbol: 'BTC',
        venueFillId: 'f-050',
        venueOrderId: 'v-050',
        clientOrderId: makeCoid(BOT_ID, 1, 'GRID_BUY', 0),
        side: 'BUY',
        price: '100',
        qty: '1',
        fee: '0',
        feeAsset: 'USDC',
        isTaker: false,
        ts: Date.now(),
      };

      // El fill entra y la pausa llega ANTES de que el tick que pide lo relea.
      await (runner as unknown as { onFill(f: Fill): Promise<void> }).onFill(fill);
      await runner.handleCommand('PAUSE');

      expect(mensajesDe(store, 'BOT_PAUSED')[0]).not.toContain('no tenía posición abierta');
      await runner.dispose();
    });
  });

  describe('reconciliacion del ciclo al adoptar', () => {
    /**
     * El barrido de ejecuciones solo retrocede diez minutos. Si el worker
     * estuvo caido mas tiempo, lo de en medio no lo ingirio nadie y el ciclo se
     * quedo contando una cantidad que ya no existe. Nada lo comparaba.
     */
    it('avisa cuando el ciclo y el venue no dicen lo mismo', async () => {
      const { runner, store } = build(
        { orders: [], immediate: [] },
        {
          repairCycleFromVenue: jest.fn().mockResolvedValue({
            before: '10',
            after: '4',
            entriesFilled: 1,
            indexes: [0],
          }) as never,
        },
      );

      await runner.start();

      expect(store.events).toContain('BOT_REPAIRED');
      await runner.dispose();
    });

    it('se comprueba una sola vez, no en cada latido', async () => {
      const reparar = jest.fn().mockResolvedValue(null);
      const { runner } = build(
        { orders: [], immediate: [] },
        { repairCycleFromVenue: reparar as never },
      );

      await runner.start();
      await runner.handleCommand('RESUME');
      await runner.handleCommand('RESUME');

      expect(reparar).toHaveBeenCalledTimes(1);
      await runner.dispose();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Apalancamiento: la configuracion tiene que LLEGAR al venue
// ═══════════════════════════════════════════════════════════════════════

describe('sincronizacion del apalancamiento', () => {
  const plan: DesiredState = { orders: [], cancelAll: false };

  it('lo fija al arrancar', async () => {
    const { runner, adapter } = build(plan, {}, { leverage: 3 });
    await runner.start();

    expect(adapter.leverageCalls).toEqual([{ leverage: 3, mode: 'ISOLATED' }]);
    await runner.dispose();
  });

  it('un cambio WARM tambien lo manda al venue', async () => {
    // Antes solo lo hacia `start()`: el bot reajustaba su escalera y sus
    // guardas con el valor nuevo mientras el exchange seguia con el viejo.
    const { runner, adapter } = build(plan, {}, { leverage: 3 });
    await runner.start();
    adapter.leverageCalls.length = 0;

    await runner.reloadConfig({ leverage: 2 } as never, 'WARM');

    expect(adapter.leverageCalls).toEqual([{ leverage: 2, mode: 'ISOLATED' }]);
    await runner.dispose();
  });

  it('no lo remanda si no cambio', async () => {
    // Es una escritura firmada: repetirla en cada cambio HOT —un stop loss, un
    // tope de exposicion— gastaria caudal para decirle al venue lo que ya sabe.
    const { runner, adapter } = build(plan, {}, { leverage: 3 });
    await runner.start();
    adapter.leverageCalls.length = 0;

    await runner.reloadConfig({ leverage: 3, stopLossPct: 5 } as never, 'HOT');

    expect(adapter.leverageCalls).toEqual([]);
    await runner.dispose();
  });

  it('un rechazo del venue no impide seguir', async () => {
    // Con posicion abierta muchos venues lo niegan, y eso es lo normal.
    const { runner, adapter, store } = build(plan, {}, { leverage: 3 });
    await runner.start();
    jest
      .spyOn(adapter, 'setLeverage')
      .mockRejectedValueOnce(new ExchangeError('RULES', 'posicion abierta', Venue.HYPERLIQUID));

    await expect(runner.reloadConfig({ leverage: 9 } as never, 'WARM')).resolves.toBeUndefined();

    expect(store.events).toContain('LEVERAGE_SKIPPED');
    await runner.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Ajuste de margen aislado
// ═══════════════════════════════════════════════════════════════════════

describe('ADJUST_MARGIN', () => {
  const plan: DesiredState = { orders: [], cancelAll: false };

  const conPosicion = (qty: string): Position => ({
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    qty,
    entryPrice: '100',
    markPrice: '100',
    unrealizedPnl: '0',
    leverage: 5,
    marginMode: 'ISOLATED',
    liquidationPrice: '80',
    marginUsed: '20',
  });

  it('manda el importe y deduce el lado del SIGNO de la posicion', async () => {
    const { runner, adapter } = build(plan);
    adapter.position = conPosicion('1');
    await runner.start();

    await runner.handleCommand('ADJUST_MARGIN', { amount: '25', action: 'ADD' });

    expect(adapter.marginCalls).toEqual([{ amount: '25', action: 'ADD', side: 'LONG' }]);
    await runner.dispose();
  });

  it('una posicion corta se financia por el lado SHORT', async () => {
    // Del signo y no de `config.direction`: un market maker se configura
    // NEUTRAL y su posicion esta igualmente en un lado concreto.
    const { runner, adapter } = build(plan, {}, { direction: 'NEUTRAL' });
    adapter.position = conPosicion('-1');
    await runner.start();

    await runner.handleCommand('ADJUST_MARGIN', { amount: '25', action: 'ADD' });

    expect(adapter.marginCalls[0].side).toBe('SHORT');
    await runner.dispose();
  });

  it('registra la liquidacion ANTES y DESPUES', async () => {
    // Es la unica prueba de que el aporte sirvio para lo que se pidio.
    const { runner, adapter, store } = build(plan);
    adapter.position = conPosicion('1');
    await runner.start();

    // El venue mueve la liquidacion al recibir el colateral.
    jest.spyOn(adapter, 'adjustIsolatedMargin').mockImplementationOnce(async () => {
      adapter.position = { ...conPosicion('1'), liquidationPrice: '60', marginUsed: '45' };
    });

    await runner.handleCommand('ADJUST_MARGIN', { amount: '25', action: 'ADD' });

    const evento = store.payloads.find((p) => p.type === 'MARGIN_ADJUSTED');
    expect(evento?.payload).toMatchObject({
      liquidationBefore: '80',
      liquidationAfter: '60',
      marginAfter: '45',
    });
    await runner.dispose();
  });

  it('sin posicion abierta no hay caja que financiar', async () => {
    const { runner } = build(plan);
    await runner.start();

    await expect(
      runner.handleCommand('ADJUST_MARGIN', { amount: '25', action: 'ADD' }),
    ).rejects.toThrow(/No hay posición abierta/i);
    await runner.dispose();
  });

  it('sin importe se rechaza en vez de mandar algo a medias', async () => {
    const { runner, adapter } = build(plan);
    adapter.position = conPosicion('1');
    await runner.start();

    await expect(runner.handleCommand('ADJUST_MARGIN', {})).rejects.toThrow(/sin importe/i);
    expect(adapter.marginCalls).toEqual([]);
    await runner.dispose();
  });

  it('un fallo del venue sube como error del comando', async () => {
    // `drainCommands` lo convierte en COMMAND_FAILED con el motivo: dejarlo
    // pasar por bueno diria que el margen entro cuando no entro.
    const { runner, adapter } = build(plan);
    adapter.position = conPosicion('1');
    adapter.marginError = new ExchangeError(
      'INSUFFICIENT_FUNDS',
      'sin margen libre',
      Venue.HYPERLIQUID,
    );
    await runner.start();

    await expect(
      runner.handleCommand('ADJUST_MARGIN', { amount: '25', action: 'ADD' }),
    ).rejects.toThrow(/sin margen libre/i);
    await runner.dispose();
  });
});

/**
 * Una liquidación no lleva el id de ninguna orden nuestra: la puso el venue.
 *
 * `recordFill` no la reconoce y devolvía null, así que el runner la descartaba:
 * la posición desaparecía del venue y la contabilidad del bot seguía enseñando
 * la de antes. La pérdida —lo que más importa de todo el episodio— no llegaba ni
 * a `bot_cycles.realized_pnl` ni a la gráfica.
 */
describe('liquidación del venue', () => {
  const fillLiq = (over: Partial<Fill> = {}): Fill => ({
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    venueFillId: 'f-liq',
    venueOrderId: 'o-liq',
    // Sin coid: es lo que la hace irreconocible para el ledger.
    clientOrderId: null,
    side: 'SELL',
    price: '80.5',
    qty: '1',
    fee: '0.04',
    feeAsset: 'USDC',
    isTaker: true,
    ts: Date.now(),
    liquidation: true,
    ...over,
  });

  /** Como el runner real: `recordFill` no encuentra orden que casar. */
  const sinOrden = { recordFill: jest.fn().mockResolvedValue(null) } as never;

  /**
   * Un bot al que van a liquidar TIENE posición.
   *
   * `averageEntry` es lo que dice que el ciclo cree tener uno: el arnés arranca
   * plano, así que sin esto ninguna liquidación sería suya — que es justo la
   * guarda que prueba el último test de este bloque.
   */
  const conPosicion = (runner: BotRunner) => {
    (runner as unknown as { cycle: CycleState }).cycle = {
      ...CYCLE,
      averageEntry: '100',
    };
  };

  /**
   * La liquidacion se lleva la posicion ENTERA.
   *
   * `applyFillToCycle` cierra el ciclo y abre el siguiente, y ahi
   * `averageEntry` vuelve a null: es lo que distingue una liquidacion total de
   * una parcial, y de eso depende si el stop loss se retira o se conserva.
   */
  const liquidaEntera = (store: { applyFillToCycle: unknown }) => {
    (store.applyFillToCycle as jest.Mock).mockImplementation(async () => ({
      ...CYCLE,
      averageEntry: null,
    }));
  };

  it('se anota, mueve el ciclo y deja el bot en pausa', async () => {
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);

    adapter.fills$.next(fillLiq());
    await new Promise((r) => setTimeout(r, 60));

    expect(store.recordLiquidation).toHaveBeenCalled();
    // Lo que arregla el agujero: la pérdida entra en la contabilidad del ciclo.
    expect(store.applyFillToCycle).toHaveBeenCalled();
    // El venue se llevó también las órdenes en reposo; dejarlas OPEN haría que
    // el reconciliador persiguiera fantasmas en cada latido.
    expect(store.markCoidsCanceled).toHaveBeenCalled();
    expect(store.setStatus).toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
    await runner.dispose();
  });

  it('avisa con severidad CRÍTICA', async () => {
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);

    adapter.fills$.next(fillLiq());
    await new Promise((r) => setTimeout(r, 60));

    const evento = (store.event as jest.Mock).mock.calls.find((c) => c[1] === 'LIQUIDATED');
    expect(evento).toBeDefined();
    expect(evento?.[2]).toBe('CRITICAL');
    await runner.dispose();
  });

  /**
   * El control que protege el dinero real. Solo entra por el camino nuevo lo que
   * viene MARCADO: una ejecución que simplemente no reconocemos —un movimiento a
   * mano del usuario en el exchange, sin ir más lejos— se sigue descartando.
   */
  it('sin la marca, una ejecución desconocida se descarta como siempre', async () => {
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);

    adapter.fills$.next(fillLiq({ liquidation: undefined }));
    await new Promise((r) => setTimeout(r, 60));

    expect(store.recordLiquidation).not.toHaveBeenCalled();
    expect(store.applyFillToCycle).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
    await runner.dispose();
  });

  it('una liquidación de OTRO símbolo no es nuestra', async () => {
    // El stream es de la cuenta entera. Sin el filtro por símbolo, un bot se
    // colgaría la liquidación de su hermano.
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);

    adapter.fills$.next(fillLiq({ symbol: 'ETH' }));
    await new Promise((r) => setTimeout(r, 60));

    expect(store.recordLiquidation).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
    await runner.dispose();
  });

  it('un bot PLANO no se cuelga una liquidación que no es suya', async () => {
    // El usuario puede abrir a mano una posición en el mismo par de la misma
    // cuenta. Si se la liquidan, el bot —que no tenía nada— se metía en el ciclo
    // una posición que nunca tuvo y encima se pausaba solo.
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    // Sin `conPosicion`: el ciclo está plano, que es el caso.

    adapter.fills$.next(fillLiq());
    await new Promise((r) => setTimeout(r, 60));

    expect(store.recordLiquidation).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
    await runner.dispose();
  });

  it('la cancelación de las órdenes llega al VENUE, no solo a la base', async () => {
    // Marcarlas canceladas en la base ANTES dejaba `liveOrderCoids` vacío y la
    // cancelación no salía nunca: la base decía «canceladas» y el libro seguía
    // teniéndolas. Un venue no siempre se lleva por delante todo al liquidar.
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);
    liquidaEntera(store);

    adapter.fills$.next(fillLiq());
    await new Promise((r) => setTimeout(r, 60));

    expect(adapter.canceledOwn.length).toBeGreaterThan(0);
    // Y sin `keepProtective`: con la posición ya cerrada, el stop loss no
    // protege de nada y quedarse puesto es una orden suelta esperando.
    expect(adapter.canceledOwn.flat()).toContain('sl-1');
    await runner.dispose();
  });

  it('en una liquidación PARCIAL conserva el stop del resto', async () => {
    // Hyperliquid y Aster liquidan por partes: cierran lo justo para
    // restablecer el margen y dejan el resto abierto. Cancelar ahí el stop loss
    // dejaba una posición viva, sin defensa y sin bot que la mirara.
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);
    // Lo dice el VENUE, no el ciclo: queda posición abierta tras el cierre
    // forzoso, así que la liquidación fue parcial.
    adapter.position = {
      venue: Venue.HYPERLIQUID,
      symbol: 'BTC',
      qty: '0.6',
      entryPrice: '100',
      markPrice: '80',
      unrealizedPnl: '0',
      leverage: 10,
      marginMode: 'ISOLATED',
      liquidationPrice: null,
      marginUsed: '6',
    };

    adapter.fills$.next(fillLiq({ qty: '0.4' }));
    await new Promise((r) => setTimeout(r, 60));

    expect(store.setStatus).toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
    // `sl-1` es el stop: con posición viva NO se toca.
    expect(adapter.canceledOwn.flat()).not.toContain('sl-1');
    await runner.dispose();
  });

  it('lo PARCIAL lo dice el venue, no un ciclo que pudo derivar', async () => {
    // Con un hueco de ejecuciones sin ingerir, una liquidación mayor que lo que
    // el ciclo cree tener le da la vuelta a la posición en sus libros: creería
    // que sigue abierta, informaría de una liquidación «parcial» que no lo fue y
    // dejaría vivo un stop sobre una posición fantasma.
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);
    // El ciclo dice que queda posición…
    (store.applyFillToCycle as jest.Mock).mockImplementation(async () => ({
      ...CYCLE,
      averageEntry: '100',
    }));
    // …pero el venue dice que no queda nada.
    adapter.position = null;

    adapter.fills$.next(fillLiq());
    await new Promise((r) => setTimeout(r, 60));

    // Se trata como total: el stop se retira porque no hay nada que defender.
    expect(adapter.canceledOwn.flat()).toContain('sl-1');
    await runner.dispose();
  });

  it('una liquidación troceada avisa UNA vez, no una por trozo', async () => {
    // Cuatro ejecuciones de un mismo episodio daban cuatro mensajes críticos y
    // cuatro empujones de Telegram por algo que pasó una sola vez.
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);

    adapter.fills$.next(fillLiq({ venueFillId: 'f1', qty: '0.3' }));
    await new Promise((r) => setTimeout(r, 40));
    adapter.fills$.next(fillLiq({ venueFillId: 'f2', qty: '0.7' }));
    await new Promise((r) => setTimeout(r, 40));

    // Las dos se contabilizan —son cambios de posición reales—…
    expect((store.recordLiquidation as jest.Mock).mock.calls.length).toBe(2);
    // …pero el aviso se da una vez.
    const avisos = (store.event as jest.Mock).mock.calls.filter((c) => c[1] === 'LIQUIDATED');
    expect(avisos).toHaveLength(1);
    await runner.dispose();
  });

  it('avisa aunque el bot YA estuviera pausado', async () => {
    // El testigo era `paused`, asi que un bot pausado por una guarda de riesgo
    // —o por el usuario— se quedaba sin el aviso de que lo habian liquidado. Y
    // una guarda saltando es justo lo que suele preceder a una liquidacion.
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);
    liquidaEntera(store);
    await runner.handleCommand('PAUSE');
    (store.event as jest.Mock).mockClear();

    adapter.fills$.next(fillLiq());
    await new Promise((r) => setTimeout(r, 60));

    const avisos = (store.event as jest.Mock).mock.calls.filter((c) => c[1] === 'LIQUIDATED');
    expect(avisos).toHaveLength(1);
    await runner.dispose();
  });

  it('tras reanudar, una segunda liquidacion vuelve a avisar', async () => {
    // El testigo era una trampilla de un solo uso: al bot que reanudabas y
    // volvian a liquidar se le pausaba en memoria pero ni cambiaba de estado ni
    // avisaba, asi que la pantalla seguia diciendo RUNNING.
    const { runner, adapter, store } = build({ orders: [], immediate: [] }, sinOrden);
    await runner.start();
    conPosicion(runner);
    liquidaEntera(store);

    adapter.fills$.next(fillLiq({ venueFillId: 'f1' }));
    await new Promise((r) => setTimeout(r, 60));
    await runner.handleCommand('RESUME');
    conPosicion(runner);
    (store.event as jest.Mock).mockClear();

    adapter.fills$.next(fillLiq({ venueFillId: 'f2' }));
    await new Promise((r) => setTimeout(r, 60));

    const avisos = (store.event as jest.Mock).mock.calls.filter((c) => c[1] === 'LIQUIDATED');
    expect(avisos).toHaveLength(1);
    await runner.dispose();
  });

  it('la reentrega de la misma liquidación no se cuenta dos veces', async () => {
    // Llega por el WebSocket y otra vez por el barrido REST. `recordLiquidation`
    // devuelve null la segunda —choca contra la clave del coid sintético— y ahí
    // tiene que pararse.
    const { runner, adapter, store } = build(
      { orders: [], immediate: [] },
      {
        recordFill: jest.fn().mockResolvedValue(null),
        recordLiquidation: jest.fn().mockResolvedValue(null),
      },
    );
    await runner.start();
    conPosicion(runner);

    adapter.fills$.next(fillLiq());
    await new Promise((r) => setTimeout(r, 60));

    expect(store.applyFillToCycle).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
    await runner.dispose();
  });
});

// ─── Spec 063: los límites de riesgo llegan a un bot que ya está en marcha ──
//
// Los guards se leían una sola vez, al adoptar el bot, y no se releían jamás.
// Un usuario que subía su tope de apalancamiento de 10x a 25x se encontraba el
// bot pausado con «apalancamiento 25x por encima de tu límite (10x)» y sin
// forma de sacarlo de ahí: reanudar lo volvía a pausar en el tick siguiente.

describe('los límites de riesgo se releen con el bot vivo (spec 063)', () => {
  const tickDe = (runner: BotRunner) => (runner as unknown as { tick(): Promise<void> }).tick();
  const cuantos = (store: ReturnType<typeof fakeStore>, tipo: string) =>
    store.events.filter((e) => e === tipo).length;

  /** Guards completos con el tope de apalancamiento que se quiera. */
  const limites = (maxLeverage: number | null) => ({
    maxNotionalPerBot: null,
    maxDailyLoss: null,
    killSwitchDrawdownPct: null,
    liquidationAlertPct: null,
    maxLeverage,
    maxTotalNotional: null,
  });

  /** Un bot con apalancamiento 20 y el tope que diga la base en cada momento. */
  const conTope = (
    alAdoptar: number | null,
    enLaBase: number | null,
    startPaused = false,
    storeExtra: Partial<BotStore> = {},
  ) => {
    const riskGuards = jest.fn().mockResolvedValue(limites(enLaBase));
    const h = build(
      { orders: [], immediate: [] },
      { riskGuards, ...storeExtra },
      { leverage: 20 },
      limites(alAdoptar) as never,
      { startPaused },
    );
    return { ...h, riskGuards };
  };

  it('bajar el tope pausa un bot que ya estaba corriendo', async () => {
    // Sin esto, un tope nuevo no llegaba a un bot vivo hasta pararlo y
    // arrancarlo: el que ya operaba seguía con el suyo indefinidamente.
    const { runner, store } = conTope(null, 10);
    await runner.start();

    for (let i = 0; i < 5; i++) await tickDe(runner);

    expect(store.events).toContain('RISK_GUARD_TRIPPED');
    await runner.dispose();
  });

  it('subir el tope deja de pausar, borra el motivo caducado y NO reanuda', async () => {
    const { runner, store } = conTope(10, 25);
    await runner.start();
    expect(store.events).toContain('RISK_GUARD_TRIPPED');
    const pausas = cuantos(store, 'RISK_GUARD_TRIPPED');
    // El arranque escribió RUNNING antes de que la guarda lo pausara; lo que se
    // vigila es que nadie lo ponga a operar DESPUÉS.
    (store.setStatus as jest.Mock).mockClear();

    for (let i = 0; i < 5; i++) await tickDe(runner);

    // El motivo se borra sin tocar el estado: `setStatus` ata las dos cosas y
    // aquí el bot tiene que seguir pausado hasta que su dueño lo reanude.
    expect(store.setLastError).toHaveBeenCalledWith(BOT_ID, null);
    expect(cuantos(store, 'RISK_GUARD_CLEARED')).toBe(1);
    expect(cuantos(store, 'RISK_GUARD_TRIPPED')).toBe(pausas);
    expect(store.setStatus).not.toHaveBeenCalledWith(BOT_ID, 'RUNNING', expect.anything());
    await runner.dispose();
  });

  it('el motivo caducado se borra UNA vez, no en cada revisión', async () => {
    const { runner, store } = conTope(10, 25);
    await runner.start();

    for (let i = 0; i < 12; i++) await tickDe(runner);

    expect(cuantos(store, 'RISK_GUARD_CLEARED')).toBe(1);
    await runner.dispose();
  });

  it('reanudar tras subir el tope no rebota: el RESUME relee los límites', async () => {
    // El agujero de verdad: RESUME borraba el motivo, y el tick siguiente
    // volvía a pausar con el tope viejo. El usuario no tenía salida.
    const { runner, store, riskGuards } = conTope(10, 25);
    await runner.start();

    await runner.handleCommand('RESUME');
    await tickDe(runner);

    expect(riskGuards).toHaveBeenCalledWith('u1', { fresco: true });
    expect(cuantos(store, 'RISK_GUARD_TRIPPED')).toBe(1);
    expect(store.setStatus).toHaveBeenCalledWith(BOT_ID, 'RUNNING', { clearError: true });
    await runner.dispose();
  });

  it('un fallo leyendo los límites conserva los que había: nunca los relaja', async () => {
    // Lo contrario —quedarse sin guards porque la base no contesta— dejaría a
    // un bot fuera de límites operando durante la avería.
    const riskGuards = jest.fn().mockRejectedValue(new Error('base caída'));
    const { runner, store } = build(
      { orders: [], immediate: [] },
      { riskGuards },
      { leverage: 20 },
      limites(10) as never,
    );
    await runner.start();

    for (let i = 0; i < 5; i++) await tickDe(runner);

    expect(store.setLastError).not.toHaveBeenCalledWith(BOT_ID, null);
    expect(cuantos(store, 'RISK_GUARD_CLEARED')).toBe(0);
    await runner.dispose();
  });

  it('tras un relevo de worker, el bot adoptado en pausa también deja de mentir', async () => {
    // La marca de «lo pausó una guarda» vive en memoria y un relevo la pierde.
    // Se recupera de la base: el motivo a la vista y el último aviso de guarda.
    const { runner, store } = conTope(10, 25, true, {
      pausadoPorRiesgo: jest
        .fn()
        .mockResolvedValue('apalancamiento 20x por encima de tu límite (10x)'),
    });
    await runner.start();

    for (let i = 0; i < 5; i++) await tickDe(runner);

    expect(store.pausadoPorRiesgo).toHaveBeenCalledWith(BOT_ID);
    expect(store.setLastError).toHaveBeenCalledWith(BOT_ID, null);
    expect(cuantos(store, 'RISK_GUARD_CLEARED')).toBe(1);
    await runner.dispose();
  });

  it('sin marca de guarda, un motivo ajeno no se borra', async () => {
    // Un bot pausado a mano durante una caída del venue tiene su propio motivo
    // en la tarjeta; una guarda que no saltó no tiene nada que limpiar ahí.
    const { runner, store } = build(
      { orders: [], immediate: [] },
      {
        riskGuards: jest.fn().mockResolvedValue(limites(25)),
        pausadoPorRiesgo: jest.fn().mockResolvedValue(null),
      },
      { leverage: 20 },
      limites(25) as never,
      { startPaused: true },
    );
    await runner.start();

    for (let i = 0; i < 5; i++) await tickDe(runner);

    expect(store.setLastError).not.toHaveBeenCalledWith(BOT_ID, null);
    expect(cuantos(store, 'RISK_GUARD_CLEARED')).toBe(0);
    await runner.dispose();
  });
});

/**
 * Spec 065. El techo de quince minutos hacía que la serie de 1 h se bajara
 * CUATRO veces por hora para traer las mismas velas cerradas: la que cierra ya
 * la trae `faltaElCierre`, así que tres de cada cuatro descargas no aportaban
 * nada y gastaban cupo de una IP que comparten todos los bots del usuario.
 */
describe('ttlDeSerie: el refresco de una serie es el de su intervalo', () => {
  it('mientras haya un cierre que perseguir, manda el intervalo', () => {
    expect(ttlDeSerie('5m')).toBe(5 * 60_000);
    expect(ttlDeSerie('15m')).toBe(15 * 60_000);
    expect(ttlDeSerie('1h')).toBe(3_600_000);
    expect(ttlDeSerie('1d')).toBe(86_400_000);
  });

  it('por encima del día no hay cierre alineado, así que vuelve el techo', () => {
    // Las semanas empiezan en lunes y los meses no duran lo mismo:
    // `faltaElCierre` no calcula ahí el cierre esperado y nadie traería la vela.
    expect(ttlDeSerie('1w')).toBe(15 * 60_000);
  });
});
