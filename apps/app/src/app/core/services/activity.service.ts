import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ActorKind, EventSeverity, FilaResumenAccion } from '@crypton/shared';
import { environment } from '../../../environments/environment';
import type { Paginated } from '../models/paging';

/** Una fila de `GET /admin/activity`, tal y como la proyecta `ActivityService.toPublic` en la API. */
export interface ActivityEntry {
  id: string;
  actor: ActorKind;
  actorId: string | null;
  botId: string | null;
  action: string;
  severity: EventSeverity;
  outcome: 'OK' | 'DENIED' | 'ERROR';
  message: string | null;
  /** Patrón de ruta (`/bots/:id`), nunca la URL: ver el modelo `ActivityLog`. */
  route: string | null;
  method: string | null;
  statusCode: number | null;
  durationMs: number | null;
  /** Dato personal: la pantalla no lo pinta en la lista, solo al desplegar. */
  ip: string | null;
  requestId: string | null;
  meta: unknown;
  createdAt: string;
}

/** El sobre de siempre. Se conserva el nombre: la pantalla no cambia. */
export type ActivityPage = Paginated<ActivityEntry>;

/** Los filtros que ofrece la pantalla; el resto de `ActivityQueryDto` no hace falta. */
export interface ActivityFilters {
  /** Todo lo que hizo una persona. Lo soporta `ActivityQueryDto` desde el spec 007. */
  actorId?: string;
  onlyFailures?: boolean;
  actor?: ActorKind;
  severity?: EventSeverity;
  /** Prefijo: `bot.` trae todas las acciones de bots. */
  action?: string;
}

/**
 * La bitácora de actividad, solo para ADMIN (spec 007).
 *
 * Solo el cliente de los dos endpoints que ya existían: la lista paginada con
 * sus filtros y el resumen por acción de una ventana. La autoridad es el
 * `RolesGuard` del servidor; un 403 aquí es un token con rol viejo y la
 * pantalla lo dice.
 */
@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/admin/activity`;

  list(filters: ActivityFilters, page = 1, limit = 50): Promise<ActivityPage> {
    const params: Record<string, string> = { page: String(page), limit: String(limit) };
    if (filters.actorId) params['actorId'] = filters.actorId;
    if (filters.onlyFailures) params['onlyFailures'] = 'true';
    if (filters.actor) params['actor'] = filters.actor;
    if (filters.severity) params['severity'] = filters.severity;
    if (filters.action) params['action'] = filters.action;
    return firstValueFrom(this.http.get<ActivityPage>(this.base, { params }));
  }

  summary(hours: number): Promise<FilaResumenAccion[]> {
    return firstValueFrom(
      this.http.get<FilaResumenAccion[]>(`${this.base}/summary`, {
        params: { hours: String(hours) },
      }),
    );
  }
}
