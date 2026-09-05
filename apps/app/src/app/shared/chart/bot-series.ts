import {
  D,
  SERIES_POINTS,
  SNAPSHOT_CADENCE_MS,
  gapMsFor,
  vistaDeSerie,
  type SerieVista,
} from '@crypton/shared';
import type { BotSnapshot } from '../../core/models';
import { bucketOf } from './bot-overlay';

/**
 * Del estado de un bot a lo que se pinta.
 *
 * Es el mismo papel que cumple `bot-overlay.ts` al lado: traducir el dominio a
 * la forma que entienden los componentes de dibujo, sin importar ninguno de los
 * dos motores. La aritmetica y la analitica viven en `@crypton/shared` y tienen
 * tests; aqui solo se eligen columnas y se ponen nombres.
 *
 * Los snapshots se escriben una vez por minuto (`SNAPSHOT_CADENCE_MS`) y la API
 * los sirve de mas nuevo a mas viejo. Sin rango, la ruta da 500 filas —8 h
 * 20 min—; con rango, el servidor agrega en cubos y conserva cuatro filas por
 * cubo. `ventanaDe()` dice lo que la serie cubre de verdad para que la pantalla
 * lo rotule y no prometa un dia que no tiene.
 */

/**
 * La serie del resultado acumulado.
 *
 * Se llama asi y no «equity» a proposito: `bot_snapshots.equity` es
 * `realized_pnl_acc + unrealized_pnl` (`bot-store.ts`), es decir, PnL, no
 * patrimonio. Rotularlo «equity» heredaria el vocabulario del sector con otro
 * significado. La `base` de la vista es el CERO, que no es opcional en una
 * serie de resultado.
 *
 * `bucketMs` es el cubo con el que llego la serie: la cadencia para la serie
 * cruda, y el cubo del servidor para un rango. De el sale el umbral de hueco;
 * con el de la serie cruda, una serie de 30 d en cubos de 90 min se partia en
 * cientos de fragmentos sin que el bot hubiera parado.
 */
export function serieDeResultado(
  snapshots: readonly BotSnapshot[],
  bucketMs: number = SNAPSHOT_CADENCE_MS,
): SerieVista | null {
  return vistaDeSerie(
    snapshots.map((s) => ({ t: Date.parse(s.taken_at), v: s.equity })),
    { maxPuntos: SERIES_POINTS, gapMs: gapMsFor(bucketMs) },
  );
}

/** Ventana que cubre de verdad la serie recibida, en ms; 0 si no hay dos puntos. */
export function ventanaDe(vista: SerieVista | null): number {
  if (!vista || vista.en.length < 2) return 0;
  return vista.en[vista.en.length - 1] - vista.en[0];
}

/**
 * La miniserie de la tarjeta, de cadenas a coordenadas.
 *
 * Memorizada por la IDENTIDAD del array: la lista se repinta con cada vuelta de
 * la deteccion de cambios (scroll, toque, evento), y convertir veinte tarjetas
 * por vuelta —y entregar a `ui-spark` un array nuevo cada vez, que le obliga a
 * rehacer sus trazos— era trabajo por nada. El array cambia de identidad solo
 * cuando la lista se refresca, y entonces si se convierte otra vez.
 */
const cacheDeSpark = new WeakMap<readonly string[], number[]>();

export function puntosDeSpark(spark: readonly string[] | undefined): number[] {
  if (!spark) return [];
  const hecho = cacheDeSpark.get(spark);
  if (hecho) return hecho;
  // La conversion del borde de pintado; la lista no suma ni resta con esto.
  const puntos = spark.map((v) => D(v).toNumber()).filter((v) => Number.isFinite(v));
  cacheDeSpark.set(spark, puntos);
  return puntos;
}

/** Un snapshot por vela: el último del cubo, con el instante de SU vela. */
export interface MuestraPorVela {
  t: number;
  s: BotSnapshot;
}

/**
 * La serie del bot casada a las velas del gráfico (spec 005, R-3 y R-5).
 *
 * El motor gráfico comparte UNA escala de tiempo entre todas las series: un
 * punto en un instante que no es el de ninguna vela crea un índice nuevo y las
 * velas se separan con huecos. Así que cada snapshot se lleva al inicio de su
 * vela —con las velas cargadas mandando, ver `bucketOf`— y de cada vela queda el
 * último. Lo anterior a la primera vela cargada se descarta: no hay barra en la
 * que ponerlo.
 */
export function muestrasPorVela(
  snapshots: readonly BotSnapshot[],
  spanMs: number,
  barsMs: readonly number[],
): MuestraPorVela[] {
  if (barsMs.length === 0) return [];
  const porCubo = new Map<number, { at: number; s: BotSnapshot }>();
  for (const s of snapshots) {
    const at = Date.parse(s.taken_at);
    if (!Number.isFinite(at) || at < barsMs[0]) continue;
    const cubo = bucketOf(at, spanMs, barsMs);
    const previo = porCubo.get(cubo);
    if (!previo || previo.at < at) porCubo.set(cubo, { at, s });
  }
  return [...porCubo.entries()].sort((a, b) => a[0] - b[0]).map(([t, { s }]) => ({ t, s }));
}
