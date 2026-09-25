/**
 * Operación IA (`AGENT_TRADE`, spec 074): la operación de un agente.
 *
 * Entra UNA vez —una IOC con su tope de precio—, pone su stop nativo y uno o
 * dos objetivos, y se detiene al cerrarse. No decide nada: los números los
 * calculó el motor del agente (`agentes/propuesta.ts`), se recalcularon al
 * aprobar y llegan en la configuración. Lo que hace aquí es sostenerlos:
 *
 * - **Una sola vez (R-1).** Solo se entra en el primer ciclo del bot. Cerrada
 *   la posición, vencida la entrada o invalidada antes de entrar, pide
 *   detenerse; rearrancado a mano, lo vuelve a pedir en su primer tick.
 * - **Stop monótono (R-2).** Con posición, se guarda el más ceñido visto. Una
 *   configuración que lo ensancha se IGNORA —venga del seguimiento o de una
 *   edición a mano— y se avisa.
 * - **Salidas (R-3).** Objetivos reduce-only, stop a la entrada más costes tras
 *   el primero, y un stop que sigue al precio si se pide. Cierre por tiempo y
 *   las salidas de seguridad del canal, que son las mismas funciones.
 * - **Reducir por configuración (R-4).** `positionCap` es un objetivo de nivel:
 *   «la posición, como mucho esto». Aplicarlo dos veces no reduce dos veces.
 * - **Una posición ajena no se toca (R-5).** Se avisa en CRITICAL y el bot se
 *   detiene sin tocarla.
 *
 * La gestión de la posición es la del canal (`operacion/gestion.ts`), pagada
 * con incidentes: no se reescribe.
 */
import {
  D,
  Decimal,
  EventoOperacionAgente,
  LevelKind,
  MAX_APALANCAMIENTO_POR_STOP,
  Mutability,
  StrategyKind,
  maintenanceMarginRateOf,
  mismoValorDeConfig,
  precioLiquidacionAislada,
  tramoDeApalancamiento,
  type AvisoEstrategia,
  type BotConfig,
  type BotContext,
  type CommonBotConfig,
  type DesiredOrder,
  type DesiredState,
  type FieldMeta,
  type MarketSpec,
  type PlanAgente,
  type PreviewResult,
  type ValidationIssue,
  type ValidationResult,
} from '@crypton/shared';
import { costesDe } from '../canal/costes';
import { llegaAlMinimo } from '../canal/herramienta';
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
import {
  ESPERA_ENTRE_CIERRES_MS,
  ESPERA_MAXIMA_LLENADO_MS,
  HOLGURA_LIQUIDACION,
  MAX_INTENTOS_CIERRE,
  cierreAMercado,
  entradaEnCurso,
  leerCierre,
  ordenStop,
  precioBreakeven,
  repartoDeObjetivos,
  salidaDeSeguridad,
  tramosDeSalida,
  type MotivoDeCierre,
} from '../operacion/gestion';
import type { Strategy } from '../types';

export interface AgentTradeConfig extends CommonBotConfig {
  /** El tope de la IOC de entrada: el largo nunca compra más caro, el corto nunca vende más barato. */
  entryLimitPrice: string;
  /** Hasta cuándo puede entrar, en ms. Pasado sin entrar, la operación no entra. */
  entryDeadline: number;
  /** La cantidad de la entrada, en moneda. */
  quantity: string;
  /** La pérdida al stop con costes, en la quote: lo que vale 1R. Solo informa. */
  riskAmount: string;
  /** La propuesta del agente de la que nace. */
  agentProposalId: string;
  stopPrice: string;
  tp1Price: string;
  tp2Price?: string | null;
  /** La parte de la posición que sale en el primer objetivo, en %. */
  tp1Fraction?: string | number;
  breakevenAfterTp1?: boolean;
  /** Tras el primer objetivo, el stop sigue al mejor precio a esta distancia. */
  trailAfterTp1?: boolean;
  trailCallbackPct?: string | number;
  maxHoldMinutes: number;
  /** La posición, como mucho esto. `'0'` es cerrar. Vacío, sin tope. */
  positionCap?: string | null;
}

// ── Constantes ─────────────────────────────────────────────────────────────

/**
 * Las reducciones a mercado van por su propio tramo de índices, `TAKE_PROFIT#100…129`:
 * los objetivos son el 0 y el 1, los cierres de la estrategia del 500 al 511 y el
 * motor reserva del 512 al 999 para los suyos (`bot-runner.ts`). Un índice
 * compartido haría que el aviso de salida contara mal por qué terminó.
 */
export const INDICE_REDUCCION = 100;
/** Reducciones enviadas como mucho en toda la operación, una cada medio minuto. */
export const MAX_REDUCCIONES = 30;
/**
 * No se entra con el precio a menos de medio stop del stop: la operación que
 * se aprobó no era esa. Es la misma media distancia con la que caduca una
 * propuesta al aprobarla (`MOVIMIENTO_MAXIMO_STOPS`).
 */
const ACERCAMIENTO_MAXIMO = D('0.5');
/**
 * Plana tras haber tenido posición, se espera a que el motor barra la
 * ejecución y cierre el ciclo. Pasado esto, la operación se da por cerrada
 * fuera del bot: se detiene sin resultado en vez de esperar para siempre.
 */
export const ESPERA_OPERACION_PERDIDA_MS = 2 * ESPERA_MAXIMA_LLENADO_MS;
/** La última vez que se vio la posición se anota como mucho una vez por minuto. */
const ANOTAR_VISTA_MS = 60_000;

// ── Descriptores ───────────────────────────────────────────────────────────

const campo = (f: Omit<FieldMeta, 'required'> & Partial<FieldMeta>): FieldMeta => ({
  required: false,
  ...f,
});

const COMUNES: FieldMeta[] = [
  // Solo aislado: la pérdida en un hueco se acota con el margen de la operación.
  comunCon('marginMode', { options: ['ISOLATED'], default: 'ISOLATED', control: 'select' }),
  // El de la operación, fijo: cambiarlo con la posición abierta movería la
  // liquidación que se comprobó al aprobarla.
  comunCon('leverage', {
    mutability: Mutability.COLD,
    max: MAX_APALANCAMIENTO_POR_STOP,
    default: 1,
  }),
  comunCon('totalInvestment', {
    mutability: Mutability.COLD,
    labelKey: 'strategy.agentTrade.totalInvestment',
    helpKey: 'strategy.agentTrade.totalInvestmentHelp',
    min: 0,
  }),
  comunCon('liquidationAction', { default: 'CLOSE_ALL' }),
];

const PROPIOS: FieldMeta[] = [
  campo({
    key: 'entryLimitPrice',
    kind: 'price',
    mutability: Mutability.COLD,
    labelKey: 'strategy.agentTrade.entryLimitPrice',
    helpKey: 'strategy.agentTrade.entryLimitPriceHelp',
    required: true,
    min: 0,
    group: 'core',
  }),
  campo({
    key: 'quantity',
    kind: 'number',
    mutability: Mutability.COLD,
    labelKey: 'strategy.agentTrade.quantity',
    helpKey: 'strategy.agentTrade.quantityHelp',
    required: true,
    min: 0,
    group: 'core',
  }),
  campo({
    key: 'riskAmount',
    kind: 'money',
    mutability: Mutability.COLD,
    labelKey: 'strategy.agentTrade.riskAmount',
    helpKey: 'strategy.agentTrade.riskAmountHelp',
    required: true,
    min: 0,
    group: 'risk',
    unit: 'USDC',
  }),
  campo({
    key: 'stopPrice',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.stopPrice',
    helpKey: 'strategy.agentTrade.stopPriceHelp',
    required: true,
    min: 0,
    group: 'risk',
    risky: true,
  }),
  campo({
    key: 'tp1Price',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.tp1Price',
    helpKey: 'strategy.agentTrade.tp1PriceHelp',
    required: true,
    min: 0,
    group: 'levels',
  }),
  campo({
    key: 'tp2Price',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.tp2Price',
    helpKey: 'strategy.agentTrade.tp2PriceHelp',
    min: 0,
    group: 'levels',
  }),
  campo({
    key: 'tp1Fraction',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.tp1Fraction',
    helpKey: 'strategy.agentTrade.tp1FractionHelp',
    min: 10,
    max: 90,
    step: 1,
    default: 50,
    group: 'levels',
    unit: '%',
  }),
  campo({
    key: 'breakevenAfterTp1',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.breakevenAfterTp1',
    helpKey: 'strategy.agentTrade.breakevenAfterTp1Help',
    default: true,
    group: 'risk',
    control: 'toggle',
  }),
  campo({
    key: 'trailAfterTp1',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.trailAfterTp1',
    helpKey: 'strategy.agentTrade.trailAfterTp1Help',
    default: false,
    group: 'risk',
    control: 'toggle',
  }),
  campo({
    key: 'trailCallbackPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.trailCallbackPct',
    helpKey: 'strategy.agentTrade.trailCallbackPctHelp',
    min: 0.1,
    max: 20,
    step: 0.1,
    default: 1,
    group: 'risk',
    unit: '%',
  }),
  campo({
    key: 'positionCap',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.positionCap',
    helpKey: 'strategy.agentTrade.positionCapHelp',
    min: 0,
    group: 'risk',
  }),
  campo({
    key: 'maxHoldMinutes',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.agentTrade.maxHoldMinutes',
    helpKey: 'strategy.agentTrade.maxHoldMinutesHelp',
    min: 1,
    max: 43_200,
    step: 1,
    default: 1440,
    group: 'timing',
    unit: 'min',
  }),
  campo({
    key: 'entryDeadline',
    kind: 'integer',
    mutability: Mutability.COLD,
    labelKey: 'strategy.agentTrade.entryDeadline',
    helpKey: 'strategy.agentTrade.entryDeadlineHelp',
    required: true,
    min: 0,
    group: 'timing',
    advanced: true,
  }),
  campo({
    key: 'agentProposalId',
    kind: 'text',
    mutability: Mutability.COLD,
    labelKey: 'strategy.agentTrade.agentProposalId',
    helpKey: 'strategy.agentTrade.agentProposalIdHelp',
    required: true,
    group: 'core',
    advanced: true,
  }),
];

const META = {
  kind: StrategyKind.AGENT_TRADE,
  labelKey: 'strategy.agentTrade.label',
  descriptionKey: 'strategy.agentTrade.description',
  fields: [...commonFieldsWith(COMUNES), ...PROPIOS],
};

// ── La configuración, leída ────────────────────────────────────────────────

/** Un decimal finito, o null. La configuración viene validada; esto es la red. */
function decimal(v: unknown): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  try {
    const d = D(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

interface Leida {
  largo: boolean;
  entrada: Decimal | null;
  plazo: number;
  cantidad: Decimal | null;
  stop: Decimal | null;
  tp1: Decimal | null;
  tp2: Decimal | null;
  fraccionTp1: Decimal;
  breakeven: boolean;
  seguir: boolean;
  retroceso: Decimal;
  maxMinutos: number;
  tope: Decimal | null;
  apalancamiento: number;
  /** La pérdida al stop declarada, para los avisos. */
  riesgo: Decimal | null;
}

function leer(config: BotConfig): Leida {
  const c = config as Record<string, unknown>;
  const fraccion = decimal(c['tp1Fraction']) ?? D(50);
  const retroceso = decimal(c['trailCallbackPct']) ?? D(1);
  const tope = decimal(c['positionCap']);
  const minutos = Number(c['maxHoldMinutes']);
  const lev = Number(c['leverage']);
  return {
    largo: c['direction'] !== 'SHORT',
    entrada: decimal(c['entryLimitPrice']),
    plazo: Number(c['entryDeadline'] ?? 0),
    cantidad: decimal(c['quantity']),
    stop: decimal(c['stopPrice']),
    tp1: decimal(c['tp1Price']),
    tp2: decimal(c['tp2Price']),
    fraccionTp1: fraccion.div(100),
    breakeven: c['breakevenAfterTp1'] !== false,
    seguir: c['trailAfterTp1'] === true,
    retroceso: retroceso.div(100),
    maxMinutos: Number.isFinite(minutos) && minutos > 0 ? minutos : 1440,
    tope: tope && !tope.isNegative() ? tope : null,
    apalancamiento: Number.isFinite(lev) && lev >= 1 ? Math.floor(lev) : 1,
    riesgo: decimal(c['riskAmount']),
  };
}

// ── El scratch del ciclo ───────────────────────────────────────────────────

/** La operación, tal y como se guarda en `cycle.scratch.op`. */
export interface OperacionAgente {
  /** `n` de `BASE#n`. */
  intento: number;
  enviadaEn: number;
  /** El stop con el que se envió la entrada: el que vale 1R. */
  stopInicial: string;
  /** La mayor posición vista de la operación: de ella salen los tramos. */
  maximo?: string;
  /** Cuándo se vio posición por primera vez: de ahí cuenta el cierre por tiempo. */
  abiertaEn?: number;
  /** La última vez que se vio la posición. */
  vistaEn?: number;
  tp1Hecho?: boolean;
  /** El stop más ceñido visto con la posición abierta: nunca vuelve atrás (R-2). */
  stop?: string;
  /** El tope de posición más bajo visto (R-4). */
  tope?: string;
  /** El mejor precio desde el primer objetivo, para el stop que sigue al precio. */
  mejorPrecio?: string;
  /** Reducciones enviadas: cada una lleva su propio índice. */
  reducciones?: number;
  reduccionEn?: number;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function leerOperacionAgente(v: unknown): OperacionAgente | null {
  if (!esObjeto(v)) return null;
  if (typeof v['intento'] !== 'number' || typeof v['enviadaEn'] !== 'number') return null;
  if (typeof v['stopInicial'] !== 'string') return null;
  // Frontera JSON: se ha mirado lo que no puede faltar; lo opcional se lee con cuidado.
  return v as unknown as OperacionAgente;
}

/** Los objetivos de la configuración, en la retícula y con su parte de la cantidad. */
function objetivosDe(
  market: MarketSpec,
  c: Leida,
  lado: 'BUY' | 'SELL',
): { precio: string; cantidad: string }[] {
  if (!c.tp1 || !c.cantidad) return [];
  const tp1 = px(market, c.tp1, lado);
  if (!c.tp2) return [{ precio: tp1, cantidad: c.cantidad.toFixed() }];
  const primera = c.cantidad.mul(c.fraccionTp1);
  return [
    { precio: tp1, cantidad: primera.toFixed() },
    { precio: px(market, c.tp2, lado), cantidad: c.cantidad.minus(primera).toFixed() },
  ];
}

// ── Terminar ───────────────────────────────────────────────────────────────

function sinEntrada(nota: string, extra: Partial<DesiredState> = {}): DesiredState {
  return { orders: [], immediate: [], note: nota, ...extra };
}

/** La operación ha terminado: el motor detiene el bot sin tocar ninguna posición. */
function detener(
  motivo: string,
  nota: string,
  aviso: AvisoEstrategia | null = null,
  scratchPatch?: Record<string, unknown>,
): DesiredState {
  return {
    orders: [],
    immediate: [],
    note: nota,
    detener: motivo,
    ...(aviso ? { avisos: [aviso] } : {}),
    ...(scratchPatch ? { scratchPatch } : {}),
  };
}

/** Una posición en el par que no es de la operación (R-5): no se toca. */
function posicionAjena(seq: number, qtyPos: Decimal): DesiredState {
  const largo = qtyPos.gt(0);
  const texto =
    `Hay una posición ${largo ? 'larga' : 'corta'} de ${qtyPos.abs().toFixed()} en el par que no ` +
    'es de esta operación: no se toca y el bot se detiene.';
  return detener('POSICION_AJENA', texto, {
    clave: `ajena:${seq}`,
    tipo: EventoOperacionAgente.POSICION_AJENA,
    severidad: 'CRITICAL',
    mensaje: texto,
  });
}

// ── En plano ───────────────────────────────────────────────────────────────

function enPlano(ctx: BotContext, c: Leida, seq: number, op: OperacionAgente | null): DesiredState {
  const patch: Record<string, unknown> = {};
  // Un cierre a medias de la operación ya no significa nada sin posición.
  if (ctx.cycle.scratch['cierre'] !== undefined && ctx.cycle.scratch['cierre'] !== null) {
    patch['cierre'] = null;
  }
  const conPatch = (): Partial<DesiredState> =>
    Object.keys(patch).length > 0 ? { scratchPatch: patch } : {};

  // Una sola vez (R-1): solo se entra en el primer ciclo del bot. Un ciclo
  // cerrado es una operación que ya ocurrió, se viera o no su ejecución.
  if (seq > 1) {
    return detener('CERRADA', 'La operación ha terminado: el bot se detiene.', null, patch);
  }

  // La posición existió y el venue está plano: se cerró, y su ejecución aún no
  // se ha barrido. El motor cerrará el ciclo; si no la ve nunca —se cerró fuera
  // del bot—, se deja de esperar.
  if (op?.maximo !== undefined) {
    const desde = op.vistaEn ?? op.abiertaEn ?? op.enviadaEn;
    if (ctx.now - desde >= ESPERA_OPERACION_PERDIDA_MS) {
      const texto =
        'La posición desapareció sin que el bot viera su cierre: se detiene sin resultado.';
      return detener(
        'FUERA',
        texto,
        {
          clave: `perdida:${seq}`,
          tipo: EventoOperacionAgente.OPERACION_PERDIDA,
          severidad: 'WARN',
          mensaje: texto,
        },
        patch,
      );
    }
    return sinEntrada('La posición ya no está en el venue: esperando su ejecución.', conPatch());
  }

  // ── Una entrada recién enviada ─────────────────────────────────────
  if (op) {
    if (entradaEnCurso(ctx, seq, op)) {
      return sinEntrada('Entrada enviada: esperando a que el venue la confirme.', conPatch());
    }
    // La IOC no se llenó. Se vuelve a intentar en el siguiente tick, mientras
    // la entrada siga valiendo: cada intento con su propio `BASE#n`.
    patch['op'] = null;
    return sinEntrada('La entrada no se llenó dentro de su tope: se reintenta mientras valga.', {
      scratchPatch: patch,
    });
  }

  const nota = (texto: string, codigo: string): DesiredState =>
    detener(
      codigo,
      texto,
      {
        clave: `sin-entrada:${seq}`,
        tipo: EventoOperacionAgente.ENTRADA_DESCARTADA,
        severidad: 'INFO',
        mensaje: texto,
      },
      patch,
    );

  if (ctx.now >= c.plazo) {
    return nota('Pasó el plazo de la entrada sin llenarse: la operación no entra.', 'SIN_ENTRADA');
  }
  if (!c.entrada || !c.cantidad || !c.stop || !c.entrada.gt(0) || !c.cantidad.gt(0)) {
    return sinEntrada('La configuración de la entrada no está completa.', conPatch());
  }
  const largo = c.largo;
  const marca = D(ctx.ticker.mark);
  if (largo ? marca.lte(c.stop) : marca.gte(c.stop)) {
    return nota(
      `El precio llegó al stop (${c.stop.toFixed()}) antes de entrar: la operación ya no vale.`,
      'INVALIDADA',
    );
  }
  const referencia = D(largo ? ctx.ticker.ask : ctx.ticker.bid);
  if (largo ? referencia.gt(c.entrada) : referencia.lt(c.entrada)) {
    return sinEntrada(
      `Esperando precio: el libro está en ${referencia.toFixed()}, más allá del tope ` +
        `${c.entrada.toFixed()}.`,
      conPatch(),
    );
  }
  const distancia = c.entrada.minus(c.stop).abs();
  const hastaStop = largo ? referencia.minus(c.stop) : c.stop.minus(referencia);
  if (hastaStop.lt(distancia.mul(ACERCAMIENTO_MAXIMO))) {
    return sinEntrada(
      'El precio está a menos de medio stop del stop: no se entra tan cerca.',
      conPatch(),
    );
  }
  const limites = ctx.limites;
  if (limites && !limites.venueListo) {
    return sinEntrada(`El venue no está listo: ${limites.motivo ?? 'sin tramos'}.`, conPatch());
  }

  // El apalancamiento de la operación, REBAJADO si el tramo del venue o el tope
  // de la cuenta lo exigen: con menos, la liquidación queda más lejos y la
  // pérdida al stop es la misma. Nunca más del pedido.
  const nocional = c.cantidad.mul(c.entrada);
  const tramo = tramoDeApalancamiento(
    ctx.nivelesApalancamiento ?? [],
    nocional,
    ctx.market.maxLeverage,
    maintenanceMarginRateOf(ctx.market),
  );
  const apalancamiento = Math.max(
    1,
    Math.min(
      c.apalancamiento,
      tramo.maxApalancamiento,
      ctx.market.maxLeverage,
      limites?.maxApalancamientoUsuario ?? c.apalancamiento,
    ),
  );

  const intento = Number(ctx.cycle.scratch['intentos'] ?? 0);
  patch['op'] = {
    intento,
    enviadaEn: ctx.now,
    stopInicial: c.stop.toFixed(),
  } satisfies OperacionAgente;
  patch['intentos'] = intento + 1;
  const lado = largo ? 'BUY' : 'SELL';
  const precio = px(ctx.market, c.entrada, lado);
  const qty = qy(ctx.market, c.cantidad);
  const entrada: DesiredOrder = {
    clientOrderId: makeCoid(ctx.botId, seq, LevelKind.BASE, intento),
    levelKind: LevelKind.BASE,
    levelIndex: intento,
    side: lado,
    type: 'LIMIT',
    timeInForce: 'IOC',
    price: precio,
    qty,
    reduceOnly: false,
  };
  return {
    orders: [entrada],
    immediate: [],
    apalancamiento,
    note:
      `Entrada ${largo ? 'larga' : 'corta'}: ${qty} hasta ${precio} a ${apalancamiento}x, ` +
      `stop ${c.stop.toFixed()}.`,
    scratchPatch: patch,
  };
}

// ── Con posición ───────────────────────────────────────────────────────────

function conPosicion(
  ctx: BotContext,
  c: Leida,
  seq: number,
  opGuardada: OperacionAgente | null,
  qtyPos: Decimal,
): DesiredState {
  const largo = qtyPos.gt(0);
  // Del otro lado, o sin cantidad que gestionar, no es de la operación.
  if (largo !== c.largo || !c.cantidad) return posicionAjena(seq, qtyPos);
  // Sin `op`, la posición es de la operación si el bot llegó a enviar su entrada
  // en este ciclo: la IOC entró, pero el venue tardó en enseñarlo más de lo que
  // la estrategia esperó y la dio por fallida. Tomarla por ajena detenía el bot
  // y dejaba su propia posición sin stop (spec 075, F-01): se reconstruye con el
  // stop de la configuración y se gestiona como cualquier otra.
  const enviadas = Number(ctx.cycle.scratch['intentos'] ?? 0);
  const reconstruida: OperacionAgente | null =
    !opGuardada && seq === 1 && enviadas > 0 && c.stop
      ? { intento: enviadas - 1, enviadaEn: ctx.now, stopInicial: c.stop.toFixed() }
      : null;
  const op = opGuardada ?? reconstruida;
  if (!op) return posicionAjena(seq, qtyPos);

  const { market } = ctx;
  const lado = largo ? 'SELL' : 'BUY';
  const abs = qtyPos.abs();
  const patch: Record<string, unknown> = {};
  const avisos: AvisoEstrategia[] = [];
  let nueva: OperacionAgente = op;
  const cambiar = (cambios: Partial<OperacionAgente>) => {
    nueva = { ...nueva, ...cambios };
    patch['op'] = nueva;
  };
  if (reconstruida) cambiar({});

  // Lo que es de la operación: lo que entró, como mucho. Si el par tiene más
  // —alguien operó a mano en la misma cuenta, o entró una segunda IOC propia
  // porque la primera se vio tarde—, los objetivos no lo tocan, pero el stop sí
  // lo cubre: una posición sin stop no se deja nunca (spec 075, F-01).
  const propia = Decimal.min(abs, c.cantidad);
  const mediaVuelta = D(market.stepSize).div(2);
  if (abs.gt(c.cantidad.plus(market.stepSize))) {
    avisos.push({
      clave: `mayor:${seq}`,
      tipo: EventoOperacionAgente.POSICION_AJENA,
      severidad: 'WARN',
      mensaje:
        `La posición del par (${abs.toFixed()}) es mayor que la de la operación ` +
        `(${c.cantidad.toFixed()}): el stop la cubre entera; los objetivos, solo la suya.`,
    });
  }
  const maximo = Decimal.max(D(op.maximo ?? '0'), propia);
  if (!maximo.eq(op.maximo ?? '0')) cambiar({ maximo: maximo.toFixed() });
  const abiertaEn = op.abiertaEn ?? ctx.now;
  if (op.abiertaEn === undefined) cambiar({ abiertaEn });
  if (op.vistaEn === undefined || ctx.now - op.vistaEn >= ANOTAR_VISTA_MS) {
    cambiar({ vistaEn: ctx.now });
  }

  // El tope de posición (R-4): el más bajo visto. Subirlo después no añade
  // nada —la operación nunca aumenta—, así que se queda el más bajo.
  const topeGuardado = op.tope !== undefined ? D(op.tope) : null;
  let tope = topeGuardado;
  if (c.tope && (!tope || c.tope.lt(tope))) {
    tope = c.tope;
    cambiar({ tope: tope.toFixed() });
  }
  // Los tramos se miden contra lo que la operación puede tener ya: con un tope
  // aplicado, la reducción no es un objetivo cobrado.
  const referencia = tope ? Decimal.min(maximo, tope) : maximo;
  const objetivos = objetivosDe(market, c, lado);
  const tramos =
    objetivos.length > 0
      ? tramosDeSalida(market, { plan: { objetivos, cantidad: c.cantidad.toFixed() } }, referencia)
      : [];
  const tp1Hecho =
    op.tp1Hecho === true ||
    (tramos.length === 2 && propia.lte(referencia.minus(tramos[0].cantidad).plus(mediaVuelta)));
  if (tp1Hecho && op.tp1Hecho !== true) cambiar({ tp1Hecho: true });

  // ── El stop, monótono (R-2) ────────────────────────────────────────
  const marca = D(ctx.ticker.mark);
  const cine = (a: Decimal, b: Decimal): boolean => (largo ? a.gt(b) : a.lt(b));
  const cabe = (s: Decimal): boolean => (largo ? s.lt(marca) : s.gt(marca));
  const guardado = D(op.stop ?? op.stopInicial);
  let stop = guardado;
  let cruzado: Decimal | null = null;
  let cruzadoSiguiendo: Decimal | null = null;
  if (c.stop) {
    if (cine(c.stop, stop)) {
      // Un stop pedido que el precio ya pasó no se coloca: se sale, que es lo
      // que habría hecho el stop.
      if (cabe(c.stop)) {
        stop = c.stop;
        avisos.push({
          clave: `stop:${seq}:${c.stop.toFixed()}`,
          tipo: EventoOperacionAgente.STOP_CENIDO,
          severidad: 'INFO',
          mensaje: `El stop se ciñe a ${c.stop.toFixed()}.`,
        });
      } else {
        cruzado = c.stop;
      }
    } else if (cine(stop, c.stop)) {
      avisos.push({
        clave: `stop-ignorado:${seq}:${c.stop.toFixed()}`,
        tipo: EventoOperacionAgente.STOP_IGNORADO,
        severidad: 'WARN',
        mensaje:
          `La configuración pide el stop en ${c.stop.toFixed()}, más lejos que el vigente ` +
          `(${stop.toFixed()}): se ignora. Con la posición abierta el stop solo se ciñe.`,
      });
    }
  }
  const entradaReal = D(ctx.position?.entryPrice ?? 0).gt(0)
    ? D(ctx.position?.entryPrice ?? 0)
    : (c.entrada ?? marca);
  if (tp1Hecho && c.breakeven) {
    const be = precioBreakeven(market, entradaReal, largo, costesDe(ctx.venue));
    // Un stop del otro lado de la marca saltaría al colocarlo: se espera.
    if (cine(be, stop) && cabe(be)) {
      stop = be;
      avisos.push({
        clave: `breakeven:${seq}`,
        tipo: EventoOperacionAgente.BREAKEVEN,
        severidad: 'INFO',
        mensaje: `Primer objetivo cobrado: el stop pasa a ${be.toFixed()}, la entrada más costes.`,
      });
    }
  }
  if (tp1Hecho && c.seguir) {
    const extremo = ctx.extremos ? D(largo ? ctx.extremos.alto : ctx.extremos.bajo) : marca;
    const previo = op.mejorPrecio !== undefined ? D(op.mejorPrecio) : marca;
    const mejor = largo ? Decimal.max(previo, extremo, marca) : Decimal.min(previo, extremo, marca);
    if (op.mejorPrecio === undefined || !mejor.eq(op.mejorPrecio)) {
      cambiar({ mejorPrecio: mejor.toFixed() });
    }
    const bruto = largo ? mejor.mul(D(1).minus(c.retroceso)) : mejor.mul(D(1).plus(c.retroceso));
    const sigue = D(px(market, bruto, lado));
    // El precio subió y retrocedió más que el retroceso entre dos ticks: el
    // stop que sigue al precio ya habría saltado. Se sale como él.
    if (cine(sigue, stop)) {
      if (cabe(sigue)) stop = sigue;
      else cruzadoSiguiendo = sigue;
    }
  }
  if (!stop.eq(guardado)) cambiar({ stop: stop.toFixed() });
  const precioStop = px(market, stop, lado);
  const orders: DesiredOrder[] = [ordenStop(ctx, seq, lado, precioStop, abs)];

  // La entrada, avisada una vez: el primer tick que ve la posición. Con la
  // posición real —la IOC puede llenarse a medias o mejor que su tope—.
  if (op.abiertaEn === undefined) {
    const lev = ctx.position?.leverage;
    const destinos = objetivos.map((o) => o.precio).join(' / ');
    avisos.push({
      clave: `entrada:${seq}`,
      tipo: EventoOperacionAgente.ENTRADA,
      severidad: 'INFO',
      mensaje:
        `Entrada ${largo ? 'larga' : 'corta'}: ${propia.toFixed()} a ${entradaReal.toFixed()}` +
        `${lev !== undefined && Number.isFinite(lev) ? ` con ${lev}x` : ''}. Stop ${precioStop}` +
        (destinos ? ` · objetivo${objetivos.length > 1 ? 's' : ''} ${destinos}` : '') +
        (c.riesgo ? ` · pérdida al stop ${c.riesgo.toFixed(2)} ${market.quote}` : '') +
        '.',
    });
  }

  // ── Las salidas ────────────────────────────────────────────────────
  const cierrePrevio = leerCierre(ctx.cycle.scratch['cierre']);
  let salida: MotivoDeCierre | null = cierrePrevio
    ? { motivo: cierrePrevio.motivo, mensaje: '' }
    : null;
  if (!salida && cruzado) {
    salida = { motivo: 'STOP', mensaje: `el precio ya pasó el stop pedido (${cruzado.toFixed()})` };
  }
  if (!salida && cruzadoSiguiendo) {
    salida = {
      motivo: 'TRAILING',
      mensaje: `el precio retrocedió más allá del stop que lo seguía (${cruzadoSiguiendo.toFixed()})`,
    };
  }
  if (!salida && tope?.isZero()) {
    salida = { motivo: 'SEGUIMIENTO', mensaje: 'el tope de posición es cero' };
  }
  if (!salida && ctx.now >= abiertaEn + c.maxMinutos * 60_000) {
    salida = { motivo: 'TIEMPO', mensaje: `pasaron ${c.maxMinutos} min` };
  }
  if (!salida && c.entrada) {
    const inicial = D(op.stopInicial);
    const distanciaStop = c.entrada.minus(inicial).abs().div(c.entrada).toNumber();
    salida = salidaDeSeguridad(
      ctx,
      { plan: { distanciaStop, apalancamiento: c.apalancamiento } },
      largo,
      stop,
    );
  }
  const extra = (): Partial<DesiredState> => ({
    scratchPatch: Object.keys(patch).length > 0 ? patch : undefined,
    avisos: avisos.length > 0 ? avisos : undefined,
  });
  if (salida) {
    const r = cierreAMercado(ctx, seq, lado, propia, cierrePrevio, salida.motivo);
    patch['cierre'] = r.cierre;
    if (!cierrePrevio) {
      avisos.push({
        clave: `salida:${seq}`,
        tipo: EventoOperacionAgente.CIERRE,
        severidad: 'INFO',
        mensaje: `Cierre a mercado (${salida.motivo}): ${salida.mensaje}.`,
      });
    }
    if (r.agotado) {
      avisos.push({
        clave: `cierre-agotado:${seq}`,
        tipo: EventoOperacionAgente.CIERRE_FALLIDO,
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
      ...extra(),
    };
  }

  // ── Reducir al tope (R-4) ──────────────────────────────────────────
  const immediate: DesiredOrder[] = [];
  if (tope && propia.gt(tope.plus(mediaVuelta))) {
    const sale = D(qy(market, propia.minus(tope)));
    const n = op.reducciones ?? 0;
    if (!llegaAlMinimo(market, sale, marca)) {
      avisos.push({
        clave: `reduccion-minimo:${seq}:${tope.toFixed()}`,
        tipo: EventoOperacionAgente.REDUCIDA,
        severidad: 'WARN',
        mensaje:
          `Reducir a ${tope.toFixed()} deja una orden de ${sale.toFixed()}, por debajo del mínimo ` +
          'del venue: no se puede. Para cerrar, el tope va a 0.',
      });
    } else if (n >= MAX_REDUCCIONES) {
      avisos.push({
        clave: `reduccion-agotada:${seq}`,
        tipo: EventoOperacionAgente.CIERRE_FALLIDO,
        severidad: 'CRITICAL',
        mensaje: `La reducción a mercado falló ${MAX_REDUCCIONES} veces. La posición sigue con su stop.`,
      });
    } else if (
      op.reduccionEn === undefined ||
      ctx.now - op.reduccionEn >= ESPERA_ENTRE_CIERRES_MS
    ) {
      const indice = INDICE_REDUCCION + n;
      immediate.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, indice),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: indice,
        side: lado,
        type: 'MARKET',
        price: px(market, marca, lado),
        qty: qy(market, sale),
        reduceOnly: true,
      });
      cambiar({ reducciones: n + 1, reduccionEn: ctx.now });
      avisos.push({
        clave: `reduccion:${seq}:${tope.toFixed()}`,
        tipo: EventoOperacionAgente.REDUCIDA,
        severidad: 'INFO',
        mensaje: `Reduciendo la posición a ${tope.toFixed()}.`,
      });
    }
  }

  // ── Los objetivos ──────────────────────────────────────────────────
  // Sobre lo que va a quedar: durante una reducción, los objetivos ya son los
  // del tope, y entre los dos no pasan de la posición.
  const base = tope ? Decimal.min(propia, tope) : propia;
  const pendientes = tp1Hecho ? tramos.slice(1) : tramos;
  for (const { t, cantidad } of repartoDeObjetivos(market, pendientes, base)) {
    if (!cantidad.gt(0)) continue;
    const indice = tramos.indexOf(t);
    orders.push({
      clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, indice),
      levelKind: LevelKind.TAKE_PROFIT,
      levelIndex: indice,
      side: lado,
      type: 'LIMIT',
      timeInForce: 'GTC',
      price: t.precio,
      qty: qy(market, cantidad),
      reduceOnly: true,
    });
  }

  const minutos = Math.max(0, Math.round((abiertaEn + c.maxMinutos * 60_000 - ctx.now) / 60_000));
  const textoObjetivos = pendientes.map((t) => t.precio).join(' / ');
  return {
    orders,
    immediate,
    note:
      `${largo ? 'Largo' : 'Corto'} en marcha. Stop en ${precioStop}` +
      `${stop.eq(guardado) ? '' : ' (ceñido)'}` +
      `${textoObjetivos ? `, objetivo${pendientes.length > 1 ? 's' : ''} ${textoObjetivos}` : ''}. ` +
      `Cierre por tiempo en ${minutos} min.`,
    ...extra(),
  };
}

// ── Lo que usan los agentes ────────────────────────────────────────────────

/**
 * La configuración del bot de una operación, desde su plan: el único sitio
 * donde un plan se vuelve configuración (spec 074, invariante 13). Todo lo que
 * lleva sale del plan, que ya pasó por las garantías de la herramienta; aquí
 * solo se traduce de nombre.
 */
export function configDeOperacion(
  plan: PlanAgente,
  base: { exchangeAccountId: string; agentProposalId: string },
): AgentTradeConfig {
  const [primero, segundo] = plan.objetivos;
  // La parte del primer objetivo, en %: la misma proporción que el plan. La
  // estrategia la vuelve a aplicar sobre lo que de verdad se llenó.
  const fraccion = segundo
    ? D(primero.cantidad).div(plan.cantidad).mul(100).toDecimalPlaces(6).toFixed()
    : '50';
  return {
    exchangeAccountId: base.exchangeAccountId,
    symbol: plan.simbolo,
    direction: plan.lado,
    leverage: plan.apalancamiento,
    marginMode: 'ISOLATED',
    totalInvestment: plan.margen,
    liquidationAction: 'CLOSE_ALL',
    entryLimitPrice: plan.entradaTope,
    entryDeadline: plan.entradaHasta,
    quantity: plan.cantidad,
    riskAmount: plan.riesgo,
    agentProposalId: base.agentProposalId,
    stopPrice: plan.stop,
    tp1Price: primero.precio,
    tp2Price: segundo?.precio ?? null,
    tp1Fraction: fraccion,
    breakevenAfterTp1: plan.breakevenTrasTp1,
    trailAfterTp1: false,
    trailCallbackPct: '1',
    maxHoldMinutes: plan.maxMinutos,
    positionCap: null,
  };
}

/**
 * ¿Solo reduce el riesgo este cambio de configuración? Solo si lo único que
 * cambia es el stop —hacia el precio— o el tope de posición —hacia abajo—. Es
 * la regla del seguimiento (R-22), y la API la aplica a los cambios del agente
 * antes de mandarlos por `updateConfig`.
 */
export function soloReduceRiesgo(anterior: BotConfig, nueva: BotConfig): boolean {
  const a = anterior as Record<string, unknown>;
  const n = nueva as Record<string, unknown>;
  const largo = a['direction'] !== 'SHORT';
  for (const clave of new Set([...Object.keys(a), ...Object.keys(n)])) {
    if (mismoValorDeConfig(a[clave], n[clave])) continue;
    if (clave === 'stopPrice') {
      const antes = decimal(a[clave]);
      const despues = decimal(n[clave]);
      if (!antes || !despues || !despues.gt(0)) return false;
      if (largo ? !despues.gt(antes) : !despues.lt(antes)) return false;
      continue;
    }
    if (clave === 'positionCap') {
      const antes = decimal(a[clave]);
      const despues = decimal(n[clave]);
      if (!despues || despues.isNegative()) return false;
      if (antes && !despues.lt(antes)) return false;
      continue;
    }
    return false;
  }
  return true;
}

// ── La estrategia ──────────────────────────────────────────────────────────

export const agentTrade: Strategy<AgentTradeConfig> = {
  kind: StrategyKind.AGENT_TRADE,
  meta: META,

  // Ni `reusesOrderSlots` ni `keepCycleOnFlat`: cada intento de entrada lleva
  // su `BASE#n` y la fila ejecutada veta repetirlo; el ciclo es la operación.
  stopPropio: true,
  apalancamientoPorOperacion: true,
  reglaLiquidacion: 'POR_STOP',
  nocionalMaximo: (config) => {
    const c = leer(config as unknown as BotConfig);
    return c.cantidad && c.entrada ? c.cantidad.mul(c.entrada).toFixed() : null;
  },
  // La regla del seguimiento (R-22): ceñir el stop o bajar el tope de posición
  // se aplica aunque un tope del usuario haya cambiado después.
  // La configuración tipada es una interfaz sin firma de índice: se lee como la
  // genérica, igual que en `nocionalMaximo`.
  soloReduceRiesgo: (anterior, nueva) =>
    soloReduceRiesgo(anterior as unknown as BotConfig, nueva as unknown as BotConfig),

  defaults() {
    return {
      direction: 'LONG',
      leverage: 1,
      marginMode: 'ISOLATED',
      liquidationAction: 'CLOSE_ALL',
      tp1Fraction: 50,
      breakevenAfterTp1: true,
      trailAfterTp1: false,
      trailCallbackPct: 1,
      maxHoldMinutes: 1440,
    };
  },

  validate(config: AgentTradeConfig, market: MarketSpec): ValidationResult {
    const issues: ValidationIssue[] = validateCommon(config, market, {
      reglaLiquidacion: 'POR_STOP',
    });
    const c = leer(config as unknown as BotConfig);
    if (config.marginMode !== 'ISOLATED') {
      issues.push(
        err('marginMode', 'Solo margen aislado: la pérdida en un hueco se acota con él.'),
      );
    }
    if (config.direction !== 'LONG' && config.direction !== 'SHORT') {
      issues.push(err('direction', 'Una operación es larga o corta.'));
    }
    const { entrada, stop, tp1, tp2, cantidad } = c;
    if (!entrada || !entrada.gt(0)) {
      issues.push(err('entryLimitPrice', 'Falta el tope de precio de la entrada.'));
    }
    if (!stop || !stop.gt(0)) issues.push(err('stopPrice', 'Falta el stop.'));
    if (!tp1 || !tp1.gt(0)) issues.push(err('tp1Price', 'Falta el primer objetivo.'));
    if (!cantidad || !cantidad.gt(0)) {
      issues.push(err('quantity', 'La cantidad tiene que ser mayor que cero.'));
    }
    if (entrada && stop && entrada.gt(0) && stop.gt(0)) {
      if (c.largo ? !stop.lt(entrada) : !stop.gt(entrada)) {
        issues.push(
          err(
            'stopPrice',
            `El stop de un ${c.largo ? 'largo' : 'corto'} va ${c.largo ? 'por debajo' : 'por encima'} de la entrada.`,
          ),
        );
      } else {
        // La liquidación, detrás del stop y con holgura: con menos, la salida
        // de seguridad cerraría la operación nada más abrirla.
        const distancia = entrada.minus(stop).abs().div(entrada);
        const liq = precioLiquidacionAislada(
          entrada,
          c.apalancamiento,
          maintenanceMarginRateOf(market),
          c.largo ? 'LONG' : 'SHORT',
        );
        const holgura = entrada.mul(distancia).mul(HOLGURA_LIQUIDACION);
        const limite = c.largo ? stop.minus(holgura) : stop.plus(holgura);
        if (liq && (c.largo ? liq.gt(limite) : liq.lt(limite))) {
          issues.push(
            err(
              'leverage',
              `A ${c.apalancamiento}x la liquidación (${liq.toFixed(market.priceDecimals)}) queda ` +
                'demasiado cerca del stop.',
            ),
          );
        }
      }
    }
    if (entrada && tp1 && entrada.gt(0) && (c.largo ? !tp1.gt(entrada) : !tp1.lt(entrada))) {
      issues.push(err('tp1Price', 'El primer objetivo va del lado del beneficio.'));
    }
    if (tp1 && tp2 && (c.largo ? !tp2.gt(tp1) : !tp2.lt(tp1))) {
      issues.push(err('tp2Price', 'El segundo objetivo va más allá del primero.'));
    }
    if (cantidad && cantidad.gt(0)) {
      if (!D(qy(market, cantidad)).eq(cantidad)) {
        issues.push(
          err('quantity', `La cantidad no cae en el paso del venue (${market.stepSize}).`),
        );
      } else if (entrada && entrada.gt(0) && !llegaAlMinimo(market, cantidad, entrada)) {
        issues.push(err('quantity', 'La operación no llega al mínimo del venue.'));
      }
    }
    if (c.tope && cantidad && c.tope.gt(cantidad)) {
      issues.push(
        warn('positionCap', 'El tope de posición es mayor que la operación: no reduce nada.'),
      );
    }
    const stopFijo = Number(config.stopLossPct ?? 0);
    if (Number.isFinite(stopFijo) && stopFijo > 0) {
      issues.push(
        warn(
          'stopLossPct',
          'Esta operación lleva su propio stop (`stopPrice`): el stop loss por porcentaje no se usa.',
        ),
      );
    }
    return toResult(issues);
  },

  preview(config: AgentTradeConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const validacion = this.validate(config, market);
    if (!validacion.ok) return invalidPreview(validacion.issues);
    const c = leer(config as unknown as BotConfig);
    // Validada: entrada, stop, objetivo y cantidad existen.
    const entrada = c.entrada ?? D(0);
    const cantidad = c.cantidad ?? D(0);
    const levels: RawLevel[] = [
      {
        index: 0,
        kind: LevelKind.BASE,
        side: c.largo ? 'BUY' : 'SELL',
        price: entrada,
        qty: cantidad,
        margin: cantidad.mul(entrada).div(c.apalancamiento),
        isEntry: true,
      },
    ];
    const objetivos = [c.tp1, c.tp2].filter((x): x is Decimal => x !== null);
    return buildPreview({
      levels,
      market,
      refPrice,
      direction: c.largo ? 'LONG' : 'SHORT',
      leverage: c.apalancamiento,
      marginMode: config.marginMode,
      issues: [
        ...validacion.issues,
        warn(
          null,
          `Operación de una sola vez: entra hasta ${entrada.toFixed()}, stop en ` +
            `${c.stop?.toFixed() ?? '—'} (pérdida al stop ${config.riskAmount}) y ` +
            `objetivo${objetivos.length > 1 ? 's' : ''} ${objetivos.map((o) => o.toFixed()).join(' / ')}. ` +
            'Al cerrarse, el bot se detiene.',
        ),
      ],
    });
  },

  plan(ctx: BotContext): DesiredState {
    const c = leer(ctx.config);
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const op = leerOperacionAgente(ctx.cycle.scratch['op']);
    const qtyPos = ctx.position ? D(ctx.position.qty) : D(0);
    if (!qtyPos.isZero()) return conPosicion(ctx, c, seq, op, qtyPos);
    return enPlano(ctx, c, seq, op);
  },
};
