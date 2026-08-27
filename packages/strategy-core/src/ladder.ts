import { D, Decimal, type Numeric } from '@crypton/shared';
import type { Direction } from '@crypton/shared';

/**
 * Matemática de escaleras compartida por las estrategias. Todo aquí es
 * aritmética exacta con Decimal: una martingala de 20 niveles encadena 20
 * multiplicaciones y con floats el último nivel se desvía lo suficiente como
 * para caer por debajo del notional mínimo del venue sin que se vea venir.
 */

/** Precios equiespaciados en importe: lower, ..., upper (ambos incluidos). */
export function arithmeticPrices(lower: Numeric, upper: Numeric, levels: number): Decimal[] {
  if (levels < 2) return [D(lower)];
  const lo = D(lower);
  const step = D(upper)
    .minus(lo)
    .div(levels - 1);
  return Array.from({ length: levels }, (_, i) => lo.plus(step.mul(i)));
}

/** Precios equiespaciados en porcentaje: cada salto es la misma razón. */
export function geometricPrices(lower: Numeric, upper: Numeric, levels: number): Decimal[] {
  if (levels < 2) return [D(lower)];
  const lo = D(lower);
  // ratio = (upper/lower)^(1/(levels-1)), vía exponencial para no perder precisión.
  const ratio = D(upper)
    .div(lo)
    .pow(D(1).div(levels - 1));
  return Array.from({ length: levels }, (_, i) => lo.mul(ratio.pow(i)));
}

/** Pesos geométricos [1, s, s², ...] usados para repartir el capital. */
export function geometricWeights(count: number, scale: Numeric): Decimal[] {
  const s = D(scale);
  const out: Decimal[] = [];
  let w = D(1);
  for (let i = 0; i < count; i++) {
    out.push(w);
    w = w.mul(s);
  }
  return out;
}

export interface ScaledLevel {
  index: number;
  price: Decimal;
  /** Margen asignado a este nivel. */
  margin: Decimal;
  /** margin × apalancamiento. */
  notional: Decimal;
  qty: Decimal;
  /** Distancia acumulada en % desde el ancla. */
  distancePct: Decimal;
}

export interface ScaledLadderParams {
  /** Precio del que cuelga toda la escalera (el de la entrada base). */
  anchor: Numeric;
  /** Nº de órdenes de seguridad POR DEBAJO de la base (la base no cuenta). */
  safetyCount: number;
  initialSeparationPct: Numeric;
  /** Cada hueco es este múltiplo del anterior. 1.0 = separación constante. */
  stepScale: Numeric;
  /** Cada nivel pide este múltiplo de capital respecto del anterior. */
  volumeScale: Numeric;
  /** Margen total del bot, repartido entre base y seguridades. */
  totalMargin: Numeric;
  leverage: number;
  direction: Direction;
}

/**
 * Escalera martingala: base (índice 0) + N seguridades que se alejan y crecen.
 *
 * El reparto de capital es proporcional a los pesos, NO "amount por orden": así
 * `totalMargin` es un techo real y el usuario no puede quedarse a medias de la
 * escalera por haberse gastado el margen en los primeros niveles.
 */
export function scaledLadder(p: ScaledLadderParams): ScaledLevel[] {
  const anchor = D(p.anchor);
  const total = D(p.totalMargin);
  const lev = D(p.leverage);
  const count = p.safetyCount + 1; // + la entrada base
  const weights = geometricWeights(count, p.volumeScale);
  const weightSum = weights.reduce((a, b) => a.plus(b), D(0));
  // SHORT compra caro y promedia hacia arriba: los niveles van por encima.
  const sign = p.direction === 'SHORT' ? D(1) : D(-1);

  const levels: ScaledLevel[] = [];
  let gap = D(p.initialSeparationPct);
  let cumulativeDistance = D(0);

  for (let i = 0; i < count; i++) {
    if (i > 0) {
      cumulativeDistance = cumulativeDistance.plus(gap);
      gap = gap.mul(p.stepScale);
    }
    const price = anchor.mul(D(1).plus(sign.mul(cumulativeDistance).div(100)));
    const margin = total.mul(weights[i]).div(weightSum);
    const notional = margin.mul(lev);
    levels.push({
      index: i,
      price,
      margin,
      notional,
      qty: price.gt(0) ? notional.div(price) : D(0),
      distancePct: cumulativeDistance,
    });
  }
  return levels;
}

/** Precio medio ponderado por cantidad. null si no hay cantidad. */
export function weightedAverage(items: { price: Numeric; qty: Numeric }[]): Decimal | null {
  let num = D(0);
  let den = D(0);
  for (const it of items) {
    num = num.plus(D(it.price).mul(it.qty));
    den = den.plus(it.qty);
  }
  return den.gt(0) ? num.div(den) : null;
}

/**
 * Precio de take profit sobre el precio medio de entrada.
 * LONG sale por encima; SHORT, por debajo.
 */
export function takeProfitPrice(
  averageEntry: Numeric,
  takeProfitPct: Numeric,
  direction: Direction,
): Decimal {
  const sign = direction === 'SHORT' ? D(-1) : D(1);
  return D(averageEntry).mul(D(1).plus(sign.mul(takeProfitPct).div(100)));
}

/** Stop loss sobre el precio medio: espejo exacto del take profit. */
export function stopLossPrice(
  averageEntry: Numeric,
  stopLossPct: Numeric,
  direction: Direction,
): Decimal {
  const sign = direction === 'SHORT' ? D(1) : D(-1);
  return D(averageEntry).mul(D(1).plus(sign.mul(stopLossPct).div(100)));
}
