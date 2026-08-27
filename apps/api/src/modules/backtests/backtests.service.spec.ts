import { BacktestSource, SourceMarketType, Venue } from '@crypton/shared';
import { BacktestsService, MAX_BARS } from './backtests.service';
import type { CreateBacktestDto } from './dtos';

/**
 * La validación de entrada del backtest.
 *
 * Todo lo que se comprueba aquí define el COSTE de la ejecución, y la ejecución
 * es síncrona: un rango sin acotar dejaría al proceso de la API dando vueltas
 * mientras el resto de usuarios espera.
 */

const SPAN_1H = 3_600_000;

const bot = {
  id: '1a2b3c4d-0000-4000-8000-000000000000',
  name: 'rejilla',
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  strategy: 'GRID_CLASSIC',
  dry_run: true,
  leverage: 1,
  margin_mode: 'ISOLATED',
  config_version: 1,
  total_investment: { toString: () => '1000' },
};

const db = {
  bot: { findUnique: jest.fn().mockResolvedValue(bot) },
  botConfigRevision: {
    findFirst: jest.fn().mockResolvedValue({ config: {}, version: 1 }),
  },
  backtestRun: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
  },
  backtestFill: { createMany: jest.fn(), findMany: jest.fn() },
};

const cache = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  setnx: jest.fn().mockResolvedValue(true),
  getDel: jest.fn().mockResolvedValue(null),
};

const markets = {
  getSpec: jest.fn().mockResolvedValue({ base: 'BTC', symbol: 'BTC' }),
};
const config = { get: () => undefined };

const svc = () =>
  new BacktestsService(
    db as never,
    cache as never,
    markets as never,
    config as never,
  );

const dto = (over: Partial<CreateBacktestDto> = {}): CreateBacktestDto => ({
  botId: bot.id,
  source: BacktestSource.BINANCE,
  interval: '1h',
  fromMs: Date.now() - 100 * SPAN_1H,
  toMs: Date.now(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.bot.findUnique.mockResolvedValue(bot);
  cache.setnx.mockResolvedValue(true);
});

describe('BacktestsService — fuentes', () => {
  it('publica las dos fuentes con sus intervalos', () => {
    const s = svc().sources();
    expect(s.map((x) => x.id).sort()).toEqual(['BINANCE', 'BYBIT']);
  });

  it('Bybit NO ofrece los intervalos que no tiene', () => {
    // `8h` y `3d` no existen allí; ofrecerlos y fallar después sería peor.
    const bybit = svc()
      .sources()
      .find((x) => x.id === BacktestSource.BYBIT)!;
    expect(bybit.intervals).not.toContain('8h');
  });

  it('ninguna fuente ofrece 1m ni intervalos largos', () => {
    // `1m` son 43 200 barras en treinta días y aporta poco sobre 5m. `1w` y
    // `1M` son tan largos que la hipótesis intrabarra deja de significar nada.
    for (const s of svc().sources()) {
      expect(s.intervals).not.toContain('1m');
      expect(s.intervals).not.toContain('1w');
      expect(s.intervals).not.toContain('1M');
    }
  });

  it('las velas de índice no existen: solo contado y perpetuos', () => {
    for (const s of svc().sources()) {
      expect(s.marketTypes).not.toContain(SourceMarketType.INDEX);
    }
  });
});

describe('BacktestsService — validación', () => {
  it('un bot que no existe es 404', async () => {
    db.bot.findUnique.mockResolvedValue(null);
    await expect(svc().run(dto(), 'admin')).rejects.toThrow(/no existe/);
  });

  it('un bot REAL se rechaza: el backtest es solo para simulación', async () => {
    // Sobre un bot real, el resultado invitaría a compararlo con su histórico de
    // verdad, y no son lo mismo: aquí no hay libro, ni funding, ni las otras
    // posiciones de la cuenta.
    db.bot.findUnique.mockResolvedValue({ ...bot, dry_run: false });
    await expect(svc().run(dto(), 'admin')).rejects.toThrow(/simulación/);
  });

  it('un rango invertido se rechaza', async () => {
    const ahora = Date.now();
    await expect(
      svc().run(dto({ fromMs: ahora, toMs: ahora - SPAN_1H }), 'admin'),
    ).rejects.toThrow(/antes de acabar/);
  });

  it('un rango de menos de diez velas se rechaza', async () => {
    const ahora = Date.now();
    await expect(
      svc().run(dto({ fromMs: ahora - 3 * SPAN_1H, toMs: ahora }), 'admin'),
    ).rejects.toThrow(/demasiado corto/);
  });

  it('pasarse del tope dice QUÉ intervalo sí cabría', async () => {
    // Un «demasiadas velas» a secas obliga al usuario a adivinar.
    const ahora = Date.now();
    const largo = ahora - (MAX_BARS + 5_000) * SPAN_1H;
    await expect(
      svc().run(dto({ fromMs: largo, toMs: ahora }), 'admin'),
    ).rejects.toThrow(/Con velas de/);
  });

  it('un intervalo que la fuente no sirve se rechaza con la lista', async () => {
    await expect(
      svc().run(dto({ source: BacktestSource.BYBIT, interval: '8h' }), 'admin'),
    ).rejects.toThrow(/Disponibles/);
  });

  it('con otro backtest EN CURSO responde 409, no encola', async () => {
    // Dos replays a la vez en el mismo proceso se reparten el bucle de eventos y
    // la API deja de responder a todo lo demás. Quien protege de eso es el
    // cerrojo de proceso, no el de Redis: el de Redis solo extiende la exclusión
    // a las otras réplicas.
    let soltar: (() => void) | null = null;
    (globalThis as { fetch: unknown }).fetch = jest.fn(
      () =>
        new Promise((r) => {
          soltar = () => r({ ok: true, status: 200, json: async () => [] });
        }),
    );

    const s = svc();
    const primero = s.run(dto(), 'admin');
    // Cede el turno para que el primero llegue a tomar el cerrojo.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await expect(s.run(dto(), 'admin')).rejects.toThrow(/en curso/);

    soltar!();
    await expect(primero).rejects.toThrow();
  });

  it('las validaciones baratas NO llegan a tomar el cerrojo', async () => {
    // El orden importa: un rango mal escrito no debe dejar el backtesting
    // bloqueado para los demás mientras el usuario corrige.
    db.bot.findUnique.mockResolvedValue({ ...bot, dry_run: false });
    await expect(svc().run(dto(), 'admin')).rejects.toThrow();
    expect(cache.setnx).not.toHaveBeenCalled();
  });

  it('con Redis caído NO responde 409: el cerrojo de proceso basta', async () => {
    // `CacheService.setnx` devuelve `false` tanto si la clave existe como si
    // Redis no está listo. Fiándolo todo a él, una caída de Redis se convertía
    // en un «ya hay uno en curso» permanente y falso, con nada corriendo.
    cache.setnx.mockResolvedValue(false);
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    // Llega hasta la descarga —que es donde falla por falta de velas— en vez de
    // rebotar con un 409.
    await expect(svc().run(dto(), 'admin')).rejects.toThrow(
      /no tiene histórico/,
    );
  });

  it('el cerrojo se suelta si la ejecución falla una vez tomado', async () => {
    // Si no, un fallo dejaría el backtesting bloqueado hasta que caducara el TTL
    // de tres minutos.
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    await expect(svc().run(dto(), 'admin')).rejects.toThrow(
      /no tiene histórico/,
    );
    expect(cache.setnx).toHaveBeenCalled();
    expect(cache.getDel).toHaveBeenCalledWith('lock:backtest:run');
  });
});
