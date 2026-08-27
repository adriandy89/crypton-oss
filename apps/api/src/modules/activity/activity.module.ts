import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';

/**
 * Modulo de LECTURA. La escritura vive en `libs/audit`, que es global.
 *
 * Separados a proposito: escribir en la bitacora lo hace medio sistema, leerla
 * la hace un administrador. Un modulo que hiciera las dos cosas obligaria a
 * importar el controlador de admin en todas partes.
 */
@Module({
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
