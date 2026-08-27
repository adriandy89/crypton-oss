import {
  BacktestSource,
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
 * Velas históricas de Bybit. El respaldo cuando Binance no está disponible.
 *
 * Existe por el 451: Binance bloquea territorios y, sobre todo, rangos de IP de
 * datacenter. Tener un solo proveedor público significaría que el backtest deja
 * de funcionar el día que la instalación cambie de proveedor de nube.
 *
 * Dos diferencias con Binance que se absorben AQUÍ y no fuera:
 *
 *   · Sus intervalos son minutos en crudo más `D`/`W`/`M`, y **no tiene `8h` ni
 *     `3d`**. Cualquiera de los dos hay que rechazarlo antes de salir a la red.
 *   · Devuelve la lista en orden INVERSO. `finishCandles` lo arreglaría de todas
 *     formas, pero darle la vuelta explícitamente evita la sorpresa a quien lea
 *     esto buscando por qué la primera vela es la más nueva.
 */
export class BybitHistory implements HistoryProvider {
  readonly id = BacktestSource.BYBIT;

  /** Los del sistema MENOS `8h` y `3d`, que Bybit no tiene. Y `1M` es `M`. */
  readonly intervals: readonly CandleInterval[] = [
    '1m',
    '3m',
    '5m',
    '15m',
    '30m',
    '1h',
    '2h',
    '4h',
    '6h',
    '12h',
    '1d',
    '1w',
    '1M',
  ];

  readonly maxBarsPerRequest = 1000;
  readonly marketTypes = [SourceMarketType.PERP, SourceMarketType.SPOT] as const;

  constructor(private readonly config: HistoryProviderConfig) {}

  symbolFor(base: string, _marketType: SourceMarketType, override?: string | null): string {
    return externalSymbol(base, override);
  }

  async page(q: HistoryPageQuery): Promise<Candle[]> {
    if (!this.marketTypes.includes(q.marketType as never)) {
      throw new ExchangeError('RULES', `Bybit no sirve velas de ${q.marketType}.`);
    }

    const interval = BYBIT_INTERVAL[q.interval];
    if (!interval) {
      throw new ExchangeError(
        'RULES',
        `Bybit no sirve velas de ${q.interval}. Intervalos disponibles: ` +
          this.intervals.join(', ') +
          '.',
      );
    }

    const category = q.marketType === SourceMarketType.SPOT ? 'spot' : 'linear';
    const url =
      `${this.config.spotUrl}/v5/market/kline` +
      `?category=${category}` +
      `&symbol=${encodeURIComponent(q.symbol)}` +
      `&interval=${interval}` +
      `&start=${q.startMs}` +
      `&end=${q.endMs}` +
      `&limit=${Math.min(q.limit, this.maxBarsPerRequest)}`;

    const body = await getJson<BybitKlineResponse>(url, this.config.timeoutMs, q.signal);

    // Bybit responde 200 con el error dentro del cuerpo, así que un `res.ok` no
    // basta para saber si salió bien.
    if (body.retCode !== 0) {
      throw new ExchangeError('RULES', `Bybit rechazó la petición: ${body.retMsg ?? body.retCode}`);
    }

    const list = body.result?.list ?? [];
    return finishCandles(
      // Al revés: Bybit sirve de la más nueva a la más vieja.
      [...list].reverse().map((r) => ({
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

/**
 * Del vocabulario del sistema al de Bybit.
 *
 * `8h` y `3d` no están porque Bybit no los tiene, y esa ausencia es la que hace
 * que `page()` los rechace con la lista de los que sí — en vez de mandar un
 * intervalo inventado y recibir un 400 opaco.
 */
const BYBIT_INTERVAL: Partial<Record<CandleInterval, string>> = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': 'D',
  '1w': 'W',
  '1M': 'M',
};

interface BybitKlineResponse {
  retCode: number;
  retMsg?: string;
  result?: { list?: string[][] };
}
