/**
 * Estadística del motor del canal, en `number` y CAUSAL (spec 058).
 *
 * Toda serie que devuelve este módulo tiene la longitud de su entrada, y su
 * valor en `i` solo depende de los datos hasta `i`. Es lo que permite evaluar
 * el régimen de hace tres velas leyendo la misma serie, y lo que hace que el
 * backtest no mire al futuro. Donde todavía no hay datos suficientes, `NaN`.
 *
 * Cada fórmula tiene su test con cifras calculadas a mano.
 */

const nan = (n: number): Float64Array => new Float64Array(n).fill(Number.NaN);

/** Media simple de las últimas `p` observaciones. */
export function sma(x: ArrayLike<number>, p: number): Float64Array {
  const out = nan(x.length);
  if (p < 1) return out;
  let suma = 0;
  for (let i = 0; i < x.length; i++) {
    suma += x[i];
    if (i >= p) suma -= x[i - p];
    if (i >= p - 1) out[i] = suma / p;
  }
  return out;
}

/** Media exponencial (`α = 2/(p+1)`), sembrada con la simple de las primeras `p`. */
export function ema(x: ArrayLike<number>, p: number): Float64Array {
  return suavizar(x, p, 2 / (p + 1));
}

/** Media de Wilder (`α = 1/p`), la de RSI y ADX, sembrada igual. */
export function rma(x: ArrayLike<number>, p: number): Float64Array {
  return suavizar(x, p, 1 / p);
}

/**
 * Suavizado exponencial sembrado con la media simple de las primeras `p`
 * observaciones VÁLIDAS. Los `NaN` del principio (una serie derivada que aún
 * no tiene valor) se saltan; un `NaN` después de sembrar corta la serie.
 */
function suavizar(x: ArrayLike<number>, p: number, alfa: number): Float64Array {
  const out = nan(x.length);
  if (p < 1) return out;
  let inicio = 0;
  while (inicio < x.length && !Number.isFinite(x[inicio])) inicio++;
  if (inicio + p > x.length) return out;
  let semilla = 0;
  for (let i = inicio; i < inicio + p; i++) semilla += x[i];
  let previo = semilla / p;
  out[inicio + p - 1] = previo;
  for (let i = inicio + p; i < x.length; i++) {
    if (!Number.isFinite(x[i])) break;
    previo = alfa * x[i] + (1 - alfa) * previo;
    out[i] = previo;
  }
  return out;
}

/**
 * Rango verdadero de cada vela. La primera, sin cierre anterior, no tiene
 * hueco que medir y vale `NaN`: así ningún promedio la mezcla con las demás.
 */
export function rangoVerdadero(
  h: ArrayLike<number>,
  l: ArrayLike<number>,
  c: ArrayLike<number>,
): Float64Array {
  const out = nan(h.length);
  for (let i = 1; i < h.length; i++) {
    const previo = c[i - 1];
    out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - previo), Math.abs(l[i] - previo));
  }
  return out;
}

/**
 * ATR como media ARITMÉTICA de los últimos `p` rangos verdaderos: la misma
 * cuenta que `indicadores.atr`, que se comprueba a mano (spec 040). Vale desde
 * la vela `p`.
 */
export function atrSerie(
  h: ArrayLike<number>,
  l: ArrayLike<number>,
  c: ArrayLike<number>,
  p: number,
): Float64Array {
  const tr = rangoVerdadero(h, l, c);
  const out = nan(h.length);
  let suma = 0;
  for (let i = 1; i < h.length; i++) {
    suma += tr[i];
    if (i > p) suma -= tr[i - p];
    if (i >= p) out[i] = suma / p;
  }
  return out;
}

/** RSI de Wilder. */
export function rsi(c: ArrayLike<number>, p: number): Float64Array {
  const n = c.length;
  const subidas = nan(n);
  const bajadas = nan(n);
  for (let i = 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    subidas[i] = d > 0 ? d : 0;
    bajadas[i] = d < 0 ? -d : 0;
  }
  const g = rma(subidas, p);
  const b = rma(bajadas, p);
  const out = nan(n);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(g[i]) || !Number.isFinite(b[i])) continue;
    if (b[i] === 0) out[i] = g[i] === 0 ? 50 : 100;
    else out[i] = 100 - 100 / (1 + g[i] / b[i]);
  }
  return out;
}

/** ADX de Wilder, con sus dos direccionales. */
export function adx(
  h: ArrayLike<number>,
  l: ArrayLike<number>,
  c: ArrayLike<number>,
  p: number,
): { adx: Float64Array; masDi: Float64Array; menosDi: Float64Array } {
  const n = h.length;
  const dmMas = nan(n);
  const dmMenos = nan(n);
  for (let i = 1; i < n; i++) {
    const arriba = h[i] - h[i - 1];
    const abajo = l[i - 1] - l[i];
    dmMas[i] = arriba > abajo && arriba > 0 ? arriba : 0;
    dmMenos[i] = abajo > arriba && abajo > 0 ? abajo : 0;
  }
  const tr = rma(rangoVerdadero(h, l, c), p);
  const mas = rma(dmMas, p);
  const menos = rma(dmMenos, p);
  const masDi = nan(n);
  const menosDi = nan(n);
  const dx = nan(n);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(tr[i]) || tr[i] <= 0) continue;
    masDi[i] = (100 * mas[i]) / tr[i];
    menosDi[i] = (100 * menos[i]) / tr[i];
    const suma = masDi[i] + menosDi[i];
    dx[i] = suma > 0 ? (100 * Math.abs(masDi[i] - menosDi[i])) / suma : 0;
  }
  return { adx: rma(dx, p), masDi, menosDi };
}

/**
 * Índice de choppiness: `100·log10(ΣTR / (máximo − mínimo)) / log10(p)`.
 *
 * Cerca de 100, un mercado que va y viene sin llegar a ningún sitio; cerca de
 * 0, uno que se va recto.
 */
export function chop(
  h: ArrayLike<number>,
  l: ArrayLike<number>,
  c: ArrayLike<number>,
  p: number,
): Float64Array {
  const tr = rangoVerdadero(h, l, c);
  const out = nan(h.length);
  const log = Math.log10(p);
  for (let i = p; i < h.length; i++) {
    let suma = 0;
    let alto = Number.NEGATIVE_INFINITY;
    let bajo = Number.POSITIVE_INFINITY;
    for (let j = i - p + 1; j <= i; j++) {
      suma += tr[j];
      if (h[j] > alto) alto = h[j];
      if (l[j] < bajo) bajo = l[j];
    }
    const rango = alto - bajo;
    if (rango > 0 && suma > 0) out[i] = (100 * Math.log10(suma / rango)) / log;
  }
  return out;
}

/** Bandas de Bollinger con desviación POBLACIONAL, y su anchura relativa a la media. */
export function bollinger(
  c: ArrayLike<number>,
  p: number,
  k: number,
): { media: Float64Array; superior: Float64Array; inferior: Float64Array; ancho: Float64Array } {
  const n = c.length;
  const media = sma(c, p);
  const superior = nan(n);
  const inferior = nan(n);
  const ancho = nan(n);
  for (let i = p - 1; i < n; i++) {
    let suma = 0;
    for (let j = i - p + 1; j <= i; j++) suma += (c[j] - media[i]) ** 2;
    const sd = Math.sqrt(suma / p);
    superior[i] = media[i] + k * sd;
    inferior[i] = media[i] - k * sd;
    ancho[i] = media[i] !== 0 ? (superior[i] - inferior[i]) / media[i] : Number.NaN;
  }
  return { media, superior, inferior, ancho };
}

/** Eficiencia de Kaufman en ventana: desplazamiento neto sobre recorrido. */
export function eficiencia(c: ArrayLike<number>, p: number): Float64Array {
  const out = nan(c.length);
  for (let i = p; i < c.length; i++) {
    let recorrido = 0;
    for (let j = i - p + 1; j <= i; j++) recorrido += Math.abs(c[j] - c[j - 1]);
    out[i] = recorrido > 0 ? Math.abs(c[i] - c[i - p]) / recorrido : 0;
  }
  return out;
}

/**
 * Rango percentil de `valor` dentro de la muestra, de 0 a 100, con los empates
 * contados a medias: en una muestra de valores iguales, cualquiera de ellos
 * queda en el 50 y no en el 100. Los `NaN` de la muestra no cuentan.
 */
export function percentil(valor: number, muestra: ArrayLike<number>): number {
  let validos = 0;
  let menores = 0;
  let iguales = 0;
  for (let i = 0; i < muestra.length; i++) {
    const m = muestra[i];
    if (!Number.isFinite(m)) continue;
    validos++;
    if (m < valor) menores++;
    else if (m === valor) iguales++;
  }
  return validos > 0 ? (100 * (menores + iguales / 2)) / validos : Number.NaN;
}

export interface Recta {
  pendiente: number;
  ordenada: number;
  r2: number;
  /** Estadístico t de la pendiente; `NaN` con menos de 3 puntos. */
  t: number;
}

/** Mínimos cuadrados ordinarios de `y` sobre `x`. */
export function ols(x: ArrayLike<number>, y: ArrayLike<number>): Recta | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
    syy += (y[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const pendiente = sxy / sxx;
  const ordenada = my - pendiente * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (y[i] - (ordenada + pendiente * x[i])) ** 2;
  const r2 = syy > 0 ? 1 - sse / syy : 1;
  const t = n > 2 && sse > 0 ? pendiente / Math.sqrt(sse / (n - 2) / sxx) : Number.NaN;
  return { pendiente, ordenada, r2, t };
}

export interface RectasParalelas {
  pendiente: number;
  ordenadaA: number;
  ordenadaB: number;
  /** R² de cada grupo con la pendiente COMÚN. */
  r2A: number;
  r2B: number;
  /** Pendiente propia de cada grupo, para medir cuánto se separan. */
  propiaA: number;
  propiaB: number;
}

/**
 * Dos rectas con la MISMA pendiente y ordenadas propias: la pendiente común
 * pondera las dos nubes de puntos juntas. Es lo que define un canal inclinado.
 */
export function olsParalelas(
  xa: ArrayLike<number>,
  ya: ArrayLike<number>,
  xb: ArrayLike<number>,
  yb: ArrayLike<number>,
): RectasParalelas | null {
  const grupo = (x: ArrayLike<number>, y: ArrayLike<number>) => {
    const n = Math.min(x.length, y.length);
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += x[i];
      my += y[i];
    }
    mx /= n;
    my /= n;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (x[i] - mx) ** 2;
      sxy += (x[i] - mx) * (y[i] - my);
      syy += (y[i] - my) ** 2;
    }
    return { n, mx, my, sxx, sxy, syy };
  };
  if (xa.length < 2 || xb.length < 2) return null;
  const a = grupo(xa, ya);
  const b = grupo(xb, yb);
  if (a.sxx === 0 || b.sxx === 0) return null;
  const pendiente = (a.sxy + b.sxy) / (a.sxx + b.sxx);
  const ordenadaA = a.my - pendiente * a.mx;
  const ordenadaB = b.my - pendiente * b.mx;
  const r2 = (x: ArrayLike<number>, y: ArrayLike<number>, ord: number, syy: number) => {
    let sse = 0;
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      sse += (y[i] - (ord + pendiente * x[i])) ** 2;
    }
    return syy > 0 ? 1 - sse / syy : 1;
  };
  return {
    pendiente,
    ordenadaA,
    ordenadaB,
    r2A: r2(xa, ya, ordenadaA, a.syy),
    r2B: r2(xb, yb, ordenadaB, b.syy),
    propiaA: a.sxy / a.sxx,
    propiaB: b.sxy / b.sxx,
  };
}

/**
 * Media vida de la reversión a la media, en observaciones (modelo AR(1) de
 * Ornstein-Uhlenbeck): se ajusta `Δy = α + β·y₋₁` y la media vida es
 * `−ln 2 / ln(1 + β)`. `null` si la serie no revierte (`β` fuera de (−1, 0)).
 */
export function mediaVidaOU(y: ArrayLike<number>): number | null {
  if (y.length < 3) return null;
  const x = new Float64Array(y.length - 1);
  const d = new Float64Array(y.length - 1);
  for (let i = 1; i < y.length; i++) {
    x[i - 1] = y[i - 1];
    d[i - 1] = y[i] - y[i - 1];
  }
  const recta = ols(x, d);
  if (!recta) return null;
  const beta = recta.pendiente;
  if (!(beta < 0 && beta > -1)) return null;
  return -Math.LN2 / Math.log(1 + beta);
}

/** Límite inferior del intervalo de Wilson para un acierto de `exitos/n`. */
export function wilsonInferior(exitos: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = exitos / n;
  const z2 = z * z;
  const centro = p + z2 / (2 * n);
  const margen = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centro - margen) / (1 + z2 / n));
}

/** Cuántas veces cambia de signo la serie, ignorando los ceros. */
export function cambiosDeSigno(y: ArrayLike<number>): number {
  let previo = 0;
  let cambios = 0;
  for (let i = 0; i < y.length; i++) {
    const s = Math.sign(y[i]);
    if (s === 0 || !Number.isFinite(y[i])) continue;
    if (previo !== 0 && s !== previo) cambios++;
    previo = s;
  }
  return cambios;
}
