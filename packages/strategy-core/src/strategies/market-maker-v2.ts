import {
  ActivationMode,
  D,
  Decimal,
  FairPriceOrigin,
  LevelKind,
  Mutability,
  PositionModeSetting,
  PriceSource,
  SizingMode,
  SourceMarketType,
  StrategyKind,
  type BotContext,
  type CommonBotConfig,
  type DesiredOrder,
  type DesiredState,
  type FieldMeta,
  type MarketSpec,
  type PreviewResult,
  type StrategyMeta,
  type ValidationIssue,
  type ValidationResult,
} from '@crypton/shared';
import { makeCoid } from '../client-order-id';
import {
  buildPreview,
  commonFieldsWith,
  err,
  invalidPreview,
  px,
  qy,
  toResult,
  validateCommon,
  warn,
  type RawLevel,
} from '../common';
import { geometricWeights } from '../ladder';
import type { Strategy } from '../types';
import { validatePriceBand, validateRiskThresholds } from './market-maker';
import {
  activationGate,
  BPS,
  bookMid,
  expiredQuotes,
  inventoryOf,
  limitBreach,
  orderAges,
  priceBand,
  profileOf,
  REGIME_DISTANCE,
  riskRegime,
  sampleVolatility,
  sideRoles,
  sizeToQty,
} from './mm-shared';

/**
 * Market Maker V2.
 *
 * La diferencia de fondo con la V1 no es el número de parámetros: es de dónde
 * sale el diferencial. La V1 lo ensancha según el inventario; la V2 lo compone
 * a partir de la volatilidad realizada, la anchura del libro y el coste de
 * operar, y garantiza un suelo por debajo del cual cotizar no deja beneficio.
 *
 * Eso obliga a dos piezas que la V1 no necesita: una muestra de precios propia
 * (el anillo en `cycle.scratch`) y la posibilidad de anclar a una fuente ajena
 * al venue.
 */
export interface MarketMakerV2Config extends CommonBotConfig {
  orderSizePerSide: string;
  maxBotPositionValue: string;
  behaviorPreset?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

  buyDistanceBps: string;
  sellDistanceBps: string;
  minAllowedDistanceBps: string;
  defensiveThresholdPct?: string | null;
  highRiskThresholdPct?: string | null;

  refreshSeconds: number;
  /** Deriva del precio a partir de la cual se recotiza aunque no toque por tiempo. */
  repriceThresholdBps: string;
  /** Edad máxima de una cotización viva antes de rehacerla. */
  orderMaxAgeSeconds?: number;
  fillCooldownSeconds?: number;
  exitOrderTtlSeconds?: number;

  /** Comisión estimada por lado. Se paga dos veces en un par casado. */
  feeEstimateBps?: string;
  /** Colchón extra sobre el coste, para no cotizar al filo. */
  safetyBufferBps?: string;
  /** Lo que debe quedar limpio tras comisiones y colchón. */
  minProfitMarginBps?: string;

  dynamicSpread?: boolean;
  volatilitySampleSeconds?: number;
  orderBookMarginBps?: string;
  volatilityMultiplier?: string;
  maxDynamicSpreadBps?: string;

  useFullSizeUntilMax?: boolean;
  layers: number;
  layerDistanceMultiplier: string;
  layerSizeMultiplier: string;
  postOnly?: boolean;

  priceSource?: PriceSource;
  fairPriceOrigin?: FairPriceOrigin;
  sourceMarketType?: SourceMarketType;
  sourceSymbolOverride?: string | null;

  activationMode?: ActivationMode;
  activationPrice?: string | null;
}

const V2_FIELDS: readonly FieldMeta[] = [
  // ── core ──
  {
    key: 'behaviorPreset',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.behaviorPreset',
    helpKey: 'strategy.mmv2.behaviorPresetHelp',
    options: ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'],
    required: false,
    default: 'BALANCED',
    group: 'core',
    control: 'select',
  },
  {
    key: 'sizingMode',
    kind: 'enum',
    mutability: Mutability.WARM,
    labelKey: 'strategy.mmv2.sizingMode',
    helpKey: 'strategy.mmv2.sizingModeHelp',
    options: [SizingMode.QUOTE, SizingMode.BASE],
    required: false,
    default: SizingMode.QUOTE,
    group: 'core',
    control: 'segment',
  },
  {
    key: 'orderSizePerSide',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.orderSizePerSide',
    helpKey: 'strategy.mmv2.orderSizePerSideHelp',
    min: 1,
    required: true,
    group: 'core',
    unit: 'USDC',
  },
  {
    key: 'maxBotPositionValue',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.maxBotPositionValue',
    helpKey: 'strategy.mmv2.maxBotPositionValueHelp',
    min: 1,
    required: true,
    risky: true,
    group: 'core',
    unit: 'USDC',
  },
  {
    key: 'limitAction',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.limitAction',
    helpKey: 'strategy.mmv2.limitActionHelp',
    options: ['PAUSE_ENTRIES', 'CLOSE_ALL', 'SHUTDOWN'],
    required: false,
    default: 'PAUSE_ENTRIES',
    risky: true,
    group: 'core',
    control: 'segment',
  },

  // ── quoting ──
  {
    key: 'buyDistanceBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.buyDistanceBps',
    helpKey: 'strategy.mmv2.buyDistanceBpsHelp',
    min: 1,
    max: 2000,
    step: 1,
    required: true,
    default: 40,
    group: 'quoting',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'sellDistanceBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.sellDistanceBps',
    min: 1,
    max: 2000,
    step: 1,
    required: true,
    default: 40,
    group: 'quoting',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'minAllowedDistanceBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.minAllowedDistanceBps',
    helpKey: 'strategy.mmv2.minAllowedDistanceBpsHelp',
    min: 1,
    max: 500,
    step: 1,
    required: true,
    default: 8,
    group: 'quoting',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'feeEstimateBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.feeEstimateBps',
    helpKey: 'strategy.mmv2.feeEstimateBpsHelp',
    min: 0,
    max: 100,
    step: 0.1,
    required: false,
    default: 0,
    group: 'quoting',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'safetyBufferBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.safetyBufferBps',
    helpKey: 'strategy.mmv2.safetyBufferBpsHelp',
    min: 0,
    max: 200,
    step: 0.1,
    required: false,
    default: 0,
    group: 'quoting',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'minProfitMarginBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.minProfitMarginBps',
    helpKey: 'strategy.mmv2.minProfitMarginBpsHelp',
    min: 0,
    max: 500,
    step: 0.1,
    required: false,
    default: 8,
    group: 'quoting',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'postOnly',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.postOnly',
    helpKey: 'strategy.mmv2.postOnlyHelp',
    required: false,
    default: true,
    group: 'quoting',
    advanced: true,
  },

  // ── risk ──
  {
    key: 'defensiveThresholdPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.defensiveThresholdPct',
    helpKey: 'strategy.mmv2.defensiveThresholdPctHelp',
    min: 1,
    max: 100,
    step: 1,
    required: false,
    default: 90,
    group: 'risk',
    unit: '%',
    advanced: true,
  },
  {
    key: 'highRiskThresholdPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.highRiskThresholdPct',
    helpKey: 'strategy.mmv2.highRiskThresholdPctHelp',
    min: 1,
    max: 100,
    step: 1,
    required: false,
    default: 100,
    risky: true,
    group: 'risk',
    unit: '%',
    advanced: true,
  },

  // ── timing ──
  {
    key: 'refreshSeconds',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.refreshSeconds',
    helpKey: 'strategy.mmv2.refreshSecondsHelp',
    // El suelo son 15 s y no 5 porque el motor reconcilia cada
    // RECONCILE_INTERVAL_MS (15 s por defecto): por debajo de eso el campo
    // prometia un refresco que nadie iba a ejecutar. Una ejecucion SI dispara
    // un tick inmediato, asi que esto es el techo de latencia cuando no pasa
    // nada, no el tiempo de reaccion.
    min: 15,
    max: 3600,
    step: 5,
    required: true,
    default: 30,
    group: 'timing',
    unit: 'sec',
    advanced: true,
  },
  {
    key: 'repriceThresholdBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.repriceThresholdBps',
    helpKey: 'strategy.mmv2.repriceThresholdBpsHelp',
    min: 1,
    max: 1000,
    step: 1,
    required: true,
    default: 30,
    group: 'timing',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'orderMaxAgeSeconds',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.orderMaxAgeSeconds',
    helpKey: 'strategy.mmv2.orderMaxAgeSecondsHelp',
    min: 0,
    max: 86400,
    step: 5,
    required: false,
    default: 120,
    group: 'timing',
    unit: 'sec',
    advanced: true,
  },
  {
    key: 'fillCooldownSeconds',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.fillCooldownSeconds',
    helpKey: 'strategy.mmv2.fillCooldownSecondsHelp',
    min: 0,
    max: 3600,
    step: 5,
    required: false,
    default: 35,
    group: 'timing',
    unit: 'sec',
    advanced: true,
  },
  {
    key: 'exitOrderTtlSeconds',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.exitOrderTtlSeconds',
    helpKey: 'strategy.mmv2.exitOrderTtlSecondsHelp',
    min: 0,
    max: 86400,
    step: 5,
    required: false,
    default: 0,
    group: 'timing',
    unit: 'sec',
    advanced: true,
  },

  // ── dynamicSpread ──
  {
    key: 'dynamicSpread',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.dynamicSpread',
    helpKey: 'strategy.mmv2.dynamicSpreadHelp',
    required: false,
    default: true,
    group: 'dynamicSpread',
    advanced: true,
  },
  {
    key: 'volatilitySampleSeconds',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.volatilitySampleSeconds',
    helpKey: 'strategy.mmv2.volatilitySampleSecondsHelp',
    min: 30,
    max: 3600,
    step: 10,
    required: false,
    default: 300,
    group: 'dynamicSpread',
    unit: 'sec',
    advanced: true,
  },
  {
    key: 'orderBookMarginBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.orderBookMarginBps',
    helpKey: 'strategy.mmv2.orderBookMarginBpsHelp',
    min: 0,
    max: 200,
    step: 0.1,
    required: false,
    default: 1.5,
    group: 'dynamicSpread',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'volatilityMultiplier',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.volatilityMultiplier',
    helpKey: 'strategy.mmv2.volatilityMultiplierHelp',
    min: 0,
    max: 5,
    step: 0.05,
    required: false,
    default: 0.35,
    group: 'dynamicSpread',
    advanced: true,
  },
  {
    key: 'maxDynamicSpreadBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.maxDynamicSpreadBps',
    helpKey: 'strategy.mmv2.maxDynamicSpreadBpsHelp',
    min: 1,
    max: 5000,
    step: 1,
    required: false,
    default: 100,
    group: 'dynamicSpread',
    unit: 'bps',
    advanced: true,
  },

  // ── levels ──
  {
    key: 'useFullSizeUntilMax',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.useFullSizeUntilMax',
    helpKey: 'strategy.mmv2.useFullSizeUntilMaxHelp',
    required: false,
    default: false,
    group: 'levels',
    advanced: true,
  },
  {
    key: 'layers',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.mmv2.layers',
    helpKey: 'strategy.mmv2.layersHelp',
    min: 1,
    max: 10,
    step: 1,
    required: true,
    default: 1,
    group: 'levels',
    advanced: true,
  },
  {
    key: 'layerDistanceMultiplier',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.mmv2.layerDistanceMultiplier',
    min: 1,
    max: 3,
    step: 0.05,
    required: true,
    default: 1,
    group: 'levels',
    advanced: true,
  },
  {
    key: 'layerSizeMultiplier',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.mmv2.layerSizeMultiplier',
    min: 0.1,
    max: 3,
    step: 0.05,
    required: true,
    default: 1,
    group: 'levels',
    advanced: true,
  },

  {
    key: 'positionMode',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'strategy.mmv2.positionMode',
    helpKey: 'strategy.mmv2.positionModeHelp',
    options: [
      PositionModeSetting.AUTO,
      PositionModeSetting.HEDGE,
      PositionModeSetting.ONE_WAY,
    ],
    required: false,
    default: PositionModeSetting.AUTO,
    group: 'venue',
    control: 'segment',
    advanced: true,
  },

  // ── priceSource ──
  {
    key: 'priceSource',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.priceSource',
    helpKey: 'strategy.mmv2.priceSourceHelp',
    options: [PriceSource.EXCHANGE, PriceSource.BINANCE],
    required: false,
    default: PriceSource.EXCHANGE,
    group: 'priceSource',
    control: 'segment',
    advanced: true,
  },
  {
    key: 'fairPriceOrigin',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.fairPriceOrigin',
    helpKey: 'strategy.mmv2.fairPriceOriginHelp',
    options: [
      FairPriceOrigin.SOURCE_GLOBAL,
      FairPriceOrigin.VENUE_MID,
      FairPriceOrigin.VENUE_MARK,
    ],
    required: false,
    default: FairPriceOrigin.SOURCE_GLOBAL,
    group: 'priceSource',
    control: 'select',
    advanced: true,
  },
  {
    key: 'sourceMarketType',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.sourceMarketType',
    helpKey: 'strategy.mmv2.sourceMarketTypeHelp',
    options: [SourceMarketType.PERP, SourceMarketType.SPOT, SourceMarketType.INDEX],
    required: false,
    default: SourceMarketType.PERP,
    group: 'priceSource',
    control: 'segment',
    advanced: true,
  },
  {
    key: 'sourceSymbolOverride',
    kind: 'text',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.sourceSymbolOverride',
    helpKey: 'strategy.mmv2.sourceSymbolOverrideHelp',
    required: false,
    group: 'priceSource',
    advanced: true,
  },
  {
    key: 'priceFloor',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.priceFloor',
    helpKey: 'strategy.mmv2.priceFloorHelp',
    min: 0,
    required: false,
    group: 'priceSource',
    advanced: true,
  },
  {
    key: 'priceCeiling',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.priceCeiling',
    helpKey: 'strategy.mmv2.priceCeilingHelp',
    min: 0,
    required: false,
    group: 'priceSource',
    advanced: true,
  },

  // ── activation ──
  {
    key: 'activationMode',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.activationMode',
    helpKey: 'strategy.mmv2.activationModeHelp',
    options: [ActivationMode.NONE, ActivationMode.PRICE_ABOVE, ActivationMode.PRICE_BELOW],
    required: false,
    default: ActivationMode.NONE,
    group: 'activation',
    control: 'segment',
    advanced: true,
  },
  {
    key: 'activationPrice',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mmv2.activationPrice',
    helpKey: 'strategy.mmv2.activationPriceHelp',
    min: 0,
    required: false,
    group: 'activation',
    advanced: true,
  },
] as const;

const V2_DIRECTION: FieldMeta = {
  key: 'direction',
  kind: 'enum',
  mutability: Mutability.COLD,
  labelKey: 'strategy.mm.direction',
  options: ['NEUTRAL', 'LONG', 'SHORT'],
  required: true,
  default: 'NEUTRAL',
  group: 'core',
  control: 'segment',
};

const META: StrategyMeta = {
  kind: StrategyKind.MARKET_MAKER_V2,
  labelKey: 'strategy.mmv2.label',
  descriptionKey: 'strategy.mmv2.description',
  fields: [...commonFieldsWith([V2_DIRECTION]), ...V2_FIELDS],
};

/**
 * Diferencial objetivo en bps, ya compuesto.
 *
 * El suelo es la parte que importa: `comisión × 2 + margen mínimo` es lo que
 * cuesta abrir y cerrar un par casado más lo que se quiere sacar limpio. Por
 * debajo de ahí, ejecutar los dos lados PIERDE dinero, así que el bot no cotiza
 * más cerca aunque el resto de la fórmula lo pida.
 *
 * El techo (`maxDynamicSpreadBps`) se aplica al total y no solo a la parte
 * dinámica: lo que el usuario quiere garantizar es «nunca cotizo más ancho de
 * X», y esa promesa no se puede cumplir capando solo un sumando.
 */
export function composeSpreadBps(
  cfg: MarketMakerV2Config,
  baseBps: Decimal,
  volBps: Decimal,
): { bps: Decimal; floorBps: Decimal; dynamicAdd: Decimal } {
  const fee = D(cfg.feeEstimateBps ?? 0);
  const buffer = D(cfg.safetyBufferBps ?? 0);
  const roundTripCost = fee.mul(2);

  const floorBps = Decimal.max(
    D(cfg.minAllowedDistanceBps ?? 1),
    roundTripCost.plus(D(cfg.minProfitMarginBps ?? 0)),
  );

  const dynamicAdd =
    cfg.dynamicSpread === false
      ? D(0)
      : D(cfg.orderBookMarginBps ?? 0).plus(volBps.mul(D(cfg.volatilityMultiplier ?? 0)));

  const raw = baseBps.plus(dynamicAdd).plus(roundTripCost).plus(buffer);
  const cap = D(cfg.maxDynamicSpreadBps ?? 0);
  const capped = cap.gt(0) ? Decimal.min(raw, cap) : raw;

  return { bps: Decimal.max(floorBps, capped), floorBps, dynamicAdd };
}

/**
 * Coherencia de la fuente de precio externa.
 *
 * Nada validaba estos campos, y el precio de no hacerlo era el peor posible: un
 * símbolo mal escrito no daba error al crear el bot, sino un bot EN MARCHA que
 * no coloca una sola orden, porque `resolveAnchor` devuelve null y el motor
 * cancela lo que hubiera. Es decir, el fallo se descubría como «no funciona» en
 * vez de como «esto está mal escrito».
 *
 * La comprobación es de FORMA, no de existencia: saber si `WBTCUSDT` cotiza de
 * verdad exige preguntárselo a Binance, y eso es red — no cabe en una función
 * pura, y meterla en la creación del bot pondría una dependencia externa en el
 * camino de un formulario. La forma ya atrapa el grueso: espacios, minúsculas,
 * barras copiadas del par del venue (`BTC/USDC`).
 */
function validateFairSource(cfg: MarketMakerV2Config): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const source = cfg.priceSource ?? PriceSource.EXCHANGE;
  const override = cfg.sourceSymbolOverride?.trim();

  if (override) {
    if (source === PriceSource.EXCHANGE) {
      issues.push(
        err(
          'sourceSymbolOverride',
          'El símbolo de origen alternativo solo se usa con una fuente externa: ' +
            'elige Binance o deja el campo vacío.',
        ),
      );
    } else if (!/^[A-Z0-9]{2,32}$/.test(override)) {
      issues.push(
        err(
          'sourceSymbolOverride',
          'El símbolo de origen se escribe como en la fuente, en mayúsculas y sin ' +
            'separadores: «1000PEPEUSDT», no «kPEPE/USDC».',
        ),
      );
    }
  }

  // Anclar al libro del venue con una fuente externa elegida no es un error
  // —funciona—, pero es casi siempre un descuido: el usuario cree que cotiza
  // contra Binance y cotiza contra el mid local.
  const origin = cfg.fairPriceOrigin ?? FairPriceOrigin.SOURCE_GLOBAL;
  if (source !== PriceSource.EXCHANGE && origin !== FairPriceOrigin.SOURCE_GLOBAL) {
    issues.push(
      warn(
        'fairPriceOrigin',
        'Has elegido una fuente externa pero el ancla es el libro del propio ' +
          'venue: el precio de la fuente no se usará.',
      ),
    );
  }

  return issues;
}

/**
 * Precio contra el que se cotiza.
 *
 * `null` significa «la fuente pedida no está disponible ahora mismo». No se
 * sustituye en silencio por el precio del venue: si el usuario eligió anclar a
 * Binance es porque no se fía del mid local, y usar el local sin avisar sería
 * hacer justo lo contrario de lo que pidió.
 */
export function resolveAnchor(cfg: MarketMakerV2Config, ctx: BotContext): Decimal | null {
  const origin = cfg.fairPriceOrigin ?? FairPriceOrigin.SOURCE_GLOBAL;
  if (origin === FairPriceOrigin.VENUE_MARK) return D(ctx.ticker.mark);
  if (origin === FairPriceOrigin.VENUE_MID) return bookMid(ctx.ticker);

  const source = cfg.priceSource ?? PriceSource.EXCHANGE;
  if (source === PriceSource.EXCHANGE) return bookMid(ctx.ticker);

  if (!ctx.fairPrice) return null;
  const fair = D(ctx.fairPrice);
  return fair.isFinite() && fair.gt(0) ? fair : null;
}

export const marketMakerV2: Strategy<MarketMakerV2Config> = {
  kind: StrategyKind.MARKET_MAKER_V2,
  meta: META,
  reusesOrderSlots: true,

  defaults() {
    return {
      behaviorPreset: 'BALANCED',
      sizingMode: SizingMode.QUOTE,
      limitAction: 'PAUSE_ENTRIES',
      positionMode: PositionModeSetting.AUTO,
      buyDistanceBps: '40',
      sellDistanceBps: '40',
      minAllowedDistanceBps: '8',
      feeEstimateBps: '0',
      safetyBufferBps: '0',
      minProfitMarginBps: '8',
      postOnly: true,
      defensiveThresholdPct: '90',
      highRiskThresholdPct: '100',
      refreshSeconds: 30,
      repriceThresholdBps: '30',
      orderMaxAgeSeconds: 120,
      fillCooldownSeconds: 35,
      exitOrderTtlSeconds: 0,
      dynamicSpread: true,
      volatilitySampleSeconds: 300,
      orderBookMarginBps: '1.5',
      volatilityMultiplier: '0.35',
      maxDynamicSpreadBps: '100',
      useFullSizeUntilMax: false,
      layers: 1,
      layerDistanceMultiplier: '1',
      layerSizeMultiplier: '1',
      priceSource: PriceSource.EXCHANGE,
      fairPriceOrigin: FairPriceOrigin.SOURCE_GLOBAL,
      sourceMarketType: SourceMarketType.PERP,
      activationMode: ActivationMode.NONE,
      leverage: 1,
      marginMode: 'CROSS',
      direction: 'NEUTRAL',
    };
  },

  validate(cfg: MarketMakerV2Config, market: MarketSpec): ValidationResult {
    const issues: ValidationIssue[] = validateCommon(cfg, market);

    const size = D(cfg.orderSizePerSide ?? 0);
    if (!size.isFinite() || size.lte(0)) {
      issues.push(err('orderSizePerSide', 'El tamaño por compra/venta debe ser mayor que cero.'));
    }

    const maxPos = D(cfg.maxBotPositionValue ?? 0);
    if (!maxPos.isFinite() || maxPos.lte(0)) {
      issues.push(err('maxBotPositionValue', 'La inversión máxima debe ser mayor que cero.'));
    }

    const buyBps = D(cfg.buyDistanceBps ?? 0);
    const sellBps = D(cfg.sellDistanceBps ?? 0);
    if (buyBps.lte(0) || sellBps.lte(0)) {
      issues.push(err('buyDistanceBps', 'Las distancias deben ser mayores que cero.'));
    }

    const layers = Math.floor(cfg.layers ?? 0);
    if (layers < 1 || layers > 10) {
      issues.push(err('layers', 'Los niveles de cotización deben estar entre 1 y 10.'));
    }
    if (Math.floor(cfg.refreshSeconds ?? 0) < 15) {
      issues.push(
        err(
          'refreshSeconds',
          'El refresco mínimo es de 15 segundos: es el ritmo al que el motor reconcilia.',
        ),
      );
    }

    issues.push(...validateRiskThresholds(cfg));
    issues.push(...validatePriceBand(cfg));
    issues.push(...validateFairSource(cfg));

    // El suelo por coste puede dejar la distancia configurada sin efecto. Es
    // legítimo, pero el usuario debe saber que su «40 bps» se va a convertir en
    // otra cosa ANTES de crear el bot, no después de mirar el libro.
    const { floorBps } = composeSpreadBps(cfg, buyBps, D(0));
    if (floorBps.gt(buyBps) || floorBps.gt(sellBps)) {
      issues.push(
        warn(
          'minProfitMarginBps',
          'Comisión y margen mínimo obligan a un diferencial de al menos ' +
            floorBps.toFixed(1) +
            ' bps: las distancias configuradas se elevarán hasta ahí.',
        ),
      );
    }

    const cap = D(cfg.maxDynamicSpreadBps ?? 0);
    if (cap.gt(0) && cap.lt(floorBps)) {
      issues.push(
        err(
          'maxDynamicSpreadBps',
          'El spread dinámico máximo (' +
            cap.toFixed(1) +
            ' bps) es menor que el suelo por coste (' +
            floorBps.toFixed(1) +
            ' bps): el bot no podría cotizar con beneficio.',
        ),
      );
    }

    if (cfg.activationMode && cfg.activationMode !== ActivationMode.NONE) {
      const trigger = cfg.activationPrice ? D(cfg.activationPrice) : null;
      if (trigger == null || !trigger.isFinite() || trigger.lte(0)) {
        issues.push(
          err(
            'activationPrice',
            'Con una condición de activación hace falta un precio de disparo.',
          ),
        );
      }
    }

    return toResult(issues);
  },

  preview(cfg: MarketMakerV2Config, market: MarketSpec, refPrice: string): PreviewResult {
    const validation = this.validate(cfg, market);
    // Sin config valida no se puede calcular NADA: seguir adelante significaba
    // `D(undefined)` -> DecimalError -> 500 en `POST /bots/preview`. La escalera
    // no se pinta, pero los `issues` explican exactamente que falta.
    if (!validation.ok) return invalidPreview(validation.issues);
    const mid = D(refPrice);
    const profile = profileOf(cfg.behaviorPreset);
    const layers = Math.max(1, Math.floor(cfg.layers ?? 1));
    const sizeWeights = geometricWeights(layers, cfg.layerSizeMultiplier ?? 1);
    const distWeights = geometricWeights(layers, cfg.layerDistanceMultiplier ?? 1);
    const size = D(cfg.orderSizePerSide ?? 0);
    const lev = D(cfg.leverage);

    // Sin histórico no hay volatilidad que medir: el preview enseña el
    // diferencial en reposo, que es el suelo de lo que el bot va a cotizar.
    const buySpread = composeSpreadBps(cfg, D(cfg.buyDistanceBps), D(0)).bps;
    const sellSpread = composeSpreadBps(cfg, D(cfg.sellDistanceBps), D(0)).bps;

    const levels: RawLevel[] = [];
    const dir = cfg.direction ?? 'NEUTRAL';

    for (let l = 0; l < layers; l++) {
      const unit = size.mul(sizeWeights[l]);

      if (dir === 'NEUTRAL' || dir === 'LONG') {
        const bps = buySpread.mul(distWeights[l]).mul(profile.distance);
        const price = mid.mul(D(1).minus(bps.div(BPS)));
        const { qty, notional } = sizeToQty(cfg.sizingMode, unit, price);
        levels.push({
          index: l,
          kind: LevelKind.QUOTE_BID,
          side: 'BUY',
          price,
          qty,
          margin: lev.gt(0) ? notional.div(lev) : notional,
          isEntry: true,
        });
      }

      if (dir === 'NEUTRAL' || dir === 'SHORT') {
        const bps = sellSpread.mul(distWeights[l]).mul(profile.distance);
        const price = mid.mul(D(1).plus(bps.div(BPS)));
        const { qty, notional } = sizeToQty(cfg.sizingMode, unit, price);
        levels.push({
          index: layers + l,
          kind: LevelKind.QUOTE_ASK,
          side: 'SELL',
          price,
          qty,
          margin: lev.gt(0) ? notional.div(lev) : notional,
          isEntry: true,
        });
      }
    }

    return buildPreview({
      levels,
      market,
      refPrice,
      direction: cfg.direction === 'SHORT' ? 'SHORT' : 'LONG',
      leverage: cfg.leverage,
      issues: validation.issues,
    });
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as MarketMakerV2Config;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const pd = ctx.market.priceDecimals;
    const scratch = ctx.cycle.scratch;
    const scratchPatch: Record<string, unknown> = {};

    // ── 1. Precio de referencia ──
    const anchorNow = resolveAnchor(cfg, ctx);
    if (anchorNow == null) {
      return {
        orders: [],
        immediate: [],
        targetLeverage: cfg.leverage,
        note:
          'Sin precio de referencia de ' +
          String(cfg.priceSource ?? PriceSource.EXCHANGE).toLowerCase() +
          ': no se cotiza hasta que la fuente vuelva.',
      };
    }

    // ── 2. Condición de activación ──
    const gate = activationGate(cfg, scratch, anchorNow, ctx.now);
    if (!gate.armed) {
      return { orders: [], immediate: [], targetLeverage: cfg.leverage, note: gate.note };
    }
    if (gate.patch) Object.assign(scratchPatch, gate.patch);

    // ── 3. ¿Toca recotizar? ──
    const refreshMs = Math.max(5, Math.floor(cfg.refreshSeconds ?? 30)) * 1000;
    const quotedMidRaw = scratch['quotedMid'] as string | undefined;
    const quotedAt = Number(scratch['quotedAt'] ?? 0);
    const quotedMid = quotedMidRaw ? D(quotedMidRaw) : null;

    const driftBps =
      quotedMid && quotedMid.gt(0)
        ? anchorNow.minus(quotedMid).div(quotedMid).mul(BPS).abs()
        : null;

    const staleByTime = ctx.now - quotedAt >= refreshMs;
    const staleByDrift = driftBps != null && driftBps.gte(D(cfg.repriceThresholdBps ?? 30));

    const cooldownMs = Math.max(0, Math.floor(cfg.fillCooldownSeconds ?? 0)) * 1000;
    const lastFillAt = ctx.cycle.lastEntryAt ?? 0;
    const cooling = cooldownMs > 0 && quotedMid != null && ctx.now - lastFillAt < cooldownMs;

    // Cotizaciones caducadas: por edad («actualizar órdenes después de») o por
    // el TTL del lado que sale. Se comprueban SOLO nuestros ids, generándolos,
    // y no todas las órdenes vivas: una que el usuario dejara puesta a mano
    // forzaría una recotización en cada tick para siempre.
    //
    // El MISMO conjunto decide si se recotiza y qué se deja de desear, y eso no
    // es una comodidad: si la caducidad solo forzara recotizar, con el precio
    // quieto el plan pediría los mismos precios, el diff los daría por buenos,
    // la antigüedad no se renovaría y el bot quedaría recotizando para siempre.
    // Ver `expiredQuotes`.
    const layerCount = Math.max(1, Math.floor(cfg.layers ?? 1));
    const ages = orderAges(ctx.openOrders);
    const roles = sideRoles(ctx.position ? D(ctx.position.qty) : D(0));
    const expired = cooling
      ? new Set<string>()
      : expiredQuotes({
          ages,
          now: ctx.now,
          layers: layerCount,
          coidFor: (kind, layer) => makeCoid(ctx.botId, seq, LevelKind[kind], layer),
          roles,
          maxAgeSeconds: cfg.orderMaxAgeSeconds,
          exitTtlSeconds: cfg.exitOrderTtlSeconds,
        });

    const shouldRequote =
      quotedMid == null || (!cooling && (staleByTime || staleByDrift || expired.size > 0));

    const mid = shouldRequote ? anchorNow : quotedMid!;
    if (shouldRequote) {
      scratchPatch['quotedMid'] = mid.toFixed(pd);
      scratchPatch['quotedAt'] = ctx.now;
    }

    // ── 4. Volatilidad realizada ──
    // Se muestrea DESPUÉS de decidir, y solo al recotizar: el diferencial únicamente
    // se aplica en ese momento, así que una muestra por tick sería una escritura en
    // la base por tick para afinar un número que no se va a usar hasta la siguiente
    // recotización.
    const vol = sampleVolatility(
      scratch,
      ctx.now,
      anchorNow,
      cfg.volatilitySampleSeconds,
      shouldRequote && cfg.dynamicSpread !== false,
    );
    if (vol.samples) scratchPatch['volSamples'] = vol.samples;

    // ── 5. Inventario, régimen y guardas ──
    const maxPos = D(cfg.maxBotPositionValue ?? 0);
    const inv = inventoryOf(ctx, mid, maxPos);
    const regime = riskRegime(inv.loadPct, cfg.defensiveThresholdPct, cfg.highRiskThresholdPct);
    const regimeMul = REGIME_DISTANCE[regime];
    const band = priceBand(cfg, mid);
    const atCap = maxPos.gt(0) && inv.exposure.abs().gte(maxPos);
    const breach = limitBreach(cfg, atCap, scratch);

    // ── 6. Diferencial compuesto ──
    const profile = profileOf(cfg.behaviorPreset);
    const buy = composeSpreadBps(cfg, D(cfg.buyDistanceBps), vol.volBps);
    const sell = composeSpreadBps(cfg, D(cfg.sellDistanceBps), vol.volBps);

    const layers = layerCount;
    const sizeWeights = geometricWeights(layers, cfg.layerSizeMultiplier ?? 1);
    const distWeights = geometricWeights(layers, cfg.layerDistanceMultiplier ?? 1);
    const size = D(cfg.orderSizePerSide ?? 0).mul(profile.size);

    const dir = cfg.direction ?? 'NEUTRAL';
    const quoteBids = dir === 'NEUTRAL' || dir === 'LONG';
    const quoteAsks = dir === 'NEUTRAL' || dir === 'SHORT';
    const orderType = cfg.postOnly === false ? 'LIMIT' : 'POST_ONLY';

    const buyRole = roles.buy;
    const sellRole = roles.sell;

    const orders: DesiredOrder[] = [];
    let projectedLong = inv.exposure.gt(0) ? inv.exposure : D(0);
    let projectedShort = inv.exposure.lt(0) ? inv.exposure.abs() : D(0);

    for (let l = 0; l < layers; l++) {
      const unit = size.mul(sizeWeights[l]);
      if (unit.lte(0)) continue;

      // ── Compras ──
      const buyMul = regimeMul[buyRole];
      if (
        quoteBids &&
        buyMul.gt(0) &&
        !(buyRole === 'adding' && (band.blockBuy || breach.pauseEntries))
      ) {
        const bps = Decimal.max(
          buy.floorBps,
          buy.bps.mul(distWeights[l]).mul(profile.distance).mul(buyMul),
        );
        const price = mid.mul(D(1).minus(bps.div(BPS)));
        const coid = makeCoid(ctx.botId, seq, LevelKind.QUOTE_BID, l);
        const reduceOnly = buyRole === 'reducing' && regime === 'HIGH_RISK';

        if (price.gt(0) && !expired.has(coid)) {
          // El recorte se hace en NOCIONAL, no sobre el tamaño configurado. Con
          // «cantidad de moneda» el tamaño va en la base y el hueco en la quote:
          // compararlos directamente hacía que el tope no frenara nada —0,5 BTC
          // «cabían» en un hueco de 1000 USDC y se colocaban 50 000.
          const wanted = sizeToQty(cfg.sizingMode, unit, price);
          const room = maxPos.gt(0) && !reduceOnly ? maxPos.minus(projectedLong) : wanted.notional;
          const notional = fitToRoom(cfg, wanted.notional, room, reduceOnly);
          // Sin recorte se conserva la cantidad exacta que pidió el usuario, en
          // vez de reconstruirla dividiendo y perdiendo el último decimal.
          const qty = notional.eq(wanted.notional) ? wanted.qty : notional.div(price);
          if (qty.gt(0)) {
            orders.push({
              clientOrderId: coid,
              levelKind: LevelKind.QUOTE_BID,
              levelIndex: l,
              side: 'BUY',
              type: orderType,
              price: px(ctx.market, price, 'BUY'),
              qty: qy(ctx.market, qty),
              reduceOnly,
            });
            if (!reduceOnly) projectedLong = projectedLong.plus(notional);
          }
        }
      }

      // ── Ventas ──
      const sellMul = regimeMul[sellRole];
      if (
        quoteAsks &&
        sellMul.gt(0) &&
        !(sellRole === 'adding' && (band.blockSell || breach.pauseEntries))
      ) {
        const bps = Decimal.max(
          sell.floorBps,
          sell.bps.mul(distWeights[l]).mul(profile.distance).mul(sellMul),
        );
        const price = mid.mul(D(1).plus(bps.div(BPS)));
        const coid = makeCoid(ctx.botId, seq, LevelKind.QUOTE_ASK, l);
        const reduceOnly = sellRole === 'reducing' && regime === 'HIGH_RISK';

        if (price.gt(0) && !expired.has(coid)) {
          // El recorte se hace en NOCIONAL, no sobre el tamaño configurado. Con
          // «cantidad de moneda» el tamaño va en la base y el hueco en la quote:
          // compararlos directamente hacía que el tope no frenara nada —0,5 BTC
          // «cabían» en un hueco de 1000 USDC y se colocaban 50 000.
          const wanted = sizeToQty(cfg.sizingMode, unit, price);
          const room = maxPos.gt(0) && !reduceOnly ? maxPos.minus(projectedShort) : wanted.notional;
          const notional = fitToRoom(cfg, wanted.notional, room, reduceOnly);
          // Sin recorte se conserva la cantidad exacta que pidió el usuario, en
          // vez de reconstruirla dividiendo y perdiendo el último decimal.
          const qty = notional.eq(wanted.notional) ? wanted.qty : notional.div(price);
          if (qty.gt(0)) {
            orders.push({
              clientOrderId: coid,
              levelKind: LevelKind.QUOTE_ASK,
              levelIndex: l,
              side: 'SELL',
              type: orderType,
              price: px(ctx.market, price, 'SELL'),
              qty: qy(ctx.market, qty),
              reduceOnly,
            });
            if (!reduceOnly) projectedShort = projectedShort.plus(notional);
          }
        }
      }
    }

    // ── 7. Cierre forzado por «acción al alcanzar el límite» ──
    const immediate: DesiredOrder[] = [];
    if (breach.flatten && inv.qty.abs().gt(0)) {
      immediate.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.STOP_LOSS, 0),
        levelKind: LevelKind.STOP_LOSS,
        levelIndex: 0,
        side: inv.qty.gt(0) ? 'SELL' : 'BUY',
        type: 'MARKET',
        price: px(ctx.market, mid, inv.qty.gt(0) ? 'SELL' : 'BUY'),
        qty: qy(ctx.market, inv.qty.abs()),
        reduceOnly: true,
      });
      scratchPatch['limitActionFiredAt'] = ctx.now;
      if (breach.shutdown) scratchPatch['requestStop'] = 'STOP_KEEP_POSITION';
    }

    const note =
      breach.note ??
      'Diferencial ' +
        buy.bps.toFixed(1) +
        '/' +
        sell.bps.toFixed(1) +
        ' bps (vol ' +
        vol.volBps.toFixed(1) +
        '), inventario ' +
        inv.loadPct.toFixed(0) +
        ' % del tope, ' +
        orders.length +
        ' cotizaciones' +
        (cooling ? ', espera tras ejecución' : '') +
        (regime === 'NORMAL' ? '' : '. Modo ' + regime.toLowerCase()) +
        '.';

    return {
      orders,
      immediate,
      targetLeverage: cfg.leverage,
      note,
      scratchPatch: Object.keys(scratchPatch).length ? scratchPatch : undefined,
    };
  },
};

/**
 * Recorta el nocional de una capa al hueco que queda hasta el tope.
 *
 * Los dos argumentos van en la MISMA unidad —la quote— a propósito: el tamaño
 * que teclea el usuario puede estar en moneda base, y mezclar unidades aquí es
 * exactamente lo que dejaba el tope sin efecto.
 *
 * Con «usar tamaño normal hasta el máximo» activado no se recorta: o cabe
 * entera o no se coloca. Es la diferencia entre una última capa de 3 USDC —que
 * el venue probablemente rechace por mínimo de orden— y ninguna capa.
 */
function fitToRoom(
  cfg: MarketMakerV2Config,
  notional: Decimal,
  room: Decimal,
  reduceOnly: boolean,
): Decimal {
  if (reduceOnly) return notional;
  if (room.lte(0)) return D(0);
  if (notional.lte(room)) return notional;
  return cfg.useFullSizeUntilMax ? D(0) : room;
}

