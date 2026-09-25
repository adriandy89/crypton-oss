import {
  D,
  FAMILIAS_AGENTE,
  type AutonomiaAgente,
  type ErrorAgente,
  type FamiliaAgente,
  type IntervaloAgente,
  type LimitesAgente,
  type ModoDecision,
  type PositionSide,
} from '@crypton/shared';
import { validarLimitesAgente } from '@crypton/strategy-core';

/**
 * La definición de un agente, comprobada antes de guardarla (spec 074, R-9).
 *
 * Los decoradores del DTO miran los tipos y las listas cerradas; aquí se mira
 * lo que depende de más de un campo o del servidor —cuántos pares, repetidos—
 * y los límites, campo a campo, con la misma validación que usa la app. Lo que
 * no se entiende se rechaza: nada se completa con valores de fábrica en
 * silencio, porque detrás hay dinero real.
 */

/** Lo que se guarda de un agente, ya leído del DTO. */
export interface DefinicionAgente {
  nombre: string;
  pares: string[];
  intervalo: IntervaloAgente;
  familias: FamiliaAgente[];
  lados: PositionSide[];
  modo: ModoDecision;
  limites: LimitesAgente;
  autonomia: AutonomiaAgente;
}

/**
 * Lo que no puede llevar un símbolo: los separadores de los temas del bus y de
 * las claves (`:`, `,`, `|`), espacios y caracteres de control. El mismo
 * criterio que `market-stream.service.ts`; quien decide si existe es el
 * catálogo.
 */
// eslint-disable-next-line no-control-regex -- el rango de control está a propósito: rechaza caracteres de control en un símbolo
const SIMBOLO = /^[^\s,:|\u0000-\u001f]{1,32}$/;

const DECIMALES = [
  'capital',
  'riesgoPct',
  'perdidaDiariaPct',
  'margenPct',
  'maxStopPct',
  'maxCosteR',
  'minObjetivoPct',
  'minRR',
  'gastoDiaUsd',
  'fraccionTp1Pct',
] as const satisfies readonly (keyof LimitesAgente)[];

const ENTEROS = [
  'maxVivas',
  'maxOperacionesDia',
  'apalancamientoMax',
  'minObjetivoCoste',
  'esperaStopMin',
  'maxPerdidasSeguidas',
  'esperaRachaMin',
  'consultasDia',
  'maxVelasOperacion',
] as const satisfies readonly (keyof LimitesAgente)[];

const TODAS: readonly string[] = [...DECIMALES, ...ENTEROS, 'breakevenTrasTp1'];

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

export type LecturaLimites =
  { limites: LimitesAgente; errores: [] } | { limites: null; errores: ErrorAgente[] };

/**
 * Los límites tal y como llegan, leídos sin completar nada: tienen que venir
 * todos, con su tipo, y ninguno de más. Luego, la validación de siempre
 * (`validarLimites`): rangos y lo que se contradice.
 */
export function limitesDeEntrada(v: unknown): LecturaLimites {
  const errores: ErrorAgente[] = [];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { limites: null, errores: [{ campo: 'limites', mensaje: 'Faltan los límites.' }] };
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!TODAS.includes(k)) errores.push({ campo: `limites.${k}`, mensaje: 'No es un límite.' });
  }
  const leidos: Record<string, unknown> = {};
  for (const k of DECIMALES) {
    const d = decimal(o[k]);
    if (d === null) errores.push({ campo: `limites.${k}`, mensaje: 'Tiene que ser un número.' });
    else leidos[k] = d;
  }
  for (const k of ENTEROS) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      errores.push({ campo: `limites.${k}`, mensaje: 'Tiene que ser un número entero.' });
    } else {
      leidos[k] = n;
    }
  }
  if (typeof o['breakevenTrasTp1'] !== 'boolean') {
    errores.push({ campo: 'limites.breakevenTrasTp1', mensaje: 'Tiene que ser sí o no.' });
  } else {
    leidos['breakevenTrasTp1'] = o['breakevenTrasTp1'];
  }
  if (errores.length > 0) return { limites: null, errores };

  // Frontera de validación: se acaba de comprobar cada campo, con su tipo.
  const limites = leidos as unknown as LimitesAgente;
  const deDominio = validarLimitesAgente(limites).map((e) => ({
    campo: `limites.${e.campo}`,
    mensaje: e.mensaje,
  }));
  return deDominio.length > 0 ? { limites: null, errores: deDominio } : { limites, errores: [] };
}

/** Lo que depende de más de un campo o del servidor. Vacío si vale. */
export function validarDefinicion(
  d: Pick<DefinicionAgente, 'nombre' | 'pares' | 'familias' | 'lados'>,
  maxPares: number,
): ErrorAgente[] {
  const errores: ErrorAgente[] = [];
  const nombre = d.nombre.trim();
  if (nombre.length === 0 || nombre.length > 64) {
    errores.push({
      campo: 'nombre',
      mensaje: 'El nombre tiene que tener entre 1 y 64 caracteres.',
    });
  }
  if (d.pares.length === 0) {
    errores.push({ campo: 'pares', mensaje: 'Elige al menos un par.' });
  } else if (d.pares.length > maxPares) {
    errores.push({ campo: 'pares', mensaje: `Como mucho ${maxPares} pares por agente.` });
  }
  for (const p of d.pares) {
    if (!SIMBOLO.test(p)) errores.push({ campo: 'pares', mensaje: `«${p}» no es un par.` });
  }
  if (new Set(d.pares).size !== d.pares.length) {
    errores.push({ campo: 'pares', mensaje: 'Hay pares repetidos.' });
  }
  if (d.familias.length === 0 || new Set(d.familias).size !== d.familias.length) {
    errores.push({ campo: 'familias', mensaje: 'Elige una o más familias, sin repetir.' });
  }
  if (d.familias.some((f) => !FAMILIAS_AGENTE.includes(f))) {
    errores.push({ campo: 'familias', mensaje: 'Hay una familia que no existe.' });
  }
  if (d.lados.length === 0 || new Set(d.lados).size !== d.lados.length) {
    errores.push({ campo: 'lados', mensaje: 'Elige largos, cortos o los dos, sin repetir.' });
  }
  return errores;
}
