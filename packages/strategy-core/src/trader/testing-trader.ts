/**
 * Fixtures del «Bot de IA» (spec 068).
 *
 * Un montaje realista de largo en el borde inferior: precio 100, ATR(15m) 0,4 y
 * una banda de unos 3 ATR. Los números están elegidos para que la matriz salga
 * con celdas viables y no viables a la vez, que es lo que hace útil el fixture.
 */
import { Evidencia, type BotConfig, type HistorialOperaciones, type Ticker } from '@crypton/shared';
import { makeMarket } from '../testing';
import type { Banda } from './senal';
import { leerConfigTrader, type ConfigTrader } from './config';
import type { EntradaEspacio } from './esqueletos';
import type { SenalTrader } from '@crypton/shared';

export const T0_TRADER = Date.UTC(2026, 8, 1, 12, 0, 0);
export const QUINCE_MIN = 900_000;

export const MERCADO_TRADER = makeMarket({
  tickSize: '0.01',
  stepSize: '0.001',
  priceDecimals: 2,
  qtyDecimals: 3,
  minNotional: '10',
  minQty: '0.001',
  maxLeverage: 50,
});

export function bandaDePrueba(o: Partial<Banda> = {}): Banda {
  return {
    // Banda de 8 ATR: la entrada queda a unas 37 veces el coste de ida y vuelta
    // de la media, que es lo que hace falta para pasar `minTargetCostMultiple`
    // en 25. Con una banda estrecha las nueve celdas mueren en OBJETIVO_CORTO, y
    // entonces el fixture no mide nada.
    superior: 103.2,
    media: 101.6,
    inferior: 100,
    atr15: 0.4,
    refT: T0_TRADER,
    ...o,
  };
}

export function senalDePrueba(o: Partial<SenalTrader> = {}): SenalTrader {
  return {
    lado: 'LONG',
    porcentajeB: 0.04,
    estiramientoAtr: 1.5,
    anchuraAtr: 8,
    anchuraPct: 3.2,
    contencion: 0.92,
    cruces: 11,
    mediaVidaVelas: 7,
    derivaMediaAtr: 0,
    mechaFraccion: 0.6,
    cierreEnMitad: true,
    rsi2: 5,
    rsi14: 28,
    divergencia: true,
    volumenRatio: 0.8,
    velasDesdeUltimoToque: 14,
    adx1h: 15,
    chop1h: 61,
    idaVueltaPrecio: 0.004,
    spreadBps: 2,
    evidencia: Evidencia.MODERADA,
    // Un histórico con algo que decir: sin esto, la pregunta del histórico no
    // tiene nada que juzgar. Se vio probando contra BTC real.
    tasas: {
      n: 63,
      aciertos: 34,
      rMedio: 0.11,
      wilsonInferior: 0.42,
      evidencia: Evidencia.MODERADA,
      estiramientoRef: 1.5,
      // Con muestra suficiente y algo que decir: es lo que el modelo lee para
      // juzgar este estiramiento en concreto (spec 070).
      similares: {
        n: 21,
        aciertos: 9,
        rMedio: -0.08,
        wilsonInferior: 0.24,
        evidencia: Evidencia.DEBIL,
      },
    },
    ...o,
  };
}

export function historialDePrueba(o: Partial<HistorialOperaciones> = {}): HistorialOperaciones {
  return {
    dia: Date.UTC(2026, 8, 1),
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

export const TICKER_TRADER: Ticker = {
  venue: 'LIGHTER',
  symbol: 'TEST',
  last: '100.1',
  bid: '100.09',
  ask: '100.11',
  mark: '100.1',
  ts: T0_TRADER,
};

/** La configuración del fixture, con los costes de un venue sin comisión. */
export function configDePrueba(extra: Record<string, unknown> = {}): ConfigTrader {
  return leerConfigTrader(
    {
      totalInvestment: '1000',
      makerFeeBps: '0',
      takerFeeBps: '0',
      slippageBps: '2',
      ...extra,
    } as unknown as BotConfig,
    'LIGHTER',
  );
}

export function entradaDePrueba(
  o: Partial<EntradaEspacio> = {},
  extraCfg: Record<string, unknown> = {},
): EntradaEspacio {
  return {
    cfg: configDePrueba(extraCfg),
    market: MERCADO_TRADER,
    ticker: TICKER_TRADER,
    senal: senalDePrueba(),
    banda: bandaDePrueba(),
    extremo: 100.02,
    niveles: [],
    historial: historialDePrueba(),
    saldoLibre: '1000',
    atr1h: '1.2',
    maxApalancamientoUsuario: null,
    barT: T0_TRADER,
    ahora: T0_TRADER + 4000,
    ...o,
  };
}
