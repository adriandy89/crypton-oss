/**
 * La curva agregada de la cartera (spec 003).
 *
 * El worker escribe una fila por usuario y red cada cinco minutos en
 * `portfolio_snapshots`, a partir del último snapshot de cada bot real vivo; la
 * API la sirve agregada por extremos como la serie de un bot; la app la pinta
 * con el mismo `ui-spark`. Lo que aquí se declara es el contrato entre los tres,
 * y las constantes que los tres tienen que compartir para que la línea se rompa
 * donde de verdad no hubo dato y no donde a uno de ellos le pareció.
 *
 * Se llama «resultado» y no «equity» por la misma razón que la serie del bot:
 * `pnl = realizado + no realizado`, la misma definición que `bot_snapshots.equity`.
 * No es patrimonio: los saldos reales del venue no entran en esta pantalla.
 */

/** Cadencia de escritura de `portfolio_snapshots`: el cron del worker, cinco minutos. */
export const PORTFOLIO_CADENCE_MS = 5 * 60_000;

/**
 * Las ventanas que ofrece la cartera. Un año porque la retención por defecto es
 * de 365 días (`RETENTION_PORTFOLIO_DAYS`); más no tendría dato que enseñar.
 */
export const PORTFOLIO_RANGES = ['24h', '7d', '30d', '1y'] as const;
export type PortfolioRange = (typeof PORTFOLIO_RANGES)[number];

export const PORTFOLIO_RANGE_MS: Record<PortfolioRange, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
  '1y': 365 * 24 * 3_600_000,
};

/** Una fila de la cartera tal y como viaja: dinero en cadena, tiempo en ms. */
export interface PortfolioEquityPoint {
  /** ms desde epoch del instante en que el worker la escribió. */
  t: number;
  realized: string;
  unrealized: string;
  /** `realized + unrealized`. La curva es esta columna. */
  pnl: string;
  /** Σ `total_investment` de los bots que aportan: lo que el usuario puso. */
  invested: string;
  /** Σ |posición| × precio medio: lo que hay abierto en el mercado. */
  exposure: string;
  /**
   * Cuántos bots aportaron a la fila. Cuando baja respecto a la anterior, un
   * bot dejó de sumar —se borró o lleva más de diez minutos sin escribir— y el
   * pasado NO se reescribe: la pantalla lo dice en vez de disimularlo.
   */
  bots: number;
}

export interface PortfolioEquitySeries {
  range: PortfolioRange;
  testnet: boolean;
  /** Ventana pedida, en ms desde epoch. Lo que la serie cubre de verdad lo dicen los puntos. */
  from: number;
  to: number;
  /** Cubo con el que se agregó, para que la app rompa la línea con `gapMsFor(bucketMs, cadenceMs)`. */
  bucketMs: number;
  cadenceMs: number;
  /**
   * Desde cuándo puede haber dato: `ahora − RETENTION_PORTFOLIO_DAYS`. `null` si
   * la purga está desactivada. Antes de ese instante no se midió nada, y la app
   * no debe pintarlo plano.
   */
  retentionFrom: number | null;
  /** De más viejo a más nuevo, hasta cuatro por cubo (primero, mínimo, máximo, último). */
  points: PortfolioEquityPoint[];
}
