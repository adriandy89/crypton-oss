import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { Market, Venue } from '../models';
import { NetworkService } from './network.service';

@Injectable({ providedIn: 'root' })
export class MarketsService {
  private readonly http = inject(HttpClient);
  private readonly network = inject(NetworkService);
  private readonly base = `${environment.apiUrl}/markets`;

  /**
   * Cache por venue Y RED: el catalogo cambia poco y la lista es larga.
   *
   * La red entra en la clave porque son catalogos distintos —otros pares, otro
   * tick, otro step— y sin ella cambiar de lente servia la lista de la red
   * anterior desde cache, sin una sola peticion que lo delatara.
   */
  private readonly cache = new Map<string, Market[]>();

  /**
   * `testnet` explícito para cuando la red NO la decide la lente.
   *
   * Lo normal es que la lente y la cuenta coincidan, y por eso el valor por
   * defecto es la lente. La excepción es la conexión de SIMULACIÓN: vive siempre
   * en mainnet y se ofrece también con la lente puesta en testnet, así que
   * dejarla a merced de la lente le daba los pares, el tick y el step del libro
   * equivocado — y el bot se creaba luego contra el otro.
   */
  async list(venue?: Venue, search?: string, testnetOverride?: boolean): Promise<Market[]> {
    const testnet = testnetOverride ?? this.network.testnet();
    const key = `${venue ?? 'all'}:${search ?? ''}:${testnet ? 't' : 'm'}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const params: Record<string, string> = {};
    if (venue) params['venue'] = venue;
    if (search) params['search'] = search;
    if (testnet) params['testnet'] = 'true';

    const markets = await firstValueFrom(this.http.get<Market[]>(this.base, { params }));
    this.cache.set(key, markets);
    return markets;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
