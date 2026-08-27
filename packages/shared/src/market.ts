import type { Venue } from './enums';

/**
 * Metadatos de un mercado, normalizados entre venues. Se cachean en la tabla
 * `markets` y se refrescan por cron: sin ellos no se puede construir ni una
 * sola orden válida (ver `precision.ts`).
 *
 * Todos los numéricos van como string para no perder precisión al viajar por
 * JSON; se convierten con `D()` en cuanto entran a un cálculo.
 */
export interface MarketSpec {
  venue: Venue;
  /** Símbolo tal y como lo espera el venue (p.ej. 'BTC' en HL, 'BTCUSDT' en Aster). */
  symbol: string;
  /** Símbolo canónico para la UI y para agrupar entre venues: 'BTC/USDC'. */
  canonical: string;
  base: string;
  quote: string;
  tickSize: string;
  stepSize: string;
  minNotional: string | null;
  minQty: string | null;
  maxQty: string | null;
  maxLeverage: number;
  priceDecimals: number;
  qtyDecimals: number;
  /** false = el venue lo ha deslistado o pausado; los bots sobre él se pausan. */
  active: boolean;
}

export interface Ticker {
  venue: Venue;
  symbol: string;
  /** Último precio negociado. */
  last: string;
  bid: string;
  ask: string;
  /** Precio de marca: el que usa el venue para liquidar. Es el que manda en riesgo. */
  mark: string;
  ts: number;
}

export interface Balance {
  asset: string;
  total: string;
  available: string;
  /** Margen inmovilizado por posiciones y órdenes abiertas. */
  used: string;
}

export interface Position {
  venue: Venue;
  symbol: string;
  /** Firmada: positiva = long, negativa = short, 0 = plana. */
  qty: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  leverage: number;
  marginMode: string;
  /** null cuando el venue no lo expone o la posición es plana. */
  liquidationPrice: string | null;
  marginUsed: string;
}
