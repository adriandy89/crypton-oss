import { Wallet } from 'ethers';
import { AsterAdapter, nextAsterNonce } from './aster';
import { asterCodec } from '../coid';

/**
 * El adaptador de Aster por la parte que no necesita red: como fabrica sus
 * nonces, que hace con la comision de una ejecucion y como comprueba el reloj
 * (spec 012). Todo lo firmado se firma de verdad, con una clave de prueba;
 * lo que sale por `fetch` se captura sin salir a ninguna parte.
 */

const KEY = '0x' + '11'.repeat(32);
const address = new Wallet(KEY).address;
const creds = () =>
  ({ userAddress: address, signerAddress: address, signerPrivateKey: KEY }) as never;

type Respuesta = { status?: number; body: unknown; headers?: Record<string, string> };

/** Sustituye `fetch` por un respondedor local y devuelve las URL que se pidieron. */
function mockFetch(responder: (url: string) => Respuesta) {
  const urls: string[] = [];
  const fetchMock = jest.fn(async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const r = responder(url);
    const status = r.status ?? 200;
    return {
      ok: status < 400,
      status,
      statusText: 'OK',
      headers: { get: (name: string) => r.headers?.[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(r.body),
    };
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  return { urls };
}

const nonceDe = (url: string): number => Number(new URL(url).searchParams.get('nonce'));

afterEach(() => {
  jest.restoreAllMocks();
});

describe('nonce de Aster', () => {
  /**
   * Spec 001, F-38. El nonce era `segundo × 10⁶ + contador`, con el contador a
   * cero en cada segundo nuevo: un paso de NTP hacia atras volvia a un segundo
   * ya usado y repetia un nonce que el venue rechaza.
   */
  it('es estrictamente creciente aunque el reloj retroceda', () => {
    const spy = jest.spyOn(Date, 'now');
    spy
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(999_000)
      .mockReturnValueOnce(999_000);

    const nonces = [nextAsterNonce(), nextAsterNonce(), nextAsterNonce(), nextAsterNonce()].map(
      Number,
    );

    expect(new Set(nonces).size).toBe(4);
    for (let i = 1; i < nonces.length; i++) expect(nonces[i]).toBeGreaterThan(nonces[i - 1]);
  });

  /**
   * Spec 001, F-69. La API crea un adaptador por peticion y firma con el mismo
   * `signer` que el worker; con el contador por instancia, dos adaptadores
   * generaban el mismo nonce en el mismo segundo y la segunda peticion recibia
   * -4225. Dentro de un proceso el nonce es unico; entre procesos, el
   * desplazamiento aleatorio hace la colision improbable.
   */
  it('dos adaptadores con el mismo firmante no repiten nonce', async () => {
    type ConFirma = { signedQuery(p: Record<string, string>): Promise<string> };
    const a = new AsterAdapter(creds()) as unknown as ConFirma;
    const b = new AsterAdapter(creds()) as unknown as ConFirma;

    const [qa, qb] = await Promise.all([a.signedQuery({ x: '1' }), b.signedQuery({ x: '1' })]);
    const na = new URLSearchParams(qa).get('nonce');
    const nb = new URLSearchParams(qb).get('nonce');

    expect(na).not.toBeNull();
    expect(na).not.toBe(nb);
  });
});

describe('el nonce se genera al enviar', () => {
  /**
   * Spec 001, F-75. El nonce se calculaba al firmar, ANTES de la cola del
   * limitador y del presupuesto: con ochenta peticiones encoladas la ultima
   * salia con un nonce de hace mas de diez segundos y el venue la rechazaba
   * (-4225 → FATAL → cuarentena). Con dos peticiones por segundo, la segunda
   * espera medio segundo: si su nonce nace al enviar, va medio segundo por
   * delante del primero; si naciera al encolar, los dos serian casi iguales.
   */
  it('no al encolar', async () => {
    const { urls } = mockFetch(() => ({ body: [] }));
    const adapter = new AsterAdapter(creds(), { rateLimitPerSecond: 2 });

    await Promise.all([adapter.getBalances(), adapter.getBalances()]);

    const [n1, n2] = urls.map(nonceDe);
    expect(n2 - n1).toBeGreaterThanOrEqual(400_000); // microsegundos
  });
});

describe('comisiones', () => {
  /**
   * Spec 001, F-78. La doc de Aster no define el signo de `commission` y su
   * ejemplo de `userTrades` trae `-0.078` en un taker. Una comision es un
   * coste: se contabiliza en valor absoluto. Si se guardara con su signo y el
   * venue expresara lo pagado en negativo, la contabilidad la SUMARIA al
   * realizado.
   */
  it('la comision se contabiliza como coste sea cual sea su signo', async () => {
    mockFetch(() => ({
      body: [
        {
          id: 1,
          orderId: 2,
          symbol: 'BTCUSDT',
          price: '100',
          qty: '1',
          commission: '-0.078',
          commissionAsset: 'USDT',
          buyer: true,
          maker: false,
          time: 1,
        },
      ],
    }));
    const adapter = new AsterAdapter(creds());

    const [fill] = await adapter.getRecentFills('BTCUSDT', 0);

    expect(fill.fee).toBe('0.078');
    expect(fill.isTaker).toBe(true);
  });
});

describe('presupuesto de caudal (spec 020)', () => {
  const presupuesto = () => ({
    take: jest.fn().mockResolvedValue(undefined),
    takeOrders: jest.fn().mockResolvedValue(undefined),
    observe: jest.fn(),
  });

  /** Spec 001, F-10: las cancelaciones iban por el cupo de lectura. */
  it('cancelar toma presupuesto con prioridad de escritura', async () => {
    mockFetch(() => ({ body: {} }));
    const b = presupuesto();
    const adapter = new AsterAdapter(creds(), { budget: b });

    await adapter.cancelOrder({ symbol: 'BTCUSDT', venueOrderId: '5' });

    expect(b.take).toHaveBeenCalledWith('ASTER', 1, 'write', false);
  });

  /** Spec 001, F-24: colocar una orden consume también el cupo de órdenes. */
  it('colocar una orden consume el cupo de órdenes', async () => {
    mockFetch(() => ({ body: {} }));
    const b = presupuesto();
    type Privado = {
      signedRequestOnce(m: string, p: string, params: Record<string, string>): Promise<unknown>;
    };
    const adapter = new AsterAdapter(creds(), { budget: b }) as unknown as Privado;

    await adapter.signedRequestOnce('POST', '/fapi/v3/order', { symbol: 'BTCUSDT' });

    expect(b.takeOrders).toHaveBeenCalledWith('ASTER', 1, false);
  });

  /** Spec 001, F-76: las cabeceras del venue se ignoraban. */
  it('las cabeceras del venue realimentan el presupuesto', async () => {
    mockFetch(() => ({
      body: [],
      headers: { 'x-mbx-used-weight-1m': '41', 'x-mbx-order-count-10s': '3' },
    }));
    const b = presupuesto();
    const adapter = new AsterAdapter(creds(), { budget: b });

    await adapter.getOpenOrders('BTCUSDT');

    expect(b.observe).toHaveBeenCalledWith(
      'ASTER',
      false,
      expect.objectContaining({ usedWeightPerMinute: 41, ordersPer10s: 3 }),
    );
  });
});

/**
 * Spec 001, F-21. Ningún test construía la petición firmada de `placeOrder`:
 * qué parámetros van, con qué nombres y qué se omite según el tipo solo lo
 * comprobaba el venue.
 */
describe('cuerpo de placeOrder (F-21)', () => {
  const parametros = (url: string) => Object.fromEntries(new URL(url).searchParams);
  const pedido = (over: Record<string, unknown> = {}) =>
    ({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '79000',
      qty: '0.001',
      clientOrderId: 'a1b2c3d4e5f60718.1.B0',
      reduceOnly: false,
      ...over,
    }) as never;

  it('una límite firma símbolo, lado, tipo, cantidad, precio, vigencia y el id codificado', async () => {
    const { urls } = mockFetch(() => ({ body: { orderId: 11, status: 'NEW', updateTime: 5 } }));
    const adapter = new AsterAdapter(creds());

    const ack = await adapter.placeOrder(pedido());

    expect(urls[0]).toContain('/fapi/v3/order?');
    const q = parametros(urls[0]);
    expect(q).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '0.001',
      price: '79000',
      timeInForce: 'GTC',
      newClientOrderId: asterCodec.encode('a1b2c3d4e5f60718.1.B0'),
      user: address,
      signer: address,
    });
    expect(q.nonce).toMatch(/^\d+$/);
    expect(q.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(q.reduceOnly).toBeUndefined();
    expect(q.stopPrice).toBeUndefined();
    expect(ack).toMatchObject({ venueOrderId: '11', status: 'OPEN' });
  });

  it('una post-only es GTX; un take profit a mercado es TAKE_PROFIT_MARKET sobre la marca, sin precio', async () => {
    const { urls } = mockFetch(() => ({ body: { orderId: 12, status: 'NEW', updateTime: 5 } }));
    const adapter = new AsterAdapter(creds());

    await adapter.placeOrder(pedido({ type: 'POST_ONLY' }));
    await adapter.placeOrder(
      pedido({
        side: 'SELL',
        type: 'MARKET',
        price: '81000',
        triggerPrice: '81000',
        intent: 'TP',
        reduceOnly: true,
      }),
    );

    const postOnly = parametros(urls[0]);
    const takeProfit = parametros(urls[1]);
    expect(postOnly).toMatchObject({ type: 'LIMIT', timeInForce: 'GTX', price: '79000' });
    expect(takeProfit).toMatchObject({
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: '81000',
      workingType: 'MARK_PRICE',
      reduceOnly: 'true',
      quantity: '0.001',
    });
    expect(takeProfit.price).toBeUndefined();
    expect(takeProfit.timeInForce).toBeUndefined();
  });
});

/**
 * Spec 001, F-22. `MarketSpec.maxQty` salía de `LOT_SIZE`, que solo acota las
 * órdenes límite; las órdenes a mercado tienen su propio tope
 * (`MARKET_LOT_SIZE`) y en Aster es siempre menor: 120 BTC frente a 1000.
 */
describe('catálogo (F-22)', () => {
  it('lee el tope de cantidad de las órdenes a mercado, aparte del de las límite', async () => {
    mockFetch(() => ({
      body: {
        symbols: [
          {
            symbol: 'BTCUSDT',
            contractType: 'PERPETUAL',
            status: 'TRADING',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.10' },
              { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
              { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '120' },
              { filterType: 'MIN_NOTIONAL', notional: '5' },
            ],
          },
        ],
      },
    }));
    const adapter = new AsterAdapter(creds());

    const [btc] = await adapter.getMarkets();

    expect(btc).toMatchObject({ maxQty: '1000', maxMarketQty: '120', maxActiveOrders: 200 });
  });
});

/** Spec 001, F-79: menores de Aster con conducta observable. */
describe('menores de Aster (F-79)', () => {
  it('una orden que no es a mercado y llega sin precio se rechaza antes de firmar', async () => {
    const { urls } = mockFetch(() => ({ body: { orderId: 1, status: 'NEW' } }));
    const adapter = new AsterAdapter(creds());

    // Antes iba `price: ''` y el venue contestaba con un rechazo que no decía
    // qué faltaba. El motor nunca llega aquí sin precio; la frontera no se fía.
    await expect(
      adapter.placeOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        qty: '0.001',
        clientOrderId: 'a1b2c3d4e5f60718.1.B0',
        reduceOnly: false,
      }),
    ).rejects.toMatchObject({ kind: 'RULES' });
    expect(urls).toHaveLength(0);
  });

  it('un modo de margen que no puede cambiar con posición no impide fijar el apalancamiento', async () => {
    const { urls } = mockFetch((url) =>
      url.includes('/fapi/v3/marginType')
        ? {
            status: 400,
            body: { code: -4047, msg: 'Margin type cannot be changed if there exists position.' },
          }
        : { body: {} },
    );
    const adapter = new AsterAdapter(creds());

    await adapter.setLeverage('BTCUSDT', 3, 'ISOLATED');

    expect(urls.some((u) => u.includes('/fapi/v3/leverage'))).toBe(true);
  });
});

describe('verify y el reloj', () => {
  /**
   * Spec 001, F-38. Aster firma con una ventana de ±60 s frente a SU reloj y
   * el adaptador nunca lo miraba: con el reloj local desviado, todas las
   * peticiones firmadas fallaban con un mensaje que no decia por que.
   */
  it('un reloj desviado mas de veinte segundos se rechaza con el motivo', async () => {
    mockFetch((url) =>
      url.includes('/fapi/v3/time') ? { body: { serverTime: Date.now() - 120_000 } } : { body: [] },
    );
    const adapter = new AsterAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/reloj/i);
  });

  it('con el reloj en hora, verifica el saldo', async () => {
    const { urls } = mockFetch((url) =>
      url.includes('/fapi/v3/time') ? { body: { serverTime: Date.now() } } : { body: [] },
    );
    const adapter = new AsterAdapter(creds());

    const r = await adapter.verify();

    expect(r.ok).toBe(true);
    expect(urls.some((u) => u.includes('/fapi/v3/balance'))).toBe(true);
  });
});

describe('liquidaciones (F-70)', () => {
  type ConEventos = {
    fills$: { subscribe(fn: (f: { liquidation?: boolean; venueFillId: string }) => void): unknown };
    handleUserEvent(raw: string): void;
  };
  const orden = (over: Record<string, unknown>) => ({
    e: 'ORDER_TRADE_UPDATE',
    E: 1,
    o: {
      s: 'BTCUSDT',
      c: 'x',
      i: 5,
      S: 'SELL',
      o: 'LIMIT',
      ot: 'LIMIT',
      x: 'TRADE',
      X: 'FILLED',
      p: '100',
      q: '1',
      z: '1',
      ap: '100',
      L: '100',
      l: '1',
      t: 9,
      n: '0.1',
      N: 'USDT',
      m: false,
      R: true,
      ...over,
    },
  });

  /**
   * Spec 001, F-70. Se buscaba `LIQUIDATION` en el tipo de orden, pero la doc
   * V3 marca la liquidacion en el id de cliente (`autoclose-…`, `adl_autoclose`),
   * en la ejecucion (`x: CALCULATED`) y en el estado (`NEW_INSURANCE`,
   * `NEW_ADL`): ninguna liquidacion real se reconocia y el bot seguia creyendo
   * tener la posicion.
   */
  it.each([
    ['autoclose- en el id de cliente', { c: 'autoclose-1700000000' }],
    ['adl_autoclose en el id de cliente', { c: 'adl_autoclose' }],
    ['x CALCULATED', { x: 'CALCULATED' }],
    ['X NEW_INSURANCE', { X: 'NEW_INSURANCE' }],
    ['X NEW_ADL', { X: 'NEW_ADL' }],
  ])('%s emite un fill marcado como liquidacion', (_nombre, over) => {
    const adapter = new AsterAdapter(creds()) as unknown as ConEventos;
    const fills: { liquidation?: boolean }[] = [];
    adapter.fills$.subscribe((f) => fills.push(f));

    adapter.handleUserEvent(JSON.stringify(orden(over)));

    expect(fills).toHaveLength(1);
    expect(fills[0].liquidation).toBe(true);
  });

  it('una ejecucion normal no se marca', () => {
    const adapter = new AsterAdapter(creds()) as unknown as ConEventos;
    const fills: { liquidation?: boolean }[] = [];
    adapter.fills$.subscribe((f) => fills.push(f));

    adapter.handleUserEvent(JSON.stringify(orden({})));

    expect(fills).toHaveLength(1);
    expect(fills[0].liquidation).toBeUndefined();
  });
});

describe('ventana de userTrades (F-74)', () => {
  /**
   * Spec 001, F-74. «The time between startTime and endTime cannot be longer
   * than 7 days»: un bot sin ejecucion propia en una semana mandaba un
   * startTime de hace mas de siete dias y sin endTime, y la red de seguridad
   * del stream dejaba de devolver fills con un warn como unico aviso.
   */
  it('acota startTime a siete dias y manda endTime', async () => {
    const { urls } = mockFetch(() => ({ body: [] }));
    const adapter = new AsterAdapter(creds());
    const antes = Date.now();

    await adapter.getRecentFills('BTCUSDT', 0);

    const url = new URL(urls.find((u) => u.includes('/fapi/v3/userTrades'))!);
    const startTime = Number(url.searchParams.get('startTime'));
    const endTime = Number(url.searchParams.get('endTime'));
    expect(startTime).toBeGreaterThanOrEqual(antes - 7 * 24 * 3600_000);
    expect(endTime).toBeGreaterThanOrEqual(antes);
    expect(endTime - startTime).toBeLessThanOrEqual(7 * 24 * 3600_000);
  });
});

describe('lo que el venue ya mandaba y se tiraba (spec 038)', () => {
  // Los nombres salen de la documentacion del venue, citada en el spec:
  // bookTicker trae bidQty/askQty y premiumIndex lastFundingRate/nextFundingTime.
  const responder = (extraBook: object, extraPremium: object) => (url: string) => {
    if (url.includes('/ticker/bookTicker')) {
      return { body: { symbol: 'BTCUSDT', bidPrice: '100.1', askPrice: '100.3', ...extraBook } };
    }
    if (url.includes('/premiumIndex')) {
      return { body: { symbol: 'BTCUSDT', markPrice: '100.2', ...extraPremium } };
    }
    return { body: {} };
  };

  it('getTicker devuelve tamanos del toque, funding y proximo pago', async () => {
    mockFetch(
      responder(
        { bidQty: '431.5', askQty: '9' },
        { lastFundingRate: '0.00038246', nextFundingTime: 1597392000000 },
      ),
    );
    const t = await new AsterAdapter(creds()).getTicker('BTCUSDT');

    expect(t.bidSize).toBe('431.5');
    expect(t.askSize).toBe('9');
    expect(t.fundingRate).toBe('0.00038246');
    expect(t.nextFundingAt).toBe(1597392000000);
  });

  it('si el venue deja de mandarlos quedan sin poner, y el resto sigue igual', async () => {
    mockFetch(responder({}, {}));
    const t = await new AsterAdapter(creds()).getTicker('BTCUSDT');

    expect(t.bidSize).toBeUndefined();
    expect(t.askSize).toBeUndefined();
    expect(t.fundingRate).toBeUndefined();
    expect(t.nextFundingAt).toBeUndefined();
    expect(t.bid).toBe('100.1');
    expect(t.mark).toBe('100.2');
  });

  it('un funding NEGATIVO se conserva con su signo', async () => {
    // Importa: el signo es lo que dice quien paga a quien.
    mockFetch(responder({}, { lastFundingRate: '-0.0004' }));
    const t = await new AsterAdapter(creds()).getTicker('BTCUSDT');
    expect(t.fundingRate).toBe('-0.0004');
  });
});
