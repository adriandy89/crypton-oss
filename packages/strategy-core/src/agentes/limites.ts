/**
 * Los límites de un agente (spec 074): los valores de fábrica, la lectura de lo
 * guardado y la validación.
 *
 * Los de fábrica son para dinero real desde el primer día (decisión del usuario
 * del 2026-09-24): prudentes, y todos editables. La validación no juzga si un
 * límite es prudente —eso es del usuario—; rechaza lo que se sale de lo que el
 * motor sabe hacer y las combinaciones que se contradicen.
 */
import {
  D,
  EsquemaObjetivo,
  MAX_APALANCAMIENTO_POR_STOP,
  type LimitesAgente,
  type Venue,
} from '@crypton/shared';
import { costesDe } from '../canal/costes';
import type { ConfigDimensionado } from '../canal/herramienta';

/** Los valores de fábrica. El capital no tiene: lo pone el usuario. */
export const DEFAULTS_AGENTE: Readonly<Omit<LimitesAgente, 'capital'>> = {
  riesgoPct: '0.5',
  perdidaDiariaPct: '2',
  maxVivas: 2,
  maxOperacionesDia: 4,
  apalancamientoMax: 10,
  margenPct: '25',
  maxStopPct: '3',
  maxCosteR: '0.2',
  minObjetivoCoste: 15,
  minObjetivoPct: '0.5',
  minRR: '1.5',
  esperaStopMin: 60,
  maxPerdidasSeguidas: 3,
  esperaRachaMin: 240,
  consultasDia: 120,
  gastoDiaUsd: '5',
  fraccionTp1Pct: '50',
  breakevenTrasTp1: true,
  maxVelasOperacion: 24,
};

// ── Lo que no es del usuario ──────────────────────────────────────────────
//
// Los mismos valores que el canal, que los pagó con incidentes: no son límites
// que el usuario tenga que entender para configurar un agente.

/** El nocional, como mucho cinco veces el capital: el tope de fábrica del canal. */
export const MULTIPLO_NOCIONAL_AGENTE = 5;
/** La liquidación, a tres stops de la entrada como poco: el suelo del canal. */
export const COLCHON_STOPS_AGENTE = 3;
/** La IOC de entrada admite hasta 0,2 R de deslizamiento, como el canal. */
export const MAX_DESLIZAMIENTO_R_AGENTE = '0.2';
/** Sin entradas con el spread por encima de esta fracción del ATR, como el canal. */
export const MAX_SPREAD_ATR_AGENTE = 0.1;
/** Propuestas esperando a una persona, como mucho, por agente. */
export const MAX_PENDIENTES_AGENTE = 2;

type ClaveNumerica = Exclude<keyof LimitesAgente, 'capital' | 'breakevenTrasTp1'>;

/** Lo que el motor sabe hacer, campo a campo. Los extremos entran. */
export const RANGOS_AGENTE: Readonly<Record<ClaveNumerica, readonly [number, number]>> = {
  riesgoPct: [0.05, 5],
  perdidaDiariaPct: [0.1, 20],
  maxVivas: [1, 10],
  maxOperacionesDia: [1, 50],
  apalancamientoMax: [1, MAX_APALANCAMIENTO_POR_STOP],
  margenPct: [1, 100],
  maxStopPct: [0.1, 10],
  maxCosteR: [0.01, 0.9],
  minObjetivoCoste: [1, 100],
  minObjetivoPct: [0, 20],
  minRR: [0.5, 10],
  esperaStopMin: [0, 1440],
  maxPerdidasSeguidas: [1, 20],
  esperaRachaMin: [0, 10_080],
  consultasDia: [0, 1000],
  gastoDiaUsd: [0, 100],
  fraccionTp1Pct: [10, 90],
  maxVelasOperacion: [1, 500],
};

/** Los que son enteros: una cuenta de operaciones o de minutos no tiene decimales. */
const ENTEROS: ReadonlySet<ClaveNumerica> = new Set<ClaveNumerica>([
  'maxVivas',
  'maxOperacionesDia',
  'apalancamientoMax',
  'minObjetivoCoste',
  'esperaStopMin',
  'maxPerdidasSeguidas',
  'esperaRachaMin',
  'consultasDia',
  'maxVelasOperacion',
]);

/** Cómo se llama cada límite en un mensaje, y en el editor de la app: una sola lista. */
export const NOMBRES_LIMITES: Readonly<Record<keyof LimitesAgente, string>> = {
  capital: 'El capital del agente',
  riesgoPct: 'El riesgo por operación (%)',
  perdidaDiariaPct: 'La pérdida diaria (%)',
  maxVivas: 'Las operaciones a la vez',
  maxOperacionesDia: 'Las operaciones al día',
  apalancamientoMax: 'El apalancamiento máximo',
  margenPct: 'El margen por operación (%)',
  maxStopPct: 'El stop máximo (%)',
  maxCosteR: 'El coste máximo (R)',
  minObjetivoCoste: 'El objetivo mínimo (veces el coste)',
  minObjetivoPct: 'El objetivo mínimo (%)',
  minRR: 'El beneficio/riesgo mínimo',
  esperaStopMin: 'La espera tras un stop (min)',
  maxPerdidasSeguidas: 'Las pérdidas seguidas',
  esperaRachaMin: 'La pausa tras la racha (min)',
  consultasDia: 'Las consultas al día',
  gastoDiaUsd: 'El gasto al día (USD)',
  fraccionTp1Pct: 'La parte del primer objetivo (%)',
  breakevenTrasTp1: 'El stop a la entrada tras el primer objetivo',
  maxVelasOperacion: 'La duración máxima (velas)',
};

export interface ErrorLimite {
  campo: keyof LimitesAgente;
  mensaje: string;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Un decimal finito escrito como cadena o número, o null. */
function decimal(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  try {
    const d = D(v);
    return d.isFinite() ? d.toFixed() : null;
  } catch {
    return null;
  }
}

const numero = (v: string | number): number => (typeof v === 'number' ? v : Number(v));

const texto = (x: number): string => x.toLocaleString('es-ES', { maximumFractionDigits: 2 });

/**
 * Los errores de unos límites, vacío si valen. Cada uno dice su campo, para
 * que la app lo enseñe al lado.
 */
export function validarLimites(l: LimitesAgente): ErrorLimite[] {
  const errores: ErrorLimite[] = [];
  const error = (campo: keyof LimitesAgente, mensaje: string) => errores.push({ campo, mensaje });

  const capital = decimal(l.capital);
  if (!capital || !D(capital).gt(0)) {
    error('capital', `${NOMBRES_LIMITES.capital} tiene que ser un importe mayor que cero.`);
  }
  for (const [campo, [min, max]] of Object.entries(RANGOS_AGENTE) as [
    ClaveNumerica,
    readonly [number, number],
  ][]) {
    const bruto = l[campo];
    const valor = decimal(bruto);
    const n = valor === null ? Number.NaN : numero(valor);
    if (!Number.isFinite(n) || n < min || n > max) {
      error(
        campo,
        `${NOMBRES_LIMITES[campo]} tiene que estar entre ${texto(min)} y ${texto(max)}.`,
      );
    } else if (ENTEROS.has(campo) && (typeof bruto !== 'number' || !Number.isInteger(bruto))) {
      error(campo, `${NOMBRES_LIMITES[campo]} tiene que ser un número entero.`);
    }
  }
  if (typeof l.breakevenTrasTp1 !== 'boolean') {
    error('breakevenTrasTp1', `${NOMBRES_LIMITES.breakevenTrasTp1} tiene que ser sí o no.`);
  }
  if (errores.length > 0) return errores;

  // Lo que se contradice. Con los campos ya sueltos en su rango.
  if (D(l.perdidaDiariaPct).lt(l.riesgoPct)) {
    error(
      'perdidaDiariaPct',
      'La pérdida diaria no puede ser menor que el riesgo de una operación: ni la primera cabría.',
    );
  }
  if (l.maxVivas > l.maxOperacionesDia) {
    error('maxVivas', 'No puede haber más operaciones a la vez que operaciones al día.');
  }
  if (D(l.margenPct).mul(l.maxVivas).gt(100)) {
    error(
      'margenPct',
      `Con ${l.maxVivas} operaciones a la vez de un ${l.margenPct} % de margen cada una, ` +
        'harían falta más del 100 % del capital.',
    );
  }
  return errores;
}

/**
 * Los límites guardados, con los de fábrica donde falte algo o no se entienda.
 * La API los validó al guardarlos; esto es la red por si una fila vieja o
 * tocada a mano trae algo raro, y lo raro cae a lo de fábrica, que es lo
 * prudente. El capital no tiene valor de fábrica: sin él, cero, y un agente
 * sin capital no abre nada.
 */
export function leerLimites(v: unknown): LimitesAgente {
  const o = esObjeto(v) ? v : {};
  const d = DEFAULTS_AGENTE;
  const dec = (k: keyof LimitesAgente, def: string): string => decimal(o[k]) ?? def;
  const ent = (k: keyof LimitesAgente, def: number): number => {
    const x = o[k];
    return typeof x === 'number' && Number.isInteger(x) ? x : def;
  };
  return {
    capital: dec('capital', '0'),
    riesgoPct: dec('riesgoPct', d.riesgoPct),
    perdidaDiariaPct: dec('perdidaDiariaPct', d.perdidaDiariaPct),
    maxVivas: ent('maxVivas', d.maxVivas),
    maxOperacionesDia: ent('maxOperacionesDia', d.maxOperacionesDia),
    apalancamientoMax: ent('apalancamientoMax', d.apalancamientoMax),
    margenPct: dec('margenPct', d.margenPct),
    maxStopPct: dec('maxStopPct', d.maxStopPct),
    maxCosteR: dec('maxCosteR', d.maxCosteR),
    minObjetivoCoste: ent('minObjetivoCoste', d.minObjetivoCoste),
    minObjetivoPct: dec('minObjetivoPct', d.minObjetivoPct),
    minRR: dec('minRR', d.minRR),
    esperaStopMin: ent('esperaStopMin', d.esperaStopMin),
    maxPerdidasSeguidas: ent('maxPerdidasSeguidas', d.maxPerdidasSeguidas),
    esperaRachaMin: ent('esperaRachaMin', d.esperaRachaMin),
    consultasDia: ent('consultasDia', d.consultasDia),
    gastoDiaUsd: dec('gastoDiaUsd', d.gastoDiaUsd),
    fraccionTp1Pct: dec('fraccionTp1Pct', d.fraccionTp1Pct),
    breakevenTrasTp1:
      typeof o['breakevenTrasTp1'] === 'boolean' ? o['breakevenTrasTp1'] : d.breakevenTrasTp1,
    maxVelasOperacion: ent('maxVelasOperacion', d.maxVelasOperacion),
  };
}

/**
 * Lo que el dimensionado del canal necesita, desde los límites del agente. Con
 * ello `opcionDeStop` calcula cada opción con las mismas tres garantías que en
 * el canal. Se admiten los tres esquemas de objetivo: la elección es del
 * modelo, y el motor solo quita los que no pagan.
 */
export function dimensionadoDeAgente(l: LimitesAgente, venue: Venue): ConfigDimensionado {
  return {
    capital: D(l.capital),
    riesgoPct: D(l.riesgoPct),
    topeDiarioPct: D(l.perdidaDiariaPct),
    maxStopPct: D(l.maxStopPct),
    costes: costesDe(venue),
    maxCosteR: D(l.maxCosteR),
    esquemas: [EsquemaObjetivo.MEDIA, EsquemaObjetivo.ESCALONADO, EsquemaObjetivo.OPUESTO],
    minObjetivoCoste: l.minObjetivoCoste,
    maxMargenPct: D(l.margenPct),
    colchonStops: COLCHON_STOPS_AGENTE,
    apalancamientoTope: l.apalancamientoMax,
    multiploNocional: D(MULTIPLO_NOCIONAL_AGENTE),
    topeNocional: null,
    minRR: Number(l.minRR),
  };
}

/** Lo peor que puede perder el agente en un día, en la quote: su pérdida diaria. */
export const peorDia = (l: Pick<LimitesAgente, 'capital' | 'perdidaDiariaPct'>): string =>
  D(l.capital).mul(l.perdidaDiariaPct).div(100).toFixed(2);
