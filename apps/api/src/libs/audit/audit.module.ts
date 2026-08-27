import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global como `DbModule`: la bitacora la escriben el filtro de excepciones, el
 * interceptor y media docena de servicios de dominio. Importarla en cada modulo
 * seria ceremonia sin nada a cambio.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
