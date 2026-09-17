import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Abrir o cortar las entradas de TODOS los bots del canal con IA (spec 059).
 *
 * El motivo es obligatorio, como en cualquier acción de la consola que toca
 * bots con dinero dentro: viaja a la bitácora.
 */
export class EntradasCanalDto {
  @ApiProperty()
  @IsBoolean()
  abiertas: boolean;

  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}

/** Las decisiones de un bot, de la más reciente hacia atrás. */
export class DecisionesCanalQueryDto {
  /** Solo las creadas antes de este instante (ISO 8601): el cursor de la página. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  antes?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limite?: number;
}

/**
 * Un bot y una de sus intenciones. Las de la IA tienen un UUID; las del juez,
 * `reglas:<bot>:<vela>`.
 */
export class DecisionCanalParamDto {
  @IsUUID()
  id: string;

  @IsString()
  @Matches(/^[0-9A-Za-z:._-]{1,80}$/)
  intentId: string;
}
