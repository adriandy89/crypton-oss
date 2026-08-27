import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Desde dónde se abre el flujo. Decide a cuál de los dos destinos configurados
 * vuelve el navegador: la app web o el enlace profundo de la app nativa.
 *
 * Es un enum cerrado a propósito. La alternativa —que el cliente mande la URL
 * de vuelta— convertiría esto en un redirect abierto con una sesión recién
 * creada dentro, que es exactamente la vulnerabilidad clásica de OAuth.
 */
export const APP_PLATFORMS = ['web', 'native'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/**
 * Un valor de 32 bytes en base64url ocupa exactamente 43 caracteres. Se exige
 * la forma completa para que nada más entre en Redis ni en la URL de vuelta.
 */
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;

export class StartGoogleAuthDto {
  @ApiProperty({ enum: APP_PLATFORMS })
  @IsIn(APP_PLATFORMS)
  platform: AppPlatform;

  @ApiProperty({
    description:
      'SHA-256 en base64url del verificador que la app se guarda. Es lo que ata el vale de ' +
      'vuelta a la aplicación que abrió el flujo.',
  })
  @IsString()
  @Matches(BASE64URL_32, {
    message: 'El reto debe ser un SHA-256 en base64url.',
  })
  challenge: string;
}

export class RedeemTicketDto {
  @ApiProperty({
    description: 'Vale de un solo uso que llega en la URL de vuelta.',
  })
  @IsString()
  @Matches(BASE64URL_32, { message: 'Vale con formato no válido.' })
  ticket: string;

  @ApiProperty({
    description: 'El verificador cuyo SHA-256 se envió al arrancar el flujo.',
  })
  @IsString()
  @Matches(BASE64URL_32, { message: 'Verificador con formato no válido.' })
  verifier: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
