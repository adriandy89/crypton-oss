import {
  AccionSeguimiento,
  D,
  EfectoAccion,
  EstadoPropuestaAgente,
  EstadoTesis,
  ModoDecision,
  cambioSeguimientoDe,
  eleccionAgenteDe,
  planAgenteDe,
  rAhora,
  respuestaAgenteDe,
  respuestaSeguimientoDe,
  resultadoHipoteticoDe,
  type AccionVista,
  type BotStatus,
  type ClaseAccion,
  type EstadoAccionAgente,
  type EstadoOperacionAgente,
  type EstadoRondaAgente,
  type FamiliaAgente,
  type OperacionVista,
  type PositionSide,
  type PropuestaVista,
  type RevisionVista,
  type SalidaOperacionAgente,
} from '@crypton/shared';
import {
  leerOperacionAgente,
  type FilaCandidato,
  type FilaPropuesta,
} from '@crypton/strategy-core';

/**
 * De las filas de propuestas, operaciones, acciones y medidas a lo que enseña
 * la app (spec 074). Puro.
 *
 * Vive aparte de `vistas.ts` a propósito: aquí se lee lo MEDIDO —el resultado
 * hipotético, la tarjeta—, y nada de lo que decide (la ronda, la aprobación,
 * el seguimiento) puede importarlo. `nadie-lee-la-medida.spec.ts` lo afirma.
 */

type Decimal = { toString(): string };

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const enLista = <T extends string>(v: unknown, o: Record<string, T>): v is T =>
  (Object.values(o) as unknown[]).includes(v);

/** La columna `side` es un `Direction` de Prisma; una propuesta solo es larga o corta. */
const ladoDe = (side: string): PositionSide => (side === 'SHORT' ? 'SHORT' : 'LONG');

const decimal = (v: Decimal | null): string | null =>
  v === null ? null : D(v.toString()).toFixed();

/** Un R guardado como decimal: estadística, se enseña en `number`. */
const numeroDe = (v: Decimal | null): number | null => {
  if (v === null) return null;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : null;
};

// ── El seguimiento ─────────────────────────────────────────────────────────

const NUMEROS_ESTADO = [
  'rAhora',
  'mfeR',
  'maeR',
  'minutos',
  'fraccionTiempo',
  'stopR',
  'posicionFraccion',
] as const;

/**
 * Cómo iba una operación, desde lo que guardó su ronda de seguimiento; null si
 * no tiene esa forma.
 */
export function estadoOperacionDe(json: unknown): EstadoOperacionAgente | null {
  if (!esObjeto(json)) return null;
  if (!NUMEROS_ESTADO.every((k) => esNumero(json[k]))) return null;
  if (typeof json['tp1Hecho'] !== 'boolean') return null;
  if (json['objetivoR'] !== null && !esNumero(json['objetivoR'])) return null;
  if (!enLista(json['tesis'], EstadoTesis)) return null;
  const motivos = json['motivosTesis'];
  if (!Array.isArray(motivos) || !motivos.every((m) => typeof m === 'string')) return null;
  if (typeof json['regimen'] !== 'string') return null;
  if (json['sentido'] !== null && typeof json['sentido'] !== 'string') return null;
  // Frontera Prisma-JSON: se ha mirado cada campo.
  return json as unknown as EstadoOperacionAgente;
}

const accionDe = (v: unknown): AccionSeguimiento | null =>
  enLista(v, AccionSeguimiento) ? v : null;

/** Una ronda de seguimiento, como la lee el servicio. */
export interface FilaRevision {
  id: string;
  trigger: string;
  state: string;
  reason: string | null;
  decision_mode: string;
  created_at: Date;
  model: string | null;
  cost: Decimal | null;
  decision: unknown;
  snapshot: unknown;
}

/** Lo que el servicio selecciona de una ronda de seguimiento: la forma de `FilaRevision`. */
export const SELECT_REVISION = {
  id: true,
  trigger: true,
  state: true,
  reason: true,
  decision_mode: true,
  created_at: true,
  model: true,
  cost: true,
  decision: true,
  snapshot: true,
} as const;

export function revisionVista(f: FilaRevision): RevisionVista {
  const d = esObjeto(f.decision) ? f.decision : {};
  const vista = esObjeto(f.snapshot) ? f.snapshot : {};
  return {
    id: f.id,
    disparador: f.trigger,
    // Frontera Prisma: la columna calca `EstadoRondaAgente`.
    estado: f.state as EstadoRondaAgente,
    motivo: f.reason,
    modo: f.decision_mode === ModoDecision.REGLAS ? ModoDecision.REGLAS : ModoDecision.IA,
    creadaEn: f.created_at.toISOString(),
    modelo: f.model,
    coste: decimal(f.cost),
    operacion: estadoOperacionDe(vista['estado']),
    accion: accionDe(d['accion']),
    juez: accionDe(d['juez']),
    respuesta: respuestaSeguimientoDe(d['respuesta']),
    fallo: typeof d['fallo'] === 'string' ? d['fallo'] : null,
  };
}

// ── Las acciones ───────────────────────────────────────────────────────────

/** Una acción de seguimiento, como la lee el servicio. */
export interface FilaAccion {
  id: string;
  action: string;
  action_class: string;
  state: string;
  reason: string | null;
  change: unknown;
  decision: unknown;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}

/** Lo que el servicio selecciona de una acción: la forma de `FilaAccion`. */
export const SELECT_ACCION_VISTA = {
  id: true,
  action: true,
  action_class: true,
  state: true,
  reason: true,
  change: true,
  decision: true,
  expires_at: true,
  decided_by: true,
  decided_at: true,
  created_at: true,
} as const;

export function accionVista(f: FilaAccion): AccionVista {
  const d = esObjeto(f.decision) ? f.decision : {};
  const opcion = esObjeto(d['opcion']) ? d['opcion'] : {};
  const cambio = cambioSeguimientoDe(f.change);
  const riesgo = opcion['riesgoRestanteR'];
  return {
    id: f.id,
    // Frontera Prisma: las columnas calcan los enums de shared.
    accion: f.action as AccionSeguimiento,
    clase: f.action_class as ClaseAccion,
    estado: f.state as EstadoAccionAgente,
    motivo: f.reason,
    stopNuevo: cambio?.stopPrice ?? null,
    posicionNueva: cambio?.positionCap ?? null,
    riesgoRestanteR: esNumero(riesgo) ? riesgo : null,
    respuesta: respuestaSeguimientoDe(d['respuesta']),
    caducaEn: f.expires_at.toISOString(),
    decididaPor: f.decided_by,
    decididaEn: f.decided_at?.toISOString() ?? null,
    creadaEn: f.created_at.toISOString(),
  };
}

// ── Las propuestas y sus operaciones ──────────────────────────────────────

/** El bot de una operación, como lo lee el servicio: su último ciclo y su último snapshot. */
export interface FilaBotOperacion {
  status: string;
  cycles: { scratch: unknown; average_entry: Decimal | null }[];
  snapshots: {
    position_qty: Decimal;
    average_entry: Decimal | null;
    mark_price: Decimal;
    /** Realizado más no realizado: resultado, no patrimonio. */
    equity: Decimal;
    taken_at: Date;
  }[];
}

/** Una propuesta, como la lee el servicio. */
export interface FilaPropuestaVista {
  id: string;
  agent_id: string;
  symbol: string;
  family: string;
  side: string;
  state: string;
  reason: string | null;
  plan: unknown;
  final_plan: unknown;
  decision: unknown;
  dry_run: boolean;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  bot_id: string | null;
  opened_at: Date | null;
  closed_at: Date | null;
  exit: string | null;
  realized_pnl: Decimal | null;
  r_real: Decimal | null;
  outcome: unknown;
  measured_at: Date | null;
  created_at: Date;
  agent: { name: string };
  bot: FilaBotOperacion | null;
  /** La última acción del seguimiento. */
  actions: FilaAccion[];
  /** La última ronda de seguimiento que llegó a mirar la operación. */
  followup_rounds: { created_at: Date; snapshot: unknown }[];
}

/** Las que tienen un bot en marcha: lo de ahora sale de su snapshot. */
const VIVAS: readonly string[] = [EstadoPropuestaAgente.EJECUTANDO, EstadoPropuestaAgente.ABIERTA];

/** La operación de una propuesta; null si nunca llegó a tener bot, o ya no lo tiene. */
export function operacionVista(f: FilaPropuestaVista): OperacionVista | null {
  if (!f.bot_id || !f.bot) return null;
  const plan = planAgenteDe(f.final_plan) ?? planAgenteDe(f.plan);
  const ciclo = f.bot.cycles[0];
  const snap = f.bot.snapshots[0];
  // El scratch del ciclo lo escribe el motor; se lee con su lector.
  const op = leerOperacionAgente(esObjeto(ciclo?.scratch) ? ciclo.scratch['op'] : null);
  const viva = VIVAS.includes(f.state);
  const entrada = ciclo?.average_entry?.toString() ?? snap?.average_entry?.toString() ?? null;
  const marca = viva && snap ? snap.mark_price.toString() : null;
  // 1R es lo que se arriesgaba al entrar: el stop con el que se envió la entrada.
  const stopInicial = op?.stopInicial ?? plan?.stop ?? null;
  const revision = f.followup_rounds[0];
  const estado =
    revision && esObjeto(revision.snapshot) ? estadoOperacionDe(revision.snapshot['estado']) : null;
  const ultima = f.actions[0];
  return {
    botId: f.bot_id,
    // Frontera Prisma: las columnas calcan los enums de shared.
    estadoBot: f.bot.status as BotStatus,
    abiertaEn: f.opened_at?.toISOString() ?? null,
    cerradaEn: f.closed_at?.toISOString() ?? null,
    salida: f.exit as SalidaOperacionAgente | null,
    entrada,
    marca,
    posicion: viva && snap ? D(snap.position_qty.toString()).abs().toFixed() : null,
    stop: op?.stop ?? op?.stopInicial ?? null,
    tp1Hecho: op?.tp1Hecho === true,
    r: viva
      ? entrada && marca && stopInicial
        ? rAhora(ladoDe(f.side), entrada, stopInicial, marca)
        : null
      : numeroDe(f.r_real),
    resultado: viva ? (snap ? D(snap.equity.toString()).toFixed() : null) : decimal(f.realized_pnl),
    vistoEn: viva && snap ? snap.taken_at.toISOString() : null,
    revision: revision && estado ? { en: revision.created_at.toISOString(), estado } : null,
    ultimaAccion: ultima ? accionVista(ultima) : null,
  };
}

export function propuestaVista(f: FilaPropuestaVista): PropuestaVista {
  const d = esObjeto(f.decision) ? f.decision : {};
  return {
    id: f.id,
    agenteId: f.agent_id,
    agente: f.agent.name,
    real: !f.dry_run,
    simbolo: f.symbol,
    // Frontera Prisma: las columnas calcan los enums de shared.
    familia: f.family as FamiliaAgente,
    lado: ladoDe(f.side),
    estado: f.state as EstadoPropuestaAgente,
    motivo: f.reason,
    plan: planAgenteDe(f.plan),
    planFinal: planAgenteDe(f.final_plan),
    eleccion: eleccionAgenteDe(d['eleccion']),
    respuesta: respuestaAgenteDe(d['respuesta']),
    efecto: enLista(d['efecto'], EfectoAccion) ? d['efecto'] : null,
    caducaEn: f.expires_at.toISOString(),
    decididaPor: f.decided_by,
    decididaEn: f.decided_at?.toISOString() ?? null,
    creadaEn: f.created_at.toISOString(),
    hipotetico: resultadoHipoteticoDe(f.outcome),
    medidaEn: f.measured_at?.toISOString() ?? null,
    operacion: operacionVista(f),
  };
}

// ── La tarjeta ─────────────────────────────────────────────────────────────

/** Un candidato medido, como lo necesita `tarjetaAgente`. */
export const filaCandidatoDe = (c: {
  eligible: boolean;
  chosen: boolean;
  outcome: unknown;
}): FilaCandidato => ({
  elegible: c.eligible,
  elegido: c.chosen,
  rHipotetico: resultadoHipoteticoDe(c.outcome)?.r ?? null,
});

/** Una propuesta, como la necesita `tarjetaAgente`. */
export const filaPropuestaDe = (p: {
  family: string;
  side: string;
  state: string;
  reason: string | null;
  outcome: unknown;
  r_real: Decimal | null;
  realized_pnl: Decimal | null;
  exit: string | null;
}): FilaPropuesta => ({
  // Frontera Prisma: las columnas calcan los enums de shared.
  familia: p.family as FamiliaAgente,
  lado: ladoDe(p.side),
  estado: p.state as EstadoPropuestaAgente,
  motivo: p.reason,
  rHipotetico: resultadoHipoteticoDe(p.outcome)?.r ?? null,
  rReal: numeroDe(p.r_real),
  resultado: decimal(p.realized_pnl),
  salida: p.exit as SalidaOperacionAgente | null,
});
