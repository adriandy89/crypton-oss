import { Evidencia, type EspacioTrader, type MarketSpec, type Ticker } from '@crypton/shared';
import { espacioTrader, leerConfigTrader, type ConfigTrader } from '@crypton/strategy-core';

/**
 * Una oferta del «Bot de IA» construida por el MOTOR de verdad (spec 069).
 *
 * No es un objeto escrito a mano, y esa es toda la gracia: si el motor cambia lo
 * que ofrece, este fixture cambia con él y los tests del lazo siguen probando
 * algo real. Un fixture inventado a mano se queda con la forma de ayer y da
 * verdes que no significan nada.
 *
 * `-spec` en el nombre para que jest no lo tome por una suite: es un fixture,
 * no tiene tests. Es el mismo truco que el del canal.
 */

export const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
export const QUINCE_MIN = 900_000;
export const CAPITAL = '1000';

export const MERCADO: MarketSpec = {
  venue: 'LIGHTER',
  symbol: 'TEST',
  canonical: 'TEST/USDC',
  base: 'TEST',
  quote: 'USDC',
  tickSize: '0.01',
  stepSize: '0.001',
  minNotional: '10',
  minQty: '0.001',
  maxQty: null,
  maxLeverage: 50,
  priceDecimals: 2,
  qtyDecimals: 3,
  active: true,
};

const TICKER: Ticker = {
  venue: 'LIGHTER',
  symbol: 'TEST',
  last: '100.02',
  bid: '100.00',
  ask: '100.04',
  mark: '100.02',
  ts: T0 + QUINCE_MIN,
};

export function configDePrueba(extra: Record<string, unknown> = {}): ConfigTrader {
  return leerConfigTrader(
    {
      exchangeAccountId: 'a',
      symbol: 'TEST',
      totalInvestment: CAPITAL,
      makerFeeBps: '0',
      takerFeeBps: '0',
      slippageBps: '2',
      ...extra,
    } as never,
    'LIGHTER',
  );
}

/**
 * La oferta: un toque del borde bajo con seis de las nueve celdas viables.
 *
 * La banda es de 8 ATR a propósito. Con una banda estrecha las nueve celdas
 * mueren en `OBJETIVO_CORTO` y el fixture no mediría nada.
 */
export function espacioDePrueba(cfg: ConfigTrader = configDePrueba()): EspacioTrader {
  return espacioTrader({
    cfg,
    market: MERCADO,
    ticker: TICKER,
    senal: {
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
      tasas: {
        n: 63,
        aciertos: 34,
        rMedio: 0.11,
        wilsonInferior: 0.42,
        evidencia: Evidencia.MODERADA,
        estiramientoRef: 1.5,
        // Con muestra suficiente: es lo que el modelo lee para juzgar ESTE
        // estiramiento en concreto, y no solo el historico global (spec 070).
        similares: {
          n: 21,
          aciertos: 9,
          rMedio: -0.08,
          wilsonInferior: 0.24,
          evidencia: Evidencia.DEBIL,
        },
      },
    },
    banda: { superior: 103.2, media: 101.6, inferior: 100, atr15: 0.4, refT: T0 },
    extremo: 99.8,
    niveles: [],
    historial: {
      dia: T0,
      operacionesHoy: 0,
      realizadoHoy: '0',
      rachaPerdidas: 0,
      ultimoCierreEn: null,
      ultimaPerdidaEn: null,
      ultimoStopEn: null,
      realizadoTotal: '0',
      picoRealizado: '0',
    },
    saldoLibre: CAPITAL,
    atr1h: '1.2',
    maxApalancamientoUsuario: null,
    barT: T0,
    ahora: T0 + QUINCE_MIN,
  });
}

/** Una respuesta del proveedor bien formada: toma el toque, sin opinar de mandos. */
export function respuestaBuena(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: {
      choice: 'TAKE_THE_TOUCH',
      probabilities: {
        TAKE_THE_TOUCH: 0.72,
        WAIT_FOR_A_BETTER_TOUCH: 0.2,
        WRONG_ENVIRONMENT: 0.08,
      },
      confidence: 0.58,
    },
    regime_is_mean_reverting: { noul: 0.82 },
    touch_is_exhaustion: { noul: 0.71 },
    history_supports_the_setup: { noul: 0.64 },
    stop_width_is_determined: { noul: 0.2 },
    stop_width: {
      choice: 'MEDIDO',
      probabilities: { CENIDO: 0.3, MEDIDO: 0.4, HOLGADO: 0.3 },
      confidence: 0.1,
    },
    target_depth_is_determined: { noul: 0.15 },
    target_depth: {
      choice: 'EN_LA_MEDIA',
      probabilities: { CORTO: 0.3, EN_LA_MEDIA: 0.4, LARGO: 0.3 },
      confidence: 0.1,
    },
    ...extra,
  };
}
