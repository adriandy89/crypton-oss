import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SessionUser } from '../interfaces';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  /**
   * A quién se le cuentan las peticiones.
   *
   * La firma conserva el `Record<string, any>` y el `async` de la clase base:
   * es un override, y estrecharlos rompería la compatibilidad con
   * `ThrottlerGuard`. Lo que sí se estrecha es el uso, dentro.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- la base la declara asíncrona
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const { user, ip } = req as { user?: SessionUser; ip?: string };
    // Con sesión, por usuario: si no, todos los que salen por una misma IP
    // —una oficina, un móvil con NAT del operador— comparten cupo.
    if (user?.id) {
      return user.id;
    }
    // Sin sesión no hay nada mejor que la IP: es el caso del arranque y el
    // canje del acceso con Google, que ocurren antes de que exista el usuario.
    return ip ?? 'unknown';
  }
}
