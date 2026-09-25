/**
 * Régimen del mercado, sobre velas de 1 h CERRADAS (spec 058).
 *
 * Un rebote en el borde de un rango solo tiene ventaja si el mercado está en
 * rango. Aquí se decide si lo está, con cuatro medidas independientes y sin
 * guardar estado. La histéresis se recalcula en cada tick sobre las tres
 * últimas velas de 15 min.
 */
import { RegimenMercado, SentidoTendencia } from '@crypton/shared';
import { adx, atrSerie, bollinger, chop, eficiencia, percentil } from './estadistica';
import type { SerieNumerica } from './numeros';

export interface MedidasRegimen {
  adx: number;
  adxHace3: number;
  masDi: number;
  menosDi: number;
  chop1h: number;
  chop15m: number;
  percentilEficiencia: number;
  percentilAncho: number;
  ratioAtr: number;
}

export interface Regimen {
  regimen: RegimenMercado;
  sentido: SentidoTendencia | null;
  medidas: MedidasRegimen | null;
  /** Los tres crudos de la histéresis, del más antiguo al más reciente. */
  crudos: RegimenMercado[];
}

const HORA = 3_600_000;
const QUINCE = 900_000;
/** Velas de 1 h necesarias: el ATR de 96 más las tres de la histéresis. */
export const MIN_VELAS_1H = 100;
const MIN_VELAS_15M = 20;
const ADX_TENDENCIA = 25;
const ADX_TENDENCIA_FUERTE = 40;
const ADX_TOLERANCIA = 2;

/**
 * Las medidas del régimen sobre una serie. Se llaman «de hora» porque el canal
 * las toma de 1 h; los agentes las toman de su propio intervalo (spec 074).
 */
export interface IndicadoresHora {
  adx: Float64Array;
  masDi: Float64Array;
  menosDi: Float64Array;
  chop: Float64Array;
  eficiencia: Float64Array;
  ancho: Float64Array;
  atrCorto: Float64Array;
  atrLargo: Float64Array;
}

export function indicadoresHora(h1: SerieNumerica): IndicadoresHora {
  const a = adx(h1.h, h1.l, h1.c, 14);
  return {
    adx: a.adx,
    masDi: a.masDi,
    menosDi: a.menosDi,
    chop: chop(h1.h, h1.l, h1.c, 14),
    eficiencia: eficiencia(h1.c, 20),
    ancho: bollinger(h1.c, 20, 2).ancho,
    atrCorto: atrSerie(h1.h, h1.l, h1.c, 14),
    atrLargo: atrSerie(h1.h, h1.l, h1.c, 96),
  };
}

export function medidasEn(ind: IndicadoresHora, j: number, chop15m: number): MedidasRegimen | null {
  if (j < 3) return null;
  const m: MedidasRegimen = {
    adx: ind.adx[j],
    adxHace3: ind.adx[j - 3],
    masDi: ind.masDi[j],
    menosDi: ind.menosDi[j],
    chop1h: ind.chop[j],
    chop15m,
    percentilEficiencia: percentil(ind.eficiencia[j], ind.eficiencia.subarray(0, j + 1)),
    percentilAncho: percentil(ind.ancho[j], ind.ancho.subarray(0, j + 1)),
    ratioAtr: ind.atrCorto[j] / ind.atrLargo[j],
  };
  return Object.values(m).every((v) => Number.isFinite(v)) ? m : null;
}

/**
 * El régimen de UNA evaluación, sin histéresis. El orden importa: una
 * tendencia manda sobre todo, y una compresión (antesala de una ruptura) manda
 * sobre el rango.
 */
export function regimenCrudo(m: MedidasRegimen): {
  regimen: RegimenMercado;
  sentido: SentidoTendencia | null;
} {
  const sentido = m.masDi >= m.menosDi ? SentidoTendencia.ALCISTA : SentidoTendencia.BAJISTA;
  // Un ADX de 40 es tendencia aunque no suba: su caída desde 76 no es un rango.
  const tendencia =
    (m.adx >= ADX_TENDENCIA && m.adx >= m.adxHace3) ||
    m.adx >= ADX_TENDENCIA_FUERTE ||
    m.percentilEficiencia >= 70;
  if (tendencia) return { regimen: RegimenMercado.TENDENCIA, sentido };
  if (m.percentilAncho < 20 && m.ratioAtr < 0.8) {
    return { regimen: RegimenMercado.COMPRESION, sentido: null };
  }
  const criterios = [
    // «Sin subir», con dos puntos de tolerancia: el ADX de una hora a otra
    // oscila, y sin margen el criterio sería una moneda al aire.
    m.adx < 20 && m.adx - m.adxHace3 <= ADX_TOLERANCIA,
    m.chop1h > 55,
    m.percentilEficiencia <= 30,
    m.percentilAncho >= 20 && m.percentilAncho <= 70 && m.ratioAtr >= 0.8 && m.ratioAtr <= 1.2,
  ].filter(Boolean).length;
  if (criterios >= 3 && m.chop15m > 50) return { regimen: RegimenMercado.RANGO, sentido: null };
  return { regimen: RegimenMercado.INDEFINIDO, sentido: null };
}

/**
 * El régimen efectivo: el crudo de las tres últimas velas de 15 min cerradas,
 * cada una con las velas de 1 h que ya habían cerrado al terminar ella. Si los
 * tres no coinciden, INDEFINIDO: ni se entra en un rango que acaba de empezar
 * ni se da por muerto uno por una sola lectura.
 */
export function regimen(h1: SerieNumerica, s15: SerieNumerica): Regimen {
  const indefinido: Regimen = {
    regimen: RegimenMercado.INDEFINIDO,
    sentido: null,
    medidas: null,
    crudos: [],
  };
  if (h1.n < MIN_VELAS_1H || s15.n < MIN_VELAS_15M) return indefinido;
  const ind = indicadoresHora(h1);
  const chop15 = chop(s15.h, s15.l, s15.c, 14);

  const evaluaciones: {
    regimen: RegimenMercado;
    sentido: SentidoTendencia | null;
    m: MedidasRegimen;
  }[] = [];
  for (let k = s15.n - 3; k < s15.n; k++) {
    const fin = s15.t[k] + QUINCE;
    // La última vela de 1 h que ya había cerrado al terminar la de 15 min.
    let j = h1.n - 1;
    while (j >= 0 && h1.t[j] + HORA > fin) j--;
    const m = medidasEn(ind, j, chop15[k]);
    if (!m) return indefinido;
    evaluaciones.push({ ...regimenCrudo(m), m });
  }
  const crudos = evaluaciones.map((e) => e.regimen);
  const ultima = evaluaciones[evaluaciones.length - 1];
  const coinciden = crudos.every((r) => r === ultima.regimen);
  return {
    regimen: coinciden ? ultima.regimen : RegimenMercado.INDEFINIDO,
    sentido: coinciden ? ultima.sentido : null,
    medidas: ultima.m,
    crudos,
  };
}
