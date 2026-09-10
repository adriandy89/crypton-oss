import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BotStatus, Role, StrategyKind, Venue } from '@crypton/db';
import { PageOptionsDto } from 'src/libs';
import { type BotCommandName } from '../../bots/dtos';

/**
 * Booleano que llega por query string.
 *
 * `?disabled=true` viaja como la CADENA 'true'. Se transforma aqui y no se
 * compara contra la cadena en cada filtro —como hace `ActivityQueryDto`— porque
 * este valor acaba entrando tal cual en el `where` de Prisma, y comparar a mano
 * en seis sitios es la clase de detalle que alguien olvida en el septimo.
 */
const BooleanQuery = () =>
  Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  );

/**
 * Columnas por las que se puede ordenar. Lista CERRADA, y no por gusto: este
 * valor acaba siendo una CLAVE del objeto `orderBy` de Prisma. Una cadena libre
 * del cliente ahi dentro es una consulta que nadie ha escrito.
 */
const ORDEN_USUARIOS = ['created_at', 'last_login_at', 'email', 'name'] as const;
export type OrdenUsuarios = (typeof ORDEN_USUARIOS)[number];

const ORDEN_BOTS = ['created_at', 'updated_at', 'last_tick_at', 'started_at', 'status'] as const;
export type OrdenBots = (typeof ORDEN_BOTS)[number];

export class AdminUsersQueryDto extends PageOptionsDto {
  /** Correo o nombre, por prefijo. Una caja para las dos cosas. */
  @ApiPropertyOptional({ description: 'Correo o nombre, por prefijo' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ enum: ['USER', 'ADMIN'] })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional()
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  disabled?: boolean;

  /** Solo cuentas con algun bot. Separa las vivas de las altas muertas. */
  @ApiPropertyOptional()
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  withBots?: boolean;

  @ApiPropertyOptional({ enum: ORDEN_USUARIOS })
  @IsOptional()
  @IsIn(ORDEN_USUARIOS)
  sortBy?: OrdenUsuarios;

  @ApiPropertyOptional({ description: 'Alta desde (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Alta hasta (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class AdminBotsQueryDto extends PageOptionsDto {
  /** El filtro de primera clase: exacto e indexado. Se llega desde la ficha. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  /**
   * Correo del dueño, por PREFIJO y no por `contains`: un `%algo%` no puede usar
   * ningun indice, nunca, y esta consulta se ejecuta dos veces (filas y total).
   */
  @ApiPropertyOptional({ description: 'Correo del dueño, por prefijo' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;

  @ApiPropertyOptional({ enum: Venue })
  @IsOptional()
  @IsEnum(Venue)
  venue?: Venue;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  symbol?: string;

  @ApiPropertyOptional({ enum: StrategyKind })
  @IsOptional()
  @IsEnum(StrategyKind)
  strategy?: StrategyKind;

  @ApiPropertyOptional({ enum: BotStatus })
  @IsOptional()
  @IsEnum(BotStatus)
  status?: BotStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  dryRun?: boolean;

  /** «Enseñame lo que esta roto»: `last_error IS NOT NULL`. */
  @ApiPropertyOptional()
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  withError?: boolean;

  @ApiPropertyOptional({ enum: ORDEN_BOTS })
  @IsOptional()
  @IsIn(ORDEN_BOTS)
  sortBy?: OrdenBots;
}

/**
 * El vocabulario de CONTENCION: lo que un administrador puede pedirle al bot de
 * otra persona, y nada mas.
 *
 * `satisfies readonly BotCommandName[]` no es adorno: ata esta lista al enum
 * real de comandos, asi que renombrar uno en `bots/dtos` rompe la compilacion
 * AQUI en vez de dejar una lista blanca que ya no casa con nada y que, al no
 * casar, dejaria de permitir lo que debia o —peor— permitiria otra cosa.
 *
 * Los dos que quedan comparten la propiedad que los hace admisibles: NINGUNO
 * toca la posicion y NINGUNO retira el stop-loss nativo del venue.
 *
 * Lo que queda fuera, y por que:
 *
 * - `STOP_AND_CLOSE`, `CLOSE_NOW`, `PANIC` y `TAKE_PROFIT_NOW` cierran a mercado
 *   y realizan el resultado. Eso es disponer del dinero de otro.
 * - `CANCEL_ALL_ORDERS` cancela TAMBIEN el stop-loss —es una orden condicional
 *   nativa que sobrevive a que el worker muera y sobrevive a PAUSE, pero no a
 *   esto—, asi que sobre una posicion apalancada la deja desnuda y sin nadie
 *   vigilandola. Es la unica «contencion» capaz de dejar a un usuario peor
 *   protegido que antes, y por eso no esta: contener no puede empeorar nada.
 * - `START`, `RESUME`, `REANCHOR_GRID`, `ADD_SAFETY_NOW` y `ADJUST_MARGIN` abren
 *   riesgo o comprometen margen nuevo.
 * - `REPAIR` toca la reconciliacion de un bot ajeno sin que su dueño lo sepa.
 */
export const ADMIN_COMMANDS = [
  'PAUSE',
  'STOP_KEEP_POSITION',
] as const satisfies readonly BotCommandName[];

export type AdminBotCommandName = (typeof ADMIN_COMMANDS)[number];

export class AdminBotCommandDto {
  @ApiPropertyOptional({ enum: ADMIN_COMMANDS })
  @IsIn(ADMIN_COMMANDS)
  command: AdminBotCommandName;

  /**
   * Obligatorio, y por eso no es opcional como en el resto de la casa.
   *
   * Es lo unico que hace revisable despues una accion sobre el bot de otra
   * persona: viaja a `activity_log.meta` y al evento del bot. Un panel de
   * administracion sin motivos es un panel donde nadie rinde cuentas.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}

export class DisableUserDto {
  /** Mismo motivo que en `AdminBotCommandDto.reason`. */
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}

/**
 * Lo que se puede purgar a mano desde la consola (spec 034).
 *
 * La lista es CERRADA y corta, y lo que NO esta es tan importante como lo que
 * esta:
 *
 * - `bot_orders`, `bot_fills` y `bot_cycles` NO se purgan por antigüedad. Son la
 *   reconciliacion del motor —el worker lee ordenes por estado y por ciclo—, la
 *   contabilidad del PnL realizado y el historial que su dueño ve en la app.
 * - `bot_config_revisions` tampoco: `bot.config_version` apunta a una de sus
 *   filas, asi que borrarla deja al bot señalando al vacio.
 */
export const PURGE_SCOPES = [
  'BOT_SNAPSHOTS',
  'BOT_EVENTS',
  'BOT_COMMANDS',
  'PORTFOLIO_SNAPSHOTS',
  'BACKTESTS',
  'ACTIVITY_LOG',
] as const;
export type PurgeScope = (typeof PURGE_SCOPES)[number];

/**
 * Las antigüedades que ofrece la pantalla. Cerrada a proposito: un campo libre
 * de dias invita a teclear un 1 con la mano torcida.
 */
export const PURGE_DAYS = [15, 30, 90, 180] as const;

export class PurgeDto {
  @ApiPropertyOptional({ enum: PURGE_SCOPES })
  @IsIn(PURGE_SCOPES)
  scope: PurgeScope;

  @ApiPropertyOptional({ enum: PURGE_DAYS })
  @Type(() => Number)
  @IsIn(PURGE_DAYS)
  days: number;
}

export class PurgeConfirmDto extends PurgeDto {
  /** Igual que en los comandos: sin motivo, la accion no es revisable despues. */
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}
