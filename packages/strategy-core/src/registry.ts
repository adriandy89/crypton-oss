import {
  StrategyKind,
  type BotConfig,
  type MarketSpec,
  type StrategyMeta,
  type ValidationIssue,
} from '@crypton/shared';
import { camposEfectivos, invalidPreview, toResult, validateMeta } from './common';
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
/**
 * Los errores genericos de `meta.fields` detras de los propios: si la estrategia
 * ya rechaza un campo, el generico no lo repite.
 */
const fusionar = (propios: ValidationIssue[], meta: ValidationIssue[]): ValidationIssue[] => [
  ...propios,
  ...meta.filter((m) => !propios.some((p) => p.field === m.field && p.severity === 'ERROR')),
];

/**
 * Envuelve una estrategia con la validacion generica de sus `meta.fields`
 * (001/F-13): `validate()` suma los rangos y opciones que solo el formulario
 * aplicaba, y `preview()` no calcula nada con una configuracion fuera de rango
 * (GridMart sin sus multiplicadores lanzaba `DecimalError`). Se hace aqui, en
 * el unico sitio por el que la API, el worker y la app resuelven estrategias,
 * para que una estrategia nueva lo tenga sin acordarse de nada.
 */
// Como el registro: heterogeneo a proposito, el tipo se concreta al pedirla.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function conValidacionGenerica(s: Strategy<any>): Strategy<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envuelta: Strategy<any> = {
    ...s,
    validate(cfg: BotConfig, market: MarketSpec) {
      const propia = s.validate.call(envuelta, cfg, market);
      return toResult(
        fusionar(propia.issues, validateMeta(cfg, camposEfectivos(s.meta.fields, cfg, market))),
      );
    },
    preview(cfg: BotConfig, market: MarketSpec, refPrice: string) {
      const meta = validateMeta(cfg, camposEfectivos(s.meta.fields, cfg, market));
      if (meta.length === 0) return s.preview.call(envuelta, cfg, market, refPrice);
      let propios: ValidationIssue[] = [];
      try {
        propios = s.validate.call(envuelta, cfg, market).issues;
      } catch {
        // Con la configuracion rota, la validacion propia puede reventar: lo
        // que importa es devolver los errores genericos, no el 500.
      }
      return invalidPreview(fusionar(propios, meta));
    },
  };
  return envuelta;
}

// El registro es heterogeneo por definicion: cada estrategia tiene su propio
// tipo de config y el parametro solo se concreta al pedir una por su kind.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY: Record<StrategyKind, Strategy<any>> = {
  [StrategyKind.GRID_CLASSIC]: conValidacionGenerica(gridClassic),
  [StrategyKind.NEUTRAL_GRID]: conValidacionGenerica(neutralGrid),
  [StrategyKind.TDCA]: conValidacionGenerica(tdca),
  [StrategyKind.MARTINGALE]: conValidacionGenerica(martingale),
  [StrategyKind.GRIDMART]: conValidacionGenerica(gridmart),
  [StrategyKind.MARKET_MAKER]: conValidacionGenerica(marketMaker),
  [StrategyKind.MARKET_MAKER_V2]: conValidacionGenerica(marketMakerV2),
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
