import type { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';

/**
 * Una entrada de la bitácora.
 *
 * `meta` es `Record<string, unknown>` y no `any` a propósito: obliga a construir
 * el objeto a mano, campo a campo, en vez de dejar caer un DTO entero. La
 * diferencia entre las dos cosas es una clave privada en la base de datos.
 */
export interface AuditEntry {
  actor: ActorKind;
  actorId?: string | null;
  botId?: string | null;
  action: string;
  severity?: EventSeverity;
  outcome: AuditOutcome;
  message?: string | null;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  ip?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Lo que declara `@Audit()` sobre un método de controlador. */
export interface AuditOptions {
  /**
   * Campos del cuerpo que SÍ se guardan. Todo lo demás se descarta.
   *
   * Lista blanca y no negra, por el mismo motivo que `toPublic()` en
   * `exchange-accounts.service.ts`: con una lista negra, añadir un campo
   * sensible a un DTO lo filtra en silencio hasta que alguien se da cuenta.
   * Con lista blanca, el campo nuevo simplemente no se registra.
   */
  fields?: readonly string[];
  /** Campos del `params` de la ruta que se guardan (`id` del bot, por ejemplo). */
  params?: readonly string[];
  /** Si la acción no se puede perder: se escribe y se espera. Ver `recordNow`. */
  critical?: boolean;
  severity?: EventSeverity;
}

export const AUDIT_METADATA = 'crypton:audit';
