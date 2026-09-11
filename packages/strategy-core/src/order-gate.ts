import { normalizeOrder, type DesiredOrder, type MarketSpec } from '@crypton/shared';

/**
 * La última puerta antes de que una orden salga hacia el venue.
 *
 * PURA a propósito: entra (mercado, orden, ¿la posición puede crecer?), sale un
 * veredicto. Vivía dentro del runner y no se podía probar sin levantar el motor
 * entero, que es justo por lo que el fallo de abajo llegó a producción.
 *
 * ── El fallo que la hizo existir ─────────────────────────────────────────────
 *
 * A un BASE de 0,00196 BTC le ejecutaron 0,00001 —una ejecución PARCIAL, lo más
 * normal del mundo en un libro de órdenes—. La martingala pidió entonces un take
 * profit sobre la posición: 0,79 $. El mínimo de Lighter son 0,0002 BTC / 10 $.
 *
 * Esa orden nunca se validó, porque las `reduceOnly` se mandaban a ciegas
 * razonando que varios venues las aceptan por debajo del mínimo para poder
 * cerrar restos. Lighter no. El rechazo tumbaba el tick, cinco veces seguidas, y
 * el cortacircuitos pausaba el bot con la posición abierta y sin stop loss.
 *
 * El razonamiento original no era malo, así que la salida no se veta sin más: lo
 * que faltaba era distinguir POR QUÉ no cumple.
 */

export type Veredicto =
  | { motivo: 'OK' }
  | {
      motivo: 'ENTRADA_INVALIDA' | 'IMPOSIBLE' | 'ESPERANDO_MINIMO' | 'RESTO_INCERRABLE';
      tipo: string;
      severidad: 'INFO' | 'WARN';
      mensaje: string;
    };

/** «0,0002 BTC / 10 USDC», o lo que haya declarado el venue. */
function minimoLegible(market: MarketSpec): string {
  return [
    market.minQty ? `${market.minQty} ${market.base}` : null,
    market.minNotional ? `${market.minNotional} ${market.quote}` : null,
  ]
    .filter(Boolean)
    .join(' / ');
}

export function revisarOrden(
  market: MarketSpec,
  order: DesiredOrder,
  entradasVivas: boolean,
  /**
   * Precio de marca, si se conoce. Lo usa toda CONDICIONAL A MERCADO: su
   * `price` es el precio de DISPARO, y medir ahí el mínimo del venue dejaba sin
   * red a una posición de 10,5 USDC con un stop al −10 % (9,45 al disparo, por
   * debajo de 10). Lo que el venue cierra es la posición que hay, al precio que
   * hay; el disparo solo dice cuándo (001/F-91). El tick y el paso los garantiza
   * ya el redondeo de quien la emite, así que redondear el mark aquí no quita
   * nada.
   *
   * La regla era `levelKind === 'STOP_LOSS'` y se quedó corta en cuanto hubo un
   * TAKE_PROFIT que también es condicional: el seguimiento del spec 042 pone su
   * disparador un retroceso POR DEBAJO de la marca, así que una posición de 13
   * USDC se medía como 11,7 y la salida no se colocaba contra un mínimo de 12
   * (spec 044 R-2). En corto es al revés —el disparador queda por encima— y la
   * puerta era más permisiva de la cuenta.
   */
  markPrice?: string | null,
): Veredicto {
  // El stop-loss sigue entrando por su nombre y no solo por su forma: la regla
  // se AMPLIA, no se estrecha. Un stop emitido sin disparador es igualmente una
  // orden a mercado que cierra la posicion, y medirlo en la marca sigue siendo
  // lo correcto.
  const aMercado =
    order.levelKind === 'STOP_LOSS' || (order.type === 'MARKET' && order.triggerPrice != null);
  const referencia = aMercado && markPrice ? markPrice : order.price;
  const check = normalizeOrder(market, referencia, order.qty, order.side);
  if (check.violations.length === 0) return { motivo: 'OK' };

  const nivel = `${order.levelKind}#${order.levelIndex}`;

  // Una ENTRADA que no cumple es un nivel mal dimensionado: se descarta y el
  // resto de la escalera sigue.
  if (!order.reduceOnly) {
    return {
      motivo: 'ENTRADA_INVALIDA',
      tipo: 'ORDER_UNVIABLE',
      severidad: 'WARN',
      mensaje: `Nivel ${nivel} no cumple las reglas del mercado: ${check.violations.join(' ')}`,
    };
  }

  // A partir de aquí, SALIDAS. Una cantidad que se queda en cero al redondear
  // —o un precio no positivo— no es cuestión de mínimos: no hay orden que
  // mandar, y no la acepta ningún venue.
  if (check.qty.lte(0) || check.price.lte(0)) {
    return {
      motivo: 'IMPOSIBLE',
      tipo: 'ORDER_UNVIABLE',
      severidad: 'WARN',
      mensaje: `${nivel} no se puede mandar: ${check.violations.join(' ')}`,
    };
  }

  // El caso que rompía todo. Es TEMPORAL: mientras queden entradas vivas la
  // posición puede crecer, y basta con esperar al siguiente tick. Va en INFO
  // porque no es una avería, y quien lo lea tiene que entender que no hay nada
  // que arreglar.
  if (entradasVivas) {
    return {
      motivo: 'ESPERANDO_MINIMO',
      tipo: 'EXIT_PENDING_MIN_SIZE',
      severidad: 'INFO',
      mensaje:
        `La posición (${order.qty} ${market.base}) aún no llega al mínimo del exchange ` +
        `(${minimoLegible(market)}). ${nivel} se colocará en cuanto entren más ejecuciones.`,
    };
  }

  // Sin entradas vivas la posición ya no va a crecer: hay un resto que el motor
  // no puede cerrar con una orden, y callarlo dejaría al usuario creyendo que su
  // take profit está puesto.
  return {
    motivo: 'RESTO_INCERRABLE',
    tipo: 'POSITION_BELOW_MINIMUM',
    severidad: 'WARN',
    mensaje:
      `Quedan ${order.qty} ${market.base}, por debajo del mínimo del exchange ` +
      `(${minimoLegible(market)}), y ya no hay órdenes de entrada vivas. El motor no puede ` +
      `cerrarlo con una orden: hazlo desde el exchange o añade posición.`,
  };
}
