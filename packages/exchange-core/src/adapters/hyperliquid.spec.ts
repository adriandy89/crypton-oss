import { D, ExchangeError, type Decimal, type MarketSpec } from '@crypton/shared';

/**
 * El adaptador de Hyperliquid sin red (spec 014). El SDK, que es ESM y no se
 * puede cargar desde Jest, se sustituye por un doble minimo; cada test inyecta
 * lo que el venue contestaria.
 */

const mockInfo = {
  metaAndAssetCtxs: jest.fn(),
  l2Book: jest.fn(),
  orderStatus: jest.fn(),
  frontendOpenOrders: jest.fn(),
};
const mockExchange = {
  cancelByCloid: jest.fn(),
};

jest.mock(
  '@nktkas/hyperliquid',
  () => ({
    __esModule: true,
    HttpTransport: class {},
    WebSocketTransport: class {
      close() {
        return Promise.resolve();
      }
    },
    InfoClient: class {
      metaAndAssetCtxs = (...a: unknown[]) => mockInfo.metaAndAssetCtxs(...a);
      l2Book = (...a: unknown[]) => mockInfo.l2Book(...a);
      orderStatus = (...a: unknown[]) => mockInfo.orderStatus(...a);
      frontendOpenOrders = (...a: unknown[]) => mockInfo.frontendOpenOrders(...a);
    },
    ExchangeClient: class {
      cancelByCloid = (...a: unknown[]) => mockExchange.cancelByCloid(...a);
    },
    SubscriptionClient: class {},
  }),
  { virtual: false },
);

// Despues del mock a proposito: el adaptador carga su SDK con require(esm).
const { HyperliquidAdapter } = require('./hyperliquid') as typeof import('./hyperliquid');

const creds = () =>
  ({
    venue: 'HYPERLIQUID',
    accountAddress: '0x' + '1'.repeat(40),
    agentPrivateKey: '0x' + '3'.repeat(64),
  }) as never;

const spec = (over: Partial<MarketSpec> = {}): MarketSpec => ({
  venue: 'HYPERLIQUID',
  symbol: 'BTC',
  canonical: 'BTC/USDC',
  base: 'BTC',
  quote: 'USDC',
  tickSize: '1',
  stepSize: '0.00001',
  minNotional: '10',
  minQty: '0.00001',
  maxQty: null,
  maxLeverage: 40,
  priceDecimals: 0,
  qtyDecimals: 5,
  active: true,
  maxSignificantDigits: 5,
  ...over,
});

const catalogo = (ctx: Record<string, unknown> = {}) => [
  { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] },
  [{ midPx: '79583.5', markPx: '79587.0', prevDayPx: '79000', dayNtlVlm: '1', ...ctx }],
];

type Privado = {
  markets: unknown;
  formatPrice(symbol: string, price: Decimal, side: 'BUY' | 'SELL'): Promise<string>;
  builder(): unknown;
  signingClient: unknown;
  assetIndex: Map<string, number>;
};

beforeEach(() => {
  mockInfo.metaAndAssetCtxs.mockReset();
  mockInfo.l2Book.mockReset();
  mockInfo.orderStatus.mockReset();
  mockInfo.frontendOpenOrders.mockReset();
});

/**
 * Spec 001, F-29. Todo lo que no era `Market` se mapeaba a LIMIT y el
 * disparador se tiraba: para el reconciliador, un stop-loss y una límite al
 * mismo precio eran la misma cosa.
 */
describe('órdenes abiertas (F-29)', () => {
  const abierta = (over: Record<string, unknown>) => ({
    coin: 'BTC',
    side: 'A',
    limitPx: '66500',
    sz: '0.01',
    oid: 5,
    timestamp: 1,
    origSz: '0.01',
    triggerCondition: 'N/A',
    isTrigger: false,
    triggerPx: '0.0',
    children: [],
    isPositionTpsl: false,
    reduceOnly: false,
    orderType: 'Limit',
    tif: 'Gtc',
    cloid: '0x' + 'a'.repeat(32),
    ...over,
  });

  it('un stop a mercado es una MARKET con disparador y reduce-only; una límite no lleva disparador', async () => {
    mockInfo.frontendOpenOrders.mockResolvedValue([
      abierta({
        oid: 5,
        isTrigger: true,
        triggerPx: '70000',
        triggerCondition: 'Price below 70000',
        orderType: 'Stop Market',
        reduceOnly: true,
        tif: null,
      }),
      abierta({ oid: 6, limitPx: '79000' }),
    ]);
    const adapter = new HyperliquidAdapter(creds());

    const [stop, limite] = await adapter.getOpenOrders('BTC');

    expect(stop).toMatchObject({
      venueOrderId: '5',
      type: 'MARKET',
      price: '66500',
      triggerPrice: '70000',
      reduceOnly: true,
    });
    expect(limite).toMatchObject({ venueOrderId: '6', type: 'LIMIT', price: '79000' });
    expect(limite.triggerPrice).toBeNull();
    await adapter.close();
  });
});

describe('presupuesto de caudal (spec 020)', () => {
  /** Spec 001, F-10: las cancelaciones iban por el cupo de lectura. */
  it('cancelar toma presupuesto con prioridad de escritura', async () => {
    mockInfo.metaAndAssetCtxs.mockResolvedValue(catalogo());
    mockExchange.cancelByCloid.mockResolvedValue({ status: 'ok' });
    const budget = { take: jest.fn().mockResolvedValue(undefined) };
    const adapter = new HyperliquidAdapter(creds(), { budget });

    await adapter.cancelOrder({ symbol: 'BTC', clientOrderId: '1a2b3c4d00000000.1.GB0' });

    expect(budget.take).toHaveBeenCalledWith('HYPERLIQUID', 1, 'write', false);
    await adapter.close();
  });
});

describe('precio enviado (F-04)', () => {
  it('el catalogo declara cinco cifras significativas', async () => {
    mockInfo.metaAndAssetCtxs.mockResolvedValue(catalogo());
    const adapter = new HyperliquidAdapter(creds());

    const [btc] = await adapter.getMarkets();

    expect(btc.maxSignificantDigits).toBe(5);
    await adapter.close();
  });

  it('formatPrice usa la misma puerta que la estrategia: hacia el lado seguro y enteros intactos', async () => {
    const adapter = new HyperliquidAdapter(creds());
    const p = adapter as unknown as Privado;
    p.markets = {
      get: async () => spec({ symbol: 'AXS', tickSize: '0.00001', priceDecimals: 5 }),
    };

    expect(await p.formatPrice('AXS', D('1.00001'), 'BUY')).toBe('1');
    expect(await p.formatPrice('AXS', D('1.00001'), 'SELL')).toBe('1.0001');
    p.markets = { get: async () => spec() };
    expect(await p.formatPrice('BTC', D('119375'), 'SELL')).toBe('119375');
    await adapter.close();
  });
});

describe('precio de marca (F-25, F-26)', () => {
  it('mark es el markPx del venue y last el punto medio del libro', async () => {
    mockInfo.metaAndAssetCtxs.mockResolvedValue(catalogo());
    mockInfo.l2Book.mockResolvedValue({
      levels: [[{ px: '79580', sz: '1' }], [{ px: '79587', sz: '1' }]],
    });
    const adapter = new HyperliquidAdapter(creds());

    const t = await adapter.getTicker('BTC');

    expect(t.mark).toBe('79587');
    expect(t.last).toBe('79583.5');
    await adapter.close();
  });

  it('con un lado del libro vacio no inventa la mitad del otro: usa la marca', async () => {
    mockInfo.metaAndAssetCtxs.mockResolvedValue(catalogo());
    mockInfo.l2Book.mockResolvedValue({ levels: [[], [{ px: '79587', sz: '1' }]] });
    const adapter = new HyperliquidAdapter(creds());

    const t = await adapter.getTicker('BTC');

    expect(t.last).toBe('79587');
    expect(t.mark).toBe('79587');
    await adapter.close();
  });

  it('sin lado y sin marca, es RETRYABLE, no un precio', async () => {
    mockInfo.metaAndAssetCtxs.mockResolvedValue([{ universe: [] }, []]);
    mockInfo.l2Book.mockResolvedValue({ levels: [[], [{ px: '79587', sz: '1' }]] });
    const adapter = new HyperliquidAdapter(creds());

    await expect(adapter.getTicker('BTC')).rejects.toMatchObject({ kind: 'RETRYABLE' });
    await adapter.close();
  });
});

describe('enfriamiento tras un throttle (F-28)', () => {
  it('tras un THROTTLED, la siguiente lectura no sale mientras dure el enfriamiento', async () => {
    mockInfo.metaAndAssetCtxs.mockRejectedValue(
      new ExchangeError('THROTTLED', 'HTTP 429', 'HYPERLIQUID'),
    );
    const adapter = new HyperliquidAdapter(creds());

    await expect(adapter.getMarkets()).rejects.toMatchObject({ kind: 'THROTTLED' });
    await expect(adapter.getMarkets()).rejects.toMatchObject({ kind: 'THROTTLED' });

    expect(mockInfo.metaAndAssetCtxs).toHaveBeenCalledTimes(1);
    await adapter.close();
  });
});

describe('cuerpo de la orden (F-16)', () => {
  it('una comision de builder fuera de (0, 100] decimas de punto basico se ignora', async () => {
    const conTope = new HyperliquidAdapter(creds(), {
      builderAddress: '0x' + 'a'.repeat(40),
      builderFeeTenthBps: 1000,
    });
    const valida = new HyperliquidAdapter(creds(), {
      builderAddress: '0x' + 'a'.repeat(40),
      builderFeeTenthBps: 50,
    });

    expect((conTope as unknown as Privado).builder()).toBeNull();
    expect((valida as unknown as Privado).builder()).toEqual({ b: '0x' + 'a'.repeat(40), f: 50 });
    await conTope.close();
    await valida.close();
  });

  it('un acuse sin estados es RETRYABLE, no un fallo sin nombre', async () => {
    const adapter = new HyperliquidAdapter(creds());
    const p = adapter as unknown as Privado;
    p.markets = { get: async () => spec(), all: async () => [spec()] };
    p.assetIndex.set('BTC', 0);
    p.signingClient = {
      order: jest.fn().mockResolvedValue({ response: { data: { statuses: [] } } }),
    };
    mockInfo.orderStatus.mockResolvedValue({ status: 'unknownOid' });

    await expect(
      adapter.placeOrder({
        symbol: 'BTC',
        side: 'BUY',
        type: 'LIMIT',
        price: '79000',
        qty: '0.001',
        clientOrderId: 'a1b2c3d4e5f60718.1.B0',
        reduceOnly: false,
      }),
    ).rejects.toMatchObject({ kind: 'RETRYABLE' });
    await adapter.close();
  });
});

/**
 * Spec 001, F-21. Ningún test construía la petición que `placeOrder` manda al
 * SDK: lo que sale por el cable —activo, lado, precio por la puerta de
 * redondeo, tipo, cloid— solo lo comprobaba el venue, en producción.
 */
describe('cuerpo de placeOrder (F-21)', () => {
  const armar = () => {
    const adapter = new HyperliquidAdapter(creds());
    const p = adapter as unknown as Privado;
    p.markets = { get: async () => spec(), all: async () => [spec()] };
    p.assetIndex.set('BTC', 0);
    const order = jest
      .fn()
      .mockResolvedValue({ response: { data: { statuses: [{ resting: { oid: 7 } }] } } });
    p.signingClient = { order };
    return { adapter, order };
  };
  const pedido = (over: Record<string, unknown> = {}) =>
    ({
      symbol: 'BTC',
      side: 'BUY',
      type: 'LIMIT',
      price: '79000',
      qty: '0.001',
      clientOrderId: 'a1b2c3d4e5f60718.1.B0',
      reduceOnly: false,
      ...over,
    }) as never;

  it('una límite viaja como Gtc, con el precio por la puerta y el cloid codificado', async () => {
    const { adapter, order } = armar();
    const { hyperliquidCodec } = await import('../coid');

    const ack = await adapter.placeOrder(pedido());

    expect(order).toHaveBeenCalledWith({
      orders: [
        {
          a: 0,
          b: true,
          p: '79000',
          s: '0.001',
          r: false,
          t: { limit: { tif: 'Gtc' } },
          c: hyperliquidCodec.encode('a1b2c3d4e5f60718.1.B0'),
        },
      ],
      grouping: 'na',
    });
    expect(ack).toMatchObject({ venueOrderId: '7', status: 'OPEN' });
    await adapter.close();
  });

  it('una post-only va como Alo y una a mercado como Ioc con el 5 % de holgura', async () => {
    const { adapter, order } = armar();

    await adapter.placeOrder(pedido({ side: 'SELL', type: 'POST_ONLY' }));
    await adapter.placeOrder(pedido({ side: 'SELL', type: 'MARKET' }));

    const [postOnly, market] = order.mock.calls.map(
      (c) => (c[0] as { orders: unknown[] }).orders[0],
    );
    expect(postOnly).toMatchObject({ b: false, p: '79000', t: { limit: { tif: 'Alo' } } });
    // 79 000 × 0,95 = 75 050: cruza el libro con holgura y no puede quedarse en reposo.
    expect(market).toMatchObject({ b: false, p: '75050', t: { limit: { tif: 'Ioc' } } });
    await adapter.close();
  });

  it('un stop lleva disparador nativo con el sentido que declara quien lo pide', async () => {
    const { adapter, order } = armar();

    await adapter.placeOrder(
      pedido({
        side: 'SELL',
        type: 'MARKET',
        price: '70000',
        triggerPrice: '70000',
        intent: 'SL',
        reduceOnly: true,
      }),
    );

    const enviado = (order.mock.calls[0][0] as { orders: unknown[] }).orders[0];
    expect(enviado).toMatchObject({
      b: false,
      r: true,
      p: '66500',
      t: { trigger: { isMarket: true, triggerPx: '70000', tpsl: 'sl' } },
    });
    await adapter.close();
  });
});

describe('modificar una orden (F-04b)', () => {
  /**
   * Spec 001, F-04b. \`modifyOrder\` enviaba el precio sin pasar por la puerta
   * de redondeo y forzaba Gtc: una post-only modificada se convertia en una
   * limit normal que puede cruzar el libro y pagar taker. Hoy el motor no
   * modifica (reemplaza cancelando y colocando), pero el camino existe.
   */
  it('formatea el precio como el resto y conserva el post-only', async () => {
    const adapter = new HyperliquidAdapter(creds());
    const p = adapter as unknown as Privado & { getOpenOrders: unknown };
    p.markets = { get: async () => spec({ symbol: 'AXS', tickSize: '0.00001', priceDecimals: 5 }) };
    p.assetIndex.set('AXS', 0);
    const modify = jest.fn().mockResolvedValue({});
    p.signingClient = { modify };
    const { hyperliquidCodec } = await import('../coid');
    p.getOpenOrders = async () => [
      {
        venue: 'HYPERLIQUID',
        symbol: 'AXS',
        clientOrderId: hyperliquidCodec.encode('a1b2c3d4e5f60718.1.B0'),
        venueOrderId: '7',
        side: 'BUY',
        type: 'POST_ONLY',
        price: '1',
        qty: '1',
        filledQty: '0',
        avgPrice: null,
        status: 'OPEN',
        reduceOnly: false,
        createdAt: 0,
      },
    ];

    await adapter.modifyOrder({
      symbol: 'AXS',
      clientOrderId: 'a1b2c3d4e5f60718.1.B0',
      price: '1.00001',
    });

    const orden = modify.mock.calls[0][0].order;
    expect(orden.p).toBe('1');
    expect(orden.t).toEqual({ limit: { tif: 'Alo' } });
    await adapter.close();
  });
});
