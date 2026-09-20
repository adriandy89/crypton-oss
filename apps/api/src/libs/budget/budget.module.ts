import { Global, Module } from '@nestjs/common';
import { CaudalMonitorService } from './caudal-monitor.service';
import { VenueBudgetProvider } from './venue-budget.provider';

// Global y con UNA sola instancia: si cada módulo tuviera la suya no sería un
// presupuesto compartido, que es justo lo único que hace falta que sea.
@Global()
@Module({
  // El vigilante no se exporta: no lo inyecta nadie, arranca solo con el
  // modulo y escribe en el log. Exportarlo seria superficie que nadie usa.
  providers: [VenueBudgetProvider, CaudalMonitorService],
  exports: [VenueBudgetProvider],
})
export class BudgetModule {}
