import { Observable, Subject } from 'rxjs';
import {
  D,
  ExchangeError,
  Venue,
  type Balance,
  type BotContext,
  type Candle,
  type CycleState,
  type Decimal,
  type DesiredOrder,
  type DesiredState,
  type Fill,
  type MarginMode,
  type MarketSpec,
  type MarketTicker,
  type NivelApalancamiento,
  type OrderAck,
  type OrderUpdate,
  type PlaceOrderRequest,
  type Position,
  type PositionMode,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';
import {
  VENUE_CAPABILITIES,
  type AcuseApalancamiento,
  type ExchangeAdapter,
  type StreamHealth,
} from '@crypton/exchange-core';
import { makeCoid } from '@crypton/strategy-core';
import { BotRunner, type BotRunnerDeps } from './bot-runner';
import type { BotRecord, BotStore } from './bot-store';

/**
 * Spec 074, R-8. El runner con la operación de un agente: recibe del canal lo
 * que no depende de las intenciones de su IA —pausar, avisos, el apalancamiento
 * de cada entrada, tramos y límites, el vigilante del stop, la protección en
 * pausa y el barrido tras cerrar—, cumple su `detener` y avisa de la salida con
 * su R. La estrategia es un doble: lo que se prueba es lo que hace el MOTOR.
 */

const BOT_ID = '7a8b9c0d-0000-4000-8000-000000000000';
const SEQ = 1;
const HL = Venue.HYPERLIQUID;

const MARKET: MarketSpec = {
  venue: HL,
  symbol: 'SOL',
  canonical: 'SOL/USDC',
  base: 'SOL',
  quote: 'USDC',
  tickSize: '0.01',
  stepSize: '0.001',
  minNotional: '10',
  minQty: null,
  maxQty: null,
  maxLeverage: 20,
  priceDecimals: 2,
  qtyDecimals: 3,
  active: true,
};

const TIERS: NivelApalancamiento[] = [
  { desdeNocional: '0', maxApalancamiento: 20, mantenimiento: 0.02 },
];

const esperar = (ms = 20) => new Promise((r) => setTimeout(r, ms));

class FakeAdapter implements ExchangeAdapter {
  readonly venue: Venue = HL;
  readonly capabilities = VENUE_CAPABILITIES[HL];
  readonly requests: PlaceOrderRequest[] = [];
  readonly fills$ = new Subject<Fill>();
  ticker: Ticker = {
    venue: HL,
    symbol: 'SOL',
    last: '100',
    bid: '99.99',
    ask: '100.01',
    mark: '100',
    ts: Date.now(),
  };
  position: Position | null = null;
  openOrders: VenueOrder[] = [];
  acuseDe: (leverage: number) => AcuseApalancamiento | void = (leverage) => ({ leverage });
  fallaAl: (req: PlaceOrderRequest) => Error | null = () => null;
  recentFillsCalls = 0;

  constructor(private readonly orden: string[]) {}

  verify = async () => ({ ok: true, publicRef: 'fake' });
  getMarkets = async (): Promise<MarketSpec[]> => [MARKET];
  getTickers = async (): Promise<MarketTicker[]> => [];
  getCandles = async (): Promise<Candle[]> => [];
  getBalances = async (): Promise<Balance[]> => [
    { asset: 'USDC', total: '1000', available: '1000', used: '0' },
  ];
  getPositions = async (): Promise<Position[]> => (this.position ? [this.position] : []);
  getOpenOrders = async (): Promise<VenueOrder[]> => this.openOrders;
  getRecentFills = async (): Promise<Fill[]> => {
    this.recentFillsCalls++;
    return [];
  };
  getTicker = async (): Promise<Ticker> => ({ ...this.ticker, ts: Date.now() });

  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    this.orden.push('place:' + req.clientOrderId);
    const fallo = this.fallaAl(req);
    if (fallo) throw fallo;
    this.requests.push(req);
    return {
      clientOrderId: req.clientOrderId,
      venueOrderId: 'v-' + req.clientOrderId,
      status: 'OPEN',
      ts: Date.now(),
    };
  }

  async setLeverage(_s: string, leverage: number, mode: MarginMode) {
    this.orden.push(`setLeverage:${leverage}:${mode}`);
    return this.acuseDe(leverage);
  }

  getLeverageTiers?: (symbol: string) => Promise<NivelApalancamiento[]> = async () => TIERS;
  getPositionMode?: () => Promise<PositionMode> = async () => 'ONE_WAY';

  cancelOrder = async () => undefined;
  cancelOwn = jest.fn(async (_s: string, coids: string[]) => {
    this.orden.push('cancelOwn:' + coids.join(','));
  });
  cancelAll = async () => undefined;
  streamOrders = (): Observable<OrderUpdate> => new Subject<OrderUpdate>().asObservable();
  streamFills = (): Observable<Fill> => this.fills$.asObservable();
  streamTicker = (): Observable<Ticker> => new Subject<Ticker>().asObservable();
  streamHealth = (): Observable<StreamHealth> => new Subject<StreamHealth>().asObservable();
  close = async () => undefined;
}

function fakeStore(orden: string[]) {
  const events: { type: string; severity: string; message: string; payload?: unknown }[] = [];
  const scratches: Record<string, unknown>[] = [];
  return {
    events,
    scratches,
    setStatus: jest.fn().mockResolvedValue(undefined),
    setLastError: jest.fn().mockResolvedValue(undefined),
    touchTick: jest.fn().mockResolvedValue(undefined),
    event: jest.fn(
      async (_bot: unknown, type: string, severity: string, message: string, payload?: unknown) => {
        events.push({ type, severity, message, payload });
      },
    ),
    findOrderByCoid: jest.fn().mockResolvedValue(null),
    upsertPendingOrder: jest.fn().mockResolvedValue(undefined),
    confirmOrder: jest.fn().mockResolvedValue(undefined),
    rejectOrder: jest.fn().mockResolvedValue(undefined),
    markOrderCanceled: jest.fn().mockResolvedValue(undefined),
    markCoidsCanceled: jest.fn().mockResolvedValue(undefined),
    syncOrderState: jest.fn().mockResolvedValue(undefined),
    liveOrderCoids: jest.fn(async (_id: string, _o: { keepProtective?: boolean }) => [
      makeCoid(BOT_ID, SEQ, 'STOP_LOSS', 0),
    ]),
    ownVenueClientIds: jest.fn().mockResolvedValue([]),
    saveSnapshot: jest.fn().mockResolvedValue(undefined),
    saveCycleScratch: jest.fn(async (_id: string, scratch: Record<string, unknown>) => {
      orden.push('scratch');
      scratches.push(scratch);
    }),
    marketSpec: jest.fn().mockResolvedValue(MARKET),
    riskGuards: jest.fn().mockResolvedValue({
      maxNotionalPerBot: null,
      maxDailyLoss: null,
      killSwitchDrawdownPct: null,
      liquidationAlertPct: null,
      maxLeverage: null,
      maxTotalNotional: null,
    }),
    pausadoPorRiesgo: jest.fn().mockResolvedValue(null),
    drawdownPct: () => D(0),
    todayRealizedPnl: jest.fn().mockResolvedValue(D(0)),
    todayRealizedPnlForBot: jest.fn().mockResolvedValue(D(0)),
    repairCycleFromVenue: jest.fn().mockResolvedValue(null),
    historialOperaciones: jest.fn().mockResolvedValue(null),
    olvidarHistorial: jest.fn(),
    recordFill: jest.fn().mockResolvedValue(makeCoid(BOT_ID, SEQ, 'STOP_LOSS', 0)),
    recordLiquidation: jest.fn().mockResolvedValue(null),
    applyFillToCycle: jest.fn(
      async (
        _id: string,
        cycle: CycleState,
        _fill?: Fill,
        _opts?: { eventoCierre?: (c: { seq: number; pnl: Decimal }) => unknown },
      ) => cycle,
    ),
  };
}

function fakeIntents() {
  return {
    vigente: jest.fn().mockResolvedValue(null),
    solicitar: jest.fn().mockResolvedValue(true),
    anotar: jest.fn().mockResolvedValue(true),
    abrir: jest.fn().mockResolvedValue(true),
    valeDePausa: jest.fn().mockResolvedValue(null),
    cerrar: jest.fn().mockResolvedValue(undefined),
    caducarPendientes: jest.fn().mockResolvedValue(0),
  };
}

const BOT = {
  id: BOT_ID,
  user_id: 'admin-1',
  exchange_account_id: 'acc-1',
  venue: HL,
  symbol: 'SOL',
  strategy: 'AGENT_TRADE',
  direction: 'LONG',
  leverage: 5,
  margin_mode: 'ISOLATED',
  config_version: 1,
  dry_run: false,
  total_investment: '20',
} as unknown as BotRecord;

/** Los flags de la operación de un agente. */
const AGENTE = {
  kind: 'AGENT_TRADE',
  apalancamientoPorOperacion: true,
  stopPropio: true,
  reglaLiquidacion: 'POR_STOP',
};

const ENTRADA: DesiredOrder = {
  clientOrderId: makeCoid(BOT_ID, SEQ, 'BASE', 0),
  levelKind: 'BASE',
  levelIndex: 0,
  side: 'BUY',
  type: 'LIMIT',
  timeInForce: 'IOC',
  price: '100.10',
  qty: '1.000',
  reduceOnly: false,
};

const STOP: DesiredOrder = {
  clientOrderId: makeCoid(BOT_ID, SEQ, 'STOP_LOSS', 0),
  levelKind: 'STOP_LOSS',
  levelIndex: 0,
  side: 'SELL',
  type: 'MARKET',
  price: '98.00',
  triggerPrice: '98.00',
  qty: '1.000',
  reduceOnly: true,
};

const planEntrada = (over: Partial<DesiredState> = {}): DesiredState => ({
  orders: [ENTRADA],
  immediate: [],
  apalancamiento: 5,
  scratchPatch: { op: { intento: 0, enviadaEn: 1, stopInicial: '98' }, intentos: 1 },
  note: 'Entrada larga.',
  ...over,
});

const largo = (qty = '1'): Position => ({
  venue: HL,
  symbol: 'SOL',
  qty,
  entryPrice: '100',
  markPrice: '100',
  unrealizedPnl: '0',
  leverage: 5,
  marginMode: 'ISOLATED',
  liquidationPrice: '81',
  marginUsed: '20',
});

interface Opciones {
  plan?: DesiredState | ((ctx: BotContext) => DesiredState);
  deps?: Partial<BotRunnerDeps>;
  scratch?: Record<string, unknown>;
  flags?: Record<string, unknown>;
}

function montar(o: Opciones = {}) {
  const orden: string[] = [];
  const adapter = new FakeAdapter(orden);
  const store = fakeStore(orden);
  const intents = fakeIntents();
  const detached: string[] = [];
  const contextos: BotContext[] = [];
  const runner = new BotRunner({
    bot: BOT,
    adapter,
    testnet: false,
    market: MARKET,
    config: { leverage: 5, riskAmount: '2.2' } as never,
    cycle: {
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
      scratch: { cycleSeq: SEQ, ...o.scratch },
    },
    store: store as unknown as BotStore,
    guards: {
      maxNotionalPerBot: null,
      maxDailyLoss: null,
      killSwitchDrawdownPct: null,
      liquidationAlertPct: null,
      maxLeverage: null,
      maxTotalNotional: null,
    },
    reconcileIntervalMs: 600_000,
    intents,
    // El interruptor del CANAL cerrado: a la operación de un agente no le toca.
    interruptorCanal: async () => ({ permitidas: false, motivo: 'cortadas en la consola' }),
    onDetach: (id) => detached.push(id),
    ...o.deps,
  });
  const plan = o.plan ?? { orders: [], immediate: [] };
  (runner as unknown as { strategy: unknown }).strategy = {
    ...AGENTE,
    ...o.flags,
    plan: (ctx: BotContext) => {
      contextos.push(ctx);
      return typeof plan === 'function' ? plan(ctx) : plan;
    },
  };
  const tick = () =>
    (
      runner as unknown as {
        exclusive(f: () => Promise<void>): Promise<void>;
        tick(): Promise<void>;
      }
    ).exclusive(() => (runner as unknown as { tick(): Promise<void> }).tick());
  const eventos = (tipo: string) => store.events.filter((e) => e.type === tipo);
  return { runner, adapter, store, intents, orden, detached, contextos, tick, eventos };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('la operación de un agente en el runner (spec 074, R-8)', () => {
  describe('la entrada', () => {
    it('el apalancamiento de la operación antes de la orden, sin nada del canal', async () => {
      const h = montar({ plan: planEntrada() });

      await h.runner.start();

      expect(h.orden).toEqual([
        'scratch',
        'setLeverage:5:ISOLATED',
        'place:' + ENTRADA.clientOrderId,
      ]);
      // Sin intenciones ni historial, y el interruptor del canal no la corta.
      expect(h.intents.vigente).not.toHaveBeenCalled();
      expect(h.store.historialOperaciones).not.toHaveBeenCalled();
      expect(h.contextos[0].limites).toMatchObject({ entradasPermitidas: true, venueListo: true });
      expect(h.contextos[0].nivelesApalancamiento).toEqual(TIERS);
      expect(h.contextos[0].decisionIa).toBeUndefined();
      await h.runner.dispose();
    });

    it('si el exchange aplica otro apalancamiento, no entra, olvida la operación y avisa una vez', async () => {
      const h = montar({ plan: planEntrada() });
      h.adapter.acuseDe = () => ({ leverage: 3 });

      await h.runner.start();
      await h.tick();

      expect(h.adapter.requests).toEqual([]);
      expect(h.store.scratches.at(-1)?.['op']).toBeNull();
      expect(h.eventos('AGENT_ENTRY_DISCARDED')).toHaveLength(1);
      expect(h.eventos('AGENT_ENTRY_DISCARDED')[0].message).toMatch(/3x en vez de 5x/);
      await h.runner.dispose();
    });

    it('con una posición abierta no entra', async () => {
      const h = montar({ plan: planEntrada() });
      h.adapter.position = largo();

      await h.runner.start();

      expect(h.adapter.requests.filter((r) => !r.reduceOnly)).toEqual([]);
      expect(h.eventos('AGENT_ENTRY_DISCARDED')[0].message).toMatch(/posición abierta/);
      await h.runner.dispose();
    });
  });

  it('los avisos de la estrategia, una vez por clave', async () => {
    const aviso = {
      clave: 'be:1',
      tipo: 'AGENT_BREAKEVEN',
      severidad: 'INFO' as const,
      mensaje: 'BE',
    };
    const h = montar({ plan: { orders: [], immediate: [], avisos: [aviso] } });

    await h.runner.start();
    await h.tick();

    expect(h.eventos('AGENT_BREAKEVEN')).toHaveLength(1);
    await h.runner.dispose();
  });

  it('si la estrategia pide pausar, se pausa', async () => {
    const h = montar({ plan: { orders: [], immediate: [], pausar: 'motivo de prueba' } });

    await h.runner.start();

    expect(h.store.setStatus).toHaveBeenCalledWith(BOT_ID, 'PAUSED', { error: 'motivo de prueba' });
    await h.runner.dispose();
  });

  it('el vigilante del stop también la vigila: sin stop confirmado, se cierra a mercado', async () => {
    let reloj = Date.UTC(2026, 8, 24, 10);
    jest.spyOn(Date, 'now').mockImplementation(() => reloj);
    const h = montar({ plan: { orders: [STOP], immediate: [] } });
    h.adapter.position = largo();
    h.adapter.fallaAl = (req) =>
      req.clientOrderId === STOP.clientOrderId
        ? new ExchangeError('RULES', 'trigger price too far', HL)
        : null;

    await h.runner.start();
    reloj += 6_000;
    await h.tick();

    expect(h.orden).toContain('place:' + makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 999));
    expect(h.eventos('SIN_STOP')[0].severity).toBe('CRITICAL');
    await h.runner.dispose();
  });

  describe('detener', () => {
    it('cancela todo lo propio, también el stop, para el bot y lo suelta', async () => {
      const h = montar({
        plan: { orders: [], immediate: [], detener: 'CERRADA', note: 'La operación ha terminado.' },
      });

      await h.runner.start();

      expect(h.store.liveOrderCoids).toHaveBeenLastCalledWith(BOT_ID, { keepProtective: false });
      expect(h.adapter.cancelOwn).toHaveBeenCalled();
      expect(h.store.setStatus).toHaveBeenCalledWith(BOT_ID, 'STOPPED');
      const parado = h.eventos('BOT_STOPPED')[0];
      expect(parado.message).toMatch(/CERRADA/);
      expect(parado.payload).toEqual({ motivo: 'CERRADA' });
      expect(h.detached).toEqual([BOT_ID]);
      await h.runner.dispose();
    });

    it('con una posición ajena no conserva ningún stop ni lo anuncia', async () => {
      const h = montar({ plan: { orders: [], immediate: [], detener: 'POSICION_AJENA' } });
      h.adapter.position = largo();

      await h.runner.start();

      expect(h.eventos('ACTION_FAILED')).toEqual([]);
      expect(h.store.liveOrderCoids).toHaveBeenLastCalledWith(BOT_ID, { keepProtective: false });
      expect(h.detached).toEqual([BOT_ID]);
      await h.runner.dispose();
    });
  });

  it('en pausa, repone el stop con su propio contexto, sin intenciones', async () => {
    const h = montar({ plan: { orders: [STOP], immediate: [] }, deps: { startPaused: true } });
    h.adapter.position = largo();

    await h.runner.start();

    expect(h.orden).toContain('place:' + STOP.clientOrderId);
    expect(h.intents.vigente).not.toHaveBeenCalled();
    await h.runner.dispose();
  });

  it('parar y cerrar barre las ejecuciones antes de soltar el bot: sin ellas no hay R', async () => {
    const h = montar();
    await h.runner.start();
    h.adapter.position = largo();
    const antes = h.adapter.recentFillsCalls;

    await h.runner.handleCommand('STOP_AND_CLOSE');

    expect(h.adapter.recentFillsCalls).toBeGreaterThan(antes);
    expect(h.detached).toEqual([BOT_ID]);
    await h.runner.dispose();
  });

  describe('el aviso de salida', () => {
    const fill = (): Fill => ({
      venue: HL,
      symbol: 'SOL',
      venueFillId: 'f1',
      clientOrderId: 'x',
      venueOrderId: 'v1',
      side: 'SELL',
      price: '98',
      qty: '1',
      fee: '0.1',
      feeAsset: 'USDC',
      ts: Date.now(),
    });

    async function salida(coid: string, pnl: string, scratch: Record<string, unknown> = {}) {
      const h = montar({ scratch });
      h.store.recordFill.mockResolvedValue(coid);
      let evento: unknown = null;
      h.store.applyFillToCycle.mockImplementation(async (_id, cycle, _fill, opts) => {
        evento = opts?.eventoCierre?.({ seq: SEQ, pnl: D(pnl) }) ?? null;
        return { ...cycle, scratch: { cycleSeq: SEQ + 1 } };
      });
      await h.runner.start();
      h.adapter.fills$.next(fill());
      await esperar();
      await h.runner.dispose();
      return evento as { type: string; message: string; payload: Record<string, unknown> } | null;
    }

    it('por el stop, con su R sobre la pérdida al stop declarada', async () => {
      const e = await salida(makeCoid(BOT_ID, SEQ, 'STOP_LOSS', 0), '-2.2');
      expect(e?.type).toBe('AGENT_EXIT');
      expect(e?.payload).toMatchObject({ r: -1, motivo: 'STOP' });
    });

    it('por un objetivo y por tiempo', async () => {
      const objetivo = await salida(makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 1), '4.4');
      expect(objetivo?.payload).toMatchObject({ r: 2, motivo: 'OBJETIVO' });
      const tiempo = await salida(makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 500), '0.5', {
        cierre: { motivo: 'TIEMPO', intentos: 1, ultimoEn: 1 },
      });
      expect(tiempo?.payload).toMatchObject({ motivo: 'TIEMPO' });
    });

    it('un cierre del motor dice quién lo pidió: el vigilante o su dueño', async () => {
      const cierre = makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 999);
      const motivoTras = async (antes: (h: ReturnType<typeof montar>) => Promise<void>) => {
        const h = montar();
        h.store.recordFill.mockResolvedValue(cierre);
        let evento: { payload: Record<string, unknown> } | null = null;
        h.store.applyFillToCycle.mockImplementation(async (_id, cycle, _fill, opts) => {
          evento = (opts?.eventoCierre?.({ seq: SEQ, pnl: D('-1') }) ?? null) as typeof evento;
          return cycle;
        });
        await h.runner.start();
        await antes(h);
        h.adapter.fills$.next(fill());
        await esperar();
        await h.runner.dispose();
        return evento?.['payload']?.['motivo'];
      };
      // Su dueño cierra a mano.
      expect(
        await motivoTras(async (h) => {
          h.adapter.position = largo();
          await h.runner.handleCommand('CLOSE_NOW');
        }),
      ).toBe('MANUAL');
      // El vigilante: sin stop confirmado, cierra él.
      expect(
        await motivoTras(async (h) => {
          (h.runner as unknown as { salidaDelMotor: string }).salidaDelMotor = 'SEGURIDAD';
        }),
      ).toBe('SEGURIDAD');
    });

    it('una estrategia que no es de un agente cierra con el evento de siempre', async () => {
      const h = montar({ flags: { kind: 'TREND_FOLLOW' } });
      (h.runner as unknown as { deps: { bot: BotRecord } }).deps.bot = {
        ...BOT,
        strategy: 'TREND_FOLLOW',
      } as unknown as BotRecord;
      await h.runner.start();
      h.adapter.fills$.next(fill());
      await esperar();
      expect(h.store.applyFillToCycle.mock.calls[0][3]).not.toHaveProperty('eventoCierre');
      await h.runner.dispose();
    });
  });
});
