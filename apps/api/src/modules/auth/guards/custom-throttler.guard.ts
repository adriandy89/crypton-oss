import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Authenticated (JWT) requests are tracked per user id
    if (req.user?.id) {
      return req.user.id;
    }
    // Fallback to IP for public routes (arranque y canje del acceso con Google…)
    return req.ip;
  }
}
