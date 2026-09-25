import {
  AiMode,
  D,
  EstadoAgente,
  ModoDecision,
  insigniaAgente,
  type AgenteVista,
  type CuentaAgente,
  type FamiliaAgente,
  type InterruptoresAgentes,
  type IntervaloAgente,
  type MotivoPausaAgente,
  type ParRondaVista,
  type PositionSide,
  type RondaVista,
  type SalidaAgente,
  type Venue,
  EstadoRondaAgente,
  TipoRondaAgente,
  eleccionAgenteDe,
  respuestaAgenteDe,
} from '@crypton/shared';
import { esElegibleAgente, leerLimitesAgente, ofertaAgente } from '@crypton/strategy-core';

/**
 * De las filas de los agentes a lo que enseña la app (spec 074). Puro.
 */

const DIA_MS = 86_400_000;

/** La cuenta de un agente, como la lee el servicio. */
export interface FilaCuentaAgente {
  id: string;
  label: string;
  venue: string;
  paper: boolean;
  testnet: boolean;
}

/** Un agente, como lo lee el servicio. */
export interface FilaAgente {
  id: string;
  name: string;
  state: string;
  pause_reason: string | null;
  symbols: string[];
  interval: string;
  families: string[];
  sides: string[];
  decision_mode: string;
  limits: unknown;
  auto_entry: string;
  auto_reduce: string;
  auto_close: string;
  next_round_at: Date | null;
  failures: number;
  sleeping_until: Date | null;
  last_error: string | null;
  usage_day: Date | null;
  calls_today: number;
  cost_today: { toString(): string };
  version: number;
  created_at: Date;
  archived_at: Date | null;
  exchange_account: FilaCuentaAgente;
}

/** Lo que el servicio selecciona de un agente: la forma de `FilaAgente`. */
export const SELECT_AGENTE = {
  id: true,
  name: true,
  state: true,
  pause_reason: true,
  symbols: true,
  interval: true,
  families: true,
  sides: true,
  decision_mode: true,
  limits: true,
  auto_entry: true,
  auto_reduce: true,
  auto_close: true,
  next_round_at: true,
  failures: true,
  sleeping_until: true,
  last_error: true,
  usage_day: true,
  calls_today: true,
  cost_today: true,
  version: true,
  created_at: true,
  archived_at: true,
  exchange_account: {
    select: { id: true, label: true, venue: true, paper: true, testnet: true },
  },
} as const;

/** Dinero de verdad: ni la cuenta de simulación ni testnet. */
export const esCuentaReal = (c: Pick<FilaCuentaAgente, 'paper' | 'testnet'>): boolean =>
  !c.paper && !c.testnet;

export function cuentaDe(c: FilaCuentaAgente): CuentaAgente {
  return {
    id: c.id,
    nombre: c.label,
    // Frontera Prisma: calca el enum `Venue` de shared.
    venue: c.venue as Venue,
    simulacion: c.paper,
    testnet: c.testnet,
    real: esCuentaReal(c),
  };
}

/** Un `AiMode` guardado, o `OFF` si no lo es: lo prudente. */
const modo = (v: string): AiMode =>
  (Object.values(AiMode) as string[]).includes(v) ? (v as AiMode) : AiMode.OFF;

/** La autonomía de un agente, desde sus tres columnas. */
export const autonomiaDe = (f: Pick<FilaAgente, 'auto_entry' | 'auto_reduce' | 'auto_close'>) => ({
  entrar: modo(f.auto_entry),
  reducir: modo(f.auto_reduce),
  cerrar: modo(f.auto_close),
});

/** Los contadores de uso son de un día UTC: los de otro día cuentan cero. */
function usoDeHoy(f: Pick<FilaAgente, 'usage_day' | 'calls_today' | 'cost_today'>, ahora: number) {
  const deHoy = f.usage_day?.getTime() === Math.floor(ahora / DIA_MS) * DIA_MS;
  return {
    consultasHoy: deHoy ? f.calls_today : 0,
    costeHoy: deHoy ? D(f.cost_today.toString()).toFixed() : '0',
  };
}

export function agenteVista(
  f: FilaAgente,
  cuentas: { vivas: number; pendientes: number; sinCoste: number },
  interruptores: InterruptoresAgentes,
  ahora: number,
): AgenteVista {
  const cuenta = cuentaDe(f.exchange_account);
  const autonomia = autonomiaDe(f);
  // Frontera Prisma: las columnas calcan los enums de shared.
  const estado = f.state as EstadoAgente;
  const modoDecision =
    f.decision_mode === ModoDecision.REGLAS ? ModoDecision.REGLAS : ModoDecision.IA;
  const dormidoHasta = f.sleeping_until?.toISOString() ?? null;
  return {
    id: f.id,
    nombre: f.name,
    estado,
    motivoPausa: estado === EstadoAgente.PAUSADO ? (f.pause_reason as MotivoPausaAgente) : null,
    cuenta,
    pares: [...f.symbols],
    // Frontera Prisma: el servicio valida las cuatro listas al guardarlas.
    intervalo: f.interval as IntervaloAgente,
    familias: f.families as FamiliaAgente[],
    lados: f.sides as PositionSide[],
    modo: modoDecision,
    limites: leerLimitesAgente(f.limits),
    autonomia,
    version: f.version,
    proximaRonda: f.next_round_at?.toISOString() ?? null,
    dormidoHasta,
    fallos: f.failures,
    ultimoError: f.last_error,
    ...usoDeHoy(f, ahora),
    consultasSinCoste: cuentas.sinCoste,
    vivas: cuentas.vivas,
    pendientes: cuentas.pendientes,
    insignia: insigniaAgente(
      interruptores,
      { estado, dormidoHasta, modo: modoDecision, autonomia, real: cuenta.real },
      ahora,
    ),
    creadoEn: f.created_at.toISOString(),
    archivadoEn: f.archived_at?.toISOString() ?? null,
  };
}

// ── Las rondas ─────────────────────────────────────────────────────────────

/** Una ronda, como la lee el servicio. */
export interface FilaRonda {
  id: string;
  kind: string;
  bar_t: Date;
  trigger: string;
  state: string;
  reason: string | null;
  decision_mode: string;
  created_at: Date;
  finished_at: Date | null;
  model: string | null;
  latency_ms: number | null;
  cost: { toString(): string } | null;
  decision: unknown;
  snapshot: unknown;
  proposals: { id: string }[];
}

/** Lo que el servicio selecciona de una ronda: la forma de `FilaRonda`. */
export const SELECT_RONDA_VISTA = {
  id: true,
  kind: true,
  bar_t: true,
  trigger: true,
  state: true,
  reason: true,
  decision_mode: true,
  created_at: true,
  finished_at: true,
  model: true,
  latency_ms: true,
  cost: true,
  decision: true,
  snapshot: true,
  proposals: { select: { id: true }, take: 1 },
} as const;

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Los pares de lo que vio la ronda, con las letras de su oferta. Las letras no
 * se guardan: se vuelven a sacar del mismo snapshot con `ofertaAgente`, que es
 * pura y ordena igual. Un snapshot vaciado por la retención, o con otra forma,
 * no da nada.
 */
export function paresDeRonda(snapshot: unknown): ParRondaVista[] {
  if (!esObjeto(snapshot) || snapshot['version'] !== 1 || !Array.isArray(snapshot['pares'])) {
    return [];
  }
  // Frontera Prisma-JSON: la salida de la herramienta, que escribió la ronda.
  const salida = snapshot as unknown as SalidaAgente;
  let letras = new Map<string, string>();
  try {
    letras = new Map(ofertaAgente(salida).map((p) => [p.candidato.id, p.letra]));
  } catch {
    // Una forma que no se entiende deja las letras vacías, no la vista.
  }
  return salida.pares
    .filter((p) => esObjeto(p) && typeof p.simbolo === 'string')
    .map((p) => ({
      simbolo: p.simbolo,
      descartes: Array.isArray(p.descartes) ? p.descartes.filter((d) => typeof d === 'string') : [],
      candidatos: (Array.isArray(p.candidatos) ? p.candidatos : []).map((c) => ({
        familia: c.familia,
        lado: c.lado,
        elegible: Array.isArray(c.descartes) && Array.isArray(c.stops) && esElegibleAgente(c),
        letra: letras.get(c.id) ?? null,
      })),
    }));
}

export function rondaVista(f: FilaRonda): RondaVista {
  const d = esObjeto(f.decision) ? f.decision : {};
  return {
    id: f.id,
    // Frontera Prisma: las columnas calcan los enums de shared.
    tipo: f.kind as TipoRondaAgente,
    barT: f.bar_t.toISOString(),
    disparador: f.trigger,
    estado: f.state as EstadoRondaAgente,
    motivo: f.reason,
    modo: f.decision_mode === ModoDecision.REGLAS ? ModoDecision.REGLAS : ModoDecision.IA,
    creadaEn: f.created_at.toISOString(),
    terminadaEn: f.finished_at?.toISOString() ?? null,
    modelo: f.model,
    latenciaMs: f.latency_ms,
    coste: f.cost === null ? null : D(f.cost.toString()).toFixed(),
    eleccion: eleccionAgenteDe(d['eleccion']),
    juez: eleccionAgenteDe(d['juez']),
    respuesta: respuestaAgenteDe(d['respuesta']),
    fallo: typeof d['fallo'] === 'string' ? d['fallo'] : null,
    propuestaId: f.proposals[0]?.id ?? null,
    pares: paresDeRonda(f.snapshot),
  };
}
