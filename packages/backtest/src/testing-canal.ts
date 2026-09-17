/**
 * Un mercado sintético para los tests del canal con IA en el replay (spec 058).
 * Solo lo importan los specs.
 *
 * Son velas de 5 min cuyo agregado a 15 min y a 1 h reconoce el motor del canal:
 * primero una tendencia —para que las medidas de 1 h tengan con qué compararse—
 * y después un rango que oscila como un seno de periodo 2 h. En cada valle y
 * cada cresta el precio toca un borde con el RSI extremo, que es un rebote listo.
 * Los ciclos de `rupturas` siguen bajando al final: son los stops.
 */
import {
  BarPath,
  StrategyKind,
  Venue,
  type BacktestParams,
  type BotConfig,
  type Candle,
  type MarketSpec,
} from '@crypton/shared';
import { getStrategy } from '@crypton/strategy-core';

export const CINCO_MIN = 300_000;
export const DESDE_CANAL = Date.UTC(2026, 6, 1);
export const HORAS_TENDENCIA = 300;
/** Lo que se da como calentamiento: la tendencia y las diez primeras horas del rango. */
export const HORAS_CALENTAMIENTO = HORAS_TENDENCIA + 10;
export const BOT_CANAL = '9c8d7e6f-0000-4000-8000-000000000000';

export function velaSintetica(t: number, abre: number, cierra: number, mecha = 0.05): Candle {
  return {
    t,
    o: abre.toFixed(4),
    h: (Math.max(abre, cierra) + mecha).toFixed(4),
    l: (Math.min(abre, cierra) - mecha).toFixed(4),
    c: cierra.toFixed(4),
    v: '10',
  };
}

export interface OpcionesMercadoCanal {
  horasRango: number;
  rupturas?: readonly number[];
  semilla?: number;
}

/** Las velas enteras, calentamiento incluido. Deterministas por la semilla. */
export function mercadoCanal(o: OpcionesMercadoCanal): Candle[] {
  let x = o.semilla ?? 12345;
  const azar = (): number => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
  const periodo = 24;
  const velas: Candle[] = [];
  let t = DESDE_CANAL;
  let p = 100;
  for (let i = 0; i < HORAS_TENDENCIA * 12; i++) {
    const deriva = Math.floor(i / 12 / 60) % 2 === 0 ? 0.35 / 12 : -0.3 / 12;
    const abre = p;
    p += deriva + (azar() - 0.5) * 0.15;
    velas.push(velaSintetica(t, abre, p));
    t += CINCO_MIN;
  }
  const centro = p;
  const rupturas = new Set(o.rupturas ?? []);
  let desvio = 0;
  let caida = 0;
  for (let j = 0; j < o.horasRango * 12; j++) {
    const ciclo = Math.floor(j / periodo);
    if (rupturas.has(ciclo) && j % periodo >= periodo * 0.7) caida += 0.12;
    else caida *= 0.8;
    desvio = 0.5 * desvio + (azar() - 0.5) * 0.04;
    const abre = p;
    p = centro + 0.8 * Math.sin((2 * Math.PI * j) / periodo) + desvio - caida;
    velas.push(velaSintetica(t, abre, p));
    t += CINCO_MIN;
  }
  return velas;
}

/** El mismo mercado partido en calentamiento y rango reproducido. */
export function partirCanal(velas: readonly Candle[]): { warmup: Candle[]; candles: Candle[] } {
  const corte = HORAS_CALENTAMIENTO * 12;
  return { warmup: velas.slice(0, corte), candles: velas.slice(corte) };
}

export const MERCADO_CANAL: MarketSpec = {
  venue: Venue.HYPERLIQUID,
  symbol: 'SOL',
  canonical: 'SOL/USDC',
  base: 'SOL',
  quote: 'USDC',
  tickSize: '0.01',
  stepSize: '0.001',
  minNotional: '10',
  minQty: null,
  maxQty: null,
  maxLeverage: 20,
  priceDecimals: 2,
  qtyDecimals: 3,
  active: true,
};

/** Las comisiones del simulador, iguales a las que la estrategia usa en sus cuentas. */
export const COSTES_CANAL = { makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 };

export const PARAMS_CANAL: BacktestParams = {
  startingBalance: '1000',
  leverage: 20,
  marginMode: 'ISOLATED',
  makerFeeRate: '0.00015',
  takerFeeRate: '0.00045',
  slippageRate: '0.0002',
  maintenanceMarginRate: 0.025,
  spreadBps: 2,
  barPath: BarPath.NEAREST_FIRST,
};

export function configCanal(extra: Record<string, unknown> = {}): BotConfig {
  return {
    ...getStrategy(StrategyKind.AI_CHANNEL).defaults(),
    exchangeAccountId: 'acc-1',
    symbol: 'SOL',
    totalInvestment: '1000',
    leverage: 20,
    marginMode: 'ISOLATED',
    direction: 'NEUTRAL',
    makerFeeBps: String(COSTES_CANAL.makerBps),
    takerFeeBps: String(COSTES_CANAL.takerBps),
    slippageBps: String(COSTES_CANAL.deslizamientoBps),
    ...extra,
  };
}
