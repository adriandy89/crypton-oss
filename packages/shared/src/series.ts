import { D, Decimal, isFiniteNum, type Numeric } from './money';

/**
 * Series de dinero, preparadas para pintarse, y la analítica pequeña que sale de
 * ellas.
 *
 * Todo aquí es PURO: entra una lista de puntos con el importe en cadena y sale
 * lo que hace falta para dibujar la línea Y para rotularla. Vive en `shared` y
 * no junto a la pantalla por el mismo motivo escrito en `candle-paging.ts`:
 * `apps/app` no tiene tests, y sacando la DECISIÓN de la vista lo único que
 * queda sin cubrir es el cableado con el SVG.
 *
 * La regla que gobierna el fichero es la frontera del invariante 1. Los importes
 * entran como `string`, se operan con `Decimal`, y todo lo que el usuario LEE
 * —primero, último, delta, peor caída, acierto, comisiones— sale también como
 * `string`, exacto. Lo único que se convierte a `number` son las coordenadas de
 * dibujo y los porcentajes que alimentan una barra, y cada conversión está
 * marcada y cubierta por un test.
 *
 * Las constantes de la serie de un bot viven aquí y no en cada extremo: el
 * servidor las usa para agregar y el cliente para saber dónde romper la línea, y
 * dos copias acabarían partiendo una curva continua o pegando una con huecos.
 */

/** Cadencia real de escritura de `bot_snapshots`: `PERSIST_EVERY_TICKS` × latido, un minuto. */
export const SNAPSHOT_CADENCE_MS = 60_000;

/**
 * Puntos de una serie agregada. 480 divide exacto los rangos de 24 h, 7 d y 30 d,
 * y es múltiplo de 4, que es lo que `muestreoPorExtremos` necesita para que su
 * tope sea duro.
 */
export const SERIES_POINTS = 480;

/** Redondea hacia abajo al minuto: las peticiones del mismo minuto comparten caché. */
export const alMinuto = (ms: number): number =>
  Math.floor(ms / SNAPSHOT_CADENCE_MS) * SNAPSHOT_CADENCE_MS;

/**
 * Tamaño del cubo para que un rango quepa en `cubos` cubos, en minutos enteros y
 * nunca por debajo de la cadencia: un cubo de 30 s sobre una tabla que escribe
 * cada minuto solo produciría cubos vacíos.
 *
 * Quien conserva CUATRO filas por cubo —primera, mínima, máxima y última, como
 * hace el servidor— tiene que pedir `puntos / 4` cubos para que salgan `puntos`
 * filas; es la misma regla `tope / 4` de `muestreoPorExtremos`.
 */
export function bucketMsFor(fromMs: number, toMs: number, cubos: number): number {
  const span = Math.max(0, toMs - fromMs);
  const crudo = Math.ceil(span / Math.max(1, cubos));
  return Math.max(
    SNAPSHOT_CADENCE_MS,
    Math.ceil(crudo / SNAPSHOT_CADENCE_MS) * SNAPSHOT_CADENCE_MS,
  );
}

/**
 * Separación a partir de la cual dos puntos consecutivos son un hueco.
 *
 * Depende del cubo con el que llegó la serie: en la serie cruda dos filas distan
 * un minuto, pero en una agregada a cubos de 90 min las cuatro filas que
 * sobreviven de cada cubo pueden distar casi hora y media sin que el bot haya
 * parado. Medir el hueco con el umbral de la serie cruda partía la curva de 30 d
 * en cientos de fragmentos.
 *
 * `cadenceMs` es la cadencia de escritura de la serie: un minuto en la de un
 * bot, cinco en la de la cartera (`PORTFOLIO_CADENCE_MS`). El criterio es el
 * mismo para las dos; lo que cambia es el paso.
 */
export function gapMsFor(bucketMs: number, cadenceMs: number = SNAPSHOT_CADENCE_MS): number {
  return Math.max(3 * cadenceMs, 2 * bucketMs);
}

/** Un punto de una serie de dinero tal y como viaja: el importe, en cadena. */
export interface SeriePunto {
  /** ms desde epoch. */
  t: number;
  v: string;
}

/** Tramo sin dato: entre `desde` y `hasta` no se midió nada. */
export interface Hueco {
  desde: number;
  hasta: number;
}

/**
 * Lo que hace falta para pintar y para rotular una serie.
 *
 * `puntos` son `number` y eso es correcto: son coordenadas, el borde de pintado.
 * Todo lo demás son cadenas calculadas con `Decimal` que no han pasado por coma
 * flotante en ningún momento.
 */
export interface SerieVista {
  /** Valores ya muestreados, listos para convertirse en coordenadas. */
  puntos: readonly number[];
  /** Eje X en ms. Misma longitud que `puntos`. */
  en: readonly number[];
  /**
   * Índices de `puntos` tras los que la línea se ROMPE.
   *
   * Un bot parado no escribe snapshots. Cruzar un hueco de tres horas con un
   * segmento recto afirma que el valor se mantuvo, y eso es mentira: nadie lo
   * midió. Es la versión en serie del mismo principio que aplica
   * `bot-overlay.ts` al no callar una orden viva que no se puede situar.
   */
  cortes: readonly number[];
  /** Los mismos huecos, como tramos de tiempo, para poder decirlos. */
  huecos: readonly Hueco[];
  primero: string;
  ultimo: string;
  minimo: string;
  maximo: string;
  /** `ultimo − primero`. */
  delta: string;
  /**
   * Peor caída desde un máximo anterior DENTRO del rango. Siempre ≥ 0.
   *
   * Es pico a valle, no `maximo − minimo`: si el mínimo ocurre antes que el
   * máximo no hay caída que contar, solo subida.
   */
  peorCaida: string;
  /** Cuándo tocó fondo esa caída; null si nunca cayó. */
  peorCaidaEn: number | null;
  minEn: number;
  maxEn: number;
  /** Puntos de entrada válidos, ya ordenados y sin repetidos. */
  total: number;
  /** Puntos que el muestreo descartó. 0 = se pinta la serie entera. */
  descartados: number;
}

export interface OpcionesVista {
  /** Tope de puntos pintados. Ver `muestreoPorExtremos`. */
  maxPuntos: number;
  /** Separación a partir de la cual dos puntos consecutivos son un hueco. Ver `gapMsFor`. */
  gapMs: number;
}

/**
 * Reduce una serie conservando los EXTREMOS de cada cubo.
 *
 * Un `slice` cada N puntos borra el pico del drawdown, y entonces el gráfico
 * miente justo sobre la cifra que se está mirando. De cada cubo se conservan el
 * primero, el mínimo, el máximo y el último, en orden temporal y sin repetir.
 *
 * Es la función que vivía privada en `packages/backtest/src/metrics.ts`,
 * generalizada con dos accesores. Se promueve aquí, no se copia: si la curva de
 * un backtest y la de un bot en vivo se muestrearan con dos implementaciones
 * distintas, una de las dos acabaría escondiendo el peor momento que la otra
 * enseña, y el usuario compararía dos gráficas que no dicen lo mismo.
 *
 * El tope: con `cubo = ceil(n / (max/4))` salen como mucho `max/4` cubos y cada
 * uno aporta hasta cuatro puntos, así que la salida no pasa de `max` siempre
 * que `max` sea múltiplo de 4 —que es como se usa— y puede quedarse corta: con
 * `max = 8` y una serie plana salen dos puntos, no ocho. Por debajo de 4 no
 * tiene sentido y se sube a 4.
 */
export function muestreoPorExtremos<T>(
  serie: readonly T[],
  max: number,
  valor: (p: T) => Decimal,
  tiempo: (p: T) => number,
): readonly T[] {
  const tope = Math.max(4, Math.floor(max));
  if (serie.length <= tope) return serie;

  const cubo = Math.ceil(serie.length / (tope / 4));
  const out: T[] = [];
  for (let i = 0; i < serie.length; i += cubo) {
    const tramo = serie.slice(i, i + cubo);
    let min = tramo[0];
    let maxP = tramo[0];
    let vMin = valor(min);
    let vMax = vMin;
    for (const p of tramo) {
      const v = valor(p);
      if (v.lt(vMin)) {
        min = p;
        vMin = v;
      }
      if (v.gt(vMax)) {
        maxP = p;
        vMax = v;
      }
    }
    const elegidos = [tramo[0], min, maxP, tramo[tramo.length - 1]]
      .filter((p, idx, arr) => arr.findIndex((q) => tiempo(q) === tiempo(p)) === idx)
      .sort((a, b) => tiempo(a) - tiempo(b));
    out.push(...elegidos);
  }
  return out;
}

/** Un punto ya convertido, para no volver a construir el `Decimal` tres veces. */
interface PuntoDecimal {
  t: number;
  v: Decimal;
}

/**
 * Ordena, deduplica y convierte una serie tal y como llega.
 *
 * La API sirve los snapshots de más nuevo a más viejo y el gráfico los quiere
 * al revés; y ante dos puntos con el mismo instante se queda el ÚLTIMO recibido,
 * que es el criterio de «la escritura más reciente manda». Los puntos cuyo
 * importe no sea un número finito se descartan en vez de lanzar: aquí no hay un
 * tick que pausar, hay una gráfica que pintar con lo que haya. El `Decimal` se
 * construye UNA vez aquí y viaja ya construido por el resto del cálculo.
 */
function normaliza(serie: readonly SeriePunto[]): PuntoDecimal[] {
  const porTiempo = new Map<number, PuntoDecimal>();
  for (const p of serie) {
    if (!Number.isFinite(p.t) || !isFiniteNum(p.v)) continue;
    porTiempo.set(p.t, { t: p.t, v: D(p.v) });
  }
  return [...porTiempo.values()].sort((a, b) => a.t - b.t);
}

/**
 * De la serie tal y como viaja a lo que se pinta y se rotula.
 *
 * Las cifras se calculan sobre la serie COMPLETA, antes de muestrear: el
 * muestreo existe para que la línea quepa, no para decidir cuál fue el mínimo.
 * Los huecos también se detectan sobre la serie completa: dos puntos
 * consecutivos del resultado muestreado pueden distar horas dentro de un tramo
 * perfectamente continuo, y medir la separación ahí inventaría huecos donde no
 * los hubo.
 *
 * Devuelve `null` con una serie vacía: no hay «vista de nada» que pintar.
 */
export function vistaDeSerie(serie: readonly SeriePunto[], opts: OpcionesVista): SerieVista | null {
  const completa = normaliza(serie);
  if (completa.length === 0) return null;

  let minimo = completa[0].v;
  let maximo = minimo;
  let minEn = completa[0].t;
  let maxEn = completa[0].t;
  let pico = minimo;
  let peorCaida = D(0);
  let peorCaidaEn: number | null = null;
  const huecos: Hueco[] = [];

  for (let i = 0; i < completa.length; i++) {
    const p = completa[i];
    if (p.v.lt(minimo)) {
      minimo = p.v;
      minEn = p.t;
    }
    if (p.v.gt(maximo)) {
      maximo = p.v;
      maxEn = p.t;
    }
    if (p.v.gt(pico)) pico = p.v;
    const caida = pico.minus(p.v);
    if (caida.gt(peorCaida)) {
      peorCaida = caida;
      peorCaidaEn = p.t;
    }
    if (i > 0 && p.t - completa[i - 1].t > opts.gapMs) {
      huecos.push({ desde: completa[i - 1].t, hasta: p.t });
    }
  }

  const muestra = muestreoPorExtremos(
    completa,
    opts.maxPuntos,
    (p) => p.v,
    (p) => p.t,
  );

  // El corte va tras el ÚLTIMO punto muestreado anterior al hueco. El punto
  // exacto donde empieza el hueco puede no haber sobrevivido al muestreo; el
  // que sí sobrevivió antes de él es donde la línea tiene que pararse. Los dos
  // arrays están ordenados, así que se recorren a la vez.
  const cortes: number[] = [];
  let j = 0;
  for (const h of huecos) {
    while (j + 1 < muestra.length && muestra[j + 1].t <= h.desde) j++;
    if (muestra[j].t <= h.desde && j < muestra.length - 1 && cortes[cortes.length - 1] !== j) {
      cortes.push(j);
    }
  }

  const primero = completa[0].v;
  const ultimo = completa[completa.length - 1].v;

  return {
    // La conversión a coma flotante de las coordenadas: aquí y en ningún otro sitio.
    puntos: muestra.map((p) => p.v.toNumber()),
    en: muestra.map((p) => p.t),
    cortes,
    huecos,
    primero: primero.toFixed(),
    ultimo: ultimo.toFixed(),
    minimo: minimo.toFixed(),
    maximo: maximo.toFixed(),
    delta: ultimo.minus(primero).toFixed(),
    peorCaida: peorCaida.toFixed(),
    peorCaidaEn,
    minEn,
    maxEn,
    total: completa.length,
    descartados: completa.length - muestra.length,
  };
}

/**
 * Índice del peor momento dentro de los puntos pintados, para marcarlo.
 *
 * El instante exacto puede no haber sobrevivido al muestreo; se marca el punto
 * pintado más cercano a él.
 */
export function indiceDePeorCaida(vista: SerieVista): number | null {
  if (vista.peorCaidaEn === null) return null;
  let mejor = -1;
  let dist = Number.POSITIVE_INFINITY;
  vista.en.forEach((t, i) => {
    const d = Math.abs(t - (vista.peorCaidaEn ?? 0));
    if (d < dist) {
      dist = d;
      mejor = i;
    }
  });
  return mejor >= 0 ? mejor : null;
}

/** Ancho del lienzo de una miniserie. Fijo: el ancho real lo pone el contenedor. */
export const TRAZO_ANCHO = 100;

export interface OpcionesTrazo {
  /** Alto del lienzo, en las unidades del `viewBox`. */
  alto: number;
  /** Rango vertical. Varias miniseries pueden compartirlo para compararse. */
  min: number;
  max: number;
  /** De `SerieVista.cortes`. */
  cortes?: readonly number[];
  /**
   * Línea de referencia que tiene que verse. En una serie de PnL es el CERO y
   * no es opcional: sin él, una curva que va de −40 a −10 se lee como una
   * remontada a un buen sitio. Amplía el rango si hace falta y es hasta donde
   * se rellena el área.
   */
  base?: number | null;
}

export interface Coordenada {
  x: number;
  y: number;
}

export interface Trazos {
  /** Atributo `d` de la línea. Un `M` por tramo continuo. */
  linea: string;
  /** Atributo `d` del relleno, cerrado contra la base o contra el suelo. */
  area: string;
  /** Coordenada Y de la base, si se pidió. */
  baseY: number | null;
  /**
   * La proyección de cada punto, en las mismas unidades que `linea`. Quien
   * quiera marcar un punto —el peor momento— lo lee de aquí y no vuelve a
   * proyectar: dos proyecciones acabarían separándose y el marcador flotaría
   * fuera de la curva.
   */
  coords: readonly Coordenada[];
}

const coord = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * Coordenadas → atributos `d` de un `<path>`.
 *
 * Geometría pura, sin Angular, y por eso vive aquí: en `apps/app` no habría
 * runner que la ejecutara. Se prueban las tres propiedades que importan —X
 * monótona, Y invertida (el máximo arriba) y un corte que emite un segundo
 * `M`—, no la cadena literal, que cambia con cada retoque visual y no delata
 * nada.
 *
 * Sin suavizado, a propósito. Una curva de Bézier inventa valores entre dos
 * puntos, y sobre dinero eso es una mentira dibujada.
 */
export function trazosDeSerie(puntos: readonly number[], opts: OpcionesTrazo): Trazos {
  const n = puntos.length;
  if (n === 0) return { linea: '', area: '', baseY: null, coords: [] };

  const base = opts.base ?? null;
  const lo = base === null ? opts.min : Math.min(opts.min, base);
  const hi = base === null ? opts.max : Math.max(opts.max, base);
  const plana = hi === lo;

  const x = (i: number): number => (n === 1 ? TRAZO_ANCHO / 2 : (i / (n - 1)) * TRAZO_ANCHO);
  const y = (v: number): number =>
    plana ? opts.alto / 2 : opts.alto - ((v - lo) / (hi - lo)) * opts.alto;
  const baseY = base === null ? null : y(base);
  const suelo = baseY ?? opts.alto;
  const coords = puntos.map((v, i) => ({ x: x(i), y: y(v) }));

  const cortes = new Set(opts.cortes ?? []);
  const tramos: number[][] = [[]];
  for (let i = 0; i < n; i++) {
    tramos[tramos.length - 1].push(i);
    if (cortes.has(i) && i < n - 1) tramos.push([]);
  }

  const linea: string[] = [];
  const area: string[] = [];
  for (const tramo of tramos) {
    if (tramo.length === 0) continue;
    const pts = tramo.map((i) => `${coord(coords[i].x)},${coord(coords[i].y)}`);
    // Un tramo de un solo punto se dibuja como segmento de longitud cero: con
    // `stroke-linecap: round` sale un punto, que es lo honesto para un dato.
    const d = pts.length === 1 ? `M${pts[0]} L${pts[0]}` : `M${pts[0]} L${pts.slice(1).join(' L')}`;
    linea.push(d);
    const x0 = coord(coords[tramo[0]].x);
    const x1 = coord(coords[tramo[tramo.length - 1]].x);
    area.push(`${d} L${x1},${coord(suelo)} L${x0},${coord(suelo)} Z`);
  }

  return { linea: linea.join(' '), area: area.join(' '), baseY, coords };
}

/**
 * Suma exacta de una lista de importes en cadena. Es lo que sustituye a los
 * `Number(a) + Number(b)` de la app: `'0.1' + '0.2'` da `'0.3'`, no
 * `0.30000000000000004`.
 */
export function sumaExacta(valores: readonly Numeric[]): string {
  return valores.reduce<Decimal>((acc, v) => acc.plus(D(v)), D(0)).toFixed();
}

// ─── Analítica pequeña ──────────────────────────────────────────────────────
//
// Las decisiones que producen una cifra de dinero o un porcentaje que el usuario
// lee. Están aquí y no en la página por la misma razón que todo lo demás del
// fichero: en `apps/app` no hay runner, y estas son las cifras que se miran para
// decidir si un bot funciona.

/** Lo mínimo de un ciclo para resumirlo. Es la forma de `bot_cycles` que viaja a la app. */
export interface CicloResumible {
  seq: number;
  opened_at: string;
  closed_at: string | null;
  realized_pnl: Numeric;
  fees: Numeric;
}

export interface ResumenDeCiclos {
  /** Uno por ciclo cerrado, en orden de cierre, para las barras. Coordenadas. */
  barras: readonly number[];
  cerrados: number;
  enVerde: number;
  /** 0-100, como cadena con dos decimales; null sin ciclos cerrados. */
  aciertoPct: string | null;
  /** Media del resultado por ciclo. */
  beneficioMedio: string | null;
  /** Duración mediana de un ciclo cerrado, en ms. */
  duracionMedianaMs: number | null;
  /** Comisiones acumuladas de los ciclos cerrados. */
  comisiones: string;
  /** Resultado neto acumulado de los ciclos cerrados. */
  neto: string;
}

/**
 * Los ciclos cerrados, resumidos. La mediana y no la media para la duración:
 * un ciclo de tres días entre cuarenta de tres horas no debería mover la cifra
 * que el usuario lee como «lo normal».
 *
 * Solo entran los cerrados: el ciclo vivo ya tiene su propia ficha y su
 * resultado todavía no es un resultado.
 */
export function resumenDeCiclos(ciclos: readonly CicloResumible[]): ResumenDeCiclos {
  const cerrados = ciclos.filter((c) => c.closed_at !== null).sort((a, b) => a.seq - b.seq);

  const enVerde = cerrados.filter((c) => D(c.realized_pnl).gt(0)).length;
  const duraciones = cerrados
    .map((c) => Date.parse(c.closed_at ?? '') - Date.parse(c.opened_at))
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);

  const neto = sumaExacta(cerrados.map((c) => c.realized_pnl));
  return {
    // Coordenadas de las barras: la conversión a number está solo aquí.
    barras: cerrados.map((c) => D(c.realized_pnl).toNumber()),
    cerrados: cerrados.length,
    enVerde,
    aciertoPct: cerrados.length ? D(enVerde).div(cerrados.length).mul(100).toFixed(2) : null,
    beneficioMedio: cerrados.length ? D(neto).div(cerrados.length).toFixed(2) : null,
    duracionMedianaMs: duraciones.length ? duraciones[Math.floor(duraciones.length / 2)] : null,
    comisiones: sumaExacta(cerrados.map((c) => c.fees)),
    neto,
  };
}

/**
 * Qué parte de lo capturado se llevan las comisiones, en % con un decimal.
 *
 * «Capturado» es el neto más las comisiones: lo que el bot sacó antes de que el
 * exchange cobrara. Sin captura positiva o sin comisiones no hay porcentaje que
 * tenga sentido y se devuelve null.
 */
export function costeDeComisionesPct(neto: Numeric, comisiones: Numeric): string | null {
  const bruto = D(neto).plus(comisiones);
  if (bruto.lte(0) || D(comisiones).lte(0)) return null;
  return D(comisiones).div(bruto).mul(100).toFixed(1);
}

export interface RepartoDeEjecucion {
  maker: number;
  taker: number;
  /** 0-100 con un decimal; null sin ejecuciones. */
  makerPct: string | null;
}

/** Cuánto se ejecutó como maker: la cifra que decide si un market maker funciona. */
export function repartoDeEjecucion(mm: {
  makerFills: number;
  takerFills: number;
}): RepartoDeEjecucion {
  const total = mm.makerFills + mm.takerFills;
  return {
    maker: mm.makerFills,
    taker: mm.takerFills,
    makerPct: total > 0 ? D(mm.makerFills).div(total).mul(100).toFixed(1) : null,
  };
}

/**
 * Fracción de los puntos con POSICIÓN abierta, en % sin decimales; null sin puntos.
 *
 * Cuenta posición, no órdenes en el libro. La pantalla lo rotulaba «En mercado»,
 * que se lee justo al revés: un market maker con dos cotizaciones vivas y nada
 * ejecutado leía «En mercado 0 %» y parecía una avería (spec 035). Ahora la app
 * lo llama «Con posición».
 */
export function enMercadoPct(cantidades: readonly Numeric[]): string | null {
  if (cantidades.length === 0) return null;
  const abiertos = cantidades.filter((q) => !D(q).isZero()).length;
  return D(abiertos).div(cantidades.length).mul(100).toFixed(0);
}

/** Lo mínimo de una posición para repartir la exposición. */
export interface PosicionRepartible {
  symbol: string;
  /** Firmada; se usa en valor absoluto. */
  qty: Numeric;
  /** Precio medio de entrada; null sin posición. */
  price: Numeric | null;
}

export interface RepartoPorSimbolo {
  /** Exposición total: Σ |cantidad| × precio medio, exacta. */
  total: string;
  /** De mayor a menor. `pct` es una coordenada de barra, 0-100. */
  partes: readonly { symbol: string; pct: number }[];
}

/**
 * Reparto de la exposición por símbolo. Cuatro bots pueden parecer
 * diversificados y ser cuatro veces BTC en tres exchanges: esto es lo que lo
 * enseña. La suma es exacta; el porcentaje de cada parte es una coordenada.
 */
export function repartoPorSimbolo(posiciones: readonly PosicionRepartible[]): RepartoPorSimbolo {
  const porSimbolo = new Map<string, Decimal>();
  let total = D(0);
  for (const p of posiciones) {
    const v = D(p.qty)
      .abs()
      .mul(p.price ?? 0);
    if (v.isZero()) continue;
    total = total.plus(v);
    porSimbolo.set(p.symbol, (porSimbolo.get(p.symbol) ?? D(0)).plus(v));
  }
  const partes = total.lte(0)
    ? []
    : [...porSimbolo.entries()]
        .map(([symbol, v]) => ({ symbol, pct: v.div(total).mul(100).toNumber() }))
        .sort((a, b) => b.pct - a.pct);
  return { total: total.toFixed(), partes };
}
