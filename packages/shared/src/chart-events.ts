/**
 * Qué sucesos de un bot merecen un marcador en el gráfico, y cómo se agrupan
 * (spec 005, R-2).
 *
 * Un market maker escribe cientos de eventos al día; pintarlos todos convierte
 * el gráfico en una nube. Aquí se decide, con test, qué entra y cómo se funde:
 *
 * · Entra todo lo de severidad `WARN` o superior: es lo que se mira cuando algo
 *   no cuadra, y verlo sobre el precio dice si el aviso coincidió con un
 *   movimiento.
 * · Entran cuatro tipos informativos (`SUCESOS_INFORMATIVOS`): los instantes que
 *   explican por qué la escalera de hoy no se parece a la de ayer. Un FILL no:
 *   las ejecuciones ya tienen sus propios marcadores desde el ledger.
 * · Se agrupa por vela y por tono, como las ejecuciones: un marcador por barra
 *   y tono, con la cuenta dentro.
 *
 * La función de cubo se recibe de fuera porque quien conoce las velas cargadas
 * es la pantalla (ver `bucketOf` en `bot-overlay.ts`); esto solo agrupa.
 */

/** Tipos sin gravedad que sí se pintan: cambian la escalera aunque nada haya fallado. */
export const SUCESOS_INFORMATIVOS = [
  'GRID_REANCHORED',
  'SAFETY_ADDED',
  'MARGIN_ADJUSTED',
  'CONFIG_RELOADED',
] as const;

/** `warn` para lo grave, `info` para lo que solo explica. Decide forma y color. */
export type TonoSuceso = 'warn' | 'info';

export interface SucesoFuente {
  type: string;
  severity: string;
  /** ms desde epoch. */
  at: number;
}

export interface GrupoSucesos {
  /** Instante de la vela en la que caen. */
  t: number;
  tono: TonoSuceso;
  /** Tipos distintos que hay dentro, en orden de aparición. */
  tipos: string[];
  count: number;
}

const GRAVES = new Set(['WARN', 'ERROR', 'CRITICAL']);

/** `null` = no se pinta. */
export function tonoDeSuceso(suceso: { type: string; severity: string }): TonoSuceso | null {
  if (GRAVES.has(suceso.severity)) return 'warn';
  return (SUCESOS_INFORMATIVOS as readonly string[]).includes(suceso.type) ? 'info' : null;
}

/**
 * Filtra y agrupa. Sale en orden temporal ascendente —el motor gráfico exige
 * los marcadores así— y, a igual vela, lo grave antes que lo informativo.
 */
export function agruparSucesos(
  sucesos: readonly SucesoFuente[],
  cubo: (at: number) => number,
): GrupoSucesos[] {
  const grupos = new Map<string, GrupoSucesos>();
  for (const s of sucesos) {
    if (!Number.isFinite(s.at)) continue;
    const tono = tonoDeSuceso(s);
    if (!tono) continue;
    const t = cubo(s.at);
    const clave = `${t}|${tono}`;
    const g = grupos.get(clave);
    if (g) {
      g.count += 1;
      if (!g.tipos.includes(s.type)) g.tipos.push(s.type);
    } else {
      grupos.set(clave, { t, tono, tipos: [s.type], count: 1 });
    }
  }
  return [...grupos.values()].sort((a, b) =>
    a.t !== b.t ? a.t - b.t : a.tono === b.tono ? 0 : a.tono === 'warn' ? -1 : 1,
  );
}
