import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { CacheService, requireSecret } from 'src/libs';
import { SessionRevocationService, type MotivoRevocacion } from './session-revocation.service';
import { ttlToSeconds } from './ttl';
import { SessionUser } from './interfaces';

interface RefreshPayload {
  sub: string; // user id
  jti: string; // one-time token id
  fam: string; // rotation family (one per signin)
}

const rtKey = (jti: string) => `auth:rt:${jti}`;
const famKey = (fam: string) => `auth:rtfam:${fam}`;
const userFamsKey = (sub: string) => `auth:rtuser:${sub}`;

/**
 * Access/refresh pair with rotating refresh tokens (Redis-only storage).
 * - One family per signin; exactly one live jti per family at any time.
 * - rotate(): GETDEL jti → if missing but family alive ⇒ REUSE ⇒ kill family.
 * - Password change/reset revokes every family of the user.
 */
@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly accessTtlSec: number;
  private readonly refreshSecret: string;
  private readonly refreshTtlSec: number;

  constructor(
    private jwt: JwtService,
    private cache: CacheService,
    private revocacion: SessionRevocationService,
    config: ConfigService,
  ) {
    // Sin default: un secreto de firma ausente debe impedir el arranque, no
    // degradarse a uno público. Ver `requireSecret`.
    this.accessSecret = requireSecret(config, 'JWT_ACCESS_SECRET');
    this.accessTtlSec = ttlToSeconds(config.get<string>('JWT_ACCESS_TTL', '15m'));
    this.refreshSecret = requireSecret(config, 'JWT_REFRESH_SECRET');
    this.refreshTtlSec = ttlToSeconds(config.get<string>('JWT_REFRESH_TTL', '30d'));
  }

  async signAccess(user: SessionUser): Promise<string> {
    const { id, ...claims } = user;
    return this.jwt.signAsync(
      { ...claims },
      { secret: this.accessSecret, expiresIn: this.accessTtlSec, subject: id },
    );
  }

  private async signRefresh(payload: RefreshPayload): Promise<string> {
    const { sub, ...claims } = payload;
    return this.jwt.signAsync(
      { ...claims },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshTtlSec,
        subject: sub,
      },
    );
  }

  /** New family (used at signin). */
  async issuePair(user: SessionUser): Promise<{ accessToken: string; refreshToken: string }> {
    const fam = randomUUID();
    await this.cache.set(famKey(fam), user.id, this.refreshTtlSec);
    await this.cache.sAdd(userFamsKey(user.id), fam);
    await this.cache.expire(userFamsKey(user.id), this.refreshTtlSec);
    return this.mint(user, fam);
  }

  private async mint(user: SessionUser, fam: string) {
    const jti = randomUUID();
    await this.cache.set(rtKey(jti), { sub: user.id, fam }, this.refreshTtlSec);
    const [accessToken, refreshToken] = await Promise.all([
      this.signAccess(user),
      this.signRefresh({ sub: user.id, jti, fam }),
    ]);
    return { accessToken, refreshToken };
  }

  /**
   * Rotate a refresh token. Returns the verified user id + family so the
   * caller can re-load fresh claims and call reissue().
   */
  async consumeRefresh(refreshToken: string): Promise<{ sub: string; fam: string }> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('invalid_refresh');
    }
    const stored = await this.cache.getDel<{ sub: string; fam: string }>(rtKey(payload.jti));
    if (!stored) {
      // jti unknown/already used: if the family is still alive this is reuse — kill it all.
      if (await this.cache.exists(famKey(payload.fam))) {
        await this.revokeFamily(payload.sub, payload.fam);
      }
      throw new UnauthorizedException('invalid_refresh');
    }
    if (stored.fam !== payload.fam || stored.sub !== payload.sub) {
      throw new UnauthorizedException('invalid_refresh');
    }
    if (!(await this.cache.exists(famKey(payload.fam)))) {
      throw new UnauthorizedException('invalid_refresh');
    }
    return { sub: payload.sub, fam: payload.fam };
  }

  /** Second half of rotate: mint the next pair in the same family. */
  async reissue(user: SessionUser, fam: string) {
    await this.cache.expire(famKey(fam), this.refreshTtlSec);
    return this.mint(user, fam);
  }

  async revokeFamily(sub: string, fam: string): Promise<void> {
    await this.cache.del(famKey(fam));
    await this.cache.sRem(userFamsKey(sub), fam);
  }

  /**
   * Cierra TODAS las sesiones del usuario: refresh Y access.
   *
   * Antes esto solo mataba las familias de refresh, y era un cierre a medias: el
   * access token que el usuario ya tuviera en la mano seguia valiendo hasta
   * quince minutos. Sobre `signOutEverywhere()` —cuyo motivo declarado es «creo
   * que alguien ha entrado en mi cuenta»— eso significaba regalarle al intruso
   * ese cuarto de hora.
   *
   * Las dos mitades van en el mismo metodo a proposito: un llamante que mate las
   * familias y se olvide de la marca es exactamente el fallo que esto existe
   * para impedir.
   */
  async revokeAll(sub: string, motivo: MotivoRevocacion = 'sesiones_cerradas') {
    const fams = await this.cache.sMembers(userFamsKey(sub));
    if (fams?.length) {
      await this.cache.del(fams.map((f) => famKey(f)));
    }
    await this.cache.del(userFamsKey(sub));
    return this.revocacion.revoke(sub, motivo);
  }

  /** Verify a refresh token WITHOUT consuming it (logout). */
  async peekRefresh(refreshToken: string): Promise<RefreshPayload | null> {
    try {
      return await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch {
      return null;
    }
  }
}
