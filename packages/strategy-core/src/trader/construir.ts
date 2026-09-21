/**
 * De la decisión a la operación: la ÚNICA vía de enumeraciones a números
 * (spec 068).
 *
 * Aquí pasan dos cosas, y conviene no confundirlas:
 *
 * 1. `cuantiza()` es la frontera entre los **números de opinión** de quien
 *    decide —probabilidades y confianzas— y el resto del sistema. Entran
 *    `number` de 0 a 1 y sale un `VeredictoTrader` que es **solo
 *    enumeraciones**. Los crudos se guardan como constancia y no los vuelve a
 *    mirar nadie. Es el agujero que el invariante 13 no cubría, porque hasta
 *    ahora ningún proveedor devolvía probabilidades.
 * 2. `construirOperacionTrader()` toma ese veredicto y la matriz, y devuelve un
 *    plan con precios y cantidades. Todo lo que sale de aquí ya pasó por
 *    `precision.ts` dentro de `esqueletos.ts`: este fichero **no calcula
 *    precios**, elige una celda que ya los trae.
 */
import {
  AccionTrader,
  BucketObjetivo,
  BucketStop,
  D,
  MotivoTrader,
  NivelConfianza,
  TamanoOperacion,
  type EspacioTrader,
  type EsqueletoTrader,
  type MarketSpec,
  type PlanTrader,
  type RespuestaTrader,
  type VeredictoTrader,
} from '@crypton/shared';
import { qy } from '../common';
import { celdaDe } from './esqueletos';
import { RespaldoMedio, type ConfigTrader } from './config';

const QUINCE_MIN = 900_000;

/**
 * Hacia dónde se camina cuando la celda elegida no es viable.
 *
 * **Siempre hacia lo prudente, nunca hacia el riesgo.** Un stop más ancho
 * arriesga lo mismo (el tamaño se ajusta) pero sobrevive a más ruido; un
 * objetivo más cerca se alcanza más veces. Si quien decide pidió algo que no
 * está, se le da lo más parecido que sea *menos* arriesgado, no más.
 */
const VECINO_STOP: Readonly<Record<BucketStop, readonly BucketStop[]>> = {
  [BucketStop.CENIDO]: [BucketStop.CENIDO, BucketStop.MEDIDO, BucketStop.HOLGADO],
  [BucketStop.MEDIDO]: [BucketStop.MEDIDO, BucketStop.HOLGADO, BucketStop.CENIDO],
  [BucketStop.HOLGADO]: [BucketStop.HOLGADO, BucketStop.MEDIDO, BucketStop.CENIDO],
};

const VECINO_OBJETIVO: Readonly<Record<BucketObjetivo, readonly BucketObjetivo[]>> = {
  [BucketObjetivo.LARGO]: [BucketObjetivo.LARGO, BucketObjetivo.EN_LA_MEDIA, BucketObjetivo.CORTO],
  [BucketObjetivo.EN_LA_MEDIA]: [
    BucketObjetivo.EN_LA_MEDIA,
    BucketObjetivo.CORTO,
    BucketObjetivo.LARGO,
  ],
  [BucketObjetivo.CORTO]: [BucketObjetivo.CORTO, BucketObjetivo.EN_LA_MEDIA, BucketObjetivo.LARGO],
};

/**
 * De las probabilidades a las enumeraciones. La frontera del invariante 13.
 *
 * La confianza compuesta es el **mínimo** de las que de verdad se usan: si
 * quien decide se abstuvo de opinar sobre el stop, su confianza en el stop no
 * entra. Así una respuesta arbitraria a confianza 0,4 sobre un mando del que
 * nadie preguntaba no tira abajo una decisión de la que sí estaba seguro.
 */
export function cuantiza(r: RespuestaTrader, cfg: ConfigTrader): VeredictoTrader {
  const stopDeterminado = r.stopDeterminado >= cfg.umbralDeterminado;
  const objetivoDeterminado = r.objetivoDeterminado >= cfg.umbralDeterminado;

  const usadas = [r.accion.confianza];
  if (stopDeterminado) usadas.push(r.stop.confianza);
  if (objetivoDeterminado) usadas.push(r.objetivo.confianza);
  const compuesta = Math.min(...usadas);

  const confianza =
    compuesta >= cfg.confianzaTamanoCompleto
      ? NivelConfianza.ALTA
      : compuesta >= cfg.confianzaMinRuta
        ? NivelConfianza.MEDIA
        : NivelConfianza.BAJA;

  // Las tres puertas de contexto solo pueden RESTAR: vetan, nunca amplían.
  const acuerdo =
    !cfg.exigirAcuerdo ||
    (r.regimenRevierte >= cfg.minProbRegimen &&
      r.toqueAgotamiento >= cfg.minProbAgotamiento &&
      r.historialApoya >= cfg.minProbHistorial);

  return {
    accion: r.accion.clave,
    confianza,
    acuerdo,
    stop: stopDeterminado ? r.stop.clave : cfg.stopPorDefecto,
    objetivo: objetivoDeterminado ? r.objetivo.clave : cfg.objetivoPorDefecto,
    // La confianza solo puede reducir el tamaño: nunca hay una opción mayor.
    tamano: confianza === NivelConfianza.ALTA ? TamanoOperacion.COMPLETO : TamanoOperacion.MEDIO,
  };
}

export type ResultadoConstruir =
  { plan: PlanTrader; motivo: null } | { plan: null; motivo: MotivoTrader };

/** La celda que de verdad se va a usar, caminando hacia lo prudente si hace falta. */
function celdaElegida(espacio: EspacioTrader, v: VeredictoTrader): EsqueletoTrader | null {
  for (const s of VECINO_STOP[v.stop]) {
    for (const o of VECINO_OBJETIVO[v.objetivo]) {
      const c = celdaDe(espacio, s, o);
      if (c?.viable) return c;
    }
  }
  return null;
}

/**
 * El plan de una decisión, o el motivo por el que no lo hay.
 *
 * Es **total**: ninguna respuesta, ni siquiera una que pida una celda que no
 * existe, produce un plan fuera de las celdas viables ofrecidas. Hay un test
 * de propiedad que lo comprueba.
 */
export function construirOperacionTrader(
  espacio: EspacioTrader,
  v: VeredictoTrader,
  cfg: ConfigTrader,
  market: MarketSpec,
  intentId: string,
  ahora: number,
): ResultadoConstruir {
  if (v.accion === AccionTrader.ENTORNO_EQUIVOCADO) {
    return { plan: null, motivo: MotivoTrader.ENTORNO };
  }
  if (v.accion !== AccionTrader.TOMAR) return { plan: null, motivo: MotivoTrader.NO_OPERAR };
  if (v.confianza === NivelConfianza.BAJA) return { plan: null, motivo: MotivoTrader.CONFIANZA };
  if (!v.acuerdo) return { plan: null, motivo: MotivoTrader.DESACUERDO };
  if (!espacio.lado) return { plan: null, motivo: MotivoTrader.OFERTA };

  const celda = celdaElegida(espacio, v);
  if (!celda || !celda.cantidad || !celda.perdidaAlStop) {
    return { plan: null, motivo: MotivoTrader.OFERTA };
  }

  // La mitad del tamaño tiene que seguir siendo una operación para el venue.
  let cantidad = D(celda.cantidad);
  if (v.tamano === TamanoOperacion.MEDIO) {
    if (celda.medioViable) {
      cantidad = D(qy(market, cantidad.div(2)));
    } else if (cfg.respaldoMedio === RespaldoMedio.NO_OPERAR) {
      return { plan: null, motivo: MotivoTrader.MINIMO };
    }
  }
  if (!cantidad.gt(0)) return { plan: null, motivo: MotivoTrader.MINIMO };

  // La pérdida y el nocional se recalculan con la cantidad de verdad: la de la
  // celda es la del tamaño completo.
  const tope = D(celda.entradaTope);
  const porUnidad = D(celda.perdidaPorUnidad!);
  const riesgo = porUnidad.mul(cantidad);
  const nocional = cantidad.mul(tope);

  return {
    plan: {
      intentId,
      lado: espacio.lado,
      veredicto: v,
      entradaReferencia: celda.entradaReferencia,
      entradaTope: celda.entradaTope,
      stop: celda.precioStop,
      objetivos: [{ precio: celda.precioObjetivo, cantidad: cantidad.toFixed() }],
      cantidad: cantidad.toFixed(),
      apalancamiento: celda.apalancamiento!,
      nocional: nocional.toFixed(),
      riesgo: riesgo.toFixed(),
      rNeto: celda.rNeto,
      liquidacionEstimada: celda.liquidacion,
      huella: espacio.huella,
      barT: espacio.barT,
      banda: espacio.banda,
      venceEn: ahora + cfg.maxVelasOperacion * QUINCE_MIN,
      distanciaStop: celda.distanciaStop,
    },
    motivo: null,
  };
}
