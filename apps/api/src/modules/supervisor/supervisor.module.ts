import { Module } from '@nestjs/common';
import { AdvisorModule } from '../advisor';
import { BotsModule } from '../bots';
import { MarketDataModule } from '../market-data';
import { MarketsModule } from '../markets';
import { RiskModule } from '../risk';
import { SupervisorPolicyService } from './supervisor.policy.service';
import { SupervisorScheduler } from './supervisor.scheduler';
import { SupervisorService } from './supervisor.service';

/**
 * El supervisor de IA: vigila bots que YA estan operando (spec 046).
 *
 * No confundir con `AdvisorModule`, que aconseja al CREAR un bot y se
 * desentiende. Aquel responde a alguien que esta mirando la pantalla; este gasta
 * solo, en bucle, sin que nadie lo pida — por eso tienen interruptores, modelos y
 * cupos distintos.
 *
 * Importa `MarketDataModule` por las velas, como el asesor. NO importa
 * `ExchangeAccountsModule`, y la ausencia es deliberada: es la puerta a
 * `openAdapter()`, que descifra la clave de firma del usuario (invariante 8). El
 * supervisor decide sobre configuraciones, y para eso no hace falta poder firmar
 * nada. Quien mañana necesite el saldo de una cuenta y venga a importarlo: eso
 * es exactamente lo que este parrafo pide que no hagas.
 */
@Module({
  imports: [MarketDataModule, MarketsModule, RiskModule, BotsModule, AdvisorModule],
  providers: [SupervisorPolicyService, SupervisorService, SupervisorScheduler],
  exports: [SupervisorPolicyService, SupervisorService],
})
export class SupervisorModule {}
