import { AccionTrader, BucketObjetivo, BucketStop } from '@crypton/shared';
import type { EleccionConfianza, RespuestaTrader } from '@crypton/shared';
import {
  ACCIONES_EN,
  CLAVES_ACCION,
  CLAVES_OBJETIVO,
  CLAVES_STOP,
  PREGUNTAS_IDS,
} from './preguntas';
import { choiceDe, noulDe } from './typesafe.client';

/**
 * El contrato de la respuesta del modelo (spec 069).
 *
 * Lo que llega de un proveedor externo **no se completa a medias**: o encaja
 * entero o es un fallo de contrato. Una respuesta a la que le falta una noul no
 * se rellena con un valor prudente, porque entonces el bot operaría con una
 * decisión que nadie tomó.
 *
 * Ojo con dónde acaba esto: `RespuestaTrader` lleva **números de opinión** —
 * probabilidades y confianzas—. Ninguno es una cantidad y ninguno llega jamás a
 * `Decimal` ni a `precision.ts`: pasan todos por `cuantiza()` a enumeraciones
 * antes de que nada aguas abajo los vea, y se guardan en crudo solo como
 * constancia (invariante 13).
 */

/** El fallo de contrato, con lo justo para poder mirarlo después. */
export interface FalloContrato {
  /** Los identificadores de las preguntas que no encajaron. */
  faltan: string[];
}

export type ResultadoContrato =
  { respuesta: RespuestaTrader; fallo: null } | { respuesta: null; fallo: FalloContrato };

/**
 * Traduce las claves inglesas del proveedor a nuestro vocabulario.
 *
 * El modelo habla en inglés porque es más preciso así; el resto del sistema
 * habla castellano. La frontera es esta función y el `estado.ts` del motor, y
 * en ningún otro sitio.
 */
function accionDe(clave: string): AccionTrader | null {
  const v = (ACCIONES_EN as Record<string, string>)[clave];
  return v === undefined ? null : (v as AccionTrader);
}

/**
 * La respuesta del modelo, validada entera, o el motivo por el que no vale.
 *
 * Las dos elecciones de mandos se validan **siempre**, aunque su noul de
 * «determinado» venga baja: `cuantiza()` es quien decide si se usan o mandan
 * los defectos del usuario, y esa decisión no se adelanta aquí. Adelantarla
 * haría que una respuesta mal formada pasara por buena solo porque el modelo se
 * abstuvo.
 */
export function parseRespuestaTrader(answers: Record<string, unknown>): ResultadoContrato {
  const faltan: string[] = [];
  const pide = <T>(id: string, leer: () => T | null): T | null => {
    const v = leer();
    if (v === null) faltan.push(id);
    return v;
  };

  const accionCruda = pide(PREGUNTAS_IDS.ACCION, () =>
    choiceDe(answers[PREGUNTAS_IDS.ACCION], CLAVES_ACCION),
  );
  const regimenRevierte = pide(PREGUNTAS_IDS.REGIMEN, () => noulDe(answers[PREGUNTAS_IDS.REGIMEN]));
  const toqueAgotamiento = pide(PREGUNTAS_IDS.AGOTAMIENTO, () =>
    noulDe(answers[PREGUNTAS_IDS.AGOTAMIENTO]),
  );
  const historialApoya = pide(PREGUNTAS_IDS.HISTORIAL, () =>
    noulDe(answers[PREGUNTAS_IDS.HISTORIAL]),
  );
  const stopDeterminado = pide(PREGUNTAS_IDS.STOP_DETERMINADO, () =>
    noulDe(answers[PREGUNTAS_IDS.STOP_DETERMINADO]),
  );
  const stopCrudo = pide(PREGUNTAS_IDS.STOP, () =>
    choiceDe(answers[PREGUNTAS_IDS.STOP], CLAVES_STOP),
  );
  const objetivoDeterminado = pide(PREGUNTAS_IDS.OBJETIVO_DETERMINADO, () =>
    noulDe(answers[PREGUNTAS_IDS.OBJETIVO_DETERMINADO]),
  );
  const objetivoCrudo = pide(PREGUNTAS_IDS.OBJETIVO, () =>
    choiceDe(answers[PREGUNTAS_IDS.OBJETIVO], CLAVES_OBJETIVO),
  );

  if (faltan.length > 0) return { respuesta: null, fallo: { faltan } };

  const accion = accionDe(accionCruda!.choice);
  if (accion === null) {
    return { respuesta: null, fallo: { faltan: [PREGUNTAS_IDS.ACCION] } };
  }

  // Las probabilidades de `action` llegan con las claves inglesas: se traducen
  // para que la constancia guardada se lea igual que el resto del sistema.
  const probsAccion: Record<string, number> = {};
  for (const [k, v] of Object.entries(accionCruda!.probabilities)) {
    const nuestra = accionDe(k);
    if (nuestra !== null) probsAccion[nuestra] = v;
  }

  const eleccion = <T extends string>(
    c: { choice: string; probabilities: Record<string, number>; confidence: number },
    clave: T,
  ): EleccionConfianza<T> => ({
    clave,
    probabilidades: c.probabilities,
    confianza: c.confidence,
  });

  return {
    respuesta: {
      accion: {
        clave: accion,
        probabilidades: probsAccion,
        confianza: accionCruda!.confidence,
      },
      regimenRevierte: regimenRevierte!,
      toqueAgotamiento: toqueAgotamiento!,
      historialApoya: historialApoya!,
      stopDeterminado: stopDeterminado!,
      stop: eleccion(stopCrudo!, stopCrudo!.choice as BucketStop),
      objetivoDeterminado: objetivoDeterminado!,
      objetivo: eleccion(objetivoCrudo!, objetivoCrudo!.choice as BucketObjetivo),
    },
    fallo: null,
  };
}
