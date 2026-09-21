/**
 * La matriz de operaciones del «Bot de IA»: 3 stops × 3 objetivos (spec 068).
 *
 * La garantía de este fichero es una sola, y es la que hace que el resto del
 * sistema pueda confiar en lo que elija quien decida: **una celda marcada
 * viable es una operación ejecutable**. Ya pasó la aritmética de coste, los
 * mínimos del venue, el margen, el apalancamiento y la distancia a la
 * liquidación. Quien elige no puede elegir mal porque lo que no se puede hacer
 * no está en la lista.
 *
 * Nueve celdas y no un catálogo: la dirección la fija el borde tocado y el
 * apalancamiento lo fija la regla del stop. Lo único que queda por decidir es
 * hasta dónde va el stop y hasta dónde va el objetivo.
 */
import {
  BucketObjetivo,
  BucketStop,
  D,
  Decimal,
  MotivoTrader,
  maintenanceMarginRateOf,
  precioLiquidacionAislada,
  type EsqueletoTrader,
  type EspacioTrader,
  type HistorialOperaciones,
  type MarketSpec,
  type NivelApalancamiento,
  type SenalTrader,
  type Ticker,
} from '@crypton/shared';
import { px, qy } from '../common';
import { costeIdaVuelta } from '../canal/costes';
import { preciosDeEntrada } from '../canal/herramienta';
import { dimensionar, llegaAlMinimo } from '../dimension';
import type { Banda } from './senal';
import type { ConfigTrader } from './config';

/**
 * A cuántos ATR(15m) del extremo del toque va cada stop.
 *
 * El del medio, 2 ATR, es lo que el spec 067 midió. Y la escalera entera está
 * lejos de la del canal (0,25 / 0,5 / 1) por la misma razón que allí se separó
 * para las bandas: un borde de Bollinger no es un precio que nadie haya
 * defendido, es la desviación típica de los últimos veinte cierres, y un stop
 * pegado a él salta por ruido.
 */
export const ATR_POR_BUCKET: Readonly<Record<BucketStop, number>> = {
  [BucketStop.CENIDO]: 1.25,
  [BucketStop.MEDIDO]: 2,
  [BucketStop.HOLGADO]: 3,
};

/** Qué fracción del camino de la entrada a la media recorre cada objetivo. */
export const FRACCION_POR_BUCKET: Readonly<Record<BucketObjetivo, number>> = {
  [BucketObjetivo.CORTO]: 0.7,
  [BucketObjetivo.EN_LA_MEDIA]: 1,
  [BucketObjetivo.LARGO]: 1.5,
};

export const BUCKETS_STOP: readonly BucketStop[] = [
  BucketStop.CENIDO,
  BucketStop.MEDIDO,
  BucketStop.HOLGADO,
];

export const BUCKETS_OBJETIVO: readonly BucketObjetivo[] = [
  BucketObjetivo.CORTO,
  BucketObjetivo.EN_LA_MEDIA,
  BucketObjetivo.LARGO,
];

/** Del saldo libre, lo que puede inmovilizar la operación. */
const PARTE_DEL_SALDO = D('0.9');
/** Del tope diario que queda, lo que puede arriesgar una operación. */
const PARTE_DEL_TOPE_DIARIO = D('0.9');

export interface EntradaEspacio {
  cfg: ConfigTrader;
  market: MarketSpec;
  ticker: Ticker;
  senal: SenalTrader;
  banda: Banda;
  /** El extremo de la vela del toque: de ahí cuelga el stop. */
  extremo: number;
  niveles: readonly NivelApalancamiento[];
  historial: HistorialOperaciones;
  saldoLibre: string;
  /** ATR de 1 h, para la regla de liquidación. */
  atr1h: string;
  maxApalancamientoUsuario: number | null;
  barT: number;
  ahora: number;
}

/** Los niveles de la banda como texto, para que viajen con la oferta. */
const nivelesDe = (banda: Banda): EspacioTrader['banda'] => ({
  superior: String(banda.superior),
  media: String(banda.media),
  inferior: String(banda.inferior),
  refT: banda.refT,
});

const vacia = (
  stop: BucketStop,
  objetivo: BucketObjetivo,
  precioStop: string,
  precioObjetivo: string,
  motivo: MotivoTrader,
): EsqueletoTrader => ({
  stop,
  objetivo,
  viable: false,
  motivo,
  entradaReferencia: '0',
  entradaTope: '0',
  precioStop,
  precioObjetivo,
  cantidad: null,
  nocional: null,
  apalancamiento: null,
  perdidaAlStop: null,
  perdidaPorUnidad: null,
  liquidacion: null,
  distanciaStop: 0,
  costeR: 0,
  multiploCoste: 0,
  rNeto: 0,
  aciertoEquilibrio: null,
  riesgoPctCapital: null,
  medioViable: false,
});

/** Lo que se puede perder hoy, descontando lo ya perdido. */
function riesgoDisponible(cfg: ConfigTrader, h: HistorialOperaciones): Decimal {
  const porOperacion = cfg.capital.mul(cfg.riesgoPctOperacion).div(100);
  const topeDia = cfg.capital.mul(cfg.maxPerdidaDiaPct).div(100);
  const perdidoHoy = D(h.realizadoHoy).lt(0) ? D(h.realizadoHoy).abs() : D('0');
  const queda = topeDia.minus(perdidoHoy).mul(PARTE_DEL_TOPE_DIARIO);
  return Decimal.min(porOperacion, queda.gt(0) ? queda : D('0'));
}

/**
 * La media donde VA a estar, no donde está.
 *
 * Una media que huye del precio convierte un objetivo alcanzable en uno que no
 * lo es. Se proyecta con la deriva medida y la media vida: si el precio tarda
 * `h` velas en volver, la media se habrá movido `h · deriva` mientras tanto.
 */
function mediaProyectada(banda: Banda, senal: SenalTrader): number {
  const velas = senal.mediaVidaVelas ?? 0;
  if (!(velas > 0)) return banda.media;
  return banda.media + senal.derivaMediaAtr * banda.atr15 * velas;
}

/** La matriz entera de una vela, con cada celda valorada y validada. */
export function espacioTrader(e: EntradaEspacio): EspacioTrader {
  const { cfg, market, senal, banda } = e;
  const lado = senal.lado;
  const generadaEn = e.ahora;

  if (!lado) {
    return {
      version: 1,
      barT: e.barT,
      generadaEn,
      senal,
      lado: null,
      banda: nivelesDe(banda),
      esqueletos: [],
      huella: `${e.barT}|-|`,
    };
  }

  const largo = lado === 'LONG';
  const medioSpread = D(e.ticker.ask).minus(e.ticker.bid).abs().div(2);
  const extremo = D(String(e.extremo));

  // Los tres precios de stop primero: el tope de la entrada es UNO para las tres
  // celdas de esa fila, calculado con el stop más cercano. Si cada stop tuviera
  // su tope, el ceñido podría acabar ejecutándose con el tope del holgado y
  // perder más de lo calculado — es la misma razón que en el canal.
  const preciosStop = BUCKETS_STOP.map((b) => {
    const distancia = D(String(banda.atr15 * ATR_POR_BUCKET[b])).plus(medioSpread);
    const bruto = largo ? extremo.minus(distancia) : extremo.plus(distancia);
    if (!bruto.gt(0)) return null;
    // El stop del largo es una venta y redondea hacia arriba: un tick más cerca
    // de la entrada, nunca más lejos.
    const s = D(px(market, bruto, largo ? 'SELL' : 'BUY'));
    return s.gt(0) ? s : null;
  });

  const { referencia, tope } = preciosDeEntrada(
    market,
    e.ticker,
    largo,
    preciosStop,
    cfg.maxDeslizamientoR,
  );

  const objetivoMedia = mediaProyectada(banda, senal);
  const esqueletos: EsqueletoTrader[] = [];

  for (let i = 0; i < BUCKETS_STOP.length; i++) {
    const bStop = BUCKETS_STOP[i];
    const stop = preciosStop[i];

    for (const bObj of BUCKETS_OBJETIVO) {
      // El objetivo: una fracción del camino de la entrada a la media proyectada.
      const camino = D(String(objetivoMedia)).minus(tope);
      const objetivoBruto = tope.plus(camino.mul(D(String(FRACCION_POR_BUCKET[bObj]))));
      // Hacia la entrada: un objetivo del largo está por encima, así que redondea
      // hacia abajo, que es hacia la entrada. Nunca se promete de más.
      const precioObjetivo = D(px(market, objetivoBruto, largo ? 'SELL' : 'BUY'));
      const textoObjetivo = precioObjetivo.toFixed();

      if (!stop) {
        esqueletos.push(vacia(bStop, bObj, '0', textoObjetivo, MotivoTrader.STOP_INVALIDO));
        continue;
      }
      const precioStop = stop.toFixed();
      // El precio ya pasó el stop: la operación nacería saltada.
      if (largo ? stop.gte(tope) : stop.lte(tope)) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.STOP_INVALIDO));
        continue;
      }
      // Y un objetivo del lado equivocado no es un objetivo.
      if (largo ? precioObjetivo.lte(tope) : precioObjetivo.gte(tope)) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.OBJETIVO_CORTO));
        continue;
      }

      const distancia = tope.minus(stop).abs();
      const s = distancia.div(tope);
      if (s.gt(cfg.maxStopPct.div(100))) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.STOP_ANCHO));
        continue;
      }
      if (!cfg.capital.gt(0)) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.SIN_MARGEN));
        continue;
      }

      const riesgo = riesgoDisponible(cfg, e.historial);
      if (!riesgo.gt(0)) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.TOPE_DIARIO));
        continue;
      }

      const taker = D(cfg.costes.takerBps).div(10_000);
      const maker = D(cfg.costes.makerBps).div(10_000);
      const deslizamiento = D(cfg.costes.deslizamientoBps).div(10_000);
      // Pérdida por unidad al saltar el stop: el precio, la comisión de entrada
      // (la IOC es taker) y la salida a mercado con su deslizamiento.
      const porUnidad = distancia.plus(tope.mul(taker)).plus(stop.mul(taker.plus(deslizamiento)));

      // Las dos puertas del spec 066, que son las que quitan la imposibilidad
      // aritmética antes de mirar el mercado.
      const costeR = porUnidad.minus(distancia).div(distancia).toNumber();
      if (costeR > cfg.maxCosteR.toNumber()) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.COSTE));
        continue;
      }
      const idaYVuelta = D(costeIdaVuelta(tope.toNumber(), cfg.costes, 0));
      const recorrido = precioObjetivo.minus(tope).abs();
      const multiploCoste = idaYVuelta.gt(0) ? recorrido.div(idaYVuelta).toNumber() : 0;
      if (multiploCoste < cfg.minObjetivoCoste) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.OBJETIVO_CORTO));
        continue;
      }

      const maxMargen = Decimal.min(
        cfg.capital.mul(cfg.maxMargenPct).div(100),
        D(e.saldoLibre).mul(PARTE_DEL_SALDO),
      );
      if (!maxMargen.gt(0)) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.SIN_MARGEN));
        continue;
      }

      const { dim, motivo } = dimensionar({
        market,
        niveles: e.niveles,
        tope,
        distanciaStop: s,
        atr1hRelativo: D(e.atr1h).div(tope),
        riesgo,
        perdidaPorUnidad: porUnidad,
        capital: cfg.capital,
        multiploNocional: cfg.multiploNocional,
        topeNocional: cfg.topeNocional,
        maxMargen,
        colchonStops: cfg.colchonStops,
        topesApalancamiento: [
          cfg.apalancamientoTope,
          e.maxApalancamientoUsuario ?? cfg.apalancamientoTope,
        ],
        mantenimientoMercado: maintenanceMarginRateOf(market),
      });
      if (!dim) {
        esqueletos.push(
          vacia(
            bStop,
            bObj,
            precioStop,
            textoObjetivo,
            motivo === 'MINIMO' ? MotivoTrader.MINIMO : MotivoTrader.APALANCAMIENTO,
          ),
        );
        continue;
      }

      // El apalancamiento es SIEMPRE el menor que hace caber el margen: la
      // liquidación más lejana posible. No es una elección de nadie.
      const apalancamiento = dim.lMin;
      const liquidacion = precioLiquidacionAislada(tope, apalancamiento, dim.mantenimiento, lado);
      if (liquidacion && (largo ? liquidacion.gte(stop) : liquidacion.lte(stop))) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.LIQUIDACION));
        continue;
      }

      const perdidaAlStop = porUnidad.mul(dim.cantidad);
      const gananciaBruta = (largo ? precioObjetivo.minus(tope) : tope.minus(precioObjetivo)).mul(
        dim.cantidad,
      );
      const comisiones = tope.mul(taker).plus(precioObjetivo.mul(maker)).mul(dim.cantidad);
      const rNeto = gananciaBruta.minus(comisiones).div(perdidaAlStop).toNumber();
      if (rNeto < cfg.minRR) {
        esqueletos.push(vacia(bStop, bObj, precioStop, textoObjetivo, MotivoTrader.RR));
        continue;
      }

      esqueletos.push({
        stop: bStop,
        objetivo: bObj,
        viable: true,
        motivo: null,
        entradaReferencia: referencia.toFixed(),
        entradaTope: tope.toFixed(),
        precioStop,
        precioObjetivo: textoObjetivo,
        cantidad: dim.cantidad.toFixed(),
        nocional: dim.nocional.toFixed(),
        apalancamiento,
        perdidaAlStop: perdidaAlStop.toFixed(),
        perdidaPorUnidad: porUnidad.toFixed(),
        liquidacion: liquidacion ? px(market, liquidacion, largo ? 'SELL' : 'BUY') : null,
        distanciaStop: s.toNumber(),
        costeR,
        multiploCoste,
        rNeto,
        aciertoEquilibrio: rNeto > 0 ? 1 / (1 + rNeto) : null,
        riesgoPctCapital: perdidaAlStop.div(cfg.capital).mul(100).toNumber(),
        medioViable: llegaAlMinimo(market, D(qy(market, dim.cantidad.div(2))), tope),
      });
    }
  }

  const viables = esqueletos
    .filter((x) => x.viable)
    .map((x) => `${x.stop[0]}${x.objetivo[0]}`)
    .join(',');

  return {
    version: 1,
    barT: e.barT,
    generadaEn,
    senal,
    lado,
    banda: nivelesDe(banda),
    esqueletos,
    huella: `${e.barT}|${lado}|${viables}`,
  };
}

/** La celda de un par de enumeraciones, si está en la matriz. */
export const celdaDe = (
  espacio: EspacioTrader,
  stop: BucketStop,
  objetivo: BucketObjetivo,
): EsqueletoTrader | undefined =>
  espacio.esqueletos.find((x) => x.stop === stop && x.objetivo === objetivo);
