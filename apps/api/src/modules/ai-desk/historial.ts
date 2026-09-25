import {
  D,
  EstadoPropuestaAgente,
  PROPUESTAS_VIVAS,
  SalidaOperacionAgente,
  planAgenteDe,
} from '@crypton/shared';
import type { HistorialAgente } from '@crypton/strategy-core';

/**
 * Lo operado por un agente, leído de sus propuestas (spec 074): el día UTC en
 * curso, lo vivo, lo pendiente, la racha y los stops recientes por par. Es lo
 * que la herramienta mira para sus límites del día y lo que enseña el detalle.
 *
 * Puro: las filas las lee el servicio, y aquí solo se cuenta.
 */

const DIA_MS = 86_400_000;

/** Una propuesta, con lo que el historial mira de ella. */
export interface FilaHistorial {
  id: string;
  symbol: string;
  state: string;
  plan: unknown;
  final_plan: unknown;
  expires_at: Date;
  decided_at: Date | null;
  opened_at: Date | null;
  closed_at: Date | null;
  exit: string | null;
  realized_pnl: { toString(): string } | null;
}

/** Los estados que se leen para el historial: lo pendiente y lo vivo. */
export const ESTADOS_ACTIVOS: readonly EstadoPropuestaAgente[] = [
  EstadoPropuestaAgente.PROPUESTA,
  ...PROPUESTAS_VIVAS,
];

/** Cuántas cerradas se miran, de la más reciente hacia atrás: la racha no pasa de ahí. */
export const CERRADAS_MIRADAS = 50;

const vivas = new Set<string>(PROPUESTAS_VIVAS);
/** Salidas tras las que el par espera: el stop, y lo que es peor que el stop. */
const TRAS_STOP = new Set<string>([SalidaOperacionAgente.STOP, SalidaOperacionAgente.LIQUIDACION]);
/** Las que ya han entrado en el mercado, o están a punto. */
const ENTRADAS = new Set<string>([EstadoPropuestaAgente.EJECUTANDO, EstadoPropuestaAgente.ABIERTA]);

/** La pérdida al stop de una propuesta: la del plan aprobado, o la del propuesto. */
function riesgoDe(f: FilaHistorial): string {
  return (planAgenteDe(f.final_plan) ?? planAgenteDe(f.plan))?.riesgo ?? '0';
}

const cuando = (f: FilaHistorial): number | null =>
  (f.opened_at ?? f.decided_at ?? f.closed_at)?.getTime() ?? null;

/**
 * El historial de un agente.
 *
 * - `activas`: sus propuestas pendientes y vivas.
 * - `cerradas`: las últimas cerradas, de la más reciente hacia atrás.
 * - `paresDeBots`: los pares de la cuenta con un bot real vivo del usuario
 *   (invariante 11): el agente no puede abrir ahí.
 * - `excluir`: la propuesta que se está aprobando, que no puede contarse a sí
 *   misma como viva mientras se recalcula.
 */
export function historialDe(
  activas: readonly FilaHistorial[],
  cerradas: readonly FilaHistorial[],
  paresDeBots: readonly string[],
  ahora: number,
  excluir: string | null = null,
): HistorialAgente {
  const dia = Math.floor(ahora / DIA_MS) * DIA_MS;
  const mias = activas.filter((f) => f.id !== excluir);
  const vivasAhora = mias.filter((f) => vivas.has(f.state));
  const pendientes = mias.filter(
    (f) => f.state === EstadoPropuestaAgente.PROPUESTA && f.expires_at.getTime() > ahora,
  );

  let riesgoAbierto = D(0);
  for (const f of vivasAhora) riesgoAbierto = riesgoAbierto.plus(riesgoDe(f));

  const deHoy = (f: FilaHistorial): boolean => (cuando(f) ?? 0) >= dia;
  const operacionesHoy =
    vivasAhora.filter((f) => ENTRADAS.has(f.state) && deHoy(f)).length +
    cerradas.filter(deHoy).length;

  let realizadoHoy = D(0);
  for (const f of cerradas) {
    if ((f.closed_at?.getTime() ?? 0) >= dia && f.realized_pnl !== null) {
      realizadoHoy = realizadoHoy.plus(f.realized_pnl.toString());
    }
  }

  // La racha: pérdidas seguidas desde la última cerrada. Un cierre sin
  // resultado conocido —cerrada fuera del bot— no es una pérdida y la corta.
  let rachaPerdidas = 0;
  let ultimaPerdidaEn: number | null = null;
  const porFecha = [...cerradas].sort(
    (a, b) => (b.closed_at?.getTime() ?? 0) - (a.closed_at?.getTime() ?? 0),
  );
  for (const f of porFecha) {
    if (f.realized_pnl === null || !D(f.realized_pnl.toString()).lt(0)) break;
    rachaPerdidas++;
    ultimaPerdidaEn ??= f.closed_at?.getTime() ?? null;
  }

  const ultimoStopEn: Record<string, number> = {};
  for (const f of cerradas) {
    const t = f.closed_at?.getTime();
    if (t === undefined || !f.exit || !TRAS_STOP.has(f.exit)) continue;
    if ((ultimoStopEn[f.symbol] ?? 0) < t) ultimoStopEn[f.symbol] = t;
  }

  // Un par con una operación viva, o con una propuesta esperando, no admite
  // otra: dos propuestas del mismo par a la vez serían dos respuestas a la
  // misma pregunta.
  const ocupados = new Set<string>([
    ...vivasAhora.map((f) => f.symbol),
    ...pendientes.map((f) => f.symbol),
    ...paresDeBots,
  ]);

  return {
    dia,
    operacionesHoy,
    realizadoHoy: realizadoHoy.toFixed(),
    riesgoAbierto: riesgoAbierto.toFixed(),
    vivas: vivasAhora.length,
    pendientes: pendientes.length,
    rachaPerdidas,
    ultimaPerdidaEn,
    ultimoStopEn,
    ocupados: [...ocupados].sort(),
  };
}
