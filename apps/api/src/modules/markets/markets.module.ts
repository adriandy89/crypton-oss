import { Module } from '@nestjs/common';
import { MarketsController } from './markets.controller';
import { MarketsService } from './markets.service';

// Sin ExchangeAccountsModule: los metadatos de mercado son públicos y desde que
// `syncVenue` usa un adaptador sin credenciales, este módulo no necesita
// acceder a las de nadie.
@Module({
  controllers: [MarketsController],
  providers: [MarketsService],
  exports: [MarketsService],
})
export class MarketsModule {}
