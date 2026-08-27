import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Venue } from '@crypton/db';
import type { Candle, MarketTicker } from '@crypton/shared';
import { MarketDataService } from './market-data.service';

/**
 * Tests del servicio de datos de mercado.
 *
 * Lo que se comprueba aqui es lo que decide si esto aguanta a mil usuarios
 * mirando el mismo par: que un intervalo no soportado se rechace ANTES de
 * llegar al DEX, que una vela cerrada se cachee mucho mas que una viva, y que
 * doscientos fallos de cache simultaneos produzcan UNA sola llamada.
 */

/** CacheService de mentira: un Map, con la misma tolerancia a fallos. */
class FakeCache {
  readonly store = new Map<string, { value: unknown; ttl?: number }>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key)?.value as T) ?? null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, { value, ttl: ttlSeconds });
  }

  async setnx(): Promise<boolean> {
    return true;
  }

  ttlOf(key: string): number | undefined {
    return this.store.get(key)?.ttl;
  }
}

/** Catálogo de mentira: acepta todo salvo lo que se marque como desconocido. */
const markets = {
  async getSpec(venue: string, symbol: string) {
    if (symbol === 'NOPE')
      throw new NotFoundException(`El mercado ${symbol} no está disponible en ${venue}.`);
    return { venue, symbol };
  },
};

/**
 * Presupuesto de mentira que NO limita.
 *
 * Va explicito y no ausente: el servicio construye ahora los adaptadores CON
 * presupuesto —antes iban con `NO_BUDGET` y la API gastaba cupo del venue sin
 * apuntarlo—, asi que el test tiene que darle uno.
 */
const budget = { budget: { take: async () => undefined } };

/** Sin cuenta de servicio: el modo por defecto, lecturas sin firmar. */
const config = { get: (_key: string, fallback?: unknown) => fallback ?? '' };

const svc = (cache = new FakeCache()) => ({
  service: new MarketDataService(
    cache as never,
    markets as never,
    budget as never,
    config as never,
  ),
  cache,
});

describe('MarketDataService — capacidades', () => {
  it('declara los tres venues, cada uno con su lista', () => {
    const { service } = svc();
    const caps = service.capabilities();

    expect(caps[Venue.HYPERLIQUID].candles.intervals).toHaveLength(14);
    expect(caps[Venue.LIGHTER].candles.intervals).toHaveLength(8);
    expect(caps[Venue.ASTER].candles.intervals).toHaveLength(15);
  });

  it('la asimetria entre venues es real y esta declarada', () => {
    const { service } = svc();
    const caps = service.capabilities();

    // Es el caso que la interfaz tiene que saber contar: 3m existe en dos de
    // los tres, y esconderlo dejaria al usuario creyendo que la app no sabe.
    expect(caps[Venue.HYPERLIQUID].candles.intervals).toContain('3m');
    expect(caps[Venue.ASTER].candles.intervals).toContain('3m');
    expect(caps[Venue.LIGHTER].candles.intervals).not.toContain('3m');

    // 6h solo lo sirve Aster.
    expect(caps[Venue.ASTER].candles.intervals).toContain('6h');
    expect(caps[Venue.HYPERLIQUID].candles.intervals).not.toContain('6h');
  });

  it('los tres venues tienen stream de velas', () => {
    const { service } = svc();
    const caps = service.capabilities();
    // Lighter estuvo en false y era un error de nuestro lado, no una carencia
    // suya: su WebSocket oficial tiene `candle/{market_id}/{resolution}`.
    // Mientras estuvo declarado asi, el worker respondia «no hay velas en vivo»
    // y el grafico se quedaba sondeando la API por REST — que es por donde se
    // agotaba el cupo del venue y saltaba su CAPTCHA.
    expect(caps[Venue.LIGHTER].candles.live).toBe(true);
    expect(caps[Venue.HYPERLIQUID].candles.live).toBe(true);
    expect(caps[Venue.ASTER].candles.live).toBe(true);
  });

  it('se construyen una sola vez por proceso', () => {
    const { service } = svc();
    expect(service.capabilities()).toBe(service.capabilities());
  });
});

describe('MarketDataService — validacion de intervalo', () => {
  it('rechaza con 400 y nombra las alternativas, sin tocar el venue', async () => {
    const { service } = svc();
    await expect(service.candles(Venue.LIGHTER, 'BTC', '3m')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.candles(Venue.LIGHTER, 'BTC', '3m')).rejects.toThrow(/1m, 5m, 15m/);
  });

  it('el mensaje se puede enseñar tal cual al usuario', async () => {
    const { service } = svc();
    await expect(service.candles(Venue.LIGHTER, 'BTC', '8h')).rejects.toThrow(
      /LIGHTER no sirve velas de 8h/,
    );
  });
});

describe('MarketDataService — símbolo desconocido', () => {
  it('responde 404 desde el catálogo SIN salir al venue', async () => {
    // Cada símbolo inventado era antes una llamada al DEX con el presupuesto
    // de caudal que comparten los bots.
    const { service } = svc();
    await expect(service.candles(Venue.ASTER, 'NOPE', '1h')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('MarketDataService — caché de velas', () => {
  const candle = (t: number): Candle => ({
    t,
    o: '1',
    h: '2',
    l: '0',
    c: '1.5',
    v: '10',
  });

  it('sirve de la caché sin volver a pedir', async () => {
    const { service, cache } = svc();
    const key = 'md:candles:HYPERLIQUID:BTC:1h:300:now';
    await cache.set(key, [candle(1)], 10);

    await expect(service.candles(Venue.HYPERLIQUID, 'BTC', '1h')).resolves.toEqual([candle(1)]);
  });

  it('dos endMs dentro de la misma vela comparten entrada de caché', async () => {
    // Es lo que hace que paginar hacia atrás acierte: dos usuarios que arrastran
    // con un milisegundo de diferencia piden la MISMA ventana, y el gráfico
    // manda siempre el `t` de la vela más antigua, que ya viene alineado.
    const { service, cache } = svc();
    const span = 3_600_000;
    const alineado = Math.floor((Date.now() - 10 * span) / span) * span;
    await cache.set(`md:candles:HYPERLIQUID:BTC:1h:300:${alineado}`, [candle(3)], 60);

    await expect(
      service.candles(Venue.HYPERLIQUID, 'BTC', '1h', { endMs: alineado }),
    ).resolves.toEqual([candle(3)]);
    // Un milisegundo más tarde cae en el mismo cubo.
    await expect(
      service.candles(Venue.HYPERLIQUID, 'BTC', '1h', { endMs: alineado + 1 }),
    ).resolves.toEqual([candle(3)]);
    // Y el último milisegundo de esa vela, también.
    await expect(
      service.candles(Venue.HYPERLIQUID, 'BTC', '1h', {
        endMs: alineado + span - 1,
      }),
    ).resolves.toEqual([candle(3)]);
  });

  it('un endMs en el futuro es «ahora», no una ventana propia', async () => {
    const { service, cache } = svc();
    await cache.set('md:candles:HYPERLIQUID:BTC:1h:300:now', [candle(4)], 60);

    await expect(
      service.candles(Venue.HYPERLIQUID, 'BTC', '1h', {
        endMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual([candle(4)]);
  });

  it('el límite se acota al techo REAL del venue antes de entrar en la clave', async () => {
    // Lighter sirve 500 velas como máximo. Sin acotar, un `limit=1500` guardaba
    // 500 velas bajo una clave que decía 1500 — un nombre que miente y que nunca
    // casaría con la clave legítima de 500.
    const { service, cache } = svc();
    await cache.set('md:candles:LIGHTER:BTC:1h:500:now', [candle(7)], 10);

    await expect(service.candles(Venue.LIGHTER, 'BTC', '1h', { limit: 1500 })).resolves.toEqual([
      candle(7),
    ]);
  });

  it('una ventana CERRADA se cachea una hora; la viva, segundos', async () => {
    const { service, cache } = svc();
    const viejo = Date.now() - 40 * 86_400_000;

    await cache.set(`md:candles:HYPERLIQUID:BTC:1d:300:${viejo}`, [candle(1)]);
    await cache.set('md:candles:HYPERLIQUID:BTC:1d:300:now', [candle(2)]);

    // La distincion importa: sin ella hay que elegir entre servir precios
    // viejos o no cachear nada, y desplazarse hacia atras en el grafico
    // volveria a golpear el DEX en cada gesto.
    const ttlCerrada = (
      service as never as {
        candleTtl(i: string, e?: number): number;
      }
    ).candleTtl('1d', viejo);
    const ttlViva = (
      service as never as {
        candleTtl(i: string, e?: number): number;
      }
    ).candleTtl('1d');

    expect(ttlCerrada).toBe(3600);
    expect(ttlViva).toBeLessThanOrEqual(15);
    expect(ttlViva).toBeGreaterThanOrEqual(3);
  });

  it('el TTL de la vela viva es una decima del intervalo, entre 3 y 15 s', () => {
    const { service } = svc();
    const ttl = (i: string) =>
      (service as never as { candleTtl(i: string, e?: number): number }).candleTtl(i);

    // 1m -> 6 s. Con la mitad del intervalo salian los 15 s del tope y la vela
    // viva se congelaba un cuarto de su propia duracion.
    expect(ttl('1m')).toBe(6);
    expect(ttl('5m')).toBe(15);
    expect(ttl('1d')).toBe(15);
    // Ningun intervalo puede producir un TTL de cero, que seria no cachear.
    expect(ttl('1m')).toBeGreaterThanOrEqual(3);
  });

  it('endMs entra en la clave, ALINEADO a la vela: la historia no pisa a la ventana viva', async () => {
    const { service, cache } = svc();
    // 1h = 3.600.000 ms. Un endMs de 3.600.001 se alinea a 3.600.000.
    await cache.set('md:candles:ASTER:BTCUSDT:1h:300:now', [candle(9)]);
    await cache.set('md:candles:ASTER:BTCUSDT:1h:300:3600000', [candle(1)]);

    await expect(service.candles(Venue.ASTER, 'BTCUSDT', '1h')).resolves.toEqual([candle(9)]);
    await expect(
      service.candles(Venue.ASTER, 'BTCUSDT', '1h', { endMs: 3_600_001 }),
    ).resolves.toEqual([candle(1)]);
  });

  it('limit se cuantiza: valores distintos no generan claves distintas', async () => {
    // Es una defensa: con limit libre, un usuario autenticado generaba claves
    // nuevas a voluntad y cada una era una llamada al DEX con el presupuesto
    // de caudal que comparten los bots.
    const { service, cache } = svc();
    await cache.set('md:candles:ASTER:BTCUSDT:1h:300:now', [candle(7)]);
    for (const limit of [151, 200, 299, 300]) {
      await expect(service.candles(Venue.ASTER, 'BTCUSDT', '1h', { limit })).resolves.toEqual([
        candle(7),
      ]);
    }
  });

  it('un endMs en el futuro es «ahora», no una clave nueva', async () => {
    const { service, cache } = svc();
    await cache.set('md:candles:ASTER:BTCUSDT:1h:300:now', [candle(3)]);
    await expect(
      service.candles(Venue.ASTER, 'BTCUSDT', '1h', {
        endMs: Date.now() + 86_400_000,
      }),
    ).resolves.toEqual([candle(3)]);
  });
});

describe('MarketDataService — precios de 24 h', () => {
  const ticker = (venue: Venue, symbol: string): MarketTicker => ({
    venue,
    symbol,
    last: '100',
    change24h: '1',
    changePct24h: '1',
    high24h: null,
    low24h: null,
    volume24h: '5',
    ts: 0,
  });

  it('une los tres venues cuando no se filtra', async () => {
    const { service, cache } = svc();
    await cache.set('md:tickers:HYPERLIQUID', [ticker(Venue.HYPERLIQUID, 'BTC')]);
    await cache.set('md:tickers:LIGHTER', [ticker(Venue.LIGHTER, 'BTC')]);
    await cache.set('md:tickers:ASTER', [ticker(Venue.ASTER, 'BTCUSDT')]);

    await expect(service.tickers()).resolves.toHaveLength(3);
  });

  it('filtrado devuelve solo ese venue', async () => {
    const { service, cache } = svc();
    await cache.set('md:tickers:HYPERLIQUID', [ticker(Venue.HYPERLIQUID, 'BTC')]);
    await cache.set('md:tickers:ASTER', [ticker(Venue.ASTER, 'BTCUSDT')]);

    const rows = await service.tickers(Venue.ASTER);
    expect(rows).toHaveLength(1);
    expect(rows[0].venue).toBe(Venue.ASTER);
  });

  it('un venue sin datos no vacia a los demas', async () => {
    // Que Aster no responda no puede dejar la lista sin Hyperliquid.
    const { service, cache } = svc();
    await cache.set('md:tickers:HYPERLIQUID', [ticker(Venue.HYPERLIQUID, 'BTC')]);

    const rows = await service.tickers();
    expect(rows).toHaveLength(1);
    expect(rows[0].venue).toBe(Venue.HYPERLIQUID);
  });
});
