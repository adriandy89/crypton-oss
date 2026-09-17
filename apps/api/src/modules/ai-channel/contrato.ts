import {
  BandaApalancamiento,
  EsquemaObjetivo,
  MotivoCanal,
  MotivoConsulta,
  NivelConfianza,
  RiesgoCanal,
  TamanoOperacion,
  TipoStop,
  Veredicto,
  eleccionEfectiva,
  type EleccionOperacion,
  type RespuestaModeloCanal,
} from '@crypton/shared';
import type { OfertaCanal } from './herramienta';

/**
 * El contrato con el modelo para decidir una entrada del canal con IA (spec 059).
 *
 * La doctrina es la del asesor y la del supervisor, y aquí pesa más que en
 * ninguno de los dos, porque lo que hay detrás es una operación apalancada:
 *
 *   **El modelo no emite números.** Elige con enumeraciones entre opciones que
 *   el motor ya calculó dentro de los límites del dueño. El esquema no lleva ni
 *   un `number` ni un `minimum`: una barandilla numérica sería real con un
 *   proveedor y decorativa con otro, y el proveedor lo elige el enrutador. Lo
 *   único que acota igual en todos es `enum`.
 *
 *   **El modelo no ve ids.** La oferta lleva etiquetas neutras (`A`, `B`…) y el
 *   esquema de CADA solicitud solo admite las de su oferta. Así una opción que
 *   no se ofreció no pasa ni la gramática, y si pasara, el parser la rechaza.
 *
 *   **No se repara nada.** Una respuesta fuera del contrato no es de fiar
 *   entera, y cuenta como fallo del modelo.
 *
 * Hay un test que recorre el esquema y falla si aparece un número, una
 * restricción numérica o un objeto abierto.
 */

/** Se sube al tocar el esquema. Va dentro de la versión del prompt. */
export const VERSION_CONTRATO_CANAL = 1;

/** Lo que elige el modelo cuando no opera. */
export const NINGUNA = 'NINGUNA';

/** Largo máximo del texto del modelo. Se recorta aquí sin fiarse de que obedezca. */
export const MAX_TEXTO = 200;

const valores = <T extends Record<string, string>>(o: T): T[keyof T][] =>
  Object.values(o) as T[keyof T][];

/** Todas las claves de la respuesta, en el orden del esquema. */
export const CLAVES_RESPUESTA = [
  'veredicto',
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
  'motivo',
] as const;

/** Las etiquetas neutras de una oferta: `A`, `B`, `C`… */
export const etiquetaDe = (i: number): string => String.fromCharCode(65 + i);

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
 * eso, cuando no se opera, los demás campos también llevan valor; se ignoran.
 */
export function esquemaDecision(etiquetas: readonly string[]): {
  name: string;
  schema: Record<string, unknown>;
} {
  const motivos = valores(MotivoCanal);
  const riesgos = valores(RiesgoCanal);
  return {
    name: 'decision_canal',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [...CLAVES_RESPUESTA],
      properties: {
        veredicto: enumerado(
          valores(Veredicto),
          'OPERAR solo si una opción ofrecida tiene ventaja clara; ante la duda, NO_OPERAR.',
        ),
        opcion: enumerado(
          [...etiquetas, NINGUNA],
          'La letra de la opción elegida, o NINGUNA si no operas.',
        ),
        stop: enumerado(valores(TipoStop), 'El stop de esa opción, de los marcados disponibles.'),
        objetivo: enumerado(
          valores(EsquemaObjetivo),
          'El esquema de salida, de los disponibles para ese stop.',
        ),
        apalancamiento: enumerado(
          valores(BandaApalancamiento),
          'La banda de apalancamiento de ese stop.',
        ),
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
        motivo: {
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

/** Los motivos sin relleno ni repetidos, en su orden. */
function sinRelleno<T extends string>(lista: T[], relleno: T): T[] {
  return lista.filter((x, i) => x !== relleno && lista.indexOf(x) === i);
}

/**
 * La respuesta del modelo, validada contra el contrato de ESTA oferta, o null.
 *
 * Se valida aunque el modo estricto prometa que no hace falta: la promesa la
 * cumple el proveedor, y el proveedor lo elige el enrutador.
 */
export function parseDecision(
  raw: string,
  etiquetas: readonly string[],
): RespuestaModeloCanal | null {
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
  const esperadas: readonly string[] = CLAVES_RESPUESTA;
  if (claves.length !== esperadas.length || !esperadas.every((k) => k in o)) return null;

  const { veredicto, opcion, stop, objetivo, apalancamiento, tamano, confianza, motivo } = o;
  if (!en<Veredicto>(veredicto, valores(Veredicto))) return null;
  if (!en<string>(opcion, [...etiquetas, NINGUNA])) return null;
  if (!en<TipoStop>(stop, valores(TipoStop))) return null;
  if (!en<EsquemaObjetivo>(objetivo, valores(EsquemaObjetivo))) return null;
  if (!en<BandaApalancamiento>(apalancamiento, valores(BandaApalancamiento))) return null;
  if (!en<TamanoOperacion>(tamano, valores(TamanoOperacion))) return null;
  if (!en<NivelConfianza>(confianza, valores(NivelConfianza))) return null;
  if (typeof motivo !== 'string') return null;

  const motivos: MotivoCanal[] = [];
  for (const k of ['motivo1', 'motivo2', 'motivo3']) {
    const m = o[k];
    if (!en<MotivoCanal>(m, valores(MotivoCanal))) return null;
    motivos.push(m);
  }
  const riesgos: RiesgoCanal[] = [];
  for (const k of ['riesgo1', 'riesgo2']) {
    const r = o[k];
    if (!en<RiesgoCanal>(r, valores(RiesgoCanal))) return null;
    riesgos.push(r);
  }

  // Operar sin decir qué es una contradicción: la respuesta entera no vale.
  if (veredicto === Veredicto.OPERAR && opcion === NINGUNA) return null;

  return {
    veredicto,
    opcion,
    stop,
    objetivo,
    apalancamiento,
    tamano,
    confianza,
    motivos: sinRelleno(motivos, MotivoCanal.NINGUNO),
    riesgos: sinRelleno(riesgos, RiesgoCanal.NINGUNO),
    // Lo único del modelo que ve una persona tal cual: texto ajeno.
    texto: recortarSinPartir(motivo, MAX_TEXTO),
  };
}

const ORDEN_CONFIANZA: Readonly<Record<NivelConfianza, number>> = {
  [NivelConfianza.BAJA]: 0,
  [NivelConfianza.MEDIA]: 1,
  [NivelConfianza.ALTA]: 2,
};

export type ResultadoEleccion =
  { eleccion: EleccionOperacion; motivo: null } | { eleccion: null; motivo: MotivoConsulta };

/**
 * De la respuesta a la elección que se ejecuta, o por qué no hay ninguna.
 *
 * Mira lo mismo que mirará el worker al construir la operación —si la opción
 * está en la oferta y disponible—, y además la confianza mínima del bot y la
 * reducción de tamaño. El worker vuelve a comprobarlo todo con datos frescos.
 */
export function validarEleccion(
  r: RespuestaModeloCanal,
  oferta: OfertaCanal,
  confianzaMinima: 'MEDIA' | 'ALTA',
): ResultadoEleccion {
  const no = (motivo: MotivoConsulta): ResultadoEleccion => ({ eleccion: null, motivo });
  if (r.veredicto !== Veredicto.OPERAR) return no(MotivoConsulta.NO_OPERAR);

  const candidato = oferta.porEtiqueta.get(r.opcion);
  if (!candidato) return no(MotivoConsulta.OFERTA);
  const opcion = candidato.stops.find((s) => s.tipo === r.stop);
  if (!opcion?.viable) return no(MotivoConsulta.OFERTA);
  if (!opcion.esquemasViables.includes(r.objetivo)) return no(MotivoConsulta.OFERTA);
  if (!opcion.bandas.some((b) => b.banda === r.apalancamiento)) return no(MotivoConsulta.OFERTA);

  if (ORDEN_CONFIANZA[r.confianza] < ORDEN_CONFIANZA[confianzaMinima]) {
    return no(MotivoConsulta.CONFIANZA);
  }

  const eleccion = eleccionEfectiva({
    veredicto: r.veredicto,
    opcion: candidato.id,
    stop: r.stop,
    objetivo: r.objetivo,
    apalancamiento: r.apalancamiento,
    tamano: r.tamano,
    confianza: r.confianza,
  });
  // La mitad tiene que seguir siendo una operación.
  if (eleccion.tamano === TamanoOperacion.MEDIO && !opcion.medioViable) {
    return no(MotivoConsulta.OFERTA);
  }
  return { eleccion, motivo: null };
}
