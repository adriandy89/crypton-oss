import { ExchangeError, SourceMarketType, type Candle } from '@crypton/shared';
import { BinanceHistory } from './binance';
import { BybitHistory } from './bybit';
import { paginateHistory } from './paginate';
import type { HistoryPageQuery, HistoryProvider } from './types';

const CONFIG = {
  spotUrl: 'https://api.binance.com',
  perpUrl: 'https://fapi.binance.com',
  timeoutMs: 5_000,
};
const BYBIT_CONFIG = {
  spotUrl: 'https://api.bybit.com',
  perpUrl: 'https://api.bybit.com',
  timeoutMs: 5_000,
};

const SPAN = 900_000; // 15m
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % SPAN);

let urls: string[];

function mockFetch(responder: (url: string) => unknown): void {
  urls = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn((url: string) => {
    urls.push(url);
    const body = responder(url);
    if (body instanceof Error) return Promise.reject(body);
    if (typeof body === 'number') {
      return Promise.resolve({ ok: false, status: body, json: async () => ({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
}

/** Filas de Binance: `[openTime, o, h, l, c, v, …]`. */
const klines = (startT: number, n: number): unknown[][] =>
  Array.from({ length: n }, (_, i) => [startT + i * SPAN, '1', '2', '0.5', '1.5', '10', 0]);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('BinanceHistory', () => {
  const p = new BinanceHistory(CONFIG);

  it('los perpetuos van a fapi y el contado al REST', async () => {
    mockFetch(() => klines(T0, 2));

    await p.page(query({ marketType: SourceMarketType.PERP }));
    expect(urls[0]).toContain('https://fapi.binance.com/fapi/v1/klines');

    await p.page(query({ marketType: SourceMarketType.SPOT }));
    expect(urls[1]).toContain('https://api.binance.com/api/v3/klines');
  });

  it('mapea la fila y devuelve la serie ascendente', async () => {
    mockFetch(() => klines(T0, 3));
    const out = await p.page(query());

    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ t: T0, o: '1', h: '2', l: '0.5', c: '1.5', v: '10' });
    expect(out.map((c) => c.t)).toEqual([T0, T0 + SPAN, T0 + 2 * SPAN]);
  });

  it('la traducción de intervalos es la IDENTIDAD', async () => {
    // El vocabulario de Binance es un superconjunto del del sistema. Lo primero
    // que hace cualquiera es escribir una tabla de mapeo; no hace falta.
    mockFetch(() => klines(T0, 1));
    await p.page(query({ interval: '8h' }));
    expect(urls[0]).toContain('interval=8h');
  });

  it('el símbolo alternativo manda', async () => {
    mockFetch(() => klines(T0, 1));
    expect(p.symbolFor('kPEPE', SourceMarketType.PERP, '1000PEPEUSDT')).toBe('1000PEPEUSDT');
    expect(p.symbolFor('btc', SourceMarketType.PERP)).toBe('BTCUSDT');
  });

  it('un 451 dice que es un bloqueo por territorio, no «error de red»', async () => {
    // Es el fallo más probable en un datacenter y el que peor se diagnostica
    // solo: un mensaje genérico manda al operador a mirar la red.
    mockFetch(() => 451);
    await expect(p.page(query())).rejects.toThrow(/territorio/i);
    await expect(p.page(query())).rejects.toBeInstanceOf(ExchangeError);
  });

  it('un 429 se marca como límite de caudal', async () => {
    mockFetch(() => 429);
    await expect(p.page(query())).rejects.toThrow(/limitando/i);
  });

  it('un 400 es una petición mala, no algo que reintentar', async () => {
    mockFetch(() => 400);
    await expect(p.page(query())).rejects.toMatchObject({ kind: 'RULES' });
  });

  it('INDEX no existe para velas', async () => {
    mockFetch(() => klines(T0, 1));
    await expect(p.page(query({ marketType: SourceMarketType.INDEX }))).rejects.toThrow(/INDEX/);
  });
});

describe('BybitHistory', () => {
  const p = new BybitHistory(BYBIT_CONFIG);
  const bybitRows = (startT: number, n: number) =>
    // Bybit sirve de la MÁS NUEVA a la más vieja.
    Array.from({ length: n }, (_, i) => [
      String(startT + (n - 1 - i) * SPAN),
      '1',
      '2',
      '0.5',
      '1.5',
      '10',
      '0',
    ]);

  it('le da la vuelta a la lista, que llega al revés', async () => {
    mockFetch(() => ({ retCode: 0, result: { list: bybitRows(T0, 3) } }));
    const out = await p.page(query());
    expect(out.map((c) => c.t)).toEqual([T0, T0 + SPAN, T0 + 2 * SPAN]);
  });

  it('traduce los intervalos a su vocabulario', async () => {
    mockFetch(() => ({ retCode: 0, result: { list: bybitRows(T0, 1) } }));

    await p.page(query({ interval: '1h' }));
    expect(urls[0]).toContain('interval=60');

    await p.page(query({ interval: '1d' }));
    expect(urls[1]).toContain('interval=D');
  });

  it('RECHAZA 8h y 3d, que Bybit no tiene, diciendo cuáles sí', async () => {
    // Mandarlos y recibir un 400 opaco sería peor: el usuario no sabría qué
    // poner en su lugar.
    mockFetch(() => ({ retCode: 0, result: { list: [] } }));
    await expect(p.page(query({ interval: '8h' }))).rejects.toThrow(/Intervalos disponibles/);
    await expect(p.page(query({ interval: '3d' }))).rejects.toThrow(/Intervalos disponibles/);
    expect(urls).toHaveLength(0);
  });

  it('un error dentro de un 200 también es un error', async () => {
    // Bybit responde 200 con el fallo en el cuerpo: `res.ok` no basta.
    mockFetch(() => ({ retCode: 10001, retMsg: 'params error' }));
    await expect(p.page(query())).rejects.toThrow(/params error/);
  });

  it('el contado va a category=spot y los perpetuos a linear', async () => {
    mockFetch(() => ({ retCode: 0, result: { list: bybitRows(T0, 1) } }));
    await p.page(query({ marketType: SourceMarketType.SPOT }));
    expect(urls[0]).toContain('category=spot');
    await p.page(query({ marketType: SourceMarketType.PERP }));
    expect(urls[1]).toContain('category=linear');
  });
});

describe('paginateHistory', () => {
  /** Proveedor de mentira que sirve velas contiguas desde `startMs`. */
  const fake = (
    responder: (q: HistoryPageQuery) => Candle[],
    over: Partial<HistoryProvider> = {},
  ): HistoryProvider => ({
    id: 'BINANCE',
    intervals: ['15m'],
    maxBarsPerRequest: 100,
    marketTypes: [SourceMarketType.PERP],
    symbolFor: (b) => b,
    page: async (q) => responder(q),
    ...over,
  });

  const serie = (startT: number, n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      t: startT + i * SPAN,
      o: '1',
      h: '1',
      l: '1',
      c: '1',
      v: null,
    }));

  const base = {
    symbol: 'BTCUSDT',
    interval: '15m' as const,
    marketType: SourceMarketType.PERP,
    fromMs: T0,
    toMs: T0 + 250 * SPAN,
    barCap: 1000,
    now: T0 + 300 * SPAN,
  };

  /** Velas contiguas desde `startMs`, sin pasarse de `endMs`: como los reales. */
  const contiguas = (q: HistoryPageQuery): Candle[] =>
    serie(q.startMs, Math.min(q.limit, Math.max(0, Math.floor((q.endMs - q.startMs) / SPAN))));

  it('encadena páginas hasta cubrir el rango', async () => {
    const r = await paginateHistory({ ...base, provider: fake(contiguas) });

    expect(r.pages).toBe(3);
    expect(r.candles).toHaveLength(250);
    expect(r.candles[0].t).toBe(T0);
    // Contiguas de verdad: un hueco aquí sería un fallo de paginación.
    expect(r.barsMissing).toBe(0);
  });

  it('una página vacía corta: la fuente no tiene más', async () => {
    let n = 0;
    const r = await paginateHistory({
      ...base,
      provider: fake((q) => (n++ === 0 ? serie(q.startMs, 100) : [])),
    });

    expect(r.pages).toBe(1);
    expect(r.candles).toHaveLength(100);
  });

  it('NO entra en bucle infinito si una página se repite', async () => {
    // Sin la guardia, un proveedor que devuelva siempre la misma ventana cuelga
    // la petición HTTP entera.
    let llamadas = 0;
    const r = await paginateHistory({
      ...base,
      provider: fake(() => {
        llamadas++;
        return serie(T0, 100); // siempre la misma
      }),
    });

    expect(llamadas).toBe(2);
    expect(r.candles).toHaveLength(100);
  });

  it('el cursor se alinea a la vela, para que la caché acierte', async () => {
    const vistos: number[] = [];
    await paginateHistory({
      ...base,
      // Desalineado a propósito.
      fromMs: T0 + 12_345,
      provider: fake((q) => {
        vistos.push(q.startMs);
        return serie(q.startMs, 100);
      }),
    });

    expect(vistos[0] % SPAN).toBe(0);
  });

  it('respeta el tope de barras', async () => {
    const r = await paginateHistory({
      ...base,
      barCap: 150,
      provider: fake((q) => serie(q.startMs, 100)),
    });

    expect(r.candles).toHaveLength(150);
    // Y conserva las MÁS RECIENTES: `finishCandles` recorta por delante.
    expect(r.candles[r.candles.length - 1].t).toBe(T0 + 199 * SPAN);
  });

  it('rechaza un intervalo que el proveedor no sirve, sin salir a la red', async () => {
    let llamado = false;
    await expect(
      paginateHistory({
        ...base,
        interval: '1h',
        provider: fake(() => {
          llamado = true;
          return [];
        }),
      }),
    ).rejects.toThrow(/Intervalos disponibles/);
    expect(llamado).toBe(false);
  });

  it('los huecos se CONSERVAN y se cuentan, nunca se rellenan', async () => {
    // Rellenar inventaría precios, y el motor colocaría órdenes contra velas que
    // no existieron.
    // Una sola página con un agujero de diez velas en medio: es lo que devuelve
    // un par que estuvo delistado o un mercado que paró.
    let servida = false;
    const r = await paginateHistory({
      ...base,
      toMs: T0 + 30 * SPAN,
      provider: fake((q) => {
        if (servida) return [];
        servida = true;
        return [...serie(q.startMs, 10), ...serie(q.startMs + 20 * SPAN, 10)];
      }),
    });

    expect(r.barsMissing).toBe(10);
    expect(r.largestGapMs).toBe(11 * SPAN);
    // Y la serie no ha crecido con velas de mentira.
    expect(r.candles).toHaveLength(20);
  });

  it('la caché evita la llamada, y solo se escribe con ventanas cerradas', async () => {
    const guardadas = new Map<string, Candle[]>();
    let llamadas = 0;

    const run = () =>
      paginateHistory({
        ...base,
        toMs: T0 + 100 * SPAN,
        provider: fake((q) => {
          llamadas++;
          return serie(q.startMs, 100);
        }),
        readCache: async (k) => guardadas.get(k),
        writeCache: async (k, page) => {
          guardadas.set(k, page);
        },
      });

    await run();
    expect(llamadas).toBe(1);

    await run();
    // La segunda vez sale entera de la caché.
    expect(llamadas).toBe(1);
  });
});

function query(over: Partial<HistoryPageQuery> = {}): HistoryPageQuery {
  return {
    symbol: 'BTCUSDT',
    interval: '15m',
    marketType: SourceMarketType.PERP,
    startMs: T0,
    endMs: T0 + 100 * SPAN,
    limit: 100,
    ...over,
  };
}
