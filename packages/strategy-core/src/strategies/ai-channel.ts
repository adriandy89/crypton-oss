/**
 * Canal con IA (`AI_CHANNEL`, specs 058-059): rebotes en el borde de un rango o
 * de un canal, con el apalancamiento que permite el stop de cada operación.
 *
 * El reparto de papeles es lo que la define:
 * - el motor determinista (`canal/`) detecta el rango, el setup y TODOS los
 *   números de cada operación posible;
 * - la IA —o el juez en modo `REGLAS`— solo elige entre esas opciones;
 * - este `plan()` vuelve a derivar la elección con los datos del tick, la
 *   revalida y la convierte en órdenes;
 * - las salidas son nativas (stop y objetivos) o deterministas (tiempo,
 *   invalidación, régimen): ninguna espera a la IA.
 *
 * La operación viva se guarda en `cycle.scratch.op` ANTES de mandar la entrada:
 * de ella salen el stop y los objetivos aunque falten las velas.
 */
import {
  D,
  Decimal,
  EstadoIntencion,
  EstadoSetup,
  EventoCanal,
  LevelKind,
  MotivoRechazo,
  Mutability,
  NivelConfianza,
  RegimenMercado,
  SentidoTendencia,
  StrategyKind,
  TipoCanal,
  Venue,
  Veredicto,
  agregarVelas,
  apalancamientoPorStop,
  eleccionEfectiva,
  maintenanceMarginRateOf,
  vistaCanalDe,
  type AvisoEstrategia,
  type BotConfig,
  type BotContext,
  type CommonBotConfig,
  type DesiredOrder,
  type DesiredState,
  type EleccionOperacion,
  type FieldMeta,
  type HistorialOperaciones,
  type MarcaDecision,
  type MarketSpec,
  type PlanOperacion,
  type PreviewResult,
  type SalidaHerramienta,
  type ValidationIssue,
  type ValidationResult,
  type VistaCanal,
} from '@crypton/shared';
import { analizarMercado, seriesNecesarias, type ResultadoAnalisis } from '../canal/analisis';
import { PASO_TASAS } from '../canal/tasas-base';
import { nivelesEn } from '../canal/canales';
import {
  DEFAULTS_CANAL,
  enVentanaSinEntradas,
  leerConfig,
  type ConfigCanal,
} from '../canal/config';
import {
  construirOperacion,
  esElegible,
  inicioDelCanal,
  llegaAlMinimo,
  perdidaHoyPct,
} from '../canal/herramienta';
import { juezDeReglas } from '../canal/juez';
import { makeCoid } from '../client-order-id';
import {
  buildPreview,
  comunCon,
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
import type { Strategy } from '../types';
import { fundingBps } from './mm-shared';

/**
 * La configuración del canal. Todos los campos propios son opcionales: los que
 * falten los pone `DEFAULTS_CANAL` al leerla (`leerConfig`). Se declaran uno a
 * uno para que la guía de la app tenga que documentarlos todos.
 */
export interface AiChannelConfig extends CommonBotConfig {
  structureInterval?: '15m' | '5m';
  decisionMode?: 'IA' | 'REGLAS';
  aiProfile?: 'PRUDENTE' | 'EQUILIBRADA' | 'AGRESIVA';
  entriesEnabled?: boolean;
  observeOnly?: boolean;
  riskPerTradePct?: string | number;
  maxMarginPct?: string | number;
  maxNotionalMultiple?: string | number;
  liqBufferStops?: number;
  maxStopPct?: string | number;
  maxCostPerTradeR?: string | number;
  minTargetCostMultiple?: string | number;
  minRewardRisk?: string | number;
  maxEntrySlippageR?: string | number;
  maxSpreadFraction?: string | number;
  makerFeeBps?: string | number | null;
  takerFeeBps?: string | number | null;
  slippageBps?: string | number | null;
  maxTradesPerDay?: number;
  maxConsecutiveLosses?: number;
  lossStreakCooldownMinutes?: number;
  stopCooldownMinutes?: number;
  dailyProfitTargetPct?: string | number;
  maxDrawdownPct?: string | number;
  aiDailyCallBudget?: number;
  takeProfitSchemes?: 'TODOS' | 'MEDIA' | 'ESCALONADO' | 'OPUESTO';
  tp1Fraction?: string | number;
  breakevenAfterTp1?: boolean;
  maxHoldBars?: number;
  invalidationAtr?: string | number;
  allowedSetups?: 'REBOTE' | 'FALSO_QUIEBRE' | 'TODOS';
  allowedChannels?: 'TODOS' | 'HORIZONTAL' | 'INCLINADO' | 'BANDA';
  slopedWithTrendOnly?: boolean;
  channelWindowBars?: number;
  minChannelQuality?: 'A' | 'B' | 'C';
  minConfirmations?: number;
  requireEvidence?: 'NO' | 'DEBIL' | 'MODERADA';
  minAiConfidence?: 'MEDIA' | 'ALTA';
  maxAdverseFundingBps?: string | number;
  fundingBlackoutMinutes?: number;
  /** `HH:MM-HH:MM` en UTC, separadas por comas; hasta seis. */
  noEntryWindowsUtc?: string | null;
}

/** La configuración tal y como la lee el motor del canal. */
const leer = (config: AiChannelConfig, venue: Venue): ConfigCanal =>
  // La interfaz no lleva firma de índice: `BotConfig` sí. Es la misma config.
  leerConfig(config as unknown as BotConfig, venue);

const QUINCE_MIN = 900_000;
const CINCO_MIN = 300_000;
/** Lo que se espera a que una entrada IOC aparezca como posición. */
export const ESPERA_LLENADO_MS = 30_000;
/** Pasado esto sin posición ni ejecución, la entrada se da por perdida. */
const ESPERA_MAXIMA_LLENADO_MS = 5 * 60_000;
/** Cierres a mercado: un intento cada 30 s, doce como mucho (`TAKE_PROFIT#500..511`). */
export const INDICE_CIERRE = 500;
export const MAX_INTENTOS_CIERRE = 12;
const ESPERA_ENTRE_CIERRES_MS = 30_000;
/** El stop no saltó: el precio lo ha pasado en más de esta fracción del stop. */
const STOP_NO_SALTO = 0.5;
/** La liquidación del venue tiene que quedar al menos a medio stop detrás del stop. */
const HOLGURA_LIQUIDACION = 0.5;
/** Un canal inclinado admite tendencia a favor mientras el ADX no pase de aquí. */
const ADX_INCLINADO = 40;
/** Al 1,5× del tope diario, pausa con reanudación manual. */
const FACTOR_PAUSA_DIARIA = D('1.5');

// ── Descriptores ────────────────────────────────────────────────────────────

const d = DEFAULTS_CANAL;
const campo = (f: Omit<FieldMeta, 'mutability' | 'required'> & Partial<FieldMeta>): FieldMeta => ({
  mutability: Mutability.HOT,
  required: false,
  ...f,
});

const COMUNES: FieldMeta[] = [
  // La dirección solo decide las entradas nuevas: se puede cambiar en marcha.
  comunCon('direction', {
    mutability: Mutability.HOT,
    labelKey: 'strategy.aiChannel.direction',
    helpKey: 'strategy.aiChannel.directionHelp',
    options: ['NEUTRAL', 'LONG', 'SHORT'],
    default: d.direction,
  }),
  comunCon('totalInvestment', { min: 50 }),
  // Solo aislado: la pérdida en un hueco se acota con el margen de la operación.
  comunCon('marginMode', { options: ['ISOLATED'], default: d.marginMode, control: 'select' }),
  comunCon('leverage', {
    mutability: Mutability.HOT,
    labelKey: 'strategy.aiChannel.leverage',
    helpKey: 'strategy.aiChannel.leverageHelp',
    max: 25,
    default: d.leverage,
    group: 'risk',
  }),
  comunCon('maxDailyLossPct', {
    labelKey: 'strategy.aiChannel.maxDailyLossPct',
    helpKey: 'strategy.aiChannel.maxDailyLossPctHelp',
    min: 0.5,
    max: 6,
    default: Number(d.maxDailyLossPct),
    risky: true,
  }),
  comunCon('liquidationAction', { default: d.liquidationAction }),
  comunCon('cooldownMinutes', {
    labelKey: 'strategy.aiChannel.cooldownMinutes',
    helpKey: 'strategy.aiChannel.cooldownMinutesHelp',
    max: 1440,
    default: d.cooldownMinutes,
  }),
];

const PROPIOS: FieldMeta[] = [
  // Base
  campo({
    key: 'structureInterval',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'strategy.aiChannel.structureInterval',
    helpKey: 'strategy.aiChannel.structureIntervalHelp',
    options: ['15m', '5m'],
    default: d.structureInterval,
    group: 'core',
    control: 'segment',
  }),
  campo({
    key: 'decisionMode',
    kind: 'enum',
    labelKey: 'strategy.aiChannel.decisionMode',
    helpKey: 'strategy.aiChannel.decisionModeHelp',
    options: ['IA', 'REGLAS'],
    default: d.decisionMode,
    group: 'core',
    control: 'segment',
  }),
  campo({
    key: 'aiProfile',
    kind: 'enum',
    labelKey: 'strategy.aiChannel.aiProfile',
    helpKey: 'strategy.aiChannel.aiProfileHelp',
    options: ['PRUDENTE', 'EQUILIBRADA', 'AGRESIVA'],
    default: d.aiProfile,
    group: 'core',
    control: 'segment',
  }),
  campo({
    key: 'entriesEnabled',
    kind: 'boolean',
    labelKey: 'strategy.aiChannel.entriesEnabled',
    helpKey: 'strategy.aiChannel.entriesEnabledHelp',
    default: d.entriesEnabled,
    group: 'core',
    control: 'toggle',
  }),
  campo({
    key: 'observeOnly',
    kind: 'boolean',
    labelKey: 'strategy.aiChannel.observeOnly',
    helpKey: 'strategy.aiChannel.observeOnlyHelp',
    default: d.observeOnly,
    group: 'core',
    control: 'toggle',
  }),
  // Riesgo por operación
  campo({
    key: 'riskPerTradePct',
    kind: 'percent',
    labelKey: 'strategy.aiChannel.riskPerTradePct',
    helpKey: 'strategy.aiChannel.riskPerTradePctHelp',
    min: 0.1,
    max: 2,
    step: 0.1,
    required: true,
    default: Number(d.riskPerTradePct),
    group: 'risk',
    unit: '%',
    risky: true,
  }),
  campo({
    key: 'maxMarginPct',
    kind: 'percent',
    labelKey: 'strategy.aiChannel.maxMarginPct',
    helpKey: 'strategy.aiChannel.maxMarginPctHelp',
    min: 5,
    max: 100,
    step: 1,
    default: Number(d.maxMarginPct),
    group: 'risk',
    unit: '%',
    risky: true,
  }),
  campo({
    key: 'maxNotionalMultiple',
    kind: 'number',
    labelKey: 'strategy.aiChannel.maxNotionalMultiple',
    helpKey: 'strategy.aiChannel.maxNotionalMultipleHelp',
    min: 1,
    max: 25,
    step: 0.5,
    default: Number(d.maxNotionalMultiple),
    group: 'risk',
    unit: 'x',
  }),
  campo({
    key: 'liqBufferStops',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.liqBufferStops',
    helpKey: 'strategy.aiChannel.liqBufferStopsHelp',
    min: 3,
    max: 10,
    step: 1,
    default: d.liqBufferStops,
    group: 'risk',
    advanced: true,
  }),
  campo({
    key: 'maxStopPct',
    kind: 'percent',
    labelKey: 'strategy.aiChannel.maxStopPct',
    helpKey: 'strategy.aiChannel.maxStopPctHelp',
    min: 0.1,
    max: 5,
    step: 0.1,
    default: Number(d.maxStopPct),
    group: 'risk',
    unit: '%',
  }),
  campo({
    key: 'maxCostPerTradeR',
    kind: 'number',
    labelKey: 'strategy.aiChannel.maxCostPerTradeR',
    helpKey: 'strategy.aiChannel.maxCostPerTradeRHelp',
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
    labelKey: 'strategy.aiChannel.minTargetCostMultiple',
    helpKey: 'strategy.aiChannel.minTargetCostMultipleHelp',
    min: 3,
    max: 60,
    step: 1,
    default: d.minTargetCostMultiple,
    group: 'risk',
    risky: true,
  }),
  campo({
    key: 'minRewardRisk',
    kind: 'number',
    labelKey: 'strategy.aiChannel.minRewardRisk',
    helpKey: 'strategy.aiChannel.minRewardRiskHelp',
    min: 0.5,
    max: 5,
    step: 0.1,
    default: Number(d.minRewardRisk),
    group: 'risk',
    unit: 'R',
  }),
  campo({
    key: 'maxEntrySlippageR',
    kind: 'number',
    labelKey: 'strategy.aiChannel.maxEntrySlippageR',
    helpKey: 'strategy.aiChannel.maxEntrySlippageRHelp',
    min: 0.05,
    max: 0.5,
    step: 0.05,
    default: Number(d.maxEntrySlippageR),
    group: 'risk',
    unit: 'R',
    advanced: true,
  }),
  campo({
    key: 'maxSpreadFraction',
    kind: 'number',
    labelKey: 'strategy.aiChannel.maxSpreadFraction',
    helpKey: 'strategy.aiChannel.maxSpreadFractionHelp',
    min: 0.02,
    max: 0.5,
    step: 0.01,
    default: Number(d.maxSpreadFraction),
    group: 'risk',
    advanced: true,
  }),
  campo({
    key: 'makerFeeBps',
    kind: 'number',
    labelKey: 'strategy.aiChannel.makerFeeBps',
    helpKey: 'strategy.aiChannel.feeBpsHelp',
    min: 0,
    max: 20,
    step: 0.1,
    group: 'venue',
    unit: 'bps',
    advanced: true,
  }),
  campo({
    key: 'takerFeeBps',
    kind: 'number',
    labelKey: 'strategy.aiChannel.takerFeeBps',
    helpKey: 'strategy.aiChannel.feeBpsHelp',
    min: 0,
    max: 20,
    step: 0.1,
    group: 'venue',
    unit: 'bps',
    advanced: true,
  }),
  campo({
    key: 'slippageBps',
    kind: 'number',
    labelKey: 'strategy.aiChannel.slippageBps',
    helpKey: 'strategy.aiChannel.slippageBpsHelp',
    min: 0,
    max: 20,
    step: 0.1,
    group: 'venue',
    unit: 'bps',
    advanced: true,
  }),
  // Límites del día y de racha (UTC)
  campo({
    key: 'maxTradesPerDay',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.maxTradesPerDay',
    helpKey: 'strategy.aiChannel.maxTradesPerDayHelp',
    min: 1,
    max: 48,
    step: 1,
    default: d.maxTradesPerDay,
    group: 'timing',
  }),
  campo({
    key: 'maxConsecutiveLosses',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.maxConsecutiveLosses',
    helpKey: 'strategy.aiChannel.maxConsecutiveLossesHelp',
    min: 1,
    max: 10,
    step: 1,
    default: d.maxConsecutiveLosses,
    group: 'timing',
  }),
  campo({
    key: 'lossStreakCooldownMinutes',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.lossStreakCooldownMinutes',
    helpKey: 'strategy.aiChannel.lossStreakCooldownMinutesHelp',
    min: 0,
    max: 1440,
    step: 1,
    default: d.lossStreakCooldownMinutes,
    group: 'timing',
    unit: 'min',
  }),
  campo({
    key: 'stopCooldownMinutes',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.stopCooldownMinutes',
    helpKey: 'strategy.aiChannel.stopCooldownMinutesHelp',
    min: 0,
    max: 720,
    step: 1,
    default: d.stopCooldownMinutes,
    group: 'timing',
    unit: 'min',
  }),
  campo({
    key: 'dailyProfitTargetPct',
    kind: 'percent',
    labelKey: 'strategy.aiChannel.dailyProfitTargetPct',
    helpKey: 'strategy.aiChannel.dailyProfitTargetPctHelp',
    min: 0,
    max: 50,
    step: 0.5,
    default: Number(d.dailyProfitTargetPct),
    group: 'risk',
    unit: '%',
  }),
  campo({
    key: 'maxDrawdownPct',
    kind: 'percent',
    labelKey: 'strategy.aiChannel.maxDrawdownPct',
    helpKey: 'strategy.aiChannel.maxDrawdownPctHelp',
    min: 2,
    max: 50,
    step: 1,
    default: Number(d.maxDrawdownPct),
    group: 'risk',
    unit: '%',
    risky: true,
  }),
  campo({
    key: 'aiDailyCallBudget',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.aiDailyCallBudget',
    helpKey: 'strategy.aiChannel.aiDailyCallBudgetHelp',
    min: 1,
    max: 200,
    step: 1,
    default: d.aiDailyCallBudget,
    group: 'timing',
    advanced: true,
  }),
  // Salidas
  campo({
    key: 'takeProfitSchemes',
    kind: 'enum',
    labelKey: 'strategy.aiChannel.takeProfitSchemes',
    helpKey: 'strategy.aiChannel.takeProfitSchemesHelp',
    options: ['TODOS', 'MEDIA', 'ESCALONADO', 'OPUESTO'],
    default: d.takeProfitSchemes,
    group: 'levels',
  }),
  campo({
    key: 'tp1Fraction',
    kind: 'percent',
    labelKey: 'strategy.aiChannel.tp1Fraction',
    helpKey: 'strategy.aiChannel.tp1FractionHelp',
    min: 50,
    max: 70,
    step: 5,
    default: Number(d.tp1Fraction),
    group: 'levels',
    unit: '%',
  }),
  campo({
    key: 'breakevenAfterTp1',
    kind: 'boolean',
    labelKey: 'strategy.aiChannel.breakevenAfterTp1',
    helpKey: 'strategy.aiChannel.breakevenAfterTp1Help',
    default: d.breakevenAfterTp1,
    group: 'levels',
    control: 'toggle',
  }),
  campo({
    key: 'maxHoldBars',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.maxHoldBars',
    helpKey: 'strategy.aiChannel.maxHoldBarsHelp',
    min: 4,
    max: 48,
    step: 1,
    default: d.maxHoldBars,
    group: 'levels',
  }),
  campo({
    key: 'invalidationAtr',
    kind: 'number',
    labelKey: 'strategy.aiChannel.invalidationAtr',
    helpKey: 'strategy.aiChannel.invalidationAtrHelp',
    min: 0.25,
    max: 0.5,
    step: 0.05,
    default: Number(d.invalidationAtr),
    group: 'levels',
    unit: 'ATR',
    advanced: true,
  }),
  // Mercado
  campo({
    key: 'allowedSetups',
    kind: 'enum',
    labelKey: 'strategy.aiChannel.allowedSetups',
    helpKey: 'strategy.aiChannel.allowedSetupsHelp',
    options: ['REBOTE', 'FALSO_QUIEBRE', 'TODOS'],
    default: d.allowedSetups,
    group: 'intelligence',
    control: 'segment',
  }),
  campo({
    key: 'allowedChannels',
    kind: 'enum',
    labelKey: 'strategy.aiChannel.allowedChannels',
    helpKey: 'strategy.aiChannel.allowedChannelsHelp',
    options: ['TODOS', 'HORIZONTAL', 'INCLINADO', 'BANDA'],
    default: d.allowedChannels,
    group: 'intelligence',
    // Desplegable y no fila de botones: con `BANDA` (spec 067) son cuatro
    // opciones, y cuatro no caben en una fila en un móvil.
    control: 'select',
  }),
  campo({
    key: 'slopedWithTrendOnly',
    kind: 'boolean',
    labelKey: 'strategy.aiChannel.slopedWithTrendOnly',
    helpKey: 'strategy.aiChannel.slopedWithTrendOnlyHelp',
    default: d.slopedWithTrendOnly,
    group: 'intelligence',
    control: 'toggle',
  }),
  campo({
    key: 'channelWindowBars',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.channelWindowBars',
    helpKey: 'strategy.aiChannel.channelWindowBarsHelp',
    min: 48,
    max: 200,
    step: 1,
    default: d.channelWindowBars,
    group: 'intelligence',
    advanced: true,
  }),
  campo({
    key: 'minChannelQuality',
    kind: 'enum',
    labelKey: 'strategy.aiChannel.minChannelQuality',
    helpKey: 'strategy.aiChannel.minChannelQualityHelp',
    options: ['A', 'B', 'C'],
    default: d.minChannelQuality,
    group: 'intelligence',
    control: 'segment',
  }),
  campo({
    key: 'minConfirmations',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.minConfirmations',
    helpKey: 'strategy.aiChannel.minConfirmationsHelp',
    min: 1,
    max: 4,
    step: 1,
    default: d.minConfirmations,
    group: 'intelligence',
  }),
  campo({
    key: 'requireEvidence',
    kind: 'enum',
    labelKey: 'strategy.aiChannel.requireEvidence',
    helpKey: 'strategy.aiChannel.requireEvidenceHelp',
    options: ['NO', 'DEBIL', 'MODERADA'],
    default: d.requireEvidence,
    group: 'intelligence',
    control: 'segment',
  }),
  campo({
    key: 'minAiConfidence',
    kind: 'enum',
    labelKey: 'strategy.aiChannel.minAiConfidence',
    helpKey: 'strategy.aiChannel.minAiConfidenceHelp',
    options: ['MEDIA', 'ALTA'],
    default: d.minAiConfidence,
    group: 'intelligence',
    control: 'segment',
  }),
  // Horario
  campo({
    key: 'maxAdverseFundingBps',
    kind: 'number',
    labelKey: 'strategy.aiChannel.maxAdverseFundingBps',
    helpKey: 'strategy.aiChannel.maxAdverseFundingBpsHelp',
    min: 0,
    max: 100,
    step: 0.5,
    default: Number(d.maxAdverseFundingBps),
    group: 'timing',
    unit: 'bps',
    advanced: true,
  }),
  campo({
    key: 'fundingBlackoutMinutes',
    kind: 'integer',
    labelKey: 'strategy.aiChannel.fundingBlackoutMinutes',
    helpKey: 'strategy.aiChannel.fundingBlackoutMinutesHelp',
    min: 0,
    max: 60,
    step: 1,
    default: d.fundingBlackoutMinutes,
    group: 'timing',
    unit: 'min',
    advanced: true,
  }),
  campo({
    key: 'noEntryWindowsUtc',
    kind: 'text',
    labelKey: 'strategy.aiChannel.noEntryWindowsUtc',
    helpKey: 'strategy.aiChannel.noEntryWindowsUtcHelp',
    group: 'timing',
    advanced: true,
  }),
];

const META = {
  kind: StrategyKind.AI_CHANNEL,
  labelKey: 'strategy.aiChannel.label',
  descriptionKey: 'strategy.aiChannel.description',
  fields: [...commonFieldsWith(COMUNES), ...PROPIOS],
};

/**
 * Ventanas de muestreo que se quieren para las tasas base.
 *
 * `etiquetasHistoricas` recorre el histórico de estructura con `PASO_TASAS`, y
 * como mucho sale una etiqueta por ventana y por par (setup, lado): el no
 * solapamiento de `libreDesde` lo impide. La evidencia MODERADA empieza en 61
 * muestras (`evidenciaDe`), que es la única que dispara la puerta automática
 * «esperanza negativa» de la herramienta.
 *
 * Se piden 70 y no 61 porque 70 es el TECHO teórico: en la práctica alguna
 * ventana no da toque. Medido sobre `escenarioCanal`, 640 velas —68 ventanas
 * teóricas— dieron 67 muestras (spec 065).
 */
const VENTANAS_TASAS = 70;

/**
 * Velas por serie: la estructura y el disparo, topadas por el venue en el motor.
 *
 * La estructura pedía mil velas, que en Hyperliquid pesan 37 contra un depósito
 * que valía 34: exigía el depósito lleno y lo dejaba en deuda. Lo que de verdad
 * ata el número no es el canal —`detectarCanal` solo mira `ventanaCanal`, 200
 * como mucho— sino el tamaño de muestra de las tasas base, así que la ventana
 * se DERIVA de ahí en vez de ser un número plano. Con la ventana por defecto
 * son 656 velas, peso 31; con la ventana en su máximo, 760, peso 33.
 *
 * El 5 min y el 1 h se quedan como estaban, y no por prudencia:
 *
 * - el RSI(14) de Wilder es recursivo y necesita ~110 velas para converger, y
 *   bajar de 144 a 120 ni siquiera cambia el peso (`20 + ceil(barras/60)` da 23
 *   en los dos casos);
 * - los percentiles del régimen se calculan sobre TODA la serie de 1 h, así que
 *   su longitud no es margen: es la ventana de referencia. Medido, a 336 velas
 *   el escenario de prueba pasa de RANGO a INDEFINIDO.
 */
function seriesDe(cfg: ConfigCanal): { interval: '5m' | '15m' | '1h'; bars: number }[] {
  const estructura = cfg.ventanaCanal + PASO_TASAS * VENTANAS_TASAS;
  const barras = {
    '5m': cfg.intervaloEstructura === '5m' ? estructura : 144,
    '15m': estructura,
    '1h': 480,
  };
  return seriesNecesarias(cfg.intervaloEstructura).map((iv) => ({
    interval: iv as '5m' | '15m' | '1h',
    bars: barras[iv as '5m' | '15m' | '1h'],
  }));
}

/** El mayor nocional que esta configuración puede abrir. */
export function nocionalMaximoDe(cfg: ConfigCanal): Decimal {
  const topes = [
    cfg.capital.mul(cfg.multiploNocional),
    cfg.capital.mul(Math.min(cfg.apalancamientoTope, 25)),
  ];
  if (cfg.topeNocional) topes.push(cfg.topeNocional);
  return Decimal.max(0, Decimal.min(...topes));
}

// ── El scratch del ciclo ────────────────────────────────────────────────────

/** La operación viva, tal y como se guarda en `cycle.scratch.op`. */
export interface OperacionGuardada {
  plan: PlanOperacion;
  /** `n` de `BASE#n`. */
  intento: number;
  enviadaEn: number;
  /** La mayor posición vista: de ella salen los tramos de salida. */
  maximo?: string;
  tp1Hecho?: boolean;
  /** El stop en breakeven, una vez puesto: nunca vuelve atrás. */
  stopBreakeven?: string;
}

export interface CierreEnCurso {
  motivo: string;
  intentos: number;
  ultimoEn: number;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function leerOperacion(v: unknown): OperacionGuardada | null {
  if (!esObjeto(v) || !esObjeto(v['plan'])) return null;
  const plan = v['plan'] as unknown as PlanOperacion;
  if (typeof plan.stop !== 'string' || !Array.isArray(plan.objetivos)) return null;
  return v as unknown as OperacionGuardada;
}

function leerCierre(v: unknown): CierreEnCurso | null {
  if (!esObjeto(v) || typeof v['motivo'] !== 'string') return null;
  return {
    motivo: v['motivo'],
    intentos: Number(v['intentos'] ?? 0),
    ultimoEn: Number(v['ultimoEn'] ?? 0),
  };
}

// ── Con posición ────────────────────────────────────────────────────────────

/**
 * Lo más lejos que puede quedar el stop de emergencia de una posición huérfana:
 * dos tercios del camino de la entrada a la liquidación del venue, que es donde
 * la guarda del motor cierra de todas formas (spec 062, F-24).
 */
const RECORRIDO_STOP_HUERFANA = D(2).div(3);

/** Los tramos de salida de la operación para la posición que llegó a haber. */
export function tramosDeSalida(
  market: MarketSpec,
  op: OperacionGuardada,
  maximo: Decimal,
): { precio: string; cantidad: Decimal }[] {
  const [tp1, tp2] = op.plan.objetivos;
  const todo = [{ precio: tp1.precio, cantidad: maximo }];
  if (!tp2 || !D(op.plan.cantidad).gt(0)) return todo;
  // La misma proporción que el plan, sobre lo que de verdad se llenó.
  // Multiplicando antes de dividir: 31,257 × (18,754 / 31,257) no da 18,754
  // exacto, y el redondeo a la baja se comería un paso.
  const primera = D(qy(market, maximo.mul(tp1.cantidad).div(op.plan.cantidad)));
  const segunda = maximo.minus(primera);
  if (
    !llegaAlMinimo(market, primera, D(tp1.precio)) ||
    !llegaAlMinimo(market, segunda, D(tp2.precio))
  ) {
    return todo;
  }
  return [
    { precio: tp1.precio, cantidad: primera },
    { precio: tp2.precio, cantidad: segunda },
  ];
}

interface Salida {
  motivo: string;
  mensaje: string;
}

/** Las velas de 15 min del contexto; con estructura de 5, construidas con ellas. */
function velasDe15(ctx: BotContext): readonly { t: number; c: string }[] | undefined {
  const propias = ctx.series?.['15m'];
  if (propias && propias.length > 0) return propias;
  const cinco = ctx.series?.['5m'];
  if (!cinco || cinco.length === 0) return undefined;
  return agregarVelas(cinco, '5m', '15m', cinco[cinco.length - 1].t + CINCO_MIN) ?? undefined;
}

/** ¿Hay que cerrar ya? La primera razón que se cumple. */
function motivoDeSalida(
  ctx: BotContext,
  c: ConfigCanal,
  op: OperacionGuardada,
  largo: boolean,
  stop: Decimal,
  analisis: ResultadoAnalisis | null,
): Salida | null {
  const marca = D(ctx.ticker.mark);
  if (ctx.now >= op.plan.venceEn) {
    return { motivo: 'TIEMPO', mensaje: `pasaron ${c.maxVelasOperacion} velas de 15 min` };
  }
  const s = D(op.plan.distanciaStop).mul(STOP_NO_SALTO);
  if (largo ? marca.lt(stop.mul(D(1).minus(s))) : marca.gt(stop.mul(D(1).plus(s)))) {
    return {
      motivo: 'STOP_NO_SALTO',
      mensaje: `el precio pasó el stop ${stop.toFixed()} y no saltó`,
    };
  }
  const pos = ctx.position;
  if (pos?.liquidationPrice && D(pos.liquidationPrice).gt(0)) {
    const liq = D(pos.liquidationPrice);
    const holgura = D(pos.entryPrice).mul(op.plan.distanciaStop).mul(HOLGURA_LIQUIDACION);
    const tope = largo ? stop.minus(holgura) : stop.plus(holgura);
    if (largo ? liq.gt(tope) : liq.lt(tope)) {
      return {
        motivo: 'LIQUIDACION',
        mensaje: `el venue pone la liquidación en ${liq.toFixed()}, demasiado cerca del stop`,
      };
    }
  }
  if (pos && Number.isFinite(pos.leverage) && pos.leverage > op.plan.apalancamiento + 0.5) {
    return {
      motivo: 'APALANCAMIENTO',
      mensaje: `el venue informa ${pos.leverage}x y la operación pidió ${op.plan.apalancamiento}x`,
    };
  }
  if (!analisis) return null;
  const velas15 = velasDe15(ctx);
  const atr = Number(analisis.salida.mercado.atr15m);
  const ultima = velas15?.[velas15.length - 1];
  // La invalidación mira el último cierre de 15 min POSTERIOR a la entrada.
  if (ultima && ultima.t + QUINCE_MIN > op.enviadaEn && atr > 0) {
    const { soporte, resistencia } = nivelesEn(op.plan.canal, ultima.t);
    const cierre = Number(ultima.c);
    const fuera = largo ? soporte - cierre : cierre - resistencia;
    if (fuera > c.invalidacionAtr * atr) {
      return {
        motivo: 'INVALIDACION',
        mensaje: `la vela de 15 min cerró ${(fuera / atr).toFixed(2)} ATR fuera del canal`,
      };
    }
  }
  const r = analisis.regimen;
  const contra = largo ? SentidoTendencia.BAJISTA : SentidoTendencia.ALCISTA;
  if (r.regimen === RegimenMercado.TENDENCIA && r.sentido === contra) {
    return { motivo: 'REGIMEN', mensaje: 'el mercado ha pasado a tendencia en contra' };
  }
  return null;
}

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

/** Una posición sin operación guardada: stop de emergencia y aviso. */
function posicionHuerfana(
  ctx: BotContext,
  c: ConfigCanal,
  seq: number,
  qtyPos: Decimal,
): DesiredState {
  const largo = qtyPos.gt(0);
  const lado = largo ? 'SELL' : 'BUY';
  const entrada = D(ctx.position?.entryPrice ?? 0).gt(0)
    ? D(ctx.position?.entryPrice ?? 0)
    : D(ctx.ticker.mark);
  const s = c.maxStopPct.div(100);
  let nivel = largo ? entrada.mul(D(1).minus(s)) : entrada.mul(D(1).plus(s));
  // Acotado por la liquidación que declara el venue: a 25x, un 3 o un 5 % de la
  // entrada cae DETRÁS de la liquidación, así que el «stop de emergencia» no
  // protegía de nada —la posición se liquidaba antes de tocarlo—. Como mucho,
  // dos tercios del camino, que es donde la guarda del motor cierra de todas
  // formas (spec 062, F-24).
  const liquidacion = D(ctx.position?.liquidationPrice ?? 0);
  if (liquidacion.gt(0)) {
    const camino = entrada.minus(liquidacion).abs().mul(RECORRIDO_STOP_HUERFANA);
    const tope = largo ? entrada.minus(camino) : entrada.plus(camino);
    nivel = largo ? Decimal.max(nivel, tope) : Decimal.min(nivel, tope);
  }
  const stop = px(ctx.market, nivel, lado);
  // El porcentaje del aviso es el de VERDAD, no el configurado: acotado por la
  // liquidación, ya no son el mismo número.
  const distancia = entrada.minus(stop).abs().div(entrada).mul(100).toFixed(2);
  const marca = D(ctx.ticker.mark);
  const pasado = largo ? marca.lte(stop) : marca.gte(stop);
  const avisos: AvisoEstrategia[] = [
    {
      clave: `huerfana:${seq}`,
      tipo: EventoCanal.POSICION_HUERFANA,
      severidad: 'CRITICAL',
      mensaje:
        `Posición ${largo ? 'larga' : 'corta'} sin operación registrada: stop de emergencia en ` +
        `${stop}, al ${distancia} % de la entrada.`,
    },
  ];
  const previo = leerCierre(ctx.cycle.scratch['cierre']);
  if (!pasado && !previo) {
    return {
      orders: [ordenStop(ctx, seq, lado, stop, qtyPos.abs())],
      immediate: [],
      note: `Posición sin operación registrada. Stop de emergencia en ${stop}.`,
      avisos,
    };
  }
  // El precio ya está más allá del stop de emergencia: fuera a mercado.
  const r = cierreAMercado(ctx, seq, lado, qtyPos.abs(), previo, 'HUERFANA');
  return {
    orders: [ordenStop(ctx, seq, lado, stop, qtyPos.abs())],
    immediate: r.immediate,
    note: `Posición sin operación registrada y más allá del stop de emergencia: se cierra a mercado.`,
    scratchPatch: { cierre: r.cierre },
    avisos,
  };
}

function conPosicion(
  ctx: BotContext,
  c: ConfigCanal,
  seq: number,
  op: OperacionGuardada | null,
  qtyPos: Decimal,
  analisis: ResultadoAnalisis | null,
): DesiredState {
  const largo = qtyPos.gt(0);
  if (!op || op.plan.lado !== (largo ? 'LONG' : 'SHORT')) {
    return posicionHuerfana(ctx, c, seq, qtyPos);
  }
  const lado = largo ? 'SELL' : 'BUY';
  const abs = qtyPos.abs();
  const patch: Record<string, unknown> = {};
  const avisos: AvisoEstrategia[] = [];
  let nueva: OperacionGuardada = op;
  const cambiar = (cambios: Partial<OperacionGuardada>) => {
    nueva = { ...nueva, ...cambios };
    patch['op'] = nueva;
  };

  const maximo = Decimal.max(D(op.maximo ?? '0'), abs);
  if (!maximo.eq(op.maximo ?? '0')) cambiar({ maximo: maximo.toFixed() });
  const tramos = tramosDeSalida(ctx.market, op, maximo);
  const mediaVuelta = D(ctx.market.stepSize).div(2);
  const tp1Hecho =
    op.tp1Hecho === true ||
    (tramos.length === 2 && abs.lte(maximo.minus(tramos[0].cantidad).plus(mediaVuelta)));
  if (tp1Hecho && op.tp1Hecho !== true) cambiar({ tp1Hecho: true });

  // El stop: el de la operación o, tras el primer objetivo, el de breakeven.
  let stop = D(op.stopBreakeven ?? op.plan.stop);
  if (tp1Hecho && c.breakeven && !op.stopBreakeven) {
    const entrada = D(ctx.position?.entryPrice ?? op.plan.entradaTope);
    // La entrada más lo que cuesta salir: comisión de entrada y salida a mercado.
    const costes = D(c.costes.takerBps).mul(2).plus(c.costes.deslizamientoBps).div(10_000);
    const bruto = largo ? entrada.mul(D(1).plus(costes)) : entrada.mul(D(1).minus(costes));
    const be = D(px(ctx.market, bruto, lado));
    const marca = D(ctx.ticker.mark);
    const mejora = largo ? be.gt(stop) : be.lt(stop);
    // Un stop del otro lado de la marca saltaría al colocarlo: se espera.
    const cabe = largo ? be.lt(marca) : be.gt(marca);
    if (mejora && cabe) {
      stop = be;
      cambiar({ stopBreakeven: be.toFixed() });
      avisos.push({
        clave: `breakeven:${op.plan.intentId}`,
        tipo: EventoCanal.BREAKEVEN,
        severidad: 'INFO',
        mensaje: `Primer objetivo cobrado: el stop pasa a ${be.toFixed()}, la entrada más costes.`,
      });
    }
  }
  const precioStop = px(ctx.market, stop, lado);
  const orders: DesiredOrder[] = [ordenStop(ctx, seq, lado, precioStop, abs)];

  const cierrePrevio = leerCierre(ctx.cycle.scratch['cierre']);
  const salida = cierrePrevio
    ? { motivo: cierrePrevio.motivo, mensaje: '' }
    : motivoDeSalida(ctx, c, op, largo, stop, analisis);
  if (salida) {
    const r = cierreAMercado(ctx, seq, lado, abs, cierrePrevio, salida.motivo);
    patch['cierre'] = r.cierre;
    if (!cierrePrevio) {
      // En INFO: es la orden de salir. El aviso con el resultado es `AI_EXIT`,
      // que emite el motor al cerrarse el ciclo (spec 059).
      avisos.push({
        clave: `salida:${op.plan.intentId}`,
        tipo: EventoCanal.CIERRE,
        severidad: 'INFO',
        mensaje: `Cierre a mercado (${salida.motivo}): ${salida.mensaje}.`,
      });
    }
    if (r.agotado) {
      avisos.push({
        clave: `cierre-agotado:${op.plan.intentId}`,
        tipo: EventoCanal.CIERRE_FALLIDO,
        severidad: 'CRITICAL',
        mensaje:
          `El cierre a mercado falló ${MAX_INTENTOS_CIERRE} veces. La posición sigue con su stop ` +
          `en ${precioStop}.`,
      });
    }
    return {
      orders,
      immediate: r.immediate,
      note: `Cerrando a mercado (${salida.motivo}). Stop en ${precioStop} mientras tanto.`,
      scratchPatch: patch,
      avisos: avisos.length > 0 ? avisos : undefined,
    };
  }

  // Los objetivos, repartidos DE ABAJO ARRIBA: el último tramo se queda con lo
  // suyo y el primero con el resto.
  //
  // Al revés —que es como estaba— lo que faltaba se le quitaba siempre al
  // segundo objetivo: con el primero ejecutado a medias, el primero se quedaba
  // con TODA la posición que quedaba y el segundo se cancelaba, así que la
  // operación cobraba entera en el objetivo corto y el recorrido bueno se
  // regalaba. La ejecución parcial es del tramo que se estaba cobrando, no del
  // que no ha tocado nadie (spec 062, F-22).
  const pendientes = tp1Hecho ? tramos.slice(1) : tramos;
  const reparto = pendientes.map((t) => ({ t, cantidad: D(0) }));
  let restante = abs;
  for (let i = reparto.length - 1; i >= 0; i--) {
    const cantidad = i === 0 ? restante : Decimal.min(reparto[i].t.cantidad, restante);
    reparto[i].cantidad = cantidad;
    restante = restante.minus(cantidad);
  }
  // Un resto que no llega al mínimo del venue no se puede colocar solo: se suma
  // al tramo de al lado, o esa parte de la posición se quedaría sin objetivo.
  if (
    reparto.length === 2 &&
    reparto[0].cantidad.gt(0) &&
    !llegaAlMinimo(ctx.market, reparto[0].cantidad, D(reparto[0].t.precio))
  ) {
    reparto[1].cantidad = reparto[1].cantidad.plus(reparto[0].cantidad);
    reparto[0].cantidad = D(0);
  }
  reparto.forEach(({ t, cantidad }) => {
    if (!cantidad.gt(0)) return;
    const indice = tramos.indexOf(t);
    orders.push({
      clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, indice),
      levelKind: LevelKind.TAKE_PROFIT,
      levelIndex: indice,
      side: lado,
      type: 'LIMIT',
      timeInForce: 'GTC',
      price: t.precio,
      qty: qy(ctx.market, cantidad),
      reduceOnly: true,
    });
  });

  const minutos = Math.max(0, Math.round((op.plan.venceEn - ctx.now) / 60_000));
  const objetivos = pendientes.map((t) => t.precio).join(' / ');
  return {
    orders,
    immediate: [],
    note:
      `${largo ? 'Largo' : 'Corto'} en marcha (${op.plan.candidatoId}, ${op.plan.apalancamiento}x). ` +
      `Stop en ${precioStop}${nueva.stopBreakeven ? ' (breakeven)' : ''}, objetivo${
        pendientes.length > 1 ? 's' : ''
      } ${objetivos}. Cierre por tiempo en ${minutos} min.`,
    scratchPatch: Object.keys(patch).length > 0 ? patch : undefined,
    avisos: avisos.length > 0 ? avisos : undefined,
  };
}

// ── En plano ────────────────────────────────────────────────────────────────

/** Sin historial no se puede saber lo perdido hoy: no hay entradas. */
const historialDe = (ctx: BotContext): HistorialOperaciones | null => ctx.historial ?? null;

const ORDEN_CONFIANZA: Record<string, number> = {
  [NivelConfianza.BAJA]: 0,
  [NivelConfianza.MEDIA]: 1,
  [NivelConfianza.ALTA]: 2,
};

interface Puerta {
  nota: string;
  aviso?: AvisoEstrategia;
  pausar?: string;
}

/** Las puertas que no dependen del mercado, en el orden del plan. */
function puertasDelDia(ctx: BotContext, c: ConfigCanal, h: HistorialOperaciones): Puerta | null {
  const perdida = perdidaHoyPct(h, c.capital);
  if (perdida.gte(c.topeDiarioPct.mul(FACTOR_PAUSA_DIARIA))) {
    const texto =
      `La pérdida de hoy (${perdida.toFixed(2)} %) llega a 1,5 veces el tope diario: el bot se ` +
      'pausa hasta las 00:00 UTC. Reanudarlo antes no abre entradas y la guarda diaria lo vuelve ' +
      'a pausar.';
    return { nota: texto, pausar: texto };
  }
  if (perdida.gte(c.topeDiarioPct)) {
    return {
      nota:
        `Tope diario alcanzado (${perdida.toFixed(2)} % de ${c.topeDiarioPct.toFixed()} %): sin ` +
        'entradas hasta las 00:00 UTC.',
      aviso: {
        clave: `tope-dia:${h.dia}`,
        tipo: EventoCanal.TOPE_DIARIO,
        severidad: 'WARN',
        mensaje: `Tope diario alcanzado: sin entradas hasta las 00:00 UTC.`,
      },
    };
  }
  if (c.objetivoDiarioPct.gt(0)) {
    const ganado = D(h.realizadoHoy).div(c.capital).mul(100);
    if (ganado.gte(c.objetivoDiarioPct)) {
      return {
        nota: `Objetivo del día cumplido (${ganado.toFixed(2)} %): sin entradas hasta las 00:00 UTC.`,
      };
    }
  }
  if (h.operacionesHoy >= c.maxOperacionesDia) {
    return {
      nota: `${h.operacionesHoy} operaciones hoy, el máximo: sin entradas hasta las 00:00 UTC.`,
    };
  }
  const esperando = (desde: number | null, minutos: number): number =>
    desde !== null && minutos > 0 ? desde + minutos * 60_000 - ctx.now : 0;
  if (h.rachaPerdidas >= c.maxPerdidasSeguidas) {
    const falta = esperando(h.ultimaPerdidaEn, c.esperaRachaMin);
    if (falta > 0) {
      return {
        nota: `${h.rachaPerdidas} pérdidas seguidas: espera de ${Math.ceil(falta / 60_000)} min.`,
      };
    }
  }
  const tras = [
    { falta: esperando(h.ultimoStopEn, c.esperaStopMin), que: 'tras el último stop' },
    { falta: esperando(h.ultimoCierreEn, c.esperaMin), que: 'entre operaciones' },
    {
      falta: ctx.cycle.cooldownUntil ? ctx.cycle.cooldownUntil - ctx.now : 0,
      que: 'entre operaciones',
    },
  ].find((e) => e.falta > 0);
  if (tras) return { nota: `Espera ${tras.que}: ${Math.ceil(tras.falta / 60_000)} min.` };
  if (c.ventanasSinEntradas === null) {
    return {
      nota: 'Las ventanas sin entradas están mal escritas: sin entradas hasta corregirlas.',
    };
  }
  if (enVentanaSinEntradas(c.ventanasSinEntradas, ctx.now)) {
    return { nota: 'Ventana horaria sin entradas.' };
  }
  const caida = D(h.picoRealizado).minus(h.realizadoTotal).div(c.capital).mul(100);
  if (caida.gte(c.maxCaidaPct)) {
    const texto =
      `Caída desde el máximo del ${caida.toFixed(2)} %, por encima del ` +
      `${c.maxCaidaPct.toFixed()} % permitido: el bot se pausa. Al reanudarlo, la caída se mide ` +
      'desde el resultado de ese momento.';
    return { nota: texto, pausar: texto };
  }
  return null;
}

/** Las puertas del mercado, con el análisis del tick. */
function puertasDelMercado(
  ctx: BotContext,
  c: ConfigCanal,
  salida: SalidaHerramienta,
  a: ResultadoAnalisis,
): string | null {
  if (!salida.mercado.frescas) return 'Esperando velas cerradas al día.';
  const canal = salida.canal;
  if (!canal) {
    const motivos = a.motivosCanal.length > 0 ? ` (${a.motivosCanal.join(', ')})` : '';
    return `Sin canal operable${motivos}.`;
  }
  const r = a.regimen;
  const aFavor = canal.pendientePorVela > 0 ? SentidoTendencia.ALCISTA : SentidoTendencia.BAJISTA;
  const regimenValido =
    r.regimen === RegimenMercado.RANGO ||
    (canal.tipo === TipoCanal.INCLINADO &&
      r.regimen === RegimenMercado.TENDENCIA &&
      r.sentido === aFavor &&
      salida.mercado.adx1h < ADX_INCLINADO);
  if (!regimenValido) {
    return `Régimen ${r.regimen}${r.sentido ? ` ${r.sentido}` : ''}: el canal no se opera así.`;
  }
  const spread = D(ctx.ticker.ask).minus(ctx.ticker.bid);
  const tope = D(salida.mercado.atr15m).mul(c.maxSpreadFraccion);
  if (spread.gt(tope)) {
    return `Spread de ${spread.toFixed()} por encima de ${c.maxSpreadFraccion} ATR: sin entradas.`;
  }
  const proximo = ctx.ticker.nextFundingAt;
  if (proximo !== undefined && c.apagonFundingMin > 0) {
    const falta = proximo - ctx.now;
    if (falta >= 0 && falta <= c.apagonFundingMin * 60_000) {
      return `Cobro de funding en ${Math.ceil(falta / 60_000)} min: sin entradas hasta que pase.`;
    }
  }
  return null;
}

/** El funding que paga el lado, por encima del tope configurado. */
function fundingEnContra(ctx: BotContext, c: ConfigCanal, lado: 'LONG' | 'SHORT'): boolean {
  const f = fundingBps(ctx.ticker);
  if (f === null || c.maxFundingBps <= 0) return false;
  if (f.abs().lte(c.maxFundingBps)) return false;
  return lado === 'LONG' ? f.gt(0) : f.lt(0);
}

function sinEntrada(nota: string, extra: Partial<DesiredState> = {}): DesiredState {
  return { orders: [], immediate: [], note: nota, ...extra };
}

type CanalDeVista = NonNullable<VistaCanal['canal']>;

function mismoCanal(a: CanalDeVista | null, b: CanalDeVista | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.tipo === b.tipo &&
    a.calidad === b.calidad &&
    a.soporte === b.soporte &&
    a.resistencia === b.resistencia &&
    a.media === b.media &&
    a.pendientePorVela === b.pendientePorVela &&
    a.refT === b.refT &&
    a.desde === b.desde
  );
}

/**
 * Lo que el panel y el gráfico enseñan del mercado (spec 059): el régimen y el
 * canal del último análisis, también cuando no hay setup.
 *
 * Solo se anota con velas al día —una vista vieja se queda como estaba, con su
 * vela, y la pantalla sabe decir de cuándo es— y solo si cambia: el scratch va
 * a la base en cada tick que lo toca. Se compara campo a campo y no como
 * texto, porque la base devuelve el JSON con las claves en otro orden.
 */
function anotarVista(
  ctx: BotContext,
  c: ConfigCanal,
  salida: SalidaHerramienta,
  patch: Record<string, unknown>,
): void {
  if (!salida.mercado.frescas) return;
  const canal = salida.canal;
  const vista: VistaCanal = {
    barT: salida.barT,
    regimen: salida.mercado.regimen,
    sentido: salida.mercado.sentido,
    canal: canal
      ? {
          tipo: canal.tipo,
          calidad: canal.calidad,
          soporte: canal.soporte,
          resistencia: canal.resistencia,
          media: canal.media,
          pendientePorVela: canal.pendientePorVela,
          refT: canal.refT,
          desde: inicioDelCanal(canal, c.intervaloEstructura),
        }
      : null,
  };
  const previa = vistaCanalDe(ctx.cycle.scratch);
  const igual =
    previa !== null &&
    previa.barT === vista.barT &&
    previa.regimen === vista.regimen &&
    previa.sentido === vista.sentido &&
    mismoCanal(previa.canal, vista.canal);
  if (!igual) patch['vista'] = vista;
}

function enPlano(
  ctx: BotContext,
  c: ConfigCanal,
  seq: number,
  op: OperacionGuardada | null,
): DesiredState {
  const patch: Record<string, unknown> = {};
  const avisos: AvisoEstrategia[] = [];
  let decision: MarcaDecision | undefined;
  // Un cierre a medias de la operación anterior ya no significa nada.
  if (ctx.cycle.scratch['cierre'] !== undefined && ctx.cycle.scratch['cierre'] !== null) {
    patch['cierre'] = null;
  }

  // ── Una entrada recién enviada ─────────────────────────────────────
  if (op) {
    const coid = makeCoid(ctx.botId, seq, LevelKind.BASE, op.intento);
    const enLibro = ctx.openOrders.some((o) => o.clientOrderId === coid);
    const transcurrido = ctx.now - op.enviadaEn;
    const hayLlenado = ctx.cycle.entriesFilled > 0 || ctx.cycle.averageEntry !== null;
    if (
      enLibro ||
      transcurrido < ESPERA_LLENADO_MS ||
      (hayLlenado && transcurrido < ESPERA_MAXIMA_LLENADO_MS)
    ) {
      return sinEntrada('Entrada enviada: esperando a que el venue la confirme.');
    }
    // La operación llegó a existir (`maximo` solo se pone con posición a la vista)
    // y ahora el venue está plano: se cerró fuera del bot, o su ejecución todavía
    // no se ha barrido. No es una IOC sin llenar, así que ni se descarta la
    // decisión ni se avisa de un llenado que sí hubo: se espera a que el motor
    // cierre el ciclo, que es quien tiene las ejecuciones (spec 062 F-21).
    if (op.maximo !== undefined) {
      return sinEntrada('La operación ya no está en el venue: esperando su ejecución.');
    }
    // La IOC no se llenó: la decisión ya se usó y se descarta. Se resuelve en
    // su propio tick: un plan solo marca una intención, y la siguiente entrada
    // necesita la suya.
    patch['op'] = null;
    return sinEntrada('La entrada anterior no se llenó dentro de su tope de precio.', {
      scratchPatch: patch,
      decision: {
        intentId: op.plan.intentId,
        estado: EstadoIntencion.RECHAZADA,
        motivo: MotivoRechazo.VENUE,
        plan: null,
      },
      avisos: [
        {
          clave: `sin-llenado:${op.plan.intentId}`,
          tipo: EventoCanal.ENTRADA_DESCARTADA,
          severidad: 'INFO',
          mensaje: `La entrada ${op.plan.candidatoId} no se llenó dentro de su tope de precio.`,
        },
      ],
    });
  }
  const extra = (): Partial<DesiredState> => ({
    scratchPatch: Object.keys(patch).length > 0 ? patch : undefined,
    avisos: avisos.length > 0 ? avisos : undefined,
    decision,
  });

  // ── Las puertas ────────────────────────────────────────────────────
  const h = historialDe(ctx);
  if (!h) return sinEntrada('Sin el historial del día no hay entradas.', extra());

  const limites = ctx.limites;
  const analisis = analizarMercado({
    cfg: c,
    market: ctx.market,
    ticker: ctx.ticker,
    series: ctx.series ?? {},
    fundingBps: fundingBps(ctx.ticker)?.toNumber() ?? null,
    saldoLibre: ctx.availableBalance,
    historial: h,
    niveles: ctx.nivelesApalancamiento ?? [],
    maxApalancamientoUsuario: limites?.maxApalancamientoUsuario ?? null,
    ahora: ctx.now,
  });
  const salidaCompleta = analisis.salida;
  // La vista se anota ANTES de las puertas del día: si no, durante la espera
  // entre operaciones, con el tope diario alcanzado o en la racha de pérdidas,
  // la pantalla decía «Sin análisis todavía» aunque el motor estuviera mirando
  // el canal en cada vela. El análisis está cacheado por vela, así que mirarlo
  // aquí no cuesta una cuenta más (spec 062, F-47).
  anotarVista(ctx, c, salidaCompleta, patch);

  const dia = puertasDelDia(ctx, c, h);
  if (dia) {
    if (dia.aviso) avisos.push(dia.aviso);
    return sinEntrada(dia.nota, { ...extra(), pausar: dia.pausar });
  }

  const mercado = puertasDelMercado(ctx, c, salidaCompleta, analisis);
  if (mercado) return sinEntrada(mercado, extra());

  // La vela de la decisión tiene que haber cerrado después de la última salida:
  // una operación que abre y cierra dentro de la misma vela no la reutiliza.
  const cierreVela = salidaCompleta.barT + CINCO_MIN;
  if (h.ultimoCierreEn !== null && h.ultimoCierreEn >= cierreVela) {
    return sinEntrada('Esperando a la siguiente vela tras la última salida.', extra());
  }
  if (c.modo === 'REGLAS' && ctx.cycle.scratch['decididaEn'] === salidaCompleta.barT) {
    return sinEntrada('Esta vela ya se decidió: esperando a la siguiente.', extra());
  }

  if (!c.entradasActivas) return sinEntrada('Entradas apagadas en la configuración.', extra());
  if (!limites) return sinEntrada('Sin los límites del motor no hay entradas.', extra());
  if (!limites.entradasPermitidas) {
    return sinEntrada(`Entradas cortadas: ${limites.motivo ?? 'interruptor global'}.`, extra());
  }
  if (!limites.venueListo) {
    return sinEntrada(`El venue no está listo: ${limites.motivo ?? 'sin tramos'}.`, extra());
  }

  // El funding en contra quita el lado que paga.
  const candidatos = salidaCompleta.candidatos.filter(
    (cand) => !fundingEnContra(ctx, c, cand.lado),
  );
  const salida: SalidaHerramienta = { ...salidaCompleta, candidatos };
  const elegibles = candidatos.filter(esElegible);
  if (elegibles.length === 0) {
    const vigilando = salidaCompleta.candidatos.filter((x) => x.estado === EstadoSetup.VIGILANDO);
    const quitados = salidaCompleta.candidatos.length - candidatos.length;
    const nota =
      quitados > 0 && candidatos.length === 0
        ? 'Setup descartado por funding en contra.'
        : vigilando.length > 0
          ? `Vigilando ${vigilando.map((x) => x.id).join(', ')}: faltan confirmaciones.`
          : `Canal ${salida.canal?.tipo ?? ''} ${salida.canal?.calidad ?? ''}: sin setup listo.`;
    return sinEntrada(nota, extra());
  }

  // ── La decisión ────────────────────────────────────────────────────
  const intento = Number(ctx.cycle.scratch['intentos'] ?? 0);
  if (c.modo === 'REGLAS') {
    const eleccion = juezDeReglas(salida, c);
    if (eleccion.veredicto !== Veredicto.OPERAR) {
      patch['decididaEn'] = salida.barT;
      return sinEntrada('El juez no ve una opción que cumpla el perfil.', extra());
    }
    // El motor crea la fila con este id: tiene que ser único en toda la base.
    const intentId = `reglas:${ctx.botId}:${salida.barT}`;
    return entrar(ctx, c, seq, intento, salida, eleccion, intentId, patch, avisos, null);
  }

  const dIa = ctx.decisionIa ?? null;
  const deEstaVela = dIa !== null && dIa.barT === salida.barT && dIa.cycleSeq === seq;
  if (dIa && deEstaVela && dIa.estado === EstadoIntencion.DECIDIDA && dIa.eleccion) {
    const rechazar = (motivo: MotivoRechazo, nota: string): DesiredState => {
      decision = { intentId: dIa.intentId, estado: EstadoIntencion.RECHAZADA, motivo, plan: null };
      return sinEntrada(nota, extra());
    };
    if (dIa.expiresAt <= ctx.now)
      return rechazar(MotivoRechazo.PLAZO, 'La decisión de la IA llegó tarde.');
    if (dIa.huella !== salida.huella) {
      return rechazar(MotivoRechazo.HUELLA, 'La oferta cambió desde que se consultó a la IA.');
    }
    if (
      dIa.eleccion.veredicto === Veredicto.OPERAR &&
      ORDEN_CONFIANZA[dIa.eleccion.confianza] < ORDEN_CONFIANZA[c.confianzaMinima]
    ) {
      return rechazar(MotivoRechazo.OFERTA, 'La IA decidió con menos confianza de la pedida.');
    }
    if (dIa.eleccion.veredicto !== Veredicto.OPERAR) {
      return rechazar(MotivoRechazo.OFERTA, 'La IA no quiere operar esta vela.');
    }
    // La API ya la guarda reducida; se vuelve a aplicar por si no (spec 059).
    return entrar(
      ctx,
      c,
      seq,
      intento,
      salida,
      eleccionEfectiva(dIa.eleccion),
      dIa.intentId,
      patch,
      avisos,
      dIa.intentId,
    );
  }
  if (dIa && deEstaVela) {
    const esperando =
      dIa.estado === EstadoIntencion.SOLICITADA || dIa.estado === EstadoIntencion.CONSULTANDO;
    return sinEntrada(
      esperando
        ? 'Consultando a la IA.'
        : `La IA no operó en esta vela${dIa.motivo ? `: ${dIa.motivo}` : ''}.`,
      extra(),
    );
  }
  // Sin decisión para esta vela: se pide.
  return sinEntrada('Setup listo: solicitud enviada a la IA.', {
    ...extra(),
    solicitudIa: {
      barT: salida.barT,
      huella: salida.huella,
      expiresAt: cierreVela + 60_000,
      snapshot: salida,
    },
  });
}

function entrar(
  ctx: BotContext,
  c: ConfigCanal,
  seq: number,
  intento: number,
  salida: SalidaHerramienta,
  eleccion: EleccionOperacion,
  intentId: string,
  patch: Record<string, unknown>,
  avisos: AvisoEstrategia[],
  /** La intención de la IA que se usa; null en modo reglas (el motor crea la suya). */
  idDecision: string | null,
): DesiredState {
  const r = construirOperacion(salida, eleccion, c, ctx.market, intentId, ctx.now);
  const extra = (decision: MarcaDecision | undefined): Partial<DesiredState> => ({
    scratchPatch: Object.keys(patch).length > 0 ? patch : undefined,
    avisos: avisos.length > 0 ? avisos : undefined,
    decision,
  });
  if (c.modo === 'REGLAS') patch['decididaEn'] = salida.barT;
  if (!r.plan) {
    const decision: MarcaDecision | undefined = idDecision
      ? {
          intentId: idDecision,
          estado: EstadoIntencion.RECHAZADA,
          motivo: r.motivo === 'MINIMO' ? MotivoRechazo.LIMITES : MotivoRechazo.OFERTA,
          plan: null,
        }
      : undefined;
    return sinEntrada(`Decisión descartada: ${r.motivo}.`, extra(decision));
  }
  const plan = r.plan;
  if (c.soloObservar) {
    return sinEntrada(
      `Solo observar: habría entrado ${plan.lado === 'LONG' ? 'en largo' : 'en corto'} ` +
        `(${plan.candidatoId}) con ${plan.cantidad} a ${plan.apalancamiento}x, stop ${plan.stop}.`,
      extra({
        intentId,
        estado: EstadoIntencion.RECHAZADA,
        motivo: MotivoRechazo.PUERTA,
        plan,
      }),
    );
  }
  const largo = plan.lado === 'LONG';
  patch['op'] = { plan, intento, enviadaEn: ctx.now } satisfies OperacionGuardada;
  patch['intentos'] = intento + 1;
  const entrada: DesiredOrder = {
    clientOrderId: makeCoid(ctx.botId, seq, LevelKind.BASE, intento),
    levelKind: LevelKind.BASE,
    levelIndex: intento,
    side: largo ? 'BUY' : 'SELL',
    type: 'LIMIT',
    timeInForce: 'IOC',
    price: plan.entradaTope,
    qty: plan.cantidad,
    reduceOnly: false,
  };
  return {
    orders: [entrada],
    immediate: [],
    apalancamiento: plan.apalancamiento,
    note:
      `Entrada ${largo ? 'larga' : 'corta'} (${plan.candidatoId}): ${plan.cantidad} hasta ` +
      `${plan.entradaTope} a ${plan.apalancamiento}x, stop ${plan.stop}, R ${plan.rNeto.toFixed(2)}.`,
    ...extra({ intentId, estado: EstadoIntencion.ACEPTADA, motivo: null, plan }),
  };
}

// ── La estrategia ───────────────────────────────────────────────────────────

export const aiChannel: Strategy<AiChannelConfig> = {
  kind: StrategyKind.AI_CHANNEL,
  meta: META,

  // Ni `reusesOrderSlots` ni `keepCycleOnFlat`: cada intento de entrada usa su
  // propio `BASE#n`, y la fila ejecutada veta repetirlo. El ciclo es la
  // operación: al quedar plano se cierra y el scratch empieza de cero.
  stopPropio: true,
  apalancamientoPorOperacion: true,
  reglaLiquidacion: 'POR_STOP',
  topeDiarioReanuda: true,
  consumeDecisionesIa: true,
  // Sin IA decide el juez, que elige por el mismo perfil (`aiProfile`).
  sinIa: (config) => ({ ...config, decisionMode: 'REGLAS' }),
  // Ni las series ni el nocional dependen de las comisiones: el venue da igual.
  series: (config) => seriesDe(leer(config, Venue.HYPERLIQUID)),
  nocionalMaximo: (config) => nocionalMaximoDe(leer(config, Venue.HYPERLIQUID)).toFixed(),

  defaults() {
    return { ...DEFAULTS_CANAL };
  },

  validate(config: AiChannelConfig, market: MarketSpec): ValidationResult {
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
    if (!c.riesgoPct.gt(0) || c.riesgoPct.gt(2)) {
      issues.push(err('riskPerTradePct', 'El riesgo por operación va de 0,1 % a 2 %.'));
    }
    if (c.topeDiarioPct.gt(6)) {
      issues.push(err('maxDailyLossPct', 'La pérdida diaria máxima no puede pasar del 6 %.'));
    }
    if (c.topeDiarioPct.lt(c.riesgoPct)) {
      issues.push(
        err(
          'maxDailyLossPct',
          'La pérdida diaria máxima no puede ser menor que el riesgo de una sola operación.',
        ),
      );
    }
    if (c.ventanasSinEntradas === null) {
      issues.push(
        err(
          'noEntryWindowsUtc',
          'Formato de las ventanas: HH:MM-HH:MM separadas por comas, hasta seis.',
        ),
      );
    }
    const stopFijo = Number(config.stopLossPct ?? 0);
    if (Number.isFinite(stopFijo) && stopFijo > 0) {
      issues.push(
        warn(
          'stopLossPct',
          'Esta estrategia pone el stop de cada operación con el canal y el ATR. El stop loss por ' +
            'porcentaje no se usa.',
        ),
      );
    }
    // Con el stop más ancho que admite, ¿llega la operación al mínimo del venue?
    if (c.capital.gt(0) && market.minNotional) {
      const costes = D(c.costes.takerBps).mul(2).plus(c.costes.deslizamientoBps).div(10_000);
      const riesgo = c.capital.mul(Decimal.min(c.riesgoPct, c.topeDiarioPct)).div(100);
      const nocional = Decimal.min(
        riesgo.div(c.maxStopPct.div(100).plus(costes)),
        nocionalMaximoDe(c),
      );
      if (nocional.lt(market.minNotional)) {
        issues.push(
          err(
            'totalInvestment',
            `Con este capital y este riesgo, una operación con el stop más ancho ` +
              `(${c.maxStopPct.toFixed()} %) no llega al mínimo del venue ` +
              `(${D(market.minNotional).toFixed()}).`,
          ),
        );
      }
    }
    if (c.setups.length > 1) {
      issues.push(
        warn(
          'allowedSetups',
          'La ruptura fallida entra contra un movimiento que acaba de romper el canal: es la ' +
            'operación con más riesgo de las dos.',
        ),
      );
    }
    if (c.modo === 'REGLAS') {
      issues.push(
        warn(
          'decisionMode',
          'En modo reglas no se consulta a la IA: decide el juez determinista con el perfil.',
        ),
      );
    }
    return toResult(issues);
  },

  preview(config: AiChannelConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const validation = this.validate(config, market);
    if (!validation.ok) return invalidPreview(validation.issues);
    const c = leer(config, market.venue);
    const precio = D(refPrice);
    if (!precio.gt(0)) return invalidPreview([err(null, 'Sin precio de referencia.')]);

    // Una operación de ejemplo con el stop más ancho que se admite y un ATR de
    // 1 h del 1 %: el peor caso de apalancamiento que la regla permitiría.
    const s = c.maxStopPct.div(100);
    const mmr = maintenanceMarginRateOf(market);
    const lev = apalancamientoPorStop({
      distanciaStop: s,
      atr1hRelativo: '0.01',
      liqBufferStops: c.colchonStops,
      mantenimiento: mmr,
      topes: [25, c.apalancamientoTope, market.maxLeverage],
    });
    const riesgo = c.capital.mul(Decimal.min(c.riesgoPct, c.topeDiarioPct)).div(100);
    const costes = D(c.costes.takerBps).mul(2).plus(c.costes.deslizamientoBps).div(10_000);
    const techo = nocionalMaximoDe(c);
    const maxMargen = c.capital.mul(c.maxMargenPct).div(100);
    const palanca = Math.max(1, lev.maximo);
    let nocional = Decimal.min(riesgo.div(s.plus(costes)), techo, c.capital.mul(palanca));
    nocional = Decimal.min(nocional, maxMargen.mul(palanca));
    const qty = D(qy(market, nocional.div(precio)));
    const largo = c.direccion !== 'SHORT';
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
          `Límites: ${pct(riesgo)} por operación (${c.riesgoPct.toFixed()} %), ` +
            `${pct(c.capital.mul(c.topeDiarioPct).div(100))} al día ` +
            `(${c.topeDiarioPct.toFixed()} %), nocional hasta ${pct(techo)} y, en un hueco, ` +
            `como mucho ${pct(maxMargen)} (${c.maxMargenPct.toFixed()} % del capital).`,
        ),
        warn(
          null,
          `Estimación: con el stop más ancho (${c.maxStopPct.toFixed()} %) y un ATR de 1 h del 1 %, ` +
            `el apalancamiento baja a ${lev.maximo}x y la liquidación queda a ` +
            `${lev.necesaria.mul(100).toFixed(1)} % o más. Cada operación calcula el suyo con su ` +
            'stop: con uno más estrecho, más apalancamiento y la misma pérdida al stop.',
        ),
      ],
    });
  },

  plan(ctx: BotContext): DesiredState {
    const c = leerConfig(ctx.config, ctx.venue);
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const op = leerOperacion(ctx.cycle.scratch['op']);
    const qtyPos = ctx.position ? D(ctx.position.qty) : D(0);
    if (!qtyPos.isZero()) {
      // Con posición el stop y los objetivos no necesitan velas. Las salidas que
      // sí las miran (invalidación y régimen) solo se evalúan si las hay.
      const analisis =
        ctx.series && ctx.historial
          ? analizarMercado({
              cfg: c,
              market: ctx.market,
              ticker: ctx.ticker,
              series: ctx.series,
              fundingBps: null,
              saldoLibre: ctx.availableBalance,
              historial: ctx.historial,
              niveles: ctx.nivelesApalancamiento ?? [],
              maxApalancamientoUsuario: null,
              ahora: ctx.now,
            })
          : null;
      return conPosicion(ctx, c, seq, op, qtyPos, analisis);
    }
    return enPlano(ctx, c, seq, op);
  },
};
