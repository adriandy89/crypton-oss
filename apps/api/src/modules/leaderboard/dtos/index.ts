import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { LeaderboardPeriod, StrategyKind, Venue } from '@crypton/db';

export class ListLeaderboardDto {
  @IsOptional()
  @IsEnum(LeaderboardPeriod)
  period?: LeaderboardPeriod;

  @IsOptional()
  @IsEnum(Venue)
  venue?: Venue;

  @IsOptional()
  @IsEnum(StrategyKind)
  strategy?: StrategyKind;

  @IsOptional()
  @IsString()
  symbol?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ShareBotDto {
  /** false deja de listarlo sin borrar el codigo ya repartido. */
  @IsOptional()
  @IsBoolean()
  public?: boolean;
}

export class CopyShareDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsUUID()
  exchangeAccountId: string;

  @IsString()
  @IsNotEmpty()
  symbol: string;

  /**
   * Capital que asigna QUIEN COPIA. Es obligatorio a proposito: los importes de
   * la configuracion compartida se reexpanden contra este numero, nunca contra
   * el del autor.
   */
  @IsNumberString()
  totalInvestment: string;
}
