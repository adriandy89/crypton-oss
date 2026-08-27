import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  BacktestSource,
  BarPath,
  SourceMarketType,
  type CandleInterval,
} from '@crypton/shared';

/**
 * Intervalos con los que un backtest significa algo.
 *
 * `1m` queda FUERA aunque las fuentes lo sirvan: treinta días en velas de minuto
 * son 43 200 barras y unos 33 segundos de CPU, y aporta muy poco frente a 5m
 * —el motor real reconcilia cada quince segundos, así que una vela de cinco
 * minutos ya reconcilia más a menudo que en vivo—.
 *
 * `1w`, `3d` y `1M` también quedan fuera, por el motivo contrario: la hipótesis
 * sobre el orden de máximo y mínimo dentro de la vela no significa nada a esa
 * escala, y `candleSpanMs('1M')` es una aproximación de 31 días declarada como
 * tal.
 */
export const BACKTESTABLE_INTERVALS: readonly CandleInterval[] = [
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '12h',
  '1d',
];

export class CreateBacktestDto {
  @IsUUID()
  botId!: string;

  @IsEnum(BacktestSource)
  source!: BacktestSource;

  @IsOptional()
  @IsEnum(SourceMarketType)
  marketType?: SourceMarketType;

  /**
   * «Símbolo de origen alternativo», el mismo concepto que ya existe para el
   * feed de precio en vivo: la base del venue no siempre casa con `<BASE>USDT`.
   *
   * Viaja en la petición y NO se lee de la configuración del bot: el par que el
   * administrador quiere reproducir puede no ser el del bot, y tomarlo de allí
   * escondería justo el caso que este campo existe para resolver.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Z0-9]{2,32}$/, {
    message:
      'El símbolo de origen se escribe en mayúsculas y sin separadores: «1000PEPEUSDT».',
  })
  symbolOverride?: string;

  @IsIn(BACKTESTABLE_INTERVALS)
  interval!: CandleInterval;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromMs!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  toMs!: number;

  // ── Parámetros de la simulación ────────────────────────────────────────
  //
  // Todos opcionales, pero ninguno es cosmético: son EXACTAMENTE lo que hace
  // comparables dos ejecuciones, y por eso viajan enteros al resultado.
  //
  // Se validan con `@Matches` y no con `@IsNumberString`: hay que rechazar la
  // notación científica y los negativos ANTES de que lleguen a `new Decimal()`.

  @IsOptional()
  @Matches(/^\d+(\.\d+)?$/)
  startingBalance?: string;

  @IsOptional()
  @Matches(/^0(\.\d+)?$/)
  makerFeeRate?: string;

  @IsOptional()
  @Matches(/^0(\.\d+)?$/)
  takerFeeRate?: string;

  @IsOptional()
  @Matches(/^0(\.\d+)?$/)
  slippageRate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.2)
  maintenanceMarginRate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  spreadBps?: number;

  @IsOptional()
  @IsEnum(BarPath)
  barPath?: BarPath;
}

export class ListBacktestsQueryDto {
  @IsOptional()
  @IsUUID()
  botId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
