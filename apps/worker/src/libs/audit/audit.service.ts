import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import { DbService } from '../db';

/** Lo que el motor puede registrar. Deliberadamente pocos campos. */
export interface WorkerAuditEntry {
  action: string;
  outcome?: AuditOutcome;
  severity?: EventSeverity;
  botId?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}

/**
 * Bitacora del motor.
 *
 * Deliberadamente MUCHO mas simple que la de la API, y no por descuido: el
 * buffer de aquella existe para que la escritura no se cruce en el camino de la
 * peticion de un usuario, y el worker no tiene peticiones. Aqui se registran
 * unos pocos eventos por vida de proceso, asi que agruparlos no ahorraria nada
 * y si añadiria una ventana en la que perderlos.
 *
 * Lo que NO entra aqui: nada por ciclo de reconciliacion. Con el tick de 15 s y
 * 250 bots serian 1,44 millones de filas al dia por worker, y la purga tiene un
 * techo muy por debajo de eso. La vida de cada bot ya la cuenta `bot_events`.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  readonly enabled: boolean;
  /** Identifica al proceso en las filas: con varias replicas hace falta. */
  private readonly workerId = `worker-${process.pid}`;

  constructor(
    private readonly db: DbService,
    config: ConfigService,
  ) {
    this.enabled = config.get('AUDIT_LOG_ENABLE') === 'true';
    if (!this.enabled) {
      this.logger.log('AUDIT_LOG_ENABLE apagado: el motor no registra actividad.');
    }
  }

  /**
   * Registra sin que el llamante tenga que esperar ni protegerse.
   *
   * Devuelve void a proposito: nadie puede `await`earlo por accidente, asi que
   * la bitacora es estructuralmente incapaz de retrasar el motor. Si la base
   * esta caida, se queda en un aviso del log — un bot que deja de operar porque
   * no puede escribir una linea de auditoria seria el criterio equivocado.
   */
  record(entry: WorkerAuditEntry): void {
    if (!this.enabled) return;
    void this.db.activityLog
      .create({
        data: {
          actor: ActorKind.WORKER,
          actor_id: this.workerId,
          bot_id: entry.botId ?? null,
          action: entry.action.slice(0, 64),
          severity: entry.severity ?? EventSeverity.INFO,
          outcome: entry.outcome ?? AuditOutcome.OK,
          message: entry.message ?? null,
          meta: (entry.meta ?? null) as never,
        },
      })
      .catch((e: unknown) =>
        this.logger.warn(
          `No se pudo registrar ${entry.action}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  }
}
