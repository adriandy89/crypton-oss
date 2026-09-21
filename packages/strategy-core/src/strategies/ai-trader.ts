/**
 * `AI_TRADER` — el «Bot de IA» (spec 068).
 *
 * Una operación cada vez, en el borde de una banda de Bollinger, con el
 * apalancamiento que permite su stop. El motor calcula una matriz de nueve
 * operaciones ya valoradas y **quien decide elige entre ellas**: el juez de
 * reglas hoy, un modelo en el spec 069.
 *
 * Lo que la separa del canal con IA no es el adorno, son tres decisiones:
 *
 * 1. **La dirección no se elige**: la fija el borde tocado. Eso quita la única
 *    decisión que un proveedor que evalúa sus preguntas en aislamiento no
 *    podría tomar bien.
 * 2. **El apalancamiento tampoco**: es siempre el menor que hace caber el
 *    margen, o sea la liquidación más lejana. Exponerlo solo añadiría varianza.
 * 3. **El objetivo nunca es el borde opuesto.** El spec 067 lo midió: hundía el
 *    R medio de +0,28 a −0,21 porque está a cuatro sigmas.
 *
 * Arranca **apagado dos veces**: `decisionMode` en `REGLAS` y `observeOnly` en
 * `true`. Un bot recién creado no llega ni al modelo ni al mercado hasta que su
 * dueño lo diga dos veces.
 */
import {
  AccionTrader,
  D,
  EstadoIntencion,
  MotivoRechazo,
  Decimal,
  LevelKind,
  ModoDecision,
  MotivoTrader,
  StrategyKind,
  apalancamientoPorStop,
  maintenanceMarginRateOf,
  type BotContext,
  type CommonBotConfig,
  type DesiredOrder,
  type DesiredState,
  type EspacioTrader,
  type FieldMeta,
  type MarketSpec,
  type PlanTrader,
  type PreviewResult,
  type StrategyMeta,
  type ValidationIssue,
  type ValidationResult,
} from '@crypton/shared';
import {
  buildPreview,
  commonFieldsWith,
  comunCon,
  err,
  invalidPreview,
  px,
  qy,
  toResult,
  validateCommon,
  warn,
  type RawLevel,
} from '../common';
import { makeCoid } from '../client-order-id';
import type { Strategy } from '../types';
import { serieNumerica } from '../canal/numeros';
import { serieFresca } from '../canal/velas';
import { DEFAULTS_TRADER, leerConfigTrader, type ConfigTrader } from '../trader/config';
import { senalTrader } from '../trader/senal';
import { espacioTrader } from '../trader/esqueletos';
import { construirOperacionTrader, cuantiza } from '../trader/construir';
import { juezTrader } from '../trader/juez';
import { regimen } from '../canal/regimen';

const QUINCE_MIN = 900_000;
/** Velas de 1 h que pide el filtro de régimen, más las tres de la histéresis. */
const VELAS_1H = 130;
/** Velas de 15 min: la ventana de la banda más margen para las tasas base. */
const VELAS_15M = 220;
const VELAS_5M = 144;

/**
 * El cierre a mercado: índice base, tope de intentos y espera entre ellos.
 *
 * El índice **sube en cada intento** a propósito. Con uno fijo, un cierre que se
 * llena a medias deja su fila ejecutada, y esa fila veta el reintento con el
 * mismo identificador: la posición se queda abierta para siempre. Es el mismo
 * patrón que el canal, y está aquí por la misma razón.
 */
const INDICE_CIERRE = 500;
const MAX_INTENTOS_CIERRE = 12;
const ESPERA_ENTRE_CIERRES_MS = 30_000;
/** Gracia para dar una vela por cerrada: el venue no publica al milisegundo. */
const GRACIA_VELA_MS = 20_000;

/** Un cierre a mercado en marcha, con lo que hace falta para no repetirlo mal. */
interface CierreEnCurso {
  motivo: string;
  intentos: number;
  ultimoEn: number;
}

export interface AiTraderConfig extends CommonBotConfig {
  decisionMode?: 'IA' | 'REGLAS';
  observeOnly?: boolean;
  entriesEnabled?: boolean;

  riskPerTradePct?: string | number;
  maxMarginPct?: string | number;
  maxNotionalMultiple?: string | number;
  liqBufferStops?: number;
  maxStopPct?: string | number;
  maxCostPerTradeR?: string | number;
  minTargetCostMultiple?: number;
  minRewardRisk?: string | number;
  maxEntrySlippageR?: string | number;
  maxSpreadFraction?: string | number;
  maxDrawdownPct?: string | number;
  dailyProfitTargetPct?: string | number;

  bandPeriod?: number;
  bandSigma?: string | number;
  bandWindowBars?: number;
  touchPercentB?: string | number;
  maxAdx1h?: string | number;
  minBandWidthAtr?: string | number;
  maxHalfLifeBars?: number;

  maxHoldBars?: number;
  invalidationAtr?: string | number;

  minRouteConfidence?: string | number;
  fullSizeConfidence?: string | number;
  minRegimeProb?: string | number;
  minExhaustionProb?: string | number;
  minEvidenceProb?: string | number;
  statedThreshold?: string | number;
  requireAgreement?: boolean;
  defaultStopBucket?: 'CENIDO' | 'MEDIDO' | 'HOLGADO';
  defaultTargetBucket?: 'CORTO' | 'EN_LA_MEDIA' | 'LARGO';
  halfSizeFallback?: 'NO_OPERAR' | 'COMPLETO';
  wrongEnvironmentCooldownBars?: number;

  maxTradesPerDay?: number;
  maxConsecutiveLosses?: number;
  lossStreakCooldownMinutes?: number;
  stopCooldownMinutes?: number;
  aiDailyCallBudget?: number;

  makerFeeBps?: string | number;
  takerFeeBps?: string | number;
  slippageBps?: string | number;
}

const d = DEFAULTS_TRADER;

const campo = (f: Omit<FieldMeta, 'mutability' | 'required'> & Partial<FieldMeta>): FieldMeta => ({
  mutability: 'HOT',
  required: false,
  ...f,
});

const COMUNES = [
  comunCon('exchangeAccountId', {}),
  comunCon('symbol', {}),
  comunCon('direction', { options: ['NEUTRAL', 'LONG', 'SHORT'], default: d.direction }),
  comunCon('marginMode', { options: ['ISOLATED'], default: d.marginMode, control: 'select' }),
  comunCon('leverage', { max: 25, default: d.leverage }),
  comunCon('totalInvestment', { min: 50 }),
  comunCon('maxNotionalCap', {}),
  comunCon('maxDailyLossPct', { min: 0.5, max: 6, default: Number(d.maxDailyLossPct) }),
  comunCon('liquidationAction', {}),
  comunCon('cooldownMinutes', { max: 1440, default: d.cooldownMinutes }),
];

const PROPIOS: FieldMeta[] = [
  campo({
    key: 'decisionMode',
    kind: 'enum',
    labelKey: 'strategy.aiTrader.decisionMode',
    helpKey: 'strategy.aiTrader.decisionModeHelp',
    options: ['REGLAS', 'IA'],
    default: d.decisionMode,
    group: 'core',
    control: 'segment',
  }),
  campo({
    key: 'observeOnly',
    kind: 'boolean',
    labelKey: 'strategy.aiTrader.observeOnly',
    helpKey: 'strategy.aiTrader.observeOnlyHelp',
    default: d.observeOnly,
    group: 'core',
  }),
  campo({
    key: 'entriesEnabled',
    kind: 'boolean',
    labelKey: 'strategy.aiTrader.entriesEnabled',
    helpKey: 'strategy.aiTrader.entriesEnabledHelp',
    default: d.entriesEnabled,
    group: 'core',
  }),

  campo({
    key: 'riskPerTradePct',
    kind: 'number',
    labelKey: 'strategy.aiTrader.riskPerTradePct',
    helpKey: 'strategy.aiTrader.riskPerTradePctHelp',
    min: 0.1,
    max: 2,
    step: 0.1,
    unit: '%',
    default: Number(d.riskPerTradePct),
    group: 'risk',
    risky: true,
  }),
  campo({
    key: 'maxMarginPct',
    kind: 'number',
    labelKey: 'strategy.aiTrader.maxMarginPct',
    helpKey: 'strategy.aiTrader.maxMarginPctHelp',
    min: 5,
    max: 100,
    step: 5,
    unit: '%',
    default: Number(d.maxMarginPct),
    group: 'risk',
    risky: true,
  }),
  campo({
    key: 'maxNotionalMultiple',
    kind: 'number',
    labelKey: 'strategy.aiTrader.maxNotionalMultiple',
    helpKey: 'strategy.aiTrader.maxNotionalMultipleHelp',
    min: 1,
    max: 25,
    step: 1,
    default: Number(d.maxNotionalMultiple),
    group: 'risk',
  }),
  campo({
    key: 'liqBufferStops',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.liqBufferStops',
    helpKey: 'strategy.aiTrader.liqBufferStopsHelp',
    min: 3,
    max: 10,
    step: 1,
    default: d.liqBufferStops,
    group: 'risk',
    advanced: true,
  }),
  campo({
    key: 'maxStopPct',
    kind: 'number',
    labelKey: 'strategy.aiTrader.maxStopPct',
    helpKey: 'strategy.aiTrader.maxStopPctHelp',
    min: 0.1,
    max: 5,
    step: 0.1,
    unit: '%',
    default: Number(d.maxStopPct),
    group: 'risk',
  }),
  campo({
    key: 'maxCostPerTradeR',
    kind: 'number',
    labelKey: 'strategy.aiTrader.maxCostPerTradeR',
    helpKey: 'strategy.aiTrader.maxCostPerTradeRHelp',
    min: 0.05,
    max: 0.6,
    step: 0.05,
    default: Number(d.maxCostPerTradeR),
    group: 'risk',
    risky: true,
  }),
  campo({
    key: 'minTargetCostMultiple',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.minTargetCostMultiple',
    helpKey: 'strategy.aiTrader.minTargetCostMultipleHelp',
    min: 15,
    max: 60,
    step: 1,
    default: d.minTargetCostMultiple,
    group: 'risk',
    risky: true,
  }),
  campo({
    key: 'minRewardRisk',
    kind: 'number',
    labelKey: 'strategy.aiTrader.minRewardRisk',
    helpKey: 'strategy.aiTrader.minRewardRiskHelp',
    min: 0.5,
    max: 5,
    step: 0.1,
    default: Number(d.minRewardRisk),
    group: 'risk',
  }),
  campo({
    key: 'maxEntrySlippageR',
    kind: 'number',
    labelKey: 'strategy.aiTrader.maxEntrySlippageR',
    helpKey: 'strategy.aiTrader.maxEntrySlippageRHelp',
    min: 0.05,
    max: 0.5,
    step: 0.05,
    default: Number(d.maxEntrySlippageR),
    group: 'risk',
    advanced: true,
  }),
  campo({
    key: 'maxSpreadFraction',
    kind: 'number',
    labelKey: 'strategy.aiTrader.maxSpreadFraction',
    helpKey: 'strategy.aiTrader.maxSpreadFractionHelp',
    min: 0.02,
    max: 0.5,
    step: 0.01,
    default: Number(d.maxSpreadFraction),
    group: 'risk',
    advanced: true,
  }),

  campo({
    key: 'bandPeriod',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.bandPeriod',
    helpKey: 'strategy.aiTrader.bandPeriodHelp',
    min: 10,
    max: 50,
    step: 1,
    default: d.bandPeriod,
    group: 'intelligence',
    mutability: 'COLD',
    advanced: true,
  }),
  campo({
    key: 'bandSigma',
    kind: 'number',
    labelKey: 'strategy.aiTrader.bandSigma',
    helpKey: 'strategy.aiTrader.bandSigmaHelp',
    min: 1.5,
    max: 3,
    step: 0.1,
    default: Number(d.bandSigma),
    group: 'intelligence',
    mutability: 'COLD',
    advanced: true,
  }),
  campo({
    key: 'bandWindowBars',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.bandWindowBars',
    helpKey: 'strategy.aiTrader.bandWindowBarsHelp',
    min: 48,
    max: 200,
    step: 1,
    default: d.bandWindowBars,
    group: 'intelligence',
    mutability: 'COLD',
    advanced: true,
  }),
  campo({
    key: 'touchPercentB',
    kind: 'number',
    labelKey: 'strategy.aiTrader.touchPercentB',
    helpKey: 'strategy.aiTrader.touchPercentBHelp',
    min: 0,
    max: 0.2,
    step: 0.01,
    default: Number(d.touchPercentB),
    group: 'intelligence',
  }),
  campo({
    key: 'maxAdx1h',
    kind: 'number',
    labelKey: 'strategy.aiTrader.maxAdx1h',
    helpKey: 'strategy.aiTrader.maxAdx1hHelp',
    min: 12,
    max: 30,
    step: 1,
    default: Number(d.maxAdx1h),
    group: 'intelligence',
    risky: true,
  }),
  campo({
    key: 'minBandWidthAtr',
    kind: 'number',
    labelKey: 'strategy.aiTrader.minBandWidthAtr',
    helpKey: 'strategy.aiTrader.minBandWidthAtrHelp',
    min: 1,
    max: 6,
    step: 0.5,
    default: Number(d.minBandWidthAtr),
    group: 'intelligence',
  }),
  campo({
    key: 'maxHalfLifeBars',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.maxHalfLifeBars',
    helpKey: 'strategy.aiTrader.maxHalfLifeBarsHelp',
    min: 2,
    max: 30,
    step: 1,
    default: d.maxHalfLifeBars,
    group: 'intelligence',
    advanced: true,
  }),

  campo({
    key: 'maxHoldBars',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.maxHoldBars',
    helpKey: 'strategy.aiTrader.maxHoldBarsHelp',
    min: 4,
    max: 48,
    step: 1,
    default: d.maxHoldBars,
    group: 'levels',
  }),
  campo({
    key: 'invalidationAtr',
    kind: 'number',
    labelKey: 'strategy.aiTrader.invalidationAtr',
    helpKey: 'strategy.aiTrader.invalidationAtrHelp',
    min: 0.25,
    max: 1,
    step: 0.05,
    default: Number(d.invalidationAtr),
    group: 'levels',
    advanced: true,
  }),

  campo({
    key: 'minRouteConfidence',
    kind: 'number',
    labelKey: 'strategy.aiTrader.minRouteConfidence',
    helpKey: 'strategy.aiTrader.minRouteConfidenceHelp',
    min: 0.2,
    max: 0.99,
    step: 0.05,
    default: Number(d.minRouteConfidence),
    group: 'intelligence',
    risky: true,
  }),
  campo({
    key: 'fullSizeConfidence',
    kind: 'number',
    labelKey: 'strategy.aiTrader.fullSizeConfidence',
    helpKey: 'strategy.aiTrader.fullSizeConfidenceHelp',
    min: 0.3,
    max: 0.99,
    step: 0.05,
    default: Number(d.fullSizeConfidence),
    group: 'intelligence',
    risky: true,
  }),
  campo({
    key: 'requireAgreement',
    kind: 'boolean',
    labelKey: 'strategy.aiTrader.requireAgreement',
    helpKey: 'strategy.aiTrader.requireAgreementHelp',
    default: d.requireAgreement,
    group: 'intelligence',
    risky: true,
  }),
  campo({
    key: 'minRegimeProb',
    kind: 'number',
    labelKey: 'strategy.aiTrader.minRegimeProb',
    helpKey: 'strategy.aiTrader.minRegimeProbHelp',
    min: 0.3,
    max: 0.99,
    step: 0.05,
    default: Number(d.minRegimeProb),
    group: 'intelligence',
    advanced: true,
  }),
  campo({
    key: 'minExhaustionProb',
    kind: 'number',
    labelKey: 'strategy.aiTrader.minExhaustionProb',
    helpKey: 'strategy.aiTrader.minExhaustionProbHelp',
    min: 0.3,
    max: 0.99,
    step: 0.05,
    default: Number(d.minExhaustionProb),
    group: 'intelligence',
    advanced: true,
  }),
  campo({
    key: 'minEvidenceProb',
    kind: 'number',
    labelKey: 'strategy.aiTrader.minEvidenceProb',
    helpKey: 'strategy.aiTrader.minEvidenceProbHelp',
    min: 0.1,
    max: 0.99,
    step: 0.05,
    default: Number(d.minEvidenceProb),
    group: 'intelligence',
    advanced: true,
  }),
  campo({
    key: 'statedThreshold',
    kind: 'number',
    labelKey: 'strategy.aiTrader.statedThreshold',
    helpKey: 'strategy.aiTrader.statedThresholdHelp',
    min: 0.3,
    max: 0.95,
    step: 0.05,
    default: Number(d.statedThreshold),
    group: 'intelligence',
    advanced: true,
  }),
  campo({
    key: 'defaultStopBucket',
    kind: 'enum',
    labelKey: 'strategy.aiTrader.defaultStopBucket',
    helpKey: 'strategy.aiTrader.defaultStopBucketHelp',
    options: ['CENIDO', 'MEDIDO', 'HOLGADO'],
    default: d.defaultStopBucket,
    group: 'intelligence',
    control: 'segment',
  }),
  campo({
    key: 'defaultTargetBucket',
    kind: 'enum',
    labelKey: 'strategy.aiTrader.defaultTargetBucket',
    helpKey: 'strategy.aiTrader.defaultTargetBucketHelp',
    options: ['CORTO', 'EN_LA_MEDIA', 'LARGO'],
    default: d.defaultTargetBucket,
    group: 'intelligence',
    control: 'segment',
  }),
  campo({
    key: 'halfSizeFallback',
    kind: 'enum',
    labelKey: 'strategy.aiTrader.halfSizeFallback',
    helpKey: 'strategy.aiTrader.halfSizeFallbackHelp',
    options: ['NO_OPERAR', 'COMPLETO'],
    default: d.halfSizeFallback,
    group: 'intelligence',
    control: 'segment',
    risky: true,
  }),
  campo({
    key: 'wrongEnvironmentCooldownBars',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.wrongEnvironmentCooldownBars',
    helpKey: 'strategy.aiTrader.wrongEnvironmentCooldownBarsHelp',
    min: 0,
    max: 96,
    step: 1,
    default: d.wrongEnvironmentCooldownBars,
    group: 'intelligence',
    advanced: true,
  }),
  campo({
    key: 'aiDailyCallBudget',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.aiDailyCallBudget',
    helpKey: 'strategy.aiTrader.aiDailyCallBudgetHelp',
    min: 1,
    max: 96,
    step: 1,
    default: d.aiDailyCallBudget,
    group: 'intelligence',
    advanced: true,
  }),

  campo({
    key: 'maxDrawdownPct',
    kind: 'number',
    labelKey: 'strategy.aiTrader.maxDrawdownPct',
    helpKey: 'strategy.aiTrader.maxDrawdownPctHelp',
    min: 2,
    max: 50,
    step: 1,
    unit: '%',
    default: Number(d.maxDrawdownPct),
    group: 'risk',
    risky: true,
  }),
  campo({
    key: 'dailyProfitTargetPct',
    kind: 'number',
    labelKey: 'strategy.aiTrader.dailyProfitTargetPct',
    helpKey: 'strategy.aiTrader.dailyProfitTargetPctHelp',
    min: 0,
    max: 50,
    step: 1,
    unit: '%',
    default: Number(d.dailyProfitTargetPct),
    group: 'risk',
  }),
  campo({
    key: 'maxTradesPerDay',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.maxTradesPerDay',
    helpKey: 'strategy.aiTrader.maxTradesPerDayHelp',
    min: 1,
    max: 48,
    step: 1,
    default: d.maxTradesPerDay,
    group: 'timing',
  }),
  campo({
    key: 'maxConsecutiveLosses',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.maxConsecutiveLosses',
    helpKey: 'strategy.aiTrader.maxConsecutiveLossesHelp',
    min: 1,
    max: 10,
    step: 1,
    default: d.maxConsecutiveLosses,
    group: 'timing',
  }),
  campo({
    key: 'lossStreakCooldownMinutes',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.lossStreakCooldownMinutes',
    helpKey: 'strategy.aiTrader.lossStreakCooldownMinutesHelp',
    min: 0,
    max: 1440,
    step: 15,
    default: d.lossStreakCooldownMinutes,
    group: 'timing',
  }),
  campo({
    key: 'stopCooldownMinutes',
    kind: 'integer',
    labelKey: 'strategy.aiTrader.stopCooldownMinutes',
    helpKey: 'strategy.aiTrader.stopCooldownMinutesHelp',
    min: 0,
    max: 720,
    step: 15,
    default: d.stopCooldownMinutes,
    group: 'timing',
  }),

  campo({
    key: 'makerFeeBps',
    kind: 'number',
    labelKey: 'strategy.aiTrader.makerFeeBps',
    helpKey: 'strategy.aiTrader.makerFeeBpsHelp',
    min: 0,
    max: 20,
    step: 0.1,
    default: null,
    group: 'venue',
    advanced: true,
  }),
  campo({
    key: 'takerFeeBps',
    kind: 'number',
    labelKey: 'strategy.aiTrader.takerFeeBps',
    helpKey: 'strategy.aiTrader.takerFeeBpsHelp',
    min: 0,
    max: 20,
    step: 0.1,
    default: null,
    group: 'venue',
    advanced: true,
  }),
  campo({
    key: 'slippageBps',
    kind: 'number',
    labelKey: 'strategy.aiTrader.slippageBps',
    helpKey: 'strategy.aiTrader.slippageBpsHelp',
    min: 0,
    max: 20,
    step: 0.1,
    default: null,
    group: 'venue',
    advanced: true,
  }),
];

const META: StrategyMeta = {
  kind: StrategyKind.AI_TRADER,
  labelKey: 'strategy.aiTrader.label',
  descriptionKey: 'strategy.aiTrader.description',
  fields: [...commonFieldsWith(COMUNES), ...PROPIOS],
};

/** Lo que el bot recuerda entre ticks. */
interface OperacionGuardada {
  plan: PlanTrader;
  intento: number;
  enviadaEn: number;
  cierre?: CierreEnCurso;
}

const leer = (config: AiTraderConfig, venue: MarketSpec['venue']): ConfigTrader =>
  leerConfigTrader(config as never, venue);

const nocionalMaximoDe = (c: ConfigTrader): Decimal =>
  c.topeNocional
    ? Decimal.min(c.capital.mul(c.multiploNocional), c.topeNocional)
    : c.capital.mul(c.multiploNocional);

function leerOperacion(v: unknown): OperacionGuardada | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as OperacionGuardada;
  return o.plan && typeof o.plan.stop === 'string' ? o : null;
}

const sinEntrada = (note: string, extra: Partial<DesiredState> = {}): DesiredState => ({
  orders: [],
  immediate: [],
  note,
  ...extra,
});

// ── Con la posición abierta ─────────────────────────────────────────────────

const ordenStop = (
  ctx: BotContext,
  seq: number,
  lado: 'BUY' | 'SELL',
  precio: string,
  cantidad: Decimal,
): DesiredOrder => ({
  clientOrderId: makeCoid(ctx.botId, seq, LevelKind.STOP_LOSS, 0),
  levelKind: LevelKind.STOP_LOSS,
  levelIndex: 0,
  side: lado,
  type: 'MARKET',
  price: precio,
  triggerPrice: precio,
  qty: qy(ctx.market, cantidad),
  reduceOnly: true,
});

const ordenObjetivo = (
  ctx: BotContext,
  seq: number,
  lado: 'BUY' | 'SELL',
  precio: string,
  cantidad: Decimal,
): DesiredOrder => ({
  clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
  levelKind: LevelKind.TAKE_PROFIT,
  levelIndex: 0,
  side: lado,
  type: 'LIMIT',
  price: precio,
  qty: qy(ctx.market, cantidad),
  reduceOnly: true,
});

/**
 * Un cierre a mercado, con su reintento bien hecho.
 *
 * El índice del identificador **sube en cada intento**: con uno fijo, un cierre
 * llenado a medias deja su fila ejecutada y esa fila veta el reintento, con la
 * posición abierta y nadie mirándola. Y hay tope de intentos y espera entre
 * ellos, porque machacar al venue con la misma orden rechazada no la acepta
 * antes (spec 068).
 */
function cierreAMercado(
  ctx: BotContext,
  seq: number,
  lado: 'BUY' | 'SELL',
  cantidad: Decimal,
  previo: CierreEnCurso | null,
  motivo: string,
): { immediate: DesiredOrder[]; cierre: CierreEnCurso; agotado: boolean } {
  const cierre = previo ?? { motivo, intentos: 0, ultimoEn: 0 };
  if (cierre.intentos >= MAX_INTENTOS_CIERRE) return { immediate: [], cierre, agotado: true };
  if (ctx.now - cierre.ultimoEn < ESPERA_ENTRE_CIERRES_MS) {
    return { immediate: [], cierre, agotado: false };
  }
  const indice = INDICE_CIERRE + cierre.intentos;
  return {
    immediate: [
      {
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, indice),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: indice,
        side: lado,
        type: 'MARKET',
        price: px(ctx.market, D(ctx.ticker.mark), lado),
        qty: qy(ctx.market, cantidad),
        reduceOnly: true,
      },
    ],
    cierre: { motivo: cierre.motivo, intentos: cierre.intentos + 1, ultimoEn: ctx.now },
    agotado: false,
  };
}

/**
 * Una posición que no es de este bot, o de la que se perdió el plan.
 *
 * No se adivina: se protege con un stop al precio de mercado y se avisa. Cerrar
 * a ciegas algo que no se sabe qué es sería peor.
 */
function posicionHuerfana(
  ctx: BotContext,
  seq: number,
  qty: Decimal,
  previo: CierreEnCurso | null,
): DesiredState {
  const largo = qty.gt(0);
  const r = cierreAMercado(ctx, seq, largo ? 'SELL' : 'BUY', qty.abs(), previo, 'HUERFANA');
  return {
    orders: [],
    immediate: r.immediate,
    scratchPatch: { cierreHuerfana: r.cierre },
    note: r.agotado
      ? 'Posición sin plan que no se deja cerrar. Ciérrala tú desde el exchange.'
      : 'Posición sin plan conocido: se cierra a mercado.',
    avisos: [
      {
        clave: r.agotado ? 'trader-huerfana-agotada' : 'trader-huerfana',
        tipo: 'POSICION_HUERFANA',
        severidad: r.agotado ? 'CRITICAL' : 'WARN',
        mensaje: r.agotado
          ? 'Hay una posición abierta sin plan del bot y no se ha podido cerrar tras varios ' +
            'intentos. Hay que cerrarla a mano en el exchange.'
          : 'Había una posición abierta sin plan del bot. Se cierra a mercado.',
      },
    ],
  };
}

function leerCierre(v: unknown): CierreEnCurso | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as CierreEnCurso;
  return typeof c.intentos === 'number' ? c : null;
}

/**
 * ¿El precio se fue del montaje que se operó?
 *
 * Se mide contra la banda que había AL ENTRAR —viaja en el plan— y no contra la
 * de ahora: la banda se mueve, y comparar contra una banda que ha perseguido al
 * precio diría que nada se invalida nunca.
 */
function invalidacion(ctx: BotContext, c: ConfigTrader, op: OperacionGuardada): boolean {
  if (!(c.invalidacionAtr > 0)) return false;
  const largo = op.plan.lado === 'LONG';
  const marca = D(ctx.ticker.mark);
  const borde = D(largo ? op.plan.banda.inferior : op.plan.banda.superior);
  const anchura = D(op.plan.banda.superior).minus(op.plan.banda.inferior);
  if (!anchura.gt(0)) return false;
  // La holgura se mide en fracción de la anchura de la banda, que es la unidad
  // natural aquí: un ATR suelto no dice nada sobre una banda concreta.
  const holgura = anchura.mul(D(String(c.invalidacionAtr)));
  return largo ? marca.lt(borde.minus(holgura)) : marca.gt(borde.plus(holgura));
}

function conPosicion(
  ctx: BotContext,
  c: ConfigTrader,
  seq: number,
  op: OperacionGuardada | null,
  qtyPos: Decimal,
): DesiredState {
  const largo = qtyPos.gt(0);
  if (!op || op.plan.lado !== (largo ? 'LONG' : 'SHORT')) {
    const previo = leerCierre(ctx.cycle.scratch['cierreHuerfana']);
    return posicionHuerfana(ctx, seq, qtyPos, previo);
  }
  const lado = largo ? 'SELL' : 'BUY';
  const abs = qtyPos.abs();

  // Dos salidas que necesitan al bot vivo. El stop y el objetivo NO: son órdenes
  // nativas del venue y siguen ahí aunque el worker muera.
  //
  //  1. El tiempo: pasadas las velas del dueño, se cierra a mercado.
  //  2. La invalidación: el precio se ha ido tan lejos del borde que el montaje
  //     ya no es el que se operó. `invalidationAtr` mide cuánto, en ATR.
  const invalidado = invalidacion(ctx, c, op);
  const motivo = ctx.now >= op.plan.venceEn ? 'TIEMPO' : invalidado ? 'INVALIDADO' : null;

  if (motivo) {
    const r = cierreAMercado(ctx, seq, lado, abs, op.cierre ?? null, motivo);
    return {
      orders: [
        // El stop se mantiene mientras se intenta cerrar: si el cierre no sale,
        // la posición no puede quedarse sin red.
        ordenStop(ctx, seq, lado, op.plan.stop, abs),
      ],
      immediate: r.immediate,
      scratchPatch: { op: { ...op, cierre: r.cierre } satisfies OperacionGuardada },
      note: r.agotado
        ? `No se ha podido cerrar tras ${MAX_INTENTOS_CIERRE} intentos (${motivo}). El stop sigue puesto.`
        : motivo === 'TIEMPO'
          ? `Cierre por tiempo: pasaron ${c.maxVelasOperacion} velas de 15 min.`
          : 'Cierre: el precio se fue del montaje que se operó.',
      avisos: r.agotado
        ? [
            {
              clave: 'trader-cierre-agotado',
              tipo: 'CIERRE_AGOTADO',
              severidad: 'CRITICAL',
              mensaje:
                'La operación no se ha podido cerrar a mercado tras varios intentos. El stop ' +
                'nativo sigue colocado, pero conviene mirarlo.',
            },
          ]
        : undefined,
    };
  }

  return {
    orders: [
      ordenStop(ctx, seq, lado, op.plan.stop, abs),
      ordenObjetivo(ctx, seq, lado, op.plan.objetivos[0].precio, abs),
    ],
    immediate: [],
    note:
      `Posición ${largo ? 'larga' : 'corta'} de ${abs.toFixed()}: stop ${op.plan.stop}, ` +
      `objetivo ${op.plan.objetivos[0].precio}.`,
  };
}

// ── En plano ────────────────────────────────────────────────────────────────

/** Las velas de 15 min que hay que mirar: es donde vive la señal. */
function seriesDe(): { interval: '5m' | '15m' | '1h'; bars: number }[] {
  return [
    { interval: '5m', bars: VELAS_5M },
    { interval: '15m', bars: VELAS_15M },
    { interval: '1h', bars: VELAS_1H },
  ];
}

/** La oferta de esta vela, o `null` si no hay nada que ofrecer. */
function ofertaDe(ctx: BotContext, c: ConfigTrader): EspacioTrader | null {
  const s5 = ctx.series?.['5m'];
  const s15 = ctx.series?.['15m'];
  const h1 = ctx.series?.['1h'];
  if (!s5?.length || !s15?.length || !h1?.length || !ctx.historial) return null;

  const n5 = serieNumerica(s5);
  const n15 = serieNumerica(s15);
  const n1h = serieNumerica(h1);
  const r = senalTrader({
    s5: n5,
    s15: n15,
    h1: n1h,
    bid: Number(ctx.ticker.bid),
    ask: Number(ctx.ticker.ask),
    p: {
      periodoBanda: c.periodoBanda,
      sigmaBanda: c.sigmaBanda,
      ventanaBanda: c.ventanaBanda,
      toquePorcentajeB: c.toquePorcentajeB,
      costes: c.costes,
    },
  });
  if (!r || !r.senal.lado) return null;

  const b = n15.n - 1;
  return espacioTrader({
    cfg: c,
    market: ctx.market,
    ticker: ctx.ticker,
    senal: r.senal,
    banda: r.banda,
    extremo: r.senal.lado === 'LONG' ? n15.l[b] : n15.h[b],
    niveles: ctx.nivelesApalancamiento ?? [],
    historial: ctx.historial,
    saldoLibre: ctx.availableBalance,
    atr1h: String(r.atr1h),
    maxApalancamientoUsuario: null,
    barT: n15.t[b],
    ahora: ctx.now,
  });
}

/**
 * ¿Hay que pausar el bot entero?
 *
 * Es para lo que NO se cura solo. La caída máxima se mide desde el pico de lo
 * realizado: si el bot ha devuelto más de lo que su dueño aguanta, parar y que
 * lo reanude una persona. Lo que sí se cura —el tope del día, una espera— es
 * una puerta del plan, no una pausa.
 */
function pausaNecesaria(ctx: BotContext, c: ConfigTrader): string | null {
  const h = ctx.historial;
  if (!h || !c.maxCaidaPct.gt(0) || !c.capital.gt(0)) return null;
  const pico = D(h.picoRealizado);
  const ahora = D(h.realizadoTotal);
  const caida = pico.minus(ahora);
  if (!caida.gt(0)) return null;
  const tope = c.capital.mul(c.maxCaidaPct).div(100);
  if (caida.lt(tope)) return null;
  return (
    `Caída máxima alcanzada: ${caida.toFixed(2)} desde el pico, y el tope es ` +
    `${tope.toFixed(2)} (${c.maxCaidaPct.toFixed()} % del capital).`
  );
}

/**
 * El spread del libro, en fracción del ATR de 15 min.
 *
 * Se deriva de la propia señal en vez de volver a leer el ticker: la anchura de
 * la banda viene en las dos unidades —en ATR y en % del precio—, así que el ATR
 * en porcentaje sale de dividirlas, y con él el spread queda en la misma unidad
 * que pide el mando del usuario.
 */
function fraccionDeSpread(espacio: EspacioTrader): number | null {
  const { spreadBps, anchuraAtr, anchuraPct } = espacio.senal;
  if (!(anchuraAtr > 0) || !(anchuraPct > 0)) return null;
  const atrPct = anchuraPct / anchuraAtr;
  if (!(atrPct > 0)) return null;
  return spreadBps / 100 / atrPct;
}

/** Las puertas del día: lo que no depende del mercado. */
function puertasDelDia(ctx: BotContext, c: ConfigTrader): string | null {
  const h = ctx.historial;
  if (!h) return null;
  if (!c.entradasActivas) return 'Las entradas están desactivadas.';
  if (h.operacionesHoy >= c.maxOperacionesDia) {
    return `Tope del día: ${c.maxOperacionesDia} operaciones.`;
  }
  const perdido = D(h.realizadoHoy);
  if (perdido.lt(0) && perdido.abs().gte(c.capital.mul(c.maxPerdidaDiaPct).div(100))) {
    return 'Tope de pérdida del día alcanzado.';
  }
  // El objetivo de ganancia del día: al llegar, deja de entrar. Cero lo apaga.
  if (c.objetivoDiarioPct.gt(0)) {
    const meta = c.capital.mul(c.objetivoDiarioPct).div(100);
    if (D(h.realizadoHoy).gte(meta)) {
      return `Objetivo del día alcanzado (${c.objetivoDiarioPct.toFixed()} % del capital).`;
    }
  }
  if (h.rachaPerdidas >= c.maxPerdidasSeguidas && h.ultimaPerdidaEn !== null) {
    const hasta = h.ultimaPerdidaEn + c.esperaRachaMin * 60_000;
    if (ctx.now < hasta) return 'Racha de pérdidas: esperando.';
  }
  if (h.ultimoStopEn !== null && ctx.now < h.ultimoStopEn + c.esperaStopMin * 60_000) {
    return 'Espera tras el último stop.';
  }
  if (h.ultimoCierreEn !== null && ctx.now < h.ultimoCierreEn + c.esperaMin * 60_000) {
    return 'Espera entre operaciones.';
  }
  return null;
}

function enPlano(ctx: BotContext, c: ConfigTrader, seq: number): DesiredState {
  const pausa = pausaNecesaria(ctx, c);
  if (pausa) return { orders: [], immediate: [], note: pausa, pausar: pausa };

  const puerta = puertasDelDia(ctx, c);
  if (puerta) return sinEntrada(puerta);

  // Las velas, cerradas de verdad. Sin esto la señal puede salir de una vela a
  // medio formar, que es una señal que cambia sola antes de ejecutarse.
  for (const [intervalo, velas] of [
    ['5m', ctx.series?.['5m']],
    ['15m', ctx.series?.['15m']],
    ['1h', ctx.series?.['1h']],
  ] as const) {
    if (!serieFresca(velas, intervalo, ctx.now, GRACIA_VELA_MS)) {
      return sinEntrada(`Esperando la última vela de ${intervalo}.`);
    }
  }

  const espacio = ofertaDe(ctx, c);
  if (!espacio) return sinEntrada('Sin toque de banda en esta vela.');

  // El libro, lo bastante cerrado. Un spread ancho se come el viaje antes de
  // empezarlo, y además dice que ahí no hay nadie con quien operar.

  const spreadFraccion = fraccionDeSpread(espacio);
  if (spreadFraccion !== null && spreadFraccion > c.maxSpreadFraccion) {
    return sinEntrada('El libro está demasiado abierto para entrar.');
  }
  if (!espacio.esqueletos.some((x) => x.viable)) {
    return sinEntrada('Hay toque, pero ninguna operación cierra su aritmética.');
  }

  // El enfriado tras un entorno equivocado: se deja de mirar durante unas velas.
  const enfriado = Number(ctx.cycle.scratch['enfriadoHasta'] ?? 0);
  if (ctx.now < enfriado) return sinEntrada('Entorno equivocado: esperando a que cambie.');

  // Decide el juez. El modo IA no llega aquí: `validate()` lo rechaza mientras
  // no haya proveedor cableado (spec 069). Antes esta rama escribía una
  // solicitud que nadie atendía —la barrera de la API sigue clavada al canal—,
  // así que el bot se quedaba mirando en silencio para siempre. Prefiero que no
  // se pueda elegir a que se pueda elegir y no haga nada.
  const s15 = ctx.series?.['15m'];
  const h1 = ctx.series?.['1h'];
  if (!s15 || !h1) return sinEntrada('Sin series para decidir.');

  const reg = regimen(serieNumerica(h1), serieNumerica(s15));
  const respuesta = juezTrader(espacio, reg, c);
  const veredicto = cuantiza(respuesta, c);
  const patch: Record<string, unknown> = {};

  if (veredicto.accion === AccionTrader.ENTORNO_EQUIVOCADO && c.enfriadoEntornoVelas > 0) {
    patch['enfriadoHasta'] = ctx.now + c.enfriadoEntornoVelas * QUINCE_MIN;
  }

  // El id lleva la vela dentro: es la idempotencia de la fila del histórico, y
  // lo que impide que una misma vela se decida dos veces.
  const intentId = `reglas:${espacio.barT}`;
  const r = construirOperacionTrader(espacio, veredicto, c, ctx.market, intentId, ctx.now);
  const scratchPatch = Object.keys(patch).length > 0 ? patch : undefined;

  if (!r.plan) return sinEntrada(motivoLegible(r.motivo), { scratchPatch });

  const plan = r.plan;
  if (c.soloObservar) {
    // Se guarda con sus números: es la constancia de lo que habría hecho, que
    // es exactamente para lo que sirve «solo observar».
    return sinEntrada(
      `Solo observar: habría entrado ${plan.lado === 'LONG' ? 'en largo' : 'en corto'} con ` +
        `${plan.cantidad} a ${plan.apalancamiento}x, stop ${plan.stop}.`,
      {
        scratchPatch,
        decision: {
          intentId,
          estado: EstadoIntencion.RECHAZADA,
          motivo: MotivoRechazo.PUERTA,
          plan,
        },
      },
    );
  }

  const intento = Number(ctx.cycle.scratch['intentos'] ?? 0);
  patch['op'] = { plan, intento, enviadaEn: ctx.now } satisfies OperacionGuardada;
  patch['intentos'] = intento + 1;
  const largo = plan.lado === 'LONG';

  return {
    decision: { intentId, estado: EstadoIntencion.ACEPTADA, motivo: null, plan },
    orders: [
      {
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.BASE, intento),
        levelKind: LevelKind.BASE,
        levelIndex: intento,
        side: largo ? 'BUY' : 'SELL',
        type: 'LIMIT',
        timeInForce: 'IOC',
        price: plan.entradaTope,
        qty: plan.cantidad,
        reduceOnly: false,
      },
    ],
    immediate: [],
    apalancamiento: plan.apalancamiento,
    scratchPatch: patch,
    note:
      `Entrada ${largo ? 'larga' : 'corta'}: ${plan.cantidad} hasta ${plan.entradaTope} a ` +
      `${plan.apalancamiento}x, stop ${plan.stop}, R ${plan.rNeto.toFixed(2)}.`,
  };
}

function motivoLegible(m: MotivoTrader): string {
  switch (m) {
    case MotivoTrader.ENTORNO:
      return 'Entorno equivocado: el mercado no está oscilando.';
    case MotivoTrader.CONFIANZA:
      return 'La confianza no llega al mínimo pedido.';
    case MotivoTrader.DESACUERDO:
      return 'El contexto no acompaña al toque.';
    case MotivoTrader.OFERTA:
      return 'Ninguna operación de la matriz era viable.';
    case MotivoTrader.MINIMO:
      return 'La operación no llega a los mínimos del venue.';
    default:
      return 'Esta vela no se opera.';
  }
}

// ── La estrategia ───────────────────────────────────────────────────────────

export const aiTrader: Strategy<AiTraderConfig> = {
  kind: StrategyKind.AI_TRADER,
  meta: META,

  stopPropio: true,
  apalancamientoPorOperacion: true,
  reglaLiquidacion: 'POR_STOP',
  topeDiarioReanuda: true,
  consumeDecisionesIa: true,
  sinIa: (config) => ({ ...config, decisionMode: 'REGLAS' }),
  series: () => seriesDe(),
  nocionalMaximo: (config) => nocionalMaximoDe(leer(config, 'HYPERLIQUID')).toFixed(),

  defaults() {
    return { ...DEFAULTS_TRADER };
  },

  validate(config: AiTraderConfig, market: MarketSpec): ValidationResult {
    const issues: ValidationIssue[] = validateCommon(config, market, {
      reglaLiquidacion: 'POR_STOP',
    });
    const c = leer(config, market.venue);

    if (config.marginMode !== 'ISOLATED') {
      issues.push(
        err(
          'marginMode',
          'Solo margen aislado: la pérdida en un hueco se acota con el margen de cada operación.',
        ),
      );
    }
    if (!c.riesgoPctOperacion.gt(0) || c.riesgoPctOperacion.gt(2)) {
      issues.push(err('riskPerTradePct', 'El riesgo por operación va de 0,1 % a 2 %.'));
    }
    if (c.maxPerdidaDiaPct.lt(c.riesgoPctOperacion)) {
      issues.push(
        err(
          'maxDailyLossPct',
          'La pérdida diaria máxima no puede ser menor que el riesgo de una sola operación.',
        ),
      );
    }
    // El spec 066 midió que por debajo de quince veces el coste se pierde de
    // media. No es una preferencia: es la zona donde la aritmética no cierra.
    if (c.minObjetivoCoste < 15) {
      issues.push(
        err(
          'minTargetCostMultiple',
          'Medido sobre doce pares y siete meses: con el objetivo por debajo de quince veces el ' +
            'coste de ida y vuelta, la estrategia pierde de media.',
        ),
      );
    }
    if (c.sigmaBanda * 2 < c.minAnchuraAtr) {
      issues.push(
        err(
          'minBandWidthAtr',
          'Con esas desviaciones la banda nunca llegará a la anchura mínima que pides.',
        ),
      );
    }
    // NO se avisa de la comisión, y el motivo merece quedar escrito porque es
    // contraintuitivo. El aviso estaba puesto por herencia del canal, y al
    // medir este motor salió lo CONTRARIO: sobre doce pares y ciento noventa
    // días, con costes de Hyperliquid da R medio +0,69 con t = 2,80, y sin
    // comisión da −0,11. La puerta del coste no solo evita la imposibilidad
    // aritmética: con comisiones altas se convierte en un filtro de calidad, y
    // con comisiones cero deja pasar cualquier cosa (spec 068).
    // El modo IA todavía no tiene proveedor cableado: la barrera de la API sigue
    // siendo del canal, así que una solicitud de este bot se cerraría sin
    // respuesta y el bot no operaría nunca, en silencio. Se rechaza en el
    // formulario hasta el spec 069: un mando que se puede poner y no hace nada
    // es peor que un mando que no está.
    if (c.modo === ModoDecision.IA) {
      issues.push(
        err(
          'decisionMode',
          'El modo IA todavía no está disponible para esta estrategia: falta conectar el ' +
            'proveedor. De momento decide el juez de reglas.',
        ),
      );
    }
    const stopFijo = Number(config.stopLossPct ?? 0);
    if (Number.isFinite(stopFijo) && stopFijo > 0) {
      issues.push(
        warn(
          'stopLossPct',
          'Esta estrategia pone el stop de cada operación con la banda y el ATR. El stop loss ' +
            'por porcentaje no se usa.',
        ),
      );
    }
    return toResult(issues);
  },

  preview(config: AiTraderConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const validation = this.validate(config, market);
    if (!validation.ok) return invalidPreview(validation.issues);
    const c = leer(config, market.venue);
    const precio = D(refPrice);
    if (!precio.gt(0)) return invalidPreview([err(null, 'Sin precio de referencia.')]);

    // Una operación de ejemplo con el stop más ancho que se admite y un ATR de
    // 1 h del 1 %: el peor caso de apalancamiento que la regla permitiría.
    const s = c.maxStopPct.div(100);
    const lev = apalancamientoPorStop({
      distanciaStop: s,
      atr1hRelativo: '0.01',
      liqBufferStops: c.colchonStops,
      mantenimiento: maintenanceMarginRateOf(market),
      topes: [25, c.apalancamientoTope, market.maxLeverage],
    });
    const riesgo = c.capital.mul(Decimal.min(c.riesgoPctOperacion, c.maxPerdidaDiaPct)).div(100);
    const costes = D(c.costes.takerBps).mul(2).plus(c.costes.deslizamientoBps).div(10_000);
    const techo = nocionalMaximoDe(c);
    const maxMargen = c.capital.mul(c.maxMargenPct).div(100);
    const palanca = Math.max(1, lev.maximo);
    let nocional = Decimal.min(riesgo.div(s.plus(costes)), techo, c.capital.mul(palanca));
    nocional = Decimal.min(nocional, maxMargen.mul(palanca));
    const qty = D(qy(market, nocional.div(precio)));
    const largo = config.direction !== 'SHORT';
    const levels: RawLevel[] = [
      {
        index: 0,
        kind: LevelKind.BASE,
        side: largo ? 'BUY' : 'SELL',
        price: precio,
        qty,
        margin: qty.mul(precio).div(palanca),
        isEntry: true,
      },
    ];
    const pct = (x: Decimal) => x.toFixed(2);
    return buildPreview({
      levels,
      market,
      refPrice,
      direction: largo ? 'LONG' : 'SHORT',
      leverage: palanca,
      marginMode: config.marginMode,
      issues: [
        ...validation.issues,
        warn(
          null,
          `Límites: ${pct(riesgo)} por operación (${c.riesgoPctOperacion.toFixed()} %), ` +
            `${pct(c.capital.mul(c.maxPerdidaDiaPct).div(100))} al día, nocional hasta ` +
            `${pct(techo)} y, en un hueco, como mucho ${pct(maxMargen)}.`,
        ),
        warn(
          null,
          c.soloObservar
            ? 'Arranca en «solo observar» y con el juez de reglas: no manda ninguna orden hasta ' +
                'que lo cambies tú.'
            : 'Cada operación calcula su apalancamiento con su stop: con uno más estrecho, más ' +
                'apalancamiento y la misma pérdida al stop.',
        ),
      ],
    });
  },

  plan(ctx: BotContext): DesiredState {
    const c = leer(ctx.config, ctx.venue);
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const op = leerOperacion(ctx.cycle.scratch['op']);
    const qtyPos = ctx.position ? D(ctx.position.qty) : D(0);
    if (!qtyPos.isZero()) return conPosicion(ctx, c, seq, op, qtyPos);
    return enPlano(ctx, c, seq);
  },
};
