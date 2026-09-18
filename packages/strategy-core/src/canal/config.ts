/**
 * La configuración del canal, leída y tipada una sola vez (spec 058).
 *
 * `DEFAULTS_CANAL` es la ÚNICA fuente de los valores por defecto. La usan
 * `meta.fields`, `defaults()` y este lector, y así no pueden discrepar: la
 * batería genérica lo exige, y un valor por defecto distinto en el formulario y
 * en el motor sería un bot que no hace lo que dice.
 */
import {
  CalidadCanal,
  D,
  Decimal,
  EsquemaObjetivo,
  ModoDecision,
  PerfilCanal,
  TipoCanal,
  TipoSetup,
  type BotConfig,
  type Venue,
} from '@crypton/shared';
import { costesDe, type Costes } from './costes';

/** Valores por defecto, con las claves de `meta.fields`. */
export const DEFAULTS_CANAL = {
  direction: 'NEUTRAL',
  leverage: 25,
  marginMode: 'ISOLATED',
  structureInterval: '15m',
  decisionMode: 'IA',
  aiProfile: 'AGRESIVA',
  entriesEnabled: true,
  observeOnly: false,
  riskPerTradePct: '1',
  maxMarginPct: '25',
  maxNotionalMultiple: '5',
  liqBufferStops: 3,
  maxStopPct: '1.5',
  minRewardRisk: '1.2',
  maxEntrySlippageR: '0.2',
  maxSpreadFraction: '0.1',
  maxDailyLossPct: '6',
  maxTradesPerDay: 8,
  maxConsecutiveLosses: 3,
  lossStreakCooldownMinutes: 120,
  stopCooldownMinutes: 30,
  cooldownMinutes: 15,
  dailyProfitTargetPct: '0',
  maxDrawdownPct: '15',
  aiDailyCallBudget: 48,
  takeProfitSchemes: 'TODOS',
  tp1Fraction: '60',
  breakevenAfterTp1: true,
  maxHoldBars: 24,
  invalidationAtr: '0.35',
  liquidationAction: 'CLOSE_ALL',
  allowedSetups: 'REBOTE',
  allowedChannels: 'TODOS',
  slopedWithTrendOnly: true,
  channelWindowBars: 96,
  minChannelQuality: 'B',
  minConfirmations: 2,
  requireEvidence: 'NO',
  minAiConfidence: 'MEDIA',
  maxAdverseFundingBps: '1',
  fundingBlackoutMinutes: 10,
} as const;

export type EvidenciaMinima = 'NO' | 'DEBIL' | 'MODERADA';

/** Una ventana UTC sin entradas, en minutos del día. `desde > hasta` cruza la medianoche. */
export interface VentanaUtc {
  desde: number;
  hasta: number;
}

export interface ConfigCanal {
  direccion: 'LONG' | 'SHORT' | 'NEUTRAL';
  intervaloEstructura: '15m' | '5m';
  modo: ModoDecision;
  perfil: PerfilCanal;
  entradasActivas: boolean;
  soloObservar: boolean;

  capital: Decimal;
  apalancamientoTope: number;
  riesgoPct: Decimal;
  maxMargenPct: Decimal;
  multiploNocional: Decimal;
  topeNocional: Decimal | null;
  colchonStops: number;
  maxStopPct: Decimal;
  minRR: number;
  maxDeslizamientoR: Decimal;
  maxSpreadFraccion: number;
  costes: Costes;

  topeDiarioPct: Decimal;
  maxOperacionesDia: number;
  maxPerdidasSeguidas: number;
  esperaRachaMin: number;
  esperaStopMin: number;
  esperaMin: number;
  objetivoDiarioPct: Decimal;
  maxCaidaPct: Decimal;
  presupuestoIaDia: number;

  esquemas: EsquemaObjetivo[];
  fraccionTp1: Decimal;
  breakeven: boolean;
  maxVelasOperacion: number;
  invalidacionAtr: number;

  setups: TipoSetup[];
  canales: TipoCanal[];
  inclinadoSoloAFavor: boolean;
  ventanaCanal: number;
  calidadMinima: CalidadCanal;
  minConfirmaciones: number;
  evidenciaMinima: EvidenciaMinima;
  confianzaMinima: 'MEDIA' | 'ALTA';

  maxFundingBps: number;
  apagonFundingMin: number;
  /** null = mal formadas: el motor no abre nada con una ventana que no entiende. */
  ventanasSinEntradas: VentanaUtc[] | null;
}

const texto = (v: unknown, def: string): string =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : def;

const decimal = (v: unknown, def: string): Decimal => {
  if (v === null || v === undefined || v === '') return D(def);
  try {
    const d = D(typeof v === 'number' || typeof v === 'string' ? v : def);
    return d.isFinite() ? d : D(def);
  } catch {
    return D(def);
  }
};

const entero = (v: unknown, def: number): number => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? Math.trunc(n) : def;
};

const booleano = (v: unknown, def: boolean): boolean =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : def;

/**
 * Como `booleano`, pero lo que no se entiende cae al lado SEGURO en vez de al
 * valor por defecto.
 *
 * `validate` ya rechaza lo que no sea un booleano, así que esto es la red por
 * si una configuración guardada antes lo lleva: un `observeOnly: 1` hacía
 * operar de verdad al bot que su dueño había dejado en «solo observar», y un
 * `entriesEnabled: 'si'` lo dejaba abriendo (spec 062, F-23). Ausente sigue
 * siendo «no dicho» y se queda con su valor por defecto.
 */
const booleanoSeguro = (v: unknown, def: boolean, seguro: boolean): boolean => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v === undefined || v === null || v === '' ? def : seguro;
};

const enumerado = <T extends string>(v: unknown, opciones: readonly T[], def: T): T => {
  const s = texto(v, def);
  return (opciones as readonly string[]).includes(s) ? (s as T) : def;
};

/**
 * `HH:MM-HH:MM` separadas por comas. Devuelve `null` si alguna está mal
 * formada: la validación la rechaza, y el motor no opera con una ventana que
 * no entiende.
 */
export function leerVentanas(v: unknown): VentanaUtc[] | null {
  if (v === null || v === undefined || v === '') return [];
  if (typeof v !== 'string') return null;
  const ventanas: VentanaUtc[] = [];
  for (const trozo of v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(trozo);
    if (!m) return null;
    const desde = Number(m[1]) * 60 + Number(m[2]);
    const hasta = Number(m[3]) * 60 + Number(m[4]);
    if (desde === hasta) return null;
    ventanas.push({ desde, hasta });
  }
  return ventanas.length <= 6 ? ventanas : null;
}

/** ¿Cae `ahora` en alguna ventana sin entradas? */
export function enVentanaSinEntradas(ventanas: readonly VentanaUtc[], ahora: number): boolean {
  const d = new Date(ahora);
  const minuto = d.getUTCHours() * 60 + d.getUTCMinutes();
  return ventanas.some((w) =>
    w.desde < w.hasta
      ? minuto >= w.desde && minuto < w.hasta
      : minuto >= w.desde || minuto < w.hasta,
  );
}

export function leerConfig(cfg: BotConfig, venue: Venue): ConfigCanal {
  const c = cfg as Record<string, unknown>;
  const d = DEFAULTS_CANAL;
  const esquema = enumerado(
    c['takeProfitSchemes'],
    ['TODOS', 'MEDIA', 'ESCALONADO', 'OPUESTO'],
    d.takeProfitSchemes,
  );
  const setup = enumerado(
    c['allowedSetups'],
    ['REBOTE', 'FALSO_QUIEBRE', 'TODOS'],
    d.allowedSetups,
  );
  const canal = enumerado(
    c['allowedChannels'],
    ['TODOS', 'HORIZONTAL', 'INCLINADO'],
    d.allowedChannels,
  );
  const tope = decimal(c['maxNotionalCap'], '0');
  return {
    direccion: enumerado(c['direction'], ['LONG', 'SHORT', 'NEUTRAL'], d.direction),
    intervaloEstructura: enumerado(c['structureInterval'], ['15m', '5m'], d.structureInterval),
    modo: enumerado(c['decisionMode'], [ModoDecision.IA, ModoDecision.REGLAS], d.decisionMode),
    perfil: enumerado(
      c['aiProfile'],
      [PerfilCanal.PRUDENTE, PerfilCanal.EQUILIBRADA, PerfilCanal.AGRESIVA],
      d.aiProfile,
    ),
    entradasActivas: booleanoSeguro(c['entriesEnabled'], d.entriesEnabled, false),
    soloObservar: booleanoSeguro(c['observeOnly'], d.observeOnly, true),

    capital: decimal(c['totalInvestment'], '0'),
    apalancamientoTope: entero(c['leverage'], d.leverage),
    riesgoPct: decimal(c['riskPerTradePct'], d.riskPerTradePct),
    maxMargenPct: decimal(c['maxMarginPct'], d.maxMarginPct),
    multiploNocional: decimal(c['maxNotionalMultiple'], d.maxNotionalMultiple),
    topeNocional: tope.gt(0) ? tope : null,
    colchonStops: Math.max(3, entero(c['liqBufferStops'], d.liqBufferStops)),
    maxStopPct: decimal(c['maxStopPct'], d.maxStopPct),
    minRR: decimal(c['minRewardRisk'], d.minRewardRisk).toNumber(),
    maxDeslizamientoR: decimal(c['maxEntrySlippageR'], d.maxEntrySlippageR),
    maxSpreadFraccion: decimal(c['maxSpreadFraction'], d.maxSpreadFraction).toNumber(),
    costes: costesDe(venue, c),

    topeDiarioPct: decimal(c['maxDailyLossPct'], d.maxDailyLossPct),
    maxOperacionesDia: entero(c['maxTradesPerDay'], d.maxTradesPerDay),
    maxPerdidasSeguidas: entero(c['maxConsecutiveLosses'], d.maxConsecutiveLosses),
    esperaRachaMin: entero(c['lossStreakCooldownMinutes'], d.lossStreakCooldownMinutes),
    esperaStopMin: entero(c['stopCooldownMinutes'], d.stopCooldownMinutes),
    esperaMin: entero(c['cooldownMinutes'], d.cooldownMinutes),
    objetivoDiarioPct: decimal(c['dailyProfitTargetPct'], d.dailyProfitTargetPct),
    maxCaidaPct: decimal(c['maxDrawdownPct'], d.maxDrawdownPct),
    presupuestoIaDia: entero(c['aiDailyCallBudget'], d.aiDailyCallBudget),

    esquemas:
      esquema === 'TODOS'
        ? [EsquemaObjetivo.MEDIA, EsquemaObjetivo.ESCALONADO, EsquemaObjetivo.OPUESTO]
        : [esquema],
    fraccionTp1: decimal(c['tp1Fraction'], d.tp1Fraction).div(100),
    breakeven: booleano(c['breakevenAfterTp1'], d.breakevenAfterTp1),
    maxVelasOperacion: entero(c['maxHoldBars'], d.maxHoldBars),
    invalidacionAtr: decimal(c['invalidationAtr'], d.invalidationAtr).toNumber(),

    setups: setup === 'TODOS' ? [TipoSetup.REBOTE, TipoSetup.FALSO_QUIEBRE] : [setup],
    canales: canal === 'TODOS' ? [TipoCanal.HORIZONTAL, TipoCanal.INCLINADO] : [canal],
    inclinadoSoloAFavor: booleano(c['slopedWithTrendOnly'], d.slopedWithTrendOnly),
    ventanaCanal: entero(c['channelWindowBars'], d.channelWindowBars),
    calidadMinima: enumerado(
      c['minChannelQuality'],
      [CalidadCanal.A, CalidadCanal.B, CalidadCanal.C],
      d.minChannelQuality,
    ),
    minConfirmaciones: entero(c['minConfirmations'], d.minConfirmations),
    evidenciaMinima: enumerado(
      c['requireEvidence'],
      ['NO', 'DEBIL', 'MODERADA'],
      d.requireEvidence,
    ),
    confianzaMinima: enumerado(c['minAiConfidence'], ['MEDIA', 'ALTA'], d.minAiConfidence),

    maxFundingBps: decimal(c['maxAdverseFundingBps'], d.maxAdverseFundingBps).toNumber(),
    apagonFundingMin: entero(c['fundingBlackoutMinutes'], d.fundingBlackoutMinutes),
    ventanasSinEntradas: leerVentanas(c['noEntryWindowsUtc']),
  };
}
