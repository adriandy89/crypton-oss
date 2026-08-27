import {
  BacktestSource,
  CANDLE_INTERVALS,
  ExchangeError,
  SourceMarketType,
  externalSymbol,
  type Candle,
  type CandleInterval,
} from '@crypton/shared';
import { finishCandles, num, numOrNull } from '../candles';
import { getJson } from './http';
import type { HistoryPageQuery, HistoryProvider, HistoryProviderConfig } from './types';

/**
 * Velas históricas de Binance.
 *
 * Sin clave: `/api/v3/klines` y `/fapi/v1/klines` son públicos. Mil velas por
 * petición, peso 2 sobre un presupuesto de 1200 por minuto — treinta días en 5m
 * son nueve peticiones, un 1,5 % de la cuota— y ese presupuesto NO lo comparte
 * con los bots: `VenueBudget` está tipado por el enum `Venue` y no cubre a
 * Binance, así que un backtest no puede quitarle caudal a una cancelación.
 *
 * Su histórico es profundo de verdad: comprobado, `BTCUSDT` empieza en agosto de
 * 2017 y las velas de 15m de hace 1500 días siguen ahí.
 *
 * El riesgo real es el HTTP 451 desde IPs de datacenter. No es teórico —Binance
 * bloquea territorios enteros— pero tampoco es lo que pasa hoy: desde España
 * responde 200 en menos de 300 ms. Por eso hay un segundo proveedor y no un
 * proveedor único.
 */
export class BinanceHistory implements HistoryProvider {
  readonly id = BacktestSource.BINANCE;

  /**
   * TODOS los del sistema, y la traducción es la identidad.
   *
   * El vocabulario de Binance (`1m`, `3m`, `8h`, `3d`…) es un SUPERCONJUNTO de
   * `CANDLE_INTERVALS`, así que no hace falta tabla de mapeo. Conviene decirlo
   * en voz alta porque lo primero que hace cualquiera es escribir una.
   */
  readonly intervals: readonly CandleInterval[] = CANDLE_INTERVALS;

  readonly maxBarsPerRequest = 1000;

  /** Ni contado ni perpetuos sirven velas de índice: `INDEX` queda fuera. */
  readonly marketTypes = [SourceMarketType.PERP, SourceMarketType.SPOT] as const;

  constructor(private readonly config: HistoryProviderConfig) {}

  symbolFor(base: string, _marketType: SourceMarketType, override?: string | null): string {
    return externalSymbol(base, override);
  }

  async page(q: HistoryPageQuery): Promise<Candle[]> {
    if (!this.marketTypes.includes(q.marketType as never)) {
      throw new ExchangeError('RULES', `Binance no sirve velas de ${q.marketType}.`);
    }

    const base =
      q.marketType === SourceMarketType.SPOT
        ? `${this.config.spotUrl}/api/v3/klines`
        : `${this.config.perpUrl}/fapi/v1/klines`;

    const url =
      `${base}?symbol=${encodeURIComponent(q.symbol)}` +
      `&interval=${q.interval}` +
      `&startTime=${q.startMs}` +
      `&endTime=${q.endMs}` +
      `&limit=${Math.min(q.limit, this.maxBarsPerRequest)}`;

    const rows = await getJson<BinanceKline[]>(url, this.config.timeoutMs, q.signal);
    if (!Array.isArray(rows)) return [];

    return finishCandles(
      rows.map((r) => ({
        t: Number(r[0]),
        o: num(r[1]),
        h: num(r[2]),
        l: num(r[3]),
        c: num(r[4]),
        v: numOrNull(r[5]),
      })),
      q.limit,
    );
  }
}

/** `[openTime, o, h, l, c, v, closeTime, …]`. Solo se usan los seis primeros. */
type BinanceKline = [number, string, string, string, string, string, ...unknown[]];
