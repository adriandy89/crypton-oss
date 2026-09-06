import { BotStore } from './bot-store';

/**
 * Spec 024. El motor construye el mercado de cada bot desde la fila de
 * `markets`, y esa fila no guardaba lo que los specs 013, 014, 019 y 023
 * añadieron a `MarketSpec`: la estrategia redondeaba sin la regla de cifras
 * significativas de Hyperliquid mientras el adaptador sí la aplicaba (F-04
 * seguía vivo), y el cierre troceado de Aster no conocía su tope.
 */
describe('BotStore.marketSpec (spec 024)', () => {
  it('devuelve los campos del venue que guarda la fila de markets', async () => {
    const fila = {
      venue: 'LIGHTER',
      symbol: 'ETH',
      canonical: 'ETH/USDC',
      base: 'ETH',
      quote: 'USDC',
      tick_size: '0.01',
      step_size: '0.001',
      min_notional: '10',
      min_qty: '0.001',
      max_qty: null,
      max_leverage: 50,
      price_decimals: 2,
      qty_decimals: 3,
      active: true,
      max_market_qty: null,
      max_active_orders: 30,
      max_significant_digits: null,
      maintenance_margin_rate: '0.0125',
    };
    const db = { market: { findUniqueOrThrow: jest.fn().mockResolvedValue(fila) } };
    const store = new BotStore(db as never, {} as never);

    const spec = await store.marketSpec('LIGHTER', 'ETH', false);

    expect(spec).toMatchObject({
      tickSize: '0.01',
      maxActiveOrders: 30,
      maintenanceMarginRate: 0.0125,
      maxSignificantDigits: null,
      maxMarketQty: null,
    });
  });
});
