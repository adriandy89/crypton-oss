import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { ActorKind, EventSeverity } from '@crypton/db';
import { PageOptionsDto } from 'src/libs';

/**
 * Filtros de la bitacora.
 *
 * Extiende `PageOptionsDto`, que ya existia en `libs/common/pagination` y no lo
 * usaba nadie: trae `page`, `limit` (tope 101) y `sortOrder` ya validados.
 */
export class ActivityQueryDto extends PageOptionsDto {
  /** Un usuario concreto. Es texto y no UUID: tambien identifica a un worker. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorId?: string;

  @IsOptional()
  @IsEnum(ActorKind)
  actor?: ActorKind;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  botId?: string;

  /** Prefijo de accion: `bot.` trae todas las de bots. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  @IsOptional()
  @IsEnum(EventSeverity)
  severity?: EventSeverity;

  @IsOptional()
  @IsIn(['OK', 'DENIED', 'ERROR'])
  outcome?: 'OK' | 'DENIED' | 'ERROR';

  /** Atajo para la pregunta del encargo: solo lo que NO salio bien. */
  @IsOptional()
  @IsIn(['true', 'false'])
  onlyFailures?: 'true' | 'false';

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
