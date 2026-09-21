/**
 * El detector de cascadas de liquidación y sus rasgos (spec 071).
 *
 * ── Qué es una cascada, y por qué esto no es «comprar caídas» ──
 *
 * En un perpetuo, los largos apalancados son el lado abarrotado. Cuando el
 * precio baja lo suficiente, el venue **cierra a la fuerza** los más apalancados,
 * y esa venta forzada empuja el precio al siguiente tramo de liquidaciones. La
 * venta no la decide nadie: la decide el motor de riesgo del exchange. Por eso
 * el movimiento sobrepasa el precio que justificaría cualquier noticia, y por
 * eso vuelve.
 *
 * Eso lo hace **asimétrico**, y la medición lo confirma: comprar el pánico da
 * +0,573 % neto con t 4,66 sobre 368 eventos, mientras que vender la euforia da
 * +0,143 % con t 1,20 — nada. Los cortos no están igual de abarrotados, así que
 * sus liquidaciones no cascadean.
 *
 * ── Lo que este módulo NO hace ──
 *
 * No decide. Detecta el evento y describe lo que se ve, en unidades relativas.
 * Quién decide es otro asunto —un escalar barato, un logit, o el modelo— y este
 * spec existe justamente para medir cuál de los tres aporta.
 *
 * ── Por qué vive en `strategy-core` ──
 *
 * Igual que `estado.ts`: el backtest tiene que poder reproducir el mismo estado
 * **byte a byte** para replicar una corrida sin volver a llamar a nadie. Con
 * esto en la API, el mensaje exacto sería irreproducible fuera de ella.
 */
import type { SerieNumerica } from '../canal/numeros';

/**
 * El flujo agresor de cada vela, que NO viaja en `SerieNumerica`.
 *
 * Es la distinción entre **rotación** —alguien tomando posición a propósito— y
 * **liquidación forzada** —posiciones cerrándose solas—, y la literatura la
 * señala como lo decisivo para saber si un movimiento tiene continuidad. Ningún
 * indicador de precio puede verla.
 *
 * Se descargó tarde: el primer script de datos se quedaba con seis de los doce
 * campos que devuelve el venue y tiró justo estos.
 */
export interface FlujoAgresor {
  /** Volumen de COMPRA agresora de cada vela, en unidades base. */
  compraAgresora: Float64Array;
  /** Número de operaciones de cada vela. */
  operaciones: Float64Array;
}

export interface ParametrosCascada {
  /** Velas hacia atrás sobre las que se mide la caída. */
  ventana: number;
  /** Caída mínima en tanto por uno para que cuente como evento. */
  caidaMinima: number;
  /** Velas de referencia para las medias de volumen y flujo. */
  referencia: number;
}

export const CASCADA_POR_DEFECTO: ParametrosCascada = {
  // Doce velas de 5 min = una hora, y 3 %: es lo medido, no lo elegido. Con
  // ventana de 30 min el efecto es parecido pero hay la mitad de eventos, y con
  // umbral del 5 % sube a +1,33 % con solo 64 casos.
  ventana: 12,
  caidaMinima: 0.03,
  referencia: 288,
};

/**
 * Los rasgos de una cascada, todos **adimensionales**.
 *
 * Ni un precio, ni un importe, ni una cantidad: lo que sale de aquí va a un
 * modelo de lenguaje y a un clasificador, y los dos tienen que poder comparar
 * un evento de BTC con uno de DOGE sin que la escala les diga cuál es cuál.
 */
export interface RasgosCascada {
  /** Índice de la vela del evento dentro de la serie. */
  indice: number;
  /** Caída acumulada de la ventana, en tanto por uno (positiva). */
  caida: number;
  /** La misma caída, en múltiplos del ATR de la ventana. */
  caidaEnAtr: number;
  /** Velas de las `ventana` que cerraron a la baja. */
  velasEnRojo: number;
  /** La peor vela de la ventana sobre el total: 1 = todo fue un salto. */
  concentracion: number;

  /** Cuota de compra agresora de la ventana, de 0 a 1. `NaN` si no hay dato. */
  cuotaCompra: number;
  /** La misma cuota en la referencia: la línea base del par. */
  cuotaCompraBase: number;
  /** Volumen de la ventana sobre su media de referencia. */
  volumenRatio: number;
  /** Operaciones de la ventana sobre su media: muchas y pequeñas = minoristas. */
  operacionesRatio: number;
  /**
   * Tamaño medio de operación sobre su base.
   *
   * Es el rasgo que más directamente distingue una liquidación forzada: el
   * motor de riesgo cierra posiciones grandes de golpe, así que el tamaño medio
   * se dispara aunque el número de operaciones no.
   */
  tamanoMedioRatio: number;

  /** Mecha inferior de la vela del evento sobre su rango: rechazo del mínimo. */
  mechaInferior: number;
  /** Dónde cerró la vela dentro de su rango: 0 = en el mínimo, 1 = en el máximo. */
  cierreEnRango: number;

  /** ATR de la ventana sobre el ATR largo: cuánto se expandió la volatilidad. */
  expansionVolatilidad: number;
  /** Tendencia previa: retorno de las `referencia` velas ANTERIORES a la ventana. */
  derivaPrevia: number;
  /** Velas desde el mínimo anterior de la referencia. 0 = esto es un mínimo nuevo. */
  velasDesdeMinimo: number;
  /** Cuánto por debajo del mínimo previo cerró, en ATR. Negativo = no lo rompió. */
  rupturaDelMinimo: number;
}

const finito = (x: number): boolean => Number.isFinite(x);

/** Media de un tramo de un array tipado, ignorando lo que no es finito. */
function media(a: Float64Array, desde: number, hasta: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, desde); i <= hasta; i++) {
    if (finito(a[i])) {
      s += a[i];
      n++;
    }
  }
  return n > 0 ? s / n : Number.NaN;
}

/** ATR simple de un tramo: media del rango verdadero. */
function atrTramo(s: SerieNumerica, desde: number, hasta: number): number {
  let suma = 0;
  let n = 0;
  for (let i = Math.max(1, desde); i <= hasta; i++) {
    const tr = Math.max(
      s.h[i] - s.l[i],
      Math.abs(s.h[i] - s.c[i - 1]),
      Math.abs(s.l[i] - s.c[i - 1]),
    );
    if (finito(tr)) {
      suma += tr;
      n++;
    }
  }
  return n > 0 ? suma / n : Number.NaN;
}

/**
 * ¿La vela `i` cierra una cascada? El evento, o `null`.
 *
 * **Solo mira hacia atrás.** La vela `i` tiene que estar cerrada; nada de lo
 * que se lee aquí ocurre después de su cierre. Es la única forma de que la
 * medición signifique algo.
 */
export function detectarCascada(
  s: SerieNumerica,
  i: number,
  p: ParametrosCascada = CASCADA_POR_DEFECTO,
): { caida: number } | null {
  if (i < p.ventana || i >= s.n) return null;
  const antes = s.c[i - p.ventana];
  const ahora = s.c[i];
  if (!finito(antes) || !finito(ahora) || antes <= 0) return null;
  const caida = (antes - ahora) / antes;
  return caida >= p.caidaMinima ? { caida } : null;
}

/**
 * Los rasgos del evento de la vela `i`.
 *
 * `flujo` es opcional: sin él, los cuatro rasgos de agresor salen `NaN` y quien
 * los consuma tiene que decir que no hay dato, nunca rellenarlos. Un cero ahí
 * sería «no hubo compras», que es una afirmación, no una ausencia.
 */
export function rasgosCascada(
  s: SerieNumerica,
  i: number,
  p: ParametrosCascada = CASCADA_POR_DEFECTO,
  flujo?: FlujoAgresor,
): RasgosCascada | null {
  const ev = detectarCascada(s, i, p);
  if (!ev) return null;

  const desdeV = i - p.ventana + 1;
  const desdeR = Math.max(1, i - p.ventana - p.referencia + 1);
  const hastaR = i - p.ventana;
  // La referencia tiene que estar ENTERA. Con media docena de velas detrás
  // salen medias que no son medias, y todos los rasgos son cocientes contra
  // ellas: un ratio calculado sobre siete velas no dice nada y lo parece.
  if (hastaR - desdeR + 1 < p.referencia) return null;

  const atrV = atrTramo(s, desdeV, i);
  const atrL = atrTramo(s, desdeR, hastaR);
  const precio = s.c[i];
  if (!finito(atrV) || !finito(atrL) || atrL <= 0 || precio <= 0) return null;

  // Cuántas velas de la ventana cerraron a la baja, y cuánto pesó la peor.
  let enRojo = 0;
  let peor = 0;
  for (let k = desdeV; k <= i; k++) {
    const r = (s.c[k] - s.c[k - 1]) / s.c[k - 1];
    if (r < 0) {
      enRojo++;
      peor = Math.min(peor, r);
    }
  }

  // Flujo agresor: la ventana contra su propia línea base.
  let cuotaCompra = Number.NaN;
  let cuotaCompraBase = Number.NaN;
  let operacionesRatio = Number.NaN;
  let tamanoMedioRatio = Number.NaN;
  if (flujo) {
    let cV = 0;
    let vV = 0;
    for (let k = desdeV; k <= i; k++) {
      if (finito(flujo.compraAgresora[k]) && finito(s.v[k])) {
        cV += flujo.compraAgresora[k];
        vV += s.v[k];
      }
    }
    cuotaCompra = vV > 0 ? cV / vV : Number.NaN;

    let cR = 0;
    let vR = 0;
    for (let k = desdeR; k <= hastaR; k++) {
      if (finito(flujo.compraAgresora[k]) && finito(s.v[k])) {
        cR += flujo.compraAgresora[k];
        vR += s.v[k];
      }
    }
    cuotaCompraBase = vR > 0 ? cR / vR : Number.NaN;

    const opV = media(flujo.operaciones, desdeV, i);
    const opR = media(flujo.operaciones, desdeR, hastaR);
    operacionesRatio = opR > 0 ? opV / opR : Number.NaN;

    const volV = media(s.v, desdeV, i);
    const volR = media(s.v, desdeR, hastaR);
    const tamV = opV > 0 ? volV / opV : Number.NaN;
    const tamR = opR > 0 ? volR / opR : Number.NaN;
    tamanoMedioRatio = finito(tamV) && finito(tamR) && tamR > 0 ? tamV / tamR : Number.NaN;
  }

  const volV = media(s.v, desdeV, i);
  const volR = media(s.v, desdeR, hastaR);

  // La vela del evento.
  const rango = s.h[i] - s.l[i];
  const mechaInferior = rango > 0 ? (Math.min(s.o[i], s.c[i]) - s.l[i]) / rango : Number.NaN;
  const cierreEnRango = rango > 0 ? (s.c[i] - s.l[i]) / rango : Number.NaN;

  // Estructura: el mínimo previo y si esto lo rompió.
  let minPrevio = Infinity;
  let idxMin = hastaR;
  for (let k = desdeR; k <= hastaR; k++) {
    if (s.l[k] < minPrevio) {
      minPrevio = s.l[k]!;
      idxMin = k;
    }
  }
  const derivaPrevia = (s.c[hastaR] - s.c[desdeR]) / s.c[desdeR];

  return {
    indice: i,
    caida: ev.caida,
    caidaEnAtr: (ev.caida * precio) / atrV,
    velasEnRojo: enRojo,
    concentracion: ev.caida > 0 ? Math.abs(peor) / ev.caida : Number.NaN,
    cuotaCompra,
    cuotaCompraBase,
    volumenRatio: volR > 0 ? volV / volR : Number.NaN,
    operacionesRatio,
    tamanoMedioRatio,
    mechaInferior,
    cierreEnRango,
    expansionVolatilidad: atrV / atrL,
    derivaPrevia,
    velasDesdeMinimo: i - idxMin,
    rupturaDelMinimo: (minPrevio - s.l[i]) / atrV,
  };
}
