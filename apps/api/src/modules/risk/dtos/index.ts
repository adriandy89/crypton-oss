import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumberString,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Un tope tiene que ser MAYOR QUE CERO, y omitirlo es como se dice «sin límite».
 *
 * Cero no es una configuración que nadie quiera: significa «frena siempre». Y no
 * era inofensivo aceptarlo. El worker recibe las guardas como CADENAS
 * (`limits.max_notional_per_bot?.toString()`) y las comprueba por veracidad
 * —`if (g.maxNotionalPerBot && …)`—, y la cadena `'0'` es veraz en JavaScript.
 * Así que un cero guardado no solo impedía crear bots: pausaba TODOS los que ya
 * estuvieran corriendo en cuanto tuvieran posición. Alguien que escribiera `0`
 * creyendo que significa «sin límite» se apagaba la plataforma entera.
 *
 * Los enteros de aquí abajo ya se protegían con `@Min(1)`; los decimales no. Es
 * el mismo patrón que ya resolvió `totalInvestment` en el módulo `advisor`.
 */
const POSITIVO = /^(?!0+(\.0+)?$)\d+(\.\d+)?$/;

const mensaje = (campo: string): string =>
  `${campo} debe ser mayor que cero. Deja el campo vacío para no poner límite.`;

export class UpdateRiskLimitsDto {
  /** Notional máximo de un solo bot (margen x apalancamiento). */
  @IsOptional()
  @Matches(POSITIVO, { message: mensaje('maxNotionalPerBot') })
  @IsNumberString()
  maxNotionalPerBot?: string;

  /** Notional agregado de todos los bots vivos. */
  @IsOptional()
  @Matches(POSITIVO, { message: mensaje('maxTotalNotional') })
  @IsNumberString()
  maxTotalNotional?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  maxLeverage?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  maxOpenBots?: number;

  /** Pérdida diaria a partir de la cual no se arrancan bots nuevos. */
  @IsOptional()
  @Matches(POSITIVO, { message: mensaje('maxDailyLoss') })
  @IsNumberString()
  maxDailyLoss?: string;

  /** Caída (%) que pausa el bot automáticamente. */
  @IsOptional()
  @Matches(POSITIVO, { message: mensaje('killSwitchDrawdownPct') })
  @IsNumberString()
  killSwitchDrawdownPct?: string;

  /**
   * Distancia (%) a liquidación por debajo de la cual se alerta.
   *
   * La ÚNICA que sí admite cero, y por eso no lleva `@Matches`: aquí un cero no
   * significa «frena siempre» sino «no me avises nunca», que es un uso legítimo
   * para quien no quiera esa alerta. En los otros cuatro, cero es siempre una
   * errata.
   */
  @IsOptional()
  @IsNumberString()
  liquidationAlertPct?: string;
}
