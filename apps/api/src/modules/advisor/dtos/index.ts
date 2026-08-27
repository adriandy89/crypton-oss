import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { StrategyKind, Venue } from '@crypton/db';

/**
 * Petición de recomendaciones.
 *
 * Va por POST y no por GET a propósito: el cuerpo lleva el capital del usuario y
 * no debe acabar en la URL —ni en los registros de ningún proxy—, y la respuesta
 * no debería cachearla el navegador.
 */
export class RecommendDto {
  @IsEnum(Venue)
  venue: Venue;

  /**
   * Mismo patrón que el resto de la API: lista NEGRA, no blanca. Hay pares con
   * nombre en chino en el catálogo, y `:` se excluye porque el símbolo entra en
   * claves de Redis compuestas con dos puntos.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  // eslint-disable-next-line no-control-regex -- el rango de control esta a proposito: es el saneado que rechaza caracteres de control en un simbolo
  @Matches(/^[^\s,:|\u0000-\u001f]+$/)
  symbol: string;

  @IsEnum(StrategyKind)
  strategy: StrategyKind;

  /**
   * Cadena, como todo lo monetario del sistema: en coma flotante se pierde.
   *
   * El patrón exige un decimal POSITIVO. Con `@IsNumberString()` a secas pasaban
   * `"0"` y `"-500"`, y el endpoint respondía 200 con la lista de perfiles vacía
   * y un aviso sin sentido en vez de un 400 diciendo qué está mal.
   */
  @Matches(/^(?!0+(\.0+)?$)\d+(\.\d+)?$/, {
    message: 'totalInvestment debe ser un número positivo.',
  })
  @IsNumberString()
  totalInvestment: string;

  /**
   * `@Transform` y no `@Type(() => Boolean)`: el segundo aplica `Boolean(v)`, y
   * `Boolean('false')` es `true`. Un cliente que mandara la cadena `"false"`
   * acababa pidiendo specs y velas de TESTNET sin enterarse.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  testnet?: boolean;

  @IsOptional()
  @IsIn(['LONG', 'SHORT', 'NEUTRAL'])
  direction?: 'LONG' | 'SHORT' | 'NEUTRAL';
}
