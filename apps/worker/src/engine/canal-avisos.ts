import {
  D,
  EventoCanal,
  type Decimal,
  type OperacionCanalVista,
  type Position,
} from '@crypton/shared';
import { INDICE_CIERRE, parseCoid } from '@crypton/strategy-core';
import type { EventoCierre } from './bot-store';

/**
 * Los avisos de la operación del canal con IA (spec 059), como funciones puras.
 *
 * - `AI_ENTRY` sale cuando la entrada se llena: con los números de la
 *   operación y el vale del botón «⏸ Pausar».
 * - `AI_EXIT` sale al cerrarse el ciclo, EN LUGAR de `CYCLE_CLOSED`: lleva lo
 *   mismo —el resultado y el ciclo— y además el R y por qué terminó. Dos
 *   avisos por la misma salida serían ruido.
 */

/** Los cierres a mercado del propio runner (comandos, vigilante del stop) van del 999 hacia abajo. */
const INDICE_CIERRE_MOTOR = 900;

export interface AvisoEntrada {
  message: string;
  payload: Record<string, unknown>;
}

const signo = (x: Decimal): string => (x.gte(0) ? '+' : '');

/**
 * El aviso de la entrada. Con la posición real si se tiene —la IOC puede
 * llenarse a medias o a mejor precio que el tope— y con el plan si no.
 */
export function avisoDeEntrada(
  op: OperacionCanalVista,
  posicion: Position | null,
  quote: string,
  vale: string | null,
): AvisoEntrada {
  const p = op.plan;
  const conPosicion = posicion !== null && !D(posicion.qty).isZero();
  const cantidad = conPosicion ? D(posicion.qty).abs() : D(p.cantidad);
  const precio =
    conPosicion && D(posicion.entryPrice).gt(0) ? D(posicion.entryPrice) : D(p.entradaTope);
  const objetivos = p.objetivos.map((o) => o.precio);
  const liquidacion = p.liquidacionEstimada
    ? ` · liquidación estimada ${p.liquidacionEstimada}`
    : '';
  const message =
    `Entrada ${p.lado === 'LONG' ? 'larga' : 'corta'}: ${cantidad.toFixed()} a ${precio.toFixed()} ` +
    `con ${p.apalancamiento}x (nocional ${cantidad.mul(precio).toFixed(2)} ${quote}). ` +
    `Stop ${p.stop} · objetivo${objetivos.length > 1 ? 's' : ''} ${objetivos.join(' / ')} · ` +
    `riesgo ${D(p.riesgo).toFixed(2)} ${quote} · R ${D(p.rNeto).toFixed(2)}${liquidacion}.`;
  return {
    message,
    payload: {
      intentId: p.intentId,
      ...(vale ? { vale } : {}),
      lado: p.lado,
      cantidad: cantidad.toFixed(),
      precio: precio.toFixed(),
      apalancamiento: p.apalancamiento,
      stop: p.stop,
      objetivos,
      riesgo: p.riesgo,
      rPlaneado: p.rNeto,
    },
  };
}

/**
 * Por qué terminó la operación, a partir de la orden que la cerró.
 * - el stop, o el stop ya en breakeven;
 * - un objetivo;
 * - un cierre a mercado de la estrategia, con el motivo que dejó en el scratch;
 * - un cierre a mercado del runner: un comando o el vigilante del stop;
 * - una liquidación del venue.
 */
export function motivoDeSalida(
  clientOrderId: string | null,
  liquidacion: boolean,
  op: OperacionCanalVista | null,
  cierre: unknown,
): string {
  if (liquidacion) return 'LIQUIDADA';
  const c = clientOrderId ? parseCoid(clientOrderId) : null;
  if (!c) return 'CIERRE';
  if (c.kind === 'STOP_LOSS') return op?.stopBreakeven ? 'BREAKEVEN' : 'STOP';
  if (c.kind !== 'TAKE_PROFIT') return 'CIERRE';
  if (c.levelIndex >= INDICE_CIERRE_MOTOR) return 'CIERRE_MOTOR';
  if (c.levelIndex >= INDICE_CIERRE) {
    const motivo =
      typeof cierre === 'object' && cierre !== null
        ? (cierre as { motivo?: unknown }).motivo
        : undefined;
    return typeof motivo === 'string' && motivo !== '' ? motivo : 'CIERRE';
  }
  return 'OBJETIVO';
}

const TEXTO_SALIDA: Readonly<Record<string, string>> = {
  OBJETIVO: 'objetivo',
  STOP: 'stop',
  BREAKEVEN: 'stop en breakeven',
  TIEMPO: 'por tiempo',
  INVALIDACION: 'el canal se rompió',
  REGIMEN: 'el mercado giró a tendencia en contra',
  STOP_NO_SALTO: 'el stop no saltó',
  LIQUIDACION: 'la liquidación quedaba demasiado cerca del stop',
  APALANCAMIENTO: 'el apalancamiento no era el pedido',
  HUERFANA: 'posición sin operación registrada',
  CIERRE_MOTOR: 'cierre a mercado por un comando o por el vigilante del stop',
  LIQUIDADA: 'liquidación',
  CIERRE: 'cierre',
};

/**
 * El evento del cierre del ciclo. El R es el resultado sobre lo que la
 * operación declaró que arriesgaba al entrar; sin operación guardada, no hay R.
 */
export function eventoDeSalida(
  cierre: { seq: number; pnl: Decimal },
  op: OperacionCanalVista | null,
  motivo: string,
  quote: string,
): EventoCierre {
  const riesgo = op ? D(op.plan.riesgo) : null;
  const r = riesgo?.gt(0) ? cierre.pnl.div(riesgo) : null;
  const enR = r ? ` (${signo(r)}${r.toFixed(2)} R)` : '';
  return {
    type: EventoCanal.SALIDA,
    severity: motivo === 'LIQUIDADA' ? 'WARN' : 'INFO',
    message:
      `Operación cerrada (${TEXTO_SALIDA[motivo] ?? motivo.toLowerCase()}): ` +
      `${signo(cierre.pnl)}${cierre.pnl.toFixed(2)} ${quote}${enR}.`,
    payload: {
      realizedPnl: cierre.pnl.toFixed(),
      seq: cierre.seq,
      r: r ? r.toDecimalPlaces(4).toNumber() : null,
      motivo,
      intentId: op?.plan.intentId ?? null,
    },
  };
}
