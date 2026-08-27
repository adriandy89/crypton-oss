import {
  ExchangeError,
  candleSpanMs,
  type Candle,
  type CandleInterval,
  type SourceMarketType,
} from '@crypton/shared';
import { finishCandles } from '../candles';
import type { HistoryProvider } from './types';

/**
 * Tope duro de páginas, independiente de cuántas barras pida el llamante.
 *
 * Es el freno de última instancia: aunque alguien pida un rango absurdo y el
 * tope de barras falle, esto acota el número de llamadas a la fuente.
 */
export const MAX_HISTORY_PAGES = 120;

export interface PaginateRequest {
  provider: HistoryProvider;
  symbol: string;
  interval: CandleInterval;
  marketType: SourceMarketType;
  fromMs: number;
  toMs: number;
  /** Tope de barras. Por encima se corta y se devuelve lo que haya.  */
  barCap: number;
  /** Espaciado mínimo entre peticiones, para no atragantar a la fuente. */
  gapMs?: number;
  signal?: AbortSignal;
  /** Se llama con cada página aceptada. Sirve para ir informando del avance. */
  onPage?: (bars: number, total: number) => void;
  /** Lee una página de la caché; `undefined` = no está. */
  readCache?: (key: string) => Promise<Candle[] | undefined>;
  /** Guarda una página. Solo se llama con ventanas CERRADAS. */
  writeCache?: (key: string, page: Candle[]) => Promise<void>;
  now?: number;
}

export interface PaginateResult {
  candles: Candle[];
  pages: number;
  /** Barras que faltan dentro del rango: delistings, paradas del mercado… */
  barsMissing: number;
  /** El hueco más largo, en ms. Cero si la serie es continua. */
  largestGapMs: number;
}

/**
 * Recorre el rango hacia delante, página a página.
 *
 * Dos guardias que no son opcionales, y conviene decir por qué:
 *
 *   · El cursor se ALINEA a `floor(from/span)*span`. Sin eso, dos peticiones del
 *     mismo rango con un milisegundo de diferencia generan claves de caché
 *     distintas y la caché no acierta nunca — es decoración cara.
 *   · Si una página no hace avanzar el cursor, se corta. Un proveedor que
 *     devuelva la misma ventana convierte esto en un bucle infinito DENTRO de
 *     una petición HTTP, y eso ha pasado en más de un backtester.
 *
 * Los huecos se CONSERVAN, nunca se rellenan: inventar precios haría que el
 * motor colocara órdenes contra velas que no existieron. Se cuentan y se avisan.
 */
export async function paginateHistory(req: PaginateRequest): Promise<PaginateResult> {
  const span = candleSpanMs(req.interval);
  const ahora = req.now ?? Date.now();
  const perPage = Math.min(req.provider.maxBarsPerRequest, req.barCap);

  if (!req.provider.intervals.includes(req.interval)) {
    throw new ExchangeError(
      'RULES',
      `${req.provider.id} no sirve velas de ${req.interval}. Intervalos disponibles: ` +
        req.provider.intervals.join(', ') +
        '.',
    );
  }

  let cursor = Math.floor(req.fromMs / span) * span;
  const fin = Math.min(req.toMs, ahora);
  const bars: Candle[] = [];
  let pages = 0;

  while (cursor < fin && pages < MAX_HISTORY_PAGES && bars.length < req.barCap) {
    if (req.signal?.aborted) break;

    const hasta = Math.min(cursor + span * perPage, fin);
    const key = `${req.provider.id}:${req.marketType}:${req.symbol}:${req.interval}:${cursor}:${perPage}`;

    let page = await req.readCache?.(key);
    if (page === undefined) {
      page = await req.provider.page({
        symbol: req.symbol,
        interval: req.interval,
        marketType: req.marketType,
        startMs: cursor,
        endMs: hasta,
        limit: perPage,
        signal: req.signal,
      });
      // Solo se guarda una ventana CERRADA. Una que toca el borde vivo cambiaría
      // debajo, y cachearla congelaría la última vela.
      if (req.writeCache && hasta < ahora - span) await req.writeCache(key, page);
      if (req.gapMs && req.gapMs > 0) await esperar(req.gapMs);
    }

    // Sin datos: se acabó el histórico de la fuente para este par.
    if (page.length === 0) break;

    bars.push(...page);
    pages += 1;
    req.onPage?.(page.length, bars.length);

    const siguiente = page[page.length - 1].t + span;
    // GUARDIA: una página que no avanza es un bucle infinito.
    if (siguiente <= cursor) break;
    cursor = siguiente;
  }

  const candles = finishCandles(bars, req.barCap);
  return { candles, pages, ...gapsOf(candles, span) };
}

/** Cuenta lo que falta dentro de la serie, sin rellenar nada. */
function gapsOf(candles: Candle[], span: number): { barsMissing: number; largestGapMs: number } {
  let barsMissing = 0;
  let largestGapMs = 0;
  for (let i = 1; i < candles.length; i++) {
    const hueco = candles[i].t - candles[i - 1].t;
    if (hueco > span) {
      barsMissing += Math.round(hueco / span) - 1;
      if (hueco > largestGapMs) largestGapMs = hueco;
    }
  }
  return { barsMissing, largestGapMs };
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
