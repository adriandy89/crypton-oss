import type { MarketSpec } from '@crypton/shared';
import { MarketsService } from './markets.service';

/**
 * Spec 024. `MarketSpec` ganó cuatro campos en los specs 013, 014, 019 y 023
 * —tope de órdenes activas, cifras significativas, tasa de mantenimiento y tope
 * de las órdenes a mercado— y los adaptadores los rellenan, pero la API
 * construía el mercado desde la fila de `markets`, que no los guardaba: las
 * cuatro correcciones se quedaban en el adaptador.
 */
const fila = {
  venue: 'HYPERLIQUID',
  testnet: false,
  symbol: 'BTC',
  canonical: 'BTC/USDC',
  base: 'BTC',
  quote: 'USDC',
  tick_size: '1',
  step_size: '0.00001',
  min_notional: '10',
  min_qty: '0.00001',
  max_qty: null,
  max_leverage: 40,
  price_decimals: 0,
  qty_decimals: 5,
  active: true,
  max_market_qty: null,
  max_active_orders: null,
  max_significant_digits: 5,
  maintenance_margin_rate: '0.0125',
};

const spec: MarketSpec = {
  venue: 'ASTER',
  symbol: 'BTCUSDT',
  canonical: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  tickSize: '0.1',
  stepSize: '0.001',
  minNotional: '5',
  minQty: '0.001',
  maxQty: '1000',
  maxMarketQty: '120',
  maxLeverage: 50,
  priceDecimals: 1,
  qtyDecimals: 3,
  active: true,
  maxActiveOrders: 200,
  maxSignificantDigits: null,
  maintenanceMarginRate: 0.004,
};

function build() {
  const db = {
    market: {
      findUnique: jest.fn().mockResolvedValue(fila),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const svc = new MarketsService(db as never, {} as never);
  return { svc, db };
}

describe('MarketsService y los campos del venue (spec 024)', () => {
  it('getSpec devuelve los cuatro campos que guarda la fila', async () => {
    const { svc } = build();

    const market = await svc.getSpec('HYPERLIQUID', 'BTC');

    expect(market).toMatchObject({
      maxSignificantDigits: 5,
      maintenanceMarginRate: 0.0125,
      maxActiveOrders: null,
      maxMarketQty: null,
    });
  });

  it('la sincronización escribe los cuatro campos del adaptador', async () => {
    const { svc, db } = build();
    type Privado = { upsertAll(specs: MarketSpec[], testnet: boolean): Promise<void> };

    await (svc as unknown as Privado).upsertAll([spec], false);

    expect(db.market.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          max_market_qty: '120',
          max_active_orders: 200,
          max_significant_digits: null,
          maintenance_margin_rate: 0.004,
        }),
      }),
    );
  });

  it('la lista los incluye en su select: el preview local los necesita igual que el del servidor', async () => {
    const { svc, db } = build();

    await svc.list();

    expect(db.market.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          max_market_qty: true,
          max_active_orders: true,
          max_significant_digits: true,
          maintenance_margin_rate: true,
        }),
      }),
    );
  });
});
