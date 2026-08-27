import type { StrategyKind } from '../models';
import { COMMON_OPTION_DOCS } from './common-options';
import { GRIDMART_GUIDE } from './gridmart.guide';
import { GRID_CLASSIC_GUIDE } from './grid-classic.guide';
import { MARKET_MAKER_GUIDE } from './market-maker.guide';
import { MARKET_MAKER_V2_GUIDE } from './market-maker-v2.guide';
import { MARTINGALE_GUIDE } from './martingale.guide';
import { NEUTRAL_GRID_GUIDE } from './neutral-grid.guide';
import { TDCA_GUIDE } from './tdca.guide';
import type { OptionDoc, StrategyGuide } from './types';

export * from './types';
export { COMMON_OPTION_DOCS } from './common-options';

/**
 * El manual de cada estrategia.
 *
 * El tipo es un `Record` completo y no un `Partial` a propósito: una estrategia
 * nueva en `StrategyKind` deja de compilar hasta que tenga su guía, igual que
 * pasa con `STRATEGY_LABELS` y `STRATEGY_BLURBS`.
 */
export const STRATEGY_GUIDES: Record<StrategyKind, StrategyGuide> = {
  GRID_CLASSIC: GRID_CLASSIC_GUIDE,
  NEUTRAL_GRID: NEUTRAL_GRID_GUIDE,
  TDCA: TDCA_GUIDE,
  MARTINGALE: MARTINGALE_GUIDE,
  GRIDMART: GRIDMART_GUIDE,
  MARKET_MAKER: MARKET_MAKER_GUIDE,
  MARKET_MAKER_V2: MARKET_MAKER_V2_GUIDE,
};

export const strategyGuide = (kind: string): StrategyGuide | null =>
  STRATEGY_GUIDES[kind as StrategyKind] ?? null;

/**
 * Ficha larga de un parámetro dentro de una estrategia.
 *
 * Primero la de la estrategia, que puede haber redefinido un campo común porque
 * allí significa otra cosa; si no, la común. `null` si nadie la ha escrito: el
 * panel cae entonces a la ayuda corta del formulario, que es mejor que un hueco.
 */
export function optionDoc(kind: string, key: string): OptionDoc | null {
  const guide = STRATEGY_GUIDES[kind as StrategyKind];
  const own = (guide?.options as Record<string, OptionDoc> | undefined)?.[key];
  return own ?? COMMON_OPTION_DOCS[key as keyof typeof COMMON_OPTION_DOCS] ?? null;
}
