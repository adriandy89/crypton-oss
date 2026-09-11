export * from './types';
export * from './registry';
export * from './mutability';
export * from './client-order-id';
export * from './ladder';
export * from './trailing-take-profit';
// La liquidacion estimada vivia aqui, pero la necesita tambien el simulador de
// `exchange-core` —que no depende de este paquete— para poder reventar una
// posicion como lo haria el venue. Se mudo a `shared`, que es lo unico que los
// dos comparten, y se reexporta desde aqui para no mover a quien ya la importa.
export {
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  estimateLiquidationPrice,
  liquidationDistancePct,
} from '@crypton/shared';
export {
  camposEfectivos,
  COMMON_FIELDS,
  commonFieldsWith,
  buildPreview,
  invalidPreview,
  entrySide,
  exitSide,
  positionSize,
  px,
  qy,
  validateCommon,
  type RawLevel,
} from './common';
export type { GridClassicConfig } from './strategies/grid-classic';
export type { NeutralGridConfig } from './strategies/neutral-grid';
export type { TdcaConfig } from './strategies/tdca';
export type { MartingaleConfig } from './strategies/martingale';
export type { GridMartConfig } from './strategies/gridmart';
export type { MarketMakerConfig } from './strategies/market-maker';
export type { MarketMakerV2Config } from './strategies/market-maker-v2';
export type { TrendFollowConfig } from './strategies/trend-follow';
export type { TrailingProfitConfig } from './strategies/trailing-profit';
export * from './indicadores';
export { composeSpreadBps, resolveAnchor } from './strategies/market-maker-v2';
export { MAX_VOL_SAMPLES, sampleVolatility } from './strategies/mm-shared';

// Specs REALES de los tres venues, tomadas de sus APIs publicas. Se exportan
// porque las usan tambien los tests del worker y de la API: sin un origen unico,
// cada uno se inventaria sus mercados y los tests dejarian de decir nada.
export * from './venue-markets';

// Piezas que vivian en `apps/worker/src/engine`. Se mudaron aqui porque ya solo
// dependian de `shared` y de este paquete, y porque el backtest las necesita:
// duplicarlas alli habria dejado dos verdades sobre la misma decision.
export * from './reconcile';
export * from './order-gate';
export * from './stop-loss';
export * from './cycle-accounting';
