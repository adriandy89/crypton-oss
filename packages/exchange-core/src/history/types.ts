import type { BacktestSource, Candle, CandleInterval, SourceMarketType } from '@crypton/shared';

/**
 * Un proveedor de velas históricas AJENO a los venues donde operan los bots.
 *
 * Existe porque los tres DEX no guardan pasado suficiente: Hyperliquid corta en
 * las últimas 5000 velas del intervalo —tres días y medio en 1m, cincuenta y dos
 * en 15m—, comprobado contra su API. Para reproducir treinta días de una rejilla
 * hay que ir a otro sitio, y da igual cuál mientras el par sea el mismo.
 *
 * El contrato es deliberadamente pequeño: traducir un HTTP en `Candle[]`. Quien
 * pagina, cachea y marca el ritmo es el servicio que los usa — el mismo reparto
 * que ya tienen `MarketDataService` y los adaptadores de venue.
 */
export interface HistoryProvider {
  readonly id: BacktestSource;
  /** Intervalos que sirve, EN EL VOCABULARIO DEL SISTEMA. */
  readonly intervals: readonly CandleInterval[];
  /** Velas por petición. Binance y Bybit dan 1000. */
  readonly maxBarsPerRequest: number;
  /** Tipos de mercado que soporta. Ninguno de los dos sirve velas de índice. */
  readonly marketTypes: readonly SourceMarketType[];

  /**
   * El símbolo tal y como lo espera ESTE proveedor.
   *
   * `override` es el «símbolo de origen alternativo» que ya existe para el feed
   * de precio en vivo: la base del venue no siempre casa con `<BASE>USDT`
   * —`kPEPE` allí es `1000PEPEUSDT`— y el usuario lo escribe a mano.
   */
  symbolFor(base: string, marketType: SourceMarketType, override?: string | null): string;

  /** UNA página, ascendente por tiempo y ya normalizada. */
  page(q: HistoryPageQuery): Promise<Candle[]>;
}

export interface HistoryPageQuery {
  symbol: string;
  interval: CandleInterval;
  marketType: SourceMarketType;
  startMs: number;
  endMs: number;
  limit: number;
  signal?: AbortSignal;
}

/** Lo que hace falta para hablar con un proveedor por HTTP. */
export interface HistoryProviderConfig {
  /** Host del mercado de contado. */
  spotUrl: string;
  /** Host del mercado de perpetuos. En Bybit es el mismo. */
  perpUrl: string;
  timeoutMs: number;
}
