/**
 * El seguimiento de una operación viva (spec 074): cómo va, si la idea sigue
 * en pie y qué se puede hacer con ella AHORA.
 *
 * Todas las acciones REDUCEN el riesgo (R-22). Solo tocan dos campos del bot,
 * y en un solo sentido:
 * - `stopPrice`, más ceñido que el vigente y con holgura hasta el precio: un
 *   stop pegado al precio es un cierre a mercado disfrazado;
 * - `positionCap`, menor que la posición; `'0'` es cerrar.
 * Una opción que no cumple las dos cosas no se ofrece. La estrategia vuelve a
 * mirarlo por su cuenta (stop monótono, R-2): esto es la primera línea.
 */
import {
  AccionSeguimiento,
  CLASE_DE_ACCION,
  ClaseAccion,
  D,
  Decimal,
  DisparadorSeguimiento,
  EfectoAccion,
  EstadoTesis,
  FamiliaAgente,
  RegimenMercado,
  SentidoTendencia,
  candleSpanMs,
  type Candle,
  type EstadoOperacionAgente,
  type MarketSpec,
  type OpcionSeguimiento,
  type PlanAgente,
  type Ticker,
} from '@crypton/shared';
import { llegaAlMinimo } from '../canal/herramienta';
import { aNumero, serieNumerica, type SerieNumerica } from '../canal/numeros';
import { px, qy } from '../common';
import { precioBreakeven } from '../operacion/gestion';
import {
  MIN_VELAS_AGENTE,
  indicadoresAgente,
  regimenAgente,
  type IndicadoresAgente,
  type RegimenAgente,
} from './mercado';

/** Un stop nuevo deja al menos este margen hasta el precio, en ATR del intervalo. */
export const HOLGURA_STOP_ATR = 0.25;
/** Y nunca menos de estos ticks. */
const HOLGURA_STOP_TICKS = 2;

/** La operación, tal y como la conoce la API. */
export interface OperacionViva {
  /** El plan con el que se ejecutó: su stop es el INICIAL, el que vale 1R. */
  plan: PlanAgente;
  /** El precio medio de entrada real. */
  entrada: string;
  /** La posición que queda, en valor absoluto. */
  posicion: string;
  /** La que llegó a haber: la base de la fracción. */
  posicionInicial: string;
  /** El stop vigente: el más ceñido que guarda la estrategia. */
  stop: string;
  tp1Hecho: boolean;
  abiertaEn: number;
}

export interface EntradaSeguimiento {
  op: OperacionViva;
  market: MarketSpec;
  ticker: Ticker;
  /** Velas del intervalo del agente, con historia de antes de la entrada. */
  velas: readonly Candle[];
  ahora: number;
}

const finitos = (...xs: number[]): boolean => xs.every((x) => Number.isFinite(x));

/**
 * La idea con la que se entró, mirada con la última vela cerrada. Cada familia
 * se rompe a su manera; y una tendencia en contra rompe cualquiera.
 */
export function tesisDe(
  plan: Pick<PlanAgente, 'familia' | 'lado' | 'extremo' | 'nivelIdea'>,
  s: SerieNumerica,
  ind: IndicadoresAgente,
  reg: RegimenAgente,
): { tesis: EstadoTesis; motivos: string[] } {
  const j = s.n - 1;
  const largo = plan.lado === 'LONG';
  const c = s.c[j];
  const a = ind.atr[j];
  const motivos: string[] = [];
  let rota = false;
  let debil = false;
  const contra = largo ? SentidoTendencia.BAJISTA : SentidoTendencia.ALCISTA;
  if (reg.regimen === RegimenMercado.TENDENCIA && reg.sentido === contra) {
    rota = true;
    motivos.push('TENDENCIA_EN_CONTRA');
  }
  if (plan.familia === FamiliaAgente.TENDENCIA) {
    const e20 = ind.ema20[j];
    const e50 = ind.ema50[j];
    if (finitos(c, e20, e50)) {
      if (largo ? c < e50 : c > e50) {
        rota = true;
        motivos.push('CIERRE_TRAS_MEDIA_LENTA');
      } else if (largo ? e20 < e50 : e20 > e50) {
        rota = true;
        motivos.push('CRUCE_DE_MEDIAS');
      } else if (largo ? c < e20 : c > e20) {
        debil = true;
        motivos.push('CIERRE_TRAS_MEDIA_RAPIDA');
      }
    }
    if (Number.isFinite(ind.adx[j]) && ind.adx[j] < 20) {
      debil = true;
      motivos.push('TENDENCIA_SIN_FUERZA');
    }
  } else if (plan.familia === FamiliaAgente.RUPTURA) {
    const nivel = plan.nivelIdea === null ? Number.NaN : aNumero(plan.nivelIdea);
    if (finitos(c, nivel, a)) {
      // Vuelta al rango por un cuarto de ATR: la ruptura ha fallado.
      if (largo ? c < nivel - 0.25 * a : c > nivel + 0.25 * a) {
        rota = true;
        motivos.push('VUELTA_AL_RANGO');
      } else if (largo ? c < nivel : c > nivel) {
        debil = true;
        motivos.push('DENTRO_DEL_NIVEL');
      }
    }
  } else {
    const extremo = aNumero(plan.extremo);
    const banda = largo ? ind.bbInferior[j] : ind.bbSuperior[j];
    if (finitos(c, extremo)) {
      if (largo ? c < extremo : c > extremo) {
        rota = true;
        motivos.push('NUEVO_EXTREMO');
      } else if (Number.isFinite(banda) && (largo ? c < banda : c > banda)) {
        debil = true;
        motivos.push('FUERA_DE_BANDA');
      }
    }
  }
  return {
    tesis: rota ? EstadoTesis.ROTA : debil ? EstadoTesis.DEBILITADA : EstadoTesis.INTACTA,
    motivos,
  };
}

/** Las velas cerradas a `ahora`. */
const cerradas = (velas: readonly Candle[], span: number, ahora: number): Candle[] =>
  velas.filter((v) => v.t + span <= ahora);

/** Cómo va la operación: lo que ve el modelo y lo que enseña la app. */
export function estadoOperacion(e: EntradaSeguimiento): EstadoOperacionAgente {
  const { op, ticker, ahora } = e;
  const largo = op.plan.lado === 'LONG';
  const entrada = D(op.entrada);
  const riesgo = entrada.minus(op.plan.stop).abs();
  const enR = (x: Decimal): number => (riesgo.gt(0) ? x.div(riesgo).toNumber() : 0);
  const aFavor = (p: Decimal): Decimal => (largo ? p.minus(entrada) : entrada.minus(p));
  const marca = D(ticker.mark);

  const span = candleSpanMs(op.plan.intervalo);
  const velas = cerradas(e.velas, span, ahora);
  // Lo más a favor y en contra: desde la primera vela entera tras la entrada,
  // más el precio de ahora. La vela de la entrada tiene precios de antes de
  // entrar, y contarlos inventaría recorridos que la operación no vivió.
  let mejor = marca;
  let peor = marca;
  for (const v of velas) {
    if (v.t < op.abiertaEn) continue;
    const alto = D(v.h);
    const bajo = D(v.l);
    if (largo) {
      mejor = Decimal.max(mejor, alto);
      peor = Decimal.min(peor, bajo);
    } else {
      mejor = Decimal.min(mejor, bajo);
      peor = Decimal.max(peor, alto);
    }
  }

  const pos = D(op.posicion);
  const inicial = D(op.posicionInicial);
  const siguiente = op.tp1Hecho ? op.plan.objetivos[1] : op.plan.objetivos[0];
  const minutos = Math.max(0, (ahora - op.abiertaEn) / 60_000);

  let tesis: { tesis: EstadoTesis; motivos: string[] } = {
    tesis: EstadoTesis.INTACTA,
    motivos: ['SIN_DATOS'],
  };
  let reg: RegimenAgente = { regimen: RegimenMercado.INDEFINIDO, sentido: null };
  if (velas.length >= MIN_VELAS_AGENTE) {
    const s = serieNumerica(velas);
    reg = regimenAgente(s);
    tesis = tesisDe(op.plan, s, indicadoresAgente(s), reg);
  }
  return {
    rAhora: enR(aFavor(marca)),
    mfeR: Math.max(0, enR(aFavor(mejor))),
    maeR: Math.min(0, enR(aFavor(peor))),
    minutos: Math.round(minutos),
    fraccionTiempo: op.plan.maxMinutos > 0 ? minutos / op.plan.maxMinutos : 0,
    tp1Hecho: op.tp1Hecho,
    stopR: enR(aFavor(D(op.stop))),
    posicionFraccion: inicial.gt(0) ? pos.div(inicial).toNumber() : 0,
    objetivoR: siguiente
      ? Math.max(0, enR(aFavor(D(siguiente.precio)).minus(aFavor(marca))))
      : null,
    tesis: tesis.tesis,
    motivosTesis: tesis.motivos,
    regimen: reg.regimen,
    sentido: reg.sentido,
  };
}

/** El ATR de la última vela cerrada, o null. */
function ultimoAtr(velas: readonly Candle[]): number | null {
  if (velas.length < 20) return null;
  const s = serieNumerica(velas);
  const a = indicadoresAgente(s).atr[s.n - 1];
  return Number.isFinite(a) && a > 0 ? a : null;
}

/**
 * Lo que se puede hacer con la operación ahora, con el cambio que lo aplica.
 * `MANTENER` va siempre, y siempre la primera.
 */
export function opcionesSeguimiento(e: EntradaSeguimiento): OpcionSeguimiento[] {
  const { op, market, ticker } = e;
  const largo = op.plan.lado === 'LONG';
  const entrada = D(op.entrada);
  const stopActual = D(op.stop);
  const pos = D(op.posicion);
  const inicial = D(op.posicionInicial);
  const riesgo = entrada.minus(op.plan.stop).abs();
  const marca = D(ticker.mark);

  /** Lo que se perdería al stop, en R del riesgo inicial; 0 si ya asegura beneficio. */
  const riesgoR = (stop: Decimal, q: Decimal): number => {
    if (!riesgo.gt(0) || !inicial.gt(0)) return 0;
    const porUnidad = largo ? entrada.minus(stop) : stop.minus(entrada);
    return Decimal.max(0, porUnidad).mul(q).div(riesgo.mul(inicial)).toNumber();
  };

  const out: OpcionSeguimiento[] = [
    {
      accion: AccionSeguimiento.MANTENER,
      clase: null,
      cambio: {},
      stopNuevo: null,
      posicionNueva: null,
      riesgoRestanteR: riesgoR(stopActual, pos),
    },
  ];
  if (!pos.gt(0) || !riesgo.gt(0)) return out;

  const atr = ultimoAtr(cerradas(e.velas, candleSpanMs(op.plan.intervalo), e.ahora));
  const holgura = Decimal.max(
    atr === null ? D(0) : D(atr.toString()).mul(HOLGURA_STOP_ATR),
    D(market.tickSize).mul(HOLGURA_STOP_TICKS),
  );
  const limite = largo ? marca.minus(holgura) : marca.plus(holgura);
  // Los stops del largo son ventas: redondean hacia arriba, hacia el precio,
  // que es ceñir un tick más y nunca menos. Los del corto, al revés.
  const ladoStop = largo ? 'SELL' : 'BUY';
  const nivelEnR = (r: number): Decimal =>
    D(px(market, largo ? entrada.plus(riesgo.mul(r)) : entrada.minus(riesgo.mul(r)), ladoStop));
  const stops: [AccionSeguimiento, Decimal][] = [
    [AccionSeguimiento.PROTEGER, precioBreakeven(market, entrada, largo, op.plan.costes)],
    [AccionSeguimiento.ASEGURAR_MEDIO_R, nivelEnR(0.5)],
    [AccionSeguimiento.ASEGURAR_UN_R, nivelEnR(1)],
  ];
  for (const [accion, stop] of stops) {
    const cine = largo ? stop.gt(stopActual) : stop.lt(stopActual);
    const cabe = largo ? stop.lt(limite) : stop.gt(limite);
    if (!cine || !cabe) continue;
    out.push({
      accion,
      clase: CLASE_DE_ACCION[accion],
      cambio: { stopPrice: stop.toFixed() },
      stopNuevo: stop.toFixed(),
      posicionNueva: null,
      riesgoRestanteR: riesgoR(stop, pos),
    });
  }

  // Reducir: lo que queda y lo que sale tienen que llegar a los mínimos del
  // venue. Lo que sale es una orden; lo que queda necesita su stop y sus
  // objetivos, que también lo son.
  const vistas = new Set<string>();
  const reducciones: [AccionSeguimiento, Decimal][] = [
    [AccionSeguimiento.REDUCIR_TERCIO, D(qy(market, pos.mul(2).div(3)))],
    [AccionSeguimiento.REDUCIR_MITAD, D(qy(market, pos.div(2)))],
  ];
  for (const [accion, queda] of reducciones) {
    const sale = pos.minus(queda);
    if (!queda.gt(0) || !sale.gt(0) || vistas.has(queda.toFixed())) continue;
    if (!llegaAlMinimo(market, queda, marca) || !llegaAlMinimo(market, sale, marca)) continue;
    vistas.add(queda.toFixed());
    out.push({
      accion,
      clase: ClaseAccion.REDUCIR,
      cambio: { positionCap: queda.toFixed() },
      stopNuevo: null,
      posicionNueva: queda.toFixed(),
      riesgoRestanteR: riesgoR(stopActual, queda),
    });
  }

  out.push({
    accion: AccionSeguimiento.CERRAR,
    clase: ClaseAccion.CERRAR,
    cambio: { positionCap: '0' },
    stopNuevo: null,
    posicionNueva: '0',
    riesgoRestanteR: 0,
  });
  return out;
}

/**
 * Las opciones que se pueden ofrecer con la autonomía del agente: las de una
 * clase que nunca se hace, fuera. Mantener se queda siempre.
 */
export function ofreciblesSegun(
  opciones: readonly OpcionSeguimiento[],
  efecto: (clase: ClaseAccion) => EfectoAccion,
): OpcionSeguimiento[] {
  return opciones.filter((o) => o.clase === null || efecto(o.clase) !== EfectoAccion.NUNCA);
}

/**
 * La huella del expediente: si no cambia, el seguimiento por intervalo no
 * pregunta otra vez (R-24). Gruesa a propósito —el R en cuartos, el stop en
 * décimas—: un precio que baila no es un expediente nuevo.
 */
export function huellaSeguimiento(
  estado: EstadoOperacionAgente,
  opciones: readonly OpcionSeguimiento[],
): string {
  const redondo = (x: number, paso: number): string => (Math.round(x / paso) * paso).toFixed(2);
  return [
    estado.tesis,
    estado.regimen,
    estado.sentido ?? '-',
    estado.tp1Hecho ? 'tp1' : '-',
    redondo(estado.rAhora, 0.25),
    redondo(estado.stopR, 0.1),
    redondo(estado.posicionFraccion, 0.01),
    opciones.map((o) => o.accion).join('+'),
  ].join('|');
}

/**
 * Lo que despierta al seguimiento fuera de su intervalo: el primer objetivo,
 * la idea rota o un cambio de régimen. null si nada de eso ha pasado desde el
 * estado anterior.
 */
export function eventoSeguimiento(
  previo: EstadoOperacionAgente | null,
  actual: EstadoOperacionAgente,
): DisparadorSeguimiento | null {
  if (!previo) return null;
  if (!previo.tp1Hecho && actual.tp1Hecho) return DisparadorSeguimiento.OBJETIVO_1;
  if (previo.tesis !== EstadoTesis.ROTA && actual.tesis === EstadoTesis.ROTA) {
    return DisparadorSeguimiento.TESIS_ROTA;
  }
  if (previo.regimen !== actual.regimen) return DisparadorSeguimiento.REGIMEN;
  return null;
}
