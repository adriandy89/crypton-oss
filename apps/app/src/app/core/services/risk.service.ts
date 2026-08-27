import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { RiskLimits } from '../models';

@Injectable({ providedIn: 'root' })
export class RiskService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/risk`;

  readonly limits = signal<RiskLimits | null>(null);

  async refresh(): Promise<void> {
    this.limits.set(await firstValueFrom(this.http.get<RiskLimits>(`${this.base}/limits`)));
  }

  async update(patch: Partial<Record<string, string | number | null>>): Promise<void> {
    this.limits.set(
      await firstValueFrom(this.http.patch<RiskLimits>(`${this.base}/limits`, patch)),
    );
  }

  /** Para TODOS los bots del usuario y cancela sus órdenes. */
  killSwitch(): Promise<{ affected: number }> {
    return firstValueFrom(this.http.post<{ affected: number }>(`${this.base}/kill-switch`, {}));
  }
}
