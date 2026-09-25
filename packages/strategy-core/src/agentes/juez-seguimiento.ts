/**
 * El juez de reglas del seguimiento (spec 074): qué hacer con una operación
 * viva sin preguntar a nadie.
 *
 * Es el modo `REGLAS` del seguimiento y la línea base de la IA, como el juez de
 * entradas. Prudente y corto a propósito: el plan de la operación ya lleva sus
 * salidas nativas —stop, objetivos, stop a la entrada tras el primero y salida
 * por tiempo—, así que el juez solo actúa cuando la idea con la que se entró se
 * ha roto o se ha debilitado con beneficio en juego. Solo elige entre las
 * opciones que se le dan, que ya son las válidas y las permitidas por la
 * autonomía del agente: nunca inventa una.
 */
import {
  AccionSeguimiento,
  EstadoTesis,
  type EstadoOperacionAgente,
  type OpcionSeguimiento,
} from '@crypton/shared';

/** Lo que se hace con una idea rota, del más al menos contundente. */
const SI_ROTA: readonly AccionSeguimiento[] = [
  AccionSeguimiento.CERRAR,
  AccionSeguimiento.ASEGURAR_UN_R,
  AccionSeguimiento.ASEGURAR_MEDIO_R,
  AccionSeguimiento.PROTEGER,
  AccionSeguimiento.REDUCIR_MITAD,
  AccionSeguimiento.REDUCIR_TERCIO,
];

/** Con la idea debilitada y beneficio en juego: asegurar, sin cerrar. */
const SI_DEBIL: readonly AccionSeguimiento[] = [
  AccionSeguimiento.ASEGURAR_MEDIO_R,
  AccionSeguimiento.PROTEGER,
];

/** A partir de qué R a favor se protege lo ganado con la idea debilitada. */
export const R_PARA_ASEGURAR = 1;

/** A partir de qué parte del tiempo máximo se protege la entrada si va a favor. */
export const TIEMPO_PARA_PROTEGER = 0.8;

const primera = (
  orden: readonly AccionSeguimiento[],
  opciones: readonly OpcionSeguimiento[],
): AccionSeguimiento | null => orden.find((a) => opciones.some((o) => o.accion === a)) ?? null;

/** La acción del juez: una de las ofrecidas, y MANTENER si nada lo justifica. */
export function juezSeguimiento(
  estado: EstadoOperacionAgente,
  opciones: readonly OpcionSeguimiento[],
): AccionSeguimiento {
  if (estado.tesis === EstadoTesis.ROTA) {
    return primera(SI_ROTA, opciones) ?? AccionSeguimiento.MANTENER;
  }
  if (estado.tesis === EstadoTesis.DEBILITADA && estado.rAhora >= R_PARA_ASEGURAR) {
    return primera(SI_DEBIL, opciones) ?? AccionSeguimiento.MANTENER;
  }
  if (estado.fraccionTiempo >= TIEMPO_PARA_PROTEGER && estado.rAhora > 0) {
    return primera([AccionSeguimiento.PROTEGER], opciones) ?? AccionSeguimiento.MANTENER;
  }
  return AccionSeguimiento.MANTENER;
}
