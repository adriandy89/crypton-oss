import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * El guard que sustituye a los tres `if (user.role !== 'ADMIN')` sueltos.
 *
 * El caso que más importa de este fichero es el PRIMERO. Es la diferencia entre
 * un guard que restringe lo que se le pide y uno que cierra la API entera en
 * cuanto alguien lo registre de forma global o se olvide un decorador.
 */

const ctx = (user: unknown) =>
  ({
    getHandler: () => 'handler',
    getClass: () => 'clase',
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;

/** Reflector de mentira: devuelve lo que se le diga para `ROLES_KEY`. */
const reflector = (roles: unknown): Reflector =>
  ({
    getAllAndOverride: (key: string) => (key === ROLES_KEY ? roles : undefined),
  }) as never;

describe('RolesGuard', () => {
  it('SIN metadata deja pasar: restringe, no protege por defecto', () => {
    // Si esto denegara, registrar el guard de forma global —o poner @Roles en la
    // clase y olvidarlo en un método— cerraría rutas que nadie quiso cerrar, y
    // ningún test lo notaría.
    const guard = new RolesGuard(reflector(undefined));
    expect(guard.canActivate(ctx({ id: 'u1', role: 'USER' }))).toBe(true);
  });

  it('con una lista vacía tampoco restringe nada', () => {
    const guard = new RolesGuard(reflector([]));
    expect(guard.canActivate(ctx({ id: 'u1', role: 'USER' }))).toBe(true);
  });

  it('deja pasar al rol declarado', () => {
    const guard = new RolesGuard(reflector(['ADMIN']));
    expect(guard.canActivate(ctx({ id: 'u1', role: 'ADMIN' }))).toBe(true);
  });

  it('rechaza a quien no lo tiene', () => {
    const guard = new RolesGuard(reflector(['ADMIN']));
    expect(() => guard.canActivate(ctx({ id: 'u1', role: 'USER' }))).toThrow(
      ForbiddenException,
    );
  });

  it('sin usuario NIEGA, no revienta', () => {
    // Es el caso de que `JwtAuthGuard` no haya corrido antes. Lo honesto es un
    // 403, no un 500 que parezca un fallo del servidor.
    const guard = new RolesGuard(reflector(['ADMIN']));
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });

  it('el mensaje no filtra qué rol haría falta más allá de lo evidente', () => {
    const guard = new RolesGuard(reflector(['ADMIN']));
    expect(() => guard.canActivate(ctx({ id: 'u1', role: 'USER' }))).toThrow(
      /solo para administradores/i,
    );
  });
});
