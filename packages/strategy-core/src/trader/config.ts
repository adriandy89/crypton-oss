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
   * ── En modo IA, DECIDE LA IA. Todos los jueces de encima, apagados. ──
   *
   * Estos cinco mandos pueden anular al modelo, y por eso arrancan a cero:
   *
   * - `minRouteConfidence` y `fullSizeConfidence` comparan la confianza del
   *   modelo contra un suelo. A cero, su elección se ejecuta y con el tamaño
   *   entero.
   * - `statedThreshold` decide si se le hace caso al modelo sobre el stop y el
   *   objetivo, o si se usan los valores por defecto. A cero, **manda siempre
   *   su elección**.
   * - `requireAgreement` deja que las tres preguntas de contexto VETEN el
   *   enrutado. Apagado: el modelo ya integra esas tres cosas cuando elige, y
   *   volver a preguntárselas por separado para poder llevarle la contraria es
   *   ponerle un juez encima.
   *
   * Estaban en 0,45 / 0,60 / 0,60 / sí, y con eso el modelo casi nunca decidía:
   * probando contra BTC real su confianza **no pasó de 0,61** en dieciséis
   * llamadas (rango 0,35-0,61), así que la mitad de sus decisiones salían con
   * tamaño medio y una parte no salía. Se medía el juez, no la IA.
   *
   * Siguen siendo campos del USUARIO y se pueden subir: quien quiera un suelo
   * de confianza o un veto de contexto lo enciende. Lo que cambia es el
   * defecto, que ahora dice lo que el modo promete.
   *
   * Los tres `minXxxProb` solo se miran si `requireAgreement` está encendido:
   * son el valor que tendría el veto SI alguien lo quiere, no un veto activo.
   */
  minRouteConfidence: '0',
  fullSizeConfidence: '0',
  minRegimeProb: '0.75',
  minExhaustionProb: '0.65',
  minEvidenceProb: '0.55',
  statedThreshold: '0',
  requireAgreement: false,
  defaultStopBucket: 'MEDIDO',
  defaultTargetBucket: 'EN_LA_MEDIA',
  halfSizeFallback: 'NO_OPERAR',
  wrongEnvironmentCooldownBars: 8,

  /**
   * La cadencia de decision (spec 070).
   *
   * 15 min por defecto, y es lo MEDIDO como mejor en el caso dificil: sobre BTC
   * con costes reales da 0,71 evaluaciones al dia contra 0,38 a 5 min y 0,34 a
   * 30 min, y sin comision ninguna sigue ganando (3,69 contra 2,90 y 1,81).
   *
   * **1 minuto no esta, y no es un olvido**: 30 dias de BTC dieron 8.719 toques
   * y CERO ejecutables, porque el coste de ida y vuelta es fijo en precio y el
   * recorrido disponible encoge con la raiz del tiempo. Un ajuste que da cero
   * operaciones medidas seria una trampa, y ademas triplicaria la carga de
   * datos de mercado a cambio de nada.
   *
   * Es un campo del usuario porque el mejor valor depende del par: con cero
   * comision y sobre doce pares, 5 min daba MAS evaluaciones que 15 (16,10
   * contra 10,31 al dia), porque los alts tienen mucho mas recorrido relativo
   * que BTC.
   */
  decisionInterval: '15m',

  maxTradesPerDay: 8,
  maxConsecutiveLosses: 3,
  lossStreakCooldownMinutes: 120,
  stopCooldownMinutes: 30,
  cooldownMinutes: 15,
  /**
   * El presupuesto de llamadas del dia.
   *
   * Sube de 48 a 300 en el spec 070. El 48 estaba calibrado para un modelo
   * TRESCIENTAS veces mas caro; el de ahora cuesta 0,000081 $ por llamada, o
   * sea que el maximo teorico a 5 min —288 velas al dia— sale por dos centimos
   * y medio al mes. Ademas, medido: el tope nunca se rozo, porque quien limita
   * la cadencia es la puerta de coste y no el presupuesto.
   */
  aiDailyCallBudget: 300,

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

/** Las cadencias que el motor sabe decidir. Sin 1 min: ver `DEFAULTS_TRADER`. */
export const CADENCIAS = ['5m', '15m', '30m', '1h'] as const;
export type Cadencia = (typeof CADENCIAS)[number];

/** Los milisegundos de cada cadencia. */
export const PASO_CADENCIA: Readonly<Record<Cadencia, number>> = {
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
};

export interface ConfigTrader {
  modo: ModoDecision;
  /** Cada cuanto se decide, y de que velas sale la senal. */
  cadencia: Cadencia;
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
    cadencia: enumerado(c['decisionInterval'], [...CADENCIAS], d.decisionInterval),
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
