import {
  D,
  type AvisoEstrategia,
  type DesiredState,
  type Direction,
  type MarketSpec,
  type Numeric,
  type Position,
} from '@crypton/shared';
import { makeCoid } from './client-order-id';
import { exitSide, px, qy } from './common';
import { stopLossPrice } from './ladder';

/**
 * Diferencia de apalancamiento que se da por ruido. Los venues lo informan
 * entero, pero Lighter lo deduce de su fracción de margen inicial y el
 * simulador lo calcula; una centésima no es un cambio de apalancamiento.
 */
const TOLERANCIA_APALANCAMIENTO = D('0.01');

/**
 * Añade el nivel de STOP_LOSS al plan si la configuración lo pide.
 *
 * Vive aquí y no en cada estrategia porque `stopLossPct` lo inyecta
 * `COMMON_FIELDS` en TODAS, y cuando esto se escribió solo dos lo leían: las
 * otras cinco pintaban el campo en el formulario y no colocaban nada —eran
 * siete entonces—. Eso es peor que no ofrecerlo
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
    /** % del MARGEN que se está dispuesto a perder (spec 080). */
    stopLossPct?: string | number | null;
    /** El apalancamiento de la configuración, el que el motor fija en el venue. */
    leverage: Numeric;
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

  // El stop es un % del MARGEN, así que depende del apalancamiento (spec 080).
  // Manda el de la configuración, que es el que conocen la Revisión, el
  // backtest y la validación; salvo que el venue tenga la posición MÁS
  // apalancada —el cambio no se pudo aplicar con la posición abierta, o se tocó
  // a mano en el exchange—: entonces se usa el del venue, que da el stop más
  // estrecho, y se avisa. Al revés no: un apalancamiento efectivo menor (un
  // margen aportado a mano) movería el stop cada vez que alguien aporta
  // colateral.
  const configurado = D(ctx.leverage ?? 1);
  const delVenue =
    Number.isFinite(position.leverage) && position.leverage > 0 ? D(position.leverage) : null;
  const venueMayor = delVenue != null && delVenue.minus(configurado).gt(TOLERANCIA_APALANCAMIENTO);
  const apalancamiento = venueMayor && delVenue ? delVenue : configurado;

  const direction: Direction = qty.gt(0) ? 'LONG' : 'SHORT';
  const side = exitSide(direction);
  const price = px(
    ctx.market,
    stopLossPrice(position.entryPrice, pct, apalancamiento, direction),
    side,
  );

  const avisos: AvisoEstrategia[] =
    venueMayor && delVenue
      ? [
          ...(desired.avisos ?? []),
          {
            clave: `stop-apalancamiento-${delVenue.toFixed()}`,
            tipo: 'LEVERAGE_SKIPPED',
            severidad: 'WARN',
            mensaje:
              `El exchange tiene la posición a ${delVenue.toFixed()}× y la configuración dice ` +
              `${configurado.toFixed()}×: el stop del ${D(pct).toFixed()} % del margen se ` +
              `calcula con ${delVenue.toFixed()}×, el más estrecho, para que no quede detrás de ` +
              'la liquidación.',
          },
        ]
      : (desired.avisos ?? []);

  return {
    ...desired,
    ...(avisos.length > 0 ? { avisos } : {}),
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
