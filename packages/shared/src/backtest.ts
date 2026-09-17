import type { Candle, CandleInterval } from './candle';
import type {
  BacktestSource,
  LevelKind,
  OrderSide,
  SourceMarketType,
  StrategyKind,
  Venue,
} from './enums';

/**
 * El contrato de un backtest: lo que se pide y lo que sale.
 *
 * Vive en `shared` y no en el paquete del motor porque lo consume también la app
 * Angular, que solo puede importar de aquí — `@crypton/backtest` arrastraría el
 * motor entero y sus dependencias al bundle del móvil.
 *
 * TODO el dinero viaja como cadena, nunca como `number`. Es la misma regla que
 * `MarketSpec` y `Candle` documentan: un `number` de JavaScript no representa
 * exactamente 0,1, y una cifra que ha pasado por coma flotante ya no se puede
 * comparar con el tick del venue.
 */

/** Cómo se supone que se recorrió el interior de cada vela. */
export const BarPath = {
  /**
   * Apertura → el extremo MÁS CERCANO a la apertura → el otro → cierre.
   *
   * Es la convención del emulador de TradingView y la más plausible. Una vela no
   * dice si el máximo llegó antes que el mínimo, así que esto es una hipótesis,
   * no un dato: en velas de un minuto el error es pequeño, en velas diarias es
   * enorme.
   */
  NEAREST_FIRST: 'NEAREST_FIRST',
  /**
   * El extremo que MÁS duele primero: si la vela cierra al alza, primero el
   * mínimo. Sirve para estresar un resultado que parece demasiado bueno.
   */
  PESSIMISTIC: 'PESSIMISTIC',
} as const;
export type BarPath = (typeof BarPath)[keyof typeof BarPath];

export interface BacktestParams {
  startingBalance: string;
  leverage: number;
  marginMode: string;
  makerFeeRate: string;
  takerFeeRate: string;
  slippageRate: string;
  maintenanceMarginRate: number;
  /** Diferencial sintético del libro. Cambia mucho a un market maker. */
  spreadBps: number;
  barPath: BarPath;
}

export interface BacktestMeta {
  botId: string | null;
  botName: string | null;
  strategy: StrategyKind;
  venue: Venue;
  symbol: string;
  configVersion: number | null;
  source: BacktestSource;
  /** El símbolo que se pidió DE VERDAD a la fuente. */
  sourceSymbol: string;
  marketType: SourceMarketType;
  interval: CandleInterval;
  fromMs: number;
  toMs: number;
  generatedAt: number;
  durationMs: number;
}

export interface BacktestEquityPoint {
  t: number;
  equity: string;
  /** Posición firmada en ese momento. Negativa = corto. */
  position: string;
  /** Caída desde el máximo anterior, en %. Siempre ≤ 0. */
  ddPct: string;
}

export interface BacktestFillView {
  ts: number;
  side: OrderSide;
  price: string;
  qty: string;
  fee: string;
  isTaker: boolean;
  levelKind: LevelKind | 'LIQUIDATION' | null;
  levelIndex: number | null;
  cycleSeq: number;
  positionAfter: string;
  realizedAccAfter: string;
  liquidation: boolean;
}

export interface BacktestCycleView {
  seq: number;
  openedAt: number;
  closedAt: number | null;
  entries: number;
  averageEntry: string | null;
  exitAvg: string | null;
  realizedPnl: string;
  fees: string;
}

export interface BacktestMetrics {
  startingBalance: string;
  endingEquity: string;
  netPnl: string;
  netPnlPct: string;
  realizedPnl: string;
  unrealizedPnlAtEnd: string;
  feesPaid: string;

  maxDrawdown: string;
  maxDrawdownPct: string;
  maxDrawdownAt: number | null;
  peakEquity: string;
  peakEquityAt: number | null;

  cyclesClosed: number;
  cyclesOpenAtEnd: number;
  winRatePct: string | null;
  avgCycleMs: number | null;

  fills: number;
  buyFills: number;
  sellFills: number;
  makerFills: number;
  takerFills: number;
  /** El «grid profit»: diferencial capturado ANTES de comisiones. */
  grossMatchedProfit: string;
  liquidations: number;

  peakPositionQty: string;
  peakNotional: string;
  timeInMarketPct: string;

  /**
   * Lo que habría dado comprar y mantener el mismo periodo.
   *
   * Va SIEMPRE al lado del resultado, y no es cortesía: un `+8 %` en un mercado
   * que subió un `40 %` parece un éxito hasta que se ve al lado.
   */
  buyAndHoldPct: string;

  bars: number;
  ticks: number;
  barsMissing: number;
  largestGapMs: number;
}

/** Cómo terminó una operación del canal con IA (spec 058). */
export type SalidaOperacion = 'OBJETIVO' | 'STOP' | 'CIERRE' | 'LIQUIDACION';

/**
 * Una operación del canal con IA en el replay (spec 058): lo que se planeó y lo
 * que salió. El resultado va en USDC, neto de comisiones, y en R: el riesgo que
 * la operación declaró al entrar.
 */
export interface BacktestOperacionView {
  setup: string;
  lado: 'LONG' | 'SHORT';
  candidatoId: string;
  entradaEn: number;
  salidaEn: number;
  precioEntrada: string;
  precioSalida: string;
  stop: string;
  /** Los precios de sus objetivos, del primero al último. */
  objetivos: string[];
  apalancamiento: number;
  riesgo: string;
  resultado: string;
  r: number;
  rPlaneado: number;
  salida: SalidaOperacion;
}

/**
 * Las cifras de un setup en el replay (spec 058), con las mismas medidas que
 * las tasas base que ve la IA. Los cocientes son adimensionales y van en
 * `number`; el dinero, en cadena.
 */
export interface BacktestSetupMetrics {
  setup: string;
  lado: 'LONG' | 'SHORT';
  n: number;
  aciertos: number;
  /** Límite inferior de Wilson (95 %) de la tasa de aciertos. */
  wilsonInferior: number;
  rMedio: number;
  /** Resultado medio por operación, en USDC. */
  esperanza: string;
  /** Ganado entre perdido; null sin pérdidas. */
  factorBeneficio: number | null;
  resultado: string;
}

/** Un tramo del rango con sus cifras: se miran juntos para ver si el resultado se sostiene. */
export interface BacktestVentana {
  desde: number;
  hasta: number;
  operaciones: number;
  resultado: string;
  rTotal: number;
  porSetup: BacktestSetupMetrics[];
}

export interface BacktestResult {
  meta: BacktestMeta;
  params: BacktestParams;
  metrics: BacktestMetrics;
  /**
   * Curva de equity ya remuestreada.
   *
   * El drawdown máximo se calcula sobre la serie COMPLETA, antes de remuestrear:
   * al revés, el remuestreo escondería justo el peor momento, que es el número
   * que más importa.
   */
  equity: BacktestEquityPoint[];
  /** Velas para el gráfico, agregadas (no muestreadas: se perderían las mechas). */
  candles: Candle[];
  fills: BacktestFillView[];
  fillsTruncated: boolean;
  cycles: BacktestCycleView[];
  /** Solo las estrategias que registran operaciones: el canal con IA (spec 058). */
  operaciones?: BacktestOperacionView[];
  porSetup?: BacktestSetupMetrics[];
  /** El rango partido en tramos consecutivos (`ventanasConsecutivas`). */
  ventanas?: BacktestVentana[];
  /** Redactados en español y listos para pintar. Ver `FIDELITY_WARNINGS`. */
  warnings: string[];
}
