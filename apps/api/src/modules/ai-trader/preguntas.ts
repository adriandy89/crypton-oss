import { BucketObjetivo, BucketStop } from '@crypton/shared';
import type { EstadoTrader } from '@crypton/strategy-core';
import type { Pregunta } from './typesafe.client';

/**
 * Las ocho preguntas del «Bot de IA» (spec 069).
 *
 * ── Por qué ocho y no una ──
 *
 * El proveedor evalúa **todas las preguntas de una llamada en paralelo y en
 * aislamiento**: una respuesta no puede informar a otra. Eso descarta el patrón
 * del canal —«¿qué candidato?» y luego «¿qué stop para ese candidato?»— y es la
 * razón de que aquí haya un único montaje, con la dirección fijada por el borde
 * tocado, y dos elecciones ortogonales encima.
 *
 * ── El reparto ──
 *
 * 1. `action` es el enrutado: tres opciones, no dos, porque las dos negativas
 *    significan cosas distintas para el código. `WRONG_ENVIRONMENT` arma un
 *    enfriado determinista que **deja de preguntar** durante unas velas, y eso
 *    es dinero que no se gasta; `WAIT` se salta solo esta vela.
 * 2-4. Las tres nouls son las tres patas de la primera, preguntadas **por
 *    separado** para que no las arrastre el enrutado. El código exige acuerdo:
 *    el desacuerdo no es un fallo, es una estadística de calibración.
 * 5-8. El patrón `stated`: primero si hay razón para opinar, y solo entonces la
 *    opinión. Existe porque la confianza de este proveedor refleja el argumento
 *    más débil: sin la vía de abstención, una respuesta arbitraria sobre el
 *    stop hundiría la confianza compuesta y costaría una operación de la que el
 *    enrutado estaba seguro.
 *
 * El criterio de esperar decía antes «weak, late, or not stretched enough to be
 * worth acting on». Se quitó en el spec 070 y el motivo importa: midiendo 498
 * decisiones reales salió que el estiramiento predice el resultado **al revés**
 * —cuanto más estirado, peor—, así que esa frase le estaba enseñando al modelo
 * justo lo contrario de lo medido. Ahora el criterio no insinúa ninguna
 * dirección; la evidencia va en el estado, condicionada al estiramiento, para
 * que la relación la encuentre él.
 *
 * Y lo que se descarta a propósito: el **tamaño** (lo duplica la confianza,
 * mejor calibrada), la **banda de apalancamiento** (el modelo no sabe nada que
 * el código no sepa), la **dirección** (la fija el borde) y la primitiva
 * **`score`** entera, porque devuelve un número continuo y todo lo que
 * expresaría está disponible como `choice` ordenada, que además trae
 * distribución y confianza.
 *
 * Están en inglés porque el modelo es más preciso en inglés y lo dice su
 * documentación. El castellano se para en esta frontera, como en `estado.ts`.
 */

/** Los identificadores, en un solo sitio: los usan las preguntas y el contrato. */
export const PREGUNTAS_IDS = {
  ACCION: 'action',
  REGIMEN: 'regime_is_mean_reverting',
  AGOTAMIENTO: 'touch_is_exhaustion',
  HISTORIAL: 'history_supports_the_setup',
  STOP_DETERMINADO: 'stop_width_is_determined',
  STOP: 'stop_width',
  OBJETIVO_DETERMINADO: 'target_depth_is_determined',
  OBJETIVO: 'target_depth',
} as const;

/** Las tres claves de `action`, y su traducción a nuestro vocabulario. */
export const ACCIONES_EN = {
  TAKE_THE_TOUCH: 'TOMAR',
  WAIT_FOR_A_BETTER_TOUCH: 'ESPERAR',
  WRONG_ENVIRONMENT: 'ENTORNO_EQUIVOCADO',
} as const;

export const CLAVES_ACCION = Object.keys(ACCIONES_EN);
export const CLAVES_STOP: readonly string[] = Object.values(BucketStop);
export const CLAVES_OBJETIVO: readonly string[] = Object.values(BucketObjetivo);

/** La versión de las preguntas, para poder comparar respuestas entre versiones. */
export const VERSION_PREGUNTAS = '070.1';

/**
 * Las preguntas para un estado concreto.
 *
 * Los criterios de las dos elecciones salen del propio estado: el motor ya ha
 * descrito cada opción en unidades relativas, así que el modelo elige entre
 * descripciones que **ya están valoradas y validadas**, nunca entre números que
 * tenga que inventar.
 */
export function preguntasTrader(estado: EstadoTrader): Record<string, Pregunta> {
  const criterios = (xs: { key: string; detail: string }[]): Record<string, string> =>
    Object.fromEntries(xs.map((x) => [x.key, x.detail]));

  return {
    [PREGUNTAS_IDS.ACCION]: {
      type: 'choice',
      instructions:
        'A deterministic engine has found a touch of a statistical band around a moving ' +
        'average. It has already checked the market regime, priced every trade it is willing ' +
        'to place, and sized each one so the money at risk is the same. Exits are already ' +
        'placed at the exchange and are not your concern. Decide only what should be done ' +
        'with this touch.',
      criteria: {
        TAKE_THE_TOUCH:
          'The market is oscillating around a centre, and this particular touch looks like a ' +
          'rejection that is likely to revert toward the centre before price continues in the ' +
          'direction of the touch.',
        WAIT_FOR_A_BETTER_TOUCH:
          'Mean reversion is plausible in this market, but the evidence that THIS touch will ' +
          'revert is thin or points both ways. Another touch is likely to come while the ' +
          'market stays in this regime.',
        WRONG_ENVIRONMENT:
          'This market is not oscillating around a centre: it is trending, expanding, or ' +
          'breaking out. Touches of the band here are continuation, not reversal, and no ' +
          'touch should be taken until that changes.',
      },
    },
    [PREGUNTAS_IDS.REGIMEN]: {
      type: 'noul',
      instructions:
        'Is the market described in the state oscillating around a central value, rather than ' +
        'trending, expanding, or breaking out?',
    },
    [PREGUNTAS_IDS.AGOTAMIENTO]: {
      type: 'noul',
      instructions:
        'Does the touching bar described in the state look like the traders pushing price to ' +
        'the band are exhausted, rather than like the start of a directional expansion?',
    },
    [PREGUNTAS_IDS.HISTORIAL]: {
      type: 'noul',
      instructions:
        'Taken on its own, does the historical record described in the state argue in favour ' +
        'of taking this kind of touch?',
    },
    [PREGUNTAS_IDS.STOP_DETERMINADO]: {
      type: 'noul',
      instructions:
        'Do the facts in the state give a clear reason to prefer one stop width over the ' +
        "engine's default of a conventional width?",
    },
    [PREGUNTAS_IDS.STOP]: {
      type: 'choice',
      instructions:
        'If this touch is taken, how far beyond the extreme of the touching bar should the ' +
        'protective stop sit? Position size is adjusted in code so that the money at risk is ' +
        'identical whichever width is chosen: a tighter stop buys a larger position and is ' +
        'hit by ordinary noise more often; a wider stop buys a smaller position and survives ' +
        'more noise.',
      criteria: criterios(estado.stop_choices),
    },
    [PREGUNTAS_IDS.OBJETIVO_DETERMINADO]: {
      type: 'noul',
      instructions:
        'Do the facts in the state give a clear reason to prefer one target depth over the ' +
        "engine's default of the centre line?",
    },
    [PREGUNTAS_IDS.OBJETIVO]: {
      type: 'choice',
      instructions:
        'If this touch is taken, where should the profit target sit relative to the centre ' +
        'line of the band? A closer target is reached more often and pays less; a target at ' +
        'or beyond the centre pays more and is reached less often.',
      criteria: criterios(estado.target_choices),
    },
  };
}
