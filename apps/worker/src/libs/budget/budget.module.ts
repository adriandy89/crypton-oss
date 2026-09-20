import { Global, Module } from '@nestjs/common';
import { CaudalMonitorService } from './caudal-monitor.service';
import { VenueBudgetProvider } from './venue-budget.provider';

// Global: lo necesitan tanto los adaptadores de cuenta como el feed publico de
// precios, y tiene que ser el MISMO objeto en los dos — si no, no seria un
// presupuesto compartido.
@Global()
@Module({
  // El vigilante no se exporta: no lo inyecta nadie, arranca solo con el
  // modulo y escribe en el log. Exportarlo seria superficie que nadie usa.
  providers: [VenueBudgetProvider, CaudalMonitorService],
  exports: [VenueBudgetProvider],
})
export class BudgetModule {}
