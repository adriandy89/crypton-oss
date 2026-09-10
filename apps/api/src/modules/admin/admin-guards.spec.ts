import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard, RolesGuard } from '../auth/guards';
import { AdminBotsController } from './admin-bots.controller';
import { AdminMaintenanceController } from './admin-maintenance.controller';
import { AdminUsersController } from './admin-users.controller';

/**
 * Que TODA la superficie de administracion este cerrada por rol.
 *
 * `RolesGuard` restringe pero no protege por defecto: sin metadata deja pasar,
 * y su propio spec congela ese contrato. En este modulo eso significa que un
 * controlador al que se le olvide el decorador es publico —la lista de correos
 * de todos los usuarios, o los bots de todo el mundo—, y no habria nada que lo
 * delatase salvo alguien mirando.
 *
 * Este fichero es ese alguien, y corre en milisegundos sin infraestructura.
 */
describe('la consola de administracion esta cerrada por rol', () => {
  const controladores = [
    ['AdminUsersController', AdminUsersController],
    ['AdminBotsController', AdminBotsController],
    // El mas destructivo de los tres, y el que faltaba aqui: sus rutas borran
    // filas sin vuelta atras.
    ['AdminMaintenanceController', AdminMaintenanceController],
  ] as const;

  it.each(controladores)('%s exige el rol ADMIN', (_nombre, clase) => {
    expect(Reflect.getMetadata(ROLES_KEY, clase)).toEqual(['ADMIN']);
  });

  it.each(controladores)('%s pasa por la sesion Y por el rol', (_nombre, clase) => {
    // El orden importa: `RolesGuard` lee `request.user`, que lo pone
    // `JwtAuthGuard`. Al reves, `user` seria `undefined` y el guard denegaria
    // siempre —que falla del lado seguro, pero deja la consola inservible.
    const guards = Reflect.getMetadata('__guards__', clase) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
  });
});
