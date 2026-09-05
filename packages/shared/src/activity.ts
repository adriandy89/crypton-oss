/**
 * El resumen de la bitácora de actividad, por acción (spec 007, R-2).
 *
 * `GET /admin/activity/summary` devuelve una fila por (acción, resultado) con su
 * recuento. La pantalla quiere una fila por acción con los tres resultados uno
 * al lado del otro —es lo que se pinta como barra apilada—, ordenada por lo que
 * más pasa. Es aritmética de pantalla y va aquí con test por el precedente de
 * `candle-paging.ts`.
 */

export interface FilaResumenAccion {
  action: string;
  /** OK | DENIED | ERROR, como los escribe `AuditService`. */
  outcome: string;
  count: number;
}

export interface ResumenAccion {
  action: string;
  ok: number;
  denied: number;
  error: number;
  /** Suma de los tres, más cualquier resultado desconocido. */
  total: number;
}

export function resumenPorAccion(filas: readonly FilaResumenAccion[]): ResumenAccion[] {
  const por = new Map<string, ResumenAccion>();
  for (const f of filas) {
    if (!Number.isFinite(f.count) || f.count <= 0) continue;
    const r = por.get(f.action) ?? { action: f.action, ok: 0, denied: 0, error: 0, total: 0 };
    if (f.outcome === 'OK') r.ok += f.count;
    else if (f.outcome === 'DENIED') r.denied += f.count;
    else if (f.outcome === 'ERROR') r.error += f.count;
    r.total += f.count;
    por.set(f.action, r);
  }
  return [...por.values()].sort((a, b) =>
    a.total !== b.total ? b.total - a.total : a.action < b.action ? -1 : 1,
  );
}

/** Lo que NO salió bien, para el interruptor «solo fallos» y para el rótulo del resumen. */
export function fallosDe(resumen: readonly ResumenAccion[]): number {
  return resumen.reduce((n, r) => n + r.denied + r.error, 0);
}
