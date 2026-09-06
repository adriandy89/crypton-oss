import { D, type Numeric } from './money';

/**
 * La aritmética del capital de un bot (spec 025).
 *
 * Vive aquí y no en la app por el mismo motivo que `series.ts`: la app no suma
 * dinero, lo pide a `shared` con test. Y vive aparte de `series.ts` porque no
 * es analítica de una serie sino la foto de ahora: cuánto hay, cuánto se puso,
 * qué hay en juego.
 *
 * Vocabulario, para no chocar con el de la cartera (spec 002, R-7): «capital
 * actual» es PATRIMONIO (asignado + realizado + abierto); «resultado» sigue
 * siendo realizado + abierto, que es lo que guarda `bot_snapshots.equity`.
 */

/** Capital actual: lo asignado más lo realizado más lo abierto, exacto. */
export function capitalActual(asignado: Numeric, realizado: Numeric, abierto: Numeric): string {
  return D(asignado).plus(realizado).plus(abierto).toFixed();
}

/**
 * Valor de la posición a precio de marca: |cantidad| × marca. Sin posición es
 * cero; sin precio (o con precio cero) no se inventa y devuelve null.
 */
export function valorDePosicion(qty: Numeric, mark: Numeric | null | undefined): string | null {
  const cantidad = D(qty).abs();
  if (cantidad.isZero()) return '0';
  if (mark === null || mark === undefined || mark === '') return null;
  const precio = D(mark);
  if (!precio.isFinite() || precio.lte(0)) return null;
  return cantidad.mul(precio).toFixed();
}

/**
 * PnL abierto sobre el margen que sostiene la posición, en % con dos decimales:
 * el «ROE» que los exchanges ponen junto a la posición. Sin margen no hay
 * porcentaje.
 */
export function retornoSobreMargen(
  abierto: Numeric,
  margenUsado: Numeric | null | undefined,
): string | null {
  if (margenUsado === null || margenUsado === undefined || margenUsado === '') return null;
  const margen = D(margenUsado);
  if (!margen.isFinite() || margen.lte(0)) return null;
  return D(abierto).div(margen).mul(100).toFixed(2);
}
