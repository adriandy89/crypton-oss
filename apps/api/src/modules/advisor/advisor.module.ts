import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data';
import { MarketsModule } from '../markets';
import { RiskModule } from '../risk';
import { AdvisorController } from './advisor.controller';
import { AdvisorService } from './advisor.service';
import { OpenRouterClient } from './openrouter.client';

/**
 * Recomendaciones de configuración de bot.
 *
 * Importa `MarketDataModule` para las velas y `MarketsModule` para la spec. Se
 * puede hacer desde aquí sin problema; hacerlo desde `bots` crearía un ciclo,
 * porque `MarketDataModule` ya importa `BotsModule`.
 */
@Module({
  imports: [MarketsModule, MarketDataModule, RiskModule],
  controllers: [AdvisorController],
  providers: [AdvisorService, OpenRouterClient],
  // `OpenRouterClient` se exporta porque `SupervisorModule` lo inyecta directo
  // (spec 046): el supervisor no pide consejo, llama a `revisar()` con su propio
  // modelo y su propio cupo. Se comparte la instancia a proposito — es el unico
  // fichero que habla con un LLM y asi sigue habiendo un solo sitio que lo haga.
  // Faltaba, y la API no arrancaba (spec 049).
  exports: [AdvisorService, OpenRouterClient],
})
export class AdvisorModule {}
