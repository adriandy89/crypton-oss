import type { Candle, MarketSpec } from '@crypton/shared';

/**
 * Rasgos de mercado, calculados aqui y nunca por el modelo.
 *
 * Pedirle a un modelo de lenguaje que calcule la desviacion tipica de trescientos
 * numeros es la peor forma posible de obtenerla: cuesta tokens, tarda y sale mal.
 * Aqui se calculan una vez, se cuantizan y entran en el prompt ya masticados.
 *
 * Todo el fichero es PURO: entra un array de velas, sale un objeto. Se prueba
 * sin levantar nada.
 */

export interface MarketFeatures {
  /** Precio de referencia con el que se calculo TODO lo demas. */
  mark: number;
  /** Volatilidad realizada anualizada, en %. */
  volAnnualPct: number;
  /** Recorrido tipico de una vela de 1 h, en % del precio. */
  atrPct1h: number;
  /** Recorrido tipico de una vela diaria, en % del precio. */
  atrPct1d: number;
  /** Amplitud del rango de los ultimos 30 dias, en %. */
  rangePct30: number;
  /** Donde cae el precio dentro de ese rango: 0 = suelo, 1 = techo. */
  posInRange: number;
  /** Signo y magnitud de la tendencia, en % de separacion entre medias. */
  trendPct: number;
  trend: 'ALCISTA' | 'BAJISTA' | 'LATERAL';
  /**
   * Eficiencia de Kaufman: recorrido neto sobre recorrido total.
   *
   * Cerca de 0 el precio va y viene —terreno de rejilla y de market maker—;
   * cerca de 1 se mueve en linea recta, que es donde una rejilla se queda
   * comprando todo el camino de bajada.
   */
  efficiency: number;
  /** La peor sesion diaria del periodo, en % (negativa). */
  worstDayPct: number;
  /** El tick del mercado en puntos basicos: el suelo real de un diferencial. */
  tickBps: number;
}

const n = (v: string | number | null | undefined): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Media movil exponencial sobre los ultimos `periodo` cierres. */
function ema(values: number[], periodo: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (periodo + 1);
  let acc = values[0];
  for (let i = 1; i < values.length; i++) acc = values[i] * k + acc * (1 - k);
  return acc;
}

/**
 * Rango verdadero medio, en % del ultimo cierre.
 *
 * Es el numero mas util de todos: traduce «un escalon» a cuanto se mueve esto de
 * verdad. Una separacion de rejilla del 1 % es holgada en un par tranquilo y
 * ridicula en uno que respira un 4 % por vela.
 */
function atrPct(velas: Candle[], periodo: number): number {
  if (velas.length < 2) return 0;
  const trozo = velas.slice(-Math.min(periodo + 1, velas.length));
  let suma = 0;
  let cuenta = 0;
  for (let i = 1; i < trozo.length; i++) {
    const alto = n(trozo[i].h);
    const bajo = n(trozo[i].l);
    const cierrePrevio = n(trozo[i - 1].c);
    const tr = Math.max(alto - bajo, Math.abs(alto - cierrePrevio), Math.abs(bajo - cierrePrevio));
    suma += tr;
    cuenta++;
  }
  const ultimo = n(velas[velas.length - 1].c);
  if (cuenta === 0 || ultimo <= 0) return 0;
  return (suma / cuenta / ultimo) * 100;
}

/**
 * Construye los rasgos.
 *
 * @param velas1h serie horaria, ascendente. Se esperan ~300 (12 dias).
 * @param velas1d serie diaria, ascendente. Se esperan ~150 (5 meses).
 */
export function buildFeatures(
  velas1h: Candle[],
  velas1d: Candle[],
  market: MarketSpec,
  markPrice: string | number,
): MarketFeatures | null {
  // Sin serie no hay rasgos, y sin rasgos no se llama al modelo: un prompt con
  // la volatilidad a cero produce numeros inventados con aspecto de calculados.
  if (velas1h.length < 30) return null;

  const mark = n(markPrice) || n(velas1h[velas1h.length - 1].c);
  if (mark <= 0) return null;

  const cierres1h = velas1h.map((v) => n(v.c)).filter((v) => v > 0);

  // ── Volatilidad realizada, anualizada ──
  // Sobre los retornos logaritmicos de la ultima semana. No se resta la media:
  // en 168 muestras es practicamente cero y restarla solo mete ruido.
  const ventana = cierres1h.slice(-168);
  const retornos: number[] = [];
  for (let i = 1; i < ventana.length; i++) {
    retornos.push(Math.log(ventana[i] / ventana[i - 1]));
  }
  const varianza =
    retornos.length > 1 ? retornos.reduce((a, r) => a + r * r, 0) / (retornos.length - 1) : 0;
  const volAnnualPct = Math.sqrt(varianza) * Math.sqrt(24 * 365) * 100;

  // ── Rango de los ultimos 30 dias y posicion dentro de el ──
  const dias30 = velas1d.slice(-30);
  const altos = dias30.map((v) => n(v.h)).filter((v) => v > 0);
  const bajos = dias30.map((v) => n(v.l)).filter((v) => v > 0);
  const techo = altos.length ? Math.max(...altos) : mark;
  const suelo = bajos.length ? Math.min(...bajos) : mark;
  const amplitud = techo - suelo;
  const rangePct30 = suelo > 0 ? (amplitud / suelo) * 100 : 0;
  const posInRange = amplitud > 0 ? (mark - suelo) / amplitud : 0.5;

  // ── Tendencia: separacion entre una media rapida y una lenta ──
  const rapida = ema(cierres1h.slice(-24), 24);
  const lenta = ema(cierres1h.slice(-120), 120);
  const trendPct = lenta > 0 ? ((rapida - lenta) / lenta) * 100 : 0;

  // ── Eficiencia: recorrido neto sobre recorrido total ──
  const tramo = cierres1h.slice(-168);
  let recorrido = 0;
  for (let i = 1; i < tramo.length; i++) recorrido += Math.abs(tramo[i] - tramo[i - 1]);
  const neto = tramo.length > 1 ? Math.abs(tramo[tramo.length - 1] - tramo[0]) : 0;
  const efficiency = recorrido > 0 ? neto / recorrido : 0;

  // ── La peor sesion del periodo ──
  // Se contrasta despues contra la distancia a liquidacion: si el peor dia se
  // come un tercio de esa distancia, el apalancamiento propuesto es una tonteria.
  let worstDayPct = 0;
  for (let i = 1; i < velas1d.length; i++) {
    const previo = n(velas1d[i - 1].c);
    const actual = n(velas1d[i].c);
    if (previo <= 0 || actual <= 0) continue;
    const cambio = ((actual - previo) / previo) * 100;
    if (cambio < worstDayPct) worstDayPct = cambio;
  }

  const tickBps = mark > 0 ? (n(market.tickSize) / mark) * 10_000 : 0;

  return {
    mark,
    volAnnualPct: round2(volAnnualPct),
    atrPct1h: round2(atrPct(velas1h, 14)),
    atrPct1d: round2(velas1d.length >= 2 ? atrPct(velas1d, 14) : atrPct(velas1h, 14) * 4),
    rangePct30: round2(rangePct30),
    posInRange: round2(Math.min(Math.max(posInRange, 0), 1)),
    trendPct: round2(trendPct),
    trend: trendPct > 1.5 ? 'ALCISTA' : trendPct < -1.5 ? 'BAJISTA' : 'LATERAL',
    efficiency: round2(efficiency),
    worstDayPct: round2(worstDayPct),
    tickBps: round2(tickBps),
  };
}

/**
 * Huella cuantizada de los rasgos, para la clave de cache.
 *
 * Cuantizar no es una optimizacion: es lo que impide que cada peticion genere
 * una clave nueva. Con los rasgos crudos —dos decimales sobre un precio que se
 * mueve— cada llamada seria un fallo de cache y una llamada pagada al modelo. Es
 * el mismo motivo por el que el modulo de mercado cuantiza el limite de velas.
 *
 * Ningun componente de esta huella lo controla el usuario: todos salen de las
 * velas del venue.
 */
export function featuresBucket(f: MarketFeatures): string {
  const tramo = (v: number, cortes: number[]): number => {
    for (let i = 0; i < cortes.length; i++) if (v < cortes[i]) return i;
    return cortes.length;
  };
  return [
    tramo(f.atrPct1h, [0.2, 0.4, 0.7, 1.2, 2, 3.5, 6]),
    tramo(f.atrPct1d, [1, 2, 3.5, 6, 10, 16]),
    tramo(f.volAnnualPct, [30, 60, 100, 160, 250]),
    tramo(f.rangePct30, [10, 25, 50, 100]),
    tramo(f.posInRange, [0.2, 0.4, 0.6, 0.8]),
    f.trend === 'ALCISTA' ? 'A' : f.trend === 'BAJISTA' ? 'B' : 'L',
    tramo(f.efficiency, [0.15, 0.3, 0.5]),
    tramo(Math.abs(f.worstDayPct), [3, 6, 12, 20]),
    tramo(f.tickBps, [0.5, 2, 10, 50]),
  ].join('');
}
