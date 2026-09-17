/**
 * La frontera entre la estadística y el dinero (spec 058).
 *
 * El motor del canal mide el mercado con `number`: mil velas en `Decimal`
 * llevan el análisis de 20 ms a varios cientos, y un ADX o una recta de mínimos
 * cuadrados son estadísticas, no importes. Lo que sale de aquí hacia una orden
 * cruza la frontera UNA vez, con `aDecimal`, y pasa por `px()` antes de tocar
 * nada: el precio que se manda es siempre un `Decimal` en la retícula del venue
 * (invariante 1).
 */
import { D, type Candle, type Decimal } from '@crypton/shared';

/** Una serie de velas como columnas de números. */
export interface SerieNumerica {
  n: number;
  /** Apertura de cada vela, en ms. */
  t: number[];
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  /** `NaN` donde el venue no dio volumen. */
  v: Float64Array;
}

export function serieNumerica(velas: readonly Candle[]): SerieNumerica {
  const n = velas.length;
  const s: SerieNumerica = {
    n,
    t: new Array<number>(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const vela = velas[i];
    s.t[i] = vela.t;
    s.o[i] = Number(vela.o);
    s.h[i] = Number(vela.h);
    s.l[i] = Number(vela.l);
    s.c[i] = Number(vela.c);
    s.v[i] = vela.v === null ? Number.NaN : Number(vela.v);
  }
  return s;
}

/** Los últimos `k` elementos de la serie, sin copiar los arrays tipados. */
export function recortarSerie(s: SerieNumerica, k: number): SerieNumerica {
  if (k >= s.n) return s;
  const desde = s.n - k;
  return {
    n: k,
    t: s.t.slice(desde),
    o: s.o.subarray(desde),
    h: s.h.subarray(desde),
    l: s.l.subarray(desde),
    c: s.c.subarray(desde),
    v: s.v.subarray(desde),
  };
}

/**
 * Las primeras `k` velas: la serie tal y como se veía al cerrar la vela `k − 1`.
 * Los índices no cambian, así que los giros de la serie entera sirven tal cual.
 */
export function prefijoSerie(s: SerieNumerica, k: number): SerieNumerica {
  if (k >= s.n) return s;
  return {
    n: k,
    t: s.t.slice(0, k),
    o: s.o.subarray(0, k),
    h: s.h.subarray(0, k),
    l: s.l.subarray(0, k),
    c: s.c.subarray(0, k),
    v: s.v.subarray(0, k),
  };
}

/**
 * Un número de la estadística hacia el mundo del dinero.
 *
 * Lanza con un valor no finito: un nivel `NaN` que llegara a una orden sería
 * un precio que nadie ha calculado.
 */
export function aDecimal(n: number): Decimal {
  if (!Number.isFinite(n)) throw new Error('Valor no finito en el motor del canal: ' + n);
  return D(n.toString());
}

/** Un `Decimal` hacia la estadística. Solo para medir, nunca para una orden. */
export const aNumero = (d: Decimal | string): number =>
  Number(typeof d === 'string' ? d : d.toFixed());
