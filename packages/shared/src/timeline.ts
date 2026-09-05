/**
 * La cronología de un bot por ciclo (spec 006, R-4).
 *
 * Órdenes, ejecuciones y sucesos llegan de tres endpoints distintos y se pintan
 * en tres listas; la pregunta del operador es una sola: «¿qué pasó en el ciclo
 * 7, en orden?». Aquí se funden. Es una función pura y vive en `shared` por el
 * precedente de `candle-paging.ts`: la app no tiene runner de tests y esto es
 * exactamente lo que puede salir mal en silencio (una orden en el ciclo
 * equivocado, un suceso fuera de sitio).
 *
 * Reglas:
 *
 * · Lo que trae ciclo (`cycleSeq`: órdenes y ejecuciones) va a ese ciclo, exista
 *   o no en la lista de ciclos recibida —el ciclo vivo no está entre los
 *   cerrados y sus órdenes también tienen que verse.
 * · Lo que no lo trae (sucesos) va al ciclo cuya ventana temporal lo contiene:
 *   `desde <= at < hasta`, con `hasta` nulo para el ciclo abierto. Es una
 *   aproximación y la pantalla lo dice.
 * · Lo que no cae en ninguno se agrupa aparte (`seq: null`) y se enseña: callar
 *   una orden o un aviso es la clase de omisión que hace creer que no pasó.
 * · Ciclos de más nuevo a más viejo; dentro de cada uno, en orden temporal.
 */

export type EntradaTipo = 'orden' | 'ejecucion' | 'suceso' | 'configuracion';

export interface EntradaCronologia {
  id: string;
  /** ms desde epoch. */
  at: number;
  tipo: EntradaTipo;
  /** Ciclo declarado por el dato; `null` cuando el dato no lo trae. */
  cycleSeq: number | null;
  titulo: string;
  detalle: string;
  tono: 'up' | 'down' | 'warn' | 'neutral';
}

export interface VentanaCiclo {
  seq: number;
  /** ms desde epoch. */
  desde: number;
  /** ms desde epoch, o `null` si el ciclo sigue abierto. */
  hasta: number | null;
}

export interface CicloCronologia {
  /** `null` = lo que no cae en ningún ciclo. */
  seq: number | null;
  desde: number | null;
  hasta: number | null;
  entradas: EntradaCronologia[];
}

export function cronologiaPorCiclo(
  entradas: readonly EntradaCronologia[],
  ciclos: readonly VentanaCiclo[],
): CicloCronologia[] {
  const ventanas = [...ciclos].sort((a, b) => a.desde - b.desde);
  const grupos = new Map<number | null, CicloCronologia>();
  const grupo = (seq: number | null): CicloCronologia => {
    let g = grupos.get(seq);
    if (!g) {
      const v = seq === null ? undefined : ventanas.find((c) => c.seq === seq);
      g = { seq, desde: v?.desde ?? null, hasta: v?.hasta ?? null, entradas: [] };
      grupos.set(seq, g);
    }
    return g;
  };

  for (const e of entradas) {
    if (!Number.isFinite(e.at)) continue;
    if (e.cycleSeq !== null) {
      grupo(e.cycleSeq).entradas.push(e);
      continue;
    }
    const v = ventanas.find((c) => c.desde <= e.at && (c.hasta === null || e.at < c.hasta));
    grupo(v ? v.seq : null).entradas.push(e);
  }

  for (const g of grupos.values()) g.entradas.sort((a, b) => a.at - b.at);

  return [...grupos.values()].sort((a, b) => {
    if (a.seq === null) return 1;
    if (b.seq === null) return -1;
    return b.seq - a.seq;
  });
}
