/**
 * Los rasgos de la vela para el «Bot de IA» (spec 068).
 *
 * Aquí no se escribe estadística: se envuelve la que ya existe en
 * `canal/estadistica.ts` y `canal/regimen.ts`. El filtro de régimen sobre todo
 * —en el walk-forward del spec 066 descartó el 87 % de las entradas y llevó el
 * R medio de −0,143 a +0,608—, que es la pieza más valiosa que este repo ha
 * medido y por eso entra tal cual.
 *
 * Todo lo que sale de aquí es **adimensional** (ATR, fracciones, percentiles) o
 * un precio como `string`. Ni un `number` de este fichero acaba en una orden:
 * para eso está `esqueletos.ts`, que cruza a `Decimal` una sola vez.
 */
import { Evidencia, type PositionSide, type SenalTrader, type TasasBase } from '@crypton/shared';
import {
  atrSerie,
  bollinger,
  cambiosDeSigno,
  mediaVidaOU,
  ols,
  rsi,
  sma,
} from '../canal/estadistica';
import type { SerieNumerica } from '../canal/numeros';
import { regimen, type Regimen } from '../canal/regimen';
import { hayDivergencia } from '../canal/setups';
import { swingsConfirmados } from '../canal/swings';
import { costeIdaVuelta, spreadBps, type Costes } from '../canal/costes';
import { etiquetarTripleBarrera, evidenciaDe } from '../canal/tasas-base';
import { wilsonInferior } from '../canal/estadistica';

/** Velas de 15 min que hacen falta antes de poder decir nada. */
export const MIN_VELAS_15M = 40;
/** Velas hacia atrás sobre las que se mide la deriva de la media. */
const VELAS_DERIVA = 20;
/** Velas sobre las que se mide el volumen de referencia. */
const VELAS_VOLUMEN = 20;

/** La banda en la última vela cerrada, que es lo que `esqueletos.ts` necesita. */
export interface Banda {
  superior: number;
  media: number;
  inferior: number;
  /** ATR(15m) de la última vela: la unidad en la que se miden los stops. */
  atr15: number;
  /** Apertura de la vela de 15 min a la que se refieren los niveles. */
  refT: number;
}

/** Cuántas velas se le dan a un toque histórico para resolverse. */
const VELAS_ETIQUETA = 24;
/** El stop con el que se etiqueta el histórico: el bucket por defecto, 2 ATR. */
const ATR_ETIQUETA = 2;

export interface ParametrosSenal {
  periodoBanda: number;
  sigmaBanda: number;
  /** Velas hacia atrás sobre las que se miden contención, cruces y media vida. */
  ventanaBanda: number;
  /** Fracción de la anchura que cuenta como «estar en el borde». */
  toquePorcentajeB: number;
  costes: Costes;
}

export interface EntradaSenal {
  s5: SerieNumerica;
  s15: SerieNumerica;
  h1: SerieNumerica;
  bid: number;
  ask: number;
  p: ParametrosSenal;
}

export interface ResultadoSenal {
  senal: SenalTrader;
  banda: Banda;
  regimen: Regimen;
  /**
   * ATR(1h) de la última vela horaria, en unidades de precio.
   *
   * Va aquí y no se estima en el llamante porque entra en
   * `apalancamientoPorStop`, que es la regla que decide cuánta palanca permite
   * la distancia a la liquidación. Estimarlo —«el de 15 min por dos»— es meter
   * un número inventado en un cálculo de seguridad (spec 068).
   */
  atr1h: number;
}

const finito = (x: number): boolean => Number.isFinite(x);

/**
 * La señal de la última vela de 15 min **cerrada**.
 *
 * Devuelve `null` cuando no hay datos para decir nada. Un `null` aquí no es un
 * error: es la respuesta honesta de un motor que no tiene con qué opinar, y
 * aguas arriba se traduce en «esta vela no se opera» sin gastar nada.
 */
export function senalTrader(e: EntradaSenal): ResultadoSenal | null {
  const { s15, h1, p } = e;
  if (s15.n < Math.max(MIN_VELAS_15M, p.periodoBanda + 2)) return null;

  const b = s15.n - 1;
  const bb = bollinger(s15.c, p.periodoBanda, p.sigmaBanda);
  const superior = bb.superior[b];
  const media = bb.media[b];
  const inferior = bb.inferior[b];
  if (!finito(superior) || !finito(inferior) || !(superior > inferior)) return null;

  const atrs = atrSerie(s15.h, s15.l, s15.c, 14);
  const atr15 = atrs[b];
  if (!(atr15 > 0)) return null;

  const anchura = superior - inferior;
  const cierre = s15.c[b];
  const porcentajeB = (cierre - inferior) / anchura;

  // El borde tocado fija la dirección, y con ella desaparece la única decisión
  // que el proveedor del 069 no podría tomar en aislamiento (spec 068).
  let lado: PositionSide | null = null;
  if (porcentajeB <= p.toquePorcentajeB) lado = 'LONG';
  else if (porcentajeB >= 1 - p.toquePorcentajeB) lado = 'SHORT';

  // Contención, cruces y media vida sobre la ventana pedida: son la evidencia
  // de que esto revierte, no de que esté simplemente quieto.
  const desde = Math.max(p.periodoBanda - 1, s15.n - p.ventanaBanda);
  let dentro = 0;
  const residuos: number[] = [];
  let velasDesdeUltimoToque = s15.n;
  for (let i = desde; i <= b; i++) {
    const sup = bb.superior[i];
    const inf = bb.inferior[i];
    if (!finito(sup) || !finito(inf)) continue;
    if (s15.c[i] >= inf && s15.c[i] <= sup) dentro++;
    residuos.push(s15.c[i] - bb.media[i]);
    const borde = p.toquePorcentajeB * (sup - inf);
    if (i < b && (s15.l[i] <= inf + borde || s15.h[i] >= sup - borde)) {
      velasDesdeUltimoToque = b - i;
    }
  }
  const medidas = Math.max(1, b - desde + 1);

  // Deriva de la media: el objetivo se pone donde la media VA a estar, no donde
  // está. Una media que huye del precio convierte un objetivo alcanzable en uno
  // que no lo es.
  const inicioDeriva = Math.max(p.periodoBanda - 1, b - VELAS_DERIVA);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = inicioDeriva; i <= b; i++) {
    if (finito(bb.media[i])) {
      xs.push(i);
      ys.push(bb.media[i]);
    }
  }
  const recta = xs.length >= 3 ? ols(xs, ys) : null;
  const derivaMediaAtr = recta ? recta.pendiente / atr15 : 0;

  // La vela del toque: mecha de rechazo y dónde cerró dentro de su propio rango.
  const rango = s15.h[b] - s15.l[b];
  const mecha =
    rango > 0
      ? lado === 'SHORT'
        ? (s15.h[b] - Math.max(s15.o[b], s15.c[b])) / rango
        : (Math.min(s15.o[b], s15.c[b]) - s15.l[b]) / rango
      : 0;
  const cierreEnMitad =
    rango > 0 &&
    (lado === 'SHORT' ? s15.c[b] <= s15.l[b] + rango / 2 : s15.c[b] >= s15.l[b] + rango / 2);

  const r2 = rsi(s15.c, 2);
  const r14 = rsi(s15.c, 14);
  const giros = swingsConfirmados(s15, atrs);
  const divergencia =
    lado !== null && hayDivergencia(s15, r14, giros, lado === 'LONG' ? s15.l[b] : s15.h[b], lado);

  const volumenes = sma(s15.v, VELAS_VOLUMEN);
  const volumenRatio =
    finito(volumenes[b]) && volumenes[b] > 0 && finito(s15.v[b]) ? s15.v[b] / volumenes[b] : 1;

  const reg = regimen(h1, s15);
  const spread = spreadBps(e.bid, e.ask);

  const senal: SenalTrader = {
    lado,
    porcentajeB,
    estiramientoAtr: Math.abs(cierre - media) / atr15,
    anchuraAtr: anchura / atr15,
    anchuraPct: (anchura / cierre) * 100,
    contencion: dentro / medidas,
    cruces: cambiosDeSigno(residuos),
    mediaVidaVelas: mediaVidaOU(residuos),
    derivaMediaAtr,
    mechaFraccion: mecha,
    cierreEnMitad,
    rsi2: r2[b],
    rsi14: r14[b],
    divergencia,
    volumenRatio,
    velasDesdeUltimoToque,
    adx1h: reg.medidas?.adx ?? Number.NaN,
    chop1h: reg.medidas?.chop1h ?? Number.NaN,
    idaVueltaPrecio: costeIdaVuelta(cierre, p.costes, spread),
    spreadBps: spread,
    evidencia: Evidencia.INSUFICIENTE,
    tasas: null,
  };

  // Las tasas de toques comparables, por triple barrera y con la geometría por
  // defecto (2 ATR de stop, la media de objetivo). Sin esto, la pregunta del
  // histórico no tiene nada que juzgar: probándolo contra BTC real se quedaba
  // clavada entre 0,2 y 0,36 en dieciséis llamadas seguidas, porque se le
  // estaba pidiendo opinar sobre una evidencia que no se le daba.
  senal.tasas = tasasDeToques(s15, bb, atrs, desde, b, p);
  senal.evidencia = senal.tasas ? senal.tasas.evidencia : Evidencia.INSUFICIENTE;

  const atrs1h = atrSerie(h1.h, h1.l, h1.c, 14);
  const atr1h = atrs1h[h1.n - 1];

  return {
    senal,
    banda: { superior, media, inferior, atr15, refT: s15.t[b] },
    regimen: reg,
    // Si el ATR horario no se puede medir, se cae al de 15 min: es MENOR, así
    // que la regla de liquidación pide más distancia, no menos. Equivocarse
    // hacia el lado prudente.
    atr1h: finito(atr1h) && atr1h > 0 ? atr1h : atr15,
  };
}

/**
 * Las tasas de los toques que ya se resolvieron dentro de la ventana.
 *
 * Solo cuenta los que tienen velas suficientes por delante para saber cómo
 * acabaron: contar uno sin resolver sería inventarse el final, que es
 * exactamente lo que `etiquetarTripleBarrera` se niega a hacer.
 */
function tasasDeToques(
  s15: SerieNumerica,
  bb: ReturnType<typeof bollinger>,
  atrs: Float64Array,
  desde: number,
  hasta: number,
  p: ParametrosSenal,
): TasasBase | null {
  const rs: number[] = [];
  for (let i = desde; i <= hasta - VELAS_ETIQUETA; i++) {
    const sup = bb.superior[i];
    const inf = bb.inferior[i];
    const atr = atrs[i];
    if (!finito(sup) || !finito(inf) || !(atr > 0) || !(sup > inf)) continue;

    const borde = p.toquePorcentajeB * (sup - inf);
    const largo = s15.l[i] <= inf + borde;
    const corto = s15.h[i] >= sup - borde;
    if (!largo && !corto) continue;

    const lado = largo ? 'LONG' : 'SHORT';
    const extremo = largo ? s15.l[i] : s15.h[i];
    const stop = largo ? extremo - ATR_ETIQUETA * atr : extremo + ATR_ETIQUETA * atr;
    const et = etiquetarTripleBarrera(
      s15,
      i,
      lado,
      s15.c[i],
      stop,
      bb.media[i],
      VELAS_ETIQUETA,
      p.costes,
    );
    if (et) rs.push(et.r);
  }

  const n = rs.length;
  if (n === 0) return null;
  const aciertos = rs.filter((r) => r > 0).length;
  return {
    n,
    aciertos,
    rMedio: rs.reduce((a, b) => a + b, 0) / n,
    wilsonInferior: wilsonInferior(aciertos, n),
    evidencia: evidenciaDe(n),
  };
}
