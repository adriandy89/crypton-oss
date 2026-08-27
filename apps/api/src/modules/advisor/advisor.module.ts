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
  exports: [AdvisorService],
})
export class AdvisorModule {}
