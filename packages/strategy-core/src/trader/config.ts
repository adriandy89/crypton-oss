/**
 * La configuración del «Bot de IA» (spec 068).
 *
 * `DEFAULTS_TRADER` es la ÚNICA fuente de los valores por defecto: la usan
 * `meta.fields`, `defaults()` y este lector, y la batería genérica exige que no
 * discrepen. Un valor por defecto distinto en el formulario y en el motor sería
 * un bot que no hace lo que dice.
 *
 * Dos defectos merecen explicación porque van más apretados que los del canal:
 * `maxCostPerTradeR` en 0,15 y `minTargetCostMultiple` en 25. Salen del spec
 * 066, que midió que por debajo de quince veces el coste se pierde de media, y
 * del 067, que encontró el mejor resultado justo por encima.
 */
import {
  AccionTrader,
  BucketObjetivo,
  BucketStop,
  D,
  Decimal,
  ModoDecision,
  TamanoOperacion,
  type BotConfig,
  type Venue,
} from '@crypton/shared';
import { costesDe, type Costes } from '../canal/costes';

export const DEFAULTS_TRADER = {
  direction: 'NEUTRAL',
  leverage: 25,
  marginMode: 'ISOLATED',

  /**
   * Arranca en reglas y solo observando: un bot recién creado no llega ni al
   * modelo ni al mercado hasta que su dueño lo diga **dos veces**.
   */
  decisionMode: 'REGLAS',
  observeOnly: true,
  entriesEnabled: true,

  riskPerTradePct: '0.5',
  maxMarginPct: '25',
  maxNotionalMultiple: '5',
  maxNotionalCap: '',
  liqBufferStops: 3,
  maxStopPct: '2',
  maxCostPerTradeR: '0.15',
  minTargetCostMultiple: 25,
  minRewardRisk: '1',
  maxEntrySlippageR: '0.15',
  maxSpreadFraction: '0.1',
  maxDailyLossPct: '4',
  maxDrawdownPct: '15',
  dailyProfitTargetPct: '0',

  bandPeriod: 20,
  bandSigma: '2',
  bandWindowBars: 96,
  touchPercentB: '0.1',
  maxAdx1h: '20',
  minBandWidthAtr: '2',
  maxHalfLifeBars: 12,

  maxHoldBars: 24,
  invalidationAtr: '0.5',

  /**
   * Los umbrales de confianza son del USUARIO. El modelo no los toca jamás.
   *
   * Estaban en 0,90 y 0,95, copiados del «act automatically above 0.9» de la
   * documentación del proveedor. Probando contra BTC real, el modelo **no pasó
   * de 0,61** en dieciséis llamadas seguidas (rango 0,35-0,61): con 0,90 el bot
   * no operaría jamás. La propia documentación avisa de esto —«the correct
   * threshold values depend on your domain... test with your own data»— así que
   * esto es hacerle caso.
   *
   * OJO: dieciséis llamadas de un par y doce horas son POCA muestra para
   * calibrar un umbral. Es un punto de partida medido, no un valor asentado, y
   * por eso es un campo del usuario y no una constante.
   */
  minRouteConfidence: '0.45',
  fullSizeConfidence: '0.6',
  minRegimeProb: '0.75',
  minExhaustionProb: '0.65',
  minEvidenceProb: '0.55',
  statedThreshold: '0.6',
  requireAgreement: true,
  defaultStopBucket: 'MEDIDO',
  defaultTargetBucket: 'EN_LA_MEDIA',
  halfSizeFallback: 'NO_OPERAR',
  wrongEnvironmentCooldownBars: 8,

  maxTradesPerDay: 8,
  maxConsecutiveLosses: 3,
  lossStreakCooldownMinutes: 120,
  stopCooldownMinutes: 30,
  cooldownMinutes: 15,
  aiDailyCallBudget: 48,

  // `null` y no cadena vacía: el descriptor declara `default: null` y la
  // batería genérica exige que el formulario y el motor digan lo mismo.
  makerFeeBps: null,
  takerFeeBps: null,
  slippageBps: null,
} as const;

/** Qué hacer cuando la confianza pide media posición y el venue no la admite. */
export const RespaldoMedio = {
  NO_OPERAR: 'NO_OPERAR',
  COMPLETO: 'COMPLETO',
} as const;
export type RespaldoMedio = (typeof RespaldoMedio)[keyof typeof RespaldoMedio];

export interface ConfigTrader {
  modo: ModoDecision;
  soloObservar: boolean;
  entradasActivas: boolean;

  capital: Decimal;
  riesgoPctOperacion: Decimal;
  maxMargenPct: Decimal;
  multiploNocional: Decimal;
  topeNocional: Decimal | null;
  colchonStops: number;
  maxStopPct: Decimal;
  /** Lo más que pueden llevarse comisiones y deslizamiento del riesgo. */
  maxCosteR: Decimal;
  /** Lo menos que tiene que recorrer el precio hasta el objetivo, en costes. */
  minObjetivoCoste: number;
  minRR: number;
  maxDeslizamientoR: Decimal;
  maxSpreadFraccion: number;
  apalancamientoTope: number;
  maxPerdidaDiaPct: Decimal;
  maxCaidaPct: Decimal;
  objetivoDiarioPct: Decimal;

  periodoBanda: number;
  sigmaBanda: number;
  ventanaBanda: number;
  toquePorcentajeB: number;
  maxAdx1h: number;
  minAnchuraAtr: number;
  maxMediaVida: number;

  maxVelasOperacion: number;
  invalidacionAtr: number;

  confianzaMinRuta: number;
  confianzaTamanoCompleto: number;
  minProbRegimen: number;
  minProbAgotamiento: number;
  minProbHistorial: number;
  umbralDeterminado: number;
  exigirAcuerdo: boolean;
  stopPorDefecto: BucketStop;
  objetivoPorDefecto: BucketObjetivo;
  respaldoMedio: RespaldoMedio;
  enfriadoEntornoVelas: number;

  maxOperacionesDia: number;
  maxPerdidasSeguidas: number;
  esperaRachaMin: number;
  esperaStopMin: number;
  esperaMin: number;
  presupuestoIaDia: number;

  costes: Costes;
}

const decimal = (v: unknown, def: string): Decimal => {
  if (v === null || v === undefined || v === '') return D(def);
  try {
    const d = D(typeof v === 'number' || typeof v === 'string' ? v : def);
    return d.isFinite() ? d : D(def);
  } catch {
    return D(def);
  }
};

const numero = (v: unknown, def: string): number => decimal(v, def).toNumber();

const entero = (v: unknown, def: number): number => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? Math.trunc(n) : def;
};

const booleano = (v: unknown, def: boolean): boolean =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : def;

const enumerado = <T extends string>(v: unknown, opciones: readonly T[], def: T): T =>
  typeof v === 'string' && (opciones as readonly string[]).includes(v) ? (v as T) : def;

export function leerConfigTrader(cfg: BotConfig, venue: Venue): ConfigTrader {
  const c = cfg as Record<string, unknown>;
  const d = DEFAULTS_TRADER;
  const tope = decimal(c['maxNotionalCap'], '0');
  return {
    modo: enumerado(c['decisionMode'], [ModoDecision.IA, ModoDecision.REGLAS], d.decisionMode),
    soloObservar: booleano(c['observeOnly'], d.observeOnly),
    entradasActivas: booleano(c['entriesEnabled'], d.entriesEnabled),

    capital: decimal(c['totalInvestment'], '0'),
    riesgoPctOperacion: decimal(c['riskPerTradePct'], d.riskPerTradePct),
    maxMargenPct: decimal(c['maxMarginPct'], d.maxMarginPct),
    multiploNocional: decimal(c['maxNotionalMultiple'], d.maxNotionalMultiple),
    topeNocional: tope.gt(0) ? tope : null,
    colchonStops: Math.max(3, entero(c['liqBufferStops'], d.liqBufferStops)),
    maxStopPct: decimal(c['maxStopPct'], d.maxStopPct),
    maxCosteR: decimal(c['maxCostPerTradeR'], d.maxCostPerTradeR),
    minObjetivoCoste: entero(c['minTargetCostMultiple'], d.minTargetCostMultiple),
    minRR: numero(c['minRewardRisk'], d.minRewardRisk),
    maxDeslizamientoR: decimal(c['maxEntrySlippageR'], d.maxEntrySlippageR),
    maxSpreadFraccion: numero(c['maxSpreadFraction'], d.maxSpreadFraction),
    apalancamientoTope: entero(c['leverage'], d.leverage),
    maxPerdidaDiaPct: decimal(c['maxDailyLossPct'], d.maxDailyLossPct),
    maxCaidaPct: decimal(c['maxDrawdownPct'], d.maxDrawdownPct),
    objetivoDiarioPct: decimal(c['dailyProfitTargetPct'], d.dailyProfitTargetPct),

    periodoBanda: entero(c['bandPeriod'], d.bandPeriod),
    sigmaBanda: numero(c['bandSigma'], d.bandSigma),
    ventanaBanda: entero(c['bandWindowBars'], d.bandWindowBars),
    toquePorcentajeB: numero(c['touchPercentB'], d.touchPercentB),
    maxAdx1h: numero(c['maxAdx1h'], d.maxAdx1h),
    minAnchuraAtr: numero(c['minBandWidthAtr'], d.minBandWidthAtr),
    maxMediaVida: entero(c['maxHalfLifeBars'], d.maxHalfLifeBars),

    maxVelasOperacion: entero(c['maxHoldBars'], d.maxHoldBars),
    invalidacionAtr: numero(c['invalidationAtr'], d.invalidationAtr),

    confianzaMinRuta: numero(c['minRouteConfidence'], d.minRouteConfidence),
    confianzaTamanoCompleto: numero(c['fullSizeConfidence'], d.fullSizeConfidence),
    minProbRegimen: numero(c['minRegimeProb'], d.minRegimeProb),
    minProbAgotamiento: numero(c['minExhaustionProb'], d.minExhaustionProb),
    minProbHistorial: numero(c['minEvidenceProb'], d.minEvidenceProb),
    umbralDeterminado: numero(c['statedThreshold'], d.statedThreshold),
    exigirAcuerdo: booleano(c['requireAgreement'], d.requireAgreement),
    stopPorDefecto: enumerado(
      c['defaultStopBucket'],
      [BucketStop.CENIDO, BucketStop.MEDIDO, BucketStop.HOLGADO],
      d.defaultStopBucket,
    ),
    objetivoPorDefecto: enumerado(
      c['defaultTargetBucket'],
      [BucketObjetivo.CORTO, BucketObjetivo.EN_LA_MEDIA, BucketObjetivo.LARGO],
      d.defaultTargetBucket,
    ),
    respaldoMedio: enumerado(
      c['halfSizeFallback'],
      [RespaldoMedio.NO_OPERAR, RespaldoMedio.COMPLETO],
      d.halfSizeFallback,
    ),
    enfriadoEntornoVelas: entero(c['wrongEnvironmentCooldownBars'], d.wrongEnvironmentCooldownBars),

    maxOperacionesDia: entero(c['maxTradesPerDay'], d.maxTradesPerDay),
    maxPerdidasSeguidas: entero(c['maxConsecutiveLosses'], d.maxConsecutiveLosses),
    esperaRachaMin: entero(c['lossStreakCooldownMinutes'], d.lossStreakCooldownMinutes),
    esperaStopMin: entero(c['stopCooldownMinutes'], d.stopCooldownMinutes),
    esperaMin: entero(c['cooldownMinutes'], d.cooldownMinutes),
    presupuestoIaDia: entero(c['aiDailyCallBudget'], d.aiDailyCallBudget),

    costes: costesDe(venue, {
      makerFeeBps: c['makerFeeBps'],
      takerFeeBps: c['takerFeeBps'],
      slippageBps: c['slippageBps'],
    }),
  };
}

/** Los tres tamaños posibles, por si alguien quiere recorrerlos. */
export const TAMANOS: readonly TamanoOperacion[] = [
  TamanoOperacion.COMPLETO,
  TamanoOperacion.MEDIO,
];

/** Las tres acciones, en el orden en que se ofrecen al modelo. */
export const ACCIONES: readonly AccionTrader[] = [
  AccionTrader.TOMAR,
  AccionTrader.ESPERAR,
  AccionTrader.ENTORNO_EQUIVOCADO,
];
