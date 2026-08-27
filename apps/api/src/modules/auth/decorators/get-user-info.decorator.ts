import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { SessionUser } from '../interfaces';

/**
 * El usuario que la estrategia JWT dejó en `req.user`.
 *
 * El request va tipado y no como `any`: `getRequest()` devuelve `any` por
 * defecto, así que sin el parámetro de tipo cualquier error de nombre en un
 * claim —`request.user.rol` por `role`— compilaba y fallaba en ejecución.
 */
export const GetUserInfo = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{ user?: SessionUser }>();
  if (!request.user?.role) {
    throw new InternalServerErrorException('user out of context');
  }
  return request.user;
});
