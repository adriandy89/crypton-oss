import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { PORTFOLIO_RANGES, type PortfolioRange } from '@crypton/shared';

export class PortfolioEquityQueryDto {
  /**
   * `IsIn` sobre la lista compartida y no `IsEnum`: la ventana es una unión de
   * cadenas, no un objeto enum, y así la API y la app aceptan exactamente las
   * mismas cuatro.
   */
  @IsIn(PORTFOLIO_RANGES)
  range: PortfolioRange;

  /**
   * Red del venue. Ausente = mainnet.
   *
   * `Type(() => Boolean)` NO sirve aquí: convierte cualquier cadena no vacía en
   * `true`, así que `?testnet=false` acabaría pidiendo testnet. Se transforma a
   * mano comparando con la cadena exacta, como en `market-data`.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  testnet?: boolean;
}
