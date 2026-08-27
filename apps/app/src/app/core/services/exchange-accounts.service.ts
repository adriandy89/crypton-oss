import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { ExchangeAccount, Venue } from '../models';

@Injectable({ providedIn: 'root' })
export class ExchangeAccountsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/exchange-accounts`;

  readonly accounts = signal<ExchangeAccount[]>([]);

  async refresh(): Promise<void> {
    this.accounts.set(await firstValueFrom(this.http.get<ExchangeAccount[]>(this.base)));
  }

  /**
   * Alta de conexión. El secreto viaja UNA vez y no vuelve nunca: la respuesta
   * solo trae `publicRef`, que es un dato público del venue.
   *
   * La prueba de identidad no va en el cuerpo: es la reautenticación con Google
   * hecha justo antes, que el servidor consume al procesar esta petición.
   */
  async create(payload: {
    venue: Venue;
    label: string;
    /**
     * Red del venue. Ausente = mainnet.
     *
     * Va de primer nivel porque vale para los tres venues: es una propiedad de
     * la cuenta, no de la credencial. La URL no se manda —la decide el
     * servidor— asi que esto es lo unico que elige contra que libro opera.
     */
    testnet?: boolean;
    hyperliquid?: { accountAddress: string; agentPrivateKey: string };
    lighter?: { accountIndex: number; apiKeyIndex: number; apiPrivateKey: string };
    aster?: { userAddress: string; signerAddress: string; signerPrivateKey: string };
  }): Promise<ExchangeAccount> {
    const created = await firstValueFrom(this.http.post<ExchangeAccount>(this.base, payload));
    await this.refresh();
    return created;
  }

  async verify(id: string): Promise<ExchangeAccount> {
    const updated = await firstValueFrom(
      this.http.post<ExchangeAccount>(`${this.base}/${id}/verify`, {}),
    );
    await this.refresh();
    return updated;
  }

  /**
   * Cambia el capital de partida de la simulacion.
   *
   * El servidor la REINICIA al hacerlo: conservar el estado convertiria
   * «simular con 500» en «simular con 500 mas lo que ya llevabas».
   */
  async setPaperBalance(id: string, balance: string): Promise<ExchangeAccount> {
    const updated = await firstValueFrom(
      this.http.patch<ExchangeAccount>(`${this.base}/${id}`, { paperBalance: balance }),
    );
    await this.refresh();
    return updated;
  }

  /** Devuelve la simulacion a su capital de partida, sin posiciones ni ordenes. */
  async resetPaper(id: string): Promise<ExchangeAccount> {
    const updated = await firstValueFrom(
      this.http.post<ExchangeAccount>(`${this.base}/${id}/paper-reset`, {}),
    );
    await this.refresh();
    return updated;
  }

  async setBuilderApproved(id: string, approved: boolean): Promise<void> {
    await firstValueFrom(this.http.patch(`${this.base}/${id}`, { builderApproved: approved }));
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${this.base}/${id}`));
    await this.refresh();
  }
}
