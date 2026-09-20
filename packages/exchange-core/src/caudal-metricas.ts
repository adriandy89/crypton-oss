/**
 * Contadores de espera en el caudal (spec 065).
 *
 * El presupuesto **duerme en vez de fallar**, que es la decisión correcta: un
 * cupo agotado no es una avería y rendirse ahí convertiría una espera en un
 * fallo falso del venue (specs 020/031). Pero deja una degradación invisible —
 * el tick no falla, el cortacircuitos no salta, y el bot aparece «operando» con
 * el latido estirado de quince segundos a un minuto. La única señal era
 * `TICK_SLOW`, que llega cuando el usuario YA ha perdido el ritmo y encima no
 * dice de qué venue ni cuánto fue del presupuesto.
 *
 * Esto se mide aquí, en el sitio donde se duerme, y no en el motor: la espera
 * la comparten todos los bots de esa IP, y atribuírsela a uno sería mentir.
 *
 * Ámbito de PROCESO, como `VenueCooldown`: son sumas sobre números y no cuestan
 * nada en el camino rápido.
 */
import { venueKey, type Venue } from '@crypton/shared';
import type { BudgetPriority } from './venue-budget';

export interface MuestraCaudal {
  /** Cuántas peticiones se concedieron. */
  concesiones: number;
  /** Cuántas de ellas tuvieron que esperar. */
  esperadas: number;
  esperaTotalMs: number;
  esperaMaxMs: number;
  /** Lo más largo que se ha visto la cola desde el último reinicio. */
  colaMax: number;
}

const vacia = (): MuestraCaudal => ({
  concesiones: 0,
  esperadas: 0,
  esperaTotalMs: 0,
  esperaMaxMs: 0,
  colaMax: 0,
});

const CONTADORES = new Map<string, MuestraCaudal>();

/** `HYPERLIQUID|read`, `LIGHTER-testnet|write`… */
export const claveCaudal = (venue: Venue, testnet: boolean, prioridad: BudgetPriority): string =>
  `${venueKey(venue, testnet)}|${prioridad}`;

function de(clave: string): MuestraCaudal {
  let m = CONTADORES.get(clave);
  if (!m) {
    m = vacia();
    CONTADORES.set(clave, m);
  }
  return m;
}

/** Una concesión, con lo que esperó. Cero es lo normal y también se cuenta. */
export function anotarConcesion(clave: string, esperaMs: number): void {
  const m = de(clave);
  m.concesiones++;
  if (esperaMs <= 0) return;
  m.esperadas++;
  m.esperaTotalMs += esperaMs;
  m.esperaMaxMs = Math.max(m.esperaMaxMs, esperaMs);
}

/** Lo larga que está la cola AHORA; se guarda el máximo visto. */
export function anotarCola(clave: string, largo: number): void {
  const m = de(clave);
  m.colaMax = Math.max(m.colaMax, largo);
}

/**
 * Una copia de lo contado. Es copia y no la estructura viva a propósito: quien
 * vigila no puede poder alterar lo que mide.
 */
export function instantaneaDeCaudal(): Map<string, MuestraCaudal> {
  return new Map([...CONTADORES].map(([k, v]) => [k, { ...v }]));
}

/** Lo acumulado por un venue y red, sumando sus prioridades. */
export function caudalDeVenue(venue: Venue, testnet = false): MuestraCaudal {
  const prefijo = `${venueKey(venue, testnet)}|`;
  const total = vacia();
  for (const [clave, m] of CONTADORES) {
    if (!clave.startsWith(prefijo)) continue;
    total.concesiones += m.concesiones;
    total.esperadas += m.esperadas;
    total.esperaTotalMs += m.esperaTotalMs;
    total.esperaMaxMs = Math.max(total.esperaMaxMs, m.esperaMaxMs);
    total.colaMax = Math.max(total.colaMax, m.colaMax);
  }
  return total;
}

/** Solo para los tests: el vigilante usa `consumirVentana`, que no destruye. */
export function reiniciarCaudal(): void {
  CONTADORES.clear();
  PREVIO.clear();
}

/**
 * A partir de aquí duele: es la quinta parte del latido por defecto del motor,
 * así que todavía no hay `TICK_SLOW` y ya se sabe que se va hacia él.
 *
 * Sin exportar a propósito: quien decide si algo duele es `consumirVentana`, y
 * un umbral suelto que nadie lee acaba divergiendo del que se usa de verdad.
 */
const ESPERA_AVISO_MS = 3_000;
/** Y a partir de aquí por cola: si se junta gente, es que el cupo no da. */
const COLA_AVISO = 5;

export interface LineaCaudal {
  clave: string;
  texto: string;
  /** Si merece un aviso o solo una línea de depuración. */
  duele: boolean;
}

/** Lo que llevaba cada clave la última vez que el vigilante miró. */
const PREVIO = new Map<string, MuestraCaudal>();

/**
 * Lo ocurrido desde la última vez que se preguntó, traducido a líneas legibles.
 *
 * Los totales del contador **no se borran**, y esa es la diferencia que importa:
 * el motor mide lo que esperó UN tick restando el total de antes al de después,
 * y un reinicio a mitad de tick le habría dado una resta negativa —o sea, un
 * aviso diciendo que el cupo no tuvo nada que ver justo cuando lo tuvo todo.
 * Aquí se restan deltas y solo se ponen a cero los MÁXIMOS, que por definición
 * son de la ventana.
 *
 * Puro salvo por esa memoria, y compartido a propósito: la decisión de qué duele
 * es la misma en el worker y en la API —comparten depósito, así que mirarlo en
 * uno solo sería ver media historia— y lo único que cambia entre ellos es quién
 * escribe el log.
 */
export function consumirVentana(): LineaCaudal[] {
  const out: LineaCaudal[] = [];
  for (const [clave, m] of CONTADORES) {
    const antes = PREVIO.get(clave) ?? vacia();
    const concesiones = m.concesiones - antes.concesiones;
    const esperadas = m.esperadas - antes.esperadas;
    const esperaTotalMs = m.esperaTotalMs - antes.esperaTotalMs;
    PREVIO.set(clave, { ...m });
    // Los máximos son de la ventana: se leen y se ponen a cero.
    const esperaMaxMs = m.esperaMaxMs;
    const colaMax = m.colaMax;
    m.esperaMaxMs = 0;
    m.colaMax = 0;

    if (concesiones === 0) continue;
    const media = esperadas > 0 ? esperaTotalMs / esperadas : 0;
    out.push({
      clave,
      duele: esperaMaxMs >= ESPERA_AVISO_MS || colaMax >= COLA_AVISO,
      texto:
        `Caudal ${clave}: ${concesiones} peticiones, ${esperadas} esperaron ` +
        `(media ${Math.round(media)} ms, peor ${Math.round(esperaMaxMs)} ms), ` +
        `cola máxima ${colaMax}.`,
    });
  }
  return out;
}
