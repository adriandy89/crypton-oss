import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BotStatus, Paginated, Venue } from '../models';

/** Una fila de `GET /admin/users`, tal y como la proyecta `toRow` en la API. */
export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  disabled: boolean;
  emailVerified: boolean;
  country: string | null;
  language: string;
  createdAt: string;
  lastLoginAt: string | null;
  bots: { total: number; live: number };
  exchangeAccounts: number;
}

/**
 * Las conexiones de exchange de un usuario, sin UN SOLO campo del sobre
 * criptografico: la API no los proyecta y aqui no hay donde ponerlos.
 */
export interface AdminAccountRow {
  id: string;
  venue: Venue;
  label: string;
  status: string;
  publicRef: string;
  testnet: boolean;
  paper: boolean;
  builderApproved: boolean;
  lastVerifiedAt: string | null;
  agentValidUntil: string | null;
  lastError: string | null;
}

export interface AdminUserDetail extends AdminUserRow {
  bio: string | null;
  timezone: string | null;
  displayCurrency: string | null;
  updatedAt: string | null;
  riskLimits: {
    maxNotionalPerBot: string | null;
    maxTotalNotional: string | null;
    maxLeverage: number | null;
    maxOpenBots: number | null;
    maxDailyLoss: string | null;
    killSwitchDrawdownPct: string | null;
    liquidationAlertPct: string | null;
  } | null;
  accounts: AdminAccountRow[];
  botsByStatus: Partial<Record<BotStatus, number>>;
  telegram: { linked: boolean; verifiedAt: string | null };
}

export interface AdminUsersFilters {
  /** Correo o nombre, por prefijo. Una caja para las dos cosas. */
  q?: string;
  role?: 'USER' | 'ADMIN';
  disabled?: boolean;
  withBots?: boolean;
  sortBy?: 'created_at' | 'last_login_at' | 'email' | 'name';
}

/** Lo que devuelve deshabilitar: el corte puede no haberse aplicado. */
export interface ResultadoDeshabilitar {
  id: string;
  disabled: boolean;
  sesionCortada: boolean;
  accesoResidualHasta?: string | null;
}

/**
 * Las cuentas de la plataforma, solo para ADMIN (spec 033).
 *
 * Sin señales de estado, al contrario que `BotsService`: estos datos son
 * paginados y filtrados POR PANTALLA y no los comparte nadie. Una señal
 * compartida aqui solo serviria para que dos pantallas se pisaran los filtros.
 *
 * La autoridad es el `RolesGuard` del servidor. Un 403 aqui significa un token
 * con el rol viejo, y las pantallas lo dicen con esas palabras.
 */
@Injectable({ providedIn: 'root' })
export class AdminUsersService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/admin/users`;

  list(filters: AdminUsersFilters, page = 1, limit = 30): Promise<Paginated<AdminUserRow>> {
    // Los parametros se construyen a mano y solo si tienen valor: el servidor
    // va con `forbidNonWhitelisted`, asi que mandar `q: ''` no es un filtro
    // vacio, es un 400.
    const params: Record<string, string> = { page: String(page), limit: String(limit) };
    if (filters.q) params['q'] = filters.q;
    if (filters.role) params['role'] = filters.role;
    if (filters.disabled !== undefined) params['disabled'] = String(filters.disabled);
    if (filters.withBots !== undefined) params['withBots'] = String(filters.withBots);
    if (filters.sortBy) params['sortBy'] = filters.sortBy;
    return firstValueFrom(this.http.get<Paginated<AdminUserRow>>(this.base, { params }));
  }

  detail(id: string): Promise<AdminUserDetail> {
    return firstValueFrom(this.http.get<AdminUserDetail>(`${this.base}/${id}`));
  }

  /** El motivo viaja a la bitacora: es lo que hace revisable la accion despues. */
  disable(id: string, reason: string): Promise<ResultadoDeshabilitar> {
    return firstValueFrom(
      this.http.post<ResultadoDeshabilitar>(`${this.base}/${id}/disable`, { reason }),
    );
  }

  enable(id: string): Promise<{ id: string; disabled: boolean }> {
    return firstValueFrom(
      this.http.post<{ id: string; disabled: boolean }>(`${this.base}/${id}/enable`, {}),
    );
  }

  revokeSessions(id: string): Promise<{ id: string; sesionCortada: boolean }> {
    return firstValueFrom(
      this.http.post<{ id: string; sesionCortada: boolean }>(
        `${this.base}/${id}/sessions/revoke`,
        {},
      ),
    );
  }
}
