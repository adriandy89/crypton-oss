import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BotStatus, Paginated, StrategyKind, Venue } from '../models';

/**
 * Los UNICOS comandos que un administrador puede mandar sobre un bot ajeno.
 *
 * Contencion, no destruccion: ninguno de los dos toca la posicion y ninguno
 * retira el stop-loss nativo del venue. `CANCEL_ALL_ORDERS` no esta —y no es un
 * olvido— porque cancela tambien ese stop, y sobre una posicion apalancada la
 * dejaria desnuda: la unica «contencion» capaz de dejar a alguien peor protegido
 * que antes.
 *
 * Esta lista es COMODIDAD para pintar botones. La que manda es el `@IsIn` del
 * DTO del servidor: un cliente que se restringe a si mismo no restringe nada.
 */
export const ADMIN_BOT_COMMANDS = ['PAUSE', 'STOP_KEEP_POSITION'] as const;
export type AdminBotCommand = (typeof ADMIN_BOT_COMMANDS)[number];

export const ETIQUETA_COMANDO: Record<AdminBotCommand, string> = {
  PAUSE: 'Pausar (mantiene la posición)',
  STOP_KEEP_POSITION: 'Parar conservando la posición',
};

export interface AdminBotRow {
  id: string;
  name: string;
  owner: { id: string; email: string; name: string; disabled: boolean };
  venue: Venue;
  symbol: string;
  strategy: StrategyKind;
  status: BotStatus;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  leverage: number;
  marginMode: 'CROSS' | 'ISOLATED';
  dryRun: boolean;
  paper: boolean;
  testnet: boolean;
  /** Dinero: cadena, siempre. La app no suma importes, los pide ya sumados. */
  totalInvestment: string;
  lastError: string | null;
  startedAt: string | null;
  lastTickAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface AdminBotsFilters {
  userId?: string;
  email?: string;
  venue?: Venue;
  symbol?: string;
  strategy?: StrategyKind;
  status?: BotStatus;
  dryRun?: boolean;
  withError?: boolean;
}

/**
 * El detalle de un bot ajeno.
 *
 * Es lo que devuelve `BotsService.detail()` —el mismo objeto que ve su dueño—
 * mas quien es ese dueño. Se escribe suelto y no se reutiliza el tipo del
 * detalle propio porque esta pantalla solo lee un puñado de campos y atarla al
 * contrato completo la obligaria a seguir cada cambio de aquel.
 */
export interface AdminBotDetail extends AdminBotRow {
  currentCapital?: string | null;
  realizedPnl?: string;
  unrealizedPnl?: string;
  roiPct?: string;
  positionQty?: string | null;
  marginUsed?: string | null;
  liquidationPrice?: string | null;
  liquidationDistancePct?: string | null;
  openOrders?: number;
  note?: string | null;
  configVersion?: number;
  config?: Record<string, unknown>;
}

/**
 * Todos los bots de la plataforma, solo para ADMIN (spec 033).
 *
 * Mirar y contener. No hay aqui nada que cree, edite ni borre un bot ajeno: esa
 * superficie no existe en el servidor tampoco.
 */
@Injectable({ providedIn: 'root' })
export class AdminBotsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/admin/bots`;

  list(filters: AdminBotsFilters, page = 1, limit = 30): Promise<Paginated<AdminBotRow>> {
    const params: Record<string, string> = { page: String(page), limit: String(limit) };
    if (filters.userId) params['userId'] = filters.userId;
    if (filters.email) params['email'] = filters.email;
    if (filters.venue) params['venue'] = filters.venue;
    if (filters.symbol) params['symbol'] = filters.symbol;
    if (filters.strategy) params['strategy'] = filters.strategy;
    if (filters.status) params['status'] = filters.status;
    if (filters.dryRun !== undefined) params['dryRun'] = String(filters.dryRun);
    if (filters.withError) params['withError'] = 'true';
    return firstValueFrom(this.http.get<Paginated<AdminBotRow>>(this.base, { params }));
  }

  detail(id: string): Promise<AdminBotDetail> {
    return firstValueFrom(this.http.get<AdminBotDetail>(`${this.base}/${id}`));
  }

  /** El motivo es obligatorio: sin el, el servidor devuelve 400. */
  command(
    id: string,
    command: AdminBotCommand,
    reason: string,
  ): Promise<{ accepted: boolean; command: string }> {
    return firstValueFrom(
      this.http.post<{ accepted: boolean; command: string }>(`${this.base}/${id}/commands`, {
        command,
        reason,
      }),
    );
  }
}
