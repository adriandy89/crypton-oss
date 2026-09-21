/**
 * La herramienta del canal: cada número de cada operación posible (spec 058).
 *
 * Es lo que la IA —o el juez de reglas— tiene delante para elegir, y lo único
 * de lo que puede salir una orden. Tres garantías, por construcción y con su
 * test de propiedad:
 * - la pérdida al stop, con comisiones y deslizamiento, no pasa del riesgo
 *   pedido ni del margen que queda en el tope diario;
 * - la liquidación queda al menos a `max(colchón·stop, 3·ATR(1h))` de la
 *   entrada en TODAS las bandas;
 * - lo que se pierde si el precio salta más allá de la liquidación —el margen
 *   aislado— no pasa de `maxMarginPct` del capital.
 *
 * Todo lo que es dinero va en `Decimal`. Los niveles del canal vienen de la
 * estadística en `number` y cruzan con `aDecimal` antes de pasar por `px()`.
 */
import {
  BandaApalancamiento,
  D,
  Decimal,
  EsquemaObjetivo,
  EstadoSetup,
  Evidencia,
  MAX_APALANCAMIENTO_POR_STOP,
  TamanoOperacion,
  TipoStop,
  Veredicto,
  candleSpanMs,
  maintenanceMarginRateOf,
  precioLiquidacionAislada,
  type BandaCalculada,
  TipoCanal,
  type CanalDetectado,
  type CandidatoOperacion,
  type ContextoMercado,
  type EleccionOperacion,
  type HistorialOperaciones,
  type MarketSpec,
  type NivelApalancamiento,
  type ObjetivoPlan,
  type OpcionStop,
  type PlanOperacion,
  type SalidaHerramienta,
  type ResumenTasas,
  type Ticker,
  type UsoDelDia,
} from '@crypton/shared';
import { px, qy } from '../common';
import { dimensionar, llegaAlMinimo, tramosOrdenados } from '../dimension';

// Se mudaron a `../dimension.ts` (spec 068). Se reexportan para no arrastrar a
// sus importadores en el mismo commit que el traslado.
export { llegaAlMinimo, tramosOrdenados };
import { nivelTexto } from './canales';
import type { ConfigCanal, EvidenciaMinima } from './config';
import { costeIdaVuelta } from './costes';
import { aDecimal } from './numeros';
import type { CandidatoBase } from './setups';

/**
 * A cuántos ATR(15m) más allá del extremo va cada stop, antes del medio spread.
 *
 * Con esta escalera, el coste de ida y vuelta —fijo en porcentaje— se llevaba
 * el 67 % del riesgo en la operación mediana y el riesgo ENTERO en ocho de cada
 * veintiocho: aritmética imposible antes de mirar el mercado.
 *
 * Se probó a ensancharla a 1 / 1,5 / 2,5 (spec 066), con el razonamiento de que
 * para dejar el coste por debajo del quinto del riesgo hace falta un stop de
 * unas cinco veces el coste, y en velas de 15 minutos eso es un par de ATR. No
 * funcionó: el stop se iba por encima de `maxStopPct` y las opciones pasaban de
 * morir por COSTE a morir por STOP_ANCHO, sin ninguna operación de más.
 *
 * La escalera se queda donde estaba y quien descarta la aritmética imposible es
 * `maxCosteR`, que mide justo eso y además es del usuario.
 */
export const ATR_POR_STOP: Readonly<Record<TipoCanal, Readonly<Record<TipoStop, number>>>> = {
  [TipoCanal.HORIZONTAL]: {
    [TipoStop.AJUSTADO]: 0.25,
    [TipoStop.NORMAL]: 0.5,
    [TipoStop.AMPLIO]: 1,
  },
  [TipoCanal.INCLINADO]: {
    [TipoStop.AJUSTADO]: 0.25,
    [TipoStop.NORMAL]: 0.5,
    [TipoStop.AMPLIO]: 1,
  },
  // Una banda de Bollinger no es un precio que nadie haya defendido: es la
  // desviación típica de los últimos veinte cierres, y el precio la atraviesa
  // sin que pase nada. Un stop pegado al borde salta por ruido. La medición que
  // trajo este tipo de canal usaba **2 ATR**, y con un cuarto de ATR ni se
  // parece: por eso aquí la escalera es otra (spec 067).
  [TipoCanal.BANDA]: {
    [TipoStop.AJUSTADO]: 1,
    [TipoStop.NORMAL]: 1.5,
    [TipoStop.AMPLIO]: 2.5,
  },
};

export const TIPOS_STOP: readonly TipoStop[] = [
  TipoStop.AJUSTADO,
  TipoStop.NORMAL,
  TipoStop.AMPLIO,
];

/** El segundo objetivo se queda a esta fracción de la anchura del borde opuesto. */
const HOLGURA_OBJETIVO = D('0.15');
/** Del tope diario que queda, lo que puede arriesgar una operación. */
const PARTE_DEL_TOPE_DIARIO = D('0.9');
/** Del saldo libre, lo que puede inmovilizar la operación. */
const PARTE_DEL_SALDO = D('0.9');
/** El tope absoluto de apalancamiento de esta estrategia. */
export const APALANCAMIENTO_MAXIMO = MAX_APALANCAMIENTO_POR_STOP;
const QUINCE_MIN = 900_000;

/**
 * La apertura de la vela del primer toque del canal. La duración cuenta velas
 * de la estructura (5 o 15 min), no de 15: es desde donde se dibuja.
 */
export const inicioDelCanal = (
  canal: Pick<CanalDetectado, 'refT' | 'duracionVelas'>,
  intervalo: ConfigCanal['intervaloEstructura'],
): number => canal.refT - canal.duracionVelas * candleSpanMs(intervalo);

export interface EntradaHerramienta {
  cfg: ConfigCanal;
  market: MarketSpec;
  ticker: Ticker;
  /** Lo que la cuenta tiene libre para margen, en la quote. */
  saldoLibre: string;
  historial: HistorialOperaciones;
  niveles: readonly NivelApalancamiento[];
  maxApalancamientoUsuario: number | null;
  mercado: ContextoMercado;
  canal: CanalDetectado | null;
  candidatos: readonly CandidatoBase[];
  /** Tasas base por id de candidato, si se calcularon. */
  tasas: ReadonlyMap<string, ResumenTasas>;
  /** Apertura de la última vela cerrada de 5 min. */
  barT: number;
  ahora: number;
}

/** Lo que se ha perdido hoy, en % del capital (0 si se va ganando). */
export function perdidaHoyPct(historial: HistorialOperaciones, capital: Decimal): Decimal {
  if (!capital.gt(0)) return D(0);
  return Decimal.max(0, D(historial.realizadoHoy).neg()).div(capital).mul(100);
}

/** El riesgo en dinero de una operación: el pedido, sin pasar del margen del tope diario. */
export function riesgoDisponible(cfg: ConfigCanal, historial: HistorialOperaciones): Decimal {
  const porOperacion = cfg.capital.mul(cfg.riesgoPct).div(100);
  const margenDiario = cfg.capital
    .mul(cfg.topeDiarioPct.minus(perdidaHoyPct(historial, cfg.capital)))
    .div(100)
    .mul(PARTE_DEL_TOPE_DIARIO);
  return Decimal.min(porOperacion, margenDiario);
}

/** ¿Llega la evidencia del histórico a lo que pide la configuración? */
export function evidenciaSuficiente(tasas: ResumenTasas | null, minima: EvidenciaMinima): boolean {
  if (minima === 'NO') return true;
  if (!tasas) return false;
  if (minima === 'MODERADA') return tasas.evidencia === Evidencia.MODERADA;
  return tasas.evidencia === Evidencia.DEBIL || tasas.evidencia === Evidencia.MODERADA;
}

/**
 * Los niveles del canal en el instante `t`, en `Decimal`.
 *
 * Es `nivelesEn` sin pasar por `number`: los niveles llegan como texto y solo
 * el desplazamiento de un inclinado es estadística. En coma flotante,
 * `99.9 + 0.15·3` da `100.35000000000001`, y el objetivo acababa un tick más
 * allá de donde debía.
 */
export function nivelesDecimalesEn(
  canal: Pick<CanalDetectado, 'soporte' | 'resistencia' | 'pendientePorVela' | 'refT'>,
  t: number,
): { soporte: Decimal; resistencia: Decimal; media: Decimal } {
  const desplazamiento = D(nivelTexto((canal.pendientePorVela * (t - canal.refT)) / QUINCE_MIN));
  const soporte = D(canal.soporte).plus(desplazamiento);
  const resistencia = D(canal.resistencia).plus(desplazamiento);
  return { soporte, resistencia, media: soporte.plus(resistencia).div(2) };
}

/** Los dos objetivos del canal para un lado, en el instante `t`, redondeados HACIA la entrada. */
export function objetivosDelCanal(
  market: MarketSpec,
  canal: CanalDetectado,
  largo: boolean,
  t: number,
): { tp1: Decimal; tp2: Decimal } {
  const { soporte, resistencia, media } = nivelesDecimalesEn(canal, t);
  const holgura = resistencia.minus(soporte).mul(HOLGURA_OBJETIVO);
  const opuesto = largo ? resistencia.minus(holgura) : soporte.plus(holgura);
  // Un objetivo del largo está por encima de la entrada: hacia ella es hacia
  // abajo, que es como redondea una compra. En el corto, al revés.
  const lado = largo ? 'BUY' : 'SELL';
  return { tp1: D(px(market, media, lado)), tp2: D(px(market, opuesto, lado)) };
}

/** El stop de un tipo, redondeado HACIA la entrada; null si no queda por encima de cero. */
export function precioDeStop(
  e: Pick<EntradaHerramienta, 'market' | 'ticker' | 'mercado'>,
  cand: Pick<CandidatoBase, 'lado' | 'extremo'>,
  tipo: TipoStop,
  tipoCanal: TipoCanal,
): Decimal | null {
  const largo = cand.lado === 'LONG';
  const medioSpread = D(e.ticker.ask).minus(e.ticker.bid).abs().div(2);
  const distancia = D(e.mercado.atr15m).mul(ATR_POR_STOP[tipoCanal][tipo]).plus(medioSpread);
  const extremo = aDecimal(cand.extremo);
  const bruto = largo ? extremo.minus(distancia) : extremo.plus(distancia);
  if (!bruto.gt(0)) return null;
  // El stop del largo es una venta y redondea hacia arriba: un tick más cerca
  // de la entrada, nunca más lejos. El del corto, al revés.
  const stop = D(px(e.market, bruto, largo ? 'SELL' : 'BUY'));
  return stop.gt(0) ? stop : null;
}

/**
 * La referencia (ask o bid) y el tope de la IOC, UNO por candidato.
 *
 * La holgura se mide en R del stop válido más cercano. Así ninguna opción
 * admite más deslizamiento del pedido, y todas se calculan con la misma entrada
 * que luego se manda: si cada stop tuviera su tope, el del ajustado podría
 * acabar ejecutándose con el tope del amplio y perder más de lo calculado.
 */
export function preciosDeEntrada(
  market: MarketSpec,
  ticker: Ticker,
  largo: boolean,
  stops: readonly (Decimal | null)[],
  maxDeslizamientoR: Decimal,
): { referencia: Decimal; tope: Decimal } {
  const referencia = D(largo ? ticker.ask : ticker.bid);
  let base: Decimal | null = null;
  for (const stop of stops) {
    if (!stop || (largo ? stop.gte(referencia) : stop.lte(referencia))) continue;
    const d = referencia.minus(stop).abs();
    if (!base || d.lt(base)) base = d;
  }
  if (!base) return { referencia, tope: referencia };
  const holgura = base.mul(maxDeslizamientoR);
  const bruto = largo ? referencia.plus(holgura) : referencia.minus(holgura);
  // La compra redondea hacia abajo y la venta hacia arriba: el tope nunca deja
  // más deslizamiento del pedido. Si la holgura no llega a un tick, el tope es
  // la propia referencia.
  const redondo = D(px(market, bruto, largo ? 'BUY' : 'SELL'));
  const tope = largo ? Decimal.max(redondo, referencia) : Decimal.min(redondo, referencia);
  return { referencia, tope };
}

/**
 * Los tramos del par de menor a mayor nocional. Sin tramos, o si el primero no
 * empieza en cero, rige el del mercado entero, como en `tramoDeApalancamiento`.
 */

const inviable = (tipo: TipoStop, precio: string, motivo: string): OpcionStop => ({
  tipo,
  precio,
  distancia: 0,
  viable: false,
  motivo,
  nocional: null,
  cantidad: null,
  riesgo: null,
  perdidaAlStop: null,
  perdidaPorUnidad: null,
  esquemasViables: [],
  bandas: [],
  apalancamientoMinimo: null,
  apalancamientoMaximo: null,
  rNetoTp1: null,
  rNetoTp2: null,
  costeR: null,
  aciertoEquilibrioTp1: null,
  aciertoEquilibrioTp2: null,
  riesgoPctCapital: null,
  medioViable: false,
});

/**
 * Si la mitad del tamaño sigue llegando a los mínimos del venue. Es la misma
 * cuenta que hace `construirOperacion` con `MEDIO`: si no casaran, la oferta
 * prometería algo que la ejecución rechaza.
 */
export const medioLlegaAlMinimo = (market: MarketSpec, cantidad: Decimal, tope: Decimal): boolean =>
  llegaAlMinimo(market, D(qy(market, cantidad.div(2))), tope);

/**
 * Una opción de stop con todos sus números.
 *
 * Exportada para el test de propiedad: es aquí donde se sostienen las tres
 * garantías de la cabecera.
 */
export function opcionDeStop(
  e: EntradaHerramienta,
  cand: CandidatoBase,
  tipo: TipoStop,
  stop: Decimal | null,
  tope: Decimal,
  tp1: Decimal,
  tp2: Decimal,
): OpcionStop {
  const { cfg, market } = e;
  const largo = cand.lado === 'LONG';
  if (!stop) return inviable(tipo, '0', 'STOP_INVALIDO');
  const precioStop = stop.toFixed();
  // El precio ya pasó el stop: la operación nacería saltada.
  if (largo ? stop.gte(tope) : stop.lte(tope)) return inviable(tipo, precioStop, 'STOP_INVALIDO');
  const distancia = tope.minus(stop).abs();
  const s = distancia.div(tope);
  if (s.gt(cfg.maxStopPct.div(100))) return inviable(tipo, precioStop, 'STOP_ANCHO');
  if (!cfg.capital.gt(0)) return inviable(tipo, precioStop, 'CAPITAL');

  const riesgo = riesgoDisponible(cfg, e.historial);
  if (!riesgo.gt(0)) return inviable(tipo, precioStop, 'TOPE_DIARIO');

  const taker = D(cfg.costes.takerBps).div(10_000);
  const maker = D(cfg.costes.makerBps).div(10_000);
  const deslizamiento = D(cfg.costes.deslizamientoBps).div(10_000);
  // Pérdida por unidad de moneda al saltar el stop: el precio, la comisión de
  // entrada (la IOC es taker) y la salida a mercado con su deslizamiento.
  const porUnidad = distancia.plus(tope.mul(taker)).plus(stop.mul(taker.plus(deslizamiento)));

  // ── Que la aritmética cierre ANTES de dimensionar nada (spec 066) ──
  //
  // `costeR` es la parte del riesgo que se van comisiones y deslizamiento. Se
  // calculaba ya, al final, y solo se le enseñaba a la IA: era información, no
  // una puerta. Con 0,67 de coste por R —la mediana medida— una operación
  // necesita 2R brutos para sacar 1R neto, y eso no lo arregla ningún acierto.
  const costeR = porUnidad.minus(distancia).div(distancia);
  if (costeR.gt(cfg.maxCosteR)) return inviable(tipo, precioStop, 'COSTE');

  // Y el objetivo se mide en COSTES, no solo en múltiplos del stop: `minRR`
  // compara con el stop, así que uno diminuto pasa con un objetivo diminuto.
  //
  // Se mide contra el objetivo MÁS CERCANO que algún esquema admitido vaya a
  // usar de verdad. `tp1` es la media del canal y `tp2` el borde opuesto, al
  // doble de distancia: a quien solo admite `OPUESTO` no se le puede negar la
  // entrada por lo corto que le quedaría un objetivo que nunca va a poner.
  const soloOpuesto = cfg.esquemas.every((x) => x === EsquemaObjetivo.OPUESTO);
  const objetivo = soloOpuesto ? tp2 : tp1;
  const idaYVuelta = D(costeIdaVuelta(tope.toNumber(), cfg.costes, 0));
  if (objetivo.minus(tope).abs().lt(idaYVuelta.mul(cfg.minObjetivoCoste))) {
    return inviable(tipo, precioStop, 'OBJETIVO_CORTO');
  }

  const maxMargen = Decimal.min(
    cfg.capital.mul(cfg.maxMargenPct).div(100),
    D(e.saldoLibre).mul(PARTE_DEL_SALDO),
  );
  if (!maxMargen.gt(0)) return inviable(tipo, precioStop, 'SIN_MARGEN');

  // El dimensionado por tramos vive en `../dimension.ts` desde el spec 068: lo
  // comparten esta herramienta y el motor del «Bot de IA», y una copia en cada
  // sitio sería un sitio más donde olvidarse del siguiente arreglo.
  const { dim: mejor, motivo } = dimensionar({
    market,
    niveles: e.niveles,
    tope,
    distanciaStop: s,
    atr1hRelativo: D(e.mercado.atr1h).div(tope),
    riesgo,
    perdidaPorUnidad: porUnidad,
    capital: cfg.capital,
    multiploNocional: cfg.multiploNocional,
    topeNocional: cfg.topeNocional,
    maxMargen,
    colchonStops: cfg.colchonStops,
    topesApalancamiento: [
      APALANCAMIENTO_MAXIMO,
      cfg.apalancamientoTope,
      e.maxApalancamientoUsuario ?? APALANCAMIENTO_MAXIMO,
    ],
    mantenimientoMercado: maintenanceMarginRateOf(market),
  });
  if (!mejor) return inviable(tipo, precioStop, motivo);
  const { cantidad, nocional } = mejor;

  const perdidaAlStop = porUnidad.mul(cantidad);
  const bandas: BandaCalculada[] = [];
  const valores: [BandaApalancamiento, number][] = [
    [BandaApalancamiento.BAJA, mejor.lMin],
    [BandaApalancamiento.MEDIA, Math.round((mejor.lMin + mejor.lMax) / 2)],
    [BandaApalancamiento.ALTA, mejor.lMax],
  ];
  for (const [banda, apalancamiento] of valores) {
    const margen = nocional.div(apalancamiento);
    const liquidacion = precioLiquidacionAislada(
      tope,
      apalancamiento,
      mejor.mantenimiento,
      cand.lado,
    );
    // La garantía, comprobada otra vez: la liquidación va detrás del stop.
    if (liquidacion && (largo ? liquidacion.gte(stop) : liquidacion.lte(stop))) {
      return inviable(tipo, precioStop, 'LIQUIDACION');
    }
    bandas.push({
      banda,
      apalancamiento,
      margen: margen.toFixed(2),
      // Redondeada hacia la entrada: la estimación que se enseña nunca es la optimista.
      liquidacion: liquidacion ? px(market, liquidacion, largo ? 'SELL' : 'BUY') : null,
      perdidaCatastrofica: margen.toFixed(2),
    });
  }

  const rNeto = (objetivo: Decimal): number => {
    const bruto = (largo ? objetivo.minus(tope) : tope.minus(objetivo)).mul(cantidad);
    const comisiones = tope.mul(taker).plus(objetivo.mul(maker)).mul(cantidad);
    return bruto.minus(comisiones).div(perdidaAlStop).toNumber();
  };
  const r1 = rNeto(tp1);
  const r2 = rNeto(tp2);
  const esquemasViables: EsquemaObjetivo[] = [];
  if (r1 >= cfg.minRR) esquemasViables.push(EsquemaObjetivo.MEDIA, EsquemaObjetivo.ESCALONADO);
  // En un canal de banda, el borde opuesto está a CUATRO sigmas: apuntar ahí no
  // es revertir a la media, es pedir la travesía entera del canal. Medido sobre
  // doce pares y siete meses, dejar que el juez eligiera el borde opuesto —o el
  // escalonado, que cobra la mitad ahí— hundía el R medio de +0,28 a −0,21 y el
  // acierto del 42 % al 21 %: más de la mitad de las operaciones no llegaban a
  // ninguna barrera y morían por tiempo. En un canal de giros el borde opuesto
  // es un precio que el mercado ya defendió, y ahí sigue teniendo sentido.
  const travesiaEntera = e.canal?.tipo === TipoCanal.BANDA;
  if (r2 >= cfg.minRR && !travesiaEntera) esquemasViables.push(EsquemaObjetivo.OPUESTO);
  const permitidos = esquemasViables
    .filter((x) => cfg.esquemas.includes(x))
    .filter((x) => !(travesiaEntera && x === EsquemaObjetivo.ESCALONADO));
  const equilibrio = (r: number): number | null => (r > 0 ? 1 / (1 + r) : null);

  return {
    tipo,
    precio: precioStop,
    distancia: s.toNumber(),
    viable: permitidos.length > 0,
    motivo: permitidos.length > 0 ? null : 'RR',
    nocional: nocional.toFixed(),
    cantidad: cantidad.toFixed(),
    riesgo: riesgo.toFixed(2),
    perdidaAlStop: perdidaAlStop.toFixed(),
    perdidaPorUnidad: porUnidad.toFixed(),
    esquemasViables: permitidos,
    bandas,
    apalancamientoMinimo: mejor.lMin,
    apalancamientoMaximo: mejor.lMax,
    rNetoTp1: r1,
    rNetoTp2: r2,
    costeR: costeR.toNumber(),
    aciertoEquilibrioTp1: equilibrio(r1),
    aciertoEquilibrioTp2: equilibrio(r2),
    riesgoPctCapital: perdidaAlStop.div(cfg.capital).mul(100).toNumber(),
    medioViable: medioLlegaAlMinimo(market, cantidad, tope),
  };
}

/** La huella de una oferta: la vela, el canal y los candidatos con su estado. */
export function huellaDe(
  barT: number,
  canalId: string | null,
  candidatos: readonly Pick<CandidatoOperacion, 'id' | 'estado'>[],
): string {
  const ids = candidatos.map((c) => `${c.id}:${c.estado}`).sort();
  return `${barT}|${canalId ?? '-'}|${ids.join(',')}`;
}

/** Un candidato se puede elegir si está LISTO y nada lo descarta. */
export const esElegible = (c: Pick<CandidatoOperacion, 'estado' | 'descartes'>): boolean =>
  c.estado === EstadoSetup.LISTO && c.descartes.length === 0;

export function herramientaCanal(e: EntradaHerramienta): SalidaHerramienta {
  const canal = e.canal;
  const candidatos: CandidatoOperacion[] = !canal
    ? []
    : e.candidatos.map((cand) => {
        const largo = cand.lado === 'LONG';
        const { tp1, tp2 } = objetivosDelCanal(e.market, canal, largo, e.ahora);
        const precios = TIPOS_STOP.map((tipo) => precioDeStop(e, cand, tipo, canal.tipo));
        const { referencia, tope } = preciosDeEntrada(
          e.market,
          e.ticker,
          largo,
          precios,
          e.cfg.maxDeslizamientoR,
        );
        const stops = TIPOS_STOP.map((tipo, i) =>
          opcionDeStop(e, cand, tipo, precios[i], tope, tp1, tp2),
        );
        const tasas = e.tasas.get(cand.id) ?? null;
        const descartes: string[] = [];
        if (cand.estado !== EstadoSetup.LISTO) descartes.push('CONFIRMACIONES');
        if (!stops.some((o) => o.viable)) descartes.push('SIN_OPCION_VIABLE');
        // Con evidencia de verdad y esperanza negativa, el setup no se ofrece.
        if (tasas?.evidencia === Evidencia.MODERADA && tasas.rMedio < 0) {
          descartes.push('ESPERANZA_NEGATIVA');
        }
        if (!evidenciaSuficiente(tasas, e.cfg.evidenciaMinima)) descartes.push('EVIDENCIA');
        return {
          id: cand.id,
          setup: cand.setup,
          lado: cand.lado,
          estado: cand.estado,
          confirmaciones: cand.confirmaciones,
          canalId: canal.id,
          entradaReferencia: referencia.toFixed(),
          entradaTope: tope.toFixed(),
          extremo: aDecimal(cand.extremo).toFixed(),
          tp1: tp1.toFixed(),
          tp2: tp2.toFixed(),
          stops,
          tasas,
          descartes,
        };
      });
  const uso: UsoDelDia = {
    perdidaHoyPct: perdidaHoyPct(e.historial, e.cfg.capital).toNumber(),
    topeDiarioPct: e.cfg.topeDiarioPct.toNumber(),
    operacionesHoy: e.historial.operacionesHoy,
    topeOperaciones: e.cfg.maxOperacionesDia,
    rachaPerdidas: e.historial.rachaPerdidas,
  };
  return {
    version: 1,
    barT: e.barT,
    generadaEn: e.ahora,
    mercado: e.mercado,
    canal,
    candidatos,
    uso,
    huella: huellaDe(e.barT, canal?.id ?? null, candidatos),
  };
}

/** Los tramos de salida de un esquema, fundidos si alguno no llega al mínimo. */
export function objetivosDeEsquema(
  market: MarketSpec,
  esquema: EsquemaObjetivo,
  cantidad: Decimal,
  tp1: Decimal,
  tp2: Decimal,
  fraccionTp1: Decimal,
): ObjetivoPlan[] {
  const todo = (precio: Decimal): ObjetivoPlan[] => [
    { precio: precio.toFixed(), cantidad: cantidad.toFixed() },
  ];
  if (esquema === EsquemaObjetivo.MEDIA) return todo(tp1);
  if (esquema === EsquemaObjetivo.OPUESTO) return todo(tp2);
  const primera = D(qy(market, cantidad.mul(fraccionTp1)));
  const segunda = cantidad.minus(primera);
  // Una parte no llega al mínimo del venue: todo al primer objetivo, que es el
  // que sostiene la viabilidad del escalonado.
  if (!llegaAlMinimo(market, primera, tp1) || !llegaAlMinimo(market, segunda, tp2)) {
    return todo(tp1);
  }
  return [
    { precio: tp1.toFixed(), cantidad: primera.toFixed() },
    { precio: tp2.toFixed(), cantidad: segunda.toFixed() },
  ];
}

export type ResultadoOperacion =
  { plan: PlanOperacion; motivo: null } | { plan: null; motivo: string };

/**
 * De la elección a la operación: la ÚNICA vía de enumeraciones a números.
 *
 * Una elección que no está en la oferta, o no estaba disponible, no produce
 * nada (`OFERTA`). La configuración se vuelve a mirar aquí aunque la oferta ya
 * la respetara: puede haber cambiado entre la oferta y la decisión.
 */
export function construirOperacion(
  salida: SalidaHerramienta,
  eleccion: EleccionOperacion,
  cfg: ConfigCanal,
  market: MarketSpec,
  intentId: string,
  ahora: number,
): ResultadoOperacion {
  const no = (motivo: string): ResultadoOperacion => ({ plan: null, motivo });
  if (eleccion.veredicto !== Veredicto.OPERAR) return no('NO_OPERAR');
  const canal = salida.canal;
  if (!canal) return no('OFERTA');
  const cand = salida.candidatos.find((c) => c.id === eleccion.opcion);
  if (!cand || !esElegible(cand)) return no('OFERTA');
  if (cfg.direccion !== 'NEUTRAL' && cand.lado !== cfg.direccion) return no('OFERTA');
  if (!cfg.setups.includes(cand.setup) || !cfg.canales.includes(canal.tipo)) return no('OFERTA');
  const opcion = cand.stops.find((o) => o.tipo === eleccion.stop);
  if (!opcion?.viable || !opcion.cantidad || !opcion.perdidaPorUnidad) return no('OFERTA');
  if (!opcion.esquemasViables.includes(eleccion.objetivo)) return no('OFERTA');
  if (!cfg.esquemas.includes(eleccion.objetivo)) return no('OFERTA');
  const banda = opcion.bandas.find((b) => b.banda === eleccion.apalancamiento);
  if (!banda) return no('OFERTA');

  const tope = D(cand.entradaTope);
  let cantidad = D(opcion.cantidad);
  if (eleccion.tamano === TamanoOperacion.MEDIO) {
    if (!medioLlegaAlMinimo(market, cantidad, tope)) return no('MINIMO');
    cantidad = D(qy(market, cantidad.div(2)));
  }
  const tp1 = D(cand.tp1);
  const tp2 = D(cand.tp2);
  const objetivos = objetivosDeEsquema(
    market,
    eleccion.objetivo,
    cantidad,
    tp1,
    tp2,
    cfg.fraccionTp1,
  );
  const largo = cand.lado === 'LONG';
  const perdida = D(opcion.perdidaPorUnidad).mul(cantidad);
  const taker = D(cfg.costes.takerBps).div(10_000);
  const maker = D(cfg.costes.makerBps).div(10_000);
  let ganancia = D(0);
  for (const o of objetivos) {
    const precio = D(o.precio);
    const q = D(o.cantidad);
    ganancia = ganancia
      .plus((largo ? precio.minus(tope) : tope.minus(precio)).mul(q))
      .minus(tope.mul(taker).plus(precio.mul(maker)).mul(q));
  }
  return {
    motivo: null,
    plan: {
      intentId,
      candidatoId: cand.id,
      setup: cand.setup,
      lado: cand.lado,
      eleccion,
      entradaReferencia: cand.entradaReferencia,
      entradaTope: cand.entradaTope,
      stop: opcion.precio,
      objetivos,
      cantidad: cantidad.toFixed(),
      apalancamiento: banda.apalancamiento,
      nocional: cantidad.mul(tope).toFixed(),
      riesgo: perdida.toFixed(),
      rNeto: perdida.gt(0) ? ganancia.div(perdida).toNumber() : 0,
      liquidacionEstimada: banda.liquidacion,
      huella: salida.huella,
      barT: salida.barT,
      canal: {
        tipo: canal.tipo,
        soporte: canal.soporte,
        resistencia: canal.resistencia,
        media: canal.media,
        pendientePorVela: canal.pendientePorVela,
        refT: canal.refT,
        desde: inicioDelCanal(canal, cfg.intervaloEstructura),
      },
      venceEn: ahora + cfg.maxVelasOperacion * QUINCE_MIN,
      distanciaStop: opcion.distancia,
    },
  };
}
