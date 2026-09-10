import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Lo que se puede purgar a mano. Comodidad para pintar la pantalla: la lista
 * que manda es la del servidor, que ademas impone los suelos.
 */
export const PURGE_SCOPES = [
  'BOT_SNAPSHOTS',
  'BOT_EVENTS',
  'BOT_COMMANDS',
  'PORTFOLIO_SNAPSHOTS',
  'BACKTESTS',
  'ACTIVITY_LOG',
] as const;
export type PurgeScope = (typeof PURGE_SCOPES)[number];

export const ETIQUETA_AMBITO: Record<PurgeScope, string> = {
  BOT_SNAPSHOTS: 'Series de bots',
  BOT_EVENTS: 'Eventos de bots',
  BOT_COMMANDS: 'Comandos ejecutados',
  PORTFOLIO_SNAPSHOTS: 'Curva de cartera',
  BACKTESTS: 'Backtests',
  ACTIVITY_LOG: 'Bitácora de actividad',
};

/** Las antigüedades que ofrece la pantalla, iguales a las del DTO del servidor. */
export const ANTIGUEDADES = [
  { dias: 15, label: '15 días' },
  { dias: 30, label: '1 mes' },
  { dias: 90, label: '3 meses' },
  { dias: 180, label: '6 meses' },
] as const;

export interface AmbitoPurgable {
  scope: PurgeScope;
  tabla: string;
  descripcion: string;
  /** Por debajo de esto el servidor no purga, se pida lo que se pida. */
  sueloDias: number;
  /** Retención del cron del worker. `null` = esa tabla no la purga ningún cron. */
  retencionAutomaticaDias: number | null;
  variable: string;
  filas: number;
}

@Injectable({ providedIn: 'root' })
export class AdminMaintenanceService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/admin/maintenance`;

  estado(): Promise<{ ambitos: AmbitoPurgable[] }> {
    return firstValueFrom(this.http.get<{ ambitos: AmbitoPurgable[] }>(this.base));
  }

  /** Cuántas filas caerían. No borra: es lo que se enseña antes de confirmar. */
  preview(scope: PurgeScope, days: number): Promise<{ filas: number }> {
    return firstValueFrom(
      this.http.post<{ filas: number }>(`${this.base}/preview`, { scope, days }),
    );
  }

  purge(
    scope: PurgeScope,
    days: number,
    reason: string,
  ): Promise<{ borradas: number; completo: boolean }> {
    return firstValueFrom(
      this.http.post<{ borradas: number; completo: boolean }>(`${this.base}/purge`, {
        scope,
        days,
        reason,
      }),
    );
  }
}
