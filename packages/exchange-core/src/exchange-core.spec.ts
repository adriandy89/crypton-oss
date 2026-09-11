import { Observable, Subject } from 'rxjs';
import {
  D,
  OrderStatus,
  ExchangeError,
  Venue,
  type Balance,
  type Candle,
  type Fill,
  type MarketSpec,
  type MarketTicker,
  type OrderAck,
  type Position,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';
import { DryRunAdapter } from './adapters/dry-run';
import { esLiquidacionHl } from './adapters/hyperliquid';
import { asterCodec, codecFor, hyperliquidCodec, lighterCodec } from './coid';
import { classify, isRetryable, messageOf, toExchangeError } from './errors';
import { MarketSpecCache, decimalsOf } from './market-cache';
import {
  capabilitiesOf,
  changePct,
  checkInterval,
  finishCandles,
  num,
  numOrNull,
  resolveRange,
} from './candles';
import { RateLimiter, withRetry, withWriteRetry } from './rate-limit';
import { MemoryVenueBudget } from './venue-budget';
import type { ExchangeAdapter, StreamHealth } from './types';
import { hyperliquidTickSize } from './adapters/hyperliquid';
import { oldestPrice, scaled } from './adapters/lighter';

/**
 * Topes de paginación de histórico para los dobles de este fichero.
 *
 * Cualquier valor vale: lo que se comprueba aquí no es la política de caudal
 * —eso vive en `capabilities.ts`, por venue— sino que las capacidades la lleven.
 */
const HIST = { maxHistoryPages: 9, minPageGapMs: 400 };

// ═══════════════════════════════════════════════════════════════
// IDS DE CLIENTE
// ═══════════════════════════════════════════════════════════════

describe('codecs de client order id', () => {
  const coid = '1a2b3c4d.7.S3';

  it('Hyperliquid produce un cloid de 34 caracteres (0x + 16 bytes)', () => {
    const encoded = hyperliquidCodec.encode(coid);
    expect(encoded).toMatch(/^0x[0-9a-f]{32}$/);
    expect(encoded).toHaveLength(34);
  });

  it('Lighter produce un entero por debajo del límite seguro de JavaScript', () => {
    const n = lighterCodec.encodeNumeric!(coid);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(n).toBeGreaterThan(0);
  });

  it('Aster conserva el id legible cuando cabe', () => {
    expect(asterCodec.encode(coid)).toBe(coid);
  });

  it('Aster recorta a hash si el id se pasa de 36 caracteres', () => {
    const largo = 'x'.repeat(50);
    expect(asterCodec.encode(largo)).toHaveLength(32);
  });

  it('la codificación es determinista: la misma entrada da la misma salida', () => {
    // Es la propiedad de la que depende toda la idempotencia: sin ella, un
    // worker reiniciado no reconocería sus propias órdenes.
    for (const venue of [Venue.HYPERLIQUID, Venue.LIGHTER, Venue.ASTER]) {
      const codec = codecFor(venue);
      expect(codec.encode(coid)).toBe(codec.encode(coid));
    }
  });

  it('niveles distintos producen ids distintos', () => {
    const a = hyperliquidCodec.encode('1a2b3c4d.7.S3');
    const b = hyperliquidCodec.encode('1a2b3c4d.7.S4');
    const c = hyperliquidCodec.encode('1a2b3c4d.8.S3');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// CLASIFICACIÓN DE ERRORES
// ═══════════════════════════════════════════════════════════════

describe('clasificación de errores', () => {
  it('distingue las familias que el motor trata de forma distinta', () => {
    expect(classify('Invalid API signature')).toBe('AUTH');
    expect(classify('Insufficient margin available')).toBe('INSUFFICIENT_FUNDS');
    expect(classify('Order notional below min_notional')).toBe('RULES');
    expect(classify('ETIMEDOUT')).toBe('RETRYABLE');
    expect(classify('429 Too Many Requests')).toBe('RETRYABLE');
    expect(classify('algo raro que nadie ha visto')).toBe('FATAL');
  });

  it('un rechazo de post-only cuenta como error de reglas, no como fallo grave', () => {
    expect(classify('Post only order would immediately match')).toBe('RULES');
  });

  it('extrae el mensaje del cuerpo de una respuesta HTTP', () => {
    const err = Object.assign(new Error('Request failed'), {
      response: { data: { code: -2019, msg: 'Margin is insufficient' } },
    });
    expect(messageOf(err)).toContain('Margin is insufficient');
    expect(classify(err)).toBe('INSUFFICIENT_FUNDS');
  });

  it('cae al estado HTTP cuando el rechazo no trae cuerpo', () => {
    // Es el caso real de Lighter: el borde (CloudFront) corta la peticion con
    // un 403 y Content-Length 0, asi que no hay cuerpo del que sacar el
    // motivo. Sin esto llegaba a la pantalla como «ERR_BAD_REQUEST: Request
    // failed with status code 403».
    const sinCuerpo = Object.assign(new Error('Request failed with status code 403'), {
      code: 'ERR_BAD_REQUEST',
      response: { status: 403, data: '' },
    });
    expect(messageOf(sinCuerpo)).toBe('HTTP 403');

    const cuerpoVacio = Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502, data: {} },
    });
    expect(messageOf(cuerpoVacio)).toBe('HTTP 502');
    // Y el estado sigue clasificando: un 502 es transitorio y se reintenta.
    expect(classify(cuerpoVacio)).toBe('RETRYABLE');
  });

  it('no vuelve a envolver un ExchangeError que ya venía clasificado', () => {
    const original = new ExchangeError('AUTH', 'clave revocada');
    expect(toExchangeError(original)).toBe(original);
  });

  it('solo son reintentables los errores transitorios', () => {
    expect(isRetryable(new ExchangeError('RETRYABLE', 'timeout'))).toBe(true);
    expect(isRetryable(new ExchangeError('RULES', 'tick size'))).toBe(false);
    expect(isRetryable(new ExchangeError('AUTH', 'clave mala'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// CAUDAL Y REINTENTOS
// ═══════════════════════════════════════════════════════════════

describe('RateLimiter', () => {
  it('preserva el orden de las llamadas', async () => {
    const limiter = new RateLimiter(1000);
    const orden: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        limiter.run(async () => {
          orden.push(n);
        }),
      ),
    );
    expect(orden).toEqual([1, 2, 3, 4]);
  });

  it('un fallo no rompe la cola para las llamadas siguientes', async () => {
    // Si la cola se rompiera, el adaptador dejaría de mandar órdenes en
    // silencio: el peor fallo posible en un motor de trading.
    const limiter = new RateLimiter(1000);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(() => Promise.resolve('sigue viva'))).resolves.toBe('sigue viva');
  });

  it('espacia las llamadas según el caudal configurado', async () => {
    const limiter = new RateLimiter(20); // 50 ms entre llamadas
    const start = Date.now();
    await limiter.run(async () => undefined);
    await limiter.run(async () => undefined);
    await limiter.run(async () => undefined);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });
});

describe('withRetry', () => {
  it('reintenta los errores transitorios hasta que uno sale bien', async () => {
    let intentos = 0;
    const result = await withRetry(
      async () => {
        intentos++;
        if (intentos < 3) throw new ExchangeError('RETRYABLE', 'timeout');
        return 'ok';
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(intentos).toBe(3);
  });

  it('NO reintenta un rechazo por reglas: el resultado no cambiaría', async () => {
    let intentos = 0;
    await expect(
      withRetry(
        async () => {
          intentos++;
          throw new ExchangeError('RULES', 'min notional');
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow('min notional');
    expect(intentos).toBe(1);
  });

  it('se rinde tras agotar los intentos y propaga el error clasificado', async () => {
    let intentos = 0;
    await expect(
      withRetry(
        async () => {
          intentos++;
          throw new Error('ECONNRESET');
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toBeInstanceOf(ExchangeError);
    expect(intentos).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// CACHÉ DE MERCADOS
// ═══════════════════════════════════════════════════════════════

describe('MarketSpecCache', () => {
  const spec = (symbol: string): MarketSpec => ({
    venue: Venue.HYPERLIQUID,
    symbol,
    canonical: symbol + '/USDC',
    base: symbol,
    quote: 'USDC',
    tickSize: '0.1',
    stepSize: '0.001',
    minNotional: '10',
    minQty: null,
    maxQty: null,
    maxLeverage: 20,
    priceDecimals: 1,
    qtyDecimals: 3,
    active: true,
  });

  it('colapsa las peticiones simultáneas en una sola llamada', async () => {
    // Al arrancar, veinte bots del mismo venue piden la spec a la vez.
    let llamadas = 0;
    const cache = new MarketSpecCache(async () => {
      llamadas++;
      return [spec('BTC')];
    });
    await Promise.all([cache.all(), cache.all(), cache.all()]);
    expect(llamadas).toBe(1);
  });

  it('sirve de caché mientras no expire el TTL', async () => {
    let llamadas = 0;
    const cache = new MarketSpecCache(async () => {
      llamadas++;
      return [spec('BTC')];
    }, 60_000);
    await cache.all();
    await cache.all();
    expect(llamadas).toBe(1);
  });

  it('refresca cuando le piden un símbolo que no conoce', async () => {
    let llamadas = 0;
    const cache = new MarketSpecCache(async () => {
      llamadas++;
      return llamadas === 1 ? [spec('BTC')] : [spec('BTC'), spec('ETH')];
    });
    await cache.all();
    await expect(cache.get('ETH')).resolves.toMatchObject({ symbol: 'ETH' });
    expect(llamadas).toBe(2);
  });

  it('falla claro si el mercado sigue sin existir tras refrescar', async () => {
    const cache = new MarketSpecCache(async () => [spec('BTC')]);
    await expect(cache.get('DOGE')).rejects.toThrow('Mercado desconocido');
  });
});

describe('utilidades de precisión', () => {
  it('deduce los decimales del tamaño de paso', () => {
    expect(decimalsOf('0.001')).toBe(3);
    expect(decimalsOf('1')).toBe(0);
    expect(decimalsOf('0.00001')).toBe(5);
  });

  it('el tick de Hyperliquid depende de la magnitud del precio', () => {
    // 5 cifras significativas: a 100.000 el paso es 10; a 3.000, 0,1.
    expect(hyperliquidTickSize(D(100000), 5).toNumber()).toBe(10);
    expect(hyperliquidTickSize(D(3000), 4).toNumber()).toBeCloseTo(0.1, 10);
    // Pero nunca por debajo del tope de decimales (6 − szDecimals).
    expect(hyperliquidTickSize(D(0.0001), 0).toNumber()).toBeCloseTo(1e-6, 12);
  });

  it('Lighter escala a entero truncando, nunca redondeando hacia arriba', () => {
    expect(scaled('1.23456', 4)).toBe(12345);
    expect(scaled('100.5', 2)).toBe(10050);
  });
});

// ═══════════════════════════════════════════════════════════════
// SIMULADOR
// ═══════════════════════════════════════════════════════════════

/** Fuente de precios controlada, para poder mover el mercado a voluntad. */
class StubSource implements ExchangeAdapter {
  readonly venue = Venue.HYPERLIQUID;
  readonly ticker$ = new Subject<Ticker>();
  current: Ticker = {
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    last: '100',
    bid: '99.9',
    ask: '100.1',
    mark: '100',
    ts: 0,
  };

  move(bid: string, ask: string): void {
    this.current = { ...this.current, bid, ask, mark: bid, last: bid };
    this.ticker$.next(this.current);
  }

  readonly capabilities = capabilitiesOf(Venue.HYPERLIQUID, ['1m', '1h'], 500, true, HIST);

  verify = async () => ({ ok: true, publicRef: 'stub' });
  getMarkets = async (): Promise<MarketSpec[]> => [];
  getTickers = async (): Promise<MarketTicker[]> => [];
  getCandles = async (): Promise<Candle[]> => [];
  getBalances = async (): Promise<Balance[]> => [];
  getPositions = async (): Promise<Position[]> => [];
  getOpenOrders = async (): Promise<VenueOrder[]> => [];
  getTicker = async (): Promise<Ticker> => this.current;
  placeOrder = async (): Promise<OrderAck> => {
    throw new Error('la fuente no debe recibir órdenes en dry-run');
  };
  getRecentFills = async (): Promise<Fill[]> => [];
  cancelOrder = async () => undefined;
  cancelOwn = async () => undefined;
  cancelAll = async () => undefined;
  setLeverage = async () => undefined;
  streamOrders = (): Observable<never> => new Subject<never>().asObservable();
  streamFills = (): Observable<never> => new Subject<never>().asObservable();
  streamTicker = (): Observable<Ticker> => this.ticker$.asObservable();
  streamHealth = (): Observable<StreamHealth> => new Subject<StreamHealth>().asObservable();
  close = async () => undefined;
}

describe('DryRunAdapter', () => {
  const order = (over: Partial<Parameters<DryRunAdapter['placeOrder']>[0]> = {}) => ({
    symbol: 'BTC',
    side: 'BUY' as const,
    type: 'LIMIT' as const,
    price: '95',
    qty: '1',
    clientOrderId: 'coid-1',
    reduceOnly: false,
    ...over,
  });

  it('nunca manda nada al venue real', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    // Si delegara, StubSource.placeOrder lanzaría.
    await expect(sim.placeOrder(order())).resolves.toMatchObject({ status: 'OPEN' });
  });

  describe('reloj y semilla inyectables', () => {
    it('sin opciones, el comportamiento es el de siempre', async () => {
      // La red que protege al modo simulación de verdad: los dos parámetros son
      // para el backtest y no deben cambiar nada de lo que ya funcionaba.
      const antes = Date.now();
      const sim = new DryRunAdapter(new StubSource());
      await sim.getTicker('BTC');
      const ack = await sim.placeOrder(order());

      expect(ack.ts).toBeGreaterThanOrEqual(antes);
      expect(ack.ts).toBeLessThanOrEqual(Date.now());
    });

    it('con reloj propio, las marcas de tiempo son las de la simulación', async () => {
      // Con el reloj de pared, la edad de una cotización —`ctx.now - createdAt`—
      // salía negativa y enorme al reproducir un rango de hace tres meses, y
      // todo lo que caduca órdenes por antigüedad se volvía loco.
      const AYER = 1_600_000_000_000;
      const sim = new DryRunAdapter(new StubSource(), { now: () => AYER });
      await sim.getTicker('BTC');

      const ack = await sim.placeOrder(order());
      expect(ack.ts).toBe(AYER);
      expect((await sim.getOpenOrders())[0].createdAt).toBe(AYER);
    });

    it('el reloj llega también a las ejecuciones', async () => {
      const AYER = 1_600_000_000_000;
      const source = new StubSource();
      const sim = new DryRunAdapter(source, { now: () => AYER });
      await sim.getTicker('BTC');
      await sim.placeOrder(order());

      source.move('89', '90');
      await sim.getTicker('BTC');

      const fills = await sim.getRecentFills('BTC', 0);
      expect(fills).toHaveLength(1);
      expect(fills[0].ts).toBe(AYER);
    });

    it('con la misma semilla, dos ejecuciones producen los mismos ids', async () => {
      // Es lo que hace posible el test de «el mismo rango da el mismo
      // resultado», que es la propiedad que hace útil comparar configuraciones.
      const correr = async () => {
        const source = new StubSource();
        const sim = new DryRunAdapter(source, { runId: 'fijo' });
        await sim.getTicker('BTC');
        await sim.placeOrder(order());
        source.move('89', '90');
        await sim.getTicker('BTC');
        return (await sim.getRecentFills('BTC', 0)).map((f) => f.venueFillId);
      };

      expect(await correr()).toEqual(await correr());
    });
  });

  it('una limit se queda en reposo y no toca la posición', async () => {
    const sim = new DryRunAdapter(new StubSource());
    await sim.getTicker('BTC');
    await sim.placeOrder(order());
    expect(await sim.getOpenOrders()).toHaveLength(1);
    expect(await sim.getPositions()).toHaveLength(0);
  });

  it('la compra se ejecuta cuando el ask baja hasta su precio', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.placeOrder(order({ price: '95' }));

    source.current = { ...source.current, bid: '94.9', ask: '95' };
    await sim.getTicker('BTC');

    expect(await sim.getOpenOrders()).toHaveLength(0);
    const [pos] = await sim.getPositions();
    // Se llena a SU precio limit, nunca mejor.
    expect(pos.entryPrice).toBe('95');
    expect(pos.qty).toBe('1');
  });

  it('promedia la entrada al acumular en el mismo sentido', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.placeOrder(order({ price: '100', qty: '1', clientOrderId: 'a' }));
    source.current = { ...source.current, bid: '99', ask: '99.5' };
    await sim.getTicker('BTC');

    await sim.placeOrder(order({ price: '90', qty: '1', clientOrderId: 'b' }));
    source.current = { ...source.current, bid: '89', ask: '90' };
    await sim.getTicker('BTC');

    const [pos] = await sim.getPositions();
    expect(pos.qty).toBe('2');
    expect(Number(pos.entryPrice)).toBeCloseTo(95, 8);
  });

  it('realiza el PnL al cerrar contra el precio medio', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source, { makerFeeRate: '0', takerFeeRate: '0' });
    await sim.getTicker('BTC');

    await sim.placeOrder(order({ price: '100', qty: '1', clientOrderId: 'a' }));
    source.current = { ...source.current, bid: '99', ask: '100' };
    await sim.getTicker('BTC');

    await sim.placeOrder(
      order({ side: 'SELL', price: '110', qty: '1', clientOrderId: 'b', reduceOnly: true }),
    );
    source.current = { ...source.current, bid: '110', ask: '110.5' };
    await sim.getTicker('BTC');

    expect(await sim.getPositions()).toHaveLength(0);
    expect(Number(sim.stats().realizedPnl)).toBeCloseTo(10, 8);
  });

  it('rechaza una post-only que cruzaría el libro, igual que el venue real', async () => {
    const sim = new DryRunAdapter(new StubSource());
    await sim.getTicker('BTC');
    // El ask está en 100,1: una compra post-only a 101 cruzaría.
    await expect(sim.placeOrder(order({ type: 'POST_ONLY', price: '101' }))).rejects.toThrow(
      'cruzaría el libro',
    );
  });

  it('la orden a mercado paga taker y se lleva el deslizamiento en contra', async () => {
    const sim = new DryRunAdapter(new StubSource(), {
      takerFeeRate: '0.001',
      slippageRate: '0.01',
    });
    await sim.getTicker('BTC');
    await sim.placeOrder(order({ type: 'MARKET', price: undefined, qty: '1' }));

    const [pos] = await sim.getPositions();
    // ask 100,1 con un 1 % de deslizamiento en contra.
    expect(Number(pos.entryPrice)).toBeCloseTo(101.101, 6);
    expect(Number(sim.stats().feesPaid)).toBeGreaterThan(0);
  });

  it('cancelar retira la orden del libro simulado', async () => {
    const sim = new DryRunAdapter(new StubSource());
    await sim.getTicker('BTC');
    await sim.placeOrder(order({ clientOrderId: 'x' }));
    await sim.cancelOrder({ symbol: 'BTC', clientOrderId: 'x' });
    expect(await sim.getOpenOrders()).toHaveLength(0);
  });

  it('emite fill y actualización de orden al ejecutarse', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');

    const fills: unknown[] = [];
    sim.streamFills().subscribe((f) => fills.push(f));

    await sim.placeOrder(order({ price: '95' }));
    source.current = { ...source.current, bid: '94', ask: '95' };
    await sim.getTicker('BTC');

    expect(fills).toHaveLength(1);
  });

  // ── Órdenes condicionales (001/F-45, corregido en el spec 004) ──
  // El motor manda el stop-loss como MARKET con `triggerPrice` y los tres
  // adaptadores reales lo traducen a la orden condicional del venue. El
  // simulador lo ejecutaba EN EL ACTO como orden a mercado: toda posición con
  // stop se cerraba nada más abrirse, en simulación y en backtest.

  describe('órdenes condicionales', () => {
    /** Posición larga de 1 BTC abierta a mercado, sin comisiones ni deslizamiento. */
    const conLargo = async (opts: { slippageRate?: string; leverage?: number } = {}) => {
      const source = new StubSource();
      const sim = new DryRunAdapter(source, {
        makerFeeRate: '0',
        takerFeeRate: '0',
        slippageRate: opts.slippageRate ?? '0',
      });
      await sim.getTicker('BTC');
      if (opts.leverage) await sim.setLeverage('BTC', opts.leverage, 'ISOLATED');
      await sim.placeOrder(order({ type: 'MARKET', clientOrderId: 'entrada' }));
      return { source, sim };
    };

    /** Mueve el mercado y deja que el simulador lo vea: casa en `getTicker`, como en los demás tests. */
    const mover = async (sim: DryRunAdapter, source: StubSource, bid: string, ask: string) => {
      source.move(bid, ask);
      await sim.getTicker('BTC');
    };

    /** El stop tal y como lo emite `withStopLoss` más el `intent` que añade el motor. */
    const stop = (over: Partial<Parameters<DryRunAdapter['placeOrder']>[0]> = {}) =>
      order({
        type: 'MARKET',
        side: 'SELL',
        price: '90',
        triggerPrice: '90',
        qty: '1',
        reduceOnly: true,
        intent: 'SL',
        clientOrderId: 'sl',
        ...over,
      });

    it('un stop se queda en reposo: la posición sigue abierta y la orden espera', async () => {
      const { sim } = await conLargo();
      const ack = await sim.placeOrder(stop());
      expect(ack.status).toBe(OrderStatus.OPEN);
      expect(await sim.getPositions()).toHaveLength(1);
      expect(await sim.getOpenOrders()).toHaveLength(1);
    });

    it('se dispara cuando el precio de marca cruza el disparador: a mercado, taker y con deslizamiento', async () => {
      const { source, sim } = await conLargo({ slippageRate: '0.001' });
      const fills: Fill[] = [];
      sim.streamFills().subscribe((f) => fills.push(f));
      await sim.placeOrder(stop());

      await mover(sim, source, '95', '95.2');
      expect(await sim.getPositions()).toHaveLength(1);

      await mover(sim, source, '89', '89.2');
      expect(await sim.getPositions()).toHaveLength(0);
      expect(await sim.getOpenOrders()).toHaveLength(0);
      expect(fills).toHaveLength(1);
      expect(fills[0].isTaker).toBe(true);
      // Al precio del DISPARADOR con el deslizamiento en contra —el mismo
      // supuesto de camino continuo con el que las limit se llenan a su precio—,
      // no al bid del tick, que con el paso de vela del backtest puede estar muy
      // por debajo.
      expect(fills[0].price).toBe('89.91');
    });

    it('sin intención declarada, el sentido sale del precio de marca al colocarla', async () => {
      const { source, sim } = await conLargo();
      await sim.placeOrder(stop({ intent: undefined }));
      // Por encima del disparador no pasa nada: una venta con el disparador por
      // debajo de la marca es un stop, no un take-profit.
      await mover(sim, source, '105', '105.2');
      expect(await sim.getOpenOrders()).toHaveLength(1);
      await mover(sim, source, '89.5', '89.7');
      expect(await sim.getOpenOrders()).toHaveLength(0);
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('un take-profit condicional se dispara al alza y no a la baja', async () => {
      const { source, sim } = await conLargo();
      await sim.placeOrder(
        stop({ intent: 'TP', price: '110', triggerPrice: '110', clientOrderId: 'tp' }),
      );
      await mover(sim, source, '95', '95.2');
      expect(await sim.getOpenOrders()).toHaveLength(1);
      await mover(sim, source, '111', '111.2');
      expect(await sim.getOpenOrders()).toHaveLength(0);
      expect(sim.stats().realizedPnl).toBe(D('110').minus('100.1').toFixed());
    });

    it('un take profit que SIGUE al precio dispara a la BAJA, aunque esté muy arriba', async () => {
      // El caso del spec 042. La posición entró a ~100 y el precio ha subido a
      // 125; el seguimiento pone su disparador en 123,75, o sea MUY por encima
      // de la entrada. Si llegara etiquetado como take-profit, la condición
      // «marca >= 123,75» sería cierta al colocarlo y el venue cerraría la
      // posición al instante: el fallo 001/F-80.
      //
      // Por eso el `intent` viaja explícito y vale más que el `levelKind`: en
      // la contabilidad es un objetivo de beneficio y en el disparo es un stop.
      const { source, sim } = await conLargo();
      await mover(sim, source, '125', '125.2');

      await sim.placeOrder(stop({ price: '123.75', triggerPrice: '123.75', clientOrderId: 'ttp' }));
      // No se ha cerrado nada: sigue esperando el retroceso.
      expect(await sim.getOpenOrders()).toHaveLength(1);
      expect(await sim.getPositions()).toHaveLength(1);

      // Sube más: el disparador no le afecta.
      await mover(sim, source, '130', '130.2');
      expect(await sim.getOpenOrders()).toHaveLength(1);

      // Y retrocede: ahí sí.
      await mover(sim, source, '123', '123.2');
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('y la misma orden etiquetada como TP se ejecutaría en el acto', async () => {
      // El contraejemplo, para que quede escrito por qué existe el campo.
      const { source, sim } = await conLargo();
      await mover(sim, source, '125', '125.2');
      await sim.placeOrder(
        stop({ intent: 'TP', price: '123.75', triggerPrice: '123.75', clientOrderId: 'mal' }),
      );
      await mover(sim, source, '125.1', '125.3');
      expect(await sim.getPositions()).toHaveLength(0);
    });

    it('el stop se dispara antes que la liquidación cuando está por encima de ella', async () => {
      // A 10× la liquidación de una entrada a 100,1 ronda 90,6; el stop a 95
      // tiene que cerrar la posición ANTES aunque el tick baje de golpe a 80.
      const { source, sim } = await conLargo({ leverage: 10 });
      const fills: Fill[] = [];
      sim.streamFills().subscribe((f) => fills.push(f));
      await sim.placeOrder(stop({ price: '95', triggerPrice: '95' }));
      await mover(sim, source, '80', '80.2');
      expect(fills).toHaveLength(1);
      expect(fills[0].liquidation).toBeUndefined();
      expect(fills[0].price).toBe('95');
      expect(sim.stats().realizedPnl).toBe(D('95').minus('100.1').toFixed());
    });

    it('un stop por DEBAJO de la liquidación no salva nada: liquida el venue', async () => {
      const { source, sim } = await conLargo({ leverage: 10 });
      const fills: Fill[] = [];
      sim.streamFills().subscribe((f) => fills.push(f));
      await sim.placeOrder(stop({ price: '85', triggerPrice: '85' }));
      await mover(sim, source, '80', '80.2');
      expect(fills).toHaveLength(1);
      expect(fills[0].liquidation).toBe(true);
      expect(await sim.getOpenOrders()).toHaveLength(0);
    });

    it('sobrevive al guardado del estado: al importarlo sigue esperando su disparo', async () => {
      const { source, sim } = await conLargo();
      await sim.placeOrder(stop());
      const otro = new DryRunAdapter(source, {
        takerFeeRate: '0',
        slippageRate: '0',
        initialState: sim.exportState(),
      });
      await otro.getTicker('BTC');
      expect(await otro.getOpenOrders()).toHaveLength(1);
      expect(await otro.getPositions()).toHaveLength(1);
      await mover(otro, source, '89', '89.2');
      expect(await otro.getPositions()).toHaveLength(0);
    });

    it('cancelar una condicional la retira, como a cualquier otra', async () => {
      const { source, sim } = await conLargo();
      await sim.placeOrder(stop());
      await sim.cancelOrder({ symbol: 'BTC', clientOrderId: 'sl' });
      await mover(sim, source, '89', '89.2');
      expect(await sim.getPositions()).toHaveLength(1);
    });
  });

  // ── Ajuste de margen ─────────────────────────────────────────
  // El simulador existe para probar el comportamiento ANTES de arriesgar
  // dinero, asi que un aporte que aqui no moviera nada enseñaria lo contrario
  // de lo que va a pasar en el venue.

  /** Posicion larga de 1 BTC a 95, con el apalancamiento dado. */
  const conPosicion = async (leverage = 5) => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', leverage, 'ISOLATED');
    await sim.placeOrder(order({ price: '95' }));
    source.current = { ...source.current, bid: '94.9', ask: '95' };
    await sim.getTicker('BTC');
    return sim;
  };

  it('aportar margen sube el margen usado y BAJA el apalancamiento efectivo', async () => {
    const sim = await conPosicion(5);
    const [antes] = await sim.getPositions();
    // 1 BTC a 95 con 5x = 19 de margen.
    expect(Number(antes.marginUsed)).toBeCloseTo(19, 8);
    expect(antes.leverage).toBeCloseTo(5, 8);

    await sim.adjustIsolatedMargin('BTC', '19', 'ADD', 'LONG');

    const [despues] = await sim.getPositions();
    expect(Number(despues.marginUsed)).toBeCloseTo(38, 8);
    // Es lo que hace que la liquidacion estimada se aleje: quien la calcula
    // rio abajo solo mira el apalancamiento.
    expect(despues.leverage).toBeCloseTo(2.5, 8);
  });

  it('el margen aportado sale del saldo disponible', async () => {
    const sim = await conPosicion(5);
    const [antes] = await sim.getBalances();
    await sim.adjustIsolatedMargin('BTC', '10', 'ADD', 'LONG');
    const [despues] = await sim.getBalances();

    expect(Number(antes.available) - Number(despues.available)).toBeCloseTo(10, 8);
    expect(Number(despues.used) - Number(antes.used)).toBeCloseTo(10, 8);
  });

  it('retirar devuelve lo aportado y deja la posicion como estaba', async () => {
    const sim = await conPosicion(5);
    await sim.adjustIsolatedMargin('BTC', '10', 'ADD', 'LONG');
    await sim.adjustIsolatedMargin('BTC', '10', 'REMOVE', 'LONG');

    const [pos] = await sim.getPositions();
    expect(Number(pos.marginUsed)).toBeCloseTo(19, 8);
    expect(pos.leverage).toBeCloseTo(5, 8);
  });

  it('no deja retirar mas de lo aportado a mano', async () => {
    const sim = await conPosicion(5);
    await sim.adjustIsolatedMargin('BTC', '5', 'ADD', 'LONG');
    // Por debajo de eso se estaria comiendo el margen que exige el
    // apalancamiento, y ahi el venue real rechaza.
    await expect(sim.adjustIsolatedMargin('BTC', '6', 'REMOVE', 'LONG')).rejects.toThrow(
      /Solo puedes retirar/i,
    );
  });

  it('sin posicion abierta no hay caja que financiar', async () => {
    const sim = new DryRunAdapter(new StubSource());
    await sim.getTicker('BTC');
    await expect(sim.adjustIsolatedMargin('BTC', '10', 'ADD', 'LONG')).rejects.toThrow(
      /No hay posición abierta/i,
    );
  });

  it('en margen cruzado la operacion no existe', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 5, 'CROSS');
    await sim.placeOrder(order({ price: '95' }));
    source.current = { ...source.current, bid: '94.9', ask: '95' };
    await sim.getTicker('BTC');

    await expect(sim.adjustIsolatedMargin('BTC', '10', 'ADD', 'LONG')).rejects.toThrow(
      /solo existe en modo aislado/i,
    );
  });

  // -- Estado persistible --------------------------------------------
  //
  // Sin esto la simulacion vivia SOLO en memoria: reiniciar el worker devolvia
  // el saldo al de partida y borraba las posiciones, mientras las ordenes y las
  // ejecuciones seguian en la base. El bot quedaba discutiendo con su propio
  // libro justo cuando el usuario estaba decidiendo si operar de verdad.

  it('exportar e importar reproduce posicion, ordenes en reposo y contabilidad', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 5, 'ISOLATED');

    await sim.placeOrder(order({ price: '95', clientOrderId: 'llena' }));
    source.current = { ...source.current, bid: '94.9', ask: '95' };
    await sim.getTicker('BTC');
    await sim.placeOrder(order({ price: '80', clientOrderId: 'reposo' }));
    await sim.adjustIsolatedMargin('BTC', '25', 'ADD', 'LONG');

    const state = sim.exportState();
    // El viaje real es por JSON: si algo no sobrevive a la serializacion, el
    // reinicio del worker tampoco lo recuperaria.
    const revivido = new DryRunAdapter(new StubSource(), {
      initialState: JSON.parse(JSON.stringify(state)) as typeof state,
    });

    const [antes] = await sim.getPositions();
    const [despues] = await revivido.getPositions();
    expect(despues.qty).toBe(antes.qty);
    expect(despues.entryPrice).toBe(antes.entryPrice);
    expect(despues.marginUsed).toBe(antes.marginUsed);
    expect(despues.leverage).toBe(antes.leverage);

    const abiertas = await revivido.getOpenOrders();
    expect(abiertas).toHaveLength(1);
    expect(abiertas[0].clientOrderId).toBe((await sim.getOpenOrders())[0].clientOrderId);
    expect((await revivido.getBalances())[0].total).toBe((await sim.getBalances())[0].total);
  });

  it('el simulador revivido sigue numerando ids donde lo dejo', async () => {
    // Los ids de ejecucion son unicos en la base. Reiniciando el contador, la
    // primera ejecucion despues de un reinicio chocaria con una ya guardada y
    // se descartaria en silencio, dejando mal la contabilidad del bot.
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.placeOrder(order({ type: 'MARKET', clientOrderId: 'm1' }));

    const revivido = new DryRunAdapter(new StubSource(), { initialState: sim.exportState() });
    await revivido.getTicker('BTC');
    await revivido.placeOrder(order({ type: 'MARKET', clientOrderId: 'm2' }));

    const [fill] = await revivido.getRecentFills('BTC', 0);
    expect(fill.venueOrderId).not.toBe('sim-1');
  });

  it('avisa de cada cambio de estado para que quien lo guarda no lo pierda', async () => {
    const cambios = jest.fn();
    const source = new StubSource();
    const sim = new DryRunAdapter(source, { onStateChange: cambios });
    await sim.getTicker('BTC');

    await sim.placeOrder(order({ price: '95' }));
    expect(cambios).toHaveBeenCalled();

    cambios.mockClear();
    source.current = { ...source.current, bid: '94.9', ask: '95' };
    await sim.getTicker('BTC');
    // La ejecucion tambien avisa: es el cambio que mas duele perder.
    expect(cambios).toHaveBeenCalled();
  });

  // -- Liquidacion ---------------------------------------------------
  //
  // Era la mentira mas cara del simulador: sin liquidacion, una martingala
  // apalancada SIEMPRE acababa ganando, porque la unica forma real de perderlo
  // todo -que el venue te cierre- no estaba modelada.

  it('informa del precio de liquidacion en vez de dejarlo vacio', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'ISOLATED');
    await sim.placeOrder(order({ price: '100', qty: '1' }));
    source.move('99', '100');
    await sim.getTicker('BTC');

    const [pos] = await sim.getPositions();
    // 100 x (1 - 1/10 + 0,005)
    expect(Number(pos.liquidationPrice)).toBeCloseTo(90.5, 6);
  });

  it('liquida la posicion cuando la marca cruza su precio de liquidacion', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'ISOLATED');
    await sim.placeOrder(order({ price: '100', qty: '1', clientOrderId: 'entrada' }));
    source.move('99', '100');
    await sim.getTicker('BTC');
    await sim.placeOrder(order({ price: '85', qty: '1', clientOrderId: 'refuerzo' }));

    source.move('90', '90.4');
    await sim.getTicker('BTC');

    expect(await sim.getPositions()).toHaveLength(0);
    // La escalera muere con la posicion: el venue deja la cuenta plana, no a
    // medio camino con las ordenes todavia puestas.
    expect(await sim.getOpenOrders()).toHaveLength(0);
    expect(Number(sim.stats().realizedPnl)).toBeLessThan(-9);
  });

  it('el margen aportado a mano aleja la liquidacion, como en el venue', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'ISOLATED');
    await sim.placeOrder(order({ price: '100', qty: '1' }));
    source.move('99', '100');
    await sim.getTicker('BTC');

    const [sinAporte] = await sim.getPositions();
    await sim.adjustIsolatedMargin('BTC', '10', 'ADD', 'LONG');
    const [conAporte] = await sim.getPositions();

    expect(Number(conAporte.liquidationPrice)).toBeLessThan(Number(sinAporte.liquidationPrice));

    // Y de verdad defiende: al precio que antes liquidaba, ahora aguanta.
    source.move('90', '90.4');
    await sim.getTicker('BTC');
    expect(await sim.getPositions()).toHaveLength(1);
  });

  it('liquidar no cobra dos veces el margen aportado a mano', async () => {
    // El precio de liquidacion sale del apalancamiento EFECTIVO, que ya incluye
    // el aporte: cerrar ahi realiza la caja entera de la posicion. Restar
    // ademas `extraMargin` la cobraba dos veces, y solo se veia con un aporte
    // de por medio — que es justo lo que el unico test de liquidacion no tenia.
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'ISOLATED');
    await sim.placeOrder(order({ price: '100', qty: '1' }));
    source.move('99', '100');
    await sim.getTicker('BTC');
    await sim.adjustIsolatedMargin('BTC', '10', 'ADD', 'LONG');

    const [pos] = await sim.getPositions();
    const liq = Number(pos.liquidationPrice);
    // 100 x (1 - 20/100 + 0,005): con 20 de caja sobre 100 de notional.
    expect(liq).toBeCloseTo(80.5, 6);

    const antes = Number(sim.stats().realizedPnl);
    source.move(String(liq - 1), String(liq - 0.9));
    await sim.getTicker('BTC');
    expect(await sim.getPositions()).toHaveLength(0);

    // Pierde la caja de la posicion (20) menos el colchon de mantenimiento
    // (0,5), mas la comision del cierre forzoso. Ni un centimo mas.
    const perdida = antes - Number(sim.stats().realizedPnl);
    expect(perdida).toBeGreaterThan(19.5);
    expect(perdida).toBeLessThan(19.6);
  });

  it('una posicion CRUZADA la respalda la cuenta entera, no su margen inicial', async () => {
    // CRUZADO es el modo por defecto de varias estrategias —la rejilla neutral,
    // sin ir mas lejos—. Tratandolo como aislado, una posicion de 100 sobre una
    // cuenta de 10.000 reventaba con una caida del 10 %, que en un venue real ni
    // se nota. Era el modo por defecto simulando el peor caso posible.
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'CROSS');
    await sim.placeOrder(order({ price: '100', qty: '1' }));
    source.move('99', '100');
    await sim.getTicker('BTC');

    // Con 10.000 detras de 100 de notional no hay liquidacion que dar.
    const [pos] = await sim.getPositions();
    expect(pos.liquidationPrice).toBeNull();

    // Y no revienta donde reventaria una aislada del mismo apalancamiento.
    source.move('85', '85.1');
    await sim.getTicker('BTC');
    expect(await sim.getPositions()).toHaveLength(1);
  });

  it('en CRUZADO lo inmovilizado por las aisladas no defiende a nadie mas', async () => {
    // La caja de una cruzada es la cuenta MENOS lo que las aisladas tienen
    // pillado. Sin descontarlo, el mismo dinero defenderia dos posiciones a la
    // vez y las dos parecerian mas seguras de lo que estan.
    //
    // Saldo 80 y no 10.000 a proposito: con caja de sobra la cruzada no se
    // liquida NUNCA y la comprobacion no distinguiria nada.
    const source = new StubSource();
    const sim = new DryRunAdapter(source, { startingBalance: '80' });
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'CROSS');
    await sim.placeOrder(order({ price: '100', qty: '1' }));
    source.move('99', '100');
    await sim.getTicker('BTC');

    // Caja 80 sobre 100 de notional: 100 x (1 - 80/100 + 0,005).
    const [sola] = await sim.getPositions();
    expect(Number(sola.liquidationPrice)).toBeCloseTo(20.5, 1);

    // Una aislada en otro simbolo se lleva 50 del saldo comun.
    await sim.setLeverage('ETH', 2, 'ISOLATED');
    await sim.placeOrder(order({ symbol: 'ETH', price: '100', qty: '1', clientOrderId: 'eth' }));
    source.current = { ...source.current, symbol: 'ETH', bid: '99', ask: '100' };
    await sim.getTicker('ETH');

    // A la cruzada le quedan ~30: 100 x (1 - 30/100 + 0,005).
    const btc = (await sim.getPositions('BTC'))[0];
    expect(Number(btc.liquidationPrice)).toBeCloseTo(70.5, 0);
  });

  it('dos cruzadas se REPARTEN la caja, no la tienen entera cada una', async () => {
    // Acreditandole la cuenta entera a cada una, ninguna se liquidaba hasta
    // perderla al completo: entre las dos, el simulador podia realizar el doble
    // del saldo que habia.
    const source = new StubSource();
    const sim = new DryRunAdapter(source, { startingBalance: '80' });
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'CROSS');
    await sim.placeOrder(order({ price: '100', qty: '1' }));
    source.move('99', '100');
    await sim.getTicker('BTC');

    const [sola] = await sim.getPositions('BTC');
    expect(Number(sola.liquidationPrice)).toBeCloseTo(20.5, 1);

    // Una segunda cruzada del mismo tamaño se lleva la mitad de la caja.
    await sim.setLeverage('ETH', 10, 'CROSS');
    await sim.placeOrder(order({ symbol: 'ETH', price: '100', qty: '1', clientOrderId: 'eth' }));
    source.current = { ...source.current, symbol: 'ETH', bid: '99', ask: '100' };
    await sim.getTicker('ETH');

    // A cada una le tocan ~40 de los 80: 100 x (1 - 40/100 + 0,005).
    const btc = (await sim.getPositions('BTC'))[0];
    expect(Number(btc.liquidationPrice)).toBeCloseTo(60.5, 0);
  });

  it('la ejecucion de una liquidacion va MARCADA', async () => {
    // Sin la marca, el motor no puede reconocerla: no lleva el id de ninguna
    // orden suya y la descarta, dejando la perdida fuera de la contabilidad.
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'ISOLATED');
    await sim.placeOrder(order({ price: '100', qty: '1' }));
    source.move('99', '100');
    await sim.getTicker('BTC');
    source.move('90', '90.4');
    await sim.getTicker('BTC');

    const fills = await sim.getRecentFills('BTC', 0);
    const liq = fills.at(-1);
    expect(liq?.liquidation).toBe(true);
    // Y las ordinarias siguen sin llevarla: es lo que separa un cierre forzoso
    // de una ejecucion cualquiera.
    expect(fills[0].liquidation).toBeUndefined();
  });

  it('con `closeSource: false` no cierra una fuente que no es suya', async () => {
    // Es lo que permite que N bots simulados compartan UNA conexion al venue.
    // Sin esto, el primero en apagarse dejaba sin precios a los demas.
    const source = new StubSource();
    const cerrar = jest.spyOn(source, 'close');

    const compartido = new DryRunAdapter(source, { closeSource: false });
    await compartido.close();
    expect(cerrar).not.toHaveBeenCalled();

    // Y por defecto SI la cierra, que es lo que hacia y sigue haciendo quien la
    // construye para si solo.
    const propio = new DryRunAdapter(source);
    await propio.close();
    expect(cerrar).toHaveBeenCalled();
  });

  it('un corto se liquida al subir, no al bajar', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    await sim.getTicker('BTC');
    await sim.setLeverage('BTC', 10, 'ISOLATED');
    await sim.placeOrder(order({ side: 'SELL', price: '100', qty: '1' }));
    source.move('100', '100.1');
    await sim.getTicker('BTC');
    expect(await sim.getPositions()).toHaveLength(1);

    source.move('80', '80.1');
    await sim.getTicker('BTC');
    expect(await sim.getPositions()).toHaveLength(1);

    source.move('110', '110.1');
    await sim.getTicker('BTC');
    expect(await sim.getPositions()).toHaveLength(0);
  });
});

/**
 * Reconocer la liquidacion en lo que manda cada venue.
 *
 * Es lo unico que autoriza al motor a atribuir por SIMBOLO una ejecucion sin id
 * de orden nuestra, asi que un falso positivo le colgaria a un bot un
 * movimiento que no es suyo. Se prueba aparte por eso.
 */
describe('marcador de liquidacion por venue', () => {
  it('Hyperliquid la dice en `dir`', () => {
    expect(esLiquidacionHl({ dir: 'Liquidated Isolated Long' })).toBe(true);
    expect(esLiquidacionHl({ dir: 'Liquidated Cross Short' })).toBe(true);
  });

  it('y una ejecucion normal NO lo es', () => {
    for (const dir of ['Open Long', 'Close Short', 'Auto-Deleveraged Long']) {
      expect(esLiquidacionHl({ dir })).toBe(false);
    }
    // Ni un fill sin `dir` ninguno: el tipo del SDK no lo declara, asi que hay
    // que sobrevivir a que no venga.
    expect(esLiquidacionHl({})).toBe(false);
    expect(esLiquidacionHl({ dir: 42 })).toBe(false);
  });
});

describe('withWriteRetry', () => {
  const timeout = (): ExchangeError => new ExchangeError('RETRYABLE', 'timeout', Venue.HYPERLIQUID);

  it('devuelve a la primera cuando el envío funciona', async () => {
    const send = jest.fn().mockResolvedValue('ok');
    const verify = jest.fn().mockResolvedValue(null);

    await expect(withWriteRetry(send, verify)).resolves.toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  /**
   * El caso que motiva toda la función: el venue ACEPTÓ la orden y la respuesta
   * se perdió. Reenviar a ciegas —que es lo que hacía `withRetry`— provocaba un
   * rechazo por id duplicado, el error se clasificaba como fatal y la fila
   * quedaba marcada REJECTED con la orden viva en el libro.
   */
  it('no reenvía si la orden ya entró: devuelve lo que el venue ya tiene', async () => {
    const send = jest.fn().mockRejectedValue(timeout());
    const verify = jest.fn().mockResolvedValue('ya-estaba');

    await expect(withWriteRetry(send, verify, { baseDelayMs: 1 })).resolves.toBe('ya-estaba');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reenvía solo cuando el venue confirma que no la tiene', async () => {
    const send = jest.fn().mockRejectedValueOnce(timeout()).mockResolvedValue('ok');
    const verify = jest.fn().mockResolvedValue(null);

    await expect(withWriteRetry(send, verify, { baseDelayMs: 1 })).resolves.toBe('ok');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('no reintenta un rechazo por reglas: reenviarlo da el mismo resultado', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(new ExchangeError('RULES', 'min notional', Venue.HYPERLIQUID));
    const verify = jest.fn().mockResolvedValue(null);

    await expect(withWriteRetry(send, verify, { baseDelayMs: 1 })).rejects.toThrow('min notional');
    expect(send).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('MemoryVenueBudget', () => {
  it('concede mientras hay presupuesto', async () => {
    const budget = new MemoryVenueBudget({ ratePerSecond: { [Venue.HYPERLIQUID]: 100 } });
    const empezado = Date.now();

    for (let i = 0; i < 10; i++) await budget.take(Venue.HYPERLIQUID, 2, 'read', false);

    expect(Date.now() - empezado).toBeLessThan(100);
  });

  /**
   * La razón de ser de la reserva: una avalancha de lecturas —cientos de bots
   * latiendo a la vez— no puede dejar sin presupuesto a la cancelación de un
   * pánico. Las lecturas se pueden posponer; cerrar una posición, no.
   */
  it('reserva presupuesto para las escrituras', async () => {
    const budget = new MemoryVenueBudget({
      ratePerSecond: { [Venue.HYPERLIQUID]: 10 },
      burstSeconds: 1,
      writeReserve: 0.5,
    });

    // Las lecturas solo pueden bajar hasta el borde de la reserva (5 de 10).
    for (let i = 0; i < 5; i++) await budget.take(Venue.HYPERLIQUID, 1, 'read', false);

    // Y una escritura sigue entrando al instante, con el depósito "vacío" para
    // las lecturas.
    const empezado = Date.now();
    await budget.take(Venue.HYPERLIQUID, 1, 'write', false);
    expect(Date.now() - empezado).toBeLessThan(50);
  });

  it('hace esperar cuando el presupuesto se agota', async () => {
    const budget = new MemoryVenueBudget({
      ratePerSecond: { [Venue.HYPERLIQUID]: 20 },
      burstSeconds: 1,
      writeReserve: 0,
    });

    for (let i = 0; i < 20; i++) await budget.take(Venue.HYPERLIQUID, 1, 'read', false);

    const empezado = Date.now();
    await budget.take(Venue.HYPERLIQUID, 4, 'read', false);
    expect(Date.now() - empezado).toBeGreaterThanOrEqual(20);
  });

  /**
   * Spec 029. Un stop-loss competía de igual a igual con una recotización de un
   * market maker, que manda cuatro peticiones por capa y por tick: la orden que
   * sostiene la posición perdía por volumen contra la que solo mejora el precio.
   * La reserva de críticas es lo que le guarda sitio.
   */
  it('una orden crítica pasa cuando el depósito ya no da para una escritura normal', async () => {
    const budget = new MemoryVenueBudget({
      ratePerSecond: { [Venue.HYPERLIQUID]: 10 },
      burstSeconds: 1,
      criticalReserve: 0.5,
    });

    // Se vacía el depósito hasta dejarlo por debajo de la reserva de críticas.
    await budget.take(Venue.HYPERLIQUID, 6, 'critical', false);

    // Una escritura corriente ya no cabe: tiene que esperar.
    const antesWrite = Date.now();
    await budget.take(Venue.HYPERLIQUID, 1, 'write', false);
    expect(Date.now() - antesWrite).toBeGreaterThanOrEqual(20);

    // Y la crítica, con el depósito igual de seco, entra sin esperar.
    const budget2 = new MemoryVenueBudget({
      ratePerSecond: { [Venue.HYPERLIQUID]: 10 },
      burstSeconds: 1,
      criticalReserve: 0.5,
    });
    await budget2.take(Venue.HYPERLIQUID, 6, 'critical', false);
    const antesCrit = Date.now();
    await budget2.take(Venue.HYPERLIQUID, 1, 'critical', false);
    expect(Date.now() - antesCrit).toBeLessThan(20);
  });

  /**
   * Spec 001, F-24. Aster limita también las ÓRDENES (1200/min y 300/10 s) y el
   * presupuesto solo contaba peso: un market maker de varias capas podía pasarse
   * sin que nadie lo notara. El depósito de órdenes admite 85 de golpe (lo que
   * garantiza que ninguna ventana de diez segundos pase de 255) y luego 17/s.
   */
  it('las órdenes de Aster tienen su propio cupo: 85 de golpe y la siguiente espera', async () => {
    const budget = new MemoryVenueBudget();
    const empezado = Date.now();
    for (let i = 0; i < 85; i++) await budget.takeOrders(Venue.ASTER, 1, false);
    expect(Date.now() - empezado).toBeLessThan(200);

    const antes = Date.now();
    await budget.takeOrders(Venue.ASTER, 1, false);
    expect(Date.now() - antes).toBeGreaterThanOrEqual(20);

    // En los demás venues no hay cupo de órdenes: no espera nada.
    const hl = Date.now();
    for (let i = 0; i < 200; i++) await budget.takeOrders(Venue.HYPERLIQUID, 1, false);
    expect(Date.now() - hl).toBeLessThan(100);
  });

  /**
   * Spec 001, F-76. Lo que el venue dice haber contado (cabeceras de Aster)
   * recorta el depósito a lo que queda de verdad; nunca lo amplía.
   */
  it('lo que el venue dice haber contado recorta el depósito, nunca lo amplía', async () => {
    const opts = { ratePerSecond: { [Venue.ASTER]: 20 }, burstSeconds: 1, writeReserve: 0 };
    const agotado = new MemoryVenueBudget(opts);
    agotado.observe(Venue.ASTER, false, { usedWeightPerMinute: 2400 });
    const empezado = Date.now();
    await agotado.take(Venue.ASTER, 1, 'read', false);
    expect(Date.now() - empezado).toBeGreaterThanOrEqual(20);

    const libre = new MemoryVenueBudget(opts);
    libre.observe(Venue.ASTER, false, { usedWeightPerMinute: 0 });
    const antes = Date.now();
    for (let i = 0; i < 20; i++) await libre.take(Venue.ASTER, 1, 'read', false);
    expect(Date.now() - antes).toBeLessThan(100);
  });
});

describe('passthrough de ids ya codificados', () => {
  /**
   * El motor maneja ids en dos espacios: el canónico y el del venue. Al
   * cancelar una huérfana, el id llega en espacio de venue —el reconciliador
   * trabaja ahí— y volver a codificarlo producía un id que no correspondía a
   * NINGUNA orden: la cancelación fallaba en silencio y la orden vieja quedaba
   * viva. En un reemplazo, eso era exposición duplicada.
   */
  it('Hyperliquid no vuelve a hashear un cloid', () => {
    const cloid = hyperliquidCodec.encode('1a2b3c4d00000000.1.S3');
    expect(hyperliquidCodec.encode(cloid)).toBe(cloid);
  });

  it('Lighter no vuelve a hashear un índice numérico', () => {
    const index = lighterCodec.encodeNumeric!('1a2b3c4d00000000.1.S3');
    expect(lighterCodec.encodeNumeric!(String(index))).toBe(index);
  });

  it('un id canónico se sigue codificando normal', () => {
    expect(hyperliquidCodec.encode('1a2b3c4d00000000.1.S3')).toMatch(/^0x[0-9a-f]{32}$/);
    expect(String(lighterCodec.encodeNumeric!('1a2b3c4d00000000.1.S3'))).toMatch(/^\d+$/);
  });
});

describe('vivacidad del presupuesto', () => {
  /**
   * Una petición cuyo peso supere lo que el depósito puede contener esperaría
   * PARA SIEMPRE con la regla ingenua «concede solo si hay saldo completo». Se
   * concede con el depósito lleno y el saldo queda en deuda, que el tiempo
   * amortiza — el coste real se cobra igual, sin colgar al que pide.
   */
  it('un peso mayor que la capacidad no espera para siempre', async () => {
    const budget = new MemoryVenueBudget({
      ratePerSecond: { [Venue.HYPERLIQUID]: 50 },
      burstSeconds: 1, // capacidad 50, muy por debajo del peso pedido
      writeReserve: 0.2,
    });

    const empezado = Date.now();
    await budget.take(Venue.HYPERLIQUID, 120, 'read', false);
    expect(Date.now() - empezado).toBeLessThan(300);

    // Y la deuda se nota: la siguiente petición sí tiene que esperar.
    const otra = Date.now();
    await budget.take(Venue.HYPERLIQUID, 10, 'read', false);
    expect(Date.now() - otra).toBeGreaterThanOrEqual(100);
  });
});

describe('el simulador habla el idioma de ids del venue', () => {
  /**
   * El motor reconcilia en espacio de venue. Si el simulador devolviera los ids
   * canónicos, el reconciliador daría cada orden simulada por «propia y
   * obsoleta» y la cancelaría en cada latido: ninguna orden limit llegaría a
   * ejecutarse en simulación.
   */
  it('devuelve órdenes y fills con el id codificado como el venue real', async () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source, { makerFeeRate: '0', takerFeeRate: '0' });
    const fills: string[] = [];
    sim.streamFills().subscribe((f) => fills.push(f.clientOrderId ?? ''));

    await sim.placeOrder({
      symbol: 'BTC',
      side: 'BUY',
      type: 'LIMIT',
      price: '95',
      qty: '1',
      clientOrderId: '1a2b3c4d00000000.1.S1',
      reduceOnly: false,
    });

    const [open] = await sim.getOpenOrders('BTC');
    expect(open.clientOrderId).toBe(hyperliquidCodec.encode('1a2b3c4d00000000.1.S1'));

    // Y se puede cancelar tanto por el id canónico como por el del venue.
    await sim.cancelOrder({ symbol: 'BTC', clientOrderId: open.clientOrderId! });
    expect(await sim.getOpenOrders('BTC')).toHaveLength(0);

    await sim.placeOrder({
      symbol: 'BTC',
      side: 'BUY',
      type: 'MARKET',
      price: '100',
      qty: '1',
      clientOrderId: '1a2b3c4d00000000.1.B0',
      reduceOnly: false,
    });
    expect(fills).toEqual([hyperliquidCodec.encode('1a2b3c4d00000000.1.B0')]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Velas
// ═══════════════════════════════════════════════════════════════

describe('checkInterval', () => {
  const LIGHTER_IVS = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w'] as const;

  it('devuelve el intervalo cuando el venue lo sirve', () => {
    expect(checkInterval(Venue.LIGHTER, LIGHTER_IVS, '4h')).toBe('4h');
  });

  it('rechaza con RULES, no con FATAL: no se debe reintentar solo', () => {
    try {
      checkInterval(Venue.LIGHTER, LIGHTER_IVS, '3m');
      throw new Error('tenia que haber lanzado');
    } catch (e) {
      expect(e).toBeInstanceOf(ExchangeError);
      expect((e as ExchangeError).kind).toBe('RULES');
      expect((e as ExchangeError).venue).toBe(Venue.LIGHTER);
    }
  });

  it('nombra el intervalo pedido y los disponibles: el mensaje llega al usuario', () => {
    expect(() => checkInterval(Venue.LIGHTER, LIGHTER_IVS, '8h')).toThrow(/8h/);
    expect(() => checkInterval(Venue.LIGHTER, LIGHTER_IVS, '8h')).toThrow(/1m, 5m, 15m/);
  });
});

describe('resolveRange', () => {
  it('acota el limite al maximo del venue', () => {
    const r = resolveRange('1h', { startMs: 0, limit: 9999 }, 1500, 1_700_000_000_000);
    expect(r.limit).toBe(1500);
  });

  it('deduce el inicio desde el limite cuando no se da rango', () => {
    const now = 1_700_000_000_000;
    const r = resolveRange('1h', { startMs: 0, limit: 10 }, 1500, now);
    // 11 y no 10: la ultima vela esta en formacion y casi todos los venues la
    // incluyen, asi que se pide una de mas y el tope se aplica al final.
    expect(r.endMs).toBe(now);
    expect(r.startMs).toBe(now - 3_600_000 * 11);
  });

  it('nunca deja el inicio despues del fin', () => {
    const r = resolveRange('1m', { startMs: 5_000, endMs: 1_000 }, 500);
    expect(r.startMs).toBeLessThanOrEqual(r.endMs);
  });

  it('trata 1M como 31 dias en vez de fingir un mes fijo', () => {
    const now = 1_700_000_000_000;
    const r = resolveRange('1M', { startMs: 0, limit: 1 }, 100, now);
    expect(r.startMs).toBe(now - 31 * 86_400_000 * 2);
  });
});

describe('finishCandles', () => {
  const c = (t: number, close = '1'): Candle => ({ t, o: '1', h: '1', l: '1', c: close, v: '1' });

  it('ordena por tiempo aunque el venue las devuelva al reves', () => {
    expect(finishCandles([c(3), c(1), c(2)], 10).map((x) => x.t)).toEqual([1, 2, 3]);
  });

  it('deduplica por tiempo quedandose con la ultima version recibida', () => {
    // Es lo que pasa al fusionar la vela en formacion con la que ya se tenia.
    const out = finishCandles([c(1, '10'), c(1, '20')], 10);
    expect(out).toHaveLength(1);
    expect(out[0].c).toBe('20');
  });

  it('recorta por el extremo ANTIGUO: un grafico recortado por el nuevo esta roto', () => {
    expect(finishCandles([c(1), c(2), c(3), c(4)], 2).map((x) => x.t)).toEqual([3, 4]);
  });

  it('descarta velas sin marca de tiempo utilizable', () => {
    expect(finishCandles([c(Number.NaN), c(1)], 10).map((x) => x.t)).toEqual([1]);
  });
});

describe('normalizacion numerica de velas', () => {
  it('convierte los number de Lighter sin pasar por coma flotante', () => {
    // El caso real: Lighter sirve `number` y el resto del sistema compara
    // contra el tick del venue en decimal exacto.
    expect(num(0.1)).toBe('0.1');
    expect(num('2973.45')).toBe('2973.45');
    expect(num(null)).toBe('0');
  });

  it('numOrNull conserva la ausencia en vez de convertirla en cero', () => {
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull(0)).toBe('0');
  });

  it('changePct devuelve null si la referencia no sirve, nunca Infinity', () => {
    expect(changePct('100', null)).toBeNull();
    expect(changePct('100', '0')).toBeNull();
    expect(changePct('110', '100')).toBe('10.0000');
    expect(changePct('90', '100')).toBe('-10.0000');
  });
});

describe('capacidades por venue', () => {
  it('Lighter declara ocho intervalos y ningun stream de velas', () => {
    const caps = new (require('./adapters/lighter').LighterAdapter)({
      venue: 'LIGHTER',
      accountIndex: 0,
      apiKeyIndex: 0,
      apiPrivateKey: '',
    }).capabilities;
    expect(caps.candles.intervals).toHaveLength(8);
    expect(caps.candles.intervals).not.toContain('3m');
    // `1w` NO: venia del enum del SDK, que se quedo atras. La documentacion
    // vigente de /api/v1/candles lista ocho resoluciones y la semanal responde
    // «invalid param». Ver capabilities.ts.
    expect(caps.candles.intervals).not.toContain('1w');
    // El tope real por peticion son 500 velas, no 1000.
    expect(caps.candles.maxBars).toBe(500);
    // `live` es true desde que el adaptador habla el WebSocket oficial de
    // Lighter: el canal `candle/{market_id}/{resolution}` existe y se usa.
    // Estuvo en false, y mientras lo estuvo el grafico sondeaba la API por REST
    // — que es por donde se agotaba el cupo del venue.
    expect(caps.candles.live).toBe(true);
  });

  it('el simulador hereda las del venue real: en dry-run los precios son de verdad', () => {
    const source = new StubSource();
    const sim = new DryRunAdapter(source);
    expect(sim.capabilities).toBe(source.capabilities);
  });

  it('capabilitiesOf copia la lista: una tupla const no debe poder mutarse desde fuera', () => {
    const ivs = ['1m', '1h'] as const;
    const caps = capabilitiesOf(Venue.ASTER, ivs, 100, true, HIST);
    caps.candles.intervals.push('1d');
    expect(ivs).toHaveLength(2);
  });
});

describe('oldestPrice — precio de referencia de 24 h en Lighter', () => {
  it('toma el punto mas antiguo de la serie', () => {
    expect(oldestPrice({ '300': 30, '100': 10, '200': 20 })).toBe('10');
  });

  it('ordena las claves como NUMEROS, no como cadenas', () => {
    // Ordenadas como texto, '1000' va antes que '9' y el «mas antiguo» sale
    // mal justo cuando la serie cruza una potencia de diez.
    expect(oldestPrice({ '1000': 50, '9': 7 })).toBe('7');
  });

  it('ignora puntos inservibles en vez de propagarlos', () => {
    expect(oldestPrice({ x: 5, '100': 10 })).toBe('10');
    expect(oldestPrice({ '50': 0, '100': 10 })).toBe('10');
    expect(oldestPrice({ '50': Number.NaN, '100': 10 })).toBe('10');
  });

  it('devuelve null si no hay serie: un mercado recien listado no la tiene', () => {
    expect(oldestPrice(undefined)).toBeNull();
    expect(oldestPrice({})).toBeNull();
  });
});

describe('LighterAdapter.getTickers — el cambio de 24 h sale de la serie de precios', () => {
  const detail = (over: Record<string, unknown>) => ({
    symbol: 'ETH',
    market_id: 1,
    market_type: 'perp',
    status: 'active',
    last_trade_price: 2955,
    daily_price_high: 2960,
    daily_price_low: 2900,
    daily_quote_token_volume: 74_000_000,
    daily_price_change: 1.9,
    daily_chart: { '1699920000': 2900, '1699930000': 2910, '1700003600': 2955 },
    ...over,
  });

  const adapterWith = (details: Record<string, unknown>[]) => {
    const { LighterAdapter } = require('./adapters/lighter');
    const a = new LighterAdapter({
      venue: 'LIGHTER',
      accountIndex: 0,
      apiKeyIndex: 0,
      apiPrivateKey: '',
    });
    a.call = async (fn: () => Promise<unknown>) => fn();
    a.orderApi = { orderBookDetails: async () => ({ data: { order_book_details: details } }) };
    return a as { getTickers(): Promise<MarketTicker[]> };
  };

  it('deriva importe y porcentaje del punto mas antiguo de daily_chart, consistentes entre si', async () => {
    const [t] = await adapterWith([detail({})]).getTickers();
    // 2955 - 2900 = 55; 55 / 2900 = 1,8966 %. Las dos cifras salen del MISMO
    // precio de referencia, asi que no pueden contradecirse en pantalla.
    expect(t.change24h).toBe('55');
    expect(t.changePct24h).toBe('1.8966');
  });

  it('NO lee daily_price_change cuando hay serie: su unidad no esta documentada', async () => {
    // 1.9 en porcentaje daria 1.9; en importe daria 1.9 USDC. Ninguna de las
    // dos es lo que se devuelve cuando hay serie.
    const [t] = await adapterWith([detail({ daily_price_change: 1.9 })]).getTickers();
    expect(t.changePct24h).not.toBe('1.9');
  });

  it('sin serie —mercado recien listado— cae a daily_price_change y deja el importe en null', async () => {
    const [t] = await adapterWith([
      detail({ daily_chart: {}, daily_price_change: 0.5 }),
    ]).getTickers();
    expect(t.change24h).toBeNull();
    expect(t.changePct24h).toBe('0.5');
  });

  it('maximo y minimo van a su campo, no intercambiados', async () => {
    const [t] = await adapterWith([detail({})]).getTickers();
    expect(Number(t.high24h)).toBeGreaterThanOrEqual(Number(t.low24h));
    expect(t.high24h).toBe('2960');
  });

  it('excluye los mercados spot, igual que getMarkets', async () => {
    const rows = await adapterWith([
      detail({}),
      detail({ symbol: 'X', market_type: 'spot' }),
    ]).getTickers();
    expect(rows).toHaveLength(1);
  });
});
