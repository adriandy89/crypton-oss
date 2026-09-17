import { BacktestSource, SourceMarketType, StrategyKind, Venue } from '@crypton/shared';
import {
  HORAS_CALENTAMIENTO,
  MERCADO_CANAL,
  configCanal,
  mercadoCanal,
} from '@crypton/backtest/dist/testing-canal';
import {
  BacktestsService,
  MAX_BARS,
  barrasDeCalentamiento,
  serieImposible,
} from './backtests.service';
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
  bot: { findFirst: jest.fn().mockResolvedValue(bot) },
  botConfigRevision: { findFirst: jest.fn().mockResolvedValue({ config: {}, version: 1 }) },
  backtestRun: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
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
  new BacktestsService(db as never, cache as never, markets as never, config as never);

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
  db.bot.findFirst.mockResolvedValue(bot);
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

describe('BacktestsService — propiedad (spec 004)', () => {
  it('el bot se busca SIEMPRE con el usuario: el de otro es un 404, no un 403', async () => {
    db.bot.findFirst.mockResolvedValue(null);
    await expect(svc().run(dto(), 'u1')).rejects.toThrow(/no existe/);
    const where = db.bot.findFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toEqual({ id: bot.id, user_id: 'u1' });
  });

  it('la lista es solo del usuario, con o sin filtro de bot', async () => {
    db.backtestRun.findMany.mockResolvedValue([]);
    await svc().list('u1', {});
    await svc().list('u1', { botId: bot.id });
    const wheres = db.backtestRun.findMany.mock.calls.map(
      (c) => (c[0] as { where: unknown }).where,
    );
    expect(wheres).toEqual([{ requested_by: 'u1' }, { requested_by: 'u1', bot_id: bot.id }]);
  });

  it('el detalle y las ejecuciones de otro son 404, y el borrado de otro no borra nada', async () => {
    db.backtestRun.findFirst.mockResolvedValue(null);
    await expect(svc().detail('u1', 'run-ajeno')).rejects.toThrow(/no existe/);
    await expect(svc().fills('u1', 'run-ajeno')).rejects.toThrow(/no existe/);
    expect(db.backtestFill.findMany).not.toHaveBeenCalled();
    await svc().remove('u1', 'run-ajeno');
    expect(db.backtestRun.deleteMany).toHaveBeenCalledWith({
      where: { id: 'run-ajeno', requested_by: 'u1' },
    });
  });
});

describe('BacktestsService — validación', () => {
  it('un bot que no existe es 404', async () => {
    db.bot.findFirst.mockResolvedValue(null);
    await expect(svc().run(dto(), 'admin')).rejects.toThrow(/no existe/);
  });

  it('un bot REAL se rechaza: el backtest es solo para simulación', async () => {
    // Sobre un bot real, el resultado invitaría a compararlo con su histórico de
    // verdad, y no son lo mismo: aquí no hay libro, ni funding, ni las otras
    // posiciones de la cuenta.
    db.bot.findFirst.mockResolvedValue({ ...bot, dry_run: false });
    await expect(svc().run(dto(), 'admin')).rejects.toThrow(/simulación/);
  });

  it('un rango invertido se rechaza', async () => {
    const ahora = Date.now();
    await expect(svc().run(dto({ fromMs: ahora, toMs: ahora - SPAN_1H }), 'admin')).rejects.toThrow(
      /antes de acabar/,
    );
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
    await expect(svc().run(dto({ fromMs: largo, toMs: ahora }), 'admin')).rejects.toThrow(
      /Con velas de/,
    );
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
    db.bot.findFirst.mockResolvedValue({ ...bot, dry_run: false });
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
    await expect(svc().run(dto(), 'admin')).rejects.toThrow(/no tiene histórico/);
  });

  it('el cerrojo se suelta si la ejecución falla una vez tomado', async () => {
    // Si no, un fallo dejaría el backtesting bloqueado hasta que caducara el TTL
    // de tres minutos.
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    await expect(svc().run(dto(), 'admin')).rejects.toThrow(/no tiene histórico/);
    expect(cache.setnx).toHaveBeenCalled();
    expect(cache.getDel).toHaveBeenCalledWith('lock:backtest:run');
  });
});

/**
 * Spec 058. El canal con IA decide con series que empiezan antes del rango: el
 * backtest las descarga, avisa de que decide el juez y devuelve las cifras por
 * setup, en todo el rango y por tramos.
 */
describe('BacktestsService — el canal con IA', () => {
  const CINCO = 300_000;
  const canal = { ...bot, name: 'canal', strategy: StrategyKind.AI_CHANNEL, leverage: 20 };

  it('el calentamiento es la serie más larga, con un cubo de margen, en velas reproducidas', () => {
    // 480 velas de 1 h y una de margen, en velas de 5 min: la serie de 15 min
    // (1000 velas, unas 250 h) se queda corta a su lado.
    expect(barrasDeCalentamiento(StrategyKind.AI_CHANNEL, configCanal(), '5m')).toBe(481 * 12);
    // Las estrategias sin series no piden nada.
    expect(barrasDeCalentamiento(StrategyKind.GRID_CLASSIC, {} as never, '5m')).toBe(0);
  });

  it('un intervalo con el que no se construyen sus series se rechaza antes de descargar', async () => {
    expect(serieImposible(StrategyKind.AI_CHANNEL, configCanal(), '15m')).toBe('5m');
    expect(serieImposible(StrategyKind.AI_CHANNEL, configCanal(), '5m')).toBeNull();
    expect(serieImposible(StrategyKind.GRID_CLASSIC, {} as never, '1h')).toBeNull();

    db.bot.findFirst.mockResolvedValue(canal);
    db.botConfigRevision.findFirst.mockResolvedValue({ config: configCanal(), version: 1 });
    await expect(svc().run(dto({ interval: '15m' }), 'admin')).rejects.toThrow(
      /velas de 5m.*Reprodúcelo en 5m/,
    );
    expect(cache.setnx).not.toHaveBeenCalled();
  });

  it('descarga el calentamiento, avisa del juez y devuelve las cifras por setup y por tramos', async () => {
    const sinteticas = mercadoCanal({ horasRango: 60 });
    // La fuente deja de paginar en la primera página vacía, como Binance antes
    // del listado: lo anterior a la serie sintética se rellena, plano.
    const relleno = Array.from({ length: 2400 }, (_, i) => ({
      t: sinteticas[0].t - (2400 - i) * CINCO,
      o: '100',
      h: '100.05',
      l: '99.95',
      c: '100',
      v: '10',
    }));
    const velas = [...relleno, ...sinteticas];
    const desde = sinteticas[HORAS_CALENTAMIENTO * 12].t;
    const hasta = velas[velas.length - 1].t + CINCO;
    const paginas: { startMs: number; endMs: number }[] = [];
    const proveedor = {
      id: BacktestSource.BINANCE,
      intervals: ['5m'],
      marketTypes: [SourceMarketType.PERP],
      maxBarsPerRequest: 1500,
      symbolFor: () => 'SOLUSDT',
      page: jest.fn(async (q: { startMs: number; endMs: number; limit: number }) => {
        paginas.push(q);
        return velas.filter((v) => v.t >= q.startMs && v.t < q.endMs).slice(0, q.limit);
      }),
    };
    db.bot.findFirst.mockResolvedValue(canal);
    db.botConfigRevision.findFirst.mockResolvedValue({ config: configCanal(), version: 1 });
    db.backtestRun.create.mockResolvedValue({ id: 'run-1' });
    db.backtestFill.createMany.mockResolvedValue({ count: 0 });
    markets.getSpec.mockResolvedValue(MERCADO_CANAL);
    const s = svc();
    (s as unknown as { providers: Record<string, unknown> }).providers[BacktestSource.BINANCE] =
      proveedor;

    const r = await s.run(
      dto({ interval: '5m', fromMs: desde, toMs: hasta, ventanasConsecutivas: 2 }),
      'admin',
    );

    // Primero el rango y luego lo de antes, que llega hasta su primera vela.
    expect(Math.min(...paginas.map((p) => p.startMs))).toBeLessThan(desde);
    expect(paginas.filter((p) => p.startMs < desde).every((p) => p.endMs <= desde)).toBe(true);
    expect(r.metrics.bars).toBe(sinteticas.length - HORAS_CALENTAMIENTO * 12);
    expect(r.warnings.some((w) => w.includes('decide el juez de reglas'))).toBe(true);

    expect(r.operaciones!.length).toBeGreaterThan(0);
    expect(new Set(r.porSetup!.map((x) => `${x.setup}|${x.lado}`))).toEqual(
      new Set(['REBOTE|LONG', 'REBOTE|SHORT']),
    );
    expect(r.ventanas).toHaveLength(2);
    expect(r.ventanas![0].desde).toBe(desde);
    expect(r.ventanas![1].hasta).toBe(hasta);
    expect(r.ventanas!.reduce((n, v) => n + v.operaciones, 0)).toBe(r.operaciones!.length);

    // Y se guardan con el run, dentro de sus métricas.
    const guardado = db.backtestRun.create.mock.calls[0][0] as {
      data: { metrics: Record<string, unknown> };
    };
    expect(guardado.data.metrics).toMatchObject({
      porSetup: r.porSetup,
      ventanas: r.ventanas,
      operaciones: r.operaciones,
    });
    // La descarga espera entre páginas y el replay recorre seiscientas velas.
  }, 30_000);
});
