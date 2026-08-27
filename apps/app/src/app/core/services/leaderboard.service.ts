import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { StrategyKind, Venue } from '../models';

export type LeaderboardPeriod = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';

export interface LeaderboardRow {
  rank: number;
  botId: string;
  name: string;
  venue: Venue;
  symbol: string;
  strategy: StrategyKind;
  direction: string | null;
  leverage: number | null;
  roiPct: string;
  // Sin `aum` ni `totalPnl`: la API ya no publica el capital ni el resultado
  // absoluto del autor. El ROI es relativo y es lo que compara dos bots sin
  // decir cuánto dinero mueve cada uno.
  uptimeSeconds: number;
  /** null = su autor no lo ha publicado para copiar. */
  shareCode: string | null;
  copies: number;
  computedAt: string;
}

export interface CopyResult {
  strategy: StrategyKind;
  sourceName: string;
  sourceVenue: Venue;
  sourceSymbol: string;
  config: Record<string, unknown>;
}

@Injectable({ providedIn: 'root' })
export class LeaderboardService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  readonly rows = signal<LeaderboardRow[]>([]);
  readonly loading = signal(false);

  async load(filters: {
    period?: LeaderboardPeriod;
    venue?: Venue;
    strategy?: StrategyKind;
  } = {}): Promise<void> {
    this.loading.set(true);
    try {
      const params: Record<string, string> = {};
      if (filters.period) params['period'] = filters.period;
      if (filters.venue) params['venue'] = filters.venue;
      if (filters.strategy) params['strategy'] = filters.strategy;

      this.rows.set(
        await firstValueFrom(
          this.http.get<LeaderboardRow[]>(`${this.base}/leaderboard`, { params }),
        ),
      );
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Resuelve un código compartido a una configuración lista para el asistente.
   * NO crea el bot: devuelve los parámetros ya dimensionados al capital que
   * indique quien copia, para que pueda revisarlos antes de nada.
   */
  resolve(input: {
    code: string;
    exchangeAccountId: string;
    symbol: string;
    totalInvestment: string;
  }): Promise<CopyResult> {
    return firstValueFrom(this.http.post<CopyResult>(`${this.base}/leaderboard/copy`, input));
  }

  share(botId: string, isPublic = true) {
    return firstValueFrom(
      this.http.post<{ shareCode: string; public: boolean; copies: number }>(
        `${this.base}/bots/${botId}/share`,
        { public: isPublic },
      ),
    );
  }

  unshare(botId: string) {
    return firstValueFrom(this.http.delete(`${this.base}/bots/${botId}/share`));
  }
}
