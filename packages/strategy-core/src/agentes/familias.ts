/**
 * Las tres familias de operación del agente (spec 074).
 *
 * CAUSALES: en la vela `j` solo miran velas hasta `j`. Así la misma función
 * detecta en vivo —la última vela cerrada— y recorre el histórico para las
 * tasas base sin mirar al futuro.
 *
 * Los umbrales son los de manual —ADX 20, RSI 35/65, Bollinger 20·2, Donchian
 * 20, compresión en el percentil 20— y no se han ajustado a ninguna muestra:
 * ajustarlos al histórico sería quedarse con lo que mejor salió en el pasado.
 * La tarjeta de resultados los mide (R-25); cambiarlos es un spec.
 *
 * Cada detección da el extremo del que cuelgan los stops, a cuántos ATR va cada
 * tipo de stop y dos objetivos. Los números son estadística (`number`): cruzan
 * a `Decimal` una sola vez, en la herramienta, antes de pasar por `px()`.
 */
import { FamiliaAgente, TipoStop } from '@crypton/shared';
import type { SerieNumerica } from '../canal/numeros';
import { PERIODO_DONCHIAN, type IndicadoresAgente } from './mercado';

export interface DeteccionAgente {
  familia: FamiliaAgente;
  lado: 'LONG' | 'SHORT';
  /** La vela de la señal: se entra a su cierre. */
  indice: number;
  /** El extremo del que cuelgan los stops. */
  extremo: number;
  /** A cuántos ATR más allá del extremo va cada stop. */
  stopsAtr: Readonly<Record<TipoStop, number>>;
  tp1: number;
  tp2: number;
  /** El nivel que sostiene la idea: el borde roto de una ruptura. */
  nivel: number | null;
}

/**
 * Los stops de cada familia, en ATR del intervalo más allá del extremo. En una
 * reversión el extremo es un toque de la banda de Bollinger, que no es un
 * precio que nadie defendiera: el precio la cruza por ruido, y un stop pegado
 * salta sin que la idea haya fallado. Por eso va más lejos, como el canal de
 * banda (spec 067).
 */
export const STOPS_ATR: Readonly<Record<FamiliaAgente, Readonly<Record<TipoStop, number>>>> = {
  [FamiliaAgente.TENDENCIA]: {
    [TipoStop.AJUSTADO]: 0.25,
    [TipoStop.NORMAL]: 0.5,
    [TipoStop.AMPLIO]: 1,
  },
  [FamiliaAgente.RUPTURA]: {
    [TipoStop.AJUSTADO]: 0.25,
    [TipoStop.NORMAL]: 0.5,
    [TipoStop.AMPLIO]: 1,
  },
  [FamiliaAgente.REVERSION]: {
    [TipoStop.AJUSTADO]: 0.5,
    [TipoStop.NORMAL]: 1,
    [TipoStop.AMPLIO]: 1.5,
  },
};

/** Tendencia con fuerza, y rango sin ella: la misma frontera, 20, a los dos lados. */
const ADX_TENDENCIA = 20;
const ADX_RANGO = 20;
/** El retroceso llega a la media rápida si su mínimo se queda a un cuarto de ATR. */
const TOQUE_MEDIA_ATR = 0.25;
/** Y viene de más arriba: un ATR como poco desde el máximo de las 10 velas anteriores. */
const RETROCESO_MIN_ATR = 1;
const VELAS_RETROCESO = 10;
/** Una ruptura no se persigue: el cierre, a un ATR del borde como mucho. */
const PERSECUCION_MAX_ATR = 1;
/** Comprimido: el ancho de Bollinger en su percentil 20 alguna de las 5 velas anteriores. */
const PERCENTIL_COMPRESION = 20;
const VELAS_COMPRESION = 5;
const RSI_SOBREVENTA = 35;
const RSI_SOBRECOMPRA = 65;
/** El segundo objetivo de una reversión se queda a esta fracción del ancho de la banda opuesta. */
const HOLGURA_BANDA = 0.15;
/** La pendiente de la media lenta se mide en las últimas 5 velas. */
const VELAS_PENDIENTE = 5;

const finitos = (...xs: number[]): boolean => xs.every((x) => Number.isFinite(x));

function maximo(xs: ArrayLike<number>, desde: number, hasta: number): number {
  let m = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(0, desde); i <= hasta; i++) if (xs[i] > m) m = xs[i];
  return m;
}

function minimo(xs: ArrayLike<number>, desde: number, hasta: number): number {
  let m = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, desde); i <= hasta; i++) if (xs[i] < m) m = xs[i];
  return m;
}

/**
 * TENDENCIA: un retroceso a la EMA de 20 en una tendencia con fuerza.
 *
 * - La tendencia: EMA20 por encima de la EMA50, la EMA50 subiendo en las
 *   últimas cinco velas y el ADX en 20 o más.
 * - El retroceso: la vela llega a la EMA20 y cierra de su lado, y viene de un
 *   ATR más arriba como poco.
 * - Sin agotar: el RSI entre 40 y 70.
 *
 * Primer objetivo, el máximo de las 20 velas anteriores; el segundo, pasarlo
 * en medio recorrido. El corto, en espejo.
 */
function tendencia(
  s: SerieNumerica,
  ind: IndicadoresAgente,
  j: number,
  largo: boolean,
): DeteccionAgente | null {
  const a = ind.atr[j];
  const e20 = ind.ema20[j];
  const e50 = ind.ema50[j];
  const e50Antes = ind.ema50[j - VELAS_PENDIENTE];
  const r = ind.rsi[j];
  if (j < PERIODO_DONCHIAN || !finitos(a, e20, e50, e50Antes, ind.adx[j], r) || a <= 0) {
    return null;
  }
  if (ind.adx[j] < ADX_TENDENCIA) return null;
  if (largo ? !(e20 > e50 && e50 > e50Antes) : !(e20 < e50 && e50 < e50Antes)) return null;
  const toca = largo ? s.l[j] <= e20 + TOQUE_MEDIA_ATR * a : s.h[j] >= e20 - TOQUE_MEDIA_ATR * a;
  const aguanta = largo ? s.c[j] > e20 : s.c[j] < e20;
  if (!toca || !aguanta) return null;
  const retroceso = largo
    ? maximo(s.h, j - VELAS_RETROCESO, j - 1) - s.l[j]
    : s.h[j] - minimo(s.l, j - VELAS_RETROCESO, j - 1);
  if (retroceso < RETROCESO_MIN_ATR * a) return null;
  if (largo ? r < 40 || r > 70 : r < 30 || r > 60) return null;

  const extremo = largo ? minimo(s.l, j - 2, j) : maximo(s.h, j - 2, j);
  const techo = largo
    ? maximo(s.h, j - PERIODO_DONCHIAN, j - 1)
    : minimo(s.l, j - PERIODO_DONCHIAN, j - 1);
  if (largo ? techo <= s.c[j] : techo >= s.c[j]) return null;
  const tp2 = largo ? techo + (techo - extremo) * 0.5 : techo - (extremo - techo) * 0.5;
  return {
    familia: FamiliaAgente.TENDENCIA,
    lado: largo ? 'LONG' : 'SHORT',
    indice: j,
    extremo,
    stopsAtr: STOPS_ATR[FamiliaAgente.TENDENCIA],
    tp1: techo,
    tp2,
    nivel: null,
  };
}

/**
 * RUPTURA: el cierre sale del canal de Donchian de 20 tras una compresión.
 *
 * - Comprimido: el ancho de Bollinger en su percentil 20 alguna de las cinco
 *   velas anteriores.
 * - La ruptura: el cierre por encima del máximo de las 20 velas anteriores, a
 *   un ATR del borde como mucho: una ruptura no se persigue.
 *
 * La idea se invalida si el precio vuelve dentro del rango: los stops cuelgan
 * del borde roto. Los objetivos, el movimiento medido: medio rango y el rango
 * entero desde el borde, con 1,5 y 3 ATR como poco.
 */
function ruptura(
  s: SerieNumerica,
  ind: IndicadoresAgente,
  j: number,
  largo: boolean,
): DeteccionAgente | null {
  const a = ind.atr[j];
  const alto = ind.donchianAlto[j];
  const bajo = ind.donchianBajo[j];
  if (!finitos(a, alto, bajo) || a <= 0) return null;
  const nivel = largo ? alto : bajo;
  if (largo ? !(s.c[j] > alto) : !(s.c[j] < bajo)) return null;
  if (Math.abs(s.c[j] - nivel) > PERSECUCION_MAX_ATR * a) return null;
  let comprimido = false;
  for (let k = Math.max(0, j - VELAS_COMPRESION); k < j; k++) {
    if (ind.percentilAncho[k] <= PERCENTIL_COMPRESION) comprimido = true;
  }
  if (!comprimido) return null;

  const rango = alto - bajo;
  const corto = Math.max(0.5 * rango, 1.5 * a);
  const largoRecorrido = Math.max(rango, 3 * a);
  const tp1 = largo ? nivel + corto : nivel - corto;
  const tp2 = largo ? nivel + largoRecorrido : nivel - largoRecorrido;
  if (largo ? tp1 <= s.c[j] : tp1 >= s.c[j]) return null;
  return {
    familia: FamiliaAgente.RUPTURA,
    lado: largo ? 'LONG' : 'SHORT',
    indice: j,
    extremo: nivel,
    stopsAtr: STOPS_ATR[FamiliaAgente.RUPTURA],
    tp1,
    tp2,
    nivel,
  };
}

/**
 * REVERSION: un toque de la banda de Bollinger en un rango, con el RSI en un
 * extremo.
 *
 * - En rango: ADX por debajo de 20, sin tendencia que arrastre el precio.
 * - El toque: la vela pasa la banda y cierra dentro.
 * - El RSI, en 35 o menos (65 o más en el corto) en esa vela o la anterior.
 *
 * Primer objetivo, la media de la banda; el segundo, cerca de la banda
 * opuesta.
 */
function reversion(
  s: SerieNumerica,
  ind: IndicadoresAgente,
  j: number,
  largo: boolean,
): DeteccionAgente | null {
  const a = ind.atr[j];
  const inf = ind.bbInferior[j];
  const sup = ind.bbSuperior[j];
  const media = ind.bbMedia[j];
  if (j < 1 || !finitos(a, inf, sup, media, ind.adx[j], ind.rsi[j], ind.rsi[j - 1]) || a <= 0) {
    return null;
  }
  if (ind.adx[j] >= ADX_RANGO) return null;
  const toca = largo ? s.l[j] <= inf : s.h[j] >= sup;
  const vuelve = largo ? s.c[j] > inf : s.c[j] < sup;
  if (!toca || !vuelve) return null;
  const extremoRsi = largo
    ? Math.min(ind.rsi[j], ind.rsi[j - 1]) <= RSI_SOBREVENTA
    : Math.max(ind.rsi[j], ind.rsi[j - 1]) >= RSI_SOBRECOMPRA;
  if (!extremoRsi) return null;
  if (largo ? media <= s.c[j] : media >= s.c[j]) return null;

  const ancho = sup - inf;
  return {
    familia: FamiliaAgente.REVERSION,
    lado: largo ? 'LONG' : 'SHORT',
    indice: j,
    extremo: largo ? s.l[j] : s.h[j],
    stopsAtr: STOPS_ATR[FamiliaAgente.REVERSION],
    tp1: media,
    tp2: largo ? sup - HOLGURA_BANDA * ancho : inf + HOLGURA_BANDA * ancho,
    nivel: null,
  };
}

const DETECTORES: Readonly<
  Record<
    FamiliaAgente,
    (s: SerieNumerica, ind: IndicadoresAgente, j: number, largo: boolean) => DeteccionAgente | null
  >
> = {
  [FamiliaAgente.TENDENCIA]: tendencia,
  [FamiliaAgente.RUPTURA]: ruptura,
  [FamiliaAgente.REVERSION]: reversion,
};

/** Lo que se detecta en la vela `j` para las familias y lados pedidos. */
export function detectarFamilias(
  s: SerieNumerica,
  ind: IndicadoresAgente,
  j: number,
  familias: readonly FamiliaAgente[],
  lados: readonly ('LONG' | 'SHORT')[],
): DeteccionAgente[] {
  const out: DeteccionAgente[] = [];
  if (j < 0 || j >= s.n) return out;
  for (const familia of familias) {
    for (const lado of lados) {
      const d = DETECTORES[familia](s, ind, j, lado === 'LONG');
      if (d) out.push(d);
    }
  }
  return out;
}
