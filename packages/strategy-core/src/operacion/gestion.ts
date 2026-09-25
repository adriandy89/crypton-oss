/**
 * La gestión de una operación con stop y objetivos (spec 074).
 *
 * La comparten las estrategias que abren una operación cada vez: el canal con
 * IA (`AI_CHANNEL`, spec 058) y la operación de un agente (`AGENT_TRADE`,
 * spec 074). Se movió aquí TAL CUAL desde `strategies/ai-channel.ts`, y no se
 * copió, por la razón de siempre en este repo: es la parte pagada con
 * incidentes (specs 060-062), y una copia en cada estrategia sería un sitio más
 * donde olvidarse del siguiente arreglo. Los tests del canal la cubren sin
 * haber cambiado una línea.
 *
 * Todo es puro: recibe el contexto del tick y devuelve órdenes o decisiones.
 */
import {
  D,
  Decimal,
  // La liquidación tiene que quedar al menos a medio stop detrás del stop.
  // Vive en `shared` desde el spec 080: la mide también el stop común.
  HOLGURA_LIQUIDACION,
  LevelKind,
  type BotContext,
  type DesiredOrder,
  type MarketSpec,
  type PlanOperacion,
} from '@crypton/shared';
import { llegaAlMinimo } from '../canal/herramienta';
import { makeCoid } from '../client-order-id';
import { px, qy } from '../common';

/** Lo que se espera a que una entrada IOC aparezca como posición. */
export const ESPERA_LLENADO_MS = 30_000;
/** Pasado esto sin posición ni ejecución, la entrada se da por perdida. */
export const ESPERA_MAXIMA_LLENADO_MS = 5 * 60_000;
/** Cierres a mercado: un intento cada 30 s, doce como mucho (`TAKE_PROFIT#500..511`). */
export const INDICE_CIERRE = 500;
export const MAX_INTENTOS_CIERRE = 12;
export const ESPERA_ENTRE_CIERRES_MS = 30_000;
/** El stop no saltó: el precio lo ha pasado en más de esta fracción del stop. */
export const STOP_NO_SALTO = 0.5;

export interface CierreEnCurso {
  motivo: string;
  intentos: number;
  ultimoEn: number;
}

/** Un motivo para cerrar ya, con el texto que lo explica. */
export interface MotivoDeCierre {
  motivo: string;
  mensaje: string;
}

/** Un objetivo de salida con la cantidad que le toca. */
export interface TramoDeSalida {
  precio: string;
  cantidad: Decimal;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function leerCierre(v: unknown): CierreEnCurso | null {
  if (!esObjeto(v) || typeof v['motivo'] !== 'string') return null;
  return {
    motivo: v['motivo'],
    intentos: Number(v['intentos'] ?? 0),
    ultimoEn: Number(v['ultimoEn'] ?? 0),
  };
}

/**
 * ¿Sigue en camino la entrada que se envió? La IOC puede estar aún en el libro,
 * no haber pasado su espera, o haberse llenado sin que la posición se vea
 * todavía.
 */
export function entradaEnCurso(
  ctx: BotContext,
  seq: number,
  op: { intento: number; enviadaEn: number },
): boolean {
  const coid = makeCoid(ctx.botId, seq, LevelKind.BASE, op.intento);
  const enLibro = ctx.openOrders.some((o) => o.clientOrderId === coid);
  const transcurrido = ctx.now - op.enviadaEn;
  const hayLlenado = ctx.cycle.entriesFilled > 0 || ctx.cycle.averageEntry !== null;
  return (
    enLibro ||
    transcurrido < ESPERA_LLENADO_MS ||
    (hayLlenado && transcurrido < ESPERA_MAXIMA_LLENADO_MS)
  );
}

/** Los tramos de salida de la operación para la posición que llegó a haber. */
export function tramosDeSalida(
  market: MarketSpec,
  op: { plan: Pick<PlanOperacion, 'objetivos' | 'cantidad'> },
  maximo: Decimal,
): TramoDeSalida[] {
  const [tp1, tp2] = op.plan.objetivos;
  const todo = [{ precio: tp1.precio, cantidad: maximo }];
  if (!tp2 || !D(op.plan.cantidad).gt(0)) return todo;
  // La misma proporción que el plan, sobre lo que de verdad se llenó.
  // Multiplicando antes de dividir: 31,257 × (18,754 / 31,257) no da 18,754
  // exacto, y el redondeo a la baja se comería un paso.
  const primera = D(qy(market, maximo.mul(tp1.cantidad).div(op.plan.cantidad)));
  const segunda = maximo.minus(primera);
  if (
    !llegaAlMinimo(market, primera, D(tp1.precio)) ||
    !llegaAlMinimo(market, segunda, D(tp2.precio))
  ) {
    return todo;
  }
  return [
    { precio: tp1.precio, cantidad: primera },
    { precio: tp2.precio, cantidad: segunda },
  ];
}

/**
 * Los objetivos que quedan, repartidos DE ABAJO ARRIBA: el último tramo se
 * queda con lo suyo y el primero con el resto.
 *
 * Al revés —que es como estaba— lo que faltaba se le quitaba siempre al
 * segundo objetivo: con el primero ejecutado a medias, el primero se quedaba
 * con TODA la posición que quedaba y el segundo se cancelaba, así que la
 * operación cobraba entera en el objetivo corto y el recorrido bueno se
 * regalaba. La ejecución parcial es del tramo que se estaba cobrando, no del
 * que no ha tocado nadie (spec 062, F-22).
 *
 * Un resto que no llega al mínimo del venue no se puede colocar solo: se suma
 * al tramo de al lado, o esa parte de la posición se quedaría sin objetivo.
 */
export function repartoDeObjetivos(
  market: MarketSpec,
  pendientes: readonly TramoDeSalida[],
  abs: Decimal,
): { t: TramoDeSalida; cantidad: Decimal }[] {
  const reparto = pendientes.map((t) => ({ t, cantidad: D(0) }));
  let restante = abs;
  for (let i = reparto.length - 1; i >= 0; i--) {
    const cantidad = i === 0 ? restante : Decimal.min(reparto[i].t.cantidad, restante);
    reparto[i].cantidad = cantidad;
    restante = restante.minus(cantidad);
  }
  if (
    reparto.length === 2 &&
    reparto[0].cantidad.gt(0) &&
    !llegaAlMinimo(market, reparto[0].cantidad, D(reparto[0].t.precio))
  ) {
    reparto[1].cantidad = reparto[1].cantidad.plus(reparto[0].cantidad);
    reparto[0].cantidad = D(0);
  }
  return reparto;
}

/**
 * El stop de breakeven: la entrada más lo que cuesta salir —comisión de entrada
 * y salida a mercado—, redondeado como la orden de salida.
 */
export function precioBreakeven(
  market: MarketSpec,
  entrada: Decimal,
  largo: boolean,
  costes: { takerBps: number; deslizamientoBps: number },
): Decimal {
  const c = D(costes.takerBps).mul(2).plus(costes.deslizamientoBps).div(10_000);
  const bruto = largo ? entrada.mul(D(1).plus(c)) : entrada.mul(D(1).minus(c));
  return D(px(market, bruto, largo ? 'SELL' : 'BUY'));
}

/**
 * Las salidas de seguridad, que no dependen del mercado sino del venue: el stop
 * que el precio pasó sin saltar, la liquidación demasiado cerca del stop y un
 * apalancamiento distinto del pedido. La primera que se cumple.
 */
export function salidaDeSeguridad(
  ctx: BotContext,
  op: { plan: Pick<PlanOperacion, 'distanciaStop' | 'apalancamiento'> },
  largo: boolean,
  stop: Decimal,
): MotivoDeCierre | null {
  const marca = D(ctx.ticker.mark);
  const s = D(op.plan.distanciaStop).mul(STOP_NO_SALTO);
  if (largo ? marca.lt(stop.mul(D(1).minus(s))) : marca.gt(stop.mul(D(1).plus(s)))) {
    return {
      motivo: 'STOP_NO_SALTO',
      mensaje: `el precio pasó el stop ${stop.toFixed()} y no saltó`,
    };
  }
  const pos = ctx.position;
  if (pos?.liquidationPrice && D(pos.liquidationPrice).gt(0)) {
    const liq = D(pos.liquidationPrice);
    const holgura = D(pos.entryPrice).mul(op.plan.distanciaStop).mul(HOLGURA_LIQUIDACION);
    const tope = largo ? stop.minus(holgura) : stop.plus(holgura);
    if (largo ? liq.gt(tope) : liq.lt(tope)) {
      return {
        motivo: 'LIQUIDACION',
        mensaje: `el venue pone la liquidación en ${liq.toFixed()}, demasiado cerca del stop`,
      };
    }
  }
  if (pos && Number.isFinite(pos.leverage) && pos.leverage > op.plan.apalancamiento + 0.5) {
    return {
      motivo: 'APALANCAMIENTO',
      mensaje: `el venue informa ${pos.leverage}x y la operación pidió ${op.plan.apalancamiento}x`,
    };
  }
  return null;
}

export const ordenStop = (
  ctx: BotContext,
  seq: number,
  lado: 'BUY' | 'SELL',
  precio: string,
  cantidad: Decimal,
): DesiredOrder => ({
  clientOrderId: makeCoid(ctx.botId, seq, LevelKind.STOP_LOSS, 0),
  levelKind: LevelKind.STOP_LOSS,
  levelIndex: 0,
  side: lado,
  type: 'MARKET',
  price: precio,
  triggerPrice: precio,
  qty: qy(ctx.market, cantidad),
  reduceOnly: true,
});

export function cierreAMercado(
  ctx: BotContext,
  seq: number,
  lado: 'BUY' | 'SELL',
  cantidad: Decimal,
  previo: CierreEnCurso | null,
  motivo: string,
): { immediate: DesiredOrder[]; cierre: CierreEnCurso; agotado: boolean } {
  const cierre = previo ?? { motivo, intentos: 0, ultimoEn: 0 };
  if (cierre.intentos >= MAX_INTENTOS_CIERRE) return { immediate: [], cierre, agotado: true };
  if (ctx.now - cierre.ultimoEn < ESPERA_ENTRE_CIERRES_MS) {
    return { immediate: [], cierre, agotado: false };
  }
  const indice = INDICE_CIERRE + cierre.intentos;
  return {
    immediate: [
      {
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, indice),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: indice,
        side: lado,
        type: 'MARKET',
        price: px(ctx.market, D(ctx.ticker.mark), lado),
        qty: qy(ctx.market, cantidad),
        reduceOnly: true,
      },
    ],
    cierre: { motivo: cierre.motivo, intentos: cierre.intentos + 1, ultimoEn: ctx.now },
    agotado: false,
  };
}
