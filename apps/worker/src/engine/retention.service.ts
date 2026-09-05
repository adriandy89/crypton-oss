import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbService } from '../libs';
import { LeaseService } from './lease.service';

/** Ventana del cerrojo: más que lo que puede tardar una purga completa. */
const LOCK_MS = 55 * 60_000;

/** Filas por lote. Un DELETE gigante bloquea la tabla y satura el WAL. */
const BATCH = 5_000;

/** Tope de lotes por pasada, para que una purga no monopolice la base. */
const MAX_BATCHES = 40;

/**
 * Purga de las tablas de serie temporal.
 *
 * `bot_snapshots`, `bot_events`, `activity_log` y —desde el spec 003—
 * `portfolio_snapshots` crecen sin parar y nadie los limpiaba. Con mil
 * bots latiendo, y aun escribiendo solo una fila por minuto, son un millón y
 * medio de snapshots al día; a los cien mil bots que persigue esta plataforma,
 * la tabla deja de caber en memoria y las consultas de la app —que leen los
 * últimos snapshots de un bot— empiezan a ir a disco.
 *
 * Lo que se conserva:
 *
 * · Los snapshots son para pintar gráficas y calcular ROI reciente. El
 *   histórico de verdad —lo que de verdad pasó— vive en `bot_cycles`,
 *   `bot_orders` y `bot_fills`, que NO se tocan aquí.
 *
 * · De los eventos se conservan más los graves: un FILL de hace tres meses no
 *   le importa a nadie, pero un RISK_GUARD_TRIPPED o un AUTH_ERROR son
 *   justamente lo que se va a mirar cuando algo salga mal.
 *
 * Corre detrás de un cerrojo porque `@Cron` dispara en TODAS las réplicas, y
 * varias purgando a la vez competirían por las mismas filas.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly db: DbService,
    private readonly leases: LeaseService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purge(): Promise<void> {
    const snapshotDays = Number(this.config.get('RETENTION_SNAPSHOT_DAYS', 30));
    const eventDays = Number(this.config.get('RETENTION_EVENT_DAYS', 90));
    const criticalDays = Number(this.config.get('RETENTION_CRITICAL_EVENT_DAYS', 365));
    const auditDays = Number(this.config.get('RETENTION_AUDIT_DAYS', 180));
    const portfolioDays = Number(this.config.get('RETENTION_PORTFOLIO_DAYS', 365));
    // Todas entran en la guarda: sin eso, un despliegue con las demás purgas
    // desactivadas se saltaría también la que quedara EN SILENCIO, y esa tabla
    // crecería sin techo sin que nada lo dijera.
    if (snapshotDays <= 0 && eventDays <= 0 && auditDays <= 0 && portfolioDays <= 0) return;

    if (!(await this.leases.tryLock('retention', LOCK_MS))) return;

    try {
      const snapshots = await this.purgeSnapshots(snapshotDays);
      const events = await this.purgeEvents(eventDays, criticalDays);
      // Se purga aunque AUDIT_LOG_ENABLE esté apagado: si se desactivó la
      // función, las filas viejas siguen teniendo que desaparecer.
      const audit = await this.purgeActivityLog(auditDays, criticalDays);
      const portfolio = await this.purgePortfolio(portfolioDays);
      if (snapshots + events + audit + portfolio > 0) {
        this.logger.log(
          `Purga: ${snapshots} snapshot(s), ${events} evento(s), ${audit} registro(s) de actividad y ${portfolio} fila(s) de cartera.`,
        );
      }
    } catch (e) {
      this.logger.warn(`Purga fallida: ${(e as Error).message}`);
    }
  }

  /**
   * Purga la bitácora de actividad, con el mismo criterio por gravedad que
   * `bot_events`: lo grave se conserva mucho más. Un `http.error.404` de hace
   * seis meses no le importa a nadie; un alta de credencial o un borrado de
   * cuenta es justo lo que se reclama mucho después.
   *
   * La `ip` es un dato personal, y esta purga es lo que hace defendible
   * guardarla.
   */
  private async purgeActivityLog(days: number, criticalDays: number): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const criticalCutoff = new Date(Date.now() - criticalDays * 86_400_000);
    return this.deleteInBatches(
      () => this.db.$executeRaw`
        DELETE FROM activity_log
        WHERE id IN (
          SELECT id FROM activity_log
          WHERE (severity <> 'CRITICAL' AND created_at < ${cutoff})
             OR (severity =  'CRITICAL' AND created_at < ${criticalCutoff})
          LIMIT ${BATCH}
        )`,
    );
  }

  private async purgeSnapshots(days: number): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    return this.deleteInBatches(
      () => this.db.$executeRaw`
        DELETE FROM bot_snapshots
        WHERE id IN (
          SELECT id FROM bot_snapshots WHERE taken_at < ${cutoff} LIMIT ${BATCH}
        )`,
    );
  }

  /**
   * Purga de la curva de la cartera (spec 003). Un año por defecto: es la
   * ventana más larga que ofrece el selector, y a 105 filas al día por usuario
   * y red cabe de sobra. Es la misma tabla para todas las gravedades: aquí no
   * hay nada «grave» que conservar más, solo una curva.
   */
  private async purgePortfolio(days: number): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    return this.deleteInBatches(
      () => this.db.$executeRaw`
        DELETE FROM portfolio_snapshots
        WHERE id IN (
          SELECT id FROM portfolio_snapshots WHERE taken_at < ${cutoff} LIMIT ${BATCH}
        )`,
    );
  }

  private async purgeEvents(days: number, criticalDays: number): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const criticalCutoff = new Date(Date.now() - criticalDays * 86_400_000);
    return this.deleteInBatches(
      () => this.db.$executeRaw`
        DELETE FROM bot_events
        WHERE id IN (
          SELECT id FROM bot_events
          WHERE (severity IN ('DEBUG', 'INFO', 'WARN') AND created_at < ${cutoff})
             OR (severity IN ('ERROR', 'CRITICAL') AND created_at < ${criticalCutoff})
          LIMIT ${BATCH}
        )`,
    );
  }

  /**
   * Borra por lotes hasta agotar o hasta el tope.
   *
   * De golpe sería un DELETE de millones de filas: bloquea la tabla, hincha el
   * WAL y deja a los bots esperando por escribir su siguiente snapshot. Por
   * lotes, cada uno dura milisegundos y entre medias cabe todo lo demás.
   */
  private async deleteInBatches(run: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const deleted = await run();
      total += deleted;
      if (deleted < BATCH) break;
    }
    return total;
  }
}
