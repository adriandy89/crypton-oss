import {
  D,
  Decimal,
  candleSpanMs,
  type BacktestParams,
  type Candle,
  type CandleInterval,
  type BacktestFillView,
  type BotConfig,
  type BotContext,
  type CycleState,
  type DesiredOrder,
  type Fill,
  type MarketSpec,
  type Position,
  type StrategyKind,
  type Venue,
} from '@crypton/shared';
import { DryRunAdapter, ReplaySourceAdapter, codecFor } from '@crypton/exchange-core';
import {
  cycleAfterFill,
  getStrategy,
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
 */

export interface ReplayOptions {
  botId: string;
  strategy: StrategyKind;
  config: BotConfig;
  venue: Venue;
  market: MarketSpec;
  interval: CandleInterval;
  candles: Candle[];
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
  warnings: string[];
}

/** Tope de ejecuciones que se devuelven. Un market maker produce decenas de miles. */
export const MAX_FILLS_RETURNED = 2000;

export async function runReplay(opts: ReplayOptions): Promise<ReplayOutput> {
  const { market, venue, params } = opts;
  const strategy = getStrategy(opts.strategy);
  const encode = codecFor(venue).encode;
  const span = candleSpanMs(opts.interval);

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
    scratch: { cycleSeq: 1, cooldownMinutes: Number(opts.config.cooldownMinutes ?? 0) },
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
  const warnings: string[] = [];
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

      const antes = cycleSeq();
      const r = cycleAfterFill(
        cycle,
        totals,
        fill,
        {
          recycleLevelOnExit: strategy.recycleLevelOnExit,
          cooldownMinutes: Number(opts.config.cooldownMinutes ?? 0),
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
      config: opts.config,
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
    };
  };

  const yieldEvery = opts.yieldEvery ?? 250;

  for (let i = 0; i < opts.candles.length && !detenido; i++) {
    const bar = opts.candles[i];

    for (const step of tickPath(bar, opts.interval, params.barPath)) {
      clock = step.ts;
      ticks += 1;
      source.setTicker(tickerAt(venue, market, step.price, step.role, step.ts, params.spreadBps));
      // Es `getTicker` y no el flujo quien dispara la casación: el simulador
      // comprueba liquidación y casa órdenes en reposo en cada precio que ve.
      await sim.getTicker(market.symbol);
      await drenar();
      if (detenido) break;
    }
    if (detenido) break;

    // Se PLANIFICA una vez por vela, no en cada sub-tick. El motor real
    // reconcilia cada quince segundos, así que una vez por vela de 5m ya es más
    // frecuente que en vivo — y planificar cuatro veces multiplicaría por cuatro
    // el coste sin cambiar una sola orden.
    clock = bar.t + span - 1;
    await planificar(D(bar.c));
    await drenar();

    equity.push({ ts: bar.t, ...(await snapshot()) });

    if (i % yieldEvery === 0 && opts.onProgress) await opts.onProgress(i, opts.candles.length);
  }

  async function planificar(precio: Decimal): Promise<void> {
    const ctx = await contexto(precio);
    const seq = cycleSeq();

    // Enfriamiento entre ciclos: el motor lo respeta y aquí también, con el
    // reloj de la simulación.
    if (cycle.cooldownUntil && clock < cycle.cooldownUntil) return;

    const desired = withStopLoss(strategy.plan(ctx), ctx.position, {
      botId: opts.botId,
      cycleSeq: seq,
      market,
      stopLossPct: opts.config.stopLossPct,
    });

    if (desired.scratchPatch) {
      cycle = { ...cycle, scratch: { ...cycle.scratch, ...desired.scratchPatch } };
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
    if (veredicto.motivo !== 'OK') {
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
        // El disparador y su sentido viajan como en el motor real
        // (`bot-runner.ts`): sin ellos, el stop-loss —MARKET con
        // `triggerPrice`— llegaba al simulador como una orden a mercado sin
        // más y se ejecutaba en el acto (001/F-45). Era el segundo eslabón del
        // mismo fallo: el simulador no conocía las condicionales, y el replay
        // ni siquiera le decía que lo eran.
        ...(o.triggerPrice
          ? {
              triggerPrice: o.triggerPrice,
              intent: o.levelKind === 'TAKE_PROFIT' ? ('TP' as const) : ('SL' as const),
            }
          : {}),
      })
      .catch(() => undefined);
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
    warnings:
      fillsTotal > MAX_FILLS_RETURNED
        ? [...warnings, `Se muestran ${MAX_FILLS_RETURNED} de ${fillsTotal} ejecuciones.`]
        : warnings,
  };
}
