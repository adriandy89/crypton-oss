/**
 * Indicadores sobre velas, puros y en `Decimal`.
 *
 * Existen porque la estrategia de tendencia es la primera que decide mirando un
 * gráfico y no el libro (spec 040). Se quedan aquí, en `strategy-core`, y no en
 * `shared`, porque son entrada de una estrategia y no un dato que la app tenga
 * que pintar: `MarketFeatures` es lo que se pinta, y lo calcula la API.
 */
import { D, Decimal, type Candle } from '@crypton/shared';

/**
 * Rango verdadero de una vela: lo que de verdad se movió el precio.
 *
 * `max − min` de la vela se queda corto cuando ha habido un hueco, que es justo
 * cuando más importa: un mercado que abre un 5 % por debajo del cierre anterior
 * se ha movido ese 5 %, aunque su vela sea estrecha. De ahí los otros dos
 * términos.
 *
 * Sin cierre previo —la primera vela de la serie— es `max − min`: no hay hueco
 * que medir.
 */
export function rangoVerdadero(vela: Candle, cierreAnterior: Decimal | null): Decimal {
  const alto = D(vela.h);
  const bajo = D(vela.l);
  const rango = alto.minus(bajo);
  if (!cierreAnterior) return rango;
  return Decimal.max(rango, alto.minus(cierreAnterior).abs(), bajo.minus(cierreAnterior).abs());
}

/**
 * ATR: media del rango verdadero de las últimas `periodo` velas.
 *
 * Media aritmética y no la suavización de Wilder a propósito. Las dos son
 * defendibles y dan números parecidos; esta se puede comprobar a mano en un
 * test, y un indicador del que depende el TAMAÑO de una posición tiene que
 * poder comprobarse a mano.
 *
 * `null` con menos velas de las pedidas: no se devuelve un ATR calculado sobre
 * tres velas cuando se pidieron catorce, porque ese número tiene toda la pinta
 * de ser válido y no lo es.
 */
export function atr(velas: readonly Candle[], periodo: number): Decimal | null {
  const n = Math.floor(periodo);
  if (n < 1 || velas.length < n + 1) return null;

  const tramo = velas.slice(-(n + 1));
  let suma = D(0);
  for (let i = 1; i < tramo.length; i++) {
    suma = suma.plus(rangoVerdadero(tramo[i], D(tramo[i - 1].c)));
  }
  return suma.div(n);
}

export interface Donchian {
  /** Máximo de las velas ANTERIORES a la última. */
  alto: Decimal;
  /** Mínimo de las velas anteriores a la última. */
  bajo: Decimal;
  /** El cierre de la última vela, que es el que rompe o no. */
  cierre: Decimal;
}

/**
 * Canal de Donchian sobre las `periodo` velas ANTERIORES a la última.
 *
 * La exclusión no es un detalle: si la vela que rompe entra en su propio rango,
 * su máximo ES el máximo y nunca lo supera. El canal tiene que ser el techo que
 * había ANTES de que llegara.
 *
 * `null` con menos de `periodo + 1` velas.
 */
export function donchian(velas: readonly Candle[], periodo: number): Donchian | null {
  const n = Math.floor(periodo);
  if (n < 1 || velas.length < n + 1) return null;

  const ultima = velas[velas.length - 1];
  const previas = velas.slice(-(n + 1), -1);

  let alto = D(previas[0].h);
  let bajo = D(previas[0].l);
  for (const v of previas) {
    const h = D(v.h);
    const l = D(v.l);
    if (h.gt(alto)) alto = h;
    if (l.lt(bajo)) bajo = l;
  }
  return { alto, bajo, cierre: D(ultima.c) };
}
