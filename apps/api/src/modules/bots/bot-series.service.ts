import { Injectable } from '@nestjs/common';
import { Prisma, type BotSnapshotModel } from '@crypton/db';
import { SERIES_POINTS, alMinuto, bucketMsFor } from '@crypton/shared';
import { CacheService, DbService } from 'src/libs';

/**
 * Las series temporales de los bots, agregadas en SQL.
 *
 * Es el primer SQL crudo de la API, y esta aislado aqui a proposito: solo
 * lectura, solo `bot_snapshots`, y con parametros por `Prisma.sql`, nunca por
 * concatenacion. Existe porque Prisma no sabe hacer «el ultimo de cada cubo» ni
 * «los extremos de cada cubo», y traerse 43 200 filas al proceso para tirar
 * 42 700 no es una opcion en un endpoint que se refresca con cada evento.
 *
 * Dos consultas:
 *
 *   - `inRange`: la serie de UN bot en un rango, con hasta cuatro filas por cubo
 *     —primera, minima, maxima y ultima—. Es el mismo criterio que
 *     `muestreoPorExtremos` en `@crypton/shared`: el peor momento sobrevive al
 *     dibujo por construccion, no por suerte. Devuelve filas COMPLETAS de
 *     `bot_snapshots`, asi que el cliente no necesita un tipo nuevo.
 *   - `sparks`: la miniserie de N bots a la vez, un punto por cubo (el ultimo).
 *     Es lo que permite una miniserie por tarjeta en la lista: una peticion por
 *     fila serian veinte, y ~3,4 MB para veinte rectangulos de 40 px.
 *
 * La propiedad del bot NO se comprueba aqui: la comprueba quien llama
 * (`BotsService.assertOwn`) antes de pedir nada. Este servicio recibe ids ya
 * autorizados y no debe exponerse a ningun controlador sin ese paso delante.
 *
 * Todo con cache de un minuto en Redis, que es la cadencia de escritura de la
 * tabla: pedirlo mas a menudo devuelve lo mismo.
 */

/** Puntos de la miniserie: uno por hora en las ultimas 24 h. */
export const SPARK_POINTS = 24;
export const SPARK_WINDOW_MS = 24 * 3_600_000;

const CACHE_TTL_S = 60;

/** Filas que sobreviven de cada cubo: primera, minima, maxima y ultima. */
const FILAS_POR_CUBO = 4;

interface SparkRow {
  bot_id: string;
  equity: { toString(): string };
}

@Injectable()
export class BotSeriesService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
  ) {}

  /**
   * La serie de un bot entre `fromMs` y `toMs`, en `points` filas como mucho.
   *
   * El cubo se dimensiona para `points / 4` cubos porque de cada uno salen hasta
   * cuatro filas: la primera y la ultima dicen por donde iba la curva, la minima
   * y la maxima son las que un muestreo cada N borraria y las que el usuario ha
   * abierto la pantalla para ver. Dimensionarlo para `points` cubos devolvia
   * hasta cuatro veces lo pedido. De un cubo con una sola fila sale una. El
   * resultado va de mas nuevo a mas viejo, como el endpoint de siempre, y el
   * cliente lo ordena.
   */
  async inRange(
    botId: string,
    fromMs: number,
    toMs: number,
    points = SERIES_POINTS,
  ): Promise<BotSnapshotModel[]> {
    const hasta = alMinuto(toMs);
    const desde = alMinuto(fromMs);
    if (hasta <= desde) return [];
    const bucket = bucketMsFor(desde, hasta, Math.ceil(points / FILAS_POR_CUBO));
    const clave = `bots:series:${botId}:${desde}:${hasta}:${bucket}`;
    const cacheado = await this.cache.get<BotSnapshotModel[]>(clave);
    if (cacheado) return cacheado;

    // Se eligen los ids en las CTE y se proyecta la tabla entera una sola vez:
    // asi las dos ramas del endpoint —con rango y sin el— sirven la misma
    // forma, y una columna nueva en `bot_snapshots` aparece en las dos.
    const filas = await this.db.$queryRaw<BotSnapshotModel[]>(Prisma.sql`
      WITH base AS (
        SELECT id, equity, taken_at,
               floor(extract(epoch FROM taken_at) * 1000 / ${bucket}::double precision) AS cubo
        FROM bot_snapshots
        WHERE bot_id = ${botId}
          AND taken_at >= ${new Date(desde)}
          AND taken_at < ${new Date(hasta)}
      ),
      marcadas AS (
        SELECT id,
               row_number() OVER (PARTITION BY cubo ORDER BY taken_at ASC) AS r_ini,
               row_number() OVER (PARTITION BY cubo ORDER BY taken_at DESC) AS r_fin,
               row_number() OVER (PARTITION BY cubo ORDER BY equity ASC, taken_at ASC) AS r_min,
               row_number() OVER (PARTITION BY cubo ORDER BY equity DESC, taken_at ASC) AS r_max
        FROM base
      )
      SELECT s.*
      FROM bot_snapshots s
      WHERE s.id IN (SELECT id FROM marcadas WHERE r_ini = 1 OR r_fin = 1 OR r_min = 1 OR r_max = 1)
      ORDER BY s.taken_at DESC
    `);

    await this.cache.set(clave, filas, CACHE_TTL_S);
    return filas;
  }

  /**
   * Miniserie de resultado de varios bots, un punto por hora, ultimas 24 h.
   *
   * Devuelve el `equity` del ULTIMO snapshot de cada hora, en orden temporal,
   * por bot. Un bot sin snapshots en la ventana no aparece en el mapa, y la
   * pantalla no le pinta miniserie: es lo honesto, no un cero plano.
   */
  async sparks(botIds: readonly string[], nowMs = Date.now()): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (botIds.length === 0) return out;

    const hasta = alMinuto(nowMs);
    const desde = hasta - SPARK_WINDOW_MS;
    const bucket = SPARK_WINDOW_MS / SPARK_POINTS;
    const ids = [...botIds].sort();
    const clave = `bots:sparks:${hasta}:${ids.join(',')}`;
    const cacheado = await this.cache.get<Record<string, string[]>>(clave);
    if (cacheado) return new Map(Object.entries(cacheado));

    const filas = await this.db.$queryRaw<SparkRow[]>(Prisma.sql`
      SELECT DISTINCT ON (bot_id, cubo) bot_id, equity
      FROM (
        SELECT bot_id, equity, taken_at,
               floor(extract(epoch FROM taken_at) * 1000 / ${bucket}::double precision) AS cubo
        FROM bot_snapshots
        WHERE bot_id IN (${Prisma.join(ids)})
          AND taken_at >= ${new Date(desde)}
          AND taken_at < ${new Date(hasta)}
      ) s
      ORDER BY bot_id, cubo, taken_at DESC
    `);

    // Postgres ya devuelve las filas ordenadas por bot y por cubo ascendente:
    // el DISTINCT ON exige ese orden, asi que agrupar es concatenar.
    for (const f of filas) {
      const lista = out.get(f.bot_id) ?? [];
      lista.push(f.equity.toString());
      out.set(f.bot_id, lista);
    }

    await this.cache.set(clave, Object.fromEntries(out), CACHE_TTL_S);
    return out;
  }
}
