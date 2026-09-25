import { Venue } from '@crypton/db';
import type { NivelApalancamiento, Ticker } from '@crypton/shared';
import { BotsSseService } from '../bots';
import { MarketDataService } from './market-data.service';
import { MarketStreamService } from './market-stream.service';

/**
 * Lo que los agentes de IA leen del mercado (spec 074): el ticker con su bid,
 * su ask y su marca, y los tramos de apalancamiento de un par. Lo primero sale
 * gratis del worker cuando el par está suscrito; si no, del venue, cacheado y
 * de una sola petición en vuelo.
 */

class FakeCache {
  readonly store = new Map<string, { value: unknown; ttl?: number }>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key)?.value as T) ?? null;
  }
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, { value, ttl: ttlSeconds });
  }
}

const TICKER: Ticker = {
  venue: 'HYPERLIQUID',
  symbol: 'BTC',
  last: '100',
  bid: '99.9',
  ask: '100.1',
  mark: '100',
  ts: 1,
};

function montar(adaptador: Record<string, unknown>) {
  const cache = new FakeCache();
  const service = new MarketDataService(
    cache as never,
    { getSpec: async () => ({}) } as never,
    { budget: { take: async () => undefined } } as never,
    { get: (_k: string, def?: unknown) => def ?? '' } as never,
  );
  // El adaptador del venue, de mentira: aquí no sale nada a la red.
  (service as unknown as { adapterFor: () => unknown }).adapterFor = () => adaptador;
  return { service, cache };
}

describe('MarketDataService.ticker', () => {
  it('el del worker, si está entero, sin ir al venue', async () => {
    const getTicker = jest.fn();
    const { service, cache } = montar({ getTicker });
    await cache.set('crypton:px:HYPERLIQUID:BTC', TICKER, 30);
    await expect(service.ticker(Venue.HYPERLIQUID, 'BTC')).resolves.toEqual(TICKER);
    expect(getTicker).not.toHaveBeenCalled();
  });

  it('sin él, el del venue, cacheado unos segundos y de una sola petición', async () => {
    const getTicker = jest.fn(async () => TICKER);
    const { service, cache } = montar({ getTicker });
    // Uno a medias —sin bid— no sirve: la entrada se calcula con el libro.
    await cache.set('crypton:px:HYPERLIQUID:BTC', { ...TICKER, bid: '' }, 30);
    const [a, b] = await Promise.all([
      service.ticker(Venue.HYPERLIQUID, 'BTC'),
      service.ticker(Venue.HYPERLIQUID, 'BTC'),
    ]);
    expect([a, b]).toEqual([TICKER, TICKER]);
    expect(getTicker).toHaveBeenCalledTimes(1);
    expect(cache.store.get('md:ticker:HYPERLIQUID:BTC')?.ttl).toBe(5);
  });

  it('si el venue falla, null: sin precio no se calcula nada', async () => {
    const { service } = montar({
      getTicker: async () => {
        throw new Error('caído');
      },
    });
    await expect(service.ticker(Venue.HYPERLIQUID, 'BTC')).resolves.toBeNull();
  });
});

describe('MarketDataService.tramos', () => {
  const TRAMOS: NivelApalancamiento[] = [
    { desdeNocional: '0', maxApalancamiento: 40, mantenimiento: 0.0125 },
  ];

  it('un venue que no los publica da la lista vacía: la ficha del mercado', async () => {
    const { service } = montar({});
    await expect(service.tramos(Venue.LIGHTER, 'BTC')).resolves.toEqual([]);
  });

  it('los que publica, una hora en caché', async () => {
    const getLeverageTiers = jest.fn(async () => TRAMOS);
    const { service, cache } = montar({ getLeverageTiers });
    await expect(service.tramos(Venue.HYPERLIQUID, 'BTC')).resolves.toEqual(TRAMOS);
    await expect(service.tramos(Venue.HYPERLIQUID, 'BTC')).resolves.toEqual(TRAMOS);
    expect(getLeverageTiers).toHaveBeenCalledTimes(1);
    expect(cache.store.get('md:tiers:HYPERLIQUID:BTC')?.ttl).toBe(3600);
  });

  it('si los publica y fallan, null —ese par no ofrece nada— y no se cachea el fallo', async () => {
    const getLeverageTiers = jest.fn(async () => {
      throw new Error('caído');
    });
    const { service, cache } = montar({ getLeverageTiers });
    await expect(service.tramos(Venue.HYPERLIQUID, 'BTC')).resolves.toBeNull();
    expect(cache.store.has('md:tiers:HYPERLIQUID:BTC')).toBe(false);
  });
});

describe('MarketStreamService.fijarInteresServidor', () => {
  function build() {
    const publicados: Record<string, unknown>[] = [];
    const bus = {
      listenPublic: jest.fn().mockResolvedValue({ subscribe: () => ({ unsubscribe() {} }) }),
      publishPublic: jest.fn((_c: string, m: { data: Record<string, unknown> }) => {
        publicados.push(m.data);
        return Promise.resolve();
      }),
    };
    const sse = new BotsSseService(bus as never);
    const stream = new MarketStreamService(bus as never, sse);
    const anunciar = () => (stream as unknown as { announce(): Promise<void> }).announce();
    return { stream, sse, publicados, anunciar };
  }

  it('lo que declaran los agentes va al worker con lo de las pantallas, sin repetir', async () => {
    const h = build();
    const { streamId } = h.sse.stream('u1');
    await h.stream.watch('u1', streamId, ['HYPERLIQUID:BTC'], []);
    h.stream.fijarInteresServidor('ai-desk', ['HYPERLIQUID:BTC', 'HYPERLIQUID:ETH']);
    h.stream.fijarInteresServidor('ai-desk', ['LIGHTER:SOL'], true);
    await h.anunciar();
    const ultimo = h.publicados[h.publicados.length - 1];
    expect(ultimo['symbols']).toEqual(['HYPERLIQUID:BTC', 'HYPERLIQUID:ETH']);
    expect(ultimo['symbolsTest']).toEqual(['LIGHTER:SOL']);
  });

  it('reemplaza lo anterior; vacío lo suelta; lo mal formado no pasa', async () => {
    const h = build();
    h.stream.fijarInteresServidor('ai-desk', ['HYPERLIQUID:BTC']);
    h.stream.fijarInteresServidor('ai-desk', ['HYPERLIQUID:ETH', 'NOVENUE:X', 'HYPERLIQUID:A:B']);
    await h.anunciar();
    expect(h.publicados[h.publicados.length - 1]['symbols']).toEqual(['HYPERLIQUID:ETH']);
    h.stream.fijarInteresServidor('ai-desk', []);
    await h.anunciar();
    expect(h.publicados[h.publicados.length - 1]['symbols']).toEqual([]);
  });
});
