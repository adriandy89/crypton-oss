import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiMode } from '@crypton/db';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Valida el campo solo si VIENE, pero con `null` sí valida (y falla).
 *
 * `@IsOptional` se salta los validadores tanto con `undefined` como con `null`,
 * y `set()` solo distingue `undefined`: un `trigger: null` llegaba a una columna
 * `NOT NULL` y la API respondia 500 (spec 053, H-04). Para los campos que no
 * admiten «vaciarse», omitirlos es la unica forma de no tocarlos.
 */
const SiViene = () => ValidateIf((_objeto: unknown, valor: unknown) => valor !== undefined);

/** Cuando revisa el supervisor. `VarChar` en la base: el vocabulario crecera. */
export const AI_TRIGGERS = ['PERIODICO', 'OPERACION', 'AMBOS'] as const;
export type AiTrigger = (typeof AI_TRIGGERS)[number];

/** Los tres modos, calcados del enum de Prisma. */
export const AI_MODES = [AiMode.OFF, AiMode.MANUAL, AiMode.AUTO] as const;

export class SetAiModeDto {
  /** Obligatorio en cada llamada, tambien cuando solo cambian las opciones. */
  @ApiProperty({ enum: AI_MODES })
  @IsIn(AI_MODES)
  mode: AiMode;

  @ApiPropertyOptional({ enum: AI_TRIGGERS })
  @SiViene()
  @IsIn(AI_TRIGGERS)
  trigger?: AiTrigger;

  /**
   * Minutos entre revisiones. El suelo son diez, que es el hueco minimo entre
   * llamadas pagadas: pedir menos no las haria mas frecuentes, solo mas caras
   * de descartar.
   *
   * `null` es un valor con significado: «el que recomiende la estrategia». Es la
   * forma de deshacer un intervalo puesto a mano (spec 053).
   */
  @ApiPropertyOptional({ minimum: 10, maximum: 1440, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(1440)
  reviewEveryMinutes?: number | null;

  /**
   * false = el supervisor solo propone cambios HOT, que no tocan ninguna orden.
   * Un cambio WARM cancela lo del bot y lo vuelve a tender, y eso cuesta
   * comisiones de verdad.
   */
  @ApiPropertyOptional()
  @SiViene()
  @IsBoolean()
  allowWarm?: boolean;

  /**
   * Obligatorio, como en `AdminBotCommandDto`.
   *
   * Encender un agente que reescribe la configuracion de un bot con dinero
   * dentro es una accion de administracion, y se trata como tal: el motivo viaja
   * a `activity_log.meta` y al evento del bot. Que sea un bot propio no lo hace
   * menos revisable — lo hace mas facil de olvidar.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}
