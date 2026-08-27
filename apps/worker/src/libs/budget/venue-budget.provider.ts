import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryVenueBudget, RedisVenueBudget, type VenueBudget } from '@crypton/exchange-core';
import { BusService } from '../bus';

/**
 * Presupuesto de caudal por venue, UNO por proceso y compartido por todo lo que
 * habla con los exchanges: los adaptadores de cuenta y el feed publico de
 * precios.
 *
 * Va en Redis y no en memoria porque varios workers pueden salir por la MISMA
 * IP, y los limites de los DEX se cuentan por IP: con un presupuesto por
 * proceso, cada worker se creeria dueno del total y entre todos lo
 * multiplicarian por N. Los procesos que comparten salida comparten
 * `WORKER_EGRESS_ID`, y eso es lo que los hace compartir presupuesto.
 *
 * Con `WORKER_EGRESS_ID=memory` se usa el de memoria: correcto cuando cada
 * worker tiene su propia IP, y mas rapido porque no cruza la red. La interfaz
 * es la misma, asi que cambiar de topologia no toca ni una linea del motor.
 */
@Injectable()
export class VenueBudgetProvider {
  private readonly logger = new Logger(VenueBudgetProvider.name);
  readonly budget: VenueBudget;

  constructor(bus: BusService, config: ConfigService) {
    const egress = config.get<string>('WORKER_EGRESS_ID', 'shared');
    this.budget =
      egress === 'memory'
        ? new MemoryVenueBudget()
        : new RedisVenueBudget(
            { eval: (script, options) => bus.evalScript(script, options) },
            egress,
          );
    this.logger.log(`Presupuesto de caudal por venue: ${egress}`);
  }
}
