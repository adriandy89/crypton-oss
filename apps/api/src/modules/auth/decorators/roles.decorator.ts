import { SetMetadata } from '@nestjs/common';
import type { Role } from '@crypton/db';

export const ROLES_KEY = 'roles';

/**
 * Restringe una ruta —o un controlador entero— a ciertos roles.
 *
 * Durante mucho tiempo no existió, y a propósito: con tres endpoints de
 * administración sueltos, un `if (user.role !== 'ADMIN')` en cada uno era más
 * corto de leer que un guard, y `activity.controller.ts` dejó escrito que el
 * momento de introducirlo sería «cuando aparezca el cuarto caso».
 *
 * El módulo de backtests trae siete rutas de golpe, así que ese momento llegó.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
