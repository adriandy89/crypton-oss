import { Wallet } from 'ethers';
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
  clearinghouseState: jest.fn(),
  spotClearinghouseState: jest.fn(),
  userRole: jest.fn(),
  extraAgents: jest.fn(),
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
      clearinghouseState = (...a: unknown[]) => mockInfo.clearinghouseState(...a);
      spotClearinghouseState = (...a: unknown[]) => mockInfo.spotClearinghouseState(...a);
      userRole = (...a: unknown[]) => mockInfo.userRole(...a);
      extraAgents = (...a: unknown[]) => mockInfo.extraAgents(...a);
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
  mockInfo.clearinghouseState.mockReset();
  mockInfo.spotClearinghouseState.mockReset();
  mockInfo.userRole.mockReset();
  mockInfo.extraAgents.mockReset();
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

describe('lo que el venue ya mandaba y se tiraba (spec 038)', () => {
  it('getTicker devuelve los tamanos del toque y el funding', async () => {
    mockInfo.metaAndAssetCtxs.mockResolvedValue(catalogo({ funding: '0.0000125' }));
    mockInfo.l2Book.mockResolvedValue({
      levels: [[{ px: '79580', sz: '3.5' }], [{ px: '79587', sz: '0.25' }]],
    });
    const adapter = new HyperliquidAdapter(creds());

    const t = await adapter.getTicker('BTC');

    expect(t.bidSize).toBe('3.5');
    expect(t.askSize).toBe('0.25');
    expect(t.fundingRate).toBe('0.0000125');
    // El venue no publica el instante del proximo pago: no se inventa.
    expect(t.nextFundingAt).toBeUndefined();
  });

  it('sin esos campos en la respuesta quedan sin poner, no a cero', async () => {
    // Un cero significaria «libro vacio», que es otra cosa que «no lo publica».
    mockInfo.metaAndAssetCtxs.mockResolvedValue(catalogo());
    mockInfo.l2Book.mockResolvedValue({ levels: [[{ px: '79580' }], [{ px: '79587' }]] });
    const adapter = new HyperliquidAdapter(creds());

    const t = await adapter.getTicker('BTC');

    expect(t.bidSize).toBeUndefined();
    expect(t.askSize).toBeUndefined();
    expect(t.fundingRate).toBeUndefined();
    // Y lo de siempre sigue saliendo.
    expect(t.bid).toBe('79580');
    expect(t.mark).toBe('79587');
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

/**
 * Spec 028. Un usuario pego en «Direccion de tu cuenta» la direccion de su API
 * WALLET —las dos son `0x…` y salen de la misma pantalla de Hyperliquid— y la
 * app le dijo «Verificada · 0,00 USDC disponibles» teniendo 112 USDC dentro.
 *
 * `verify()` solo llamaba a `clearinghouseState`, que es info PUBLICA: acepta
 * cualquier direccion valida y devuelve un estado vacio sin error. Con la
 * direccion de un agente guardada, las lecturas van a una cuenta y las ordenes
 * firmadas a otra: el motor reconciliaria contra el vacio.
 */
describe('verify: la credencial de verdad (spec 028)', () => {
  const cuenta = '0x' + '1'.repeat(40);
  const clave = '0x' + '3'.repeat(64);
  const agente = new Wallet(clave).address;

  const autorizado = (over: Record<string, unknown> = {}) => [
    { address: agente, name: 'crypton', validUntil: 1_800_000_000_000, ...over },
  ];

  it('rechaza la direccion de una API wallet y DICE cual es la cuenta', async () => {
    const principal = '0x' + '9'.repeat(40);
    mockInfo.userRole.mockResolvedValue({ role: 'agent', data: { user: principal } });
    const adapter = new HyperliquidAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(false);
    // El venue nos da la direccion buena: el mensaje se la tiene que dar al usuario.
    expect(r.detail).toContain(principal);
    expect(r.detail).toMatch(/API wallet/i);
    // Y no se llega a preguntar por el saldo de una cuenta que no es una cuenta.
    expect(mockInfo.clearinghouseState).not.toHaveBeenCalled();
    await adapter.close();
  });

  it('rechaza una subcuenta: sus ordenes irian a la principal', async () => {
    const master = '0x' + '7'.repeat(40);
    mockInfo.userRole.mockResolvedValue({ role: 'subAccount', data: { master } });
    const adapter = new HyperliquidAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(false);
    expect(r.detail).toContain(master);
    await adapter.close();
  });

  it('rechaza un vault', async () => {
    mockInfo.userRole.mockResolvedValue({ role: 'vault' });
    const adapter = new HyperliquidAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/vault/i);
    await adapter.close();
  });

  it('rechaza una direccion que el venue no conoce en esa red', async () => {
    mockInfo.userRole.mockResolvedValue({ role: 'missing' });
    const adapter = new HyperliquidAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no conoce|sin actividad|deposito|depósito/i);
    await adapter.close();
  });

  it('rechaza una clave que no esta autorizada en esa cuenta', async () => {
    mockInfo.userRole.mockResolvedValue({ role: 'user' });
    mockInfo.extraAgents.mockResolvedValue(autorizado({ address: '0x' + 'b'.repeat(40) }));
    const adapter = new HyperliquidAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no est[aá] autorizada/i);
    // La clave NUNCA aparece en el motivo del rechazo.
    expect(r.detail).not.toContain(clave);
    expect(r.detail).not.toContain(clave.slice(2, 12));
    await adapter.close();
  });

  it('acepta la credencial buena y devuelve la caducidad del agente', async () => {
    mockInfo.userRole.mockResolvedValue({ role: 'user' });
    mockInfo.extraAgents.mockResolvedValue(autorizado());
    mockInfo.clearinghouseState.mockResolvedValue({
      marginSummary: { accountValue: '112.15', totalMarginUsed: '0' },
      withdrawable: '112.15',
      assetPositions: [],
    });
    const adapter = new HyperliquidAdapter(creds());

    const r = await adapter.verify();

    expect(r).toMatchObject({ ok: true, publicRef: cuenta, agentValidUntil: 1_800_000_000_000 });
    expect(mockInfo.userRole).toHaveBeenCalledWith({ user: cuenta });
    await adapter.close();
  });

  /**
   * `extraAgents` devuelve la direccion en checksum EIP-55 y la nuestra sale de
   * `ethers`, que tambien la da en checksum, pero una cuenta vieja o otro venue
   * pueden traerla en minusculas: comparar cadenas tal cual rechazaria una
   * credencial perfectamente valida.
   */
  it('compara direcciones sin distinguir mayusculas', async () => {
    mockInfo.userRole.mockResolvedValue({ role: 'user' });
    mockInfo.extraAgents.mockResolvedValue(autorizado({ address: agente.toLowerCase() }));
    mockInfo.clearinghouseState.mockResolvedValue({
      marginSummary: { accountValue: '1', totalMarginUsed: '0' },
      withdrawable: '1',
      assetPositions: [],
    });
    const adapter = new HyperliquidAdapter(creds());

    expect((await adapter.verify()).ok).toBe(true);
    await adapter.close();
  });

  it('un agente sin caducidad se acepta con validUntil nulo', async () => {
    mockInfo.userRole.mockResolvedValue({ role: 'user' });
    mockInfo.extraAgents.mockResolvedValue(autorizado({ validUntil: null }));
    mockInfo.clearinghouseState.mockResolvedValue({
      marginSummary: { accountValue: '1', totalMarginUsed: '0' },
      withdrawable: '1',
      assetPositions: [],
    });
    const adapter = new HyperliquidAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(true);
    expect(r.agentValidUntil).toBeNull();
    await adapter.close();
  });

  it('si el venue no contesta, el motivo es el del venue y no un ok falso', async () => {
    mockInfo.userRole.mockRejectedValue(new Error('boom'));
    const adapter = new HyperliquidAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(false);
    expect(r.publicRef).toBe(cuenta);
    await adapter.close();
  });
});

/**
 * El dinero en el bolsillo de al lado (spec 028).
 *
 * Hyperliquid separa spot de perps y solo el segundo respalda una posicion. El
 * saldo que pinta la app sale de `clearinghouseState`, asi que quien tenga el
 * deposito en spot ve «0,00 USDC disponibles» sin ninguna pista de por que.
 */
describe('getBalances: la pista de spot (spec 028)', () => {
  const perps = (accountValue: string) => ({
    marginSummary: { accountValue, totalMarginUsed: '0' },
    withdrawable: accountValue,
    assetPositions: [],
  });

  it('con la cuenta de perps a cero dice cuanto hay en spot', async () => {
    mockInfo.clearinghouseState.mockResolvedValue(perps('0'));
    mockInfo.spotClearinghouseState.mockResolvedValue({
      balances: [
        { coin: 'HYPE', token: 1, total: '3', hold: '0', entryNtl: '0' },
        { coin: 'USDC', token: 0, total: '112.15', hold: '0', entryNtl: '0' },
      ],
    });
    const adapter = new HyperliquidAdapter(creds());

    const [saldo] = await adapter.getBalances();

    expect(saldo.available).toBe('0');
    expect(saldo.spot).toBe('112.15');
    await adapter.close();
  });

  it('con equity no pregunta por spot: seria una peticion de mas en cada tick', async () => {
    mockInfo.clearinghouseState.mockResolvedValue(perps('500'));
    const adapter = new HyperliquidAdapter(creds());

    const [saldo] = await adapter.getBalances();

    expect(saldo.spot).toBeUndefined();
    expect(mockInfo.spotClearinghouseState).not.toHaveBeenCalled();
    await adapter.close();
  });

  it('spot a cero no deja una pista que no dice nada', async () => {
    mockInfo.clearinghouseState.mockResolvedValue(perps('0'));
    mockInfo.spotClearinghouseState.mockResolvedValue({
      balances: [{ coin: 'USDC', token: 0, total: '0', hold: '0', entryNtl: '0' }],
    });
    const adapter = new HyperliquidAdapter(creds());

    expect((await adapter.getBalances())[0].spot).toBeUndefined();
    await adapter.close();
  });

  it('si la consulta de spot falla, el saldo se devuelve igual', async () => {
    // Una pista no puede tumbar el dato. Sin esto, un fallo en la llamada
    // AUXILIAR dejaria la cabecera sin el saldo, que es lo unico que importa.
    mockInfo.clearinghouseState.mockResolvedValue(perps('0'));
    mockInfo.spotClearinghouseState.mockRejectedValue(new Error('boom'));
    const adapter = new HyperliquidAdapter(creds());

    const [saldo] = await adapter.getBalances();

    expect(saldo.total).toBe('0');
    expect(saldo.spot).toBeUndefined();
    await adapter.close();
  });
});
