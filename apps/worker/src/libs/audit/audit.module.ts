import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** Global como DbModule: lo usan el motor, los leases y la retencion. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
