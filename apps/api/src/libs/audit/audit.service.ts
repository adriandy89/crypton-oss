import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventSeverity } from '@crypton/shared';
import { DbService } from '../db';
import type { AuditEntry } from './audit.types';

/** Cada cuánto se vuelca el buffer, y cuántas filas lo vuelcan antes de tiempo. */
const FLUSH_MS = 1_000;
const FLUSH_SIZE = 200;

/**
 * Tope del buffer. Si la base está caída y las entradas se acumulan, se
 * descartan las MÁS ANTIGUAS y se avisa una vez. Un registro de auditoría que
 * tumba el proceso por consumir memoria es peor que un registro incompleto.
 */
const MAX_BUFFER = 5_000;

/**
 * Bitácora de actividad.
 *
 * Dos reglas que gobiernan todo lo de aquí:
 *
 * 1. **Un fallo de la bitácora nunca puede afectar a la petición del usuario.**
 *    Nada de lo que hace este servicio se propaga: los errores se registran y
 *    se tragan. Si esto se cae, el usuario sigue pudiendo mandar un PANIC.
 *
 * 2. **Nada entra aquí que no haya sido declarado.** El servicio no ve DTOs ni
 *    cuerpos de petición: recibe objetos ya construidos campo a campo. Quien
 *    los construye es el interceptor, con la lista blanca de `@Audit()`.
 */
@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);

  /**
   * Interruptor leído UNA vez.
   *
   * Mismo patrón que `SWAGGER_ENABLE`: comparación estricta contra la cadena
   * `'true'`, así que cualquier otro valor —o su ausencia— deja el registro
   * apagado. Fail-closed: una bitácora que se enciende sola en producción por
   * un valor mal escrito es justo lo que no se quiere.
   */
  readonly enabled: boolean;

  private buffer: AuditEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private overflowed = false;

  constructor(
    private readonly db: DbService,
    config: ConfigService,
  ) {
    this.enabled = config.get('AUDIT_LOG_ENABLE') === 'true';
    if (!this.enabled) {
      this.logger.log('AUDIT_LOG_ENABLE apagado: no se registra actividad.');
      return;
    }
    // El temporizador se crea DESPUÉS del bail-out: apagado, este servicio no
    // consume ni un recurso.
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
    this.logger.log('Bitácora de actividad activa.');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Un último volcado: al parar el contenedor, lo que quede en el buffer es
    // justo lo que pasó antes del apagado.
    await this.flush();
  }

  /**
   * Registra sin esperar. Es el camino normal.
   *
   * Se agrupa en lotes porque la alternativa —una inserción por petición— con
   * un pico de errores son cientos de inserciones por segundo contra un pool de
   * diez conexiones, y esas conexiones las necesita el usuario para operar.
   */
  record(entry: AuditEntry): void {
    if (!this.enabled) return;

    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift();
      if (!this.overflowed) {
        this.overflowed = true;
        this.logger.warn(
          `Buffer de auditoría lleno (${MAX_BUFFER}): se descartan las entradas más antiguas.`,
        );
      }
      return;
    }
    this.buffer.push(entry);
    if (this.buffer.length >= FLUSH_SIZE) void this.flush();
  }

  /**
   * Registra AHORA y espera a que esté en la base.
   *
   * Para lo que no se puede perder en un reinicio: alta y baja de credencial de
   * firma, borrado de cuenta, kill-switch, PANIC, step-up concedido o denegado,
   * acciones de ADMIN sobre la cuenta de otro. Aquí sí se paga el viaje a la
   * base, y se paga a gusto.
   *
   * Sigue sin propagar: si la escritura falla, el usuario no se entera.
   */
  async recordNow(entry: AuditEntry): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.db.activityLog.create({ data: toRow(entry) });
    } catch (e) {
      this.logger.warn(`No se pudo registrar ${entry.action}: ${messageOf(e)}`);
    }
  }

  /** Vuelca el buffer. Nunca lanza. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    // Se cambia la referencia ANTES del await: si no, lo que llegue mientras se
    // escribe se perdería al vaciar el array después.
    this.buffer = [];
    this.overflowed = false;
    try {
      await this.db.activityLog.createMany({ data: batch.map(toRow) });
    } catch (e) {
      this.logger.warn(
        `No se pudieron registrar ${batch.length} entradas: ${messageOf(e)}`,
      );
    }
  }

  /** Solo para tests: cuántas entradas esperan volcado. */
  get pending(): number {
    return this.buffer.length;
  }
}

/** Traduce la entrada a la fila. Es el único sitio que conoce las columnas. */
function toRow(entry: AuditEntry) {
  return {
    actor: entry.actor,
    actor_id: entry.actorId ?? null,
    bot_id: entry.botId ?? null,
    action: entry.action.slice(0, 64),
    severity: entry.severity ?? EventSeverity.INFO,
    outcome: entry.outcome,
    message: entry.message ?? null,
    route: entry.route?.slice(0, 160) ?? null,
    method: entry.method ?? null,
    status_code: entry.statusCode ?? null,
    duration_ms: entry.durationMs ?? null,
    ip: entry.ip?.slice(0, 45) ?? null,
    request_id: entry.requestId ?? null,
    meta: (entry.meta ?? null) as never,
  };
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
