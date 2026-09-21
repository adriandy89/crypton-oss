/**
 * Setups sobre el canal: el rebote en el borde y el falso quiebre (spec 058).
 *
 * Un toque del borde no basta. El rebote pide confirmaciones, cada una con su
 * motivo:
 * - `MECHA`: el precio fue rechazado dentro de la vela del toque;
 * - `RSI`: el movimiento hasta el borde llegó sobreextendido;
 * - `DIVERGENCIA`: el precio marcó un extremo nuevo y el impulso no;
 * - `VOLUMEN`: el toque llegó sin el volumen de una ruptura.
 *
 * Solo un setup `LISTO` —con las confirmaciones mínimas— es elegible.
 */
import {
  Confirmacion,
  EstadoSetup,
  TipoCanal,
  TipoSetup,
  type CanalDetectado,
} from '@crypton/shared';
import { DECIMO_BANDA, nivelesEn, type FalsoQuiebre } from './canales';
import { rsi, sma } from './estadistica';
import type { SerieNumerica } from './numeros';
import type { Giro } from './swings';

export interface CandidatoBase {
  id: string;
  setup: TipoSetup;
  lado: 'LONG' | 'SHORT';
  estado: EstadoSetup;
  confirmaciones: Confirmacion[];
  /** El extremo del toque o de la ruptura: de él cuelgan los stops. */
  extremo: number;
}

export interface ParametrosSetups {
  minConfirmaciones: number;
  setups: readonly TipoSetup[];
  lados: readonly ('LONG' | 'SHORT')[];
  /** Un canal inclinado solo se opera a favor de su pendiente. */
  inclinadoSoloAFavor: boolean;
}

const EPS_ATR = 0.25;
const NO_ROTO_ATR = 0.1;
const MECHA_MINIMA = 0.5;
const VOLUMEN_MAXIMO = 1.5;
const RSI_LARGO = 30;
const RSI_CORTO = 70;
const RSI2_LARGO = 10;
const RSI2_CORTO = 90;

/** Los lados que se pueden operar en este canal, con la configuración. */
export function ladosPermitidos(
  canal: Pick<CanalDetectado, 'tipo' | 'pendientePorVela'>,
  p: Pick<ParametrosSetups, 'lados' | 'inclinadoSoloAFavor'>,
): ('LONG' | 'SHORT')[] {
  let lados = [...p.lados];
  if (p.inclinadoSoloAFavor && canal.tipo === TipoCanal.INCLINADO) {
    lados = lados.filter((l) => (canal.pendientePorVela > 0 ? l === 'LONG' : l === 'SHORT'));
  }
  return lados;
}

function mecha(s: SerieNumerica, k: number, lado: 'LONG' | 'SHORT'): boolean {
  const rango = s.h[k] - s.l[k];
  if (!(rango > 0)) return false;
  const medio = (s.h[k] + s.l[k]) / 2;
  if (lado === 'LONG') {
    const inferior = Math.min(s.o[k], s.c[k]) - s.l[k];
    return inferior >= MECHA_MINIMA * rango && s.c[k] >= medio;
  }
  const superior = s.h[k] - Math.max(s.o[k], s.c[k]);
  return superior >= MECHA_MINIMA * rango && s.c[k] <= medio;
}

function volumenTranquilo(s: SerieNumerica, k: number): boolean {
  const media = sma(s.v, 20)[k];
  return Number.isFinite(s.v[k]) && Number.isFinite(media) && s.v[k] <= VOLUMEN_MAXIMO * media;
}

function rsiExtremo(r14: number, r2: number, lado: 'LONG' | 'SHORT'): boolean {
  return lado === 'LONG'
    ? r14 <= RSI_LARGO || r2 <= RSI2_LARGO
    : r14 >= RSI_CORTO || r2 >= RSI2_CORTO;
}

/**
 * Divergencia contra el giro anterior del mismo lado: extremo más allá y RSI
 * de 15 min menos extremo.
 */
export function hayDivergencia(
  s15: SerieNumerica,
  rsi15: Float64Array,
  giros: readonly Giro[],
  extremo: number,
  lado: 'LONG' | 'SHORT',
): boolean {
  const tipo = lado === 'LONG' ? 'BAJO' : 'ALTO';
  const ultima = s15.n - 1;
  let previo: Giro | undefined;
  for (let i = giros.length - 1; i >= 0; i--) {
    if (giros[i].tipo === tipo && giros[i].confirmadoEn <= ultima) {
      previo = giros[i];
      break;
    }
  }
  if (!previo) return false;
  const ahora = rsi15[ultima];
  const antes = rsi15[previo.indice];
  if (!Number.isFinite(ahora) || !Number.isFinite(antes)) return false;
  return lado === 'LONG'
    ? extremo < previo.precio && ahora > antes
    : extremo > previo.precio && ahora < antes;
}

/** Los setups de la última vela cerrada de 5 min. */
export function detectarSetups(
  s5: SerieNumerica,
  s15: SerieNumerica,
  canal: CanalDetectado,
  falsoQuiebre: FalsoQuiebre | null,
  giros15: readonly Giro[],
  atr15: number,
  p: ParametrosSetups,
): CandidatoBase[] {
  if (s5.n < 25 || s15.n < 25 || !(atr15 > 0)) return [];
  const b = s5.n - 1;
  const a = s5.n - 2;
  const r14 = rsi(s5.c, 14)[b];
  const r2 = rsi(s5.c, 2)[b];
  const rsi15 = rsi(s15.c, 14);
  const { soporte, resistencia } = nivelesEn(canal, s5.t[b]);
  const anchura = resistencia - soporte;
  // Cuánto se acepta que falte para «estar en el borde». Un borde trazado desde
  // giros es un precio que el mercado defendió, y ahí un cuarto de ATR es
  // mucho. Una banda de Bollinger no la defiende nadie: el precio se le ACERCA
  // y se da la vuelta antes de llegar, y la regla que se midió entraba en su
  // décimo exterior (%B ≤ 0,1), que suele ser medio ATR (spec 067).
  const eps =
    canal.tipo === TipoCanal.BANDA
      ? Math.max(EPS_ATR * atr15, DECIMO_BANDA * anchura)
      : EPS_ATR * atr15;
  // Y hasta dónde puede haberse alejado el CIERRE del borde y seguir contando.
  // En un canal de giros es el tercio, que viene del spec 058. En una banda, el
  // décimo: la regla que se midió entraba con %B ≤ 0,1, y admitir el tercio es
  // dejar entrar tres veces más lejos del borde del que se midió, que es justo
  // donde la ventaja se diluye (spec 067).
  const cerca = canal.tipo === TipoCanal.BANDA ? DECIMO_BANDA * anchura : anchura / 3;
  const lados = ladosPermitidos(canal, p);
  const out: CandidatoBase[] = [];

  const cerrar = (
    setup: TipoSetup,
    lado: 'LONG' | 'SHORT',
    extremo: number,
    confirmaciones: Confirmacion[],
  ): CandidatoBase => ({
    id: `${setup === TipoSetup.REBOTE ? 'REB' : 'FQ'}-${lado === 'LONG' ? 'L' : 'S'}-${canal.id}`,
    setup,
    lado,
    estado:
      confirmaciones.length >= p.minConfirmaciones ? EstadoSetup.LISTO : EstadoSetup.VIGILANDO,
    confirmaciones,
    extremo,
  });

  if (p.setups.includes(TipoSetup.REBOTE)) {
    if (lados.includes('LONG')) {
      const k = s5.l[a] <= s5.l[b] ? a : b;
      const extremo = s5.l[k];
      const toca = extremo <= soporte + eps;
      const noRoto = s5.c[b] >= soporte - NO_ROTO_ATR * atr15;
      const abajo = s5.c[b] <= soporte + cerca;
      if (toca && noRoto && abajo) {
        const c: Confirmacion[] = [];
        if (mecha(s5, k, 'LONG')) c.push(Confirmacion.MECHA);
        if (rsiExtremo(r14, r2, 'LONG')) c.push(Confirmacion.RSI);
        if (hayDivergencia(s15, rsi15, giros15, extremo, 'LONG')) c.push(Confirmacion.DIVERGENCIA);
        if (volumenTranquilo(s5, k)) c.push(Confirmacion.VOLUMEN);
        out.push(cerrar(TipoSetup.REBOTE, 'LONG', extremo, c));
      }
    }
    if (lados.includes('SHORT')) {
      const k = s5.h[a] >= s5.h[b] ? a : b;
      const extremo = s5.h[k];
      const toca = extremo >= resistencia - eps;
      const noRoto = s5.c[b] <= resistencia + NO_ROTO_ATR * atr15;
      const arriba = s5.c[b] >= resistencia - cerca;
      if (toca && noRoto && arriba) {
        const c: Confirmacion[] = [];
        if (mecha(s5, k, 'SHORT')) c.push(Confirmacion.MECHA);
        if (rsiExtremo(r14, r2, 'SHORT')) c.push(Confirmacion.RSI);
        if (hayDivergencia(s15, rsi15, giros15, extremo, 'SHORT')) c.push(Confirmacion.DIVERGENCIA);
        if (volumenTranquilo(s5, k)) c.push(Confirmacion.VOLUMEN);
        out.push(cerrar(TipoSetup.REBOTE, 'SHORT', extremo, c));
      }
    }
  }

  if (p.setups.includes(TipoSetup.FALSO_QUIEBRE) && falsoQuiebre) {
    const lado = falsoQuiebre.lado;
    const mitad = (soporte + resistencia) / 2;
    // Recién vuelto dentro: el precio sigue en la mitad del borde roto.
    const cerca = lado === 'LONG' ? s5.c[b] <= mitad : s5.c[b] >= mitad;
    if (lados.includes(lado) && cerca) {
      const c: Confirmacion[] = [];
      if (mecha(s15, s15.n - 1, lado)) c.push(Confirmacion.MECHA);
      if (rsiExtremo(r14, r2, lado)) c.push(Confirmacion.RSI);
      if (hayDivergencia(s15, rsi15, giros15, falsoQuiebre.extremo, lado)) {
        c.push(Confirmacion.DIVERGENCIA);
      }
      if (volumenTranquilo(s15, falsoQuiebre.indice)) c.push(Confirmacion.VOLUMEN);
      out.push(cerrar(TipoSetup.FALSO_QUIEBRE, lado, falsoQuiebre.extremo, c));
    }
  }
  return out;
}
