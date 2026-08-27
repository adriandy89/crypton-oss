import {
  D,
  ExchangeError,
  candleSpanMs,
  isFiniteNum,
  type Candle,
  type CandleInterval,
  type Venue,
  type VenueCapabilities,
} from '@crypton/shared';
import type { CandleQuery } from './types';

/**
 * Utilidades compartidas por los tres adaptadores de velas.
 *
 * Están aquí y no repetidas en cada uno porque los tres cometen los mismos
 * errores si se les deja: devolver la serie desordenada, colar la vela en
 * formación dos veces, o ignorar el `limit` y traer cinco mil velas para
 * pintar doscientas.
 */

/**
 * Comprueba el intervalo contra la lista del venue y lo DEVUELVE estrechado a
 * ella.
 *
 * Devolver en vez de solo comprobar no es un capricho de estilo: los SDK de
 * Hyperliquid y de Lighter tipan su parámetro con su propia lista, más corta
 * que la unión del sistema. Con una función que solo valida, el compilador
 * sigue viendo el tipo ancho y hay que poner un `as` —que es exactamente el
 * sitio donde un intervalo no soportado se colaría sin que nadie lo note—.
 * Así la comprobación de ejecución y la del compilador son la misma línea.
 */
export function checkInterval<T extends CandleInterval>(
  venue: Venue,
  intervals: readonly T[],
  interval: CandleInterval,
): T {
  if ((intervals as readonly CandleInterval[]).includes(interval)) return interval as T;
  // RULES y no FATAL: no es un fallo del venue ni de la red, es una petición
  // que incumple una regla conocida de antemano. Así no se reintenta sola.
  throw new ExchangeError(
    'RULES',
    `${venue} no sirve velas de ${interval}. Intervalos disponibles: ` +
      intervals.join(', ') +
      '.',
    venue,
  );
}

/**
 * Normaliza el rango pedido: acota el número de velas al máximo del venue y
 * calcula un `startMs` coherente cuando el llamante solo da `limit`.
 *
 * El `+1` de `startMs` no es un despiste: la última vela está en formación y
 * casi todos los venues la incluyen, así que pedir exactamente `limit` velas
 * devuelve `limit - 1` cerradas. Se pide una de más y el tope se aplica al
 * final.
 */
export function resolveRange(
  interval: CandleInterval,
  query: CandleQuery,
  maxBars: number,
  now = Date.now(),
): { startMs: number; endMs: number; limit: number } {
  const span = candleSpanMs(interval);
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? maxBars)), maxBars);
  const endMs = query.endMs ?? now;
  const startMs = query.startMs > 0 ? query.startMs : endMs - span * (limit + 1);
  return { startMs: Math.min(startMs, endMs), endMs, limit };
}

/**
 * Ordena por tiempo, quita duplicados y aplica el tope quedándose con las
 * MÁS RECIENTES.
 *
 * Recortar por el otro extremo es el error clásico: se pide un rango amplio
 * para tener contexto y el recorte deja el gráfico terminado hace tres días.
 */
export function finishCandles(candles: Candle[], limit: number): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (!Number.isFinite(c.t)) continue;
    byTime.set(c.t, c);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
  return sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
}

/**
 * Convierte a string un numérico que puede llegar como number.
 *
 * Lighter sirve las velas como `number`; el resto del sistema trata los
 * precios como string decimal exacto. Sin esta conversión un precio con
 * dieciocho decimales se degrada en silencio y deja de casar con el tick del
 * venue — el mismo fallo que `precision.ts` evita en el resto del paquete.
 */
export function num(value: number | string | null | undefined): string {
  // `isFiniteNum` y no una comprobacion de null: los venues dicen «no hay
  // dato» de varias formas y la CADENA VACIA es una de ellas —Lighter la manda
  // en el mejor bid/ask de un libro vacio—. Con el null-check a secas, `''`
  // llegaba a `new Decimal('')`, que LANZA, y el fallo subia hasta tumbar el
  // tick del bot entero.
  if (!isFiniteNum(value)) return '0';
  return D(value as number | string).toFixed();
}

/** Igual que `num`, pero conserva la ausencia en vez de convertirla en cero. */
export function numOrNull(value: number | string | null | undefined): string | null {
  if (!isFiniteNum(value)) return null;
  return D(value as number | string).toFixed();
}

/**
 * Cambio porcentual entre dos precios. null si el de referencia no sirve:
 * dividir por cero produciría `Infinity` y la UI pintaría «+∞ %».
 */
export function changePct(last: string, previous: string | null): string | null {
  if (previous === null) return null;
  const prev = D(previous);
  if (!prev.isFinite() || prev.lte(0)) return null;
  return D(last).minus(prev).div(prev).times(100).toFixed(4);
}

/** Construye las capacidades de un venue con la forma que espera la interfaz. */
export function capabilitiesOf(
  venue: Venue,
  intervals: readonly CandleInterval[],
  maxBars: number,
  live: boolean,
  history: { maxHistoryPages: number; minPageGapMs: number },
): VenueCapabilities {
  return {
    venue,
    candles: { intervals: [...intervals], maxBars, live, ...history },
  };
}
