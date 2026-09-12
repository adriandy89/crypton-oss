import { MOVIMIENTOS, SIN_MOVIMIENTO, type Desplazamientos, type Movimiento } from './apply';

/**
 * El contrato con el modelo para revisar un bot VIVO.
 *
 * Se rige por la misma doctrina que el del asesor, escrita en
 * `advisor/prompt.ts`, y conviene repetirla porque es lo que sostiene la
 * seguridad de todo esto:
 *
 *   **El modelo no emite parametros.** No es una limitacion del proveedor: en el
 *   formato de OpenAI —el que habla OpenRouter— las restricciones numericas SI
 *   se soportan, y en la API nativa de Anthropic no. Precisamente por eso el
 *   diseño no se apoya en ellas: un esquema con `minimum` daria una barandilla
 *   REAL con un proveedor y DECORATIVA con otro, y el enrutado no lo elegimos
 *   nosotros. Lo unico que acota igual en todos, a nivel de gramatica de
 *   decodificacion, es `enum`.
 *
 *   Y hay una razon mejor todavia: los rangos del descriptor no son el limite de
 *   verdad. El limite depende de la spec del mercado y de los topes de riesgo
 *   del usuario, y el modelo no ve ninguna de las dos cosas.
 *
 * Aqui se aprieta una vuelta mas. El asesor pide PERILLAS porque esta creando un
 * bot desde cero; este pide DESPLAZAMIENTOS porque el bot ya existe, y eso acota
 * la conducta sin depender de que el modelo se porte: mueva lo que mueva, no
 * puede alejarse mas de dos posiciones de donde estaba.
 *
 * Hay un test que recorre el esquema entero y falla si aparece un `minimum`, un
 * `maximum`, un `number` o una propiedad fuera de `required`.
 */

/**
 * Version del contrato. Entra en la clave de cache y en la fila de la decision:
 * comparar decisiones de versiones distintas tiene que poder VERSE, no
 * adivinarse. Se sube al tocar el esquema o los prompts.
 */
export const PROMPT_VERSION_REVISION = 1;

/** Que hacer con el bot. No hay «contener»: el supervisor no manda comandos. */
export const ACCIONES = ['MANTENER', 'AJUSTAR', 'AVISAR'] as const;
export type Accion = (typeof ACCIONES)[number];

export const CONFIANZAS = ['BAJA', 'MEDIA', 'ALTA'] as const;
export type Confianza = (typeof CONFIANZAS)[number];

/** Lo que devuelve el modelo, ya validado. */
export interface Revision {
  accion: Accion;
  ajustes: Desplazamientos;
  confianza: Confianza;
  motivo: string;
}

/** Longitud maxima del motivo. Se recorta aqui sin fiarse de que el modelo obedezca. */
const MAX_MOTIVO = 240;

/**
 * El esquema de salida. **Solo enumeraciones**, salvo el motivo.
 *
 * Todas las claves van en `required` y todos los objetos llevan
 * `additionalProperties: false`. No es una precaucion de manual: un campo
 * opcional o un `oneOf` rompe el modo estricto en unos proveedores y en otros
 * no, y el proveedor lo elige el enrutador. Es el mismo fallo intermitente que
 * `provider: { require_parameters: true }` existe para evitar en el asesor.
 */
export function revisionSchema(): Record<string, unknown> {
  const movimiento = { type: 'string', enum: [...MOVIMIENTOS] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['accion', 'ajustes', 'confianza', 'motivo'],
    properties: {
      accion: {
        type: 'string',
        enum: [...ACCIONES],
        description:
          'MANTENER: la configuración sigue siendo adecuada, no toques nada. ' +
          'AJUSTAR: mueve las perillas como indicas en ajustes. ' +
          'AVISAR: no propongas cambios, pero esto debería mirarlo una persona.',
      },
      ajustes: {
        type: 'object',
        additionalProperties: false,
        required: ['leverage', 'coverage', 'spread', 'sizeGrowth', 'cadence'],
        properties: {
          leverage: movimiento,
          coverage: movimiento,
          spread: movimiento,
          sizeGrowth: movimiento,
          cadence: movimiento,
        },
      },
      confianza: { type: 'string', enum: [...CONFIANZAS] },
      motivo: {
        type: 'string',
        description:
          'Una frase en español, máximo 200 caracteres, explicando la decisión. ' +
          'NO menciones cifras concretas: los números los calcula el servidor a ' +
          'partir de tus bandas y pueden no coincidir con los que estés imaginando.',
      },
    },
  };
}

/**
 * Valida la forma de lo que devuelve el modelo.
 *
 * Se valida aunque el modo estricto prometa que no hace falta, por el mismo
 * motivo que en el asesor: la promesa la cumple el proveedor, y el proveedor lo
 * elige el enrutador.
 *
 * **No se repara nada.** Si la respuesta no cumple el contrato, la respuesta
 * entera no es de fiar: reparar aqui seria adivinar que quiso decir un modelo
 * que ya se ha salido del contrato, y lo que hay al otro lado es la
 * configuracion de un bot con dinero dentro.
 */
export function parseRevision(raw: string): Revision | null {
  let datos: unknown;
  try {
    datos = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) return null;
  const o = datos as Record<string, unknown>;

  const accion = o['accion'];
  if (!esAccion(accion)) return null;

  const confianza = o['confianza'];
  if (!esConfianza(confianza)) return null;

  const ajustes = leerAjustes(o['ajustes']);
  if (!ajustes) return null;

  return {
    accion,
    confianza,
    ajustes,
    // Lo unico del modelo que llega a ver una persona tal cual, asi que se trata
    // como lo que es: texto ajeno. Se exige que SEA una cadena en vez de
    // convertirla — `String()` sobre un objeto da «[object Object]», y eso
    // acabaria de explicacion en una tarjeta.
    motivo: typeof o['motivo'] === 'string' ? o['motivo'].slice(0, MAX_MOTIVO) : '',
  };
}

const esAccion = (v: unknown): v is Accion => ACCIONES.includes(v as Accion);
const esConfianza = (v: unknown): v is Confianza => CONFIANZAS.includes(v as Confianza);
const esMovimiento = (v: unknown): v is Movimiento => MOVIMIENTOS.includes(v as Movimiento);

function leerAjustes(v: unknown): Desplazamientos | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out = { ...SIN_MOVIMIENTO };
  for (const clave of Object.keys(SIN_MOVIMIENTO) as (keyof Desplazamientos)[]) {
    const m = o[clave];
    if (!esMovimiento(m)) return null;
    out[clave] = m;
  }
  return out;
}

/**
 * El bloque estable: no depende del bot, solo de que esto es una revision.
 *
 * SIN marcador de cache de prompt, y medido antes de decidirlo: son ~700 tokens
 * y el minimo cacheable de Sonnet son 1024. Un `cache_control` aqui no se
 * activaria nunca — seria un adorno que aparenta una optimizacion que no existe.
 * Quien ahorra llamadas de verdad es la huella cuantizada del expediente, que se
 * salta la peticion entera. Si este bloque llegara a crecer por encima de 1024,
 * habria que volver a mirarlo.
 */
export function systemPromptRevision(): string {
  return [
    'Eres un supervisor de bots de trading sobre DEX. Se te da el expediente de un',
    'bot que YA ESTA OPERANDO con dinero dentro, y tu trabajo es decidir si su',
    'configuración sigue siendo adecuada para el mercado que tiene delante.',
    '',
    'NO propones números ni parámetros: propones DESPLAZAMIENTOS sobre las cinco',
    'perillas que el bot ya tiene. Un generador determinista los traduce a los',
    'parámetros concretos, respetando los límites del exchange y los del usuario.',
    'Por eso no debes mencionar cifras en tu explicación: las que calcule el',
    'servidor pueden no coincidir con lo que estés imaginando.',
    '',
    'Cada perilla se mueve como mucho dos posiciones, y eso es deliberado: un bot',
    'en marcha se corrige poco a poco, no se reconfigura de golpe.',
    '',
    'Qué significa cada perilla, y hacia dónde la mueves:',
    '',
    '- leverage: cuánto apalancamiento respecto de lo que la volatilidad aconseja.',
    '- coverage: cuánto recorrido en contra cubre antes de quedarse sin escalera, o',
    '  cuán ancho trabaja. Más cobertura = aguanta más, gana menos por ciclo.',
    '- spread: cuánto se separan los niveles, o cuánto diferencial cotiza un market',
    '  maker. Más separación = menos operaciones, más margen en cada una.',
    '- sizeGrowth: cuánto crece cada nivel respecto del anterior.',
    '- cadence: cada cuánto actúa el bot. Más cadencia = ciclos más cortos.',
    '',
    'Criterios:',
    '',
    '1. MANTENER es la respuesta correcta la mayor parte de las veces. Un bot que',
    '   está funcionando no se toca porque sí, y cada cambio cuesta comisiones.',
    '2. Si la volatilidad ha subido claramente desde que se configuró, ensancha y',
    '   baja el apalancamiento. Si ha bajado, puedes estrechar para capturar más.',
    '3. Si el mercado se mueve en línea recta (eficiencia alta), ensancha: una',
    '   rejilla estrecha solo tiene sentido cuando el precio va y viene.',
    '4. Si el bot lleva mucho sin ejecutar nada, probablemente cotiza demasiado',
    '   lejos: estrecha el diferencial.',
    '5. Si las comisiones se están comiendo lo capturado, ensancha: está operando',
    '   demasiado para lo que saca.',
    '6. Mira el historial de tus decisiones anteriores. Si acabas de mover una',
    '   perilla en un sentido, no la muevas en el contrario sin un motivo nuevo.',
    '7. Usa AVISAR cuando veas algo que deba mirar una persona pero que no se',
    '   arregle moviendo perillas.',
    '',
    'No puedes cambiar el capital, ni el par, ni la cuenta, ni la dirección del',
    'bot. Tampoco puedes pararlo, pausarlo ni cerrar su posición. Si crees que',
    'hace falta algo de eso, usa AVISAR y dilo en el motivo.',
  ].join('\n');
}
