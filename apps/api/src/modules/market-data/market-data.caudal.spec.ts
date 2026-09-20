/**
 * El adaptador público de la API y el caudal (spec 065).
 *
 * La API y el worker comparten el depósito de caudal por IP
 * (`WORKER_EGRESS_ID`), pero la API construía su adaptador SIN tope propio: se
 * quedaba con el valor por defecto del adaptador y con la cola de concurrencia
 * uno. Una carga de histórico del gráfico son nueve páginas de trescientas
 * velas —225 de peso— contra el mismo depósito del que comen los bots.
 */
import { Venue } from '@crypton/db';
import { MarketDataService } from './market-data.service';

const mockOpciones: Record<string, unknown>[] = [];

jest.mock('@crypton/exchange-core', () => {
  const real = jest.requireActual('@crypton/exchange-core');
  return {
    ...real,
    createPublicAdapter: (venue: unknown, opts: Record<string, unknown>) => {
      mockOpciones.push(opts);
      return {
        venue,
        getCandles: async () => [],
        getTickers: async () => [],
        capabilities: real.VENUE_CAPABILITIES[venue as Venue],
      };
    },
  };
});

class CacheVacia {
  async get(): Promise<null> {
    return null;
  }
  async set(): Promise<void> {}
  async setnx(): Promise<boolean> {
    return true;
  }
}

const markets = {
  async getSpec(venue: string, symbol: string) {
    return { venue, symbol };
  },
};
const budget = { budget: { take: async () => undefined } };

const servicio = (env: Record<string, string> = {}) =>
  new MarketDataService(
    new CacheVacia() as never,
    markets as never,
    budget as never,
    { get: (key: string, fallback?: unknown) => env[key] ?? fallback ?? '' } as never,
  );

describe('MarketDataService — caudal del adaptador público', () => {
  beforeEach(() => {
    mockOpciones.length = 0;
  });

  it('lleva su tope de caudal y su concurrencia, no los valores por defecto', async () => {
    const service = servicio({
      MARKETDATA_RATE_LIMIT_PER_SECOND: '4',
      VENUE_MAX_CONCURRENT_READS: '3',
    });
    await service.candles(Venue.HYPERLIQUID, 'BTC', '1h');

    expect(mockOpciones).toHaveLength(1);
    expect(mockOpciones[0]).toMatchObject({ rateLimitPerSecond: 4, maxConcurrentReads: 3 });
  });

  it('sin la variable de concurrencia, manda el valor por defecto del venue', async () => {
    const service = servicio();
    await service.candles(Venue.HYPERLIQUID, 'BTC', '1h');

    // Una variable vacía da `Number('') === 0`, que como concurrencia es
    // absurdo: el objeto no la lleva y decide el adaptador (spec 060, F-34).
    expect(mockOpciones[0]).not.toHaveProperty('maxConcurrentReads');
  });
});
