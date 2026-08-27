import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { RecommendationSet, StrategyKind, Venue } from '../models';
import { NetworkService } from './network.service';

/**
 * Configuraciones recomendadas para crear un bot.
 *
 * Todo el cálculo vive en el servidor, y no por comodidad: las recomendaciones
 * se validan con las MISMAS funciones que ejecuta el motor y contra los límites
 * de riesgo del usuario, que la app no conoce enteros. Aquí solo se pide y se
 * pinta.
 */
@Injectable({ providedIn: 'root' })
export class AdvisorService {
  private readonly http = inject(HttpClient);
  private readonly network = inject(NetworkService);
  private readonly base = `${environment.apiUrl}/advisor`;

  /**
   * La red la pone el servicio, igual que hace `BotsService`: es una propiedad
   * de la lente, no algo que cada pantalla tenga que acordarse de mandar.
   */
  suggest(input: {
    venue: Venue;
    symbol: string;
    strategy: StrategyKind;
    totalInvestment: string;
    direction?: 'LONG' | 'SHORT' | 'NEUTRAL';
  }): Promise<RecommendationSet> {
    return firstValueFrom(
      this.http.post<RecommendationSet>(`${this.base}/bot-config`, {
        ...input,
        testnet: this.network.testnet(),
      }),
    );
  }
}
