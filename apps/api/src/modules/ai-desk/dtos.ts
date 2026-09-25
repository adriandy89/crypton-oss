import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AiMode, FAMILIAS_AGENTE, INTERVALOS_AGENTE, ModoDecision } from '@crypton/shared';

/**
 * Lo que llega por HTTP a los agentes de IA (spec 074). Los decoradores miran
 * tipos y listas cerradas; lo que depende de más de un campo o del servidor
 * —cuántos pares caben, los límites— lo mira `validacion.ts`.
 *
 * Toda acción que cambia un agente lleva motivo (R-9): va a la bitácora.
 */

const MODOS = Object.values(AiMode);

/** Qué hace el agente con cada clase de acción. */
export class AutonomiaAgenteDto {
  @ApiProperty({ enum: MODOS, description: 'OFF solo mide; MANUAL propone; AUTO ejecuta.' })
  @IsIn(MODOS)
  entrar: AiMode;

  @ApiProperty({ enum: MODOS, description: 'OFF nunca; MANUAL propone; AUTO aplica.' })
  @IsIn(MODOS)
  reducir: AiMode;

  @ApiProperty({ enum: MODOS, description: 'OFF nunca; MANUAL propone; AUTO aplica.' })
  @IsIn(MODOS)
  cerrar: AiMode;
}

/** La definición de un agente: lo mismo al crearlo que al editarlo. */
class DefinicionAgenteDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  nombre: string;

  /** Los pares, con su nombre del catálogo. El tope lo pone `AI_DESK_MAX_WATCHLIST`. */
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  pares: string[];

  @ApiProperty({ enum: INTERVALOS_AGENTE })
  @IsIn(INTERVALOS_AGENTE)
  intervalo: (typeof INTERVALOS_AGENTE)[number];

  @ApiProperty({ enum: FAMILIAS_AGENTE, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(FAMILIAS_AGENTE, { each: true })
  familias: string[];

  @ApiProperty({ enum: ['LONG', 'SHORT'], isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsIn(['LONG', 'SHORT'], { each: true })
  lados: ('LONG' | 'SHORT')[];

  @ApiProperty({ enum: Object.values(ModoDecision) })
  @IsIn(Object.values(ModoDecision))
  modo: ModoDecision;

  /** `LimitesAgente` entero: se valida campo a campo en el servicio. */
  @ApiProperty({ type: Object })
  @IsObject()
  limites: Record<string, unknown>;

  @ApiProperty({ type: AutonomiaAgenteDto })
  @ValidateNested()
  @Type(() => AutonomiaAgenteDto)
  autonomia: AutonomiaAgenteDto;

  /**
   * Sobre una cuenta real, crear o activar el agente, o pasar «entrar» a
   * automático, exige esta casilla marcada (R-11).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  consentimiento?: boolean;

  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}

export class CrearAgenteDto extends DefinicionAgenteDto {
  /** La cuenta del agente: fija tras crearlo. */
  @ApiProperty()
  @IsUUID()
  exchangeAccountId: string;
}

export class EditarAgenteDto extends DefinicionAgenteDto {
  /** La versión que se editó: si el agente cambió entretanto, responde 409. */
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}

/** Pausar o archivar: solo el motivo. */
export class MotivoAgenteDto {
  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}

/** Reanudar: el motivo, y el consentimiento si la cuenta es real. */
export class ReanudarAgenteDto extends MotivoAgenteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  consentimiento?: boolean;
}

/** Abrir o cortar las entradas de todos los agentes a la vez. */
export class EntradasAgentesDto {
  @ApiProperty()
  @IsBoolean()
  abiertas: boolean;

  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}

/** Lo de un agente propio, o lo de todos los suyos si no se dice cuál. */
export class FiltroAgenteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  agentId?: string;
}
