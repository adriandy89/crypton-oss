import { D, Decimal, type Numeric } from './money';
import type { MarketSpec } from './market';

/**
 * Redondeo a la retícula del venue.
 *
 * Esto NO es cosmético: si un precio no es múltiplo exacto de `tickSize` o una
 * cantidad no lo es de `stepSize`, el DEX rechaza la orden. Todo precio y toda
 * cantidad pasa por aquí ANTES de salir por el adaptador — es la única puerta.
 */

/** Redondea al múltiplo de `tick` más cercano (para precios de referencia). */
export const roundToTick = (price: Numeric, tick: Numeric): Decimal =>
  D(price).div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(tick);

/**
 * Redondea el precio en la dirección CONSERVADORA para el lado dado: una compra
 * baja (paga menos y no cruza el libro sin querer), una venta sube.
 */
export const roundPriceForSide = (price: Numeric, tick: Numeric, side: 'BUY' | 'SELL'): Decimal => {
  const mode = side === 'BUY' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP;
  return D(price).div(tick).toDecimalPlaces(0, mode).mul(tick);
};

/**
 * Cantidad SIEMPRE hacia abajo: redondear hacia arriba puede pedir más margen
 * del disponible y hacer que el venue rechace el último nivel de la escalera.
 */
export const floorToStep = (qty: Numeric, step: Numeric): Decimal =>
  D(qty).div(step).toDecimalPlaces(0, Decimal.ROUND_DOWN).mul(step);

export interface PrecisionResult {
  price: Decimal;
  qty: Decimal;
  /** Motivos por los que el venue rechazaría la orden. Vacío = válida. */
  violations: string[];
}

/**
 * Normaliza (precio, cantidad) contra la spec del mercado y explica por qué la
 * orden sería inválida, en vez de dejar que falle en el venue con un código
 * opaco. `previewLevels()` usa exactamente esto para pintar los ⚠ del wizard.
 */
export function normalizeOrder(
  market: MarketSpec,
  rawPrice: Numeric,
  rawQty: Numeric,
  side: 'BUY' | 'SELL',
): PrecisionResult {
  const violations: string[] = [];
  const price = roundPriceForSide(rawPrice, market.tickSize, side);
  const qty = floorToStep(rawQty, market.stepSize);

  if (price.lte(0)) violations.push('El precio redondeado es cero o negativo.');
  if (qty.lte(0)) {
    violations.push(
      `La cantidad queda en 0 al redondear al step de ${market.stepSize} (${market.symbol}).`,
    );
  }

  const notional = price.mul(qty);
  if (market.minNotional && notional.lt(market.minNotional)) {
    violations.push(
      `Notional ${notional.toFixed(2)} por debajo del mínimo del venue (${market.minNotional}).`,
    );
  }
  if (market.minQty && qty.lt(market.minQty)) {
    violations.push(`Cantidad ${qty.toFixed()} por debajo de la mínima (${market.minQty}).`);
  }
  if (market.maxQty && qty.gt(market.maxQty)) {
    violations.push(`Cantidad ${qty.toFixed()} por encima de la máxima (${market.maxQty}).`);
  }

  return { price, qty, violations };
}
