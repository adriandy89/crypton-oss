import { Module } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';

/**
 * La cartera como agregado (spec 003). Solo lectura: la tabla la escribe el
 * worker. No depende de `BotsModule` a propósito —no necesita nada de un bot
 * concreto— y así la pestaña de aterrizaje no arrastra el módulo más grande de
 * la API para pintar una curva.
 */
@Module({
  controllers: [PortfolioController],
  providers: [PortfolioService],
})
export class PortfolioModule {}
