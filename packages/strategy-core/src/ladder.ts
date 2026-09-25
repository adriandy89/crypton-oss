import {
  D,
  Decimal,
  precioDeRoi,
  precioLiquidacion,
  type Direction,
  type Numeric,
  type PositionSide,
} from '@crypton/shared';

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

/** Un nivel de entrada, tal y como lo recorre `recorridoPeorCaso`. */
export interface PasoDeEntrada {
  price: Numeric;
  qty: Numeric;
}

export interface RecorridoPeorCaso {
  /** Cuántos niveles se llegan a llenar, empezando por el primero. */
  llenos: number;
  /** Precio medio de lo lleno; null si no se llena ninguno. */
  media: Decimal | null;
  qty: Decimal;
  /**
   * El primer nivel que NO se llena y por qué: con la media de lo ya lleno, el
   * stop o la liquidación llegan antes que él, o el tope de exposición no deja
   * tenderlo. null = se llena entera.
   */
  corte: { nivel: number; por: 'STOP' | 'LIQUIDACION' | 'TOPE' } | null;
}

/**
 * El tope de exposición que aplica el plan, en nocional (USDC).
 *
 * `desde` es el primer nivel al que se aplica: una escalera abre su base sin
 * mirarlo y solo tiende las seguridades que caben (martingala y GridMart).
 */
export interface TopeDelRecorrido {
  nocional: Numeric;
  desde?: number;
}

/**
 * La escalera llenándose en contra, nivel a nivel (spec 080).
 *
 * Los niveles llegan en el orden en que el precio los tocaría yendo en contra
 * de la posición. En cada uno se mira, con la media de lo ya lleno, si el stop
 * (un % del margen) o la liquidación EXACTA llegan antes que él; si llegan, la
 * escalera se corta ahí y el resto no se ejecuta nunca. Entre los dos manda el
 * que el precio toca primero.
 *
 * Antes se comparaba la cobertura total desde el ancla con `100/L`: ni contaba
 * el mantenimiento ni que la liquidación se mueve con la media, y el stop no
 * entraba en la cuenta (079/F-01 y F-07).
 *
 * Con `tope`, además, un nivel solo entra si la posición que deja, valorada a
 * SU precio, cabe en él. Es la cota de lo que tiende el plan: tiende un nivel si
 * lo abierto, valorado al precio de ahora, más el nocional del nivel caben; y
 * lo más tarde que puede tenderlo es justo antes de que el precio lo toque.
 * Sumar los nocionales a precio de compra se quedaba corto: al llegar a un
 * nivel, lo comprado más arriba ya vale menos. La Revisión enseñaba la
 * escalera entera aunque el bot se fuera a parar en el tope (encontrado al
 * rehacer las guías del 080).
 */
export function recorridoPeorCaso(
  niveles: readonly PasoDeEntrada[],
  lado: PositionSide,
  apalancamiento: number,
  mantenimiento: number,
  stopRoiPct?: Numeric | null,
  tope?: TopeDelRecorrido | null,
): RecorridoPeorCaso {
  const largo = lado === 'LONG';
  const conStop = stopRoiPct != null && stopRoiPct !== '' && D(stopRoiPct).gt(0);
  const topeNocional = tope && D(tope.nocional).gt(0) ? D(tope.nocional) : null;
  const topeDesde = tope?.desde ?? 0;
  let num = D(0);
  let qty = D(0);
  for (let k = 0; k < niveles.length; k++) {
    const precio = D(niveles[k].price);
    // El tope primero: un nivel que el plan no tiende no existe, y decir que la
    // liquidación llega antes que él sería rechazar una escalera que el propio
    // tope ya acorta. Lo que pase por debajo de la última es lo de siempre: la
    // escalera se agota y la posición queda a merced del stop o la liquidación.
    if (topeNocional && k >= topeDesde && qty.plus(niveles[k].qty).mul(precio).gt(topeNocional)) {
      return {
        llenos: k,
        media: qty.gt(0) ? num.div(qty) : null,
        qty,
        corte: { nivel: k, por: 'TOPE' },
      };
    }
    if (qty.gt(0)) {
      const media = num.div(qty);
      // Lo que el precio encontraría antes de llegar al nivel: en un largo,
      // todo lo que esté por encima de él; en un corto, por debajo.
      const antes = (p: Decimal | null): p is Decimal =>
        p != null && (largo ? p.gte(precio) : p.lte(precio));
      const liq = precioLiquidacion(media, apalancamiento, mantenimiento, lado);
      const stop = conStop ? precioDeRoi(media, D(stopRoiPct).neg(), apalancamiento, lado) : null;
      const candidatos: { p: Decimal; por: 'STOP' | 'LIQUIDACION' }[] = [];
      if (antes(stop)) candidatos.push({ p: stop, por: 'STOP' });
      if (antes(liq)) candidatos.push({ p: liq, por: 'LIQUIDACION' });
      if (candidatos.length > 0) {
        // El primero que el precio toca: el más cercano a la media.
        const primero = candidatos.reduce((a, b) =>
          largo ? (b.p.gt(a.p) ? b : a) : b.p.lt(a.p) ? b : a,
        );
        return { llenos: k, media, qty, corte: { nivel: k, por: primero.por } };
      }
    }
    num = num.plus(precio.mul(niveles[k].qty));
    qty = qty.plus(niveles[k].qty);
  }
  return {
    llenos: niveles.length,
    media: qty.gt(0) ? num.div(qty) : null,
    qty,
    corte: null,
  };
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
 * Precio del take profit: el que gana `roiPct` % del MARGEN desde el precio
 * medio de entrada (spec 080). LONG sale por encima; SHORT, por debajo.
 *
 * El apalancamiento va en la firma a propósito: sin él, el mismo número sería
 * un % del precio, que es lo que era hasta el 080 y lo que dejaba a 15× un
 * «objetivo del 15 %» en un +225 % del margen (079/F-04).
 */
export function takeProfitPrice(
  averageEntry: Numeric,
  roiPct: Numeric,
  apalancamiento: Numeric,
  direction: Direction,
): Decimal {
  return precioDeRoi(averageEntry, roiPct, apalancamiento, direction);
}

/**
 * Cuánto vive una entrada base LIMIT antes de volver a fijarse al precio actual.
 *
 * Martingala la recalculaba al mark en cada revisión: el motor la cancelaba y
 * recolocaba con cada tick y, siempre pegada al precio, nadie la cruzaba nunca.
 * GridMart la mandaba una sola vez y sin caducidad: si el precio se iba, el
 * ciclo no abría jamás (001/F-92). Una sola conducta para las dos: post-only al
 * precio del momento de emitirla, sin persecución, y si en este plazo no se ha
 * ejecutado se vuelve a fijar al precio de entonces.
 */
export const BASE_LIMIT_TTL_MS = 5 * 60_000;

/** Lo que se memoriza en el scratch del ciclo bajo `baseLimit`. */
export interface BaseLimitMemo {
  price: string;
  at: number;
}

/**
 * Precio de la base LIMIT para esta revisión: el memorizado si sigue vigente;
 * si no, `current`, junto con el parche de scratch que lo fija para las
 * revisiones siguientes.
 */
export function baseLimitPrice(
  scratch: Record<string, unknown>,
  now: number,
  current: string,
): { price: string; patch?: Record<string, unknown> } {
  const memo = scratch['baseLimit'] as Partial<BaseLimitMemo> | undefined;
  if (
    memo &&
    typeof memo.price === 'string' &&
    typeof memo.at === 'number' &&
    now - memo.at < BASE_LIMIT_TTL_MS
  ) {
    return { price: memo.price };
  }
  const fresh: BaseLimitMemo = { price: current, at: now };
  return { price: current, patch: { baseLimit: fresh } };
}

/**
 * Precio del stop loss: el que pierde `roiPct` % del MARGEN desde el precio
 * medio (spec 080). Espejo exacto del take profit.
 */
export function stopLossPrice(
  averageEntry: Numeric,
  roiPct: Numeric,
  apalancamiento: Numeric,
  direction: Direction,
): Decimal {
  return precioDeRoi(averageEntry, D(roiPct).neg(), apalancamiento, direction);
}
