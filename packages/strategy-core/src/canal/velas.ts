/**
 * Velas para el motor del canal (spec 058): qué vela debería estar ya cerrada y
 * si una serie llega al día.
 *
 * La agregación a un intervalo mayor vive en `shared` (`agregarVelas`, spec 057)
 * porque la usa también el backtest; se reexporta aquí para que el canal tenga
 * todo lo de velas en un sitio.
 */
import { agregarVelas, candleSpanMs, type Candle, type CandleInterval } from '@crypton/shared';

export { agregarVelas };

/**
 * Apertura de la última vela que ya debería estar cerrada a `ahora`, contando
 * `gracia` de margen para que el venue la publique.
 */
export function ultimaCerradaEsperada(
  ahora: number,
  intervalo: CandleInterval,
  gracia = 0,
): number {
  const span = candleSpanMs(intervalo);
  return Math.floor((ahora - gracia) / span) * span - span;
}

/**
 * ¿Trae la serie su última vela esperada?
 *
 * Con `gracia` se tolera que la vela que acaba de cerrar aún no haya llegado:
 * es lo normal en los segundos que siguen al cierre, y el motor la pide sola
 * (spec 057, F-03). Pasada la gracia, una serie sin su vela no es fresca, y el
 * canal no abre nada con ella.
 */
export function serieFresca(
  velas: readonly Candle[] | undefined,
  intervalo: CandleInterval,
  ahora: number,
  gracia: number,
): boolean {
  if (!velas || velas.length === 0) return false;
  return velas[velas.length - 1].t >= ultimaCerradaEsperada(ahora, intervalo, gracia);
}
