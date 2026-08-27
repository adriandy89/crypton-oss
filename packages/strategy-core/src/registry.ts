import { StrategyKind, type BotConfig, type StrategyMeta } from '@crypton/shared';
import type { Strategy } from './types';
import { gridClassic } from './strategies/grid-classic';
import { gridmart } from './strategies/gridmart';
import { marketMaker } from './strategies/market-maker';
import { marketMakerV2 } from './strategies/market-maker-v2';
import { martingale } from './strategies/martingale';
import { neutralGrid } from './strategies/neutral-grid';
import { tdca } from './strategies/tdca';

/**
 * Registro único de estrategias. La API, el worker y la app resuelven siempre
 * por aquí: añadir una estrategia es añadir una entrada a este mapa, sin tocar
 * ni el motor ni los formularios (que se generan desde `meta.fields`).
 */
// El registro es heterogeneo por definicion: cada estrategia tiene su propio
// tipo de config y el parametro solo se concreta al pedir una por su kind.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY: Record<StrategyKind, Strategy<any>> = {
  [StrategyKind.GRID_CLASSIC]: gridClassic,
  [StrategyKind.NEUTRAL_GRID]: neutralGrid,
  [StrategyKind.TDCA]: tdca,
  [StrategyKind.MARTINGALE]: martingale,
  [StrategyKind.GRIDMART]: gridmart,
  [StrategyKind.MARKET_MAKER]: marketMaker,
  [StrategyKind.MARKET_MAKER_V2]: marketMakerV2,
};

export function getStrategy(kind: StrategyKind): Strategy<BotConfig> {
  const strategy = REGISTRY[kind];
  if (!strategy) throw new Error('Estrategia desconocida: ' + kind);
  return strategy as Strategy<BotConfig>;
}

export const listStrategies = (): Strategy<BotConfig>[] =>
  Object.values(REGISTRY) as Strategy<BotConfig>[];

/** Metadatos de todas las estrategias: lo que consume el wizard de la app. */
export const listStrategyMeta = (): StrategyMeta[] => listStrategies().map((s) => s.meta);

export { gridClassic, gridmart, marketMaker, marketMakerV2, martingale, neutralGrid, tdca };
