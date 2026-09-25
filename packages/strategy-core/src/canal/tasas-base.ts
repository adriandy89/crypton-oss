/**
 * Tasas base: cómo le fue a cada setup en el histórico cargado (spec 058).
 *
 * Un rebote en el borde acierta entre el 55 y el 68 % en la literatura; lo que
 * importa es cuánto en ESTE par y estos días. Se recorre el histórico de la
 * estructura como lo habría vivido el bot:
 * - cada `paso` velas se busca el canal con lo que se sabía en ese momento
 *   (prefijo de la serie y giros ya confirmados);
 * - en las velas siguientes se buscan toques de sus bordes;
 * - cada toque se etiqueta con triple barrera pesimista.
 *
 * Mide el TOQUE del borde, sin las confirmaciones del setup: es la tasa de la
 * base, no la del setup confirmado, que tendría muy pocos casos para decir nada.
 *
 * El etiquetado se exporta porque el backtest tiene que etiquetar igual: un test
 * fija que los dos coinciden.
 */
import {
  Evidencia,
  TipoSetup,
  type CalidadCanal,
  type TasasBase,
  type TipoCanal,
} from '@crypton/shared';
import { calidadSuficiente, detectarCanal, nivelesEn } from './canales';
import { costeIdaVuelta, type Costes } from './costes';
import { wilsonInferior } from './estadistica';
import { prefijoSerie, type SerieNumerica } from './numeros';
import { ladosPermitidos } from './setups';
import type { Giro } from './swings';

export type ResultadoEtiqueta = 'OBJETIVO' | 'STOP' | 'TIEMPO';

export interface Etiqueta {
  setup: TipoSetup;
  lado: 'LONG' | 'SHORT';
  /** Vela de la entrada: se entra a su cierre. */
  indice: number;
  entrada: number;
  stop: number;
  objetivo: number;
  /** Vela en la que se resolvió. */
  salida: number;
  resultado: ResultadoEtiqueta;
  /** Resultado en R, con costes. */
  r: number;
}

export interface ParametrosTasas {
  ventana: number;
  tiposPermitidos: readonly TipoCanal[];
  invalidacionAtr: number;
  calidadMinima: CalidadCanal;
  costes: Costes;
  /** La barrera de tiempo, en velas de la serie. */
  maxVelas: number;
  setups: readonly TipoSetup[];
  lados: readonly ('LONG' | 'SHORT')[];
  inclinadoSoloAFavor: boolean;
  /** Cada cuántas velas se vuelve a buscar el canal. */
  paso?: number;
}

export const PASO_TASAS = 8;
/** El stop de las etiquetas: el NORMAL de la herramienta. */
const ATR_STOP = 0.5;
// Los mismos umbrales que el setup (`setups.ts`) y el canal (`canales.ts`).
const EPS_ATR = 0.25;
const NO_ROTO_ATR = 0.1;
const MAX_FALSO_QUIEBRE_ATR = 1;
/** Las primeras velas que necesita el canal para poder existir. */
const MIN_VELAS = 31;

export function evidenciaDe(n: number): Evidencia {
  if (n < 20) return Evidencia.INSUFICIENTE;
  if (n <= 60) return Evidencia.DEBIL;
  return Evidencia.MODERADA;
}

export const claveTasas = (setup: TipoSetup, lado: 'LONG' | 'SHORT'): string => `${setup}|${lado}`;

/**
 * Triple barrera pesimista sobre velas cerradas: objetivo, stop y tiempo.
 *
 * - Una vela que toca el stop y el objetivo cuenta como stop: una vela no dice
 *   qué llegó antes.
 * - El objetivo tiene que PASARSE, no basta con llegar: una límite en el borde
 *   puede quedarse sin ejecutar. Es la regla del backtest (`TRADE_THROUGH`).
 * - Un hueco más allá del stop sale a la apertura, peor que −1R.
 * - Pasadas `maxVelas`, sale al cierre.
 * - Si la serie se acaba antes, no hay etiqueta (`null`): contarla sería
 *   inventarse el final.
 *
 * Los costes, como en la herramienta: entrada taker, stop y cierre por tiempo
 * taker con deslizamiento, objetivo maker.
 */
export function etiquetarTripleBarrera(
  s: SerieNumerica,
  indice: number,
  lado: 'LONG' | 'SHORT',
  entrada: number,
  stop: number,
  objetivo: number,
  maxVelas: number,
  costes: Costes,
): Omit<Etiqueta, 'setup'> | null {
  const largo = lado === 'LONG';
  const taker = costes.takerBps / 10_000;
  const maker = costes.makerBps / 10_000;
  const aMercado = taker + costes.deslizamientoBps / 10_000;
  const riesgo = Math.abs(entrada - stop) + entrada * taker + stop * aMercado;
  if (!(riesgo > 0) || (largo ? stop >= entrada : stop <= entrada)) return null;
  const r = (salida: number, comision: number): number =>
    ((largo ? salida - entrada : entrada - salida) - entrada * taker - salida * comision) / riesgo;
  const base = { lado, indice, entrada, stop, objetivo };
  const fin = indice + maxVelas;
  for (let i = indice + 1; i <= Math.min(fin, s.n - 1); i++) {
    const tocaStop = largo ? s.l[i] <= stop : s.h[i] >= stop;
    if (tocaStop) {
      const salida = largo ? Math.min(s.o[i], stop) : Math.max(s.o[i], stop);
      return { ...base, salida: i, resultado: 'STOP', r: r(salida, aMercado) };
    }
    const pasaObjetivo = largo ? s.h[i] > objetivo : s.l[i] < objetivo;
    if (pasaObjetivo) return { ...base, salida: i, resultado: 'OBJETIVO', r: r(objetivo, maker) };
  }
  if (fin > s.n - 1) return null;
  return { ...base, salida: fin, resultado: 'TIEMPO', r: r(s.c[fin], aMercado) };
}

/** El setup de la vela `j` para un lado, si lo hay: la ruptura fallida manda sobre el rebote. */
function setupEn(
  s: SerieNumerica,
  j: number,
  lado: 'LONG' | 'SHORT',
  canal: { soporte: string; resistencia: string; pendientePorVela: number; refT: number },
  atr: number,
  setups: readonly TipoSetup[],
): { setup: TipoSetup; extremo: number } | null {
  const largo = lado === 'LONG';
  const ahora = nivelesEn(canal, s.t[j]);
  const antes = nivelesEn(canal, s.t[j - 1]);
  if (setups.includes(TipoSetup.FALSO_QUIEBRE)) {
    const fuera = largo ? antes.soporte - s.c[j - 1] : s.c[j - 1] - antes.resistencia;
    const dentro = largo ? s.c[j] >= ahora.soporte : s.c[j] <= ahora.resistencia;
    if (fuera > 0 && fuera < MAX_FALSO_QUIEBRE_ATR * atr && dentro) {
      const extremo = largo ? Math.min(s.l[j - 1], s.l[j]) : Math.max(s.h[j - 1], s.h[j]);
      return { setup: TipoSetup.FALSO_QUIEBRE, extremo };
    }
  }
  if (setups.includes(TipoSetup.REBOTE)) {
    const anchura = ahora.resistencia - ahora.soporte;
    const eps = EPS_ATR * atr;
    const toca = largo ? s.l[j] <= ahora.soporte + eps : s.h[j] >= ahora.resistencia - eps;
    const noRoto = largo
      ? s.c[j] >= ahora.soporte - NO_ROTO_ATR * atr
      : s.c[j] <= ahora.resistencia + NO_ROTO_ATR * atr;
    const cerca = largo
      ? s.c[j] <= ahora.soporte + anchura / 3
      : s.c[j] >= ahora.resistencia - anchura / 3;
    if (toca && noRoto && cerca) {
      return { setup: TipoSetup.REBOTE, extremo: largo ? s.l[j] : s.h[j] };
    }
  }
  return null;
}

/**
 * Las etiquetas del histórico, sin mirar al futuro al buscar el canal.
 *
 * `giros` son los de la serie entera; en cada punto solo cuentan los ya
 * confirmados. Las etiquetas de un mismo lado no se solapan: mientras una
 * operación sigue abierta, el bot no abriría otra.
 */
export function etiquetasHistoricas(
  s: SerieNumerica,
  atr: ArrayLike<number>,
  giros: readonly Giro[],
  p: ParametrosTasas,
): Etiqueta[] {
  const paso = Math.max(1, p.paso ?? PASO_TASAS);
  const out: Etiqueta[] = [];
  const libreDesde = new Map<'LONG' | 'SHORT', number>();
  const visibles: Giro[] = [];
  const pendientes = [...giros].sort((a, b) => a.confirmadoEn - b.confirmadoEn);
  let g = 0;
  for (let k = Math.max(p.ventana, MIN_VELAS) - 1; k < s.n - 1; k += paso) {
    while (g < pendientes.length && pendientes[g].confirmadoEn <= k) visibles.push(pendientes[g++]);
    const a = atr[k];
    if (!(a > 0)) continue;
    const { canal } = detectarCanal(prefijoSerie(s, k + 1), visibles, a, {
      ventana: p.ventana,
      costeIdaVuelta: costeIdaVuelta(s.c[k], p.costes, 0),
      tiposPermitidos: p.tiposPermitidos,
      invalidacionAtr: p.invalidacionAtr,
    });
    if (!canal || !calidadSuficiente(canal.calidad, p.calidadMinima)) continue;
    const lados = ladosPermitidos(canal, p);
    for (let j = k + 1; j <= Math.min(k + paso, s.n - 1); j++) {
      const { soporte, resistencia, media } = nivelesEn(canal, s.t[j]);
      // Como en vivo (`detectarCanal`): un cierre fuera por un ATR o más acaba
      // con el canal; uno fuera por más de la invalidación solo lo suspende en
      // esa vela, y si el precio vuelve dentro puede haber falso quiebre.
      const fuera = Math.max(soporte - s.c[j], s.c[j] - resistencia, 0) / a;
      if (fuera >= MAX_FALSO_QUIEBRE_ATR) break;
      if (fuera > p.invalidacionAtr) continue;
      for (const lado of lados) {
        if (j < (libreDesde.get(lado) ?? 0)) continue;
        const hallado = setupEn(s, j, lado, canal, a, p.setups);
        if (!hallado) continue;
        const largo = lado === 'LONG';
        const stop = largo ? hallado.extremo - ATR_STOP * a : hallado.extremo + ATR_STOP * a;
        const e = etiquetarTripleBarrera(s, j, lado, s.c[j], stop, media, p.maxVelas, p.costes);
        if (!e) continue;
        out.push({ setup: hallado.setup, ...e });
        libreDesde.set(lado, e.salida + 1);
      }
    }
  }
  return out;
}

/**
 * Las tasas de un grupo de resultados en R: acierto es R positivo. Es la
 * cuenta de `resumirTasas`, aparte para que los agentes resuman sus familias
 * con ella (spec 074). Un grupo vacío no tiene tasas.
 */
export function tasasDeResultados(rs: readonly number[]): TasasBase | null {
  const n = rs.length;
  if (n === 0) return null;
  const aciertos = rs.filter((r) => r > 0).length;
  return {
    n,
    aciertos,
    rMedio: rs.reduce((acc, r) => acc + r, 0) / n,
    wilsonInferior: wilsonInferior(aciertos, n),
    evidencia: evidenciaDe(n),
  };
}

/** Las tasas por setup y lado (`claveTasas`). */
export function resumirTasas(etiquetas: readonly Etiqueta[]): Map<string, TasasBase> {
  const grupos = new Map<string, number[]>();
  for (const e of etiquetas) {
    const clave = claveTasas(e.setup, e.lado);
    const grupo = grupos.get(clave);
    if (grupo) grupo.push(e.r);
    else grupos.set(clave, [e.r]);
  }
  const out = new Map<string, TasasBase>();
  for (const [clave, rs] of grupos) {
    const tasas = tasasDeResultados(rs);
    if (tasas) out.set(clave, tasas);
  }
  return out;
}

export function tasasBase(
  s: SerieNumerica,
  atr: ArrayLike<number>,
  giros: readonly Giro[],
  p: ParametrosTasas,
): Map<string, TasasBase> {
  return resumirTasas(etiquetasHistoricas(s, atr, giros, p));
}
