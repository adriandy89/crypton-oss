import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { PortfolioEquitySeries, PortfolioRange } from '../models';
import { NetworkService } from './network.service';

/**
 * La curva agregada de la cartera (spec 003).
 *
 * Solo el cliente del endpoint: la serie se pide con la red del interruptor,
 * como el listado de bots, y la pantalla decide cuándo volver a pedirla. La
 * tabla cambia cada cinco minutos, así que pedirla con cada evento del flujo
 * sería descargar lo mismo cuarenta veces.
 */
@Injectable({ providedIn: 'root' })
export class PortfolioService {
  private readonly http = inject(HttpClient);
  private readonly network = inject(NetworkService);
  private readonly base = `${environment.apiUrl}/portfolio`;

  equity(range: PortfolioRange): Promise<PortfolioEquitySeries> {
    return firstValueFrom(
      this.http.get<PortfolioEquitySeries>(`${this.base}/equity`, {
        params: { range, testnet: String(this.network.testnet()) },
      }),
    );
  }
}
