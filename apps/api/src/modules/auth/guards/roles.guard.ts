import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@crypton/db';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { SessionUser } from '../interfaces';

/**
 * Deja pasar solo a los roles que la ruta declare con `@Roles(...)`.
 *
 * Va SIEMPRE detrás de `JwtAuthGuard`: sin usuario resuelto no hay rol que
 * mirar, y este guard no autentica a nadie.
 *
 * ── La línea que de verdad importa ──────────────────────────────────────────
 *
 * **Sin metadata, deja pasar.** No es una laguna, es el contrato: este guard
 * restringe lo que alguien ha marcado explícitamente, no protege por defecto. Si
 * se cambiara para denegar cuando no hay `@Roles`, bastaría con registrarlo una
 * vez de forma global —o ponerlo en un controlador y olvidar el decorador en un
 * método— para cerrar la API entera a todo el mundo sin que ningún test lo
 * notara. Tiene su propio caso de prueba justo por eso.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // El método gana sobre la clase: permite abrir una ruta concreta dentro de
    // un controlador restringido, o al revés.
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<{ user?: SessionUser }>().user;
    // Sin usuario no se cae con un 500: si `JwtAuthGuard` no corrió, lo honesto
    // es negar, no reventar.
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Esta operación es solo para administradores.');
    }
    return true;
  }
}
