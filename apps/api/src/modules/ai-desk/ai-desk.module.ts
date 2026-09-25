import { Module } from '@nestjs/common';
import { AdvisorModule } from '../advisor';
import { BotsModule } from '../bots';
import { MarketDataModule } from '../market-data';
import { MarketsModule } from '../markets';
import { RiskModule } from '../risk';
import { AiDeskConfig } from './ai-desk.config';
import { AiDeskScheduler } from './ai-desk.scheduler';
import { AiDeskAgentesService } from './agentes.service';
import { AiDeskAprobacionService } from './aprobacion.service';
import { AiDeskAvisosService } from './avisos.service';
import { AiDeskConsumoService } from './consumo.service';
import { AiDeskInterruptoresService } from './interruptores.service';
import { AiDeskLecturaService } from './lectura.service';
import { AiDeskListadosService } from './listados.service';
import { AiDeskMedicionService } from './medicion.service';
import { AiDeskOperacionesService } from './operaciones.service';
import { AiDeskRondasService } from './rondas.service';
import { AiDeskSeguimientoService } from './seguimiento.service';

/**
 * Los agentes de IA (spec 074): analizan pares de una cuenta cada intervalo,
 * proponen operaciones de una sola vez, las ejecutan como bots `AGENT_TRADE`
 * al aprobarse y les dan seguimiento.
 *
 * Importa `AdvisorModule` por el cliente del modelo —el único fichero que habla
 * con un LLM—, `BotsModule` porque sus operaciones nacen, arrancan y cambian
 * por `BotsService` como las de cualquiera, y `MarketDataModule` por las velas,
 * los tickers y el flujo de precios. NO importa `ExchangeAccountsModule`: es la
 * puerta a descifrar la clave de firma (invariante 8), y aquí no se firma
 * nada. Quien firma es el worker, como siempre.
 *
 * Sus rutas viven en la consola (`admin/admin-ai-desk.controller.ts`), cerradas
 * por rol con las demás.
 */
@Module({
  imports: [AdvisorModule, BotsModule, MarketDataModule, MarketsModule, RiskModule],
  providers: [
    AiDeskConfig,
    AiDeskInterruptoresService,
    AiDeskAgentesService,
    AiDeskAvisosService,
    AiDeskConsumoService,
    AiDeskLecturaService,
    AiDeskAprobacionService,
    AiDeskOperacionesService,
    AiDeskRondasService,
    AiDeskSeguimientoService,
    AiDeskMedicionService,
    AiDeskListadosService,
    AiDeskScheduler,
  ],
  exports: [
    AiDeskConfig,
    AiDeskInterruptoresService,
    AiDeskAgentesService,
    AiDeskAprobacionService,
    AiDeskRondasService,
    AiDeskSeguimientoService,
    AiDeskListadosService,
  ],
})
export class AiDeskModule {}
