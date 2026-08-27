import type { Venue } from './enums';

/**
 * Intervalos de vela, en el vocabulario único del sistema.
 *
 * La lista es la UNIÓN de lo que sirven los tres venues, no la intersección:
 * recortarla al mínimo común escondería que Hyperliquid y Aster sí dan velas de
 * 3 minutos, y la app dejaría de poder ofrecerlas nunca. Qué subconjunto vale
 * para cada venue lo dice `VenueCapabilities`, no este tipo.
 */
export const CANDLE_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/**
 * Duración de cada intervalo en milisegundos.
 *
 * `1M` no está: un mes no dura un número fijo de milisegundos y fingir que sí
 * hace que las peticiones se desalineen unos días al año. Quien necesite
 * acotar un rango mensual usa `candleSpanMs`, que devuelve el peor caso.
 */
export const INTERVAL_MS: Record<Exclude<CandleInterval, '1M'>, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
};

/** Milisegundos que ocupa un intervalo; para `1M` se toma 31 días. */
export function candleSpanMs(interval: CandleInterval): number {
  return interval === '1M' ? 31 * 86_400_000 : INTERVAL_MS[interval];
}

export function isCandleInterval(value: unknown): value is CandleInterval {
  return typeof value === 'string' && (CANDLE_INTERVALS as readonly string[]).includes(value);
}

/**
 * Una vela normalizada.
 *
 * Los precios van como string por el mismo motivo que en `MarketSpec`: un
 * `number` de JavaScript no representa exactamente 0,1 y una serie de precios
 * que ha pasado por coma flotante ya no se puede comparar con el tick del
 * venue. Lighter los sirve como number y su adaptador es quien tiene que
 * convertirlos — no el resto del sistema.
 */
export interface Candle {
  /** Apertura del intervalo, en ms desde epoch. Es la clave de la vela. */
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  /** Volumen en moneda BASE. null cuando el venue no lo expone. */
  v: string | null;
}

/**
 * Lo que un venue sabe hacer con las velas.
 *
 * Existe para que la interfaz no lleve una tabla fija de intervalos. La app
 * pinta su barra a partir de esto, así que añadir un venue —o que uno de ellos
 * publique un intervalo nuevo— no obliga a tocar el frontend.
 */
export interface CandleCapabilities {
  /** Intervalos que este venue sirve, en el orden en que conviene enseñarlos. */
  intervals: CandleInterval[];
  /** Máximo de velas por petición. Por encima, hay que paginar. */
  maxBars: number;
  /** true = hay stream nativo de velas; false = se compone desde el ticker. */
  live: boolean;
  /**
   * Cuántas páginas de pasado puede pedir el gráfico, y con cuánto hueco entre
   * ellas.
   *
   * Viajan aquí y no como una tabla en el cliente por el mismo motivo que
   * `maxBars`: la app no lleva tablas de venues —lo dicen tres comentarios
   * distintos del proyecto— y añadir un venue no debe obligar a tocar el
   * frontend.
   *
   * Existen porque el presupuesto de caudal NO es el mismo en los tres, y la
   * diferencia es enorme: Hyperliquid cuenta PESO (1200/min, y una página pesa
   * ~25) mientras que Lighter cuenta PETICIONES (60/min), así que allí una sola
   * página se lleva más de un segundo del presupuesto entero de la IP — el
   * mismo que los bots usan para cancelar.
   */
  maxHistoryPages: number;
  minPageGapMs: number;
}

export interface VenueCapabilities {
  venue: Venue;
  candles: CandleCapabilities;
}

/**
 * Precio y estadísticas de 24 h de un mercado.
 *
 * Es lo que pinta una fila de la lista de mercados, y deliberadamente NO es
 * `Ticker`: aquel describe el estado instantáneo del libro para decidir una
 * orden, y este describe la sesión para que un humano compare mercados. Los
 * venues los sirven además por caminos distintos —uno por símbolo, este en
 * lote— y mezclarlos llevaría a pedir doscientas veces lo que se puede pedir
 * una.
 */
export interface MarketTicker {
  venue: Venue;
  symbol: string;
  /** Último precio negociado. */
  last: string;
  /** Cambio absoluto en 24 h, en la quote. null si el venue no lo da. */
  change24h: string | null;
  /** Cambio porcentual en 24 h. null si el venue no lo da. */
  changePct24h: string | null;
  high24h: string | null;
  low24h: string | null;
  /** Volumen de 24 h en moneda QUOTE: es el que permite comparar mercados. */
  volume24h: string | null;
  ts: number;
}
