/**
 * El estado que ve quien decide (spec 068).
 *
 * Vive en `strategy-core` y no en la API, y no es un capricho de colocación: el
 * backtest tiene que poder generar **el mismo estado byte a byte** para indexar
 * respuestas grabadas y replicar al modelo sin volver a llamarlo. Con esto en
 * la API, el mensaje exacto sería irreproducible fuera de ella.
 *
 * ── Qué NO entra aquí, y por qué ──
 *
 * Ni precios, ni importes, ni cantidades, ni niveles, ni ids, ni horas, ni
 * fechas, ni el venue, ni **el símbolo**. Todo va en porcentajes, múltiplos de
 * ATR, veces el coste y veces lo arriesgado.
 *
 * Lo del símbolo es lo más importante y lo menos evidente. El fabricante lo
 * dice: *«do not rely on knowledge stored in model weights when current
 * information can come from your own knowledge base»*. Un ticker es el mayor
 * activador de pesos de todo el mensaje — invoca recuerdos de precio y de
 * noticias que están rancios y que no se pueden comprobar. Quitarlo tiene
 * además un efecto útil: dos montajes idénticos en dos pares distintos reciben
 * el mismo estado, y por tanto la misma respuesta. Eso es lo que hace
 * comparable el brazo del modelo con el del juez.
 *
 * ── Por qué está en inglés ──
 *
 * Porque el modelo es más preciso en inglés y lo dice su documentación. El
 * castellano sigue mandando en el código, los comentarios, los commits y la
 * documentación, y se para justo en esta frontera. No es un descuido.
 */
import {
  Evidencia,
  type EspacioTrader,
  type EsqueletoTrader,
  type SenalTrader,
} from '@crypton/shared';
import type { ConfigTrader } from './config';

/** El estado, como objeto de campos con nombre y hojas de texto. */
export interface EstadoTrader {
  instrument: string;
  regime: Record<string, string>;
  band: Record<string, string>;
  touch: Record<string, string>;
  costs: Record<string, string>;
  stop_choices: { key: string; detail: string }[];
  target_choices: { key: string; detail: string }[];
  history: Record<string, string>;
}

const pct = (x: number, d = 2): string => `${x.toFixed(d)} percent`;
const veces = (x: number, d = 1): string => `${x.toFixed(d)} times`;
const num = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : 'not available');

const EVIDENCIA_EN: Readonly<Record<Evidencia, string>> = {
  [Evidencia.INSUFICIENTE]: 'too few comparable cases to lean on',
  [Evidencia.DEBIL]: 'a thin sample',
  [Evidencia.MODERADA]: 'a moderate sample',
};

function regimeBlock(s: SenalTrader): Record<string, string> {
  return {
    trend_strength: Number.isFinite(s.adx1h)
      ? `ADX(14) on the hourly is ${num(s.adx1h)}; below 20 is usually considered directionless`
      : 'trend strength is not available for this instrument right now',
    choppiness: Number.isFinite(s.chop1h)
      ? `the choppiness index on the hourly is ${num(s.chop1h)}; above 55 is considered sideways`
      : 'choppiness is not available',
    containment: `${pct(s.contencion * 100, 0)} of recent closes finished inside the band`,
    crossings: `price crossed the centre line ${s.cruces} times in the recent window`,
    reversion_speed:
      s.mediaVidaVelas === null
        ? 'the distance from price to the centre line shows no measurable decay'
        : `the distance from price to the centre line decays with a half-life of ${num(
            s.mediaVidaVelas,
          )} bars`,
  };
}

function bandBlock(s: SenalTrader): Record<string, string> {
  const deriva = Math.abs(s.derivaMediaAtr) < 0.005;
  return {
    definition:
      'a band drawn two standard deviations either side of a moving average of recent closes',
    width: `${num(s.anchuraAtr)} times the average true range, which is ${pct(s.anchuraPct)} of price`,
    centre_drift: deriva
      ? 'the centre line is essentially flat'
      : `the centre line is drifting ${s.derivaMediaAtr > 0 ? 'upward' : 'downward'} by ${num(
          Math.abs(s.derivaMediaAtr),
          3,
        )} times the average true range per bar`,
  };
}

function touchBlock(s: SenalTrader): Record<string, string> {
  const largo = s.lado === 'LONG';
  return {
    side: largo
      ? 'price is at the LOWER edge of the band, so the only trade on offer is a long'
      : 'price is at the UPPER edge of the band, so the only trade on offer is a short',
    position_in_band: `percent-B is ${num(s.porcentajeB, 2)}, where 0 is the lower edge and 1 the upper edge`,
    stretch: `price sits ${num(s.estiramientoAtr)} times the average true range away from the centre line`,
    bar_shape: `the touching bar left a rejection wick worth ${pct(
      s.mechaFraccion * 100,
      0,
    )} of its range and closed in the ${s.cierreEnMitad ? 'far' : 'near'} half of that range`,
    momentum: `a 2-period RSI reads ${num(s.rsi2)} and a 14-period RSI reads ${num(s.rsi14)}`,
    divergence: s.divergencia
      ? 'price pushed past its previous extreme while momentum did not follow'
      : 'there is no divergence against the previous extreme',
    volume: `volume on the touching bar was ${num(s.volumenRatio, 2)} times its recent average; breakouts usually arrive with more`,
    recency: `the band was last touched ${s.velasDesdeUltimoToque} bars ago`,
  };
}

function costsBlock(s: SenalTrader, cfg: ConfigTrader): Record<string, string> {
  const sinComision = cfg.costes.takerBps === 0 && cfg.costes.makerBps === 0;
  // El coste en porcentaje sale de la configuración, no del precio: aquí no
  // entra ni un precio, y el spread medido se suma aparte.
  const idaVueltaPct =
    ((2 * (cfg.costes.takerBps + cfg.costes.deslizamientoBps) + s.spreadBps) / 10_000) * 100;
  return {
    round_trip: `entering and leaving costs ${pct(
      idaVueltaPct,
      3,
    )} of price, spread and slippage included`,
    venue_class: sinComision
      ? 'this account pays no commission; almost all of the cost is spread and slippage'
      : 'this account pays commission on both sides, on top of spread and slippage',
  };
}

/** Una celda, descrita sin un solo precio. */
function detalleCelda(c: EsqueletoTrader): string {
  if (!c.viable) return `not available: ${motivoEn(c)}`;
  return [
    `risk is ${pct(c.distanciaStop * 100)} of price`,
    `costs take ${pct(c.costeR * 100, 0)} of the money risked`,
    `the target is ${veces(c.multiploCoste, 0)} the round-trip cost away`,
    `net reward is ${veces(c.rNeto, 2)} the risk`,
    c.aciertoEquilibrio !== null
      ? `break-even hit rate ${pct(c.aciertoEquilibrio * 100, 0)}`
      : 'break-even hit rate not available',
  ].join('; ');
}

function motivoEn(c: EsqueletoTrader): string {
  switch (c.motivo) {
    case 'STOP_ANCHO':
      return 'the stop would be wider than the owner allows';
    case 'STOP_INVALIDO':
      return 'the stop would sit on the wrong side of the entry';
    case 'COSTE':
      return 'costs would eat more of the risk than the owner allows';
    case 'OBJETIVO_CORTO':
      return 'the target is too close to be worth the round-trip cost';
    case 'RR':
      return 'the target does not pay enough for what it risks';
    case 'MINIMO':
      return 'the order would be smaller than the venue accepts';
    case 'APALANCAMIENTO':
      return 'the margin rules do not allow a position this size';
    case 'LIQUIDACION':
      return 'liquidation would sit in front of the stop';
    case 'TOPE_DIARIO':
      return "today's loss budget does not leave room";
    case 'SIN_MARGEN':
      return 'there is no free margin';
    default:
      return 'the engine does not offer this combination';
  }
}

const RESUMEN_STOP: Readonly<Record<string, string>> = {
  CENIDO: 'a tight stop just beyond the touch',
  MEDIDO: 'a conventional stop that clears normal noise',
  HOLGADO: 'a wide stop that survives a volatility expansion',
};

const RESUMEN_OBJETIVO: Readonly<Record<string, string>> = {
  CORTO: 'a shallow reversion that stalls before the centre line',
  EN_LA_MEDIA: 'a normal reversion all the way back to the centre line',
  LARGO: 'a reversion that carries past the centre line',
};

/**
 * El histórico, con cifras de verdad.
 *
 * Sin esto la pregunta del histórico se queda clavada cerca de cero: probando
 * contra BTC real dio entre 0,21 y 0,36 en dieciséis llamadas seguidas, porque
 * se le estaba pidiendo juzgar una evidencia que no se le daba.
 */
function historyBlock(s: SenalTrader): Record<string, string> {
  const t = s.tasas;
  if (!t) {
    return {
      sample: 'there is no usable record of comparable touches on this instrument yet',
      method: 'comparable touches would be measured on the same instrument over the recent window',
    };
  }
  return {
    method:
      'the same kind of touch on this instrument, labelled pessimistically: when stop and target fall inside the same bar it is counted as a stop, and a touch that has not resolved yet is not counted at all',
    sample: `${t.n} resolved cases, which the engine classes as ${EVIDENCIA_EN[t.evidencia]}`,
    hit_rate: `${pct((t.aciertos / t.n) * 100, 0)} of them ended in profit`,
    defensible_hit_rate: `${pct(
      t.wilsonInferior * 100,
      0,
    )} is the hit rate that still survives a 95 percent confidence bound on that sample`,
    mean_result: `${t.rMedio >= 0 ? 'plus' : 'minus'} ${Math.abs(t.rMedio).toFixed(
      2,
    )} times the risk per trade, on average`,
  };
}

/**
 * El estado de una oferta.
 *
 * Las celdas se describen **una sola vez por eje**: el stop más prudente de su
 * columna y el objetivo más prudente de su fila. Nueve descripciones completas
 * serían nueve maneras de decir casi lo mismo, y el fabricante avisa de que
 * opciones confusamente parecidas reparten la probabilidad y hunden la
 * confianza sin que nadie se haya equivocado.
 */
export function estadoTrader(espacio: EspacioTrader, cfg: ConfigTrader): EstadoTrader {
  const s = espacio.senal;
  const porStop = new Map<string, EsqueletoTrader>();
  const porObjetivo = new Map<string, EsqueletoTrader>();
  for (const c of espacio.esqueletos) {
    const sActual = porStop.get(c.stop);
    if (!sActual || (c.viable && !sActual.viable)) porStop.set(c.stop, c);
    const oActual = porObjetivo.get(c.objetivo);
    if (!oActual || (c.viable && !oActual.viable)) porObjetivo.set(c.objetivo, c);
  }

  return {
    instrument:
      'a perpetual futures contract, traded continuously, with no session breaks and no closing auction',
    regime: regimeBlock(s),
    band: bandBlock(s),
    touch: touchBlock(s),
    costs: costsBlock(s, cfg),
    stop_choices: [...porStop.entries()].map(([k, c]) => ({
      key: k,
      detail: `${RESUMEN_STOP[k] ?? k}; ${detalleCelda(c)}`,
    })),
    target_choices: [...porObjetivo.entries()].map(([k, c]) => ({
      key: k,
      detail: `${RESUMEN_OBJETIVO[k] ?? k}; ${detalleCelda(c)}`,
    })),
    history: historyBlock(s),
  };
}
