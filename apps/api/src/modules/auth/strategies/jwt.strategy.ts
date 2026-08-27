import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireSecret } from 'src/libs';
import { SessionUser } from '../interfaces';

/**
 * Lo que viaja firmado dentro del access token.
 *
 * Se deriva de `SessionUser` en vez de repetir la forma a mano: `signAccess()`
 * en `token.service.ts` firma exactamente el usuario menos el `id`, y pone ese
 * id en el `subject`, que es de donde sale `sub`. Escrito aparte, cualquier
 * claim que se anadiera alli se olvidaria aqui y volveria como `undefined`.
 */
type AccessTokenPayload = Omit<SessionUser, 'id' | 'language'> & {
  sub: string;
  language?: string;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireSecret(config, 'JWT_ACCESS_SECRET'),
    });
  }

  // Los claims van firmados dentro del token: ninguna petición toca la BD solo
  // para saber quién eres.
  validate(payload: AccessTokenPayload): SessionUser {
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      language: payload.language ?? 'es',
    };
  }
}
