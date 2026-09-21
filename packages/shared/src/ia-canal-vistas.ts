import type {
  BacktestOperacionView,
  BacktestSetupMetrics,
  BacktestVentana,
  SalidaOperacion,
} from './backtest';
import {
  BandaApalancamiento,
  CalidadCanal,
  EsquemaObjetivo,
  NivelConfianza,
  RegimenMercado,
  SentidoTendencia,
  TamanoOperacion,
  TipoCanal,
  TipoSetup,
  TipoStop,
  Veredicto,
  type EleccionOperacion,
  type EstadoIntencion,
  type OrigenDecision,
  type ObjetivoPlan,
  type PlanOperacion,
  type RespuestaModeloCanal,
} from './ia-canal';
import { AccionTrader, BucketObjetivo, BucketStop, type VeredictoTrader } from './ia-trader';
import { D } from './money';

/**
 * Lo que el canal con IA enseña fuera del motor (spec 059): el panel de la app,
 * el gráfico y la consola.
 *
 * Todo lo que llega aquí sale de columnas JSON (`cycle.scratch`,
 * `backtest_runs.metrics`), así que cada lector valida la forma y devuelve
 * `null` si no encaja: una pantalla con un dato raro enseña «sin datos», no se
 * rompe ni pinta basura.
 */

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Una cadena que `Decimal` entiende y es finita. */
function esDecimal(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim() === '') return false;
  try {
    return D(v).isFinite();
  } catch {
    return false;
  }
}

const valores = (o: Record<string, string>): readonly string[] => Object.values(o);
const enLista = <T extends string>(v: unknown, lista: readonly string[]): v is T =>
  typeof v === 'string' && lista.includes(v);

// ── El canal en el scratch ─────────────────────────────────────────────────

/** Lo que hace falta para dibujar un canal: los niveles en su referencia y la pendiente. */
export interface LineasCanal {
  tipo: TipoCanal;
  soporte: string;
  resistencia: string;
  media: string;
  /** Desplazamiento por vela de 15 min, en unidades de precio. */
  pendientePorVela: number;
  /** La vela a la que se refieren los niveles. */
  refT: number;
  /** El primer toque: antes de él, el canal no existía. null si no se sabe. */
  desde: number | null;
}

/** Lo que el plan del canal deja en `cycle.scratch.vista` en cada tick en plano. */
export interface VistaCanal {
  /** Apertura de la última vela de 5 min analizada. */
  barT: number;
  regimen: RegimenMercado;
  sentido: SentidoTendencia | null;
  canal: (LineasCanal & { calidad: CalidadCanal }) | null;
}

function lineasDe(v: unknown): LineasCanal | null {
  if (!esObjeto(v)) return null;
  const { tipo, soporte, resistencia, media, pendientePorVela, refT, desde } = v;
  if (!enLista<TipoCanal>(tipo, valores(TipoCanal))) return null;
  if (!esDecimal(soporte) || !esDecimal(resistencia) || !esDecimal(media)) return null;
  if (!esNumero(pendientePorVela) || !esNumero(refT)) return null;
  if (desde !== undefined && desde !== null && !esNumero(desde)) return null;
  return {
    tipo,
    soporte,
    resistencia,
    media,
    pendientePorVela,
    refT,
    desde: esNumero(desde) ? desde : null,
  };
}

/** La vista del canal que dejó el último tick en plano, o null. */
export function vistaCanalDe(scratch: unknown): VistaCanal | null {
  if (!esObjeto(scratch)) return null;
  const v = scratch['vista'];
  if (!esObjeto(v)) return null;
  const { barT, regimen } = v;
  if (!esNumero(barT)) return null;
  if (!enLista<RegimenMercado>(regimen, valores(RegimenMercado))) return null;
  let sentido: SentidoTendencia | null = null;
  const brutoSentido = v['sentido'] ?? null;
  if (brutoSentido !== null) {
    if (!enLista<SentidoTendencia>(brutoSentido, valores(SentidoTendencia))) return null;
    sentido = brutoSentido;
  }
  let canal: VistaCanal['canal'] = null;
  const brutoCanal = v['canal'] ?? null;
  if (brutoCanal !== null) {
    const lineas = lineasDe(brutoCanal);
    const calidad = esObjeto(brutoCanal) ? brutoCanal['calidad'] : undefined;
    if (!lineas) return null;
    if (!enLista<CalidadCanal>(calidad, valores(CalidadCanal))) return null;
    canal = { ...lineas, calidad };
  }
  return { barT, regimen, sentido, canal };
}

/** La operación viva, tal y como se ve desde fuera del motor. */
export interface OperacionCanalVista {
  plan: PlanOperacion;
  enviadaEn: number;
  tp1Hecho: boolean;
  /** El stop en breakeven, si ya se movió. */
  stopBreakeven: string | null;
  lineas: LineasCanal;
}

const esObjetivo = (v: unknown): v is ObjetivoPlan =>
  esObjeto(v) && esDecimal(v['precio']) && esDecimal(v['cantidad']);

/** La operación de `cycle.scratch.op`, o null si no hay o no tiene la forma. */
export function operacionCanalDe(scratch: unknown): OperacionCanalVista | null {
  if (!esObjeto(scratch)) return null;
  const op = scratch['op'];
  if (!esObjeto(op) || !esObjeto(op['plan'])) return null;
  const p = op['plan'];
  const lineas = lineasDe(p['canal']);
  const ok =
    typeof p['intentId'] === 'string' &&
    typeof p['candidatoId'] === 'string' &&
    enLista<TipoSetup>(p['setup'], valores(TipoSetup)) &&
    (p['lado'] === 'LONG' || p['lado'] === 'SHORT') &&
    esDecimal(p['entradaTope']) &&
    esDecimal(p['stop']) &&
    Array.isArray(p['objetivos']) &&
    p['objetivos'].length > 0 &&
    p['objetivos'].every(esObjetivo) &&
    esDecimal(p['cantidad']) &&
    esNumero(p['apalancamiento']) &&
    esDecimal(p['nocional']) &&
    esDecimal(p['riesgo']) &&
    esNumero(p['rNeto']) &&
    esNumero(p['venceEn']) &&
    esNumero(op['enviadaEn']) &&
    lineas !== null;
  if (!ok || !lineas) return null;
  const be = op['stopBreakeven'];
  return {
    // Frontera JSON: se ha comprobado lo que se enseña.
    plan: p as unknown as PlanOperacion,
    enviadaEn: op['enviadaEn'] as number,
    tp1Hecho: op['tp1Hecho'] === true,
    stopBreakeven: esDecimal(be) ? be : null,
    lineas,
  };
}

/** Un punto de una línea del gráfico: el instante de una vela y su nivel. */
export interface PuntoCanal {
  t: number;
  v: number;
}

const QUINCE_MIN = 900_000;

/**
 * Los puntos de las tres líneas del canal en los instantes dados.
 *
 * Solo en velas que ya existen: añadir instantes que el gráfico no tiene
 * abriría huecos en su escala de tiempo. Nada antes del primer toque —dibujar
 * un canal inclinado hacia atrás inventaría un pasado que no tuvo— y nada
 * después de `hasta`.
 *
 * La aritmética es la de `nivelesEn` en el motor: los niveles se desplazan con
 * cada vela de 15 min, y la media es el punto medio. Se hace en `Decimal` y se
 * pasa a número al final, que es lo que pide el gráfico.
 */
export function lineasDelCanal(
  canal: LineasCanal,
  tiempos: readonly number[],
  hasta: number | null = null,
): { soporte: PuntoCanal[]; resistencia: PuntoCanal[]; media: PuntoCanal[] } {
  const soporte: PuntoCanal[] = [];
  const resistencia: PuntoCanal[] = [];
  const media: PuntoCanal[] = [];
  const s0 = D(canal.soporte);
  const r0 = D(canal.resistencia);
  for (const t of tiempos) {
    if (canal.desde !== null && t < canal.desde) continue;
    if (hasta !== null && t > hasta) continue;
    const desplazamiento = D(canal.pendientePorVela)
      .mul(t - canal.refT)
      .div(QUINCE_MIN);
    const s = s0.plus(desplazamiento);
    const r = r0.plus(desplazamiento);
    soporte.push({ t, v: s.toNumber() });
    resistencia.push({ t, v: r.toNumber() });
    media.push({ t, v: s.plus(r).div(2).toNumber() });
  }
  return { soporte, resistencia, media };
}

// ── Las decisiones ─────────────────────────────────────────────────────────

/**
 * La elección guardada en `bot_ai_intents.decision`, si tiene la forma del
 * contrato. La lee el worker para ejecutarla y la consola para enseñarla, y
 * ninguno la da por buena sin mirar: lo que no encaja es «sin elección» y no
 * se opera. Los campos de más —la respuesta del modelo— se ignoran.
 */
export function eleccionDe(json: unknown): EleccionOperacion | null {
  if (!esObjeto(json)) return null;
  const { veredicto, opcion, stop, objetivo, apalancamiento, tamano, confianza } = json;
  if (!enLista<Veredicto>(veredicto, valores(Veredicto))) return null;
  if (typeof opcion !== 'string' || opcion.length === 0) return null;
  if (!enLista<TipoStop>(stop, valores(TipoStop))) return null;
  if (!enLista<EsquemaObjetivo>(objetivo, valores(EsquemaObjetivo))) return null;
  if (!enLista<BandaApalancamiento>(apalancamiento, valores(BandaApalancamiento))) return null;
  if (!enLista<TamanoOperacion>(tamano, valores(TamanoOperacion))) return null;
  if (!enLista<NivelConfianza>(confianza, valores(NivelConfianza))) return null;
  return { veredicto, opcion, stop, objetivo, apalancamiento, tamano, confianza };
}

/**
 * El veredicto del «Bot de IA» guardado en `decision`, o null (spec 069).
 *
 * Hermano de `eleccionDe` y con su misma doctrina: viene de una columna JSON,
 * así que no se da por bueno sin mirar. Lo que no encaja se lee como «sin
 * elección», y sin elección la estrategia no opera — que es exactamente lo que
 * tiene que pasar cuando la respuesta de un proveedor externo llega rara.
 */
export function veredictoDe(json: unknown): VeredictoTrader | null {
  if (!esObjeto(json)) return null;
  const { accion, confianza, acuerdo, stop, objetivo, tamano } = json;
  if (!enLista<AccionTrader>(accion, valores(AccionTrader))) return null;
  if (!enLista<NivelConfianza>(confianza, valores(NivelConfianza))) return null;
  if (typeof acuerdo !== 'boolean') return null;
  if (!enLista<BucketStop>(stop, valores(BucketStop))) return null;
  if (!enLista<BucketObjetivo>(objetivo, valores(BucketObjetivo))) return null;
  if (!enLista<TamanoOperacion>(tamano, valores(TamanoOperacion))) return null;
  return { accion, confianza, acuerdo, stop, objetivo, tamano };
}

/**
 * La respuesta del modelo guardada dentro de `decision`, o null. La escribe la
 * API ya validada; aquí se vuelve a mirar porque viene de una columna JSON.
 */
export function respuestaModeloDe(decision: unknown): RespuestaModeloCanal | null {
  if (!esObjeto(decision) || !esObjeto(decision['respuesta'])) return null;
  const r = decision['respuesta'];
  const textos = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (
    typeof r['veredicto'] !== 'string' ||
    typeof r['opcion'] !== 'string' ||
    typeof r['stop'] !== 'string' ||
    typeof r['objetivo'] !== 'string' ||
    typeof r['apalancamiento'] !== 'string' ||
    typeof r['tamano'] !== 'string' ||
    typeof r['confianza'] !== 'string' ||
    !textos(r['motivos']) ||
    !textos(r['riesgos']) ||
    typeof r['texto'] !== 'string'
  ) {
    return null;
  }
  // Frontera JSON: los campos son cadenas; la app los enseña con su etiqueta o
  // tal cual si no la conoce.
  return r as unknown as RespuestaModeloCanal;
}

/** Lo esencial de un plan, para las listas. */
export interface ResumenPlanCanal {
  lado: 'LONG' | 'SHORT';
  setup: TipoSetup;
  entradaTope: string;
  stop: string;
  objetivos: string[];
  cantidad: string;
  apalancamiento: number;
  riesgo: string;
  rNeto: number;
}

/** Una intención de operación, tal y como la enseñan la consola y la app. */
export interface DecisionCanalVista {
  id: string;
  /** ISO. */
  barT: string;
  creadaEn: string;
  estado: EstadoIntencion;
  origen: OrigenDecision;
  motivo: string | null;
  candidatoId: string | null;
  eleccion: EleccionOperacion | null;
  respuesta: RespuestaModeloCanal | null;
  plan: ResumenPlanCanal | null;
  /** Por qué no respondió el modelo, en una `FALLIDA`: `TIEMPO`, `HTTP`, `CONTRATO`… */
  fallo: string | null;
  modelo: string | null;
  promptVersion: string | null;
  latenciaMs: number | null;
  /** USD, en cadena decimal. */
  coste: string | null;
}

/**
 * Lo que la API guarda en `decision` cuando el modelo no dio una respuesta
 * utilizable: el motivo y, si respondió algo fuera del contrato, un trozo de
 * lo que respondió para poder mirarlo.
 */
export interface FalloGuardado {
  fallo: string;
  bruto?: string;
}

/** El motivo del fallo guardado en `decision`, o null. */
export function falloDe(decision: unknown): string | null {
  if (!esObjeto(decision)) return null;
  const f = decision['fallo'];
  return typeof f === 'string' && f !== '' ? f : null;
}

/** Una decisión con todo lo que vio el modelo. */
export interface DecisionCanalDetalle extends DecisionCanalVista {
  /** La herramienta que calculó el worker (`SalidaHerramienta`), tal cual. */
  herramienta: unknown;
}

/** El resumen del plan guardado, o null si no tiene la forma. */
export function resumenPlanDe(plan: unknown): ResumenPlanCanal | null {
  const op = operacionCanalDe({ op: { plan, enviadaEn: 0 } });
  if (!op) return null;
  const p = op.plan;
  return {
    lado: p.lado,
    setup: p.setup,
    entradaTope: p.entradaTope,
    stop: p.stop,
    objetivos: p.objetivos.map((o) => o.precio),
    cantidad: p.cantidad,
    apalancamiento: p.apalancamiento,
    riesgo: p.riesgo,
    rNeto: p.rNeto,
  };
}

// ── El estado del lazo ─────────────────────────────────────────────────────

/** Los interruptores del servidor para la IA del canal. */
export interface InterruptoresCanal {
  /** `AI_CHANNEL_ENABLE` y la clave del modelo. */
  encendido: boolean;
  modelo: string;
  soloSombra: boolean;
  /** El interruptor global de entradas; `DESCONOCIDO` si Redis no contesta. */
  entradas: 'ABIERTAS' | 'CERRADAS' | 'DESCONOCIDO';
  limiteBot: number;
  limiteGlobal: number;
  /** Llamadas de hoy de toda la plataforma; null si Redis no contesta. */
  llamadasGlobalesHoy: number | null;
}

/** El contador del lazo de un bot (`bot_ai_loops`). */
export interface LazoCanal {
  fallos: number;
  /** ISO, o null si no está en pausa. */
  pausadoHasta: string | null;
  ultimoError: string | null;
  /** Del día UTC en curso: cero si la fila es de otro día. */
  llamadasHoy: number;
  costeHoy: string;
}

export const LAZO_VACIO: LazoCanal = {
  fallos: 0,
  pausadoHasta: null,
  ultimoError: null,
  llamadasHoy: 0,
  costeHoy: '0',
};

/** Lo del día UTC en curso. */
export interface HoyCanal {
  operaciones: number;
  /** Resultado realizado, en la quote. */
  realizado: string;
  /** Pérdida realizada sobre el capital, en %; cero si se va ganando. */
  perdidaPct: number;
  topePct: number;
  topeOperaciones: number;
  rachaPerdidas: number;
  /**
   * Las consultas que le caben HOY a este bot: su presupuesto o el tope del
   * servidor, el que sea menor. Es lo que de verdad aplica el lazo; la pantalla
   * enseñaba solo el del servidor y decía «3 de 48» cuando el bot tenía 12
   * (spec 062, F-45).
   */
  topeConsultas: number;
}

export interface EstadoCanalBot {
  botId: string;
  interruptores: InterruptoresCanal;
  lazo: LazoCanal;
  hoy: HoyCanal;
  decisiones: DecisionCanalVista[];
  /** El modo y las entradas de ESTE bot (spec 062, F-46). */
  propio: EstadoPropioCanal;
}

export interface BotCanalResumen {
  id: string;
  name: string;
  symbol: string;
  venue: string;
  status: string;
  dryRun: boolean;
  lazo: LazoCanal;
  ultima: { estado: EstadoIntencion; motivo: string | null; creadaEn: string } | null;
  /** Lo que decide las entradas de ESTE bot, no del servidor (spec 062, F-46). */
  propio: EstadoPropioCanal;
}

/**
 * Lo del bot que la pastilla necesita mirar además de los interruptores del
 * servidor: en modo reglas no consulta a nadie, y con sus entradas apagadas no
 * va a abrir nada aunque el interruptor global esté abierto (spec 062, F-46).
 */
export interface EstadoPropioCanal {
  modo: 'IA' | 'REGLAS';
  entradas: boolean;
}

export interface ResumenCanalAdmin {
  interruptores: InterruptoresCanal;
  bots: BotCanalResumen[];
}

/** Lo que dice la pastilla de un bot del canal. */
export type InsigniaCanal = 'CONSULTA' | 'SOMBRA' | 'PAUSADA' | 'APAGADA' | 'CORTADA' | 'REGLAS';

/**
 * El estado de la IA para un bot, de lo más grave a lo menos:
 * - `APAGADA`: el servidor no consulta a nadie;
 * - `CORTADA`: el interruptor global cierra las entradas (o no se puede leer);
 * - `PAUSADA`: este bot falló demasiadas veces seguidas;
 * - `SOMBRA`: consulta, pero no ejecuta;
 * - `CONSULTA`: todo en orden.
 */
export function insigniaCanal(
  interruptores: InterruptoresCanal,
  lazo: LazoCanal,
  ahora: number,
  propio?: EstadoPropioCanal,
): InsigniaCanal {
  if (!interruptores.encendido) return 'APAGADA';
  if (interruptores.entradas !== 'ABIERTAS') return 'CORTADA';
  // Las entradas de ESTE bot: apagadas en su configuración no abre nada, esté
  // como esté el interruptor global (spec 062, F-46).
  if (propio?.entradas === false) return 'CORTADA';
  const pausa = lazo.pausadoHasta ? Date.parse(lazo.pausadoHasta) : Number.NaN;
  if (Number.isFinite(pausa) && pausa > ahora) return 'PAUSADA';
  // Y en modo reglas no hay IA que consulte: decide el juez del motor. Decir
  // «IA · canal» ahí era sencillamente falso.
  if (propio?.modo === 'REGLAS') return 'REGLAS';
  if (interruptores.soloSombra) return 'SOMBRA';
  return 'CONSULTA';
}

/**
 * Pérdidas seguidas desde la última operación, con los resultados del más
 * reciente al más antiguo. Un cero no es una pérdida.
 */
export function rachaDePerdidas(resultados: readonly string[]): number {
  let racha = 0;
  while (racha < resultados.length && D(resultados[racha]).lt(0)) racha++;
  return racha;
}

// ── Los backtests guardados ────────────────────────────────────────────────

const SALIDAS: readonly SalidaOperacion[] = ['OBJETIVO', 'STOP', 'CIERRE', 'LIQUIDACION'];

function esSetupMetrics(v: unknown): v is BacktestSetupMetrics {
  return (
    esObjeto(v) &&
    typeof v['setup'] === 'string' &&
    (v['lado'] === 'LONG' || v['lado'] === 'SHORT') &&
    esNumero(v['n']) &&
    esNumero(v['aciertos']) &&
    esNumero(v['wilsonInferior']) &&
    esNumero(v['rMedio']) &&
    esDecimal(v['esperanza']) &&
    (v['factorBeneficio'] === null || esNumero(v['factorBeneficio'])) &&
    esDecimal(v['resultado'])
  );
}

function esVentana(v: unknown): v is BacktestVentana {
  return (
    esObjeto(v) &&
    esNumero(v['desde']) &&
    esNumero(v['hasta']) &&
    esNumero(v['operaciones']) &&
    esDecimal(v['resultado']) &&
    esNumero(v['rTotal']) &&
    Array.isArray(v['porSetup']) &&
    v['porSetup'].every(esSetupMetrics)
  );
}

function esOperacion(v: unknown): v is BacktestOperacionView {
  return (
    esObjeto(v) &&
    typeof v['setup'] === 'string' &&
    (v['lado'] === 'LONG' || v['lado'] === 'SHORT') &&
    esNumero(v['entradaEn']) &&
    esNumero(v['salidaEn']) &&
    esDecimal(v['precioEntrada']) &&
    esDecimal(v['precioSalida']) &&
    esDecimal(v['resultado']) &&
    esNumero(v['r']) &&
    enLista<SalidaOperacion>(v['salida'], SALIDAS)
  );
}

/** Las cifras del canal de un backtest guardado. */
export interface CifrasCanal {
  porSetup: BacktestSetupMetrics[];
  ventanas: BacktestVentana[];
  operaciones: BacktestOperacionView[];
}

/**
 * Las cifras del canal que el backtest guardó dentro de `metrics` (spec 058),
 * o null si ese backtest no las tiene. Una lista con un elemento que no encaja
 * se descarta entera: media tabla es peor que ninguna.
 */
export function cifrasCanalDe(metrics: unknown): CifrasCanal | null {
  if (!esObjeto(metrics)) return null;
  const lista = <T>(v: unknown, es: (x: unknown) => x is T): T[] | null =>
    Array.isArray(v) && v.every(es) ? v : null;
  const porSetup = lista(metrics['porSetup'], esSetupMetrics);
  if (!porSetup) return null;
  return {
    porSetup,
    ventanas: lista(metrics['ventanas'], esVentana) ?? [],
    operaciones: lista(metrics['operaciones'], esOperacion) ?? [],
  };
}
