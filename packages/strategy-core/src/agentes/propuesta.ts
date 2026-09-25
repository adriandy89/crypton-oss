/**
 * De la elección al plan: la ÚNICA vía de enumeraciones a números de un
 * agente (spec 074, invariante 13).
 *
 * `construirPropuesta` parte de la oferta de la ronda; `recalcularPropuesta`,
 * del plan guardado y del precio de AHORA, al aprobar. Las dos acaban en
 * `planDesdeOpcion`, así que un plan aprobado se calcula exactamente igual que
 * uno propuesto: solo cambian los datos.
 *
 * Una elección que no está en la oferta, o no estaba disponible, no produce
 * nada. Nada de aquí inventa un número: todos salen de la opción de stop que
 * ya calculó la herramienta, con sus garantías.
 */
import {
  D,
  ESQUEMA_DE_OBJETIVO,
  MotivoPropuestaAgente,
  TamanoOperacion,
  candleSpanMs,
  type CandidatoAgente,
  type EleccionAgente,
  type IntervaloAgente,
  type LimitesAgente,
  type MarketSpec,
  type NivelApalancamiento,
  type OpcionStop,
  type PlanAgente,
  type SalidaAgente,
  type Ticker,
  type Venue,
} from '@crypton/shared';
import { costesDe } from '../canal/costes';
import {
  TIPOS_STOP,
  medioLlegaAlMinimo,
  objetivosDeEsquema,
  preciosDeEntrada,
} from '../canal/herramienta';
import { qy } from '../common';
import {
  entradaDimensionado,
  esElegibleAgente,
  opcionesDeStop,
  type HistorialAgente,
} from './herramienta';
import { MAX_DESLIZAMIENTO_R_AGENTE, dimensionadoDeAgente } from './limites';

export type ResultadoPropuesta =
  { plan: PlanAgente; motivo: null } | { plan: null; motivo: string };

export interface ContextoPropuesta {
  limites: LimitesAgente;
  venue: Venue;
  /** El mercado del par de la operación. */
  market: MarketSpec;
  intervalo: IntervaloAgente;
  ahora: number;
  /** Lo que tiene la operación para entrar desde ahora: pasado, ya no entra. */
  vidaMs: number;
}

/** Lo que el plan hereda del candidato, venga de la oferta o del plan guardado. */
type BasePlan = Pick<
  CandidatoAgente,
  | 'simbolo'
  | 'familia'
  | 'lado'
  | 'entradaReferencia'
  | 'entradaTope'
  | 'extremo'
  | 'nivel'
  | 'tp1'
  | 'tp2'
> & { barT: number; huella: string };

function planDesdeOpcion(
  base: BasePlan,
  opcion: OpcionStop,
  eleccion: EleccionAgente,
  ctx: ContextoPropuesta,
): ResultadoPropuesta {
  const no = (motivo: string): ResultadoPropuesta => ({ plan: null, motivo });
  const banda = opcion.bandas.find((b) => b.banda === eleccion.apalancamiento);
  if (!opcion.viable || !opcion.cantidad || !opcion.perdidaPorUnidad || !banda) return no('OFERTA');
  const esquema = ESQUEMA_DE_OBJETIVO[eleccion.objetivo];
  if (!opcion.esquemasViables.includes(esquema)) return no('OFERTA');

  const { market, limites } = ctx;
  const tope = D(base.entradaTope);
  let cantidad = D(opcion.cantidad);
  if (eleccion.tamano === TamanoOperacion.MEDIO) {
    // La mitad tiene que seguir siendo una operación: la misma cuenta que la oferta.
    if (!medioLlegaAlMinimo(market, cantidad, tope)) return no('MINIMO');
    cantidad = D(qy(market, cantidad.div(2)));
  }
  const objetivos = objetivosDeEsquema(
    market,
    esquema,
    cantidad,
    D(base.tp1),
    D(base.tp2),
    D(limites.fraccionTp1Pct).div(100),
  );
  const largo = base.lado === 'LONG';
  const costes = costesDe(ctx.venue);
  const taker = D(costes.takerBps).div(10_000);
  const maker = D(costes.makerBps).div(10_000);
  const perdida = D(opcion.perdidaPorUnidad).mul(cantidad);
  let ganancia = D(0);
  for (const o of objetivos) {
    const precio = D(o.precio);
    const q = D(o.cantidad);
    ganancia = ganancia
      .plus((largo ? precio.minus(tope) : tope.minus(precio)).mul(q))
      .minus(tope.mul(taker).plus(precio.mul(maker)).mul(q));
  }
  const nocional = cantidad.mul(tope);
  const capital = D(limites.capital);
  return {
    motivo: null,
    plan: {
      version: 1,
      simbolo: base.simbolo,
      familia: base.familia,
      lado: base.lado,
      intervalo: ctx.intervalo,
      eleccion,
      entradaReferencia: base.entradaReferencia,
      entradaTope: base.entradaTope,
      extremo: base.extremo,
      nivelIdea: base.nivel,
      stop: opcion.precio,
      tp1: base.tp1,
      tp2: base.tp2,
      objetivos,
      cantidad: cantidad.toFixed(),
      apalancamiento: banda.apalancamiento,
      nocional: nocional.toFixed(),
      // El aislado de la banda, con la cantidad que de verdad se usa: la mitad
      // del tamaño inmoviliza la mitad y la liquidación no se mueve.
      margen: nocional.div(banda.apalancamiento).toFixed(2),
      riesgo: perdida.toFixed(),
      riesgoPctCapital: capital.gt(0) ? perdida.div(capital).mul(100).toNumber() : 0,
      rNeto: perdida.gt(0) ? ganancia.div(perdida).toNumber() : 0,
      liquidacionEstimada: banda.liquidacion,
      distanciaStop: opcion.distancia,
      barT: base.barT,
      huella: base.huella,
      entradaHasta: ctx.ahora + ctx.vidaMs,
      maxMinutos: (limites.maxVelasOperacion * candleSpanMs(ctx.intervalo)) / 60_000,
      breakevenTrasTp1: limites.breakevenTrasTp1,
      costes,
    },
  };
}

/** La propuesta de una ronda: el candidato elegido con sus números. */
export function construirPropuesta(
  salida: SalidaAgente,
  eleccion: EleccionAgente,
  ctx: ContextoPropuesta,
): ResultadoPropuesta {
  const no = (motivo: string): ResultadoPropuesta => ({ plan: null, motivo });
  if (salida.intervalo !== ctx.intervalo) return no('OFERTA');
  const cand = salida.pares.flatMap((p) => p.candidatos).find((c) => c.id === eleccion.candidatoId);
  if (!cand || !esElegibleAgente(cand) || cand.simbolo !== ctx.market.symbol) return no('OFERTA');
  const opcion = cand.stops.find((o) => o.tipo === eleccion.stop);
  if (!opcion) return no('OFERTA');
  return planDesdeOpcion(
    { ...cand, barT: salida.barT, huella: salida.huella },
    opcion,
    eleccion,
    ctx,
  );
}

/** Lo que se lee de nuevo al aprobar. */
export interface DatosFrescos {
  ticker: Ticker;
  saldoLibre: string;
  historial: HistorialAgente;
  niveles: readonly NivelApalancamiento[];
  maxApalancamientoUsuario: number | null;
  /** El ATR de la distancia a la liquidación, como en la ronda (`atrLiquidacion`). */
  atrLiquidacion: string;
}

export type ResultadoRecalculo =
  { plan: PlanAgente; motivo: null } | { plan: null; motivo: MotivoPropuestaAgente };

/**
 * Lo más que puede haberse movido el precio desde la propuesta, en distancias
 * de stop. Media distancia de stop es media operación: con más, lo que se
 * aprobó ya no es lo que se propuso.
 */
export const MOVIMIENTO_MAXIMO_STOPS = 0.5;

/**
 * La propuesta con el precio de AHORA, al aprobar (R-19).
 *
 * El stop, los objetivos y la elección son los de la propuesta; se vuelven a
 * calcular la entrada, la cantidad y el apalancamiento con el ticker, el saldo
 * y lo operado de este momento, por la misma `opcionDeStop`. Caduca, con su
 * motivo, si el precio ya pasó el stop, si se ha movido más de media
 * distancia de stop o si ya no cabe en los límites.
 */
export function recalcularPropuesta(
  plan: PlanAgente,
  f: DatosFrescos,
  ctx: ContextoPropuesta,
): ResultadoRecalculo {
  const no = (motivo: MotivoPropuestaAgente): ResultadoRecalculo => ({ plan: null, motivo });
  const { market } = ctx;
  if (plan.simbolo !== market.symbol || plan.intervalo !== ctx.intervalo) {
    return no(MotivoPropuestaAgente.LIMITES);
  }
  const largo = plan.lado === 'LONG';
  const stop = D(plan.stop);
  const marca = D(f.ticker.mark);
  const referencia = D(largo ? f.ticker.ask : f.ticker.bid);
  if (largo ? marca.lte(stop) || referencia.lte(stop) : marca.gte(stop) || referencia.gte(stop)) {
    return no(MotivoPropuestaAgente.PRECIO_PASO_STOP);
  }
  const distancia = D(plan.entradaReferencia).minus(stop).abs();
  if (referencia.minus(plan.entradaReferencia).abs().gt(distancia.mul(MOVIMIENTO_MAXIMO_STOPS))) {
    return no(MotivoPropuestaAgente.PRECIO_MOVIDO);
  }
  // Al aprobar solo queda el stop elegido, y la holgura de la IOC se mide con
  // él: el tope de entrada es el suyo, y la pérdida al stop se cuenta con ese
  // tope, así que la garantía de riesgo sigue en pie.
  const { tope } = preciosDeEntrada(market, f.ticker, largo, [stop], D(MAX_DESLIZAMIENTO_R_AGENTE));
  const dim = entradaDimensionado(
    dimensionadoDeAgente(ctx.limites, ctx.venue),
    market,
    f.saldoLibre,
    f.historial,
    f.niveles,
    f.maxApalancamientoUsuario,
    f.atrLiquidacion,
  );
  const stops = TIPOS_STOP.map((t) => (t === plan.eleccion.stop ? stop : null));
  const opcion = opcionesDeStop(
    dim,
    plan.lado,
    stops,
    tope,
    D(plan.tp1),
    D(plan.tp2),
    ctx.limites.minObjetivoPct,
  ).find((o) => o.tipo === plan.eleccion.stop);
  if (!opcion?.viable) return no(MotivoPropuestaAgente.LIMITES);
  const r = planDesdeOpcion(
    {
      simbolo: plan.simbolo,
      familia: plan.familia,
      lado: plan.lado,
      entradaReferencia: referencia.toFixed(),
      entradaTope: tope.toFixed(),
      extremo: plan.extremo,
      nivel: plan.nivelIdea,
      tp1: plan.tp1,
      tp2: plan.tp2,
      barT: plan.barT,
      huella: plan.huella,
    },
    opcion,
    plan.eleccion,
    ctx,
  );
  return r.plan ? { plan: r.plan, motivo: null } : no(MotivoPropuestaAgente.LIMITES);
}
