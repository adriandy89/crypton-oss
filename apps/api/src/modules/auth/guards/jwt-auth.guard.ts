import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Bearer-token guard. Drop-in replacement for the origin's SessionGuard. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

/** Alias so code ported from the session-based origin compiles unchanged. */
export { JwtAuthGuard as SessionGuard };
