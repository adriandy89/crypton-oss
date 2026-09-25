/**
 * Lo que el agente mide de un par (spec 074): los indicadores de sus familias,
 * el régimen y el contexto que ve el modelo.
 *
 * Todo sobre las velas CERRADAS del intervalo del agente, en `number` y causal:
 * el valor en la vela `i` solo depende de las velas hasta `i`. Cada cuenta es
 * de la estadística del canal (`canal/estadistica.ts`), con sus tests a mano;
 * aquí no hay ninguna fórmula nueva.
 */
import {
  RegimenMercado,
  agregarVelas,
  candleSpanMs,
  type Candle,
  type ContextoParAgente,
  type IntervaloAgente,
  type SentidoTendencia,
  type Ticker,
} from '@crypton/shared';
import { nivelTexto } from '../canal/canales';
import { spreadBps } from '../canal/costes';
import { adx, atrSerie, bollinger, ema, percentil, rsi } from '../canal/estadistica';
import { serieNumerica, type SerieNumerica } from '../canal/numeros';
import { MIN_VELAS_1H, indicadoresHora, medidasEn, regimenCrudo } from '../canal/regimen';

export const PERIODO_ATR_AGENTE = 14;
/** Las velas que se piden por par. Con menos de `MIN_VELAS_AGENTE` no hay análisis. */
export const VELAS_AGENTE = 500;
/**
 * La EMA de 50, el percentil del ancho en 100 velas y el régimen —que necesita
 * 100— tienen que tener historia detrás: por debajo de esto, las medidas del
 * principio de la serie aún no significan nada.
 */
export const MIN_VELAS_AGENTE = 150;
/** Las velas en las que se mide si el ancho de Bollinger está comprimido. */
export const VENTANA_PERCENTIL_ANCHO = 100;
/** El canal de Donchian de las rupturas. */
export const PERIODO_DONCHIAN = 20;

const nan = (n: number): Float64Array => new Float64Array(n).fill(Number.NaN);

export interface IndicadoresAgente {
  ema20: Float64Array;
  ema50: Float64Array;
  adx: Float64Array;
  masDi: Float64Array;
  menosDi: Float64Array;
  rsi: Float64Array;
  atr: Float64Array;
  bbMedia: Float64Array;
  bbSuperior: Float64Array;
  bbInferior: Float64Array;
  /** Percentil del ancho de Bollinger en las 100 velas hasta cada una, incluida. */
  percentilAncho: Float64Array;
  /** Máximo y mínimo de las 20 velas ANTERIORES a cada una, sin ella. */
  donchianAlto: Float64Array;
  donchianBajo: Float64Array;
}

export function indicadoresAgente(s: SerieNumerica): IndicadoresAgente {
  const a = adx(s.h, s.l, s.c, 14);
  const bb = bollinger(s.c, 20, 2);
  const percentilAncho = nan(s.n);
  for (let i = 0; i < s.n; i++) {
    if (!Number.isFinite(bb.ancho[i])) continue;
    const desde = Math.max(0, i - VENTANA_PERCENTIL_ANCHO + 1);
    percentilAncho[i] = percentil(bb.ancho[i], bb.ancho.subarray(desde, i + 1));
  }
  const donchianAlto = nan(s.n);
  const donchianBajo = nan(s.n);
  for (let i = PERIODO_DONCHIAN; i < s.n; i++) {
    let alto = Number.NEGATIVE_INFINITY;
    let bajo = Number.POSITIVE_INFINITY;
    for (let k = i - PERIODO_DONCHIAN; k < i; k++) {
      if (s.h[k] > alto) alto = s.h[k];
      if (s.l[k] < bajo) bajo = s.l[k];
    }
    donchianAlto[i] = alto;
    donchianBajo[i] = bajo;
  }
  return {
    ema20: ema(s.c, 20),
    ema50: ema(s.c, 50),
    adx: a.adx,
    masDi: a.masDi,
    menosDi: a.menosDi,
    rsi: rsi(s.c, 14),
    atr: atrSerie(s.h, s.l, s.c, PERIODO_ATR_AGENTE),
    bbMedia: bb.media,
    bbSuperior: bb.superior,
    bbInferior: bb.inferior,
    percentilAncho,
    donchianAlto,
    donchianBajo,
  };
}

export interface RegimenAgente {
  regimen: RegimenMercado;
  sentido: SentidoTendencia | null;
}

/**
 * El régimen sobre la serie del agente, con las reglas del canal
 * (`regimenCrudo`) y su histéresis: las tres últimas velas tienen que decir lo
 * mismo, o es INDEFINIDO. El canal lo toma de 1 h y mira el choppiness de 15
 * min; aquí todo sale del intervalo del agente.
 */
export function regimenAgente(s: SerieNumerica): RegimenAgente {
  const indefinido: RegimenAgente = { regimen: RegimenMercado.INDEFINIDO, sentido: null };
  if (s.n < MIN_VELAS_1H) return indefinido;
  const ind = indicadoresHora(s);
  const crudos: RegimenAgente[] = [];
  for (let j = s.n - 3; j < s.n; j++) {
    const m = medidasEn(ind, j, ind.chop[j]);
    if (!m) return indefinido;
    crudos.push(regimenCrudo(m));
  }
  const ultima = crudos[crudos.length - 1];
  return crudos.every((c) => c.regimen === ultima.regimen) ? ultima : indefinido;
}

const redondear = (x: number, decimales = 2): number => {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** decimales;
  return Math.round(x * f) / f;
};

/** El contexto de la última vela, en unidades relativas: lo que ve el modelo del par. */
export function contextoPar(
  s: SerieNumerica,
  ind: IndicadoresAgente,
  reg: RegimenAgente,
  ticker: Ticker,
  fundingBps: number | null,
  frescas: boolean,
): ContextoParAgente {
  const j = s.n - 1;
  const atr = ind.atr[j];
  const hayAtr = Number.isFinite(atr) && atr > 0;
  return {
    regimen: reg.regimen,
    sentido: reg.sentido,
    adx: redondear(ind.adx[j]),
    rsi: redondear(ind.rsi[j]),
    atrPct: hayAtr && s.c[j] > 0 ? redondear((atr / s.c[j]) * 100, 3) : 0,
    percentilAncho: redondear(ind.percentilAncho[j]),
    distanciaMediaAtr: hayAtr ? redondear((s.c[j] - ind.ema20[j]) / atr) : 0,
    pendienteMedia:
      hayAtr && j >= 5 ? redondear((ind.ema50[j] - ind.ema50[j - 5]) / 5 / atr, 3) : 0,
    spreadBps: redondear(spreadBps(Number(ticker.bid), Number(ticker.ask))),
    fundingBps,
    precio: ticker.mark,
    atr: hayAtr ? nivelTexto(atr) : '0',
    frescas,
  };
}

/**
 * El ATR con el que se mide la distancia a la liquidación: el del intervalo o
 * el de 1 h, el MAYOR. El canal exige la liquidación a tres ATR de 1 h como
 * poco; un agente de 15 min con el ATR de 15 min la dejaría más cerca de lo que
 * el canal admite. Por debajo de 1 h, la hora se construye con las propias
 * velas, sin pedir otra serie al venue.
 */
export function atrLiquidacion(
  velas: readonly Candle[],
  intervalo: IntervaloAgente,
  atrIntervalo: number,
): number {
  if (candleSpanMs(intervalo) >= candleSpanMs('1h') || velas.length === 0) return atrIntervalo;
  const hasta = velas[velas.length - 1].t + candleSpanMs(intervalo);
  const horas = agregarVelas(velas, intervalo, '1h', hasta);
  if (!horas || horas.length <= PERIODO_ATR_AGENTE) return atrIntervalo;
  const h = serieNumerica(horas);
  const atrHora = atrSerie(h.h, h.l, h.c, PERIODO_ATR_AGENTE)[h.n - 1];
  return Number.isFinite(atrHora) ? Math.max(atrIntervalo, atrHora) : atrIntervalo;
}

/**
 * El ATR de la liquidación a partir de las velas, como lo calcula la ronda. Lo
 * usa la API al aprobar, con las velas de ese momento; null si no hay datos.
 */
export function atrLiquidacionDe(
  velas: readonly Candle[],
  intervalo: IntervaloAgente,
  ahora: number,
): string | null {
  const span = candleSpanMs(intervalo);
  const cerradas = velas.filter((v) => v.t + span <= ahora);
  if (cerradas.length <= PERIODO_ATR_AGENTE) return null;
  const s = serieNumerica(cerradas);
  const atr = atrSerie(s.h, s.l, s.c, PERIODO_ATR_AGENTE)[s.n - 1];
  if (!(atr > 0)) return null;
  return nivelTexto(atrLiquidacion(cerradas, intervalo, atr));
}
