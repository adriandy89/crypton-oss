import {
  StrategyKind,
  type BotConfig,
  type BotContext,
  type CycleState,
  type FieldMeta,
  type Fill,
  type MarketSpec,
  type StrategyMeta,
  type ValidationIssue,
} from '@crypton/shared';
import { camposEfectivos, invalidPreview, toResult, validateMeta } from './common';
import type { Strategy } from './types';
import { agentTrade } from './strategies/agent-trade';
import { aiChannel } from './strategies/ai-channel';
import { gridClassic } from './strategies/grid-classic';
import { gridmart } from './strategies/gridmart';
import { marketMaker } from './strategies/market-maker';
import { marketMakerV2 } from './strategies/market-maker-v2';
import { trendFollow } from './strategies/trend-follow';
import { trailingProfit } from './strategies/trailing-profit';
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
 * Un campo opcional vacío es un campo ausente (spec 080, 079/F-29).
 *
 * El formulario manda `''` al vaciar una casilla y `validateMeta` ya lo trataba
 * como ausente, pero las estrategias leen `D(cfg.x ?? defecto)`, y `??` no tapa
 * la cadena vacía: `new Decimal('')` lanza. Vaciar el techo del diferencial de
 * la V2 daba un 500 al previsualizar, y un campo vacío que `validate()` dejaba
 * pasar —el umbral defensivo del market maker— reventaba el tick del worker en
 * cada revisión. La regla es la de `validateMeta`:
 *
 * - un opcional vacío está ausente: un stop vacío es «sin stop», un techo
 *   vacío es «sin techo»;
 * - un obligatorio con valor de fábrica vacío vale ese valor, que es con lo
 *   que `validateMeta` lo da por bueno;
 * - un obligatorio sin valor de fábrica se queda como viene, para que
 *   `validateMeta` lo rechace con «Falta …».
 */
export function sinVacios<C>(config: C, campos: readonly FieldMeta[]): C {
  const original = config as Record<string, unknown>;
  let limpia: Record<string, unknown> | null = null;
  for (const f of campos) {
    if (original[f.key] !== '') continue;
    if (!f.required) {
      limpia ??= { ...original };
      delete limpia[f.key];
    } else if (f.default !== undefined) {
      limpia ??= { ...original };
      limpia[f.key] = f.default;
    }
  }
  return (limpia ?? config) as C;
}

/**
 * Envuelve una estrategia con la validacion generica de sus `meta.fields`
 * (001/F-13): `validate()` suma los rangos y opciones que solo el formulario
 * aplicaba, y `preview()` no calcula nada con una configuracion fuera de rango
 * (GridMart sin sus multiplicadores lanzaba `DecimalError`). Y todo lo que
 * recibe la configuración la recibe sin opcionales vacíos (`sinVacios`). Se
 * hace aqui, en el unico sitio por el que la API, el worker, la app y el
 * backtest resuelven estrategias, para que una estrategia nueva lo tenga sin
 * acordarse de nada.
 */
// Como el registro: heterogeneo a proposito, el tipo se concreta al pedirla.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function conValidacionGenerica(s: Strategy<any>): Strategy<any> {
  const limpia = <T>(cfg: T): T => sinVacios(cfg, s.meta.fields);
  const { candles, series, sinIa, nocionalMaximo, soloReduceRiesgo } = s;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envuelta: Strategy<any> = {
    ...s,
    ...(candles ? { candles: (cfg: BotConfig) => candles(limpia(cfg)) } : {}),
    ...(series ? { series: (cfg: BotConfig) => series(limpia(cfg)) } : {}),
    // `sinIa` devuelve la configuración de la estrategia, que aquí es `any`.
    ...(sinIa ? { sinIa: (cfg: BotConfig): BotConfig => sinIa(limpia(cfg)) as BotConfig } : {}),
    ...(nocionalMaximo ? { nocionalMaximo: (cfg: BotConfig) => nocionalMaximo(limpia(cfg)) } : {}),
    ...(soloReduceRiesgo
      ? {
          soloReduceRiesgo: (anterior: BotConfig, nueva: BotConfig) =>
            soloReduceRiesgo(limpia(anterior), limpia(nueva)),
        }
      : {}),
    validate(cfg: BotConfig, market: MarketSpec) {
      const c = limpia(cfg);
      const meta = validateMeta(c, camposEfectivos(s.meta.fields, c, market));
      let propios: ValidationIssue[];
      try {
        propios = s.validate.call(envuelta, c, market).issues;
      } catch (e) {
        // Con un obligatorio vacío o fuera de rango la validación propia puede
        // reventar: lo que importa es devolver los errores genéricos, no el
        // 500. Con una configuración que la genérica da por buena, reventar es
        // un fallo de la estrategia, y tiene que verse.
        if (!meta.some((i) => i.severity === 'ERROR')) throw e;
        propios = [];
      }
      return toResult(fusionar(propios, meta));
    },
    preview(cfg: BotConfig, market: MarketSpec, refPrice: string) {
      const c = limpia(cfg);
      const meta = validateMeta(c, camposEfectivos(s.meta.fields, c, market));
      if (meta.length === 0) return s.preview.call(envuelta, c, market, refPrice);
      let propios: ValidationIssue[] = [];
      try {
        propios = s.validate.call(envuelta, c, market).issues;
      } catch {
        // Con la configuracion rota, la validacion propia puede reventar: lo
        // que importa es devolver los errores genericos, no el 500.
      }
      return invalidPreview(fusionar(propios, meta));
    },
    plan(ctx: BotContext) {
      return s.plan.call(envuelta, { ...ctx, config: limpia(ctx.config) });
    },
    ...(s.onFill
      ? {
          onFill(ctx: BotContext, fill: Fill, cycle: CycleState) {
            return s.onFill!.call(envuelta, { ...ctx, config: limpia(ctx.config) }, fill, cycle);
          },
        }
      : {}),
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
  [StrategyKind.TREND_FOLLOW]: conValidacionGenerica(trendFollow),
  [StrategyKind.TRAILING_PROFIT]: conValidacionGenerica(trailingProfit),
  [StrategyKind.AI_CHANNEL]: conValidacionGenerica(aiChannel),
  [StrategyKind.AGENT_TRADE]: conValidacionGenerica(agentTrade),
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
