import { Module } from '@nestjs/common';
import { AiTraderScheduler } from './ai-trader.scheduler';
import { AiTraderService } from './ai-trader.service';
import { TypeSafeClient } from './typesafe.client';

/**
 * La IA del «Bot de IA» (spec 069): responde a las solicitudes que escribe el
 * worker para los bots `AI_TRADER`.
 *
 * NO importa `AdvisorModule`: su cliente habla con OpenRouter y este habla con
 * TypeSafe. Los dos proveedores no se tocan a proposito —uno caido no arrastra
 * al otro—, y por eso el cliente vive aqui y no alli.
 *
 * Tampoco importa `BotsModule`: este bot no tiene boton de pausa en sus avisos.
 * Ni `ExchangeAccountsModule`, que es la puerta a descifrar la clave de firma
 * (invariante 8): aqui no se firma nada.
 */
@Module({
  providers: [TypeSafeClient, AiTraderService, AiTraderScheduler],
  exports: [AiTraderService],
})
export class AiTraderModule {}
