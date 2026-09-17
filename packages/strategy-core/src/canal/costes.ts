/**
 * Costes de operar, por venue (spec 058).
 *
 * Son valores de REFERENCIA del tramo base de cada venue: la cuenta del usuario
 * puede pagar otros, y por eso se pueden sobrescribir en la configuración. Un
 * rango que no paga sus costes no es un rango operable, así que el motor los
 * mira antes de proponer nada.
 */
import { Venue } from '@crypton/shared';

export interface Costes {
  makerBps: number;
  takerBps: number;
  deslizamientoBps: number;
}

/**
 * Referencias:
 * - Hyperliquid, tramo 0 de perpetuos: 1,5 / 4,5 bps.
 * - Aster: 1 / 3,5 bps.
 * - Lighter, cuenta estándar: sin comisión.
 * - Deslizamiento estimado: 2 bps en los tres.
 */
export const COSTES_VENUE: Readonly<Record<Venue, Costes>> = {
  [Venue.HYPERLIQUID]: { makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 },
  [Venue.ASTER]: { makerBps: 1, takerBps: 3.5, deslizamientoBps: 2 },
  [Venue.LIGHTER]: { makerBps: 0, takerBps: 0, deslizamientoBps: 2 },
};

const numero = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Los costes del venue con lo que el usuario haya sobrescrito. */
export function costesDe(
  venue: Venue,
  sobrescritos: { makerFeeBps?: unknown; takerFeeBps?: unknown; slippageBps?: unknown } = {},
): Costes {
  const base = COSTES_VENUE[venue] ?? COSTES_VENUE[Venue.HYPERLIQUID];
  return {
    makerBps: numero(sobrescritos.makerFeeBps) ?? base.makerBps,
    takerBps: numero(sobrescritos.takerFeeBps) ?? base.takerBps,
    deslizamientoBps: numero(sobrescritos.slippageBps) ?? base.deslizamientoBps,
  };
}

/**
 * Coste de ida y vuelta en unidades de precio, en el peor caso:
 * - entrada y salida a mercado;
 * - deslizamiento en las dos;
 * - el spread entero.
 */
export function costeIdaVuelta(precio: number, costes: Costes, spreadBps: number): number {
  const bps = 2 * costes.takerBps + 2 * costes.deslizamientoBps + Math.max(0, spreadBps);
  return (precio * bps) / 10_000;
}

/** Spread en puntos básicos sobre el punto medio. */
export function spreadBps(bid: number, ask: number): number {
  const medio = (bid + ask) / 2;
  return medio > 0 && ask >= bid ? ((ask - bid) / medio) * 10_000 : 0;
}
