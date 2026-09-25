import {
  D,
  Decimal,
  agregarVelas,
  candleSpanMs,
  esEstrategiaDeAgente,
  type BacktestOperacionView,
  type BacktestParams,
  type Candle,
  type CandleInterval,
  type BacktestFillView,
  type BotConfig,
  type BotContext,
  type CycleState,
  type DesiredOrder,
  type DesiredState,
  type Fill,
  type HistorialOperaciones,
  type LimitesExternos,
  type MarketSpec,
  type NivelApalancamiento,
  type PlanOperacion,
  type Position,
  type SalidaOperacion,
  type StrategyKind,
  type Venue,
} from '@crypton/shared';
import {
  DryRunAdapter,
  ReplaySourceAdapter,
  VENUE_CAPABILITIES,
  codecFor,
  messageOf,
} from '@crypton/exchange-core';
import {
  cycleAfterFill,
  getStrategy,
  makeCoid,
  parseCoid,
  reconcile,
  revisarOrden,
  withStopLoss,
  type CycleTotals,
} from '@crypton/strategy-core';
import { tickPath, tickerAt } from './ticks';

/**
 * El bucle de replay.
 *
 * Espeja `BotRunner.tick()` sin nada de E/S, y la correspondencia es
 * deliberada — paso a paso:
 *
 *   1. drenar ejecuciones          ← `sweepFills` + `onFill`
 *   2. leer estado del simulador   ← el `Promise.all` de posiciones/órdenes/saldo
 *   3. guardas de riesgo           ← `checkRiskGuards` (el subconjunto puro)
 *   4. `plan()` + `withStopLoss`   ← idéntico
 *   5. `reconcile()`               ← idéntico, con `ownIds` exacto
 *   6. ejecutar cancelar→reemplazar→colocar ← `execute`, con `revisarOrden`
 *
 * Lo que queda FUERA a propósito: la persistencia, los leases, los comandos
 * manuales, el cortacircuitos por colocaciones fallidas, y las guardas que
 * dependen de las OTRAS posiciones del usuario. Todo eso se declara en los
 * avisos del resultado.
 *
 * La razón de que esta lista exista es la deriva: el día que alguien arregle un
 * orden de operaciones en el runner y no aquí, el backtest empezará a mentir sin
 * que falle ningún test. Las piezas de decisión son las MISMAS —`plan`,
 * `reconcile`, `withStopLoss`, `revisarOrden`, `cycleAfterFill`—, así que lo
 * único duplicado es esta orquestación.
 *
 * El canal con IA (spec 058) añade lo que el motor hace por él:
 *
 *   - series de velas cerradas, con calentamiento, e historial del día;
 *   - el juez en lugar de la IA (`sinIa`);
 *   - el apalancamiento de cada entrada, fijado en plano antes de colocarla;
 *   - reaccionar a sus ejecuciones en el mismo instante —el stop y los
 *     objetivos de una entrada, el breakeven— y cerrar si se queda sin stop;
 *   - y medirse como las tasas base: límites que se llenan solo si el precio
 *     las PASA, la vela hacia el stop primero y el hueco que salta el stop a la
 *     apertura.
 */

/** Cuántas veces se vuelve a planificar en un mismo instante tras una ejecución. */
const MAX_REACCIONES = 3;

/** El índice del cierre a mercado del vigilante del stop, como en el motor. */
const INDICE_CIERRE_VIGILANTE = 999;

const DIA_MS = 86_400_000;

/** Los cierres que se miran para la racha de pérdidas, como `BotStore`. */
const RACHA_MAXIMA = 50;

export interface ReplayOptions {
  botId: string;
  strategy: StrategyKind;
  config: BotConfig;
  venue: Venue;
  market: MarketSpec;
  interval: CandleInterval;
  candles: Candle[];
  /**
   * Velas ANTERIORES al rango, del mismo intervalo (spec 058). No se
   * reproducen: solo llenan las series de la estrategia que las pide, para que
   * decida desde la primera vela con el histórico que tendría en vivo.
   */
  warmup?: Candle[];
  params: BacktestParams;
  /** Se llama cada `yieldEvery` barras: sirve para ceder el bucle de eventos. */
  onProgress?: (bar: number, total: number) => Promise<void> | void;
  yieldEvery?: number;
}

export interface ReplayState {
  ts: number;
  equity: Decimal;
  position: Decimal;
}

export interface ReplayOutput {
  /**
   * Las ejecuciones que se devuelven, ACOTADAS a `MAX_FILLS_RETURNED`.
   *
   * Para contar hay que usar `fillsTotal`: un market maker sobre treinta dias
   * produce decenas de miles y esta lista se queda en las primeras dos mil.
   */
  fills: BacktestFillView[];
  /** Cuantas hubo de verdad. */
  fillsTotal: number;
  /** Repartos sobre el TOTAL, no sobre la lista acotada. */
  fillCounts: { buy: number; sell: number; maker: number; taker: number };
  equity: ReplayState[];
  cycles: {
    seq: number;
    openedAt: number;
    closedAt: number | null;
    entries: number;
    averageEntry: string | null;
    exitAvg: string | null;
    realizedPnl: string;
    fees: string;
  }[];
  liquidations: number;
  ticks: number;
  finalBalance: Decimal;
  realizedPnl: Decimal;
  feesPaid: Decimal;
  grossMatched: Decimal;
  /** Las operaciones cerradas de las estrategias que guardan su plan (spec 058). */
  operaciones: BacktestOperacionView[];
  warnings: string[];
}

/** El plan que la estrategia guardó en el scratch al entrar (`scratch.op`). */
function planGuardado(scratch: Record<string, unknown>): PlanOperacion | null {
  const op = scratch['op'];
  if (!op || typeof op !== 'object') return null;
  const plan = (op as { plan?: unknown }).plan;
  if (!plan || typeof plan !== 'object') return null;
  const p = plan as Partial<PlanOperacion>;
  return typeof p.riesgo === 'string' && typeof p.setup === 'string' ? (p as PlanOperacion) : null;
}

/** Por qué terminó una operación, según la orden que la cerró. */
function salidaDe(
  kind: string | null,
  indice: number | null,
  liquidacion: boolean,
): SalidaOperacion {
  if (liquidacion) return 'LIQUIDACION';
  if (kind === 'STOP_LOSS') return 'STOP';
  // Los objetivos son los primeros índices; los cierres a mercado de la
  // estrategia (500 en adelante) y el del vigilante (999), un cierre.
  if (kind === 'TAKE_PROFIT' && indice !== null && indice < 500) return 'OBJETIVO';
  return 'CIERRE';
}

const hayEntradas = (d: DesiredState): boolean =>
  d.orders.some((o) => !o.reduceOnly) || (d.immediate ?? []).some((o) => !o.reduceOnly);

/** El mismo plan sin sus entradas: lo que el motor hace cuando no deja entrar. */
function sinEntradas(d: DesiredState): DesiredState {
  return {
    ...d,
    orders: d.orders.filter((o) => o.reduceOnly),
    immediate: (d.immediate ?? []).filter((o) => o.reduceOnly),
    apalancamiento: undefined,
  };
}

/** Tope de ejecuciones que se devuelven. Un market maker produce decenas de miles. */
export const MAX_FILLS_RETURNED = 2000;

export async function runReplay(opts: ReplayOptions): Promise<ReplayOutput> {
  const { market, venue, params } = opts;
  // La API ya lo rechaza; esto es la red. Una operación de un agente es una
  // operación fechada, con su entrada a minutos de vencer: reproducirla sobre
  // otras velas no mide nada (spec 074).
  if (esEstrategiaDeAgente(opts.strategy)) {
    throw new Error(
      'Una operación de un agente no se reproduce: se mide con la tarjeta de su agente.',
    );
  }
  const strategy = getStrategy(opts.strategy);
  const encode = codecFor(venue).encode;
  const span = candleSpanMs(opts.interval);
  const warnings: string[] = [];

  // Aquí no hay IA a la que consultar: decide quien la sustituye en la propia
  // estrategia (el juez del canal, con el mismo perfil). Spec 058.
  const sinIa = strategy.consumeDecisionesIa === true && strategy.sinIa !== undefined;
  const config: BotConfig = sinIa ? strategy.sinIa(opts.config) : opts.config;
  if (sinIa) {
    warnings.push(
      'La IA no se consulta en el backtest: decide el juez de reglas, con el mismo perfil y los ' +
        'mismos límites. El resultado mide la herramienta y las reglas, no al modelo.',
    );
  }
  /** Apalancamiento por entrada y stop propio: el motor reacciona por ella (spec 058). */
  const porOperacion = strategy.apalancamientoPorOperacion === true;
  /** El canal con IA recibe además su historial, los tramos y los límites. */
  const delCanal = strategy.consumeDecisionesIa === true;

  const source = new ReplaySourceAdapter(venue, market);
  let clock = opts.candles[0]?.t ?? 0;

  const sim = new DryRunAdapter(source, {
    startingBalance: params.startingBalance,
    makerFeeRate: params.makerFeeRate,
    takerFeeRate: params.takerFeeRate,
    slippageRate: params.slippageRate,
    maintenanceMarginRate: params.maintenanceMarginRate,
    closeSource: false,
    now: () => clock,
    // Semilla fija: sin ella, dos ejecuciones del mismo rango producen ids
    // distintos y no se puede comprobar que el resultado es reproducible.
    runId: 'bt',
    // Una límite solo se llena si el precio la PASA: es la regla de las tasas
    // base que ve la IA, y llegar al borde no garantiza la ejecución.
    ...(porOperacion ? { limitFill: 'TRADE_THROUGH' as const } : {}),
  });

  // ANTES del bucle, y no es un detalle: `executeFill` cae a `leverage ?? 1` si
  // nadie lo ha fijado. Sin esta llamada TODA posición sería 1×, la liquidación
  // no saltaría jamás y el backtest enseñaría la martingala infalible que el
  // propio simulador describe como «la mentira más cara».
  await sim.setLeverage(market.symbol, params.leverage, params.marginMode as never);

  // ── Estado en memoria, el que el runner tiene en la base ─────────────────
  let cycle: CycleState = {
    cycleId: 'bt-1',
    startedAt: clock,
    entriesFilled: 0,
    lastEntryAt: null,
    filledLevelIndexes: [],
    cooldownUntil: null,
    realizedPnl: '0',
    realizedPnlAcc: '0',
    averageEntry: null,
    anchorPrice: null,
    scratch: { cycleSeq: 1, cooldownMinutes: Number(config.cooldownMinutes ?? 0) },
  };
  let totals: CycleTotals = {
    qty: D(0),
    averageEntry: null,
    realizedPnl: D(0),
    fees: D(0),
    entriesFilled: 0,
    filledLevelIndexes: [],
    anchorPrice: null,
    lastEntryAt: null,
  };

  /**
   * Traducción de espacio de venue a canónico.
   *
   * `DryRunAdapter` emite las ejecuciones con el id YA CODIFICADO
   * (`this.encode(...)`), y en Hyperliquid y Lighter eso es un hash. Sin este
   * mapa, `parseCoid` devolvería null en esos dos venues, `entriesFilled` se
   * quedaría en cero para siempre y una martingala recolocaría sus seguridades
   * sin parar. Es lo que `BotStore.recordFill` hace contra la base.
   */
  const canonical = new Map<string, string>();
  /** Ids en espacio de venue que este replay ha colocado. Es `ownIds`, exacto. */
  const emitted = new Map<string, number>();

  const fills: BacktestFillView[] = [];
  const equity: ReplayState[] = [];
  const cycles: ReplayOutput['cycles'] = [
    {
      seq: 1,
      openedAt: clock,
      closedAt: null,
      entries: 0,
      averageEntry: null,
      exitAvg: null,
      realizedPnl: '0',
      fees: '0',
    },
  ];

  // ── Velas y extremos, como los recibe `plan()` en el motor (spec 057, F-04) ──
  //
  // El contexto no los llevaba: Tendencia decía «esperando velas» en todo el
  // replay y no operaba nunca, y el seguimiento medía el máximo sobre el cierre.
  // La estrategia ve las velas de SU intervalo que ya han cerrado en la vela
  // reproducida, la actual incluida: se planifica al final de ella.
  const quiere = strategy.candles?.(config);
  const finDelRango = (opts.candles.at(-1)?.t ?? 0) + span;
  const velasEstrategia = quiere
    ? agregarVelas(opts.candles, opts.interval, quiere.interval, finDelRango)
    : null;
  const spanEstrategia = quiere ? candleSpanMs(quiere.interval) : 0;
  if (quiere && !velasEstrategia) {
    warnings.push(
      `La estrategia decide con velas de ${quiere.interval} y el backtest reproduce velas de ` +
        `${opts.interval}: unas no se pueden construir con las otras, así que no tiene con qué ` +
        `decidir y no opera. Reprodúcelo en ${quiere.interval} o en un intervalo que lo divida.`,
    );
  } else if (quiere) {
    warnings.push(
      `Las primeras ${quiere.bars} velas de ${quiere.interval} del rango sirven para calentar ` +
        'los indicadores: la estrategia no puede operar hasta que pasan.',
    );
  }
  /** Cuántas de `velasEstrategia` han cerrado ya. */
  let velasCerradas = 0;
  /** Las que ve la estrategia ahora; `undefined` si aún no llegan a las que pide. */
  let velasVistas: Candle[] | undefined;
  /**
   * Extremos de la marca desde la última planificación: la marca de agua del
   * runner (`observarExtremo`). Se leen en cada contexto y solo se vacían al
   * planificar.
   */
  let extremos: { alto: Decimal; bajo: Decimal } | null = null;

  // ── Las series del canal (spec 058) ──
  //
  // Como `candles`, pero varias y con calentamiento: las velas de antes del
  // rango completan cada serie desde la primera vela, que es lo que el bot
  // tendría en vivo. Cada una, topada en lo que el venue sirve de una vez, como
  // en el motor.
  const primeraVela = opts.candles[0]?.t ?? 0;
  const conCalentamiento = [
    ...(opts.warmup ?? []).filter((v) => v.t < primeraVela),
    ...opts.candles,
  ];
  const maxBarras = VENUE_CAPABILITIES[venue].candles.maxBars;
  const series = new Map<
    CandleInterval,
    { velas: Candle[]; bars: number; span: number; cerradas: number }
  >();
  for (const pedida of strategy.series?.(config) ?? []) {
    const velas = agregarVelas(conCalentamiento, opts.interval, pedida.interval, finDelRango);
    if (!velas) {
      warnings.push(
        `La estrategia necesita velas de ${pedida.interval} y el backtest reproduce velas de ` +
          `${opts.interval}: no se pueden construir con ellas, así que no opera. Reprodúcelo en ` +
          'un intervalo que las divida.',
      );
      continue;
    }
    series.set(pedida.interval, {
      velas,
      bars: Math.max(1, Math.min(pedida.bars, maxBarras - 3)),
      span: candleSpanMs(pedida.interval),
      cerradas: 0,
    });
  }
  /** Las series que ve la estrategia ahora. */
  let seriesVistas: Partial<Record<CandleInterval, Candle[]>> | undefined;
  let calentamientoRevisado = false;

  /** Avanza cada serie hasta `fin`: solo las velas que ya han cerrado. */
  const avanzarSeries = (fin: number): void => {
    if (series.size === 0) return;
    const vistas: Partial<Record<CandleInterval, Candle[]>> = {};
    for (const [iv, s] of series) {
      while (s.cerradas < s.velas.length && s.velas[s.cerradas].t + s.span <= fin) s.cerradas++;
      if (s.cerradas > 0) vistas[iv] = s.velas.slice(Math.max(0, s.cerradas - s.bars), s.cerradas);
      if (!calentamientoRevisado && s.cerradas < s.bars) {
        warnings.push(
          `Calentamiento corto: al empezar, la serie de ${iv} tiene ${s.cerradas} de las ` +
            `${s.bars} velas que pide la estrategia. Hasta completarla decide con menos ` +
            'histórico del que tendría en vivo.',
        );
      }
    }
    calentamientoRevisado = true;
    seriesVistas = vistas;
  };

  // ── El historial del día y lo demás que el motor le da al canal ──
  /** Los ciclos cerrados: en el canal, cada uno es una operación. */
  const cierres: { en: number; pnl: Decimal }[] = [];
  let ultimoStopEn: number | null = null;
  const historial = (): HistorialOperaciones => {
    // Como `BotStore.historialOperaciones`: día UTC, ciclos cerrados.
    const dia = Math.floor(clock / DIA_MS) * DIA_MS;
    let operacionesHoy = 0;
    let realizadoHoy = D(0);
    let total = D(0);
    let pico = D(0);
    for (const c of cierres) {
      total = total.plus(c.pnl);
      if (total.gt(pico)) pico = total;
      if (c.en >= dia) {
        operacionesHoy++;
        realizadoHoy = realizadoHoy.plus(c.pnl);
      }
    }
    const recientes = cierres.slice(-RACHA_MAXIMA).reverse();
    let racha = 0;
    while (racha < recientes.length && recientes[racha].pnl.lt(0)) racha++;
    return {
      dia,
      operacionesHoy,
      realizadoHoy: realizadoHoy.toFixed(),
      rachaPerdidas: racha,
      ultimoCierreEn: recientes[0]?.en ?? null,
      ultimaPerdidaEn: recientes.find((c) => c.pnl.lt(0))?.en ?? null,
      ultimoStopEn,
      realizadoTotal: total.toFixed(),
      picoRealizado: pico.toFixed(),
    };
  };
  // Los tramos, de la ficha: un solo tramo con el mantenimiento del simulador,
  // para que la regla de liquidación por stop mida lo mismo que liquida.
  const niveles: NivelApalancamiento[] = [
    {
      desdeNocional: '0',
      maxApalancamiento: market.maxLeverage,
      mantenimiento: params.maintenanceMarginRate,
    },
  ];
  // Ni interruptor global ni tope de la cuenta: el replay es un solo bot.
  const limites: LimitesExternos = {
    entradasPermitidas: true,
    maxApalancamientoUsuario: null,
    venueListo: true,
    motivo: null,
  };

  // ── El registro por operación (spec 058) ──
  const operaciones: BacktestOperacionView[] = [];
  let abierta: { plan: PlanOperacion; entradaEn: number; precio: string } | null = null;
  /** Avisos de la estrategia vivos, y cuántas veces saltó cada tipo. */
  const avisosVivos = new Set<string>();
  const avisosPorTipo = new Map<string, number>();
  /** Como `emitirAvisos` del motor: cada clave cuenta una vez mientras sigue. */
  const anotarAvisos = (avisos: DesiredState['avisos']): void => {
    const vigentes = new Set((avisos ?? []).map((a) => a.clave));
    for (const clave of [...avisosVivos]) {
      if (!vigentes.has(clave)) avisosVivos.delete(clave);
    }
    for (const a of avisos ?? []) {
      if (avisosVivos.has(a.clave)) continue;
      avisosVivos.add(a.clave);
      avisosPorTipo.set(a.tipo, (avisosPorTipo.get(a.tipo) ?? 0) + 1);
    }
  };
  let sinStop = 0;

  /** Rechazos del simulador al colocar: se cuentan, no se tragan (001/F-65). */
  const rechazados: string[] = [];
  let liquidations = 0;
  let grossMatched = D(0);
  let ticks = 0;
  let fillsTotal = 0;
  const fillCounts = { buy: 0, sell: 0, maker: 0, taker: 0 };
  let detenido = false;

  const pendientes: Fill[] = [];
  const sub = sim.streamFills().subscribe((f) => pendientes.push(f));

  const cycleSeq = () => Number(cycle.scratch.cycleSeq ?? 1);

  /** Drena la cola de ejecuciones. Espeja `sweepFills` + `onFill`. */
  const drenar = async (): Promise<void> => {
    while (pendientes.length > 0) {
      const raw = pendientes.shift()!;
      const canon = canonical.get(raw.clientOrderId ?? '') ?? null;
      const fill: Fill = { ...raw, clientOrderId: canon ?? '' };
      const parsed = canon ? parseCoid(canon) : null;

      const esLiquidacion = raw.liquidation === true;
      if (esLiquidacion) liquidations += 1;
      if (parsed?.kind === 'STOP_LOSS') ultimoStopEn = raw.ts;
      // La operación empieza con la ejecución de su entrada; el plan lo dejó la
      // estrategia en el scratch antes de colocarla.
      if (parsed?.kind === 'BASE' && abierta === null) {
        const plan = planGuardado(cycle.scratch);
        if (plan) abierta = { plan, entradaEn: raw.ts, precio: raw.price };
      }

      const antes = cycleSeq();
      const r = cycleAfterFill(
        cycle,
        totals,
        fill,
        {
          recycleLevelOnExit: strategy.recycleLevelOnExit,
          rebuysOffLevelIndexes: strategy.rebuysOffLevelIndexes,
          keepCycleOnFlat: strategy.keepCycleOnFlat,
          cooldownMinutes: Number(config.cooldownMinutes ?? 0),
        },
        clock,
      );

      cycle = r.cycle;
      totals = r.totals;
      grossMatched = grossMatched.plus(r.matched);
      // Los contadores se llevan APARTE de la lista: contar sobre ella daria
      // exactamente el tope en cuanto una ejecucion pase de ahi.
      fillsTotal += 1;
      if (raw.side === 'BUY') fillCounts.buy += 1;
      else fillCounts.sell += 1;
      if (raw.isTaker) fillCounts.taker += 1;
      else fillCounts.maker += 1;

      if (fills.length < MAX_FILLS_RETURNED) {
        fills.push({
          ts: raw.ts,
          side: raw.side,
          price: raw.price,
          qty: raw.qty,
          fee: raw.fee,
          isTaker: raw.isTaker,
          levelKind: esLiquidacion ? 'LIQUIDATION' : (parsed?.kind ?? null),
          levelIndex: parsed?.levelIndex ?? null,
          cycleSeq: antes,
          positionAfter: r.totals.qty.toFixed(),
          realizedAccAfter: r.cycle.realizedPnlAcc,
          liquidation: esLiquidacion,
        });
      }

      const abierto = cycles[cycles.length - 1];
      abierto.entries = r.totals.entriesFilled;
      abierto.averageEntry = r.totals.averageEntry?.toFixed() ?? null;
      abierto.realizedPnl = r.totals.realizedPnl.toFixed();
      abierto.fees = r.totals.fees.toFixed();

      if (r.closed) {
        abierto.closedAt = clock;
        abierto.exitAvg = raw.price;
        cierres.push({ en: clock, pnl: r.totals.realizedPnl });
        if (abierta) {
          const riesgo = D(abierta.plan.riesgo);
          operaciones.push({
            setup: abierta.plan.setup,
            lado: abierta.plan.lado,
            candidatoId: abierta.plan.candidatoId,
            entradaEn: abierta.entradaEn,
            salidaEn: raw.ts,
            precioEntrada: abierta.precio,
            precioSalida: raw.price,
            stop: abierta.plan.stop,
            objetivos: abierta.plan.objetivos.map((o) => o.precio),
            apalancamiento: abierta.plan.apalancamiento,
            riesgo: abierta.plan.riesgo,
            resultado: r.totals.realizedPnl.toFixed(),
            // Un cociente: sin unidades, en `number` (spec 058, R-17).
            r: riesgo.gt(0) ? r.totals.realizedPnl.div(riesgo).toNumber() : 0,
            rPlaneado: abierta.plan.rNeto,
            salida: salidaDe(parsed?.kind ?? null, parsed?.levelIndex ?? null, esLiquidacion),
          });
          abierta = null;
        }
        cycles.push({
          seq: cycleSeq(),
          openedAt: clock,
          closedAt: null,
          entries: 0,
          averageEntry: null,
          exitAvg: null,
          realizedPnl: '0',
          fees: '0',
        });
        totals = {
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

      // La estrategia se entera con el contexto EMPOBRECIDO exactamente igual
      // que en el runner. Copiarlo tal cual y no «mejorarlo» es lo que hace que
      // GridMart se comporte aquí como en producción.
      if (strategy.onFill) {
        cycle = strategy.onFill(
          {
            ...(await contexto(D(raw.price))),
            position: null,
            openOrders: [],
            availableBalance: '0',
          },
          fill,
          cycle,
        );
      }

      // Una liquidación deja el bot parado, igual que `afterLiquidation`: el
      // motor real se pausa y no vuelve a entrar solo.
      if (esLiquidacion) detenido = true;
    }
  };

  const contexto = async (precio: Decimal): Promise<BotContext> => {
    const [positions, openOrders, balances] = await Promise.all([
      sim.getPositions(market.symbol),
      sim.getOpenOrders(market.symbol),
      sim.getBalances(),
    ]);
    return {
      botId: opts.botId,
      venue,
      strategy: opts.strategy,
      config,
      market,
      ticker: await sim.getTicker(market.symbol),
      position: positions[0] ?? null,
      openOrders,
      cycle,
      availableBalance: balances[0]?.available ?? '0',
      now: clock,
      // Si la configuración ancla a una fuente externa, en el replay esa fuente
      // ES la serie que se está reproduciendo: son las mismas velas.
      fairPrice: precio.toFixed(),
      ...(velasVistas ? { candles: velasVistas } : {}),
      ...(extremos
        ? { extremos: { alto: extremos.alto.toFixed(), bajo: extremos.bajo.toFixed() } }
        : {}),
      ...(seriesVistas ? { series: seriesVistas } : {}),
      // Sin IA: la decisión la toma el juez dentro de la propia estrategia.
      ...(delCanal
        ? { historial: historial(), decisionIa: null, nivelesApalancamiento: niveles, limites }
        : {}),
    };
  };

  /** El lado de la posición abierta, o null en plano. */
  const ladoAbierto = async (): Promise<'LONG' | 'SHORT' | null> => {
    const pos = (await sim.getPositions(market.symbol))[0];
    if (!pos || D(pos.qty).isZero()) return null;
    return D(pos.qty).gt(0) ? 'LONG' : 'SHORT';
  };

  /**
   * Un hueco que salta el stop sale a la APERTURA, no al disparo: es la regla de
   * la triple barrera. El simulador ejecuta un stop disparado a su precio —el
   * supuesto de camino continuo que vale dentro de una vela—, así que antes del
   * primer precio de la vela se le pone el disparo en la apertura.
   */
  const saltarHuecos = async (apertura: Decimal): Promise<void> => {
    const lado = await ladoAbierto();
    if (!lado) return;
    for (const o of await sim.getOpenOrders(market.symbol)) {
      const canon = canonical.get(o.clientOrderId ?? '');
      if (!canon || !o.clientOrderId || !o.triggerPrice) continue;
      if (parseCoid(canon)?.kind !== 'STOP_LOSS') continue;
      const disparo = D(o.triggerPrice);
      const saltado = lado === 'LONG' ? apertura.lt(disparo) : apertura.gt(disparo);
      if (!saltado) continue;
      await sim.cancelOwn(market.symbol, [o.clientOrderId]);
      await sim
        .placeOrder({
          symbol: market.symbol,
          side: o.side,
          type: o.type,
          price: apertura.toFixed(),
          qty: D(o.qty).minus(o.filledQty).toFixed(),
          clientOrderId: canon,
          reduceOnly: true,
          triggerPrice: apertura.toFixed(),
          intent: 'SL',
        })
        .catch((e: unknown) => rechazados.push(messageOf(e)));
    }
  };

  /**
   * El vigilante del stop del motor: una posición que, tras planificar, sigue
   * sin stop en el libro se cierra a mercado en el acto.
   */
  const vigilarStop = async (): Promise<void> => {
    const lado = await ladoAbierto();
    if (!lado) return;
    const libro = await sim.getOpenOrders(market.symbol);
    const conStop = libro.some(
      (o) => parseCoid(canonical.get(o.clientOrderId ?? '') ?? '')?.kind === 'STOP_LOSS',
    );
    if (conStop) return;
    sinStop++;
    const pos = (await sim.getPositions(market.symbol))[0];
    const coid = makeCoid(opts.botId, cycleSeq(), 'TAKE_PROFIT', INDICE_CIERRE_VIGILANTE);
    const venueId = encode(coid);
    canonical.set(venueId, coid);
    emitted.set(venueId, cycleSeq());
    await sim
      .placeOrder({
        symbol: market.symbol,
        side: lado === 'LONG' ? 'SELL' : 'BUY',
        type: 'MARKET',
        qty: D(pos.qty).abs().toFixed(),
        clientOrderId: coid,
        reduceOnly: true,
      })
      .catch((e: unknown) => rechazados.push(messageOf(e)));
    await drenar();
  };

  /** Ejecuciones ya vistas por la última planificación. */
  let fillsPlanificados = 0;

  /**
   * El motor planifica en cuanto el canal ejecuta algo: el stop y los objetivos
   * de una entrada salen en segundos, y el breakeven tras el primer objetivo
   * también. Aquí, en el mismo instante. Después, el vigilante.
   */
  const reaccionar = async (precio: Decimal): Promise<void> => {
    if (!porOperacion || detenido) return;
    for (let i = 0; i < MAX_REACCIONES && fillsTotal > fillsPlanificados && !detenido; i++) {
      await planificar(precio);
      await drenar();
    }
    if (!detenido) await vigilarStop();
  };

  const yieldEvery = opts.yieldEvery ?? 250;

  for (let i = 0; i < opts.candles.length && !detenido; i++) {
    const bar = opts.candles[i];
    // Con posición, el canal recorre la vela hacia su stop primero (ver `tickPath`).
    const adverso = porOperacion ? await ladoAbierto() : null;

    for (const step of tickPath(bar, opts.interval, params.barPath, adverso)) {
      clock = step.ts;
      ticks += 1;
      // `tickerAt` pone la marca en el precio del paso.
      extremos = extremos
        ? {
            alto: Decimal.max(extremos.alto, step.price),
            bajo: Decimal.min(extremos.bajo, step.price),
          }
        : { alto: step.price, bajo: step.price };
      if (porOperacion && step.role === 'open') await saltarHuecos(step.price);
      source.setTicker(tickerAt(venue, market, step.price, step.role, step.ts, params.spreadBps));
      // Es `getTicker` y no el flujo quien dispara la casación: el simulador
      // comprueba liquidación y casa órdenes en reposo en cada precio que ve.
      await sim.getTicker(market.symbol);
      await drenar();
      await reaccionar(step.price);
      if (detenido) break;
    }
    if (detenido) break;

    // Se PLANIFICA una vez por vela, no en cada sub-tick. El motor real
    // reconcilia cada quince segundos, así que una vez por vela de 5m ya es más
    // frecuente que en vivo — y planificar cuatro veces multiplicaría por cuatro
    // el coste sin cambiar una sola orden.
    clock = bar.t + span - 1;
    if (quiere && velasEstrategia) {
      const fin = bar.t + span;
      while (
        velasCerradas < velasEstrategia.length &&
        velasEstrategia[velasCerradas].t + spanEstrategia <= fin
      ) {
        velasCerradas++;
      }
      velasVistas =
        velasCerradas >= quiere.bars
          ? velasEstrategia.slice(velasCerradas - quiere.bars, velasCerradas)
          : undefined;
    }
    avanzarSeries(bar.t + span);
    await planificar(D(bar.c));
    await drenar();
    await reaccionar(D(bar.c));

    equity.push({ ts: bar.t, ...(await snapshot()) });

    if (i % yieldEvery === 0 && opts.onProgress) await opts.onProgress(i, opts.candles.length);
  }

  async function planificar(precio: Decimal): Promise<void> {
    fillsPlanificados = fillsTotal;
    const ctx = await contexto(precio);
    // La ventana se cierra aquí y solo aquí, como en el tick del runner: el
    // contexto de una ejecución los lee sin vaciarlos (spec 042 R-6).
    extremos = null;
    const seq = cycleSeq();

    // Enfriamiento entre ciclos: el motor lo respeta y aquí también, con el
    // reloj de la simulación.
    if (cycle.cooldownUntil && clock < cycle.cooldownUntil) return;

    let desired = withStopLoss(strategy.plan(ctx), ctx.position, {
      botId: opts.botId,
      cycleSeq: seq,
      market,
      stopLossPct: config.stopLossPct,
    });

    if (desired.scratchPatch) {
      cycle = { ...cycle, scratch: { ...cycle.scratch, ...desired.scratchPatch } };
    }

    // Lo que el motor hace con el plan del canal antes de hablar con el venue
    // (`aplicarCanal`), sin intenciones que anotar: aquí no hay otra réplica.
    if (desired.pausar) {
      warnings.push(
        `La estrategia pausó el bot el ${new Date(clock).toISOString()} (${desired.pausar}): ` +
          'el replay se detiene ahí, como el motor.',
      );
      detenido = true;
      return;
    }
    anotarAvisos(desired.avisos);
    if (porOperacion && hayEntradas(desired)) {
      if (ctx.position && !D(ctx.position.qty).isZero()) {
        // Con posición, ni se entra ni se toca el apalancamiento.
        desired = sinEntradas(desired);
      } else if (desired.apalancamiento !== undefined) {
        await sim.setLeverage(market.symbol, desired.apalancamiento, params.marginMode as never);
      }
    }

    const plan = reconcile({
      botId: opts.botId,
      cycleSeq: seq,
      desired: desired.orders,
      actual: ctx.openOrders,
      market,
      encode,
      ownIds: new Set(emitted.keys()),
    });

    // `clientOrderId` de una orden viva puede venir nulo si el venue no lo
    // devuelve; en el simulador siempre viene, pero el tipo es el compartido.
    const vivos = (id: string | null): string[] => (id ? [id] : []);
    for (const o of plan.toCancel) {
      await sim.cancelOwn(market.symbol, vivos(o.clientOrderId)).catch(() => undefined);
    }
    for (const r of plan.toReplace) {
      await sim.cancelOwn(market.symbol, vivos(r.existing.clientOrderId)).catch(() => undefined);
      await colocar(r.desired, seq);
    }
    for (const o of plan.toPlace) await colocar(o, seq);
    for (const o of desired.immediate ?? []) await colocar(o, seq);

    // «Acción al alcanzar el límite: apagar». La estrategia no puede parar el
    // bot —es pura—, así que lo pide por el scratch. Va DESPUÉS de ejecutar para
    // que el cierre a mercado que ella misma encoló llegue a salir.
    if (desired.scratchPatch?.requestStop === 'STOP_KEEP_POSITION') detenido = true;
  }

  async function colocar(o: DesiredOrder, seq: number): Promise<void> {
    // La MISMA puerta que usa el motor real. Sin ella el replay colocaría
    // niveles por debajo del mínimo del venue que en producción se rechazan, y
    // el resultado saldría mejor de lo que sería.
    const veredicto = revisarOrden(market, o, true);
    // El stop de una operación apalancada no espera al mínimo del venue, como
    // en el motor (spec 058): solo una orden imposible se queda sin mandar.
    const stopExento =
      porOperacion && o.levelKind === 'STOP_LOSS' && veredicto.motivo !== 'IMPOSIBLE';
    if (veredicto.motivo !== 'OK' && !stopExento) {
      const nota = `Un nivel no se colocó (${veredicto.motivo}): ${veredicto.mensaje}`;
      if (!warnings.includes(nota)) warnings.push(nota);
      return;
    }
    const venueId = encode(o.clientOrderId);
    canonical.set(venueId, o.clientOrderId);
    emitted.set(venueId, seq);
    await sim
      .placeOrder({
        symbol: market.symbol,
        side: o.side,
        type: o.type,
        price: o.price,
        qty: o.qty,
        clientOrderId: o.clientOrderId,
        reduceOnly: o.reduceOnly === true,
        // Como en el motor: una entrada IOC no se queda en el libro, y la
        // caducidad viaja con la orden (spec 058).
        ...(o.timeInForce ? { timeInForce: o.timeInForce } : {}),
        ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
        // El disparador y su sentido viajan como en el motor real
        // (`bot-runner.ts`): sin ellos, el stop-loss —MARKET con
        // `triggerPrice`— llegaba al simulador como una orden a mercado sin
        // más y se ejecutaba en el acto (001/F-45). Era el segundo eslabón del
        // mismo fallo: el simulador no conocía las condicionales, y el replay
        // ni siquiera le decía que lo eran.
        ...(o.triggerPrice
          ? {
              triggerPrice: o.triggerPrice,
              // Y con la MISMA precedencia que el motor: lo que declare la
              // estrategia manda sobre lo que se deduce del nivel. Lo declara
              // el trailing take profit, que es un objetivo de beneficio en la
              // contabilidad y un stop en el disparo (spec 042 R-1).
              intent:
                o.intent ?? (o.levelKind === 'TAKE_PROFIT' ? ('TP' as const) : ('SL' as const)),
            }
          : {}),
      })
      .catch((e: unknown) => {
        // Antes era un `catch` vacío: un replay podía «funcionar» con órdenes
        // que el simulador rechazó una a una sin que el resultado lo dijera.
        rechazados.push(messageOf(e));
      });
  }

  async function snapshot(): Promise<{ equity: Decimal; position: Decimal }> {
    const [positions, balances] = await Promise.all([
      sim.getPositions(market.symbol),
      sim.getBalances(),
    ]);
    const pos = positions[0] as Position | undefined;
    // `getBalances().total` es saldo + realizado y NO incluye el no realizado:
    // hay que sumarlo aparte o la curva miente mientras hay posición abierta.
    const noRealizado = pos ? D(pos.unrealizedPnl) : D(0);
    return {
      equity: D(balances[0]?.total ?? '0').plus(noRealizado),
      position: pos ? D(pos.qty) : D(0),
    };
  }

  if (rechazados.length > 0) {
    const motivos = [...new Set(rechazados)].slice(0, 3).join(' · ');
    warnings.push(
      `${rechazados.length} orden(es) rechazada(s) por el simulador al colocarlas; motivos: ${motivos}.`,
    );
  }
  if (sinStop > 0) {
    warnings.push(
      `${sinStop} vez/veces una posición se quedó sin stop en el libro y se cerró a mercado, ` +
        'como hace el vigilante del motor.',
    );
  }
  if (avisosPorTipo.size > 0) {
    const lista = [...avisosPorTipo].map(([tipo, n]) => `${tipo} ×${n}`).join(', ');
    warnings.push(`Avisos de la estrategia durante el replay: ${lista}.`);
  }
  if (abierta) {
    warnings.push(
      'La última operación sigue abierta al final del rango: no cuenta en las cifras por setup.',
    );
  }

  sub.unsubscribe();
  const stats = sim.stats();
  const saldos = await sim.getBalances();

  return {
    fills,
    fillsTotal,
    fillCounts,
    equity,
    cycles,
    liquidations,
    ticks,
    finalBalance: D(saldos[0]?.total ?? params.startingBalance),
    realizedPnl: D(stats.realizedPnl),
    feesPaid: D(stats.feesPaid),
    grossMatched,
    operaciones,
    warnings:
      fillsTotal > MAX_FILLS_RETURNED
        ? [...warnings, `Se muestran ${MAX_FILLS_RETURNED} de ${fillsTotal} ejecuciones.`]
        : warnings,
  };
}
