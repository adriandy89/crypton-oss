import {
  AccionSeguimiento,
  EstadoTesis,
  MotivoSeguimiento,
  NivelConfianza,
  type RespuestaModeloSeguimiento,
} from '@crypton/shared';
import { MAX_TEXTO_AGENTE, recortarSinPartir } from './contrato';

/**
 * El contrato con el modelo para el seguimiento de una operación viva
 * (spec 074, R-22). La doctrina de la entrada: solo enumeraciones, el esquema
 * de CADA ronda solo admite las acciones que el motor ofreció —las válidas en
 * ese momento y permitidas por la autonomía del agente—, y lo que se sale del
 * contrato no se repara. `MANTENER` va siempre, y es la respuesta por defecto.
 */

/** Se sube al tocar el esquema. Va dentro de la versión del prompt. */
export const VERSION_CONTRATO_SEGUIMIENTO = 1;

const valores = <T extends Record<string, string>>(o: T): T[keyof T][] =>
  Object.values(o) as T[keyof T][];

export const CLAVES_SEGUIMIENTO = [
  'accion',
  'tesis',
  'confianza',
  'motivo1',
  'motivo2',
  'motivo3',
  'texto',
] as const;

const enumerado = (lista: readonly string[], description: string) => ({
  type: 'string',
  enum: [...lista],
  description,
});

/** El esquema para las acciones ofrecidas en esta ronda. */
export function esquemaSeguimiento(acciones: readonly AccionSeguimiento[]): {
  name: string;
  schema: Record<string, unknown>;
} {
  const motivos = valores(MotivoSeguimiento);
  return {
    name: 'seguimiento_agente',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [...CLAVES_SEGUIMIENTO],
      properties: {
        accion: enumerado(
          acciones,
          'Una de las acciones ofrecidas. Ante la duda, MANTENER: las salidas ya están puestas.',
        ),
        tesis: enumerado(valores(EstadoTesis), 'Cómo ves la idea con la que se entró.'),
        confianza: enumerado(valores(NivelConfianza), 'Tu confianza en la acción.'),
        motivo1: enumerado(motivos, 'Tu motivo principal.'),
        motivo2: enumerado(motivos, 'Otro motivo, o NINGUNO.'),
        motivo3: enumerado(motivos, 'Otro motivo, o NINGUNO.'),
        texto: {
          type: 'string',
          description:
            'Una frase en español, de 200 caracteres como mucho y SIN cifras: los números los ' +
            'calcula el sistema.',
        },
      },
    },
  };
}

const en = <T extends string>(v: unknown, lista: readonly string[]): v is T =>
  typeof v === 'string' && lista.includes(v);

/** La respuesta del modelo, validada contra las acciones de ESTA ronda, o null. */
export function parseSeguimiento(
  raw: string,
  acciones: readonly AccionSeguimiento[],
): RespuestaModeloSeguimiento | null {
  let datos: unknown;
  try {
    datos = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) return null;
  const o = datos as Record<string, unknown>;
  const claves = Object.keys(o);
  const esperadas: readonly string[] = CLAVES_SEGUIMIENTO;
  if (claves.length !== esperadas.length || !esperadas.every((k) => k in o)) return null;

  const { accion, tesis, confianza, texto } = o;
  if (!en<AccionSeguimiento>(accion, acciones)) return null;
  if (!en<EstadoTesis>(tesis, valores(EstadoTesis))) return null;
  if (!en<NivelConfianza>(confianza, valores(NivelConfianza))) return null;
  if (typeof texto !== 'string') return null;
  const motivos: MotivoSeguimiento[] = [];
  for (const k of ['motivo1', 'motivo2', 'motivo3']) {
    const m = o[k];
    if (!en<MotivoSeguimiento>(m, valores(MotivoSeguimiento))) return null;
    if (m !== MotivoSeguimiento.NINGUNO && !motivos.includes(m)) motivos.push(m);
  }
  return {
    accion,
    tesis,
    confianza,
    motivos,
    texto: recortarSinPartir(texto.trim(), MAX_TEXTO_AGENTE),
  };
}

/**
 * La acción que se hace: la elegida, salvo con confianza BAJA, que es mantener.
 * Cambiar una operación viva con dudas es peor que dejar que sus salidas
 * nativas hagan su trabajo.
 */
export function accionEfectiva(r: RespuestaModeloSeguimiento): AccionSeguimiento {
  return r.confianza === NivelConfianza.BAJA ? AccionSeguimiento.MANTENER : r.accion;
}
