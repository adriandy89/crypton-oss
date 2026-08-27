import { Global, Module } from '@nestjs/common';
import { VenueBudgetProvider } from './venue-budget.provider';

// Global: lo necesitan tanto los adaptadores de cuenta como el feed publico de
// precios, y tiene que ser el MISMO objeto en los dos — si no, no seria un
// presupuesto compartido.
@Global()
@Module({
  providers: [VenueBudgetProvider],
  exports: [VenueBudgetProvider],
})
export class BudgetModule {}
