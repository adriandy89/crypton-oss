/**
 * Series sintéticas para los tests del canal (spec 058). Solo las importan los
 * specs, como `../testing.ts`.
 */
import {
  CalidadCanal,
  EstadoSetup,
  RegimenMercado,
  TipoCanal,
  TipoSetup,
  Venue,
  type BotConfig,
  type CanalDetectado,
  type Candle,
  type ContextoMercado,
  type HistorialOperaciones,
  type MarketSpec,
  type NivelApalancamiento,
} from '@crypton/shared';
import { makeMarket } from '../testing';
import { leerConfig } from './config';
import type { EntradaHerramienta } from './herramienta';
import type { CandidatoBase } from './setups';

export const QUINCE_MIN = 900_000;
export const T0_CANAL = Date.UTC(2026, 8, 1, 0, 0, 0);

/** Un canal horizontal entre 99,9 y 102,9, con los niveles en `T0_CANAL`. */
export function canalDePrueba(o: Partial<CanalDetectado> = {}): CanalDetectado {
  return {
    id: 'H' + T0_CANAL,
    tipo: TipoCanal.HORIZONTAL,
    calidad: CalidadCanal.A,
    puntuacion: 80,
    soporte: '99.9',
    resistencia: '102.9',
    media: '101.4',
    pendientePorVela: 0,
    refT: T0_CANAL,
    anchuraAtr: 7.5,
    toquesSoporte: 3,
    toquesResistencia: 3,
    contencion: 0.95,
    cruces: 5,
    mediaVidaVelas: 6,
    duracionVelas: 80,
    ultimoToqueHace: 1,
    r2: null,
    ...o,
  };
}

export function mercadoDePrueba(o: Partial<ContextoMercado> = {}): ContextoMercado {
  return {
    regimen: RegimenMercado.RANGO,
    sentido: null,
    adx1h: 15,
    chop1h: 60,
    chop15m: 58,
    percentilEficiencia: 20,
    percentilAncho: 40,
    ratioAtr: 1,
    atr5m: '0.2',
    atr15m: '0.4',
    atr1h: '0.8',
    precio: '100.01',
    spreadBps: 2,
    fundingBps: 0,
    frescas: true,
    ...o,
  };
}

export function historialDePrueba(o: Partial<HistorialOperaciones> = {}): HistorialOperaciones {
  return {
    dia: T0_CANAL,
    operacionesHoy: 0,
    realizadoHoy: '0',
    rachaPerdidas: 0,
    ultimoCierreEn: null,
    ultimaPerdidaEn: null,
    ultimoStopEn: null,
    realizadoTotal: '0',
    picoRealizado: '0',
    ...o,
  };
}

export function candidatoDePrueba(o: Partial<CandidatoBase> = {}): CandidatoBase {
  const lado = o.lado ?? 'LONG';
  return {
    id: `REB-${lado === 'LONG' ? 'L' : 'S'}-H${T0_CANAL}`,
    setup: TipoSetup.REBOTE,
    lado,
    estado: EstadoSetup.LISTO,
    confirmaciones: [],
    extremo: lado === 'LONG' ? 99.95 : 102.85,
    ...o,
  };
}

/**
 * La entrada del ejemplo trabajado de la herramienta: 1000 USDC en un par con
 * tick 0,01, step 0,001, mantenimiento del 1 % y máximo 50x, comisiones de
 * Hyperliquid y un largo que tocó 99,95.
 */
export function entradaDePrueba(
  o: Partial<EntradaHerramienta> = {},
  cfg: Record<string, unknown> = {},
): EntradaHerramienta {
  const market =
    o.market ??
    makeMarket({
      tickSize: '0.01',
      stepSize: '0.001',
      priceDecimals: 2,
      qtyDecimals: 3,
      minNotional: '10',
      minQty: '0.001',
      maxLeverage: 50,
      maintenanceMarginRate: 0.01,
    });
  return {
    cfg: leerConfig({ totalInvestment: '1000', ...cfg } as BotConfig, Venue.HYPERLIQUID),
    market,
    ticker: {
      venue: Venue.HYPERLIQUID,
      symbol: 'BTC',
      last: '100.01',
      bid: '100.00',
      ask: '100.02',
      mark: '100.01',
      ts: T0_CANAL,
    },
    saldoLibre: '1000',
    historial: historialDePrueba(),
    niveles: [],
    maxApalancamientoUsuario: null,
    mercado: mercadoDePrueba(),
    canal: canalDePrueba(),
    candidatos: [candidatoDePrueba()],
    tasas: new Map(),
    barT: T0_CANAL - 300_000,
    ahora: T0_CANAL,
    ...o,
  };
}

export interface OpcionesSenoidal {
  n: number;
  periodo: number;
  amplitud?: number;
  centro?: number;
  /** Desplazamiento del centro por vela. */
  deriva?: number;
  /** Mecha a cada lado del cuerpo. */
  mecha?: number;
  paso?: number;
  desde?: number;
  volumen?: number;
}

/**
 * Un precio que oscila como un seno alrededor de un centro que puede derivar.
 * Cada vela abre en el cierre anterior y lleva una mecha fija a cada lado.
 */
export function senoidal(o: OpcionesSenoidal): Candle[] {
  const amplitud = o.amplitud ?? 1;
  const centro = o.centro ?? 100;
  const deriva = o.deriva ?? 0;
  const mecha = o.mecha ?? 0.05;
  const paso = o.paso ?? QUINCE_MIN;
  const desde = o.desde ?? T0_CANAL;
  const valor = (i: number) =>
    centro + deriva * i + amplitud * Math.sin((2 * Math.PI * i) / o.periodo);
  const velas: Candle[] = [];
  let previo = valor(-1);
  for (let i = 0; i < o.n; i++) {
    const cierre = valor(i);
    velas.push(vela(desde + i * paso, previo, cierre, mecha, o.volumen ?? 10));
    previo = cierre;
  }
  return velas;
}

export function vela(t: number, abre: number, cierra: number, mecha = 0.05, volumen = 10): Candle {
  return {
    t,
    o: abre.toFixed(6),
    h: (Math.max(abre, cierra) + mecha).toFixed(6),
    l: (Math.min(abre, cierra) - mecha).toFixed(6),
    c: cierra.toFixed(6),
    v: String(volumen),
  };
}

/** Una recta: el precio sube `pendiente` por vela, sin oscilar. */
export function recta(n: number, pendiente: number, desde = 100, paso = QUINCE_MIN): Candle[] {
  const velas: Candle[] = [];
  for (let i = 0; i < n; i++) {
    velas.push(vela(T0_CANAL + i * paso, desde + pendiente * (i - 1), desde + pendiente * i));
  }
  return velas;
}

export const HORA = 3_600_000;

/**
 * Un histórico de 1 h con tramos de tendencia y, al final, un rango con ruido.
 * Determinista por la semilla: el mismo número da siempre la misma serie.
 */
export function historiaConRango(
  semilla: number,
  velasTendencia: number,
  velasRango: number,
  ruido = 1.2,
): Candle[] {
  let x = semilla;
  const azar = () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
  const velas: Candle[] = [];
  let p = 100;
  let t = Date.UTC(2026, 7, 1);
  for (let i = 0; i < velasTendencia; i++) {
    const deriva = Math.floor(i / 60) % 2 === 0 ? 0.35 : -0.3;
    const abre = p;
    p += deriva + (azar() - 0.5) * 0.6;
    velas.push(vela(t, abre, p, 0.2));
    t += HORA;
  }
  const centro = p;
  let desvio = 0;
  for (let i = 0; i < velasRango; i++) {
    const abre = p;
    desvio = 0.5 * desvio + (azar() - 0.5) * ruido;
    p = centro + 1.5 * Math.sin(i / 3) + desvio;
    velas.push(vela(t, abre, p, 0.2));
    t += HORA;
  }
  return velas;
}

/**
 * El mejor tiempo de `veces` ejecuciones, en ms.
 *
 * El mínimo y no la media: con la suite entera en paralelo, la media mide la
 * contención de la máquina y no el código. Y jest ejecuta el TypeScript unas
 * veinte veces más despacio que Node sobre `dist` —donde el análisis completo
 * tarda medio milisegundo—: estos umbrales cazan un algoritmo que se dispara,
 * no miden el tiempo real.
 */
export function mejorTiempo(f: () => unknown, veces: number): number {
  f();
  let mejor = Number.POSITIVE_INFINITY;
  for (let i = 0; i < veces; i++) {
    const inicio = performance.now();
    f();
    mejor = Math.min(mejor, performance.now() - inicio);
  }
  return mejor;
}

// ── Un mercado en rango de punta a punta ───────────────────────────────────

export const CINCO_MIN = 300_000;

export interface EscenarioCanal {
  /** Cierre de la última vela de cada serie. */
  fin: number;
  centro: number;
  soporte: number;
  resistencia: number;
  series: { '5m': Candle[]; '15m': Candle[]; '1h': Candle[] };
}

/**
 * Las tres series de un rango que el motor reconoce entero:
 * - 1 h: la historia que el régimen da por RANGO (`regimen.spec`);
 * - 15 min: un seno de periodo 8 y amplitud 0,8 alrededor del último cierre de
 *   1 h, que es un canal horizontal A con los bordes a ±0,85 del centro;
 * - 5 min: calma alrededor del centro y, con `toque`, una bajada de 30 velas
 *   que acaba rebotando con mecha en el soporte.
 */
export function escenarioCanal(o: { toque?: boolean; velas15?: number } = {}): EscenarioCanal {
  const h1 = historiaConRango(5 * 7919, 300, 180);
  const fin = h1[h1.length - 1].t + HORA;
  const centro = Number(h1[h1.length - 1].c);
  const n15 = o.velas15 ?? 200;
  const v15 = senoidal({
    n: n15,
    periodo: 8,
    amplitud: 0.8,
    centro,
    desde: fin - n15 * QUINCE_MIN,
  });
  const soporte = centro - 0.85;
  const calma = o.toque ? 112 : 144;
  const v5 = senoidal({
    n: calma,
    periodo: 24,
    amplitud: 0.2,
    centro,
    paso: CINCO_MIN,
    desde: fin - 144 * CINCO_MIN,
  });
  if (o.toque) {
    let previo = Number(v5[v5.length - 1].c);
    const hasta = soporte + 0.15;
    for (let i = 0; i < 30; i++) {
      const cierre = previo + (hasta - previo) / (30 - i);
      v5.push(vela(fin - (32 - i) * CINCO_MIN, previo, cierre, 0.02));
      previo = cierre;
    }
    const f = (x: number) => (soporte + x).toFixed(4);
    v5.push({ t: fin - 2 * CINCO_MIN, o: f(0.15), h: f(0.17), l: f(0.03), c: f(0.05), v: '10' });
    // Mecha inferior de 0,18 en un rango de 0,30 y cierre en la mitad alta.
    v5.push({ t: fin - CINCO_MIN, o: f(0.15), h: f(0.27), l: f(-0.03), c: f(0.25), v: '10' });
  }
  return {
    fin,
    centro,
    soporte,
    resistencia: centro + 0.85,
    series: { '5m': v5, '15m': v15, '1h': h1 },
  };
}

// ── Casos al azar para los tests de propiedad ──────────────────────────────

/** PRNG determinista para los tests de propiedad. */
export function mulberry32(semilla: number): () => number {
  let a = semilla;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RETICULAS = [
  { tickSize: '0.0001', priceDecimals: 4, stepSize: '1', qtyDecimals: 0, desde: 0.05, hasta: 5 },
  { tickSize: '0.01', priceDecimals: 2, stepSize: '0.001', qtyDecimals: 3, desde: 20, hasta: 500 },
  {
    tickSize: '0.1',
    priceDecimals: 1,
    stepSize: '0.00001',
    qtyDecimals: 5,
    desde: 2e4,
    hasta: 1.2e5,
  },
  { tickSize: '1', priceDecimals: 0, stepSize: '0.0001', qtyDecimals: 4, desde: 5e4, hasta: 1.2e5 },
];

const texto = (x: number) => String(Number(x.toPrecision(10)));

/**
 * Una entrada de la herramienta al azar, dentro de los límites que admite
 * `validate()`: retículas de cuatro órdenes de magnitud, tramos realistas y
 * configuraciones extremas.
 */
export function casoAleatorio(azar: () => number): EntradaHerramienta {
  const entre = (a: number, b: number) => a + (b - a) * azar();
  const uno = <T>(xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)];
  const r = uno(RETICULAS);
  const tick = Number(r.tickSize);
  const maxLeverage = uno([3, 5, 10, 20, 25, 40, 50]);
  const market: MarketSpec = makeMarket({
    tickSize: r.tickSize,
    priceDecimals: r.priceDecimals,
    stepSize: r.stepSize,
    qtyDecimals: r.qtyDecimals,
    maxLeverage,
    maintenanceMarginRate: azar() < 0.5 ? null : 1 / (2 * maxLeverage),
    minNotional: uno(['5', '10', '100', null]),
    minQty: azar() < 0.5 ? null : r.stepSize,
    maxQty: azar() < 0.15 ? texto(entre(1, 1e4)) : null,
    maxMarketQty: azar() < 0.1 ? texto(entre(1, 1e3)) : null,
  });
  const precio = entre(r.desde, r.hasta);
  const bidN = Math.floor(precio / tick);
  const bid = (bidN * tick).toFixed(r.priceDecimals);
  const ask = ((bidN + 1 + Math.floor(azar() * 3)) * tick).toFixed(r.priceDecimals);
  const atr15 = precio * entre(0.0005, 0.01);
  const lado = azar() < 0.5 ? 'LONG' : 'SHORT';
  const anchura = atr15 * entre(3, 10);
  const extremo =
    lado === 'LONG' ? Number(bid) - entre(0, 1) * atr15 : Number(ask) + entre(0, 1) * atr15;
  const borde = extremo + entre(-0.25, 0.25) * atr15;
  const soporte = lado === 'LONG' ? borde : borde - anchura;
  const inclinado = azar() < 0.3;
  const ahora = T0_CANAL + Math.floor(azar() * 8) * QUINCE_MIN;
  const canal = canalDePrueba({
    tipo: inclinado ? TipoCanal.INCLINADO : TipoCanal.HORIZONTAL,
    soporte: texto(soporte),
    resistencia: texto(soporte + anchura),
    media: texto(soporte + anchura / 2),
    pendientePorVela: inclinado ? entre(-0.05, 0.05) * atr15 : 0,
  });
  const riesgo = entre(0.1, 2);
  const capital = entre(50, 1e5);
  const cfg: Record<string, unknown> = {
    totalInvestment: capital.toFixed(2),
    riskPerTradePct: riesgo.toFixed(2),
    maxDailyLossPct: Math.max(riesgo, entre(0.5, 6)).toFixed(2),
    maxMarginPct: entre(5, 100).toFixed(0),
    maxNotionalMultiple: entre(1, 25).toFixed(1),
    maxNotionalCap: azar() < 0.3 ? entre(10, 5e4).toFixed(0) : undefined,
    liqBufferStops: 3 + Math.floor(azar() * 8),
    maxStopPct: entre(0.1, 5).toFixed(2),
    minRewardRisk: entre(0.5, 5).toFixed(2),
    maxEntrySlippageR: entre(0.05, 0.5).toFixed(2),
    leverage: 1 + Math.floor(azar() * 25),
    takeProfitSchemes: uno(['TODOS', 'MEDIA', 'ESCALONADO', 'OPUESTO']),
    tp1Fraction: entre(50, 70).toFixed(0),
    takerFeeBps: azar() < 0.3 ? entre(0, 20).toFixed(1) : undefined,
    makerFeeBps: azar() < 0.3 ? entre(0, 20).toFixed(1) : undefined,
    slippageBps: azar() < 0.3 ? entre(0, 20).toFixed(1) : undefined,
  };
  // Tramos realistas: a más nocional, menos palanca y más mantenimiento.
  const niveles: NivelApalancamiento[] = [];
  let desde = azar() < 0.3 ? entre(10, 5000) : 0;
  let max = maxLeverage;
  for (let i = 0, n = Math.floor(azar() * 4); i < n; i++) {
    niveles.push({
      desdeNocional: desde.toFixed(0),
      maxApalancamiento: max,
      mantenimiento: 1 / (2 * max),
    });
    desde += entre(100, 1e5);
    max = Math.max(1, Math.floor(max / uno([1, 2, 3])));
  }
  return entradaDePrueba(
    {
      market,
      ticker: { ...entradaDePrueba().ticker, bid, ask, mark: bid, last: bid },
      saldoLibre: (capital * entre(0.05, 3)).toFixed(2),
      historial: historialDePrueba({ realizadoHoy: (capital * entre(-0.07, 0.05)).toFixed(2) }),
      niveles,
      maxApalancamientoUsuario: azar() < 0.3 ? 1 + Math.floor(azar() * 30) : null,
      mercado: mercadoDePrueba({
        atr15m: texto(atr15),
        atr1h: texto(atr15 * entre(1.5, 3)),
      }),
      canal,
      candidatos: [candidatoDePrueba({ lado, extremo })],
      ahora,
    },
    cfg,
  );
}
