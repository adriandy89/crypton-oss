import { Observable, Subject } from 'rxjs';
import {
  D,
  ExchangeError,
  StrategyKind,
  Venue,
  eleccionEfectiva,
  type Decimal,
  type EleccionOperacion,
  type Balance,
  type Candle,
  type CycleState,
  type DecisionIa,
  type Fill,
  type HistorialOperaciones,
  type MarcaDecision,
  type MarketSpec,
  type MarketTicker,
  type OrderAck,
  type OrderUpdate,
  type PlanOperacion,
  type Position,
  type SolicitudIa,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';
import {
  DryRunAdapter,
  VENUE_CAPABILITIES,
  type ExchangeAdapter,
  type StreamHealth,
} from '@crypton/exchange-core';
import {
  cycleAfterFill,
  getStrategy,
  parseCoid,
  vaciarCacheAnalisis,
  type CycleTotals,
} from '@crypton/strategy-core';
import { escenarioCanal } from '@crypton/strategy-core/dist/canal/testing-canal';
import type { AiIntentsLike } from './ai-intents.store';
import { BotRunner, type CandleSourceLike } from './bot-runner';
import type { BotRecord, BotStore, EventoCierre } from './bot-store';

/**
 * Spec 058, el recorrido entero del canal con IA en modo REGLAS: la estrategia
 * REAL, el runner REAL y el simulador REAL, con la persistencia en memoria.
 *
 * Entrada → stop y objetivos nativos → primer objetivo → stop a breakeven →
 * segundo objetivo → ciclo cerrado → la espera entre operaciones, y sin volver a
 * entrar con la vela de la operación cerrada aunque no haya espera.
 */

const BOT_ID = '9c8d7e6f-0000-4000-8000-000000000000';
const HL = Venue.HYPERLIQUID;
const esc = escenarioCanal({ toque: true });
const PRECIO = (esc.soporte + 0.25).toFixed(2);

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
  maxLeverage: 50,
  priceDecimals: 2,
  qtyDecimals: 3,
  active: true,
};

const ticker = (bid: string, ask = D(bid).plus('0.01').toFixed(2)): Ticker => ({
  venue: HL,
  symbol: 'SOL',
  last: bid,
  bid,
  ask,
  mark: bid,
  ts: Date.now(),
});

/** Fuente de precios del simulador, movida a mano. */
class Fuente implements ExchangeAdapter {
  readonly venue = HL;
  readonly capabilities = VENUE_CAPABILITIES[HL];
  readonly ticker$ = new Subject<Ticker>();
  actual: Ticker = ticker(PRECIO);

  fijar(bid: string): void {
    this.actual = ticker(bid);
    this.ticker$.next(this.actual);
  }

  verify = async () => ({ ok: true, publicRef: 'fuente' });
  getMarkets = async (): Promise<MarketSpec[]> => [MARKET];
  getTickers = async (): Promise<MarketTicker[]> => [];
  getCandles = async (): Promise<Candle[]> => [];
  getBalances = async (): Promise<Balance[]> => [];
  getPositions = async (): Promise<Position[]> => [];
  getOpenOrders = async (): Promise<VenueOrder[]> => [];
  getRecentFills = async (): Promise<Fill[]> => [];
  getTicker = async (): Promise<Ticker> => ({ ...this.actual, ts: Date.now() });
  placeOrder = async (): Promise<OrderAck> => {
    throw new Error('la fuente no recibe órdenes');
  };
  cancelOrder = async () => undefined;
  cancelOwn = async () => undefined;
  cancelAll = async () => undefined;
  setLeverage = async () => undefined;
  streamOrders = (): Observable<OrderUpdate> => new Subject<OrderUpdate>().asObservable();
  streamFills = (): Observable<Fill> => new Subject<Fill>().asObservable();
  streamTicker = (): Observable<Ticker> => this.ticker$.asObservable();
  streamHealth = (): Observable<StreamHealth> => new Subject<StreamHealth>().asObservable();
  close = async () => undefined;
}

interface Fila {
  status: string;
  cycleSeq: number;
  venueClientId: string;
  venueOrderId: string | null;
  qty: string;
  filled: string;
  levelKind: string;
}

/**
 * La persistencia del motor en memoria, con la contabilidad del ciclo de verdad
 * (`cycleAfterFill`): al quedar plano, el ciclo se cierra, su resultado va al
 * historial del día y el siguiente empieza con el scratch vacío.
 */
class Memoria {
  readonly filas = new Map<string, Fila>();
  readonly fills = new Set<string>();
  readonly eventos: {
    type: string;
    severity: string;
    message: string;
    payload?: Record<string, unknown>;
  }[] = [];
  readonly cerrados: { pnl: string; en: number }[] = [];
  totals: CycleTotals = Memoria.vacio();
  cycle: CycleState = {
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
    scratch: { cycleSeq: 1, cooldownMinutes: 0 },
  };

  static vacio(): CycleTotals {
    return {
      qty: D(0),
      averageEntry: null,
      realizedPnl: D(0),
      fees: D(0),
      entriesFilled: 0,
      filledLevelIndexes: [],
      anchorPrice: null,
      lastEntryAt: null,
    };
  }

  /** La nota de cada tick: es lo que la app enseña del plan. */
  readonly notas: (string | null)[] = [];
  setStatus = async () => undefined;
  setLastError = async () => undefined;
  touchTick = async (_b: string, nota: string | null) => {
    this.notas.push(nota);
  };
  saveSnapshot = async () => undefined;
  saveCycleAnchor = async () => undefined;
  syncOrderState = async () => undefined;
  repairCycleFromVenue = async () => null;
  marketSpec = async () => MARKET;
  drawdownPct = () => null;
  todayRealizedPnl = async () => D(0);
  todayRealizedPnlForBot = async () => D(0);
  recordLiquidation = async () => null;
  event = async (
    _b: unknown,
    type: string,
    severity: string,
    message: string,
    payload?: Record<string, unknown>,
  ) => {
    this.eventos.push({ type, severity, message, payload });
  };
  /** Se llama con cada scratch guardado, antes de hablar con el venue. */
  alGuardar: (scratch: Record<string, unknown>) => void = () => undefined;
  saveCycleScratch = async (_id: string, scratch: Record<string, unknown>) => {
    this.cycle = { ...this.cycle, scratch };
    this.alGuardar(scratch);
  };

  findOrderByCoid = async (coid: string) => {
    const f = this.filas.get(coid);
    return f ? { ...f, venue_order_id: f.venueOrderId, updated_at: new Date() } : null;
  };

  upsertPendingOrder = async (i: {
    cycleSeq: number;
    order: { clientOrderId: string; qty: string; levelKind: string };
    venueClientId: string;
  }) => {
    this.filas.set(i.order.clientOrderId, {
      status: 'PENDING',
      cycleSeq: i.cycleSeq,
      venueClientId: i.venueClientId,
      venueOrderId: null,
      qty: i.order.qty,
      filled: '0',
      levelKind: i.order.levelKind,
    });
  };

  confirmOrder = async (coid: string, ack: OrderAck) => {
    const f = this.filas.get(coid);
    if (f) {
      f.status = ack.status;
      f.venueOrderId = ack.venueOrderId;
    }
  };

  rejectOrder = async (coid: string) => {
    const f = this.filas.get(coid);
    if (f) f.status = 'REJECTED';
  };

  private vivas = ['PENDING', 'OPEN', 'PARTIALLY_FILLED'];

  markOrderCanceled = async (_b: string, venueOrderId: string) => {
    for (const f of this.filas.values()) {
      if (f.venueOrderId === venueOrderId && this.vivas.includes(f.status)) f.status = 'CANCELED';
    }
  };

  markCoidsCanceled = async (_b: string, coids: string[]) => {
    for (const c of coids) {
      const f = this.filas.get(c);
      if (f && this.vivas.includes(f.status)) f.status = 'CANCELED';
    }
  };

  liveOrderCoids = async (_b: string, o?: { keepProtective?: boolean }) =>
    [...this.filas.entries()]
      .filter(([, f]) => this.vivas.includes(f.status))
      .filter(([, f]) => !(o?.keepProtective && f.levelKind === 'STOP_LOSS'))
      .map(([c]) => c);

  ownVenueClientIds = async (_b: string, seqs: number[]) =>
    [...this.filas.values()].filter((f) => seqs.includes(f.cycleSeq)).map((f) => f.venueClientId);

  recordFill = async (_b: string, fill: Fill) => {
    const hit = [...this.filas.entries()].find(
      ([c, f]) => f.venueClientId === fill.clientOrderId || c === fill.clientOrderId,
    );
    if (!hit || this.fills.has(fill.venueFillId)) return null;
    this.fills.add(fill.venueFillId);
    const [coid, f] = hit;
    f.filled = D(f.filled).plus(fill.qty).toFixed();
    f.status = D(f.filled).gte(f.qty) ? 'FILLED' : 'PARTIALLY_FILLED';
    return coid;
  };

  applyFillToCycle = async (
    _b: string,
    cycle: CycleState,
    fill: Fill,
    opts: { eventoCierre?: (c: { seq: number; pnl: Decimal }) => EventoCierre } = {},
  ) => {
    const f = fill.clientOrderId ? this.filas.get(fill.clientOrderId) : undefined;
    const r = cycleAfterFill(
      cycle,
      this.totals,
      fill,
      { cooldownMinutes: 0, levelComplete: f ? D(f.filled).gte(f.qty) : true },
      Date.now(),
    );
    if (!r.closed) {
      this.totals = r.totals;
      this.cycle = r.cycle;
      return this.cycle;
    }
    this.cerrados.push({ pnl: r.totals.realizedPnl.toFixed(), en: Date.now() });
    // Como el store de verdad: el evento del cierre, el de siempre o el que se pida.
    const cierre = { seq: Number(cycle.scratch.cycleSeq), pnl: r.totals.realizedPnl };
    this.eventos.push(
      opts.eventoCierre?.(cierre) ?? {
        type: 'CYCLE_CLOSED',
        severity: 'INFO',
        message: `Ciclo #${cierre.seq} cerrado.`,
        payload: { realizedPnl: cierre.pnl.toFixed(), seq: cierre.seq },
      },
    );
    this.totals = Memoria.vacio();
    const seq = Number(cycle.scratch.cycleSeq) + 1;
    this.cycle = { ...r.cycle, scratch: { cycleSeq: seq, cooldownMinutes: 0 } };
    return this.cycle;
  };

  olvidarHistorial = (): void => undefined;

  historialOperaciones = async (): Promise<HistorialOperaciones> => {
    const ahora = Date.now();
    const dia = Math.floor(ahora / 86_400_000) * 86_400_000;
    const hoy = this.cerrados.filter((c) => c.en >= dia);
    const ultimo = this.cerrados.at(-1);
    return {
      dia,
      operacionesHoy: hoy.length,
      realizadoHoy: hoy.reduce((a, c) => a.plus(c.pnl), D(0)).toFixed(),
      rachaPerdidas: 0,
      ultimoCierreEn: ultimo?.en ?? null,
      ultimaPerdidaEn: null,
      ultimoStopEn: null,
      realizadoTotal: this.cerrados.reduce((a, c) => a.plus(c.pnl), D(0)).toFixed(),
      picoRealizado: '0',
    };
  };
}

const VALE = '0123456789abcdef0123456789abcdef';

interface FilaIntencion {
  estado: string;
  barT: number;
  plan: PlanOperacion | null;
  motivo: string | null;
}

/**
 * Las intenciones en memoria, con las reglas de la base: una viva por bot y
 * cada cambio condicionado al estado de antes. En modo IA guarda además las
 * solicitudes, y `decidir` hace lo que haría la API (spec 059).
 */
class Intenciones implements AiIntentsLike {
  readonly filas = new Map<string, FilaIntencion>();
  readonly solicitudes: (SolicitudIa & { id: string; cycleSeq: number })[] = [];
  /** La última de la IA, tal y como la lee la estrategia. */
  private ultima: DecisionIa | null = null;

  private viva(): boolean {
    return [...this.filas.values()].some((f) => f.estado === 'ACEPTADA' || f.estado === 'ABIERTA');
  }

  /** La intención de la IA refleja el estado de su fila. */
  private reflejar(id: string): void {
    const f = this.filas.get(id);
    if (this.ultima?.intentId === id && f) {
      this.ultima = { ...this.ultima, estado: f.estado as DecisionIa['estado'], motivo: f.motivo };
    }
  }

  vigente = async (): Promise<DecisionIa | null> => this.ultima;

  solicitar = async (_b: unknown, cycleSeq: number, sol: SolicitudIa) => {
    if (this.solicitudes.some((s) => s.barT === sol.barT)) return false;
    const id = `ia-${this.solicitudes.length + 1}`;
    this.solicitudes.push({ ...sol, id, cycleSeq });
    this.filas.set(id, { estado: 'SOLICITADA', barT: sol.barT, plan: null, motivo: null });
    this.ultima = {
      intentId: id,
      estado: 'SOLICITADA',
      origen: 'IA',
      barT: sol.barT,
      huella: sol.huella,
      eleccion: null,
      motivo: null,
      expiresAt: sol.expiresAt,
      cycleSeq,
    };
    return true;
  };

  /** Lo que escribe la API al responder. */
  decidir(
    id: string,
    estado: 'DECIDIDA' | 'FALLIDA',
    eleccion: EleccionOperacion | null,
    extra: Partial<DecisionIa> = {},
  ): void {
    const f = this.filas.get(id);
    if (!f || !this.ultima || this.ultima.intentId !== id) throw new Error('sin solicitud');
    f.estado = estado;
    this.ultima = { ...this.ultima, estado, eleccion, ...extra };
  }

  anotar = async (_b: string, _s: number, m: MarcaDecision) => {
    const fila = this.filas.get(m.intentId);
    if (m.estado === 'ACEPTADA') {
      if (this.viva() || !m.plan) return false;
      if (fila) {
        if (fila.estado !== 'DECIDIDA') return false;
        fila.estado = 'ACEPTADA';
        fila.plan = m.plan;
        this.reflejar(m.intentId);
        return true;
      }
      this.filas.set(m.intentId, {
        estado: 'ACEPTADA',
        barT: m.plan.barT,
        plan: m.plan,
        motivo: null,
      });
      return true;
    }
    if (fila && (fila.estado === 'ACEPTADA' || fila.estado === 'DECIDIDA')) {
      fila.estado = 'RECHAZADA';
      fila.motivo = m.motivo;
      this.reflejar(m.intentId);
      return true;
    }
    return false;
  };

  abrir = async (_b: string, id: string) => {
    const f = this.filas.get(id);
    if (f?.estado !== 'ACEPTADA') return false;
    f.estado = 'ABIERTA';
    this.reflejar(id);
    return true;
  };

  cerrar = async () => {
    for (const [id, f] of this.filas) {
      if (f.estado === 'ACEPTADA' || f.estado === 'ABIERTA') {
        f.estado = 'CERRADA';
        this.reflejar(id);
      }
    }
  };

  caducarPendientes = async () => 0;

  valeDePausa = async () => VALE;
}

const esperar = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('canal con IA, de principio a fin en el simulador (spec 058)', () => {
  let reloj = esc.fin + 4_000;

  beforeEach(() => {
    vaciarCacheAnalisis();
    reloj = esc.fin + 4_000;
    jest.spyOn(Date, 'now').mockImplementation(() => reloj);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function montar(ajustes: Record<string, unknown> = {}, guardas: Record<string, string> = {}) {
    const fuente = new Fuente();
    const sim = new DryRunAdapter(fuente, { closeSource: false, runId: 'e2e' });
    const memoria = new Memoria();
    const intenciones = new Intenciones();
    const velas: CandleSourceLike = {
      candleHistory: (_v, _s, interval) =>
        (esc.series as Record<string, Candle[]>)[interval] ?? null,
    };
    const s = getStrategy(StrategyKind.AI_CHANNEL);
    const runner = new BotRunner({
      bot: {
        id: BOT_ID,
        user_id: 'admin-1',
        exchange_account_id: 'acc-1',
        venue: HL,
        symbol: 'SOL',
        strategy: 'AI_CHANNEL',
        direction: 'NEUTRAL',
        leverage: 25,
        margin_mode: 'ISOLATED',
        config_version: 1,
        dry_run: true,
        total_investment: '1000',
      } as unknown as BotRecord,
      adapter: sim,
      testnet: false,
      market: MARKET,
      config: {
        exchangeAccountId: 'acc-1',
        symbol: 'SOL',
        ...s.defaults(),
        totalInvestment: '1000',
        decisionMode: 'REGLAS',
        ...ajustes,
      } as never,
      cycle: {
        cycleId: 'c1',
        startedAt: reloj,
        entriesFilled: 0,
        lastEntryAt: null,
        filledLevelIndexes: [],
        cooldownUntil: null,
        realizedPnl: '0',
        realizedPnlAcc: '0',
        averageEntry: null,
        anchorPrice: null,
        scratch: { cycleSeq: 1, cooldownMinutes: 0 },
      },
      store: memoria as unknown as BotStore,
      guards: {
        maxNotionalPerBot: null,
        maxDailyLoss: null,
        killSwitchDrawdownPct: null,
        liquidationAlertPct: null,
        maxLeverage: null,
        maxTotalNotional: null,
        ...guardas,
      },
      reconcileIntervalMs: 600_000,
      candleSource: velas,
      intents: intenciones,
      interruptorCanal: async () => ({ permitidas: true, motivo: null }),
      onDetach: () => undefined,
    });
    const tick = () =>
      (
        runner as unknown as {
          exclusive(f: () => Promise<void>): Promise<void>;
          tick(): Promise<void>;
        }
      ).exclusive(() => (runner as unknown as { tick(): Promise<void> }).tick());
    const libro = () => sim.getOpenOrders('SOL');
    const posicion = async (): Promise<Position | null> =>
      (await sim.getPositions('SOL'))[0] ?? null;
    return { runner, sim, fuente, memoria, intenciones, tick, libro, posicion };
  }

  it('entra, protege, cobra por tramos con breakeven y espera antes de volver a entrar', async () => {
    // En este canal el objetivo en la media da algo menos de 1R neto: con el
    // mínimo por defecto (1,2) no se ofrece, y el escalonado necesita los dos.
    const h = montar({ minRewardRisk: 0.5 });

    // ── La entrada ──────────────────────────────────────────────────
    await h.runner.start();
    await esperar();

    const pos = await h.posicion();
    expect(pos).not.toBeNull();
    expect(D(pos!.qty).gt(0)).toBe(true);
    // Con el apalancamiento que pidió la operación, fijado antes de entrar.
    const intencion = [...h.intenciones.filas.values()][0];
    expect(intencion.plan?.apalancamiento).toBe(25);
    expect(intencion.plan?.eleccion.objetivo).toBe('ESCALONADO');
    expect(pos!.leverage).toBeCloseTo(25, 6);
    // La entrada fue una IOC con tope: nada de ella queda en el libro.
    const libro = await h.libro();
    expect(libro.some((o) => !o.reduceOnly)).toBe(false);

    // ── La protección: stop nativo y dos objetivos ─────────────────
    const stop = libro.find((o) => o.triggerPrice !== null);
    expect(stop).toMatchObject({ side: 'SELL', reduceOnly: true, qty: pos!.qty });
    expect(D(stop!.triggerPrice!).toFixed()).toBe(D(intencion.plan!.stop).toFixed());
    const objetivos = libro
      .filter((o) => o.triggerPrice === null)
      .sort((a, b) => D(a.price).comparedTo(b.price));
    expect(objetivos).toHaveLength(2);
    expect(D(objetivos[0].qty).plus(objetivos[1].qty).toFixed()).toBe(D(pos!.qty).toFixed());
    expect(intencion.estado).toBe('ABIERTA');

    // ── El primer objetivo, y el stop a breakeven ──────────────────
    reloj += 60_000;
    h.fuente.fijar(objetivos[0].price);
    await esperar();
    await h.tick();

    const trasTp1 = await h.posicion();
    expect(D(trasTp1!.qty).toFixed()).toBe(D(objetivos[1].qty).toFixed());
    const stopBe = (await h.libro()).find((o) => o.triggerPrice !== null);
    expect(D(stopBe!.triggerPrice!).gt(pos!.entryPrice)).toBe(true);
    expect(stopBe!.qty).toBe(D(objetivos[1].qty).toFixed());
    expect(h.memoria.eventos.some((e) => e.type === 'AI_BREAKEVEN')).toBe(true);

    // ── El segundo objetivo: fuera, y el ciclo cerrado ─────────────
    reloj += 60_000;
    h.fuente.fijar(objetivos[1].price);
    await esperar();
    await h.tick();

    expect(await h.posicion()).toBeNull();
    expect(h.memoria.cerrados).toHaveLength(1);
    expect(D(h.memoria.cerrados[0].pnl).gt(0)).toBe(true);
    expect(intencion.estado).toBe('CERRADA');
    // La entrada se avisó una vez, con su botón; la salida, con AI_EXIT y no con
    // CYCLE_CLOSED (spec 059).
    const entradas = h.memoria.eventos.filter((e) => e.type === 'AI_ENTRY');
    expect(entradas).toHaveLength(1);
    expect(entradas[0].payload).toMatchObject({ vale: VALE });
    expect(h.memoria.eventos.some((e) => e.type === 'CYCLE_CLOSED')).toBe(false);
    const salida = h.memoria.eventos.find((e) => e.type === 'AI_EXIT');
    expect(salida?.payload).toMatchObject({ motivo: 'OBJETIVO', seq: 1 });
    expect(Number(salida?.payload?.['r'])).toBeGreaterThan(0);
    // El stop de la operación terminada no se queda suelto en el libro.
    expect(await h.libro()).toEqual([]);

    // ── La espera, sin volver a decidir con la misma vela ───────────
    h.fuente.fijar(PRECIO);
    await h.tick();
    expect(h.memoria.notas.at(-1)).toMatch(/^Espera entre operaciones: 15 min/);
    expect(await h.posicion()).toBeNull();
    expect(h.intenciones.filas.size).toBe(1);
    expect(h.memoria.cycle.scratch['op']).toBeUndefined();

    await h.runner.dispose();
  });

  it('sin esperas configuradas, tampoco vuelve a entrar con la vela de la operación cerrada', async () => {
    const h = montar({ minRewardRisk: 0.5, cooldownMinutes: 0, stopCooldownMinutes: 0 });
    await h.runner.start();
    await esperar();
    const objetivos = (await h.libro())
      .filter((o) => o.triggerPrice === null)
      .sort((a, b) => D(a.price).comparedTo(b.price));
    expect(objetivos).toHaveLength(2);

    for (const objetivo of objetivos) {
      reloj += 60_000;
      h.fuente.fijar(objetivo.price);
      await esperar();
      await h.tick();
    }
    expect(await h.posicion()).toBeNull();
    expect(h.memoria.cerrados).toHaveLength(1);

    h.fuente.fijar(PRECIO);
    await h.tick();
    expect(h.memoria.notas.at(-1)).toMatch(/siguiente vela tras la última salida/);
    expect(await h.posicion()).toBeNull();
    expect(h.intenciones.filas.size).toBe(1);
    await h.runner.dispose();
  });

  it('una entrada que no llega a su tope no deja nada: se descarta en su tick', async () => {
    const h = montar();
    // Entre el plan y la orden, el ask se va por encima del tope: la IOC no casa.
    let movido = false;
    h.memoria.alGuardar = (scratch) => {
      if (movido || !scratch['op']) return;
      movido = true;
      h.fuente.ticker$.next({ ...h.fuente.actual, ask: D(PRECIO).plus(5).toFixed(2) });
    };

    await h.runner.start();
    await esperar();
    expect(await h.posicion()).toBeNull();
    const intencion = [...h.intenciones.filas.values()][0];
    expect(intencion.estado).toBe('ACEPTADA');

    // Pasado el plazo de llenado, la intención se rechaza y la operación se olvida.
    reloj += 31_000;
    await h.tick();
    expect(intencion.estado).toBe('RECHAZADA');
    expect(intencion.motivo).toBe('VENUE');
    expect(h.memoria.cycle.scratch['op']).toBeNull();

    // Y no vuelve a entrar en la misma vela.
    await h.tick();
    expect(await h.posicion()).toBeNull();
    expect(h.intenciones.filas.size).toBe(1);

    await h.runner.dispose();
  });

  it('con el interruptor apagado ni se decide ni se entra', async () => {
    const h = montar();
    (h.runner as unknown as { deps: { interruptorCanal: unknown } }).deps.interruptorCanal =
      async () => ({ permitidas: false, motivo: 'cortadas' });

    await h.runner.start();
    await esperar();

    expect(await h.posicion()).toBeNull();
    expect(h.intenciones.filas.size).toBe(0);
    await h.runner.dispose();
  });

  it('parseCoid reconoce las órdenes de la operación (el ciclo cuenta su entrada)', async () => {
    const h = montar();
    await h.runner.start();
    await esperar();

    expect(h.memoria.cycle.entriesFilled).toBe(1);
    const base = [...h.memoria.filas.keys()].find((c) => parseCoid(c)?.kind === 'BASE');
    expect(base).toBeDefined();

    // Con el R mínimo por defecto, el objetivo corto no llega: la operación va
    // entera al borde opuesto, con un solo objetivo por toda la posición.
    const plan = [...h.intenciones.filas.values()][0].plan!;
    expect(plan.eleccion.objetivo).toBe('OPUESTO');
    const objetivos = (await h.libro()).filter((o) => o.triggerPrice === null);
    expect(objetivos).toHaveLength(1);
    expect(objetivos[0].qty).toBe((await h.posicion())!.qty);
    await h.runner.dispose();
  });
  /**
   * Spec 060, F-03. Las guardas del motor se miran antes de planificar, y una
   * que salta pausa y sale: el tick siguiente al llenado, que es el que pone el
   * stop, no llegaba a ponerlo. Pausado, el bot no planifica ni vigila, así que
   * la posición a 25x se quedaba sin stop y sin nadie que la cerrara.
   *
   * Aquí salta el tope de caída del usuario (10 %), más estricto que la caída
   * máxima del canal (15 %, medida desde el pico): con 98 de pérdida de días
   * anteriores el canal deja entrar, y la comisión y el diferencial de la
   * entrada pasan la cuenta del 10 %.
   */
  it('una guarda que pausa al llenarse la entrada no deja la posición sin stop', async () => {
    const h = montar({ minRewardRisk: 0.5 }, { killSwitchDrawdownPct: '10' });
    // Como el store de verdad.
    h.memoria.drawdownPct = ((invertido: string, equity: string) => {
      const e = D(equity);
      return e.gte(0) ? D(0) : e.abs().div(invertido).mul(100);
    }) as never;
    h.memoria.cerrados.push({ pnl: '-98', en: reloj - 3 * 86_400_000 });
    (h.runner as unknown as { cycle: CycleState }).cycle.realizedPnlAcc = '-98';

    await h.runner.start();
    await esperar();

    const protegida = async () =>
      (await h.posicion()) === null || (await h.libro()).some((o) => o.triggerPrice !== null);
    expect(h.memoria.eventos.some((e) => e.type === 'RISK_GUARD_TRIPPED')).toBe(true);
    expect(await protegida()).toBe(true);

    // Un minuto de revisiones después, igual.
    for (let i = 0; i < 20; i++) {
      reloj += 3_000;
      await h.tick();
    }
    expect(await protegida()).toBe(true);
    await h.runner.dispose();
  });

  it('pausado, «cancelar todas las órdenes» vuelve a poner el stop (spec 060, F-03)', async () => {
    const h = montar({ minRewardRisk: 0.5 });
    await h.runner.start();
    await esperar();
    const conStop = async () => (await h.libro()).some((o) => o.triggerPrice !== null);
    expect(await conStop()).toBe(true);

    await h.runner.handleCommand('PAUSE');
    expect(await conStop()).toBe(true);
    await h.runner.handleCommand('CANCEL_ALL_ORDERS');
    await esperar();

    expect(await h.posicion()).not.toBeNull();
    expect(await conStop()).toBe(true);
    await h.runner.dispose();
  });

  it('pausado y con el venue rechazando el stop, el vigilante cierra (spec 060, F-03)', async () => {
    const h = montar({ minRewardRisk: 0.5 });
    await h.runner.start();
    await esperar();
    expect(await h.posicion()).not.toBeNull();

    // El venue deja de aceptar el stop: es justo el caso para el que existe el
    // vigilante, y con el bot pausado tampoco corría.
    const colocar = h.sim.placeOrder.bind(h.sim);
    h.sim.placeOrder = async (req) => {
      if (req.triggerPrice) throw new ExchangeError('RULES', 'stop rechazado', HL);
      return colocar(req);
    };

    await h.runner.handleCommand('PAUSE');
    // El temporizador que dejó la entrada se limpia aquí: lo que hay que ver es
    // si el bot PAUSADO se programa uno nuevo al quedarse sin stop.
    const interno = h.runner as unknown as { vigilanciaTimer: NodeJS.Timeout | null };
    if (interno.vigilanciaTimer) clearTimeout(interno.vigilanciaTimer);
    interno.vigilanciaTimer = null;

    await h.runner.handleCommand('CANCEL_ALL_ORDERS');
    await esperar();
    expect((await h.libro()).some((o) => o.triggerPrice !== null)).toBe(false);
    expect(interno.vigilanciaTimer).not.toBeNull();

    // Pasan los cinco segundos del vigilante.
    reloj += 6_000;
    await h.tick();
    await esperar();

    expect(await h.posicion()).toBeNull();
    expect(h.memoria.eventos.some((e) => e.type === 'SIN_STOP')).toBe(true);
    await h.runner.dispose();
  });

  describe('en modo IA (spec 059)', () => {
    type Solicitud = Intenciones['solicitudes'][number];

    /** La primera opción disponible de la oferta, como la elegiría la API. */
    function elegir(sol: Solicitud, confianza: 'ALTA' | 'MEDIA' = 'ALTA') {
      const cand = sol.snapshot.candidatos.find(
        (c) => c.estado === 'LISTO' && c.descartes.length === 0,
      );
      const op = cand?.stops.find((s) => s.viable && s.medioViable);
      if (!cand || !op?.cantidad) throw new Error('la oferta no tiene nada disponible');
      const eleccion: EleccionOperacion = eleccionEfectiva({
        veredicto: 'OPERAR',
        opcion: cand.id,
        stop: op.tipo,
        objetivo: op.esquemasViables[0],
        apalancamiento: 'BAJA',
        tamano: 'COMPLETO',
        confianza,
      });
      return { eleccion, cantidad: op.cantidad };
    }

    it('solicitud, decisión, la mitad por confianza media, protección y salida por el stop', async () => {
      const h = montar({ decisionMode: 'IA', minRewardRisk: 0.5 });
      await h.runner.start();
      await esperar();

      // Sin decisión no se opera: se pide.
      expect(await h.posicion()).toBeNull();
      expect(h.intenciones.solicitudes).toHaveLength(1);
      const sol = h.intenciones.solicitudes[0];

      // La API decide con confianza media: se ejecuta la mitad.
      const { eleccion, cantidad } = elegir(sol, 'MEDIA');
      expect(eleccion.tamano).toBe('MEDIO');
      h.intenciones.decidir(sol.id, 'DECIDIDA', eleccion);
      h.runner.pedirTick();
      await esperar();

      const pos = await h.posicion();
      expect(pos).not.toBeNull();
      const fila = h.intenciones.filas.get(sol.id);
      if (!fila?.plan) throw new Error('sin operación');
      expect(fila.estado).toBe('ABIERTA');
      expect(fila.plan.eleccion.tamano).toBe('MEDIO');
      expect(D(fila.plan.cantidad).toFixed()).toBe(
        D(cantidad).div(2).toDecimalPlaces(3, 1).toFixed(),
      );
      expect(D(pos!.qty).toFixed()).toBe(D(fila.plan.cantidad).toFixed());

      // El aviso de entrada, una vez y con su botón.
      const entradas = h.memoria.eventos.filter((e) => e.type === 'AI_ENTRY');
      expect(entradas).toHaveLength(1);
      expect(entradas[0].payload).toMatchObject({ intentId: sol.id, vale: VALE });

      // La protección nativa, con el stop del plan.
      const stop = (await h.libro()).find((o) => o.triggerPrice !== null);
      expect(D(stop!.triggerPrice!).toFixed()).toBe(D(fila.plan.stop).toFixed());

      // El precio pasa el stop: fuera, con AI_EXIT y sin CYCLE_CLOSED.
      reloj += 60_000;
      h.fuente.fijar(D(fila.plan.stop).minus('0.05').toFixed(2));
      await esperar();
      await h.tick();
      expect(await h.posicion()).toBeNull();
      expect(fila.estado).toBe('CERRADA');
      expect(h.memoria.eventos.some((e) => e.type === 'CYCLE_CLOSED')).toBe(false);
      const salida = h.memoria.eventos.find((e) => e.type === 'AI_EXIT');
      expect(salida?.payload).toMatchObject({ motivo: 'STOP', intentId: sol.id });
      const r = Number(salida?.payload?.['r']);
      expect(r).toBeLessThan(0);
      expect(r).toBeGreaterThan(-1.5);
      await h.runner.dispose();
    });

    it.each<[string, (h: ReturnType<typeof montar>, sol: Solicitud) => void, string]>([
      [
        'tardía',
        (h, sol) =>
          h.intenciones.decidir(sol.id, 'DECIDIDA', elegir(sol).eleccion, { expiresAt: reloj - 1 }),
        'PLAZO',
      ],
      [
        'fuera de la oferta',
        (h, sol) =>
          h.intenciones.decidir(sol.id, 'DECIDIDA', {
            ...elegir(sol).eleccion,
            opcion: 'REB-S-H0',
          }),
        'OFERTA',
      ],
      [
        'sobre otra oferta',
        (h, sol) =>
          h.intenciones.decidir(sol.id, 'DECIDIDA', elegir(sol).eleccion, { huella: 'otra' }),
        'HUELLA',
      ],
    ])('una decisión %s no abre nada', async (_, decidir, motivo) => {
      const h = montar({ decisionMode: 'IA', minRewardRisk: 0.5 });
      await h.runner.start();
      await esperar();
      const sol = h.intenciones.solicitudes[0];
      decidir(h, sol);
      h.runner.pedirTick();
      await esperar();

      expect(await h.posicion()).toBeNull();
      expect(await h.libro()).toEqual([]);
      expect(h.intenciones.filas.get(sol.id)).toMatchObject({ estado: 'RECHAZADA', motivo });
      // Y no se vuelve a pedir en la misma vela.
      await h.tick();
      expect(h.intenciones.solicitudes).toHaveLength(1);
      expect(h.memoria.eventos.some((e) => e.type === 'AI_ENTRY')).toBe(false);
      await h.runner.dispose();
    });

    it('sin respuesta válida no abre nada ni vuelve a pedir en la misma vela', async () => {
      const h = montar({ decisionMode: 'IA', minRewardRisk: 0.5 });
      await h.runner.start();
      await esperar();
      const sol = h.intenciones.solicitudes[0];
      h.intenciones.decidir(sol.id, 'FALLIDA', null, { motivo: 'MODELO' });
      h.runner.pedirTick();
      await esperar();

      expect(await h.posicion()).toBeNull();
      expect(await h.libro()).toEqual([]);
      expect(h.intenciones.solicitudes).toHaveLength(1);
      expect(h.memoria.notas.at(-1)).toMatch(/no operó en esta vela: MODELO/);
      await h.runner.dispose();
    });
  });
});
