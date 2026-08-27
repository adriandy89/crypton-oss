import { Module } from '@nestjs/common';
import { MarketsModule } from '../markets/markets.module';
import { BacktestsController } from './backtests.controller';
import { BacktestsService } from './backtests.service';

// `MarketsModule` por la ficha del mercado: se lee del CATÁLOGO de Postgres y no
// del venue, así que un backtest no gasta ni una llamada del presupuesto que los
// bots usan para operar.
@Module({
  imports: [MarketsModule],
  controllers: [BacktestsController],
  providers: [BacktestsService],
})
export class BacktestsModule {}
