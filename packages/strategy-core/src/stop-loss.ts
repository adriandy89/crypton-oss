import {
  D,
  type DesiredState,
  type Direction,
  type MarketSpec,
  type Position,
} from '@crypton/shared';
import { makeCoid } from './client-order-id';
import { exitSide, px, qy } from './common';
import { stopLossPrice } from './ladder';

/**
 * Añade el nivel de STOP_LOSS al plan si la configuración lo pide.
 *
 * Vive aquí y no en cada estrategia porque `stopLossPct` lo inyecta
 * `COMMON_FIELDS` en las siete, pero solo dos lo leían: las otras cinco pintaban
 * el campo en el formulario y no colocaban nada. Eso es peor que no ofrecerlo
 * —el usuario cree que tiene red y no la tiene—. En un único sitio no puede
 * volver a desincronizarse al añadir una estrategia.
 *
 * La dirección sale del SIGNO de la posición real, no de `cfg.direction`: un
 * market maker o una retícula neutral cambian de lado solos, y un stop calculado
 * sobre la dirección nominal saldría del lado contrario.
 *
 * Era un método privado de `BotRunner` y ahora es una función pura porque hay un
 * segundo consumidor: el backtest. Un replay que no aplicara el stop enseñaría
 * bots sin red, y reimplementarlo allí lo dejaría a merced de la primera vez que
 * alguien tocara este cálculo en un solo lado.
 */
export function withStopLoss(
  desired: DesiredState,
  position: Position | null,
  ctx: {
    botId: string;
    cycleSeq: number;
    market: MarketSpec;
    stopLossPct?: string | number | null;
  },
): DesiredState {
  const pct = ctx.stopLossPct;
  if (!pct || !position) return desired;

  const qty = D(position.qty);
  if (qty.isZero()) return desired;

  // Si la estrategia ya emitió el suyo, manda el suyo: sabe cosas del ciclo que
  // desde aquí no se ven. Se mira también `immediate`: un stop emitido por esa
  // vía es un stop igualmente, y añadir otro con el mismo id era lo que dejaba
  // la inmediata vetada por la fila viva del nuestro (001/F-02).
  const propio = [...desired.orders, ...desired.immediate];
  if (propio.some((o) => o.levelKind === 'STOP_LOSS')) return desired;

  const direction: Direction = qty.gt(0) ? 'LONG' : 'SHORT';
  const side = exitSide(direction);
  const price = px(ctx.market, stopLossPrice(position.entryPrice, pct, direction), side);

  return {
    ...desired,
    orders: [
      ...desired.orders,
      {
        clientOrderId: makeCoid(ctx.botId, ctx.cycleSeq, 'STOP_LOSS', 0),
        levelKind: 'STOP_LOSS',
        levelIndex: 0,
        side,
        type: 'MARKET',
        price,
        // Con `triggerPrice` el adaptador lo traduce a la orden condicional
        // nativa del venue, así que se dispara aunque el motor esté caído.
        triggerPrice: price,
        qty: qy(ctx.market, qty.abs()),
        reduceOnly: true,
      },
    ],
  };
}
