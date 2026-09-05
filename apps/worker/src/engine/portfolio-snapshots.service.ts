import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@crypton/db';
import { PORTFOLIO_CADENCE_MS } from '@crypton/shared';
import { DbService } from '../libs';
import { LeaseService } from './lease.service';
import { aggregatePortfolio, type PortfolioSource } from './portfolio-aggregate';

/**
 * Un snapshot de bot cuenta como vivo si tiene menos de esto: dos cadencias del
 * cron. Un bot parado con posición sigue escribiendo su snapshot al parar y no
 * vuelve a escribir, así que a los diez minutos deja de sumar; es lo que quiere
 * el spec (003, R-3 y R-4): la fila dice lo que hay vivo AHORA y el pasado no se
 * reescribe.
 */
export const FRESH_MS = 2 * PORTFOLIO_CADENCE_MS;

/**
 * Cerrojo: menos que la cadencia, para que la pasada siguiente pueda cogerlo
 * aunque la anterior muriera sin soltarlo; mucho más que lo que tarda una
 * pasada (una consulta y un `createMany`).
 */
const LOCK_MS = PORTFOLIO_CADENCE_MS - 60_000;

/**
 * La fila de la cartera, cada cinco minutos (spec 003).
 *
 * Es la primera escritura nueva del worker desde el 001, y por eso va así:
 *
 * · Fuera del tick. N bots de un usuario escribirían N veces la misma fila cada
 *   minuto, y metería una escritura más en el camino que coloca órdenes. Aquí
 *   es un cron aparte que lee lo que los ticks ya escribieron.
 * · Tras `tryLock`, como la purga: `@Cron` dispara en TODAS las réplicas y sin
 *   cerrojo habría una fila por réplica.
 * · Con interruptor por variable (`PORTFOLIO_SNAPSHOTS_ENABLE`, por defecto
 *   encendido) para poder apagarlo sin redesplegar.
 * · Un fallo se registra y no se propaga: nada de lo que pase aquí toca a
 *   ningún runner.
 *
 * La consulta trae el ÚLTIMO snapshot de cada bot real con dato reciente y a
 * quién pertenece; la aritmética es de `aggregatePortfolio`, que es pura y tiene
 * su spec. Los bots borrados no tienen snapshots (`onDelete: Cascade`), así que
 * dejan de sumar desde el borrado y ninguna fila anterior cambia.
 */
@Injectable()
export class PortfolioSnapshotsService {
  private readonly logger = new Logger(PortfolioSnapshotsService.name);

  constructor(
    private readonly db: DbService,
    private readonly leases: LeaseService,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    if (this.config.get('PORTFOLIO_SNAPSHOTS_ENABLE', 'true') === 'false') return;
    if (!(await this.leases.tryLock('portfolio-snapshots', LOCK_MS))) return;

    try {
      const filas = await this.snapshot();
      if (filas > 0) this.logger.debug(`Cartera: ${filas} fila(s) escrita(s).`);
    } catch (e) {
      this.logger.warn(`Snapshot de cartera fallido: ${(e as Error).message}`);
    }
  }

  /**
   * Una pasada: lee, agrega, escribe. Devuelve cuántas filas escribió. Separado
   * de `tick()` para poder probarlo sin cerrojo ni reloj.
   */
  async snapshot(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - FRESH_MS);
    // `DISTINCT ON (s.bot_id)` con ese ORDER BY es «la última fila de cada bot».
    // El filtro de simulados va también en el SQL para no traer filas que la
    // agregación va a tirar; `aggregatePortfolio` lo repite por si acaso, y ese
    // es el que tiene test.
    const fuentes = await this.db.$queryRaw<PortfolioSource[]>(Prisma.sql`
      SELECT DISTINCT ON (s.bot_id)
             b.user_id, a.testnet, s.bot_id, b.dry_run, b.total_investment,
             s.realized_pnl_acc, s.unrealized_pnl, s.position_qty, s.average_entry
      FROM bot_snapshots s
      JOIN bots b ON b.id = s.bot_id
      JOIN exchange_accounts a ON a.id = b.exchange_account_id
      WHERE s.taken_at >= ${cutoff}
        AND b.dry_run = false
      ORDER BY s.bot_id, s.taken_at DESC
    `);

    const filas = aggregatePortfolio(fuentes);
    if (filas.length === 0) return 0;

    await this.db.portfolioSnapshot.createMany({
      data: filas.map((f) => ({ ...f, taken_at: now })),
    });
    return filas.length;
  }
}
