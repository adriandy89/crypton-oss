import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { GetUserInfo } from './decorators';
import { RedeemTicketDto, RefreshTokenDto, StartGoogleAuthDto } from './dtos';
import { CustomThrottlerGuard, JwtAuthGuard } from './guards';
import type { SessionUser } from './interfaces';

/**
 * Página mínima para cuando el redirect de Google llega sin nada que procesar
 * —un enlace caducado, o abierto a mano dos días después—.
 *
 * Es HTML y no JSON porque quien está al otro lado es un navegador que viene de
 * google.com, y un `{"statusCode":400}` en pantalla no le dice nada a nadie.
 * Texto fijo, sin un solo dato de la petición: esta página se le puede enseñar
 * a cualquiera que sepa fabricar una URL.
 */
const PAGINA_ENLACE_CADUCADO = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CRYPTON</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#06080d;color:#e8ecf3;
       font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
  div{max-width:32rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem;letter-spacing:.06em}
  p{margin:0;color:#8b95a7}
</style></head>
<body><div>
  <h1>Este enlace ya no vale</h1>
  <p>El acceso caduca a los pocos minutos por seguridad. Vuelve a la aplicación e inténtalo de nuevo.</p>
</div></body></html>`;

@ApiTags('auth')
@Controller('auth')
@UseGuards(CustomThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ── Entrar ────────────────────────────────────────────────────

  @Post('google/start')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Arranca el acceso con Google',
    description:
      'Devuelve la URL de Google que la app debe abrir en el navegador del sistema. Nunca en ' +
      'un WebView propio: el usuario tiene que poder ver que teclea su contraseña en google.com.',
  })
  // Límite duro: abrir flujos es barato para quien abusa y ocupa Redis.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  startGoogle(@Body() dto: StartGoogleAuthDto) {
    return this.auth.start({
      platform: dto.platform,
      ticketChallenge: dto.challenge,
    });
  }

  @Post('google/step-up')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Arranca la reautenticación antes de una operación crítica',
    description:
      'Igual que el acceso, pero para una sesión que ya existe: se le pide a Google que vuelva ' +
      'a pedir credenciales de verdad, y a la vuelta se comprueba que es la misma cuenta.',
  })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  startStepUp(@GetUserInfo() user: SessionUser, @Body() dto: StartGoogleAuthDto) {
    return this.auth.start({
      platform: dto.platform,
      ticketChallenge: dto.challenge,
      stepUpFor: user,
    });
  }

  @Get('google/callback')
  // Fuera de Swagger: no la llama un cliente, la llama el navegador viniendo de
  // Google. Documentarla como endpoint invitaría a probarla a mano.
  @ApiExcludeEndpoint()
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const destino = await this.auth.handleCallback({ code, state, error });
      res.redirect(302, destino);
    } catch (e) {
      if (e instanceof BadRequestException) {
        res.status(400).type('html').send(PAGINA_ENLACE_CADUCADO);
        return;
      }
      throw e;
    }
  }

  @Post('google/exchange')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Canjea el vale de vuelta por la sesión',
    description:
      'Exige el verificador que la app generó al arrancar el flujo: sin él, un vale interceptado ' +
      'no sirve para nada.',
  })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  exchange(@Body() dto: RedeemTicketDto) {
    return this.auth.redeemTicket(dto.ticket, dto.verifier);
  }

  // ── Sesión ────────────────────────────────────────────────────

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rota el refresh token y devuelve un par nuevo' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('sign-out')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cierra la sesión asociada a ese refresh token' })
  async signOut(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.auth.signOut(dto.refreshToken);
  }

  @Post('sign-out-all')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cierra la sesión en todos los dispositivos',
    description: 'Invalida todos los refresh tokens del usuario y la reautenticación reciente.',
  })
  async signOutEverywhere(@GetUserInfo() user: SessionUser): Promise<void> {
    await this.auth.signOutEverywhere(user.id);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Devuelve el usuario de la sesión actual' })
  me(@GetUserInfo() user: SessionUser): SessionUser {
    return user;
  }

  @Get('step-up')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Si hay una reautenticación reciente todavía válida',
    description: 'La app lo consulta para no mandar al usuario a Google dos veces seguidas.',
  })
  async stepUpState(@GetUserInfo() user: SessionUser): Promise<{ fresh: boolean }> {
    return { fresh: await this.auth.hasFreshStepUp(user.id) };
  }
}
