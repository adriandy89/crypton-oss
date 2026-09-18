import { Observable, Subject } from 'rxjs';
import {
  D,
  ExchangeError,
  Venue,
  type Decimal,
  type Balance,
  type BotContext,
  type Candle,
  type CandleInterval,
  type CycleState,
  type DesiredOrder,
  type DesiredState,
  type Fill,
  type HistorialOperaciones,
  type MarcaDecision,
  type MarginAction,
  type MarginMode,
  type MarketSpec,
  type MarketTicker,
  type NivelApalancamiento,
  type OrderAck,
  type OrderUpdate,
  type PlaceOrderRequest,
  type PlanOperacion,
  type Position,
  type PositionMode,
  type PositionSide,
  type SolicitudIa,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';
import {
  VENUE_CAPABILITIES,
  hyperliquidCodec,
  type AcuseApalancamiento,
  type ExchangeAdapter,
  type StreamHealth,
} from '@crypton/exchange-core';
import { makeCoid } from '@crypton/strategy-core';
import { BotRunner, type BotRunnerDeps, type CandleSourceLike } from './bot-runner';
import type { BotRecord, BotStore, RiskGuards } from './bot-store';

/**
 * Spec 058. El runner con una estrategia que consume las intenciones del canal
 * con IA. La estrategia es un doble que devuelve el plan que pide cada test: lo
 * que se prueba es lo que el MOTOR hace con él, y sobre todo lo que no deja
 * pasar hacia el venue.
 */

const BOT_ID = '5e6f7a8b-0000-4000-8000-000000000000';
const SEQ = 2;
const HL = Venue.HYPERLIQUID;

const MARKET: MarketSpec = {
  venue: HL,
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

const TIERS: NivelApalancamiento[] = [
  { desdeNocional: '0', maxApalancamiento: 40, mantenimiento: 0.0125 },
];

const HISTORIAL: HistorialOperaciones = {
  dia: Date.UTC(2026, 8, 17),
  operacionesHoy: 0,
  realizadoHoy: '0',
  rachaPerdidas: 0,
  ultimoCierreEn: null,
  ultimaPerdidaEn: null,
  ultimoStopEn: null,
  realizadoTotal: '0',
  picoRealizado: '0',
};

const esperar = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** El vale del botón de pausa del aviso de entrada (spec 059). */
const VALE = '0123456789abcdef0123456789abcdef';

class FakeAdapter implements ExchangeAdapter {
  readonly venue: Venue = HL;
  readonly capabilities = VENUE_CAPABILITIES[HL];
  readonly requests: PlaceOrderRequest[] = [];
  readonly fills$ = new Subject<Fill>();
  ticker: Ticker = {
    venue: HL,
    symbol: 'BTC',
    last: '100',
    bid: '99.9',
    ask: '100.1',
    mark: '100',
    ts: Date.now(),
  };
  position: Position | null = null;
  openOrders: VenueOrder[] = [];
  acuseDe: (leverage: number) => AcuseApalancamiento | void = (leverage) => ({ leverage });
  leverageError: Error | null = null;
  /** Falla la colocación de las órdenes que diga. */
  fallaAl: (req: PlaceOrderRequest) => Error | null = () => null;
  tiers: NivelApalancamiento[] | Error = TIERS;
  tierCalls = 0;
  modo: PositionMode | Error = 'ONE_WAY';
  modoCalls = 0;

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
  getRecentFills = async (): Promise<Fill[]> => [];
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
    if (this.leverageError) throw this.leverageError;
    return this.acuseDe(leverage);
  }

  getLeverageTiers?: (symbol: string) => Promise<NivelApalancamiento[]> = async () => {
    this.tierCalls++;
    if (this.tiers instanceof Error) throw this.tiers;
    return this.tiers;
  };

  getPositionMode?: () => Promise<PositionMode> = async () => {
    this.modoCalls++;
    if (this.modo instanceof Error) throw this.modo;
    return this.modo;
  };

  readonly marginCalls: { amount: string; action: MarginAction; side: PositionSide }[] = [];
  async adjustIsolatedMargin(_s: string, amount: string, action: MarginAction, side: PositionSide) {
    this.marginCalls.push({ amount, action, side });
  }

  cancelOrder = async () => undefined;
  cancelOwn = async () => undefined;
  cancelAll = async () => undefined;
  streamOrders = (): Observable<OrderUpdate> => new Subject<OrderUpdate>().asObservable();
  streamFills = (): Observable<Fill> => this.fills$.asObservable();
  streamTicker = (): Observable<Ticker> => new Subject<Ticker>().asObservable();
  streamHealth = (): Observable<StreamHealth> => new Subject<StreamHealth>().asObservable();
  close = async () => undefined;
}

function fakeStore(orden: string[]) {
  const events: { type: string; severity: string; message: string }[] = [];
  const scratches: Record<string, unknown>[] = [];
  const store = {
    events,
    scratches,
    setStatus: jest.fn().mockResolvedValue(undefined),
    setLastError: jest.fn().mockResolvedValue(undefined),
    touchTick: jest.fn().mockResolvedValue(undefined),
    event: jest.fn(async (_bot: unknown, type: string, severity: string, message: string) => {
      events.push({ type, severity, message });
    }),
    findOrderByCoid: jest.fn().mockResolvedValue(null),
    upsertPendingOrder: jest.fn().mockResolvedValue(undefined),
    confirmOrder: jest.fn().mockResolvedValue(undefined),
    rejectOrder: jest.fn().mockResolvedValue(undefined),
    markOrderCanceled: jest.fn().mockResolvedValue(undefined),
    markCoidsCanceled: jest.fn().mockResolvedValue(undefined),
    syncOrderState: jest.fn().mockResolvedValue(undefined),
    liveOrderCoids: jest.fn().mockResolvedValue([]),
    ownVenueClientIds: jest.fn().mockResolvedValue([]),
    saveSnapshot: jest.fn().mockResolvedValue(undefined),
    saveCycleScratch: jest.fn(async (_id: string, scratch: Record<string, unknown>) => {
      orden.push('scratch');
      scratches.push(scratch);
    }),
    marketSpec: jest.fn().mockResolvedValue(MARKET),
    drawdownPct: (inversion: string, equity: string) =>
      D(equity).gte(0) ? D(0) : D(equity).abs().div(inversion).mul(100),
    todayRealizedPnl: jest.fn().mockResolvedValue(D(0)),
    todayRealizedPnlForBot: jest.fn().mockResolvedValue(D(0)),
    repairCycleFromVenue: jest.fn().mockResolvedValue(null),
    historialOperaciones: jest.fn().mockResolvedValue(HISTORIAL),
    olvidarHistorial: jest.fn(),
    recordFill: jest.fn().mockResolvedValue(makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 0)),
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
  return store;
}

function fakeIntents(orden: string[]) {
  return {
    vigente: jest.fn().mockResolvedValue(null),
    solicitar: jest.fn().mockResolvedValue(true),
    anotar: jest.fn(async (_bot: string, _seq: number, marca: MarcaDecision) => {
      orden.push(`anotar:${marca.estado}`);
      return true;
    }),
    abrir: jest.fn().mockResolvedValue(true),
    valeDePausa: jest.fn().mockResolvedValue(VALE),
    cerrar: jest.fn().mockResolvedValue(undefined),
    caducarPendientes: jest.fn().mockResolvedValue(0),
  };
}

const CYCLE: CycleState = {
  cycleId: 'c2',
  startedAt: Date.now(),
  entriesFilled: 0,
  lastEntryAt: null,
  filledLevelIndexes: [],
  cooldownUntil: null,
  realizedPnl: '0',
  realizedPnlAcc: '0',
  averageEntry: null,
  anchorPrice: null,
  scratch: { cycleSeq: SEQ },
};

const BOT = {
  id: BOT_ID,
  user_id: 'admin-1',
  exchange_account_id: 'acc-1',
  venue: HL,
  symbol: 'BTC',
  strategy: 'AI_CHANNEL',
  direction: 'NEUTRAL',
  leverage: 25,
  margin_mode: 'ISOLATED',
  config_version: 1,
  dry_run: false,
  total_investment: '1000',
} as unknown as BotRecord;

/** Los flags de la estrategia del canal. */
const CANAL = {
  kind: 'AI_CHANNEL',
  consumeDecisionesIa: true,
  apalancamientoPorOperacion: true,
  stopPropio: true,
  reglaLiquidacion: 'POR_STOP',
  topeDiarioReanuda: true,
};

const ENTRADA: DesiredOrder = {
  clientOrderId: makeCoid(BOT_ID, SEQ, 'BASE', 0),
  levelKind: 'BASE',
  levelIndex: 0,
  side: 'BUY',
  type: 'LIMIT',
  timeInForce: 'IOC',
  price: '100.2',
  qty: '0.500',
  reduceOnly: false,
};

const STOP: DesiredOrder = {
  clientOrderId: makeCoid(BOT_ID, SEQ, 'STOP_LOSS', 0),
  levelKind: 'STOP_LOSS',
  levelIndex: 0,
  side: 'SELL',
  type: 'MARKET',
  price: '97.0',
  triggerPrice: '97.0',
  qty: '1.000',
  reduceOnly: true,
};

/** Una operación guardada entera, como la deja la estrategia (spec 059). */
const OP_COMPLETA = {
  plan: {
    intentId: 'ia-1',
    candidatoId: 'REB-L-H1',
    setup: 'REBOTE',
    lado: 'LONG',
    eleccion: {},
    entradaReferencia: '100.1',
    entradaTope: '100.2',
    stop: '97.0',
    objetivos: [
      { precio: '103.0', cantidad: '0.600' },
      { precio: '104.5', cantidad: '0.400' },
    ],
    cantidad: '1.000',
    apalancamiento: 12,
    nocional: '100.2',
    riesgo: '3.25',
    rNeto: 1.5,
    liquidacionEstimada: '92.0',
    huella: 'h',
    barT: 1,
    canal: {
      tipo: 'HORIZONTAL',
      soporte: '98',
      resistencia: '105',
      media: '101.5',
      pendientePorVela: 0,
      refT: 1,
    },
    venceEn: 9_999_999_999_999,
    distanciaStop: 0.03,
  },
  intento: 0,
  enviadaEn: 1,
};

const MARCA: MarcaDecision = {
  intentId: 'ia-1',
  estado: 'ACEPTADA',
  motivo: null,
  plan: { intentId: 'ia-1', candidatoId: 'REB-L-H1' } as PlanOperacion,
};

/** El plan de una entrada, como lo devuelve la estrategia del canal. */
const planEntrada = (over: Partial<DesiredState> = {}): DesiredState => ({
  orders: [ENTRADA],
  immediate: [],
  apalancamiento: 12,
  decision: MARCA,
  scratchPatch: { op: { plan: { intentId: 'ia-1' }, intento: 0, enviadaEn: 1 }, intentos: 1 },
  note: 'Entrada larga.',
  ...over,
});

const largo = (qty = '1', entrada = '100', liquidacion: string | null = '96'): Position => ({
  venue: HL,
  symbol: 'BTC',
  qty,
  entryPrice: entrada,
  markPrice: entrada,
  unrealizedPnl: '0',
  leverage: 12,
  marginMode: 'ISOLATED',
  liquidationPrice: liquidacion,
  marginUsed: '8',
});

interface Opciones {
  plan?: DesiredState | ((ctx: BotContext) => DesiredState);
  flags?: Record<string, unknown>;
  deps?: Partial<BotRunnerDeps>;
  config?: Record<string, unknown>;
  guards?: Partial<RiskGuards>;
  bot?: Partial<Record<keyof BotRecord, unknown>>;
  scratch?: Record<string, unknown>;
  series?: (c: unknown) => { interval: CandleInterval; bars: number }[];
}

function montar(o: Opciones = {}) {
  const orden: string[] = [];
  const adapter = new FakeAdapter(orden);
  const store = fakeStore(orden);
  const intents = fakeIntents(orden);
  const detached: string[] = [];
  const contextos: BotContext[] = [];
  const runner = new BotRunner({
    bot: { ...BOT, ...o.bot } as BotRecord,
    adapter,
    testnet: false,
    market: MARKET,
    config: { leverage: 5, maxDailyLossPct: 6, ...o.config } as never,
    cycle: { ...CYCLE, scratch: { cycleSeq: SEQ, ...o.scratch } },
    store: store as unknown as BotStore,
    guards: {
      maxNotionalPerBot: null,
      maxDailyLoss: null,
      killSwitchDrawdownPct: null,
      liquidationAlertPct: null,
      maxLeverage: null,
      maxTotalNotional: null,
      ...o.guards,
    },
    reconcileIntervalMs: 600_000,
    intents,
    interruptorCanal: async () => ({ permitidas: true, motivo: null }),
    onDetach: (id) => detached.push(id),
    ...o.deps,
  });
  const plan = o.plan ?? { orders: [], immediate: [] };
  (runner as unknown as { strategy: unknown }).strategy = {
    ...CANAL,
    ...(o.series ? { series: o.series } : {}),
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

describe('canal con IA en el runner (spec 058)', () => {
  describe('la entrada', () => {
    it('primero la operación guardada, luego la intención, el apalancamiento y la orden', async () => {
      const h = montar({ plan: planEntrada() });

      await h.runner.start();

      expect(h.orden).toEqual([
        'scratch',
        'anotar:ACEPTADA',
        'setLeverage:12:ISOLATED',
        'place:' + ENTRADA.clientOrderId,
      ]);
      expect(h.adapter.requests[0]).toMatchObject({ timeInForce: 'IOC', price: '100.2' });
      await h.runner.dispose();
    });

    it('al arrancar y al recargar no toca el apalancamiento: es un tope, no el de la operación', async () => {
      const h = montar();

      await h.runner.start();
      await h.runner.reloadConfig({ leverage: 7 } as never, 'WARM');

      expect(h.orden.filter((c) => c.startsWith('setLeverage'))).toEqual([]);
      await h.runner.dispose();
    });

    it('si el exchange aplica otro apalancamiento, no hay entrada y la intención se rechaza', async () => {
      const h = montar({ plan: planEntrada() });
      h.adapter.acuseDe = () => ({ leverage: 10 });

      await h.runner.start();

      expect(h.adapter.requests).toEqual([]);
      expect(h.intents.anotar).toHaveBeenLastCalledWith(
        BOT_ID,
        SEQ,
        expect.objectContaining({ intentId: 'ia-1', estado: 'RECHAZADA', motivo: 'VENUE' }),
      );
      // La operación guardada se olvida: no hay llenado que esperar.
      expect(h.store.scratches.at(-1)?.['op']).toBeNull();
      expect(h.eventos('AI_ENTRY_DISCARDED')[0].message).toMatch(/10x en vez de 12x/);
      await h.runner.dispose();
    });

    it('un acuse que no confirma el apalancamiento (Lighter) no impide entrar', async () => {
      const h = montar({ plan: planEntrada() });
      h.adapter.acuseDe = () => ({ leverage: null });

      await h.runner.start();

      expect(h.adapter.requests).toHaveLength(1);
      await h.runner.dispose();
    });

    it('con un nocional máximo por debajo de la entrada no se entra; por encima, sí', async () => {
      // La entrada suma 0,5 × 100,2 = 50,1.
      const corto = montar({ plan: planEntrada() });
      corto.adapter.acuseDe = (leverage) => ({ leverage, maxNotional: '40' });
      await corto.runner.start();
      expect(corto.adapter.requests).toEqual([]);
      expect(corto.eventos('AI_ENTRY_DISCARDED')[0].message).toMatch(/admite 40/);
      await corto.runner.dispose();

      const holgado = montar({ plan: planEntrada() });
      holgado.adapter.acuseDe = (leverage) => ({ leverage, maxNotional: '60' });
      await holgado.runner.start();
      expect(holgado.adapter.requests).toHaveLength(1);
      await holgado.runner.dispose();
    });

    it('si el exchange rechaza el apalancamiento, no hay entrada', async () => {
      const h = montar({ plan: planEntrada() });
      h.adapter.leverageError = new ExchangeError('RULES', 'max leverage is 10', HL);

      await h.runner.start();

      expect(h.adapter.requests).toEqual([]);
      expect(h.intents.anotar).toHaveBeenLastCalledWith(
        BOT_ID,
        SEQ,
        expect.objectContaining({ estado: 'RECHAZADA', motivo: 'VENUE' }),
      );
      await h.runner.dispose();
    });

    it('una credencial muerta al fijarlo no se queda en un descarte: suelta el bot', async () => {
      const h = montar({ plan: planEntrada() });
      h.adapter.leverageError = new ExchangeError('AUTH', 'invalid api key', HL);

      await h.runner.start();

      expect(h.adapter.requests).toEqual([]);
      expect(h.eventos('AUTH_ERROR')).toHaveLength(1);
      expect(h.detached).toEqual([BOT_ID]);
      await h.runner.dispose();
    });

    it('si la intención no se puede marcar, ni apalancamiento ni orden', async () => {
      const h = montar({ plan: planEntrada() });
      h.intents.anotar.mockResolvedValue(false);

      await h.runner.start();

      expect(h.orden.some((c) => c.startsWith('setLeverage') || c.startsWith('place'))).toBe(false);
      expect(h.store.scratches.at(-1)?.['op']).toBeNull();
      expect(h.eventos('AI_ENTRY_DISCARDED')).toHaveLength(1);
      await h.runner.dispose();
    });

    it('un fallo de la base al marcarla tumba el tick, y no sale nada', async () => {
      const h = montar({ plan: planEntrada() });
      h.intents.anotar.mockRejectedValue(new Error('base caída'));

      await h.runner.start();

      expect(h.adapter.requests).toEqual([]);
      expect(h.eventos('TICK_ERROR')).toHaveLength(1);
      await h.runner.dispose();
    });

    it('sin almacén de intenciones no se abre nada', async () => {
      const h = montar({ plan: planEntrada(), deps: { intents: undefined } });

      await h.runner.start();

      expect(h.adapter.requests).toEqual([]);
      expect(h.eventos('AI_ENTRY_DISCARDED')).toHaveLength(1);
      await h.runner.dispose();
    });

    it('con posición no se toca el apalancamiento ni se entra', async () => {
      const h = montar({ plan: planEntrada() });
      h.adapter.position = largo();

      await h.runner.start();

      expect(h.orden.some((c) => c.startsWith('setLeverage'))).toBe(false);
      expect(h.adapter.requests.filter((r) => !r.reduceOnly)).toEqual([]);
      expect(h.intents.anotar).toHaveBeenLastCalledWith(
        BOT_ID,
        SEQ,
        expect.objectContaining({ estado: 'RECHAZADA', motivo: 'ESTADO' }),
      );
      await h.runner.dispose();
    });

    it('un plan sin entrada no toca el apalancamiento aunque lo traiga', async () => {
      const h = montar({ plan: planEntrada({ orders: [], decision: undefined }) });

      await h.runner.start();

      expect(h.orden.some((c) => c.startsWith('setLeverage'))).toBe(false);
      await h.runner.dispose();
    });
  });

  describe('lo demás del plan', () => {
    it('la caducidad de una orden viaja hasta el exchange', async () => {
      const vence = Date.UTC(2026, 8, 17, 10, 30);
      const h = montar({
        plan: planEntrada({ orders: [{ ...ENTRADA, timeInForce: 'GTC', expiresAt: vence }] }),
      });
      await h.runner.start();
      expect(h.adapter.requests[0]).toMatchObject({
        clientOrderId: ENTRADA.clientOrderId,
        expiresAt: vence,
      });
      await h.runner.dispose();

      // Sin caducidad, el campo no viaja.
      const sin = montar({ plan: planEntrada() });
      await sin.runner.start();
      expect(sin.adapter.requests[0]).not.toHaveProperty('expiresAt');
      await sin.runner.dispose();
    });

    it('la solicitud a la IA se escribe con el bot y el ciclo', async () => {
      const solicitud = { barT: 1, huella: 'h', expiresAt: 2, snapshot: {} } as SolicitudIa;
      const h = montar({ plan: { orders: [], immediate: [], solicitudIa: solicitud } });

      await h.runner.start();

      expect(h.intents.solicitar).toHaveBeenCalledWith(
        expect.objectContaining({ id: BOT_ID }),
        SEQ,
        solicitud,
      );
      await h.runner.dispose();
    });

    it('si la estrategia pide pausar, se pausa sin tocar el libro', async () => {
      const h = montar({ plan: planEntrada({ pausar: 'caída máxima superada' }) });

      await h.runner.start();

      expect(h.adapter.requests).toEqual([]);
      expect(h.store.setStatus).toHaveBeenCalledWith(BOT_ID, 'PAUSED', {
        error: 'caída máxima superada',
      });
      expect(h.intents.caducarPendientes).toHaveBeenCalled();
      // Ni se marca la intención ni se toca el apalancamiento de un bot pausado.
      expect(h.intents.anotar).not.toHaveBeenCalled();
      expect(h.orden.some((x) => x.startsWith('setLeverage'))).toBe(false);
      await h.runner.dispose();
    });

    it('cada aviso sale una vez mientras sigue, y otra si vuelve', async () => {
      const aviso = {
        clave: 'tope-dia:1',
        tipo: 'AI_DAY_STOP',
        severidad: 'WARN' as const,
        mensaje: 'tope',
      };
      let avisos = [aviso];
      const h = montar({ plan: () => ({ orders: [], immediate: [], avisos }) });

      await h.runner.start();
      await h.tick();
      expect(h.eventos('AI_DAY_STOP')).toHaveLength(1);

      avisos = [];
      await h.tick();
      avisos = [aviso];
      await h.tick();
      expect(h.eventos('AI_DAY_STOP')).toHaveLength(2);
      await h.runner.dispose();
    });
  });

  describe('el contexto', () => {
    it('lleva el historial, la intención, los tramos y los límites', async () => {
      const decision = { intentId: 'ia-9', estado: 'DECIDIDA' };
      const h = montar({ guards: { maxLeverage: 7 } });
      h.intents.vigente.mockResolvedValue(decision);

      await h.runner.start();

      expect(h.contextos[0]).toMatchObject({
        historial: HISTORIAL,
        decisionIa: decision,
        nivelesApalancamiento: TIERS,
        limites: {
          entradasPermitidas: true,
          maxApalancamientoUsuario: 7,
          venueListo: true,
          motivo: null,
        },
      });
      await h.runner.dispose();
    });

    it('una estrategia que no es del canal no pide nada de eso', async () => {
      const h = montar({ flags: { consumeDecisionesIa: undefined } });

      await h.runner.start();

      expect(h.store.historialOperaciones).not.toHaveBeenCalled();
      expect(h.intents.vigente).not.toHaveBeenCalled();
      expect(h.contextos[0].limites).toBeUndefined();
      await h.runner.dispose();
    });

    it.each([
      [
        'apagado',
        async () => ({ permitidas: false, motivo: 'cortadas en la consola' }),
        /cortadas en la consola/,
      ],
      [
        'ilegible (Redis caído)',
        async () => {
          throw new Error('Redis no contesta');
        },
        /no se pudo leer el interruptor global/,
      ],
      ['ausente', undefined, /no lee el interruptor/],
    ])('con el interruptor %s no hay entradas', async (_caso, interruptorCanal, motivo) => {
      const h = montar({ deps: { interruptorCanal } });

      await h.runner.start();

      expect(h.contextos[0].limites?.entradasPermitidas).toBe(false);
      expect(h.contextos[0].limites?.motivo).toMatch(motivo);
      await h.runner.dispose();
    });

    it('sin tramos leídos, o en cobertura, el venue no está listo', async () => {
      const sinTramos = montar();
      sinTramos.adapter.tiers = new ExchangeError('FATAL', 'firma', Venue.ASTER);
      await sinTramos.runner.start();
      expect(sinTramos.contextos[0].limites).toMatchObject({ venueListo: false });
      expect(sinTramos.contextos[0].limites?.motivo).toMatch(/tramos/);
      expect(sinTramos.contextos[0].nivelesApalancamiento).toBeUndefined();
      await sinTramos.runner.dispose();

      const vacios = montar();
      vacios.adapter.tiers = [];
      await vacios.runner.start();
      expect(vacios.contextos[0].limites?.venueListo).toBe(false);
      await vacios.runner.dispose();

      const cobertura = montar();
      cobertura.adapter.modo = 'HEDGE';
      await cobertura.runner.start();
      expect(cobertura.contextos[0].limites?.motivo).toMatch(/cobertura/);
      await cobertura.runner.dispose();

      const sinModo = montar();
      sinModo.adapter.modo = new Error('timeout');
      await sinModo.runner.start();
      expect(sinModo.contextos[0].limites).toMatchObject({ venueListo: false });
      await sinModo.runner.dispose();
    });

    it('un venue que no declara tramos ni modo (posición neta) está listo', async () => {
      const h = montar();
      delete h.adapter.getLeverageTiers;
      delete h.adapter.getPositionMode;

      await h.runner.start();

      expect(h.contextos[0].limites).toMatchObject({ venueListo: true, motivo: null });
      expect(h.contextos[0].nivelesApalancamiento).toBeUndefined();
      await h.runner.dispose();
    });

    it('los tramos se recuerdan; un fallo se vuelve a preguntar al minuto', async () => {
      let reloj = Date.UTC(2026, 8, 17, 10);
      jest.spyOn(Date, 'now').mockImplementation(() => reloj);
      const h = montar();

      await h.runner.start();
      await h.tick();
      expect(h.adapter.tierCalls).toBe(1);

      reloj += 11 * 60_000;
      h.adapter.tiers = new Error('caído');
      await h.tick();
      expect(h.adapter.tierCalls).toBe(2);
      await h.tick();
      expect(h.adapter.tierCalls).toBe(2);

      reloj += 61_000;
      h.adapter.tiers = TIERS;
      await h.tick();
      expect(h.adapter.tierCalls).toBe(3);
      expect(h.contextos.at(-1)?.limites?.venueListo).toBe(true);
      await h.runner.dispose();
    });

    it('el modo de posición también se recuerda; un fallo se vuelve a preguntar al minuto', async () => {
      let reloj = Date.UTC(2026, 8, 17, 10);
      jest.spyOn(Date, 'now').mockImplementation(() => reloj);
      const h = montar();

      await h.runner.start();
      await h.tick();
      expect(h.adapter.modoCalls).toBe(1);

      reloj += 11 * 60_000;
      h.adapter.modo = new Error('caído');
      await h.tick();
      expect(h.adapter.modoCalls).toBe(2);
      expect(h.contextos.at(-1)?.limites?.venueListo).toBe(false);
      await h.tick();
      expect(h.adapter.modoCalls).toBe(2);

      reloj += 61_000;
      h.adapter.modo = 'ONE_WAY';
      await h.tick();
      expect(h.adapter.modoCalls).toBe(3);
      expect(h.contextos.at(-1)?.limites?.venueListo).toBe(true);
      await h.runner.dispose();
    });

    it('las series que declara, cada una topada por lo que da el venue en una petición', async () => {
      const velas = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i }) as Candle);
      const candleSource: CandleSourceLike = {
        candleHistory: jest.fn((_v, _s, interval: CandleInterval, bars: number) =>
          interval === '1h' ? null : velas(bars),
        ),
      };
      const h = montar({
        bot: { venue: Venue.LIGHTER },
        deps: { candleSource },
        series: () => [
          { interval: '5m', bars: 144 },
          { interval: '15m', bars: 1000 },
          { interval: '1h', bars: 480 },
        ],
      });

      await h.runner.start();

      // Lighter sirve 500 por petición: 497 como mucho.
      expect(candleSource.candleHistory).toHaveBeenCalledWith(
        Venue.LIGHTER,
        'BTC',
        '5m',
        144,
        false,
        {
          ttlMs: 300_000,
        },
      );
      expect(candleSource.candleHistory).toHaveBeenCalledWith(
        Venue.LIGHTER,
        'BTC',
        '15m',
        497,
        false,
        {
          ttlMs: 900_000,
        },
      );
      expect(candleSource.candleHistory).toHaveBeenCalledWith(
        Venue.LIGHTER,
        'BTC',
        '1h',
        480,
        false,
        {
          ttlMs: 900_000,
        },
      );
      // La que no llega entera no viene.
      expect(Object.keys(h.contextos[0].series ?? {})).toEqual(['5m', '15m']);
      expect(h.contextos[0].series?.['15m']).toHaveLength(497);
      await h.runner.dispose();
    });
  });

  describe('el vigilante del stop', () => {
    const conPosicionSinStop = (bot: Opciones['bot'] = {}) => {
      let reloj = Date.UTC(2026, 8, 17, 10);
      jest.spyOn(Date, 'now').mockImplementation(() => reloj);
      const h = montar({ plan: { orders: [STOP], immediate: [] }, bot });
      h.adapter.position = largo();
      // El stop no entra: el venue lo rechaza.
      h.adapter.fallaAl = (req) =>
        req.clientOrderId === STOP.clientOrderId
          ? new ExchangeError('RULES', 'trigger price too far', HL)
          : null;
      return { h, pasan: (ms: number) => (reloj += ms) };
    };
    const cierre = makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 999);

    it('una posición sin stop confirmado más de 5 s se cierra a mercado', async () => {
      const { h, pasan } = conPosicionSinStop();

      await h.runner.start();
      pasan(3_000);
      await h.tick();
      expect(h.orden).not.toContain('place:' + cierre);

      pasan(3_000);
      await h.tick();
      expect(h.orden).toContain('place:' + cierre);
      expect(h.adapter.requests.at(-1)).toMatchObject({
        side: 'SELL',
        type: 'MARKET',
        qty: '1.000',
        reduceOnly: true,
      });
      expect(h.eventos('SIN_STOP')[0].severity).toBe('CRITICAL');
      await h.runner.dispose();
    });

    it('en Lighter espera 10 s: su stop aparece en el libro algo después del acuse', async () => {
      const { h, pasan } = conPosicionSinStop({ venue: Venue.LIGHTER });

      await h.runner.start();
      // Una revisión de Lighter (8 s) después, todavía no.
      pasan(8_000);
      await h.tick();
      expect(h.orden).not.toContain('place:' + cierre);

      pasan(3_000);
      await h.tick();
      expect(h.orden).toContain('place:' + cierre);
      expect(h.eventos('SIN_STOP')[0].message).toContain('10 s');
      await h.runner.dispose();
    });

    it('con el stop en el libro no hace nada', async () => {
      const { h, pasan } = conPosicionSinStop();
      h.adapter.openOrders = [
        {
          venue: HL,
          symbol: 'BTC',
          clientOrderId: hyperliquidCodec.encode(STOP.clientOrderId),
          venueOrderId: '1',
          side: 'SELL',
          type: 'MARKET',
          price: '97',
          triggerPrice: '97',
          qty: '1',
          filledQty: '0',
          avgPrice: null,
          status: 'OPEN',
          reduceOnly: true,
          createdAt: 0,
        },
      ];

      await h.runner.start();
      pasan(10_000);
      await h.tick();

      expect(h.orden).not.toContain('place:' + cierre);
      expect(h.eventos('SIN_STOP')).toEqual([]);
      await h.runner.dispose();
    });

    it('una estrategia sin el apalancamiento por operación no tiene vigilante', async () => {
      const { h, pasan } = conPosicionSinStop();
      (h.runner as unknown as { strategy: Record<string, unknown> }).strategy[
        'apalancamientoPorOperacion'
      ] = undefined;

      await h.runner.start();
      pasan(10_000);
      await h.tick();

      expect(h.orden).not.toContain('place:' + cierre);
      await h.runner.dispose();
    });

    it('el stop del canal sale aunque la posición no llegue al mínimo del venue', async () => {
      // 0,05 × 100 = 5 de nocional, con un mínimo de 10.
      const pequeno = { ...STOP, qty: '0.050' };
      const canal = montar({ plan: { orders: [pequeno], immediate: [] } });
      canal.adapter.position = largo('0.05');
      await canal.runner.start();
      expect(canal.orden).toContain('place:' + STOP.clientOrderId);
      await canal.runner.dispose();

      // Otra estrategia sigue esperando al mínimo, como siempre.
      const otra = montar({
        plan: { orders: [pequeno], immediate: [] },
        flags: { apalancamientoPorOperacion: undefined },
      });
      otra.adapter.position = largo('0.05');
      await otra.runner.start();
      expect(otra.orden).not.toContain('place:' + STOP.clientOrderId);
      await otra.runner.dispose();
    });

    it('una orden vencida no bloquea su id, como una cancelada; una abierta, sí', async () => {
      // Desde la fase 6, una IOC sin ejecutar en Aster llega como EXPIRED: una
      // estrategia que reutiliza sus ids no podría volver a mandarla.
      const casos = [
        ['EXPIRED', true],
        ['CANCELED', true],
        ['OPEN', false],
      ] as const;
      for (const [status, sale] of casos) {
        const h = montar({ plan: { orders: [STOP], immediate: [] } });
        h.adapter.position = largo();
        h.store.findOrderByCoid.mockResolvedValue({
          status,
          venue_order_id: 'v-1',
          updated_at: new Date(),
        });
        await h.runner.start();
        const salio = h.orden.includes('place:' + STOP.clientOrderId);
        expect(`${status}: ${salio}`).toBe(`${status}: ${sale}`);
        await h.runner.dispose();
      }
    });

    /**
     * Spec 062, F-05. El id del cierre era siempre `TAKE_PROFIT#999` y `place()`
     * veta un id con fila: el segundo cierre del ciclo —el del vigilante tras
     * uno ejecutado a medias— no salía nunca.
     */
    it('un segundo cierre del ciclo no choca con el id del primero (spec 062, F-05)', async () => {
      const { h, pasan } = conPosicionSinStop();
      h.store.findOrderByCoid.mockImplementation(async (coid: string) =>
        coid === cierre
          ? { status: 'FILLED', venue_order_id: 'v-9', updated_at: new Date() }
          : null,
      );

      await h.runner.start();
      pasan(6_000);
      await h.tick();

      expect(h.orden).not.toContain('place:' + cierre);
      expect(h.orden).toContain('place:' + makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 998));
      await h.runner.dispose();
    });

    /**
     * Spec 062, F-05. `RESTO_INCERRABLE` callaba el cierre definitivo de una
     * posición apalancada por operación: un resto a 25x sin stop es riesgo vivo.
     */
    it('el cierre definitivo del canal sale aunque el resto no llegue al mínimo (spec 062, F-05)', async () => {
      // 0,05 × 100 = 5 de nocional, con un mínimo de 10.
      const h = montar();
      h.adapter.position = largo('0.05');
      await h.runner.start();
      await h.runner.handleCommand('STOP_AND_CLOSE');

      expect(h.orden).toContain('place:' + cierre);
      expect(h.eventos('POSITION_BELOW_MINIMUM')).toEqual([]);
      await h.runner.dispose();

      // Otra estrategia sigue avisando del resto y no manda nada.
      const otra = montar({ flags: { apalancamientoPorOperacion: undefined } });
      otra.adapter.position = largo('0.05');
      await otra.runner.start();
      await otra.runner.handleCommand('STOP_AND_CLOSE');

      expect(otra.orden).not.toContain('place:' + cierre);
      expect(otra.eventos('POSITION_BELOW_MINIMUM')).toHaveLength(1);
      await otra.runner.dispose();
    });

    /**
     * Spec 062, F-05. Salían pares de CRITICAL cada seis segundos, y decían que
     * el exchange no había aceptado un cierre que nunca se mandó.
     */
    it('el aviso de la posición sin stop se enfría y no culpa al exchange (spec 062, F-05)', async () => {
      const { h, pasan } = conPosicionSinStop();
      // Ni el stop ni el cierre entran.
      h.adapter.fallaAl = () => new ExchangeError('RULES', 'rechazado', HL);
      const cierres = () => h.orden.filter((o) => o.startsWith('place:' + cierre.slice(0, -3)));

      // Cada cierre necesita dos revisiones: una rearma el reloj y la siguiente,
      // pasados los 5 s, cierra.
      const vigilar = async () => {
        pasan(6_000);
        await h.tick();
        pasan(6_000);
        await h.tick();
      };

      await h.runner.start();
      pasan(6_000);
      await h.tick();
      expect(cierres()).toHaveLength(1);
      expect(h.eventos('SIN_STOP')).toHaveLength(1);
      const fallo = h.eventos('ACTION_FAILED');
      expect(fallo).toHaveLength(1);
      expect(fallo[0].message).toMatch(/el motivo está en el evento anterior/);

      // La vigilancia siguiente vuelve a cerrar, pero no repite el CRITICAL.
      await vigilar();
      expect(cierres()).toHaveLength(2);
      expect(h.eventos('SIN_STOP')).toHaveLength(1);
      expect(h.eventos('ACTION_FAILED')).toHaveLength(1);

      // Pasado el minuto, vuelve a avisar.
      pasan(60_000);
      await vigilar();
      expect(cierres()).toHaveLength(3);
      expect(h.eventos('SIN_STOP')).toHaveLength(2);
      expect(h.eventos('ACTION_FAILED')).toHaveLength(2);
      await h.runner.dispose();
    });

    it('un stop imposible (cantidad cero) no sale ni en el canal', async () => {
      const h = montar({ plan: { orders: [{ ...STOP, qty: '0.000' }], immediate: [] } });
      h.adapter.position = largo('0.0001');
      await h.runner.start();
      expect(h.orden).not.toContain('place:' + STOP.clientOrderId);
      await h.runner.dispose();
    });
  });

  describe('las guardas', () => {
    it('la liquidación por stop calla hasta dos tercios del camino, aunque esté a pocos puntos', async () => {
      const h = montar({ guards: { liquidationAlertPct: '10' } });
      // Entrada 100, liquidación 96: a un 4 %, que con la regla del % avisaría.
      h.adapter.position = largo('1', '100', '96');
      h.adapter.ticker = { ...h.adapter.ticker, mark: '98', bid: '98', ask: '98.1' };

      await h.runner.start();

      expect(h.eventos('LIQUIDATION_NEAR')).toEqual([]);
      expect(h.eventos('RISK_GUARD_TRIPPED')).toEqual([]);
      await h.runner.dispose();
    });

    it('a dos tercios del camino avisa en CRITICAL y cierra', async () => {
      const h = montar();
      h.adapter.position = largo('1', '100', '96');
      // 2,8 de 4: el 70 % del camino.
      h.adapter.ticker = { ...h.adapter.ticker, mark: '97.2', bid: '97.2', ask: '97.3' };

      await h.runner.start();

      expect(h.eventos('LIQUIDATION_NEAR')[0].severity).toBe('CRITICAL');
      expect(h.eventos('RISK_GUARD_TRIPPED')).toHaveLength(1);
      expect(h.orden).toContain('place:' + makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 999));
      await h.runner.dispose();
    });

    it('con `liquidationAction: ALERT` solo avisa', async () => {
      const h = montar({ config: { liquidationAction: 'ALERT' } });
      h.adapter.position = largo('1', '100', '96');
      h.adapter.ticker = { ...h.adapter.ticker, mark: '97.2', bid: '97.2', ask: '97.3' };

      await h.runner.start();

      expect(h.eventos('LIQUIDATION_NEAR')).toHaveLength(1);
      expect(h.eventos('RISK_GUARD_TRIPPED')).toEqual([]);
      await h.runner.dispose();
    });

    it('un corto mide el camino hacia arriba', async () => {
      const h = montar();
      h.adapter.position = { ...largo('-1', '100', '104') };
      h.adapter.ticker = { ...h.adapter.ticker, mark: '102.9', bid: '102.9', ask: '103' };

      await h.runner.start();

      expect(h.eventos('RISK_GUARD_TRIPPED')).toHaveLength(1);
      await h.runner.dispose();
    });

    /**
     * Spec 062, F-12. Las guardas se evaluaban tambien en pausa y el aviso
     * salia, pero la rama del bot pausado se iba antes de actuar: la guia
     * prometia «Cerrar todo» y la posicion a 25x se quedaba mirando.
     */
    it('pausado, la guarda de liquidacion del canal cierra igual (spec 062, F-12)', async () => {
      const h = montar({ deps: { startPaused: true } });
      h.adapter.position = largo('1', '100', '96');
      h.adapter.ticker = { ...h.adapter.ticker, mark: '97.2', bid: '97.2', ask: '97.3' };

      await h.runner.start();

      expect(h.eventos('LIQUIDATION_NEAR')[0].severity).toBe('CRITICAL');
      expect(h.eventos('RISK_GUARD_TRIPPED')).toHaveLength(1);
      expect(h.orden).toContain('place:' + makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 999));
      await h.runner.dispose();
    });

    it('pausado, el resto de estrategias sigue solo avisando (spec 062, F-12)', async () => {
      const h = montar({
        deps: { startPaused: true },
        flags: { apalancamientoPorOperacion: undefined },
      });
      h.adapter.position = largo('1', '100', '96');
      h.adapter.ticker = { ...h.adapter.ticker, mark: '97.2', bid: '97.2', ask: '97.3' };

      await h.runner.start();

      expect(h.eventos('LIQUIDATION_NEAR')).toHaveLength(1);
      expect(h.eventos('RISK_GUARD_TRIPPED')).toEqual([]);
      expect(h.orden).not.toContain('place:' + makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 999));
      await h.runner.dispose();
    });

    it('el tope diario reanudable solo pausa a 1,5 veces', async () => {
      const siete = montar();
      siete.store.todayRealizedPnlForBot.mockResolvedValue(D('-70'));
      await siete.runner.start();
      expect(siete.store.setStatus).not.toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
      await siete.runner.dispose();

      const nueve = montar();
      nueve.store.todayRealizedPnlForBot.mockResolvedValue(D('-90'));
      await nueve.runner.start();
      expect(nueve.store.setStatus).toHaveBeenCalledWith(
        BOT_ID,
        'PAUSED',
        expect.objectContaining({ error: expect.stringMatching(/1,5 veces/) }),
      );
      await nueve.runner.dispose();
    });

    it('sin el tope reanudable, pausa al tope, como siempre', async () => {
      const h = montar({ flags: { topeDiarioReanuda: undefined } });
      h.store.todayRealizedPnlForBot.mockResolvedValue(D('-70'));

      await h.runner.start();

      expect(h.store.setStatus).toHaveBeenCalledWith(BOT_ID, 'PAUSED', expect.anything());
      await h.runner.dispose();
    });
  });

  describe('las intenciones', () => {
    const fill = (): Fill => ({
      venue: HL,
      symbol: 'BTC',
      venueFillId: 'f-1',
      venueOrderId: 'v-1',
      clientOrderId: 'x',
      side: 'SELL',
      price: '101',
      qty: '1',
      fee: '0.01',
      feeAsset: 'USDC',
      isTaker: true,
      ts: Date.now(),
    });

    it('una ejecución caduca lo pendiente; si cierra el ciclo, la operación se cierra', async () => {
      const h = montar();
      await h.runner.start();

      h.adapter.fills$.next(fill());
      await esperar();
      expect(h.intents.caducarPendientes).toHaveBeenCalledTimes(1);
      expect(h.intents.cerrar).not.toHaveBeenCalled();

      h.store.applyFillToCycle.mockImplementation(async (_id: string, cycle: CycleState) => ({
        ...cycle,
        scratch: { cycleSeq: SEQ + 1 },
      }));
      h.adapter.fills$.next({ ...fill(), venueFillId: 'f-2' });
      await esperar();
      expect(h.intents.cerrar).toHaveBeenCalledWith(BOT_ID);
      await h.runner.dispose();
    });

    it('la operación se marca abierta una vez, con posición', async () => {
      const h = montar({ scratch: { op: { plan: { intentId: 'ia-1' } } } });
      h.adapter.position = largo();

      await h.runner.start();
      await h.tick();

      expect(h.intents.abrir).toHaveBeenCalledTimes(1);
      expect(h.intents.abrir).toHaveBeenCalledWith(BOT_ID, 'ia-1');
      await h.runner.dispose();
    });

    const avisos = (h: ReturnType<typeof montar>, tipo: string) =>
      h.store.event.mock.calls.filter((c) => c[1] === tipo);

    it('al abrirse, avisa de la entrada una sola vez, con lo llenado y el vale (spec 059)', async () => {
      const h = montar({ scratch: { op: OP_COMPLETA } });
      h.adapter.position = largo('0.998', '100.18');
      await h.runner.start();
      await h.tick();

      const entradas = avisos(h, 'AI_ENTRY');
      expect(entradas).toHaveLength(1);
      // 0,998 · 100,18 = 99,97964
      expect(entradas[0].slice(2)).toEqual([
        'INFO',
        'Entrada larga: 0.998 a 100.18 con 12x (nocional 99.98 USDC). Stop 97.0 · objetivos ' +
          '103.0 / 104.5 · riesgo 3.25 USDC · R 1.50 · liquidación estimada 92.0.',
        expect.objectContaining({ intentId: 'ia-1', vale: VALE, cantidad: '0.998' }),
      ]);
      expect(h.intents.valeDePausa).toHaveBeenCalledWith(
        expect.objectContaining({ id: BOT_ID, user_id: 'admin-1' }),
      );

      await h.tick();
      expect(avisos(h, 'AI_ENTRY')).toHaveLength(1);
      await h.runner.dispose();
    });

    it('una intención que ya estaba abierta no vuelve a avisar (un reinicio)', async () => {
      const h = montar({ scratch: { op: OP_COMPLETA } });
      h.intents.abrir.mockResolvedValue(false);
      h.adapter.position = largo();
      await h.runner.start();
      await h.tick();
      expect(h.intents.abrir).toHaveBeenCalledTimes(1);
      expect(avisos(h, 'AI_ENTRY')).toEqual([]);
      expect(h.intents.valeDePausa).not.toHaveBeenCalled();
      await h.runner.dispose();
    });

    it('sin vale, el aviso sale sin botón; sin una operación legible, no sale', async () => {
      for (const fallo of [
        (h: ReturnType<typeof montar>) => h.intents.valeDePausa.mockResolvedValue(null),
        (h: ReturnType<typeof montar>) =>
          h.intents.valeDePausa.mockRejectedValue(new Error('caído')),
      ]) {
        const h = montar({ scratch: { op: OP_COMPLETA } });
        fallo(h);
        h.adapter.position = largo();
        await h.runner.start();
        await h.tick();
        const [llamada] = avisos(h, 'AI_ENTRY');
        expect(llamada[4]).not.toHaveProperty('vale');
        expect(llamada[4]).toMatchObject({ intentId: 'ia-1' });
        await h.runner.dispose();
      }

      const rota = montar({ scratch: { op: { plan: { intentId: 'ia-1' } } } });
      rota.adapter.position = largo();
      await rota.runner.start();
      await rota.tick();
      expect(rota.intents.abrir).toHaveBeenCalledTimes(1);
      expect(avisos(rota, 'AI_ENTRY')).toEqual([]);
      await rota.runner.dispose();
    });

    it('al cerrar el ciclo avisa AI_EXIT, con la operación y el cierre de antes (spec 059)', async () => {
      const casos: [string, Record<string, unknown>, string, string][] = [
        [
          makeCoid(BOT_ID, SEQ, 'STOP_LOSS', 0),
          { op: { ...OP_COMPLETA, stopBreakeven: '100.3' } },
          'BREAKEVEN',
          'Operación cerrada (stop en breakeven): +0.02 USDC (+0.01 R).',
        ],
        [
          makeCoid(BOT_ID, SEQ, 'TAKE_PROFIT', 500),
          { op: OP_COMPLETA, cierre: { motivo: 'TIEMPO', intentos: 1, ultimoEn: 1 } },
          'TIEMPO',
          'Operación cerrada (por tiempo): +0.02 USDC (+0.01 R).',
        ],
      ];
      for (const [coid, scratch, motivo, mensaje] of casos) {
        const h = montar({ scratch });
        h.store.recordFill.mockResolvedValue(coid);
        let evento: unknown = null;
        h.store.applyFillToCycle.mockImplementation(async (_id, cycle, _fill, opts) => {
          evento = opts?.eventoCierre?.({ seq: SEQ, pnl: D('0.02') }) ?? null;
          return { ...cycle, scratch: { cycleSeq: SEQ + 1 } };
        });
        await h.runner.start();
        h.adapter.fills$.next(fill());
        await esperar();
        // 0,02 / 3,25 = 0,00615…
        expect(evento).toEqual({
          type: 'AI_EXIT',
          severity: 'INFO',
          message: mensaje,
          payload: { realizedPnl: '0.02', seq: SEQ, r: 0.0062, motivo, intentId: 'ia-1' },
        });
        expect(h.intents.cerrar).toHaveBeenCalledWith(BOT_ID);
        await h.runner.dispose();
      }
    });

    it('un bot que no es del canal cierra con el evento de siempre', async () => {
      const h = montar({ flags: { consumeDecisionesIa: false } });
      await h.runner.start();
      h.adapter.fills$.next(fill());
      await esperar();
      expect(h.store.applyFillToCycle).toHaveBeenCalled();
      expect(h.store.applyFillToCycle.mock.calls[0][3]).not.toHaveProperty('eventoCierre');
      await h.runner.dispose();
    });

    it('cualquier comando y cualquier recarga caducan lo pendiente', async () => {
      const h = montar();
      await h.runner.start();

      await h.runner.handleCommand('PAUSE');
      await h.runner.handleCommand('RESUME');
      await h.runner.reloadConfig({ leverage: 5 } as never, 'HOT');

      expect(h.intents.caducarPendientes).toHaveBeenCalledTimes(3);
      await h.runner.dispose();
    });

    it('retirar margen de una operación no se permite; aportar, sí', async () => {
      const h = montar();
      h.adapter.position = largo();
      await h.runner.start();

      await expect(
        (h.runner as unknown as { adjustMargin(p: unknown): Promise<void> }).adjustMargin({
          amount: '5',
          action: 'REMOVE',
        }),
      ).rejects.toThrow(/retirar margen/);
      await h.runner.handleCommand('ADJUST_MARGIN', { amount: '5', action: 'ADD' });

      expect(h.adapter.marginCalls).toEqual([{ amount: '5', action: 'ADD', side: 'LONG' }]);
      await h.runner.dispose();
    });

    it('tras cancelar todo, el stop propio se repone en el acto', async () => {
      const h = montar();
      await h.runner.start();
      const antes = h.contextos.length;

      await h.runner.handleCommand('CANCEL_ALL_ORDERS');
      await esperar();

      expect(h.contextos.length).toBe(antes + 1);
      await h.runner.dispose();
    });

    it('`pedirTick` planifica en el acto', async () => {
      const h = montar();
      await h.runner.start();

      h.runner.pedirTick();
      await esperar();

      expect(h.contextos).toHaveLength(2);
      await h.runner.dispose();
    });
  });

  describe('los ticks de vigilancia', () => {
    /** Cuántos ticks ha planificado el bot pasados `ms` desde el arranque. */
    async function ticksTras(
      o: Opciones,
      ms: number,
      preparar?: (h: ReturnType<typeof montar>) => void,
    ) {
      jest.useFakeTimers({
        now: Date.UTC(2026, 8, 17, 10, 1),
        doNotFake: ['setImmediate', 'nextTick'],
      });
      try {
        const h = montar(o);
        preparar?.(h);
        await h.runner.start();
        await jest.advanceTimersByTimeAsync(ms);
        jest.useRealTimers();
        await esperar();
        await h.runner.dispose();
        return h.contextos.length;
      } finally {
        jest.useRealTimers();
      }
    }
    const enCurso = { scratch: { op: { plan: { intentId: 'ia-1' } } } };

    it('con una entrada en curso, revisa a los 3 s en Hyperliquid', async () => {
      expect(await ticksTras(enCurso, 2_999)).toBe(1);
      expect(await ticksTras(enCurso, 3_000)).toBe(2);
    });

    it('en Lighter, a los 8 s', async () => {
      const lighter = { ...enCurso, bot: { venue: Venue.LIGHTER } };
      expect(await ticksTras(lighter, 7_999)).toBe(1);
      expect(await ticksTras(lighter, 8_000)).toBe(2);
    });

    it('sin nada que vigilar no hay ticks de más', async () => {
      expect(await ticksTras({}, 30_000)).toBe(1);
    });

    it('una posición sin stop se revisa; con el stop en el libro, no', async () => {
      const sinStop = await ticksTras({}, 3_000, (h) => {
        h.adapter.position = largo();
      });
      expect(sinStop).toBe(2);

      const conStop = await ticksTras({ plan: { orders: [STOP], immediate: [] } }, 30_000, (h) => {
        h.adapter.position = largo();
      });
      // El stop sale en el primer tick y su acuse lo confirma: nada que vigilar.
      expect(conStop).toBe(1);
    });
  });

  describe('el despertador del cierre', () => {
    it('despierta unos segundos tras el cierre de 5 min y trae antes las velas', async () => {
      const cierre = Date.UTC(2026, 8, 17, 10, 5);
      jest.useFakeTimers({ now: cierre - 1_000, doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const candleWindow = jest.fn(async () => null);
        const candleSource: CandleSourceLike = {
          candleHistory: jest.fn(() => null),
          candleWindow,
        };
        const h = montar({
          deps: { candleSource },
          series: () => [{ interval: '5m', bars: 144 }],
        });
        await h.runner.start();
        expect(h.contextos).toHaveLength(1);

        // Seis segundos de margen más el desfase del bot, que no pasa de dos.
        await jest.advanceTimersByTimeAsync(1_000 + 5_999);
        expect(candleWindow).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(2_001);
        expect(candleWindow).toHaveBeenCalledWith(HL, 'BTC', '5m', 144, false, {
          ttlMs: 300_000,
          esperarMs: 8_000,
        });
        jest.useRealTimers();
        await esperar();
        expect(h.contextos).toHaveLength(2);
        await h.runner.dispose();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
