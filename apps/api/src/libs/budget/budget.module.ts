import { Global, Module } from '@nestjs/common';
import { VenueBudgetProvider } from './venue-budget.provider';

// Global y con UNA sola instancia: si cada módulo tuviera la suya no sería un
// presupuesto compartido, que es justo lo único que hace falta que sea.
@Global()
@Module({
  providers: [VenueBudgetProvider],
  exports: [VenueBudgetProvider],
})
export class BudgetModule {}
