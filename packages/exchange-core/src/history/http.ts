import { ExchangeError } from '@crypton/shared';

/**
 * El HTTP de los proveedores de histórico, con sus errores ya clasificados.
 *
 * Se usa `fetch` nativo y no un cliente: el repo no tiene ninguno y es
 * deliberado —los adaptadores de venue ya hablan así—, y añadir una dependencia
 * para dos peticiones GET es peor negocio que estas veinte líneas.
 *
 * Lo que sí importa es que el 451 y el 429 NO se confundan con «la red va mal»:
 * son las dos formas en que un proveedor público se cierra, se arreglan de
 * maneras distintas, y un mensaje genérico manda al operador a buscar donde no
 * es. Es el mismo criterio que se aplicó al feed de precio en vivo.
 */
export async function getJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const propio = new AbortController();
  const timer = setTimeout(() => propio.abort(), timeoutMs);
  const onAbort = () => propio.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(url, { signal: propio.signal });
    if (!res.ok) throw historyHttpError(res.status, url);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ExchangeError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new ExchangeError('RETRYABLE', `La fuente de histórico no respondió en ${timeoutMs} ms.`);
    }
    throw new ExchangeError('RETRYABLE', `No se pudo hablar con la fuente de histórico: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Traduce el estado HTTP al error que el usuario tiene que leer. */
export function historyHttpError(status: number, url: string): ExchangeError {
  const host = hostOf(url);

  // 451 es «no disponible por razones legales»: el bloqueo por territorio. Es el
  // fallo MÁS probable en un datacenter y el que peor se diagnostica solo, así
  // que su mensaje dice exactamente qué mirar.
  if (status === 451) {
    return new ExchangeError(
      'RULES',
      `${host} no atiende peticiones desde la IP de este servidor (bloqueo por ` +
        'territorio). Prueba con el otro proveedor de histórico o apunta la ' +
        'variable de entorno correspondiente a un espejo.',
    );
  }

  // 429 avisa, 418 es el baneo automático que llega tras ignorarlo, 403 es el
  // WAF. Los tres se arreglan esperando.
  if (status === 429 || status === 418 || status === 403) {
    return new ExchangeError('THROTTLED', `${host} está limitando nuestras peticiones (HTTP ${status}).`);
  }

  if (status === 400 || status === 404) {
    return new ExchangeError('RULES', `${host} no reconoce la petición (HTTP ${status}).`);
  }

  return new ExchangeError('RETRYABLE', `${host} respondió HTTP ${status}.`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'La fuente de histórico';
  }
}
