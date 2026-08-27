import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { ExchangeAccountsController } from './exchange-accounts.controller';
import { ExchangeAccountsService } from './exchange-accounts.service';

// AuthModule por la reautenticación del alta: conectar una clave de firma no
// puede depender solo de tener un token de acceso válido.
@Module({
  imports: [AuthModule],
  controllers: [ExchangeAccountsController],
  providers: [ExchangeAccountsService],
  exports: [ExchangeAccountsService],
})
export class ExchangeAccountsModule {}
