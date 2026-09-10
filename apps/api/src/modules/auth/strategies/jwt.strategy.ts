import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireSecret } from 'src/libs';
import { SessionUser } from '../interfaces';
import { SessionRevocationService } from '../session-revocation.service';

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
  /**
   * Momento de emision, en SEGUNDOS. No lo pone `signAccess`: lo pone
   * `jsonwebtoken` solo, y por eso la revocacion pudo construirse sin cambiar
   * nada de lo que se firma.
   */
  iat: number;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly revocacion: SessionRevocationService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireSecret(config, 'JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Quien eres sale de los claims firmados: ninguna peticion toca la BASE DE
   * DATOS solo para saberlo, que sigue siendo la decision de siempre.
   *
   * Lo que si hay ahora es una lectura de Redis, y esta aqui porque no habia otro
   * sitio honesto. Deshabilitar una cuenta no le impedia nada a su dueno durante
   * los quince minutos que le quedaban al token —y una cuenta se deshabilita
   * justo cuando se sospecha que esta comprometida—. Un guard aparte habria sido
   * olvidable: hay diez controladores con `JwtAuthGuard` y el undecimo habria
   * nacido sin revocacion sin que ningun test se enterase. Por aqui pasa TODA
   * validacion de un access token, y no hay forma de saltarselo.
   */
  async validate(payload: AccessTokenPayload): Promise<SessionUser> {
    if (await this.revocacion.isRevoked(payload.sub, payload.iat)) {
      throw new UnauthorizedException({
        code: 'SESSION_REVOKED',
        message: 'Tu sesion ya no es valida. Vuelve a identificarte.',
      });
    }
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      language: payload.language ?? 'es',
    };
  }
}
