import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface TelegramPrefs {
  fills: boolean;
  cycles: boolean;
  errors: boolean;
  risk: boolean;
  liquidation: boolean;
  daily: boolean;
  /**
   * Lo que propone o aplica el supervisor de IA (spec 046).
   *
   * Solo tiene fila en la pantalla para un administrador, que es el único que
   * puede encender el Modo IA (spec 055). Apagarlo deja sin revisar sus bots en
   * «propone y espera»: sus sugerencias no llegarían a ninguna parte.
   */
  ai: boolean;
}

export interface TelegramStatus {
  linked: boolean;
  botUsername: string;
  prefs: TelegramPrefs;
  deepLink: string | null;
  verifiedAt?: string | null;
}

@Injectable({ providedIn: 'root' })
export class TelegramService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/telegram`;

  readonly status = signal<TelegramStatus | null>(null);

  async refresh(): Promise<void> {
    this.status.set(await firstValueFrom(this.http.get<TelegramStatus>(this.base)));
  }

  /** Genera el código de vinculación. Invalida el anterior si existia. */
  async link(): Promise<{ code: string; deepLink: string | null; instructions: string }> {
    const result = await firstValueFrom(
      this.http.post<{ code: string; deepLink: string | null; instructions: string }>(
        `${this.base}/link`,
        {},
      ),
    );
    await this.refresh();
    return result;
  }

  async updatePrefs(patch: Partial<TelegramPrefs>): Promise<void> {
    const prefs = await firstValueFrom(this.http.patch<TelegramPrefs>(`${this.base}/prefs`, patch));
    const current = this.status();
    if (current) this.status.set({ ...current, prefs });
  }

  async unlink(): Promise<void> {
    await firstValueFrom(this.http.delete(this.base));
    await this.refresh();
  }
}
