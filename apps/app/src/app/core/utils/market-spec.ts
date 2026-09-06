import type { MarketSpec } from '@crypton/shared';
import type { Market } from '../models';

/**
 * Puente entre la fila que sirve `GET /markets` y el `MarketSpec` del dominio.
 *
 * Existen las dos formas y no sobra ninguna: la API devuelve la fila de la
 * tabla tal cual —snake_case, como la escribio el cron de sincronizacion— y el
 * dominio compartido habla camelCase. Sin este puente, `max_leverage`,
 * `min_notional`, `tick_size` y `step_size` viajaban hasta la app en cada
 * peticion del catalogo y no los leia nadie.
 *
 * Con el, la app puede llamar a `strategy.preview()` y `strategy.validate()`
 * —las mismas funciones puras que ejecuta el motor— sin pedirle nada al
 * servidor.
 */
export function toMarketSpec(m: Market): MarketSpec {
  return {
    venue: m.venue,
    symbol: m.symbol,
    canonical: m.canonical,
    base: m.base,
    quote: m.quote,
    tickSize: m.tick_size,
    stepSize: m.step_size,
    minNotional: m.min_notional,
    // `?? null` y no `!`: un servidor sin actualizar todavia no manda estos dos
    // campos, y `MarketSpec` ya admite null en ambos. Degradar a null solo
    // relaja la deteccion de violaciones de cantidad; inventarse un numero
    // haria que el preview local dijera que una orden es valida cuando no lo es.
    minQty: m.min_qty ?? null,
    maxQty: m.max_qty ?? null,
    // Los cuatro campos del venue (spec 024): sin ellos el preview local no
    // avisaba de una reticula mayor que el tope de ordenes ni redondeaba con las
    // cifras significativas de Hyperliquid, y el del servidor si.
    maxMarketQty: m.max_market_qty ?? null,
    maxActiveOrders: m.max_active_orders ?? null,
    maxSignificantDigits: m.max_significant_digits ?? null,
    maintenanceMarginRate:
      m.maintenance_margin_rate == null ? null : Number(m.maintenance_margin_rate),
    maxLeverage: m.max_leverage,
    priceDecimals: m.price_decimals,
    qtyDecimals: m.qty_decimals,
    active: m.active,
  };
}
