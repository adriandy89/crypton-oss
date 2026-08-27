import {
  D,
  Decimal,
  type BacktestEquityPoint,
  type BacktestMetrics,
  type Candle,
} from '@crypton/shared';
import type { ReplayOutput, ReplayState } from './engine';

/**
 * Las cifras del resultado. Todo puro: entra la serie y salen los números.
 */

/** Puntos que se devuelven de la curva. Más no se ve en una pantalla. */
export const CURVE_POINTS = 1000;

export function buildMetrics(
  out: ReplayOutput,
  candles: Candle[],
  startingBalance: string,
  opts: { barsMissing: number; largestGapMs: number; spanMs: number },
): { metrics: BacktestMetrics; equity: BacktestEquityPoint[] } {
  const inicial = D(startingBalance);

  // El drawdown se mide sobre la serie COMPLETA, ANTES de remuestrear. Al revés,
  // el remuestreo escondería justo el peor momento — que es el número que más
  // importa de todo el informe.
  const dd = drawdownOf(out.equity);
  const curva = downsampleExtrema(out.equity, CURVE_POINTS, dd.peakByTs);

  const finalEquity = out.equity.length ? out.equity[out.equity.length - 1].equity : inicial;
  const netPnl = finalEquity.minus(inicial);

  const cerrados = out.cycles.filter((c) => c.closedAt !== null);
  const ganadores = cerrados.filter((c) => D(c.realizedPnl).gt(0)).length;
  const duraciones = cerrados.map((c) => (c.closedAt ?? 0) - c.openedAt).filter((d) => d > 0);

  const enMercado = out.equity.filter((p) => !p.position.isZero()).length;
  const picoQty = out.equity.reduce((m, p) => Decimal.max(m, p.position.abs()), D(0));

  const buyHold =
    candles.length >= 2
      ? D(candles[candles.length - 1].c)
          .minus(candles[0].c)
          .div(candles[0].c)
          .mul(100)
      : D(0);

  const noRealizado = finalEquity.minus(inicial).minus(out.realizedPnl);

  return {
    equity: curva,
    metrics: {
      startingBalance: inicial.toFixed(),
      endingEquity: finalEquity.toFixed(),
      netPnl: netPnl.toFixed(),
      netPnlPct: pct(netPnl, inicial),
      realizedPnl: out.realizedPnl.toFixed(),
      unrealizedPnlAtEnd: noRealizado.toFixed(),
      feesPaid: out.feesPaid.toFixed(),

      maxDrawdown: dd.maxAbs.toFixed(),
      maxDrawdownPct: dd.maxPct.toFixed(4),
      maxDrawdownAt: dd.atTs,
      peakEquity: dd.peak.toFixed(),
      peakEquityAt: dd.peakTs,

      cyclesClosed: cerrados.length,
      cyclesOpenAtEnd: out.cycles.length - cerrados.length,
      winRatePct: cerrados.length ? D(ganadores).div(cerrados.length).mul(100).toFixed(2) : null,
      avgCycleMs: duraciones.length
        ? Math.round(duraciones.reduce((a, b) => a + b, 0) / duraciones.length)
        : null,

      // Del TOTAL, no de `out.fills`: esa lista está acotada a 2000, así que
      // contar sobre ella devolvería exactamente 2000 para cualquier market
      // maker — un número redondo y falso justo donde se mira si operó mucho.
      fills: out.fillsTotal,
      buyFills: out.fillCounts.buy,
      sellFills: out.fillCounts.sell,
      makerFills: out.fillCounts.maker,
      takerFills: out.fillCounts.taker,
      grossMatchedProfit: out.grossMatched.toFixed(),
      liquidations: out.liquidations,

      peakPositionQty: picoQty.toFixed(),
      peakNotional: picoQty.mul(candles.length ? D(candles[candles.length - 1].c) : D(0)).toFixed(),
      timeInMarketPct: out.equity.length
        ? D(enMercado).div(out.equity.length).mul(100).toFixed(2)
        : '0',

      buyAndHoldPct: buyHold.toFixed(4),

      bars: candles.length,
      ticks: out.ticks,
      barsMissing: opts.barsMissing,
      largestGapMs: opts.largestGapMs,
    },
  };
}

/** Máximo pico a valle sobre la serie entera. */
function drawdownOf(serie: ReplayState[]): {
  maxAbs: Decimal;
  maxPct: Decimal;
  atTs: number | null;
  peak: Decimal;
  peakTs: number | null;
  peakByTs: Map<number, Decimal>;
} {
  let peak = serie.length ? serie[0].equity : D(0);
  let peakTs: number | null = serie.length ? serie[0].ts : null;
  let maxAbs = D(0);
  let maxPct = D(0);
  let atTs: number | null = null;
  const peakByTs = new Map<number, Decimal>();

  for (const p of serie) {
    if (p.equity.gt(peak)) {
      peak = p.equity;
      peakTs = p.ts;
    }
    peakByTs.set(p.ts, peak);
    const caida = peak.minus(p.equity);
    if (caida.gt(maxAbs)) {
      maxAbs = caida;
      atTs = p.ts;
      maxPct = peak.gt(0) ? caida.div(peak).mul(100) : D(0);
    }
  }

  return { maxAbs, maxPct, atTs, peak, peakTs, peakByTs };
}

/**
 * Reduce la curva conservando los EXTREMOS de cada cubo.
 *
 * Un `slice` cada N puntos borraría el pico del drawdown, y entonces el gráfico
 * mentiría justo sobre la cifra que se está mirando. De cada cubo se conservan
 * el primero, el mínimo, el máximo y el último, en orden temporal.
 */
function downsampleExtrema(
  serie: ReplayState[],
  max: number,
  peakByTs: Map<number, Decimal>,
): BacktestEquityPoint[] {
  const punto = (p: ReplayState): BacktestEquityPoint => {
    const peak = peakByTs.get(p.ts) ?? p.equity;
    return {
      t: p.ts,
      equity: p.equity.toFixed(),
      position: p.position.toFixed(),
      ddPct: peak.gt(0) ? p.equity.minus(peak).div(peak).mul(100).toFixed(4) : '0',
    };
  };

  if (serie.length <= max) return serie.map(punto);

  const cubo = Math.ceil(serie.length / (max / 4));
  const out: BacktestEquityPoint[] = [];
  for (let i = 0; i < serie.length; i += cubo) {
    const tramo = serie.slice(i, i + cubo);
    let min = tramo[0];
    let maxP = tramo[0];
    for (const p of tramo) {
      if (p.equity.lt(min.equity)) min = p;
      if (p.equity.gt(maxP.equity)) maxP = p;
    }
    const elegidos = [tramo[0], min, maxP, tramo[tramo.length - 1]]
      .filter((p, idx, arr) => arr.findIndex((q) => q.ts === p.ts) === idx)
      .sort((a, b) => a.ts - b.ts);
    out.push(...elegidos.map(punto));
  }
  return out;
}

/**
 * Agrega las velas para el gráfico. Agregar y NO muestrear.
 *
 * Una vela muestreada pierde las mechas, y las mechas son exactamente lo que
 * ejecutó las órdenes.
 */
export function aggregateCandles(candles: Candle[], max: number): Candle[] {
  if (candles.length <= max) return candles;
  const cubo = Math.ceil(candles.length / max);
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += cubo) {
    const tramo = candles.slice(i, i + cubo);
    out.push({
      t: tramo[0].t,
      o: tramo[0].o,
      h: tramo.reduce((m, c) => (D(c.h).gt(m) ? D(c.h) : m), D(tramo[0].h)).toFixed(),
      l: tramo.reduce((m, c) => (D(c.l).lt(m) ? D(c.l) : m), D(tramo[0].l)).toFixed(),
      c: tramo[tramo.length - 1].c,
      v: tramo.every((c) => c.v === null)
        ? null
        : tramo.reduce((s, c) => s.plus(c.v ?? 0), D(0)).toFixed(),
    });
  }
  return out;
}

const pct = (n: Decimal, base: Decimal): string =>
  base.gt(0) ? n.div(base).mul(100).toFixed(4) : '0';
