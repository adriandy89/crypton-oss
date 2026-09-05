import { type EntradaCronologia, type VentanaCiclo } from '@crypton/shared';
import type { BotCycle, BotEvent, BotFill, BotOrder } from '../../core/models';
import { eventLabel, money, orderStatusLabel, price, qty, shortDate } from '../../core/utils';
import { levelTitle } from '../../shared/chart/bot-overlay';

/**
 * Del dominio del bot a la cronología y al CSV (spec 006).
 *
 * El mismo papel que `bot-series.ts` para la curva: elegir columnas y poner
 * nombres. La agrupación por ciclo y la serialización CSV viven en
 * `@crypton/shared` y tienen tests; aquí no se decide nada que pueda mentir.
 */

const GRAVE = new Set(['WARN', 'ERROR', 'CRITICAL']);

/** Órdenes, ejecuciones y sucesos como entradas de una sola lista. */
export function entradasDe(
  orders: readonly BotOrder[],
  fills: readonly BotFill[],
  events: readonly BotEvent[],
): EntradaCronologia[] {
  const out: EntradaCronologia[] = [];
  for (const o of orders) {
    out.push({
      id: `o:${o.client_order_id}`,
      at: Date.parse(o.placed_at),
      tipo: 'orden',
      cycleSeq: o.cycle_seq,
      titulo: `${levelTitle(o)} · ${orderStatusLabel(o.status)}`,
      detalle: `${o.side === 'BUY' ? 'Compra' : 'Venta'} ${qty(o.qty)} @ ${price(o.price)}`,
      tono: o.side === 'BUY' ? 'up' : 'down',
    });
  }
  for (const f of fills) {
    out.push({
      id: `f:${f.id}`,
      at: Date.parse(f.executed_at),
      tipo: 'ejecucion',
      cycleSeq: f.order.cycle_seq,
      titulo: `Ejecución ${levelTitle(f.order)}`,
      detalle: `${f.side === 'BUY' ? 'Compra' : 'Venta'} ${qty(f.qty)} @ ${price(f.price)} · comisión ${money(f.fee)} ${f.fee_asset} · ${f.is_taker ? 'taker' : 'maker'}`,
      tono: f.side === 'BUY' ? 'up' : 'down',
    });
  }
  for (const e of events) {
    out.push({
      id: `e:${e.id}`,
      at: Date.parse(e.created_at),
      tipo: 'suceso',
      // Los sucesos no traen ciclo: se sitúan por la hora (ver `cronologiaPorCiclo`).
      cycleSeq: null,
      titulo: eventLabel(e.type),
      detalle: e.message,
      tono: GRAVE.has(e.severity) ? 'warn' : 'neutral',
    });
  }
  return out;
}

/**
 * Las ventanas de los ciclos: los cerrados y, si lo hay, el vivo —que no está en
 * la lista de cerrados y es donde caen las órdenes que se están mirando.
 */
export function ventanasDe(cycles: readonly BotCycle[], vivo: BotCycle | null): VentanaCiclo[] {
  const out = cycles.map((c): VentanaCiclo => ({
    seq: c.seq,
    desde: Date.parse(c.opened_at),
    hasta: c.closed_at ? Date.parse(c.closed_at) : null,
  }));
  if (vivo && !out.some((v) => v.seq === vivo.seq)) {
    out.push({ seq: vivo.seq, desde: Date.parse(vivo.opened_at), hasta: null });
  }
  return out;
}

/** Una fila por ciclo, con las columnas que se miran en una hoja. */
export function filasDeCiclos(cycles: readonly BotCycle[]) {
  return cycles.map((c) => ({
    ciclo: c.seq,
    abierto: c.opened_at,
    cerrado: c.closed_at ?? '',
    entradas: c.entries_filled,
    cantidad: c.qty,
    precio_medio_entrada: c.average_entry ?? '',
    precio_medio_salida: c.exit_avg ?? '',
    resultado: c.realized_pnl,
    comisiones: c.fees,
  }));
}

/** Una fila por orden. */
export function filasDeOrdenes(orders: readonly BotOrder[]) {
  return orders.map((o) => ({
    orden: o.client_order_id,
    ciclo: o.cycle_seq,
    nivel: levelTitle(o),
    lado: o.side,
    tipo: o.kind,
    precio: o.price,
    cantidad: o.qty,
    ejecutado: o.filled_qty,
    precio_medio: o.avg_price ?? '',
    estado: o.status,
    colocada: o.placed_at,
    cerrada: o.closed_at ?? '',
    error: o.raw_error ?? '',
  }));
}

/** Rótulo de la cabecera de un ciclo en la cronología. */
export function rotuloDeCiclo(
  seq: number | null,
  desde: number | null,
  hasta: number | null,
): string {
  if (seq === null) return 'Fuera de ciclo';
  const tramo =
    desde === null
      ? ''
      : ` · ${shortDate(new Date(desde))}${hasta === null ? ' → abierto' : ` → ${shortDate(new Date(hasta))}`}`;
  return `Ciclo #${seq}${tramo}`;
}
