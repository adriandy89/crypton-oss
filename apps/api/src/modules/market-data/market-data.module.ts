import { Module } from '@nestjs/common';
import { BotsModule } from '../bots';
import { MarketsModule } from '../markets';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { MarketStreamService } from './market-stream.service';

/**
 * Sin DbModule: aqui no se guarda nada en Postgres. Las velas y los precios
 * viven en Redis con TTL porque caducan solos, y persistirlos significaria
 * mantener una tabla que crece sin parar para servir un dato que el venue ya
 * tiene y da gratis.
 */
@Module({
  // MarketsModule aporta el catálogo contra el que se valida cada símbolo
  // ANTES de salir al venue.
  // BotsModule aporta el TRANSPORTE del flujo SSE, no nada de bots: es la
  // conexion que la aplicacion ya tiene abierta toda la sesion. Abrir un
  // segundo canal permanente solo para precios habria multiplicado por dos las
  // conexiones por usuario sin ganar nada.
  imports: [MarketsModule, BotsModule],
  controllers: [MarketDataController],
  providers: [MarketDataService, MarketStreamService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
