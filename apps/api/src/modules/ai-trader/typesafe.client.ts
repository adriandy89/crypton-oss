import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * El transporte de TypeSafe (spec 069): el **segundo y último** fichero de este
 * repositorio que habla con un modelo. El otro es `openrouter.client.ts`.
 *
 * Los dos no se importan entre sí ni comparten transporte —un proveedor caído
 * no arrastra al otro— y comparten una sola cosa: el vocabulario del resultado,
 * para que dos decisiones de dos proveedores se puedan comparar en
 * `bot_ai_intents` sin saber de qué estrategia son.
 *
 * ── Por qué `fetch` a mano y no el SDK ──
 *
 * `@typesafe-ai/sdk` va por la 0.6.0, es ESM puro y esta API es CJS: haría
 * falta un `await import()` dentro de un `@Injectable()` en una ruta con plazo.
 * Y lo que compra es un POST con dos cabeceras. Lo difícil ya está resuelto en
 * el cliente hermano —presupuesto único para dos intentos, cancelar el cuerpo
 * perdedor, `TimeoutError` contra `TypeError`—, así que se copia ese patrón,
 * que es conocimiento pagado con averías.
 *
 * ── Lo que este proveedor NO tiene, y se dice para que no se busque ──
 *
 * No hay parámetro de esfuerzo, no hay caché de prompt y **no hay precio
 * publicado**. Por eso el coste se escribe `null` y se guardan los recuentos de
 * *tokens* en el JSON de la decisión: reconstruir la factura cuando publiquen
 * tarifas es posible; inventarse un número y meterlo en una columna
 * `Decimal(38,18)` no tiene vuelta atrás.
 */

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

/** Lo más que se le puede pedir a una llamada, pase lo que pase en la configuración. */
export const TOPE_PLAZO_MS = 25_000;

/**
 * Por qué no hubo respuesta utilizable.
 *
 * Calca los del cliente hermano salvo `SOBRECARGA`, que es el único miembro
 * nuevo: el `529` de este proveedor es transitorio, no es culpa nuestra y
 * merece su propia línea en `bot_ai_loops` para no confundirlo con un fallo
 * nuestro que hay que arreglar.
 */
export type FalloTypeSafe = 'SIN_CLAVE' | 'HTTP' | 'SOBRECARGA' | 'TIEMPO' | 'RED' | 'VACIA';

/** Una pregunta de elección: el modelo escoge una clave de `criteria`. */
export interface PreguntaChoice {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** Una pregunta de probabilidad: el modelo devuelve un número de 0 a 1. */
export interface PreguntaNoul {
  type: 'noul';
  instructions: string;
}

/**
 * Una pregunta de puntuacion: niveles ORDENADOS, y el modelo devuelve la media
 * ponderada por probabilidad sobre ellos (spec 071).
 *
 * Es la primitiva que faltaba, y su ausencia es el fallo estructural de los
 * specs 069 y 070: alli el modelo emitia una CATEGORIA, y una categoria no se
 * puede comparar con un umbral escalar a tasa de aceptacion igualada. Por eso
 * aquellas mediciones solo pudieron decir «-0,014» sin saber contra que.
 *
 * El proveedor evalua cada nivel de forma independiente, sin ver su numero ni
 * sus vecinos, y despues reparte la probabilidad: asi no se sesga hacia los
 * valores intermedios. Su documentacion insiste en que los niveles se describan
 * por lo que se VERIA, no por grados vagos («muy alto», «medio»).
 */
export interface PreguntaScore {
  type: 'score';
  instructions: string;
  /** Los niveles, del menor al mayor. El orden es la semantica. */
  levels: { key: string; detail: string }[];
}

export type Pregunta = PreguntaChoice | PreguntaNoul | PreguntaScore;

/** Una respuesta de elección, tal y como la devuelve el proveedor. */
export interface RespuestaChoice {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** Una respuesta de puntuacion, tal y como la devuelve el proveedor. */
export interface RespuestaScore {
  /** Media ponderada por probabilidad de los niveles: de 0 a `niveles - 1`. */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface UsoTypeSafe {
  entrada: number;
  salida: number;
}

export interface RespuestaTypeSafe {
  /** Las respuestas en crudo, sin interpretar. `null` si no hubo ninguna. */
  answers: Record<string, unknown> | null;
  uso: UsoTypeSafe | null;
  fallo: FalloTypeSafe | null;
  latenciaMs: number;
  modelo: string;
}

export interface PeticionTypeSafe {
  /** El estado, ya limpio y en inglés. Lo genera `strategy-core`. */
  estado: unknown;
  preguntas: Record<string, Pregunta>;
  limiteMs: number;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** El uso de la llamada, si viene y es legible. Nunca lanza. */
export function usoTypeSafeDe(bruto: unknown): UsoTypeSafe | null {
  if (!esObjeto(bruto)) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const entrada = n(bruto['input_tokens'] ?? bruto['prompt_tokens']);
  const salida = n(bruto['output_tokens'] ?? bruto['completion_tokens']);
  return entrada === 0 && salida === 0 ? null : { entrada, salida };
}

/** Una respuesta de elección bien formada, o null. Viene de fuera: se mira. */
export function choiceDe(v: unknown, opciones: readonly string[]): RespuestaChoice | null {
  if (!esObjeto(v)) return null;
  const clave = v['choice'];
  const confianza = v['confidence'];
  if (typeof clave !== 'string' || !opciones.includes(clave)) return null;
  if (typeof confianza !== 'number' || !Number.isFinite(confianza)) return null;
  // Fuera de [0,1] no se recorta: se rechaza. Un proveedor que devuelve una
  // confianza de 1,4 no está diciendo «mucha», está diciendo otra cosa.
  if (confianza < 0 || confianza > 1) return null;
  const probabilidades: Record<string, number> = {};
  const p = v['probabilities'];
  if (esObjeto(p)) {
    for (const [k, x] of Object.entries(p)) {
      if (typeof x === 'number' && Number.isFinite(x)) probabilidades[k] = x;
    }
  }
  return { choice: clave, probabilities: probabilidades, confidence: confianza };
}

/**
 * Una puntuacion bien formada, o null (spec 071).
 *
 * Igual de estricta que `choiceDe`: fuera del rango de niveles se RECHAZA, no
 * se recorta. Un proveedor que devuelve 4,2 sobre una escala de tres niveles no
 * esta diciendo «lo maximo», esta diciendo otra cosa.
 */
export function scoreDe(v: unknown, niveles: readonly string[]): RespuestaScore | null {
  if (!esObjeto(v) || niveles.length === 0) return null;
  const s = v['score'];
  const confianza = v['confidence'];
  if (typeof s !== 'number' || !Number.isFinite(s)) return null;
  if (s < 0 || s > niveles.length - 1) return null;
  if (typeof confianza !== 'number' || !Number.isFinite(confianza)) return null;
  if (confianza < 0 || confianza > 1) return null;
  const probabilities: Record<string, number> = {};
  const p = v['probabilities'];
  if (esObjeto(p)) {
    for (const [k, x] of Object.entries(p)) {
      if (typeof x === 'number' && Number.isFinite(x)) probabilities[k] = x;
    }
  }
  return { score: s, probabilities, confidence: confianza };
}

/** Una probabilidad bien formada, o null. */
export function noulDe(v: unknown): number | null {
  const n = esObjeto(v) ? v['noul'] : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n < 0 || n > 1 ? null : n;
}

@Injectable()
export class TypeSafeClient {
  private readonly logger = new Logger(TypeSafeClient.name);

  constructor(private readonly config: ConfigService) {}

  /** La clave del proveedor. **No se registra, ni entera ni en trozos.** */
  private get clave(): string {
    return (this.config.get<string>('TYPESAFE_AI_API_KEY', '') ?? '').trim();
  }

  get modelo(): string {
    return this.config.get<string>('AI_TRADER_MODEL', 'jev-latest') ?? 'jev-latest';
  }

  /** Hay clave y el interruptor está encendido: las dos cosas hacen falta. */
  get disponible(): boolean {
    return this.config.get<string>('AI_TRADER_ENABLE', 'false') === 'true' && this.clave !== '';
  }

  /**
   * Pregunta. **Nunca lanza**: devuelve las respuestas o el motivo del fallo.
   *
   * Todas las preguntas van en una sola llamada porque el proveedor las evalúa
   * **en paralelo y en aislamiento**: mandarlas por separado costaría N veces
   * más y no cambiaría ni una respuesta.
   */
  async preguntar(p: PeticionTypeSafe): Promise<RespuestaTypeSafe> {
    const t0 = Date.now();
    const modelo = this.modelo;
    const sin = (fallo: FalloTypeSafe, uso: UsoTypeSafe | null = null): RespuestaTypeSafe => ({
      answers: null,
      uso,
      fallo,
      latenciaMs: Date.now() - t0,
      modelo,
    });

    const clave = this.clave;
    if (!this.disponible) return sin('SIN_CLAVE');

    try {
      const cuerpo = JSON.stringify({ state: p.estado, model: modelo, questions: p.preguntas });
      // Un solo presupuesto para los dos intentos, como en el cliente hermano:
      // dos esperas completas se comerían el plazo de la intención entera.
      const limite = Date.now() + Math.min(p.limiteMs, TOPE_PLAZO_MS);
      let res: Response | null = null;

      for (let intento = 1; intento <= 2; intento++) {
        const restante = limite - Date.now();
        if (restante < 1_000) break;

        const r = await fetch(TYPESAFE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
          body: cuerpo,
          signal: AbortSignal.timeout(restante),
        });

        // Se reintenta SOLO lo que puede salir bien a la segunda. El cupo ya
        // está apuntado antes de llegar aquí, así que un 529 pasajero le
        // costaría al dueño una de sus llamadas del día a cambio de nada.
        const reintentable = !r.ok && (r.status >= 500 || r.status === 429);
        const hayTiempo = limite - Date.now() >= 1_000;
        if (!reintentable || intento === 2 || !hayTiempo) {
          res = r;
          break;
        }
        // Sin leerlo ni cancelarlo, la conexión queda ocupada hasta el recolector.
        await r.body?.cancel().catch(() => undefined);
      }

      if (!res) return sin('TIEMPO');
      if (!res.ok) return sin(await this.falloHttp(res));

      const datos: unknown = await res.json();
      const uso = esObjeto(datos) ? usoTypeSafeDe(datos['usage']) : null;
      const answers = esObjeto(datos) ? datos['answers'] : null;
      if (!esObjeto(answers)) {
        this.logger.warn('TypeSafe respondió 200 sin un mapa de respuestas legible.');
        return sin('VACIA', uso);
      }
      return { answers, uso, fallo: null, latenciaMs: Date.now() - t0, modelo };
    } catch (e) {
      const nombre = (e as Error)?.name;
      if (nombre === 'TimeoutError' || nombre === 'AbortError') {
        this.logger.debug(`TypeSafe tardó más de ${p.limiteMs} ms.`);
        return sin('TIEMPO');
      }
      if (e instanceof TypeError) {
        // Un `TypeError` aquí NO es un fallo de red: es una petición mal
        // construida por nosotros, y `fetch` la rechaza antes de abrir el
        // socket. Va como error para que un fallo permanente nuestro no se
        // disfrace de caída ajena pasajera.
        this.logger.error(`Petición a TypeSafe mal formada, no llegó a salir: ${e.message}`);
      } else {
        this.logger.debug(`Fallo al preguntar a TypeSafe: ${String(e)}`);
      }
      return sin('RED');
    }
  }

  /**
   * Qué clase de fallo es un HTTP que no es 200.
   *
   * El `422` se registra como **error** y no como aviso a propósito: significa
   * que nuestra petición está mal construida y no se va a arreglar sola. Un
   * `401` también, porque la clave no se arregla reintentando. Lo demás es del
   * proveedor y pasa.
   */
  private async falloHttp(res: Response): Promise<FalloTypeSafe> {
    // El cuerpo se lee acotado: es un mensaje de error, no un documento.
    const bruto = await res.text().catch(() => '');
    const detalle = bruto.slice(0, 300);
    if (res.status === 529) {
      this.logger.warn('TypeSafe está saturado (529): esta vela no se decide.');
      return 'SOBRECARGA';
    }
    if (res.status === 401 || res.status === 403) {
      this.logger.error(`TypeSafe rechaza la clave (${res.status}). Revisa TYPESAFE_AI_API_KEY.`);
    } else if (res.status === 422) {
      this.logger.error(`TypeSafe no acepta la petición (422): ${detalle}`);
    } else {
      this.logger.warn(`TypeSafe devolvió ${res.status}: ${detalle}`);
    }
    return 'HTTP';
  }
}
