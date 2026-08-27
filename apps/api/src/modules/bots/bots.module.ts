import { Module } from '@nestjs/common';
import { ExchangeAccountsModule } from '../exchange-accounts';
import { MarketsModule } from '../markets';
import { RiskModule } from '../risk';
import { BotsSseService } from './bots-sse.service';
import { BotsController } from './bots.controller';
import { BotsService } from './bots.service';

@Module({
  imports: [MarketsModule, ExchangeAccountsModule, RiskModule],
  controllers: [BotsController],
  providers: [BotsService, BotsSseService],
  exports: [BotsService, BotsSseService],
})
export class BotsModule {}
