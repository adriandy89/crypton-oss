import type { Direction, PositionSide } from './enums';
import { D, Decimal, type Numeric } from './money';

/**
 * Los % de RESULTADO, sobre el margen (spec 080).
 *
 * El stop loss, el take profit de las escaleras, el objetivo del seguimiento y
 * el TP satélite de GridMart son lo que el usuario gana o pierde, y se miden
 * sobre el MARGEN, como el TP/SL por ROI de un exchange apalancado. Es la
 * fórmula de Binance, citada en el spec 079:
 *
 *   «Long target price = Entry Price * ( ROI% / Leverage + 1 )»
 *   «Short target price = Entry Price * ( 1 - ROI% / Leverage )»
 *
 * Hasta el 080 eran % del PRECIO: a 15× un «objetivo del 15 %» era un +225 %
 * del margen y un «stop del 5 %», un −75 %, sin que ninguna pantalla lo dijera
 * (079/F-04). Las DISTANCIAS —separación entre órdenes, retroceso del trailing,
 * descuento de recompra, bps del market maker— siguen sobre el precio, como en
 * Binance, donde el «callback rate» del trailing también lo es.
 *
 * Esta es la ÚNICA traducción entre los dos: si un sitio convierte por su
 * cuenta, acaba haciéndolo distinto.
 */

/**
 * Un apalancamiento ausente o no positivo se trata como 1×. Una configuración
 * así no pasa `validate()`; esto solo evita dividir por cero en quien la lee
 * antes de validarla.
 */
function apal(apalancamiento: Numeric | null | undefined): Decimal {
  const l = D(apalancamiento ?? 1);
  return l.isFinite() && l.gt(0) ? l : D(1);
}

/** El lado de una dirección configurada: NEUTRAL se trata como largo. */
export function ladoDeDireccion(direction: Direction | PositionSide): PositionSide {
  return direction === 'SHORT' ? 'SHORT' : 'LONG';
}

/** Movimiento del precio, en %, que corresponde a un % sobre el margen: `ROI / L`. */
export function pctPrecioDeRoi(roiPct: Numeric, apalancamiento: Numeric): Decimal {
  return D(roiPct).div(apal(apalancamiento));
}

/** % sobre el margen que corresponde a un movimiento del precio en %: `pct × L`. */
export function roiDePctPrecio(pctPrecio: Numeric, apalancamiento: Numeric): Decimal {
  return D(pctPrecio).mul(apal(apalancamiento));
}

/**
 * Precio al que una posición gana (`roiPct` > 0) o pierde (`roiPct` < 0) ese %
 * de su margen, sin comisiones:
 *
 * - LARGO: `E × (1 + ROI/(100·L))`
 * - CORTO: `E × (1 − ROI/(100·L))`
 *
 * El margen es el de la posición entera, `nocional/L`, así que vale igual para
 * una sola entrada que para una escalera medida sobre su precio medio.
 */
export function precioDeRoi(
  entrada: Numeric,
  roiPct: Numeric,
  apalancamiento: Numeric,
  lado: Direction | PositionSide,
): Decimal {
  const movimiento = pctPrecioDeRoi(roiPct, apalancamiento).div(100);
  const signo = ladoDeDireccion(lado) === 'SHORT' ? D(-1) : D(1);
  return D(entrada).mul(D(1).plus(signo.mul(movimiento)));
}

/**
 * Una salida por % del margen sobre una posición abierta: su precio y su
 * resultado en la moneda de cotización, sin comisiones. Es lo que el formulario
 * enseña junto a cada % de un bot en marcha para leerlo en precio y en dinero,
 * como el TP/SL por ROI de un exchange. `roiPct` negativo para un stop.
 */
export function salidaPorRoi(
  entrada: Numeric,
  cantidad: Numeric,
  roiPct: Numeric,
  apalancamiento: Numeric,
  lado: Direction | PositionSide,
): { precio: Decimal; pnl: Decimal } {
  const precio = precioDeRoi(entrada, roiPct, apalancamiento, lado);
  const signo = ladoDeDireccion(lado) === 'SHORT' ? D(-1) : D(1);
  return { precio, pnl: D(cantidad).abs().mul(precio.minus(entrada)).mul(signo) };
}

/**
 * % sobre el margen de cerrar a `precio`: `(P − E)/E × L × 100`, con el signo
 * del lado (positivo = beneficio). Sin comisiones.
 */
export function roiDePrecio(
  entrada: Numeric,
  precio: Numeric,
  apalancamiento: Numeric,
  lado: Direction | PositionSide,
): Decimal {
  const e = D(entrada);
  if (!e.gt(0)) return D(0);
  const signo = ladoDeDireccion(lado) === 'SHORT' ? D(-1) : D(1);
  return D(precio).minus(e).div(e).mul(signo).mul(apal(apalancamiento)).mul(100);
}
