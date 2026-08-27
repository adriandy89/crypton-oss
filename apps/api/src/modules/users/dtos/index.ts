import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, MaxLength, Matches } from 'class-validator';

/** Monedas en las que se pueden mostrar los importes. */
export const DISPLAY_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: 'Nombre visible.' })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  name?: string;

  @ApiPropertyOptional({ description: 'Descripción breve. Solo la ves tú.' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string;

  // La cadena vacía se ACEPTA a propósito: en este PATCH significa «bórralo»
  // (`users.service` la convierte en NULL), y sin ella la pantalla de perfil
  // devolvía un 400 a quien guardaba cambios sin tener país puesto.
  @ApiPropertyOptional({
    description: 'Código ISO de dos letras, o cadena vacía para borrarlo.',
    example: 'ES',
  })
  @IsOptional()
  @IsString()
  @Matches(/^([A-Za-z]{2})?$/, {
    message: 'El país debe ser un código de dos letras (ES, MX…).',
  })
  country?: string;

  @ApiPropertyOptional({
    description: 'Zona horaria IANA, o cadena vacía para borrarla.',
    example: 'Europe/Madrid',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  // Igual que `country`: vacío = volver al valor por defecto, no un 400.
  @ApiPropertyOptional({ enum: DISPLAY_CURRENCIES })
  @IsOptional()
  @IsIn([...DISPLAY_CURRENCIES, ''])
  displayCurrency?: string;

  @ApiPropertyOptional({ description: 'Idioma de la interfaz.', example: 'es' })
  @IsOptional()
  @IsIn(['es', 'en'])
  language?: string;
}

/**
 * Borrar la cuenta exige escribir la palabra.
 *
 * Es irreversible y se lleva por delante bots, credenciales e histórico. Un
 * botón con una confirmación de un clic no está a la altura de eso.
 *
 * La prueba de identidad no viaja en este cuerpo: es una reautenticación con
 * Google hecha justo antes, que el controlador consume con `assertStepUp`.
 */
export class DeleteAccountDto {
  @ApiProperty({ description: 'Debe ser exactamente ELIMINAR.' })
  @IsString()
  @IsIn(['ELIMINAR'], { message: 'Escribe ELIMINAR para confirmar.' })
  confirm: string;
}
