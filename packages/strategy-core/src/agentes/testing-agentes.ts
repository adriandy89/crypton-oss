/**
 * Series y entradas sintéticas para los tests de los agentes (spec 074). Solo
 * las importan los specs, como `../canal/testing-canal.ts`.
 *
 * Las series son deterministas —fórmulas y un generador con semilla—, y cada
 * una hace disparar una familia en los dos lados: los tests buscan la vela en
 * la que dispara y cortan la serie ahí, así que la última vela cerrada es la
 * de la señal, como en vivo.
 */
import {
  Venue,
  candleSpanMs,
  type Candle,
  type FamiliaAgente,
  type IntervaloAgente,
  type LimitesAgente,
  type MarketSpec,
  type Ticker,
} from '@crypton/shared';
import { mulberry32 } from '../canal/testing-canal';
import { serieNumerica } from '../canal/numeros';
import { makeMarket } from '../testing';
import { detectarFamilias } from './familias';
import type { EntradaAgente, HistorialAgente, ParAgente } from './herramienta';
import { DEFAULTS_AGENTE } from './limites';
import { MIN_VELAS_AGENTE, indicadoresAgente } from './mercado';

export const HORA = 3_600_000;
export const T0_AGENTE = Date.UTC(2026, 7, 1);

export function vela(t: number, abre: number, cierra: number, mecha: number): Candle {
  return {
    t,
    o: abre.toFixed(6),
    h: (Math.max(abre, cierra) + mecha).toFixed(6),
    l: (Math.min(abre, cierra) - mecha).toFixed(6),
    c: cierra.toFixed(6),
    v: '10',
  };
}

/** Velas de 1 h que abren en el cierre anterior, con una mecha fija a cada lado. */
export function velasDePrecios(precios: readonly number[], mecha = 0.15): Candle[] {
  const out: Candle[] = [];
  let previo = precios[0];
  for (let i = 0; i < precios.length; i++) {
    out.push(vela(T0_AGENTE + i * HORA, previo, precios[i], mecha));
    previo = precios[i];
  }
  return out;
}

/**
 * Una tendencia con retrocesos: deriva de 0,15 por vela y un seno de amplitud
 * 2 y periodo 20. Con más deriva el precio no vuelve nunca a la media rápida,
 * que es justo lo que la familia no debe tomar por un retroceso.
 */
export function serieTendencia(lado: 'LONG' | 'SHORT', n = 400): Candle[] {
  const signo = lado === 'LONG' ? 1 : -1;
  const ps: number[] = [];
  for (let i = 0; i < n; i++)
    ps.push(100 + signo * 0.15 * i + 2 * Math.sin((2 * Math.PI * i) / 20));
  return velasDePrecios(ps);
}

/** Un rango con ruido que revierte a la media (AR(1) con semilla). */
export function serieRango(semilla: number, n = 300): Candle[] {
  const azar = mulberry32(semilla);
  const ps: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    x = 0.8 * x + (azar() - 0.5) * 2.5;
    ps.push(100 + x);
  }
  return velasDePrecios(ps, 0.2);
}

/**
 * Un rango que se comprime y rompe al final hacia el lado pedido. La vela de
 * la ruptura cierra a 0,15 del borde de las 20 anteriores: dentro de lo que la
 * familia admite, que no persigue una ruptura de más de un ATR.
 */
export function serieRuptura(lado: 'LONG' | 'SHORT'): Candle[] {
  const azar = mulberry32(5);
  const ps: number[] = [];
  for (let i = 0; i < 300; i++) {
    const amplitud = i < 200 ? 2 : Math.max(0.2, 2 - (i - 200) * 0.03);
    ps.push(100 + amplitud * Math.sin(i / 2) + (azar() - 0.5) * 0.2);
  }
  const mecha = 0.1;
  const previas = velasDePrecios(ps, mecha).slice(-20);
  const borde =
    lado === 'LONG'
      ? Math.max(...previas.map((v) => Number(v.h))) + 0.15
      : Math.min(...previas.map((v) => Number(v.l))) - 0.15;
  ps.push(borde);
  return velasDePrecios(ps, mecha);
}

/** Semillas de `serieRango` que dan una reversión en cada lado (medidas, no elegidas a mano). */
export const SEMILLA_REVERSION: Readonly<Record<'LONG' | 'SHORT', number>> = {
  LONG: 4,
  SHORT: 3,
};

/**
 * La serie cortada en la primera vela en la que dispara la familia en ese
 * lado, a partir de las que el análisis necesita. Lanza si no dispara: un
 * fixture que ya no hace lo que dice tiene que romper el test, no pasarlo.
 */
export function cortarEnSenal(
  velas: readonly Candle[],
  familia: FamiliaAgente,
  lado: 'LONG' | 'SHORT',
): Candle[] {
  const s = serieNumerica(velas);
  const ind = indicadoresAgente(s);
  for (let j = MIN_VELAS_AGENTE; j < s.n; j++) {
    if (detectarFamilias(s, ind, j, [familia], [lado]).length > 0) return velas.slice(0, j + 1);
  }
  throw new Error(`La serie no da ${familia} ${lado}`);
}

/** Un instante en el que la última vela de la serie acaba de cerrar. */
export const ahoraTras = (velas: readonly Candle[], intervalo: IntervaloAgente = '1h'): number =>
  velas[velas.length - 1].t + candleSpanMs(intervalo) + 60_000;

/** Un mercado de precio 100: tick 0,01, paso 0,001, 10 USDC de mínimo y 50x. */
export function mercadoAgente(o: Partial<MarketSpec> = {}): MarketSpec {
  return makeMarket({
    symbol: 'SOL',
    canonical: 'SOL/USDC',
    base: 'SOL',
    tickSize: '0.01',
    stepSize: '0.001',
    priceDecimals: 2,
    qtyDecimals: 3,
    minNotional: '10',
    minQty: '0.001',
    maxLeverage: 50,
    maintenanceMarginRate: 0.01,
    ...o,
  });
}

/** El libro alrededor del último cierre: un tick de spread. */
export function tickerDe(velas: readonly Candle[], simbolo = 'SOL'): Ticker {
  const c = Number(velas[velas.length - 1].c);
  const bid = (Math.floor(c * 100) / 100).toFixed(2);
  const ask = (Number(bid) + 0.01).toFixed(2);
  return { venue: Venue.HYPERLIQUID, symbol: simbolo, last: bid, bid, ask, mark: bid, ts: 0 };
}

/**
 * Límites para los tests: los de fábrica con 10 000 de capital, y las puertas
 * de coste relajadas salvo que el caso las pida. Las series son de precio 100
 * con un ATR de una unidad, y con las de fábrica medirían la rentabilidad del
 * fixture en vez del cálculo, como avisa el fixture del canal.
 */
export function limitesDePrueba(o: Partial<LimitesAgente> = {}): LimitesAgente {
  return {
    ...DEFAULTS_AGENTE,
    capital: '10000',
    minObjetivoCoste: 3,
    minObjetivoPct: '0',
    minRR: '1',
    maxCosteR: '0.5',
    ...o,
  };
}

export function historialAgenteDePrueba(o: Partial<HistorialAgente> = {}): HistorialAgente {
  return {
    dia: T0_AGENTE,
    operacionesHoy: 0,
    realizadoHoy: '0',
    riesgoAbierto: '0',
    vivas: 0,
    pendientes: 0,
    rachaPerdidas: 0,
    ultimaPerdidaEn: null,
    ultimoStopEn: {},
    ocupados: [],
    ...o,
  };
}

export function parDePrueba(velas: readonly Candle[], o: Partial<ParAgente> = {}): ParAgente {
  const simbolo = o.simbolo ?? 'SOL';
  return {
    simbolo,
    market: mercadoAgente({ symbol: simbolo }),
    ticker: tickerDe(velas, simbolo),
    velas,
    fundingBps: 0,
    niveles: [],
    ...o,
  };
}

/** Una ronda de un par con la serie dada, justo tras cerrar su última vela. */
export function entradaAgenteDePrueba(
  velas: readonly Candle[],
  o: Partial<EntradaAgente> = {},
): EntradaAgente {
  return {
    limites: limitesDePrueba(),
    venue: Venue.HYPERLIQUID,
    intervalo: '1h',
    familias: ['TENDENCIA', 'RUPTURA', 'REVERSION'],
    lados: ['LONG', 'SHORT'],
    pares: [parDePrueba(velas)],
    saldoLibre: '10000',
    historial: historialAgenteDePrueba(),
    maxApalancamientoUsuario: null,
    ahora: ahoraTras(velas),
    ...o,
  };
}
