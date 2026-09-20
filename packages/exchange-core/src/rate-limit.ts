import { isRetryable, messageOf, toExchangeError } from './errors';
import { ExchangeError, type Venue } from '@crypton/shared';

/**
 * Limitador de caudal, con dos carriles.
 *
 * El ÁMBITO importa y no lo decide este fichero. Los límites de los venues son
 * por cuenta y por IP, nunca por bot, así que un limitador por bot —que es lo
 * que había— multiplicaba el caudal real por el número de bots: diez bots de
 * una misma cuenta a 8/s mandaban 80/s contra un límite de 8/s. Quien crea el
 * limitador es responsable de compartirlo entre los bots que compartan cuenta;
 * ver `AccountHub` en el worker.
 *
 * **Los dos carriles** (spec 065). El limitador era una cadena de promesas que
 * esperaba a que `fn` TERMINASE antes de soltar la cola: concurrencia uno. Dos
 * consecuencias medidas:
 *
 * - el caudal real era `1/max(intervalo, latencia)`, no el configurado — con
 *   seis por segundo y velas de medio segundo, dos por segundo;
 * - una llamada que agotaba el plazo del SDK retenía diez segundos a todas las
 *   de detrás, y como los bots simulados de un venue comparten una sola fuente,
 *   eso eran todos los bots del venue.
 *
 * Ahora:
 *
 * - `run()` es el carril **ORDENADO**: concurrencia uno y orden de llamada. Por
 *   aquí va todo lo que FIRMA. No es una preferencia: el `nonce_manager` del SDK
 *   de Lighter asigna un contador secuencial dentro de la llamada, y dos
 *   transacciones invertidas dan `21104 invalid nonce`, tras el cual el SDK
 *   decrementa su contador y el adaptador se queda sin poder colocar nada.
 * - `runLibre()` es el carril **LIBRE**: hasta `maxEnVuelo` a la vez. Por aquí
 *   van las lecturas, que ni firman ni llevan nonce.
 *
 * El carril se elige **por prioridad, no por método**, y ese detalle no es
 * cosmético: en Lighter, cancelar una orden va por el mismo método que las
 * lecturas pero con prioridad de escritura.
 *
 * El marcapasos es común a los dos y **reserva el turno en la llamada**, no al
 * terminar: así el espaciado deja de depender de la latencia. Y subir la
 * concurrencia no puede pasarse del cupo del venue, porque toda llamada pasa
 * antes por `VenueBudget.take()`.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private readonly maxEnVuelo: number;
  /** El carril ordenado: una cadena de promesas. */
  private cola: Promise<void> = Promise.resolve();
  /** Cuándo puede salir el próximo turno, ya reservado. */
  private proximaSalida = 0;
  private enVuelo = 0;
  private readonly enEspera: (() => void)[] = [];

  constructor(perSecond: number, opts: { maxEnVuelo?: number } = {}) {
    this.intervalMs = perSecond > 0 ? 1000 / perSecond : 0;
    this.maxEnVuelo = Math.max(1, Math.floor(opts.maxEnVuelo ?? 1));
  }

  /** Carril ORDENADO: una detrás de otra, en el orden de llamada. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.cola.then(async () => {
      await this.turno();
      return fn();
    });
    // La cola avanza pase lo que pase: si un fallo la rompiera, el adaptador
    // dejaría de mandar órdenes para siempre sin ningún error visible.
    this.cola = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Carril LIBRE: hasta `maxEnVuelo` a la vez, con el mismo espaciado. */
  async runLibre<T>(fn: () => Promise<T>): Promise<T> {
    // El hueco primero y el turno después. Al revés, una llamada parada en el
    // semáforo desperdiciaría su ranura de caudal y el marcapasos mentiría.
    await this.adquirir();
    try {
      await this.turno();
      return await fn();
    } finally {
      this.liberar();
    }
  }

  /**
   * Reserva la próxima ranura de caudal y espera a que llegue.
   *
   * La reserva es SÍNCRONA, así que el orden de reserva es el orden de llamada
   * y dos llamadas nunca se quedan con la misma ranura. El `max` con el reloj
   * impide que el marcapasos derive hacia el futuro tras un rato en reposo.
   */
  private async turno(): Promise<void> {
    const ahora = Date.now();
    const salida = Math.max(ahora, this.proximaSalida);
    this.proximaSalida = salida + this.intervalMs;
    if (salida > ahora) await sleep(salida - ahora);
  }

  private async adquirir(): Promise<void> {
    if (this.enVuelo < this.maxEnVuelo) {
      this.enVuelo++;
      return;
    }
    await new Promise<void>((paso) => this.enEspera.push(paso));
    // El hueco viene TRASPASADO por `liberar`: `enVuelo` ya lo cuenta. Si aquí
    // se volviera a incrementar, dos llamadas ocuparían la misma ranura.
  }

  private liberar(): void {
    const siguiente = this.enEspera.shift();
    if (siguiente) {
      siguiente();
      return;
    }
    this.enVuelo--;
  }
}

/**
 * Traduce `VENUE_MAX_CONCURRENT_READS` a la opción del adaptador.
 *
 * Una variable vacía da `Number('') === 0`, que como concurrencia es absurdo y
 * el limitador subiría a uno de todas formas; aquí se devuelve el objeto vacío
 * para que mande el valor por defecto de cada adaptador, que es distinto por
 * venue (spec 060, F-34 avisaba de esta misma trampa).
 */
export function lecturasEnVuelo(valor: unknown): { maxConcurrentReads?: number } {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 1 ? { maxConcurrentReads: Math.floor(n) } : {};
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lo más que se espera a UNA respuesta HTTP de un venue.
 *
 * Diez segundos, los mismos que trae de serie el SDK de Hyperliquid. Lighter y
 * Aster llaman a `fetch` a pelo y no tenían ninguno: una conexión que el venue
 * deja colgada esperaba lo que undici quisiera —cinco minutos—, y la llamada
 * vive dentro del cerrojo del bot, así que un PANIC pulsado mientras tanto
 * esperaba con ella (spec 050).
 */
export const HTTP_TIMEOUT_MS = 10_000;

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  venue?: Venue;
}

/**
 * Reintento con backoff exponencial y jitter, SOLO para errores marcados como
 * reintentables. Un rechazo por reglas o por saldo se propaga a la primera:
 * reintentarlo no cambia el resultado y solo consume caudal.
 *
 * El jitter no es adorno — sin él, todos los bots que se topan con el mismo
 * corte reintentan en el mismo instante y vuelven a tumbar la conexión.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 8000;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || i === attempts - 1) break;
      const backoff = Math.min(max, base * 2 ** i);
      await sleep(backoff / 2 + Math.random() * (backoff / 2));
    }
  }
  throw toExchangeError(lastError, opts.venue);
}

/**
 * Reintento para operaciones que ESCRIBEN (colocar una orden).
 *
 * `withRetry` a secas no vale aquí. Un timeout puede llegar DESPUÉS de que el
 * venue haya aceptado la orden: el reintento manda la misma otra vez, el venue
 * la rechaza por id de cliente duplicado, el error se clasifica como FATAL y la
 * fila acaba marcada REJECTED mientras la orden está viva en el libro. La base
 * de datos pasa a mentir sobre lo que hay en el venue.
 *
 * Por eso, ante un error reintentable no se reenvía a ciegas: primero se
 * pregunta al venue si la operación llegó a surtir efecto (`verify` devuelve el
 * acuse si la orden ya está allí, o null si no), y solo se reintenta si no.
 *
 * Y si la PREGUNTA falla, no se reenvía: el estado es DESCONOCIDO, que no es lo
 * mismo que «no entró». Aquí un `verify().catch(() => null)` los confundía, y
 * justo en los escenarios en que el primer envío pudo entrar sin respuesta —503
 * sostenido (Aster: «the execution status is UNKNOWN and could have been a
 * success»), 429, nonce rechazado, `getRecentFills` caído en Lighter— se
 * mandaba la misma orden otra vez. Una MARKET ya ejecutada no está entre las
 * abiertas: la segunda DOBLABA la posición (001/F-68). Se lanza con
 * `estadoDesconocido`, y quien llama NO debe volver a mandarla hasta saberlo: el
 * motor deja su fila pendiente, que veta el reenvío hasta que la sincronización
 * con el venue la resuelva o venza (spec 057, F-06). Marcarla rechazada, como
 * se hacía, dejaba que el tick siguiente la mandara otra vez.
 *
 * Tras el ÚLTIMO intento fallido también se pregunta: antes se lanzaba sin más,
 * y ese intento podía haber entrado igual que los anteriores.
 */
export async function withWriteRetry<T>(
  send: () => Promise<T>,
  verify: () => Promise<T | null>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 300;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await send();
    } catch (e) {
      lastError = e;
      if (!isRetryable(e)) break;

      let landed: T | null;
      try {
        landed = await verify();
      } catch (verifyError) {
        const original = toExchangeError(lastError, opts.venue);
        throw new ExchangeError(
          original.kind,
          `Estado desconocido tras «${original.message}»: la comprobación de si la orden entró ` +
            `también falló (${messageOf(verifyError)}). No se reenvía hasta saberlo.`,
          opts.venue,
          undefined,
          true,
        );
      }
      if (landed !== null) return landed;
      if (i === attempts - 1) break;

      await sleep(base * 2 ** i);
    }
  }
  throw toExchangeError(lastError, opts.venue);
}
