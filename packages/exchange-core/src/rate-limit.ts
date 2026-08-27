import { isRetryable, toExchangeError } from './errors';
import type { Venue } from '@crypton/shared';

/**
 * Limitador de caudal.
 *
 * Es una cola FIFO con ventana deslizante: suficiente para el caudal de un
 * motor de bots y sin dependencias.
 *
 * El ÁMBITO importa y no lo decide este fichero. Los límites de los venues son
 * por cuenta y por IP, nunca por bot, así que un limitador por bot —que es lo
 * que había— multiplicaba el caudal real por el número de bots: diez bots de
 * una misma cuenta a 8/s mandaban 80/s contra un límite de 8/s. Quien crea el
 * limitador es responsable de compartirlo entre los bots que compartan cuenta;
 * ver `AccountHub` en el worker.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private queue: Promise<void> = Promise.resolve();
  private lastRun = 0;

  constructor(perSecond: number) {
    this.intervalMs = perSecond > 0 ? 1000 / perSecond : 0;
  }

  /** Encola `fn` respetando el caudal. Preserva el orden de llamada. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const wait = this.lastRun + this.intervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRun = Date.now();
      return fn();
    });
    // La cola avanza pase lo que pase: si un fallo la rompiera, el adaptador
    // dejaría de mandar órdenes para siempre sin ningún error visible.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
      if (!isRetryable(e) || i === attempts - 1) break;

      const landed = await verify().catch(() => null);
      if (landed !== null) return landed;

      await sleep(base * 2 ** i);
    }
  }
  throw toExchangeError(lastError, opts.venue);
}
