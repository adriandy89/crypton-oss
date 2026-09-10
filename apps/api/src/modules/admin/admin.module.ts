import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { BotsModule } from '../bots';
import { AdminBotsController } from './admin-bots.controller';
import { AdminBotsService } from './admin-bots.service';
import { AdminMaintenanceController } from './admin-maintenance.controller';
import { AdminMaintenanceService } from './admin-maintenance.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/**
 * La consola de administracion: mirar y contener.
 *
 * Un solo modulo para las dos superficies —cuentas y bots— y no dos sueltos,
 * porque la propiedad que de verdad importa es «TODA la administracion esta
 * cerrada por rol», y con un directorio eso se comprueba con un `grep` y un
 * test. Con dos modulos registrados en sitios distintos, el tercero que alguien
 * añada mañana se cuelga en otra parte y nadie lo nota.
 *
 * La bitacora vive aparte, en `ActivityModule`, sirviendo `admin/activity` desde
 * el spec 007: su propio modulo declara que es de LECTURA y que la escritura
 * vive en `libs/audit`. Meterle usuarios y bots lo convertiria en «el modulo de
 * administracion» y ese comentario dejaria de ser verdad.
 *
 * `ExchangeAccountsModule` NO se importa, y la ausencia es lo importante: es la
 * puerta a `openAdapter()`, que descifra la clave de firma del usuario
 * (invariante 8). Ningun camino de administracion puede llegar a un secreto en
 * claro, y la forma mas barata de garantizarlo es que este modulo no tenga con
 * que. Quien mañana necesite el saldo de una cuenta ajena y venga a importarlo:
 * eso es exactamente lo que este parrafo pide que no hagas.
 */
@Module({
  imports: [BotsModule, AuthModule],
  controllers: [AdminUsersController, AdminBotsController, AdminMaintenanceController],
  providers: [AdminUsersService, AdminBotsService, AdminMaintenanceService],
})
export class AdminModule {}
