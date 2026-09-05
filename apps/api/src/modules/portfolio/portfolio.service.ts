import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PortfolioSnapshotModel } from '@crypton/db';
import {
  PORTFOLIO_CADENCE_MS,
  PORTFOLIO_RANGE_MS,
  SERIES_POINTS,
  alMinuto,
  bucketMsFor,
  type PortfolioEquityPoint,
  type PortfolioEquitySeries,
  type PortfolioRange,
} from '@crypton/shared';
import { CacheService, DbService } from 'src/libs';

/**
 * La curva agregada de la cartera (spec 003), leída de `portfolio_snapshots`.
 *
 * Es el mismo SQL que `BotSeriesService.inRange` del 002 sobre otra tabla: se
 * conservan hasta cuatro filas por cubo —primera, mínima, máxima y última—
 * para que el peor momento sobreviva al dibujo por construcción. Solo lectura,
 * solo esta tabla, parámetros por `Prisma.sql`, y filtrado SIEMPRE por el
 * usuario de la sesión: no hay forma de pedir la cartera de otro.
 *
 * La fila la escribe el worker cada cinco minutos (`PORTFOLIO_CADENCE_MS`); la
 * respuesta lleva el cubo y la cadencia para que la app rompa la línea en los
 * huecos con el mismo criterio que la curva de un bot (`gapMsFor`), en vez de
 * recibir una lista de huecos calculada con otro.
 */

const CACHE_TTL_S = 60;

/** Filas que sobreviven de cada cubo: primera, mínima, máxima y última. */
const FILAS_POR_CUBO = 4;

/** Retención por defecto de la tabla, la misma que el worker (`RETENTION_PORTFOLIO_DAYS`). */
const RETENTION_DAYS_DEFAULT = 365;

@Injectable()
export class PortfolioService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  async equity(
    userId: string,
    range: PortfolioRange,
    testnet: boolean,
    nowMs = Date.now(),
  ): Promise<PortfolioEquitySeries> {
    const hasta = alMinuto(nowMs);
    const desde = hasta - PORTFOLIO_RANGE_MS[range];
    const bucketMs = bucketMsFor(desde, hasta, Math.ceil(SERIES_POINTS / FILAS_POR_CUBO));
    const retentionFrom = this.retentionFrom(nowMs);

    const clave = `portfolio:equity:${userId}:${testnet ? 't' : 'm'}:${range}:${hasta}`;
    const cacheado = await this.cache.get<PortfolioEquitySeries>(clave);
    if (cacheado) return cacheado;

    const filas = await this.db.$queryRaw<PortfolioSnapshotModel[]>(Prisma.sql`
      WITH base AS (
        SELECT id, pnl, taken_at,
               floor(extract(epoch FROM taken_at) * 1000 / ${bucketMs}::double precision) AS cubo
        FROM portfolio_snapshots
        WHERE user_id = ${userId}
          AND testnet = ${testnet}
          AND taken_at >= ${new Date(desde)}
          AND taken_at < ${new Date(hasta)}
      ),
      marcadas AS (
        SELECT id,
               row_number() OVER (PARTITION BY cubo ORDER BY taken_at ASC) AS r_ini,
               row_number() OVER (PARTITION BY cubo ORDER BY taken_at DESC) AS r_fin,
               row_number() OVER (PARTITION BY cubo ORDER BY pnl ASC, taken_at ASC) AS r_min,
               row_number() OVER (PARTITION BY cubo ORDER BY pnl DESC, taken_at ASC) AS r_max
        FROM base
      )
      SELECT s.*
      FROM portfolio_snapshots s
      WHERE s.id IN (SELECT id FROM marcadas WHERE r_ini = 1 OR r_fin = 1 OR r_min = 1 OR r_max = 1)
      ORDER BY s.taken_at ASC
    `);

    const serie: PortfolioEquitySeries = {
      range,
      testnet,
      from: desde,
      to: hasta,
      bucketMs,
      cadenceMs: PORTFOLIO_CADENCE_MS,
      retentionFrom,
      points: filas.map(punto),
    };
    await this.cache.set(clave, serie, CACHE_TTL_S);
    return serie;
  }

  /**
   * Desde cuándo puede haber dato. La retención la aplica el worker con la
   * misma variable; aquí solo se declara para que la app no pinte plano lo que
   * no se midió. `null` si la purga está desactivada (0).
   */
  private retentionFrom(nowMs: number): number | null {
    const dias = Number(this.config.get('RETENTION_PORTFOLIO_DAYS', RETENTION_DAYS_DEFAULT));
    if (!Number.isFinite(dias) || dias <= 0) return null;
    return nowMs - dias * 86_400_000;
  }
}

/** De la fila de Prisma al punto del contrato: dinero en cadena, tiempo en ms. */
function punto(f: PortfolioSnapshotModel): PortfolioEquityPoint {
  return {
    t: f.taken_at.getTime(),
    realized: f.realized.toString(),
    unrealized: f.unrealized.toString(),
    pnl: f.pnl.toString(),
    invested: f.invested.toString(),
    exposure: f.exposure.toString(),
    bots: f.bots,
  };
}
