/**
 * La medición de un agente (spec 074, R-25): el resultado hipotético de cada
 * candidato y de cada propuesta, y la tarjeta de resultados.
 *
 * El spec 070 midió, con 996 llamadas reales, que el modelo no distinguía lo
 * bueno de lo malo. Aquí eso no se supone: se mide, también sobre lo que no se
 * toma, y se enseña. NADA de lo que sale de este fichero decide nada: ninguna
 * ronda, aprobación ni seguimiento lo lee. Un test lo afirma.
 *
 * Lo hipotético se etiqueta con la triple barrera pesimista del canal
 * (`etiquetarTripleBarrera`): entrada al cierre de la vela de la decisión,
 * stop, primer objetivo y barrera de tiempo, con costes; y una vela que toca
 * el stop y el objetivo cuenta como stop.
 */
import {
  D,
  EstadoPropuestaAgente,
  FAMILIAS_AGENTE,
  MotivoPropuestaAgente,
  SalidaOperacionAgente,
  TipoStop,
  type Candle,
  type CandidatoAgente,
  type EstadisticaR,
  type FamiliaAgente,
  type PlanAgente,
  type PositionSide,
  type ResultadoHipotetico,
  type TarjetaAgente,
} from '@crypton/shared';
import type { Costes } from '../canal/costes';
import { wilsonInferior } from '../canal/estadistica';
import { aNumero, serieNumerica } from '../canal/numeros';
import { etiquetarTripleBarrera } from '../canal/tasas-base';

/** Por debajo de esta muestra, cualquier conclusión es prematura. */
export const MUESTRA_MINIMA = 30;

/** Lo que hace falta para etiquetar una operación, la tomara alguien o no. */
export interface PlanMedible {
  lado: PositionSide;
  /** La vela de la decisión: se entra a su cierre. */
  barT: number;
  entrada: string;
  stop: string;
  objetivo: string;
}

/**
 * Un candidato se mide con el stop NORMAL —o el primero viable— y el primer
 * objetivo: la opción de referencia, la misma para todos. null si ninguna
 * opción es viable.
 */
export function planMedibleDe(c: CandidatoAgente, barT: number): PlanMedible | null {
  const opcion =
    c.stops.find((o) => o.tipo === TipoStop.NORMAL && o.viable) ?? c.stops.find((o) => o.viable);
  if (!opcion) return null;
  return { lado: c.lado, barT, entrada: c.entradaTope, stop: opcion.precio, objetivo: c.tp1 };
}

/** Una propuesta se mide con su propio plan: su stop y su primer objetivo. */
export const planMedibleDePlan = (p: PlanAgente): PlanMedible => ({
  lado: p.lado,
  barT: p.barT,
  entrada: p.entradaTope,
  stop: p.stop,
  objetivo: p.objetivos[0].precio,
});

/**
 * El resultado hipotético, o null si las velas aún no lo resuelven o no traen
 * la vela de la decisión. Los precios cruzan a `number` porque esto es
 * estadística: ninguno vuelve a una orden.
 */
export function resultadoHipotetico(
  velas: readonly Candle[],
  p: PlanMedible,
  maxVelas: number,
  costes: Costes,
): ResultadoHipotetico | null {
  const s = serieNumerica(velas);
  const i = s.t.indexOf(p.barT);
  if (i < 0) return null;
  const e = etiquetarTripleBarrera(
    s,
    i,
    p.lado,
    aNumero(p.entrada),
    aNumero(p.stop),
    aNumero(p.objetivo),
    maxVelas,
    costes,
  );
  return e ? { resultado: e.resultado, r: e.r, en: s.t[e.salida] } : null;
}

/** Lo que dice una muestra de resultados en R. */
export function estadisticaR(rs: readonly number[]): EstadisticaR {
  const xs = rs.filter((r) => Number.isFinite(r));
  const n = xs.length;
  const aciertos = xs.filter((r) => r > 0).length;
  if (n === 0) {
    return { n, aciertos, wilsonInferior: 0, rMedio: null, t: null, muestraPequena: true };
  }
  const media = xs.reduce((a, r) => a + r, 0) / n;
  let t: number | null = null;
  if (n >= 2) {
    const varianza = xs.reduce((a, r) => a + (r - media) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(varianza);
    if (sd > 0) t = media / (sd / Math.sqrt(n));
  }
  return {
    n,
    aciertos,
    wilsonInferior: wilsonInferior(aciertos, n),
    rMedio: media,
    t,
    muestraPequena: n < MUESTRA_MINIMA,
  };
}

/** Un candidato de una ronda, con su medida. */
export interface FilaCandidato {
  elegible: boolean;
  /** Lo eligió el modelo, o el juez en modo reglas. */
  elegido: boolean;
  rHipotetico: number | null;
}

/** Una propuesta, con su medida y, si llegó a operar, su resultado real. */
export interface FilaPropuesta {
  familia: FamiliaAgente;
  lado: PositionSide;
  estado: EstadoPropuestaAgente;
  motivo: string | null;
  rHipotetico: number | null;
  rReal: number | null;
  /** Lo realizado con comisiones, en la quote. */
  resultado: string | null;
  salida: SalidaOperacionAgente | null;
}

/** Las que llegaron a tener bot. */
const TOMADAS: ReadonlySet<EstadoPropuestaAgente> = new Set<EstadoPropuestaAgente>([
  EstadoPropuestaAgente.EJECUTANDO,
  EstadoPropuestaAgente.ABIERTA,
  EstadoPropuestaAgente.CERRADA,
  EstadoPropuestaAgente.SIN_ENTRADA,
]);

const numeros = (xs: readonly (number | null)[]): number[] =>
  xs.filter((x): x is number => x !== null && Number.isFinite(x));

/**
 * La tarjeta de un agente. Un agente es de una sola cuenta, así que aquí lo
 * real y lo simulado nunca se mezclan; para varios agentes a la vez, la API
 * junta filas de cuentas del mismo tipo, nunca de los dos.
 */
export function tarjetaAgente(
  candidatos: readonly FilaCandidato[],
  propuestas: readonly FilaPropuesta[],
): TarjetaAgente {
  const ofrecidas = propuestas.filter((p) => p.estado !== EstadoPropuestaAgente.SOMBRA);
  const cerradas = propuestas.filter((p) => p.estado === EstadoPropuestaAgente.CERRADA);
  const conR = cerradas.filter((p) => p.rReal !== null);

  let resultado = D(0);
  for (const p of cerradas) if (p.resultado !== null) resultado = resultado.plus(p.resultado);

  const brechas = numeros(
    conR.map((p) => (p.rReal !== null && p.rHipotetico !== null ? p.rReal - p.rHipotetico : null)),
  );

  const porFamilia: TarjetaAgente['porFamilia'] = [];
  for (const familia of FAMILIAS_AGENTE) {
    for (const lado of ['LONG', 'SHORT'] as const) {
      const rs = numeros(
        conR.filter((p) => p.familia === familia && p.lado === lado).map((p) => p.rReal),
      );
      if (rs.length > 0) porFamilia.push({ familia, lado, operaciones: estadisticaR(rs) });
    }
  }

  const porSalida: TarjetaAgente['porSalida'] = [];
  for (const salida of Object.values(SalidaOperacionAgente)) {
    const n = cerradas.filter((p) => p.salida === salida).length;
    if (n > 0) porSalida.push({ salida, n });
  }

  const hipoteticos = (fs: readonly FilaCandidato[]): number[] =>
    numeros(fs.map((c) => c.rHipotetico));
  return {
    propuestas: ofrecidas.length,
    tomadas: ofrecidas.filter((p) => TOMADAS.has(p.estado)).length,
    rechazadas: ofrecidas.filter((p) => p.estado === EstadoPropuestaAgente.RECHAZADA).length,
    caducadas: ofrecidas.filter((p) => p.estado === EstadoPropuestaAgente.CADUCADA).length,
    operaciones: estadisticaR(numeros(conR.map((p) => p.rReal))),
    resultado: resultado.toFixed(),
    elegidas: estadisticaR(hipoteticos(candidatos.filter((c) => c.elegible && c.elegido))),
    noElegidas: estadisticaR(hipoteticos(candidatos.filter((c) => c.elegible && !c.elegido))),
    descartes: estadisticaR(
      numeros(
        propuestas
          .filter(
            (p) =>
              p.estado === EstadoPropuestaAgente.RECHAZADA &&
              p.motivo === MotivoPropuestaAgente.PERSONA,
          )
          .map((p) => p.rHipotetico),
      ),
    ),
    brechaEjecucion:
      brechas.length > 0 ? brechas.reduce((a, b) => a + b, 0) / brechas.length : null,
    porFamilia,
    porSalida,
  };
}
