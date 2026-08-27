import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { MarketWatchService } from './watch.service';
import { PriceSourceService } from './price-source.service';

// Sin dependencias propias: el bus es global y los adaptadores que usa este
// modulo son PUBLICOS, sin credenciales. Que no dependa de nada que descifre
// secretos no es casual, es la frontera que hace seguro compartir precios.
@Module({
  providers: [MarketDataService, MarketWatchService, PriceSourceService],
  exports: [MarketDataService, PriceSourceService],
})
export class MarketDataModule {}
