import { Module } from '@nestjs/common';
import { AdvisorModule } from '../advisor';
import { BotsModule } from '../bots';
import { AiChannelEstadoService } from './ai-channel-estado.service';
import { AiChannelScheduler } from './ai-channel.scheduler';
import { AiChannelService } from './ai-channel.service';

/**
 * La IA del canal (spec 059): responde a las solicitudes que escribe el worker
 * para los bots `AI_CHANNEL`.
 *
 * Importa `AdvisorModule` por el cliente del modelo —el único fichero que
 * habla con un LLM— y `BotsModule` por el comando de pausa del botón de los
 * avisos, que va por el mismo camino que el de la app. NO importa
 * `ExchangeAccountsModule`: es la puerta a descifrar la clave de firma
 * (invariante 8), y aquí no se firma nada.
 */
@Module({
  imports: [AdvisorModule, BotsModule],
  providers: [AiChannelService, AiChannelEstadoService, AiChannelScheduler],
  exports: [AiChannelService, AiChannelEstadoService],
})
export class AiChannelModule {}
