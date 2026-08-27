import { Observable, Subject } from 'rxjs';
import {
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
import type { ExchangeAdapter, StreamHealth } from '@crypton/exchange-core';
import { makeCoid } from '@crypton/strategy-core';
import { BotRunner } from './bot-runner';
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
  readonly canceledOwn: string[][] = [];

  readonly fills$ = new Subject<Fill>();
  readonly orders$ = new Subject<OrderUpdate>();
  readonly ticker$ = new Subject<Ticker>();
  readonly health$ = new Subject<StreamHealth>();

  /** Si es null, `getTicker` falla: simula un venue que no responde. */
  ticker: Ticker | null = TICKER;
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
  const store = {
    events,
    payloads,
    cycleCalls,
    setStatus: jest.fn().mockResolvedValue(undefined),
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

    /** Aqui si se cierra la posicion, asi que el stop debe irse con ella. */
    it('STOP_AND_CLOSE se lleva el stop por delante', async () => {
      const { runner, adapter } = build({ orders: [], immediate: [] });
      adapter.position = conPos();
      await runner.start();
      await runner.handleCommand('STOP_AND_CLOSE');

      expect(adapter.canceledOwn.at(-1)).toContain('sl-1');
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
     * `stopLossPct` lo inyecta `COMMON_FIELDS` en las siete estrategias, pero
     * solo martingale y tdca lo leian: en las otras cinco el campo salia en el
     * formulario y no colocaba nada. Ahora lo emite el motor, asi que da igual
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
    it('pausa tras varios ticks seguidos fallando', async () => {
      const adapter = new FakeAdapter();
      adapter.ticker = null; // `getTicker` lanza RETRYABLE.
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
