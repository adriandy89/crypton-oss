import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Qué eventos quiere recibir el usuario por Telegram.
 *
 * Cada campo es opcional: un PATCH parcial solo toca lo que envía. Por defecto
 * se activan los avisos que importan —errores, riesgo, liquidación— y quedan
 * apagados los de alta frecuencia: un market maker genera decenas de fills por
 * hora y notificarlos todos convierte el canal en ruido que se acaba silenciando,
 * justo antes de que llegue el aviso que sí había que leer.
 */
export class UpdateTelegramPrefsDto {
  @IsOptional()
  @IsBoolean()
  fills?: boolean;

  @IsOptional()
  @IsBoolean()
  cycles?: boolean;

  @IsOptional()
  @IsBoolean()
  errors?: boolean;

  @IsOptional()
  @IsBoolean()
  risk?: boolean;

  @IsOptional()
  @IsBoolean()
  liquidation?: boolean;

  @IsOptional()
  @IsBoolean()
  daily?: boolean;
}

export interface TelegramPrefs {
  fills: boolean;
  cycles: boolean;
  errors: boolean;
  risk: boolean;
  liquidation: boolean;
  daily: boolean;
}

export const DEFAULT_TELEGRAM_PREFS: TelegramPrefs = {
  fills: false,
  cycles: true,
  errors: true,
  risk: true,
  liquidation: true,
  daily: true,
};
