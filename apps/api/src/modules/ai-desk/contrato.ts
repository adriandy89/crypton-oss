import {
  BandaApalancamiento,
  ESQUEMA_DE_OBJETIVO,
  MotivoAgente,
  MotivoRonda,
  NivelConfianza,
  OPCION_NINGUNA,
  ObjetivoAgente,
  RiesgoAgente,
  TamanoOperacion,
  TipoStop,
  eleccionEfectiva,
  type EleccionAgente,
  type RespuestaModeloAgente,
} from '@crypton/shared';
import type { PuestoOferta } from '@crypton/strategy-core';

/**
 * El contrato con el modelo para elegir una entrada en una ronda de un agente
 * (spec 074, R-14). La doctrina es la del canal (spec 059), y aquí pesa igual:
 *
 *   **El modelo no emite números.** Elige con enumeraciones entre operaciones
 *   que el motor ya calculó dentro de los límites del dueño. El esquema no
 *   lleva ni un `number` ni un `minimum`: una barandilla numérica sería real
 *   con un proveedor y decorativa con otro. Lo único que acota igual en todos
 *   es `enum`.
 *
 *   **El modelo no ve ids.** La oferta lleva letras (`A`, `B`…) y el esquema de
 *   CADA ronda solo admite las de su oferta, más `NINGUNA`, que es la respuesta
 *   por defecto.
 *
 *   **No se repara nada.** Una respuesta fuera del contrato no es de fiar
 *   entera, y cuenta como fallo del modelo.
 *
 * Hay un test que recorre el esquema y falla si aparece un número, una
 * restricción numérica o un objeto abierto.
 */

/** Se sube al tocar el esquema. Va dentro de la versión del prompt. */
export const VERSION_CONTRATO_AGENTE = 1;

/** Largo máximo del texto del modelo. Se recorta aquí sin fiarse de que obedezca. */
export const MAX_TEXTO_AGENTE = 200;

const valores = <T extends Record<string, string>>(o: T): T[keyof T][] =>
  Object.values(o) as T[keyof T][];

/** Todas las claves de la respuesta, en el orden del esquema. */
export const CLAVES_ENTRADA = [
  'opcion',
  'stop',
  'objetivo',
  'apalancamiento',
  'tamano',
  'confianza',
  'motivo1',
  'motivo2',
  'motivo3',
  'riesgo1',
  'riesgo2',
  'texto',
] as const;

const enumerado = (lista: readonly string[], description: string) => ({
  type: 'string',
  enum: [...lista],
  description,
});

/**
 * El esquema de la respuesta para una oferta concreta.
 *
 * Todas las claves van en `required` y el objeto es cerrado: un campo opcional
 * o un `oneOf` rompe el modo estricto en unos proveedores y en otros no. Por
 * eso, con `NINGUNA`, los demás campos también llevan valor; se ignoran.
 */
export function esquemaEntrada(letras: readonly string[]): {
  name: string;
  schema: Record<string, unknown>;
} {
  const motivos = valores(MotivoAgente);
  const riesgos = valores(RiesgoAgente);
  return {
    name: 'decision_agente',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [...CLAVES_ENTRADA],
      properties: {
        opcion: enumerado(
          [...letras, OPCION_NINGUNA],
          'La letra de la operación elegida, o NINGUNA. Ante la duda, NINGUNA.',
        ),
        stop: enumerado(valores(TipoStop), 'Uno de los stops disponibles de esa operación.'),
        objetivo: enumerado(
          valores(ObjetivoAgente),
          'Uno de los objetivos disponibles para ese stop.',
        ),
        apalancamiento: enumerado(valores(BandaApalancamiento), 'Una de las bandas de ese stop.'),
        tamano: enumerado(
          valores(TamanoOperacion),
          'COMPLETO o MEDIO. Con confianza por debajo de ALTA se ejecuta MEDIO.',
        ),
        confianza: enumerado(valores(NivelConfianza), 'Tu confianza en la operación.'),
        motivo1: enumerado(motivos, 'Tu motivo principal.'),
        motivo2: enumerado(motivos, 'Otro motivo, o NINGUNO.'),
        motivo3: enumerado(motivos, 'Otro motivo, o NINGUNO.'),
        riesgo1: enumerado(riesgos, 'Lo que más te preocupa, o NINGUNO.'),
        riesgo2: enumerado(riesgos, 'Otra preocupación, o NINGUNO.'),
        texto: {
          type: 'string',
          description:
            'Una frase en español, de 200 caracteres como mucho y SIN cifras: los números los ' +
            'calcula el sistema y pueden no coincidir con los que imaginas.',
        },
      },
    },
  };
}

/**
 * Recorta sin dejar medio par sustituto: el texto viaja a Telegram, y un
 * sustituto suelto hace que rechace el mensaje entero (spec 056, R-7).
 */
export function recortarSinPartir(texto: string, max: number): string {
  const corte = texto.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(corte) ? corte.slice(0, -1) : corte;
}

const en = <T extends string>(v: unknown, lista: readonly string[]): v is T =>
  typeof v === 'string' && lista.includes(v);

/** Una lista sin relleno ni repetidos, en su orden. */
function sinRelleno<T extends string>(lista: T[], relleno: T): T[] {
  return lista.filter((x, i) => x !== relleno && lista.indexOf(x) === i);
}

/**
 * La respuesta del modelo, validada contra el contrato de ESTA oferta, o null.
 *
 * Se valida aunque el modo estricto prometa que no hace falta: la promesa la
 * cumple el proveedor, y el proveedor lo elige el enrutador.
 */
export function parseEntrada(raw: string, letras: readonly string[]): RespuestaModeloAgente | null {
  let datos: unknown;
  try {
    datos = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) return null;
  const o = datos as Record<string, unknown>;

  // Exactamente las claves del contrato: ni una de menos ni una de más.
  const claves = Object.keys(o);
  const esperadas: readonly string[] = CLAVES_ENTRADA;
  if (claves.length !== esperadas.length || !esperadas.every((k) => k in o)) return null;

  const { opcion, stop, objetivo, apalancamiento, tamano, confianza, texto } = o;
  if (!en<string>(opcion, [...letras, OPCION_NINGUNA])) return null;
  if (!en<TipoStop>(stop, valores(TipoStop))) return null;
  if (!en<ObjetivoAgente>(objetivo, valores(ObjetivoAgente))) return null;
  if (!en<BandaApalancamiento>(apalancamiento, valores(BandaApalancamiento))) return null;
  if (!en<TamanoOperacion>(tamano, valores(TamanoOperacion))) return null;
  if (!en<NivelConfianza>(confianza, valores(NivelConfianza))) return null;
  if (typeof texto !== 'string') return null;

  const motivos: MotivoAgente[] = [];
  for (const k of ['motivo1', 'motivo2', 'motivo3']) {
    const m = o[k];
    if (!en<MotivoAgente>(m, valores(MotivoAgente))) return null;
    motivos.push(m);
  }
  const riesgos: RiesgoAgente[] = [];
  for (const k of ['riesgo1', 'riesgo2']) {
    const r = o[k];
    if (!en<RiesgoAgente>(r, valores(RiesgoAgente))) return null;
    riesgos.push(r);
  }
  return {
    opcion,
    stop,
    objetivo,
    apalancamiento,
    tamano,
    confianza,
    motivos: sinRelleno(motivos, MotivoAgente.NINGUNO),
    riesgos: sinRelleno(riesgos, RiesgoAgente.NINGUNO),
    // Lo único del modelo que ve una persona tal cual: texto ajeno.
    texto: recortarSinPartir(texto.trim(), MAX_TEXTO_AGENTE),
  };
}

export type ResultadoEleccion =
  | { eleccion: EleccionAgente; puesto: PuestoOferta; motivo: null }
  | { eleccion: null; puesto: null; motivo: MotivoRonda };

/**
 * De la respuesta a la elección que se ejecuta, o por qué no hay ninguna.
 *
 * Mira lo mismo que mirará el generador —que la operación esté en la oferta y
 * lo elegido esté disponible— y aplica la confianza: con BAJA no se opera,
 * que es lo que el prompt le pide; por debajo de ALTA se ejecuta la mitad.
 */
export function validarEntrada(
  r: RespuestaModeloAgente,
  oferta: readonly PuestoOferta[],
): ResultadoEleccion {
  const no = (motivo: MotivoRonda): ResultadoEleccion => ({
    eleccion: null,
    puesto: null,
    motivo,
  });
  if (r.opcion === OPCION_NINGUNA || r.confianza === NivelConfianza.BAJA) {
    return no(MotivoRonda.NINGUNA);
  }
  const puesto = oferta.find((p) => p.letra === r.opcion);
  if (!puesto) return no(MotivoRonda.OFERTA);
  const opcion = puesto.candidato.stops.find((s) => s.tipo === r.stop);
  if (!opcion?.viable) return no(MotivoRonda.OFERTA);
  if (!opcion.esquemasViables.includes(ESQUEMA_DE_OBJETIVO[r.objetivo])) {
    return no(MotivoRonda.OFERTA);
  }
  if (!opcion.bandas.some((b) => b.banda === r.apalancamiento)) return no(MotivoRonda.OFERTA);
  const eleccion = eleccionEfectiva({
    candidatoId: puesto.candidato.id,
    stop: r.stop,
    objetivo: r.objetivo,
    apalancamiento: r.apalancamiento,
    tamano: r.tamano,
    confianza: r.confianza,
  });
  // La mitad tiene que seguir siendo una operación.
  if (eleccion.tamano === TamanoOperacion.MEDIO && !opcion.medioViable) {
    return no(MotivoRonda.OFERTA);
  }
  return { eleccion, puesto, motivo: null };
}
