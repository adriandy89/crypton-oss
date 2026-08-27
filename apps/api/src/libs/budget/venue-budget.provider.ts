import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryVenueBudget, RedisVenueBudget, type VenueBudget } from '@crypton/exchange-core';
import { BusService } from '../bus';

/**
 * Presupuesto de caudal por venue para la API.
 *
 * Es el MISMO que el del worker, y esa es toda la gracia: comparten
 * `WORKER_EGRESS_ID`, así que comparten el depósito de fichas en Redis. Los
 * límites de los DEX se cuentan por IP y la API y el worker salen por la misma.
 *
 * Antes la API no tenía ninguno. `createPublicAdapter` se construía sin
 * `budget`, o sea con `NO_BUDGET`: el cron de precios y cada petición de velas
 * gastaban cupo de Lighter sin apuntarlo en ninguna parte, y el worker creía
 * tener el depósito entero para él. Entre los dos llegaron a las 60 peticiones
 * por minuto que Lighter da a una cuenta sin autenticar, y su cortafuegos
 * empezó a devolver una página CAPTCHA.
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
