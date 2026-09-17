import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DEFAULTS_CANAL } from '@crypton/strategy-core';
import { AiChannelEstadoService, decisionDe, lazoDe } from './ai-channel-estado.service';

/**
 * Lo que la consola enseña del canal con IA (spec 059, CA-6).
 *
 * Sobre bots propios y del canal; el interruptor global se comprueba leyendo
 * lo escrito; y los contadores de otro día no se hacen pasar por los de hoy.
 */

const ADMIN = 'admin-1';
const BOT = '33333333-3333-4333-8333-333333333333';
const HOY = Math.floor(Date.now() / 86_400_000) * 86_400_000;

function montar(o: { bot?: Record<string, unknown> | null; redisCaido?: boolean } = {}) {
  const redis = new Map<string, string>();
  const bot =
    o.bot === null
      ? null
      : {
          id: BOT,
          user_id: ADMIN,
          strategy: 'AI_CHANNEL',
          venue: 'HYPERLIQUID',
          config_version: 2,
          ...o.bot,
        };
  const db = {
    bot: {
      findUnique: jest.fn(async () => bot),
      findMany: jest.fn(async () => []),
    },
    botAiLoop: { findUnique: jest.fn(async () => null) },
    botAiIntent: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async (): Promise<Record<string, unknown> | null> => null),
    },
    botConfigRevision: {
      findUnique: jest.fn(async () => ({
        config: { ...DEFAULTS_CANAL, totalInvestment: '2000', maxDailyLossPct: '5' },
      })),
    },
    botCycle: {
      aggregate: jest.fn(async () => ({ _sum: { realized_pnl: '-30' }, _count: { _all: 3 } })),
      findMany: jest.fn(async () => [
        { realized_pnl: '-10' },
        { realized_pnl: '-25' },
        { realized_pnl: '5' },
      ]),
    },
  };
  const cache = {
    getTextoOrThrow: jest.fn(async (clave: string) => {
      if (o.redisCaido) throw new Error('Redis no responde');
      return redis.get(clave) ?? null;
    }),
    set: jest.fn(async (clave: string, valor: unknown) => {
      if (!o.redisCaido) redis.set(clave, JSON.stringify(valor));
    }),
    del: jest.fn(async (clave: string) => {
      if (!o.redisCaido) redis.delete(clave);
    }),
  };
  const canal = {
    encendido: true,
    modeloId: 'anthropic/claude-sonnet-5',
    soloSombra: false,
    limiteBot: 48,
    limiteGlobal: 400,
  };
  const servicio = new AiChannelEstadoService(db as never, cache as never, canal as never);
  return { servicio, db, cache, redis };
}

const fila = (extra: Record<string, unknown> = {}) => ({
  id: 'int-1',
  bar_t: new Date(1_760_000_300_000),
  created_at: new Date(1_760_000_310_000),
  estado: 'DECIDIDA',
  origen: 'IA',
  motivo: null,
  candidato_id: 'REB-L-H1',
  decision: {
    veredicto: 'OPERAR',
    opcion: 'REB-L-H1',
    stop: 'NORMAL',
    objetivo: 'MEDIA',
    apalancamiento: 'BAJA',
    tamano: 'MEDIO',
    confianza: 'MEDIA',
    respuesta: {
      veredicto: 'OPERAR',
      opcion: 'A',
      stop: 'NORMAL',
      objetivo: 'MEDIA',
      apalancamiento: 'BAJA',
      tamano: 'COMPLETO',
      confianza: 'MEDIA',
      motivos: ['CANAL_CLARO'],
      riesgos: [],
      texto: 'Bien.',
    },
  },
  plan: null,
  modelo: 'm',
  prompt_version: 'canal-v1-x',
  latencia_ms: 900,
  coste: '0.0120000000',
  ...extra,
});

describe('AiChannelEstadoService: los interruptores', () => {
  it('el servidor, el global de entradas y las llamadas de hoy', async () => {
    const m = montar();
    const dia = new Date().toISOString().slice(0, 10);
    m.redis.set(`ai:quota-canal:global:${dia}`, '17');
    await expect(m.servicio.interruptores()).resolves.toEqual({
      encendido: true,
      modelo: 'anthropic/claude-sonnet-5',
      soloSombra: false,
      entradas: 'ABIERTAS',
      limiteBot: 48,
      limiteGlobal: 400,
      llamadasGlobalesHoy: 17,
    });
    m.redis.set('crypton:ai-channel:entries', 'off');
    m.redis.delete(`ai:quota-canal:global:${dia}`);
    await expect(m.servicio.interruptores()).resolves.toMatchObject({
      entradas: 'CERRADAS',
      llamadasGlobalesHoy: 0,
    });
  });

  it('un contador ilegible cuenta cero', async () => {
    const m = montar();
    const dia = new Date().toISOString().slice(0, 10);
    for (const basura of ['abc', '-3', '2.5']) {
      m.redis.set(`ai:quota-canal:global:${dia}`, basura);
      await expect(m.servicio.interruptores()).resolves.toMatchObject({ llamadasGlobalesHoy: 0 });
    }
  });

  it('sin Redis, desconocido', async () => {
    const m = montar({ redisCaido: true });
    await expect(m.servicio.interruptores()).resolves.toMatchObject({
      entradas: 'DESCONOCIDO',
      llamadasGlobalesHoy: null,
    });
  });

  it('cortar y abrir, comprobando lo escrito', async () => {
    const m = montar();
    await expect(m.servicio.fijarEntradas(false)).resolves.toMatchObject({ entradas: 'CERRADAS' });
    // La consola lo escribe como JSON; el worker lo lee igual.
    expect(m.redis.get('crypton:ai-channel:entries')).toBe('"off"');
    await expect(m.servicio.fijarEntradas(true)).resolves.toMatchObject({ entradas: 'ABIERTAS' });
    expect(m.redis.has('crypton:ai-channel:entries')).toBe(false);
  });

  it('sin Redis, o si lo escrito no quedó, 503', async () => {
    const caido = montar({ redisCaido: true });
    await expect(caido.servicio.fijarEntradas(false)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const terco = montar();
    terco.cache.set.mockImplementation(async () => undefined);
    await expect(terco.servicio.fijarEntradas(false)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const pegado = montar();
    pegado.redis.set('crypton:ai-channel:entries', 'off');
    pegado.cache.del.mockImplementation(async () => undefined);
    await expect(pegado.servicio.fijarEntradas(true)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('AiChannelEstadoService: los bots', () => {
  it('el resumen: solo los del canal del administrador, con su lazo y su última decisión', async () => {
    const m = montar();
    m.db.bot.findMany.mockResolvedValue([
      {
        id: BOT,
        name: 'canal 1',
        symbol: 'SOL',
        venue: 'HYPERLIQUID',
        status: 'RUNNING',
        dry_run: true,
        ai_loop: {
          fallos: 1,
          pausado_hasta: null,
          ultimo_error: 'MODELO:HTTP',
          dia: new Date(HOY),
          llamadas_hoy: 4,
          coste_hoy: '0.04',
        },
        ai_intents: [{ estado: 'SIN_ENTRADA', motivo: 'NO_OPERAR', created_at: new Date(5) }],
      },
      {
        id: 'otro',
        name: 'canal 2',
        symbol: 'BTC',
        venue: 'ASTER',
        status: 'STOPPED',
        dry_run: false,
        ai_loop: null,
        ai_intents: [],
      },
    ] as never);
    const r = await m.servicio.resumen(ADMIN);
    // El doble no resuelve relaciones: la «última» decisión es la que pide la consulta.
    expect(m.db.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { user_id: ADMIN, strategy: 'AI_CHANNEL' },
        select: expect.objectContaining({
          ai_loop: true,
          ai_intents: expect.objectContaining({ orderBy: { created_at: 'desc' }, take: 1 }),
        }),
      }),
    );
    expect(r.bots).toEqual([
      {
        id: BOT,
        name: 'canal 1',
        symbol: 'SOL',
        venue: 'HYPERLIQUID',
        status: 'RUNNING',
        dryRun: true,
        lazo: {
          fallos: 1,
          pausadoHasta: null,
          ultimoError: 'MODELO:HTTP',
          llamadasHoy: 4,
          costeHoy: '0.04',
        },
        ultima: { estado: 'SIN_ENTRADA', motivo: 'NO_OPERAR', creadaEn: new Date(5).toISOString() },
      },
      expect.objectContaining({
        id: 'otro',
        lazo: { fallos: 0, pausadoHasta: null, ultimoError: null, llamadasHoy: 0, costeHoy: '0' },
        ultima: null,
      }),
    ]);
    expect(r.interruptores.entradas).toBe('ABIERTAS');
  });

  it('un bot ajeno es 403; uno que no existe o no es del canal, 404', async () => {
    const ajeno = montar({ bot: { user_id: 'otra' } });
    await expect(ajeno.servicio.estado(ADMIN, BOT)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ajeno.servicio.decisiones(ADMIN, BOT, undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(ajeno.servicio.detalle(ADMIN, BOT, 'int-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ajeno.db.botAiIntent.findMany).not.toHaveBeenCalled();

    const nada = montar({ bot: null });
    await expect(nada.servicio.estado(ADMIN, BOT)).rejects.toBeInstanceOf(NotFoundException);
    const rejilla = montar({ bot: { strategy: 'GRID_CLASSIC' } });
    await expect(rejilla.servicio.estado(ADMIN, BOT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el estado: el lazo, el día y las últimas cinco decisiones', async () => {
    const m = montar();
    m.db.botAiIntent.findMany.mockResolvedValue([fila()] as never);
    const e = await m.servicio.estado(ADMIN, BOT);
    expect(e.botId).toBe(BOT);
    expect(e.lazo).toEqual({
      fallos: 0,
      pausadoHasta: null,
      ultimoError: null,
      llamadasHoy: 0,
      costeHoy: '0',
    });
    // 30 de pérdida sobre 2000 = 1,5 %, con un tope del 5 %; la racha son dos.
    expect(e.hoy).toEqual({
      operaciones: 3,
      realizado: '-30',
      perdidaPct: 1.5,
      topePct: 5,
      topeOperaciones: DEFAULTS_CANAL.maxTradesPerDay,
      rachaPerdidas: 2,
    });
    expect(m.db.botCycle.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bot_id: BOT, closed_at: { gte: new Date(HOY) } },
      }),
    );
    // Las consultas que el doble no interpreta: la revisión vigente, la racha
    // desde el último cierre y las decisiones de la más reciente hacia atrás.
    expect(m.db.botConfigRevision.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bot_id_version: { bot_id: BOT, version: 2 } } }),
    );
    expect(m.db.botCycle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bot_id: BOT, closed_at: { not: null } },
        orderBy: { seq: 'desc' },
        take: 50,
      }),
    );
    expect(m.db.botAiIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bot_id: BOT },
        orderBy: { created_at: 'desc' },
        take: 5,
      }),
    );
    expect(e.decisiones).toHaveLength(1);
  });

  it('un día en ganancias no es una pérdida', async () => {
    const m = montar();
    m.db.botCycle.aggregate.mockResolvedValue({
      _sum: { realized_pnl: '12.5' },
      _count: { _all: 1 },
    });
    m.db.botCycle.findMany.mockResolvedValue([]);
    const e = await m.servicio.estado(ADMIN, BOT);
    expect(e.hoy).toMatchObject({ realizado: '12.5', perdidaPct: 0, rachaPerdidas: 0 });
  });

  it('las decisiones, paginadas por fecha', async () => {
    const m = montar();
    await m.servicio.decisiones(ADMIN, BOT, '2026-09-17T10:00:00.000Z', 7);
    expect(m.db.botAiIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bot_id: BOT, created_at: { lt: new Date('2026-09-17T10:00:00.000Z') } },
        orderBy: { created_at: 'desc' },
        take: 7,
      }),
    );
    await m.servicio.decisiones(ADMIN, BOT, undefined);
    expect(m.db.botAiIntent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { bot_id: BOT }, take: 20 }),
    );
  });

  it('el detalle lleva la herramienta, y solo del bot pedido', async () => {
    const m = montar();
    await expect(m.servicio.detalle(ADMIN, BOT, 'int-9')).rejects.toBeInstanceOf(NotFoundException);
    expect(m.db.botAiIntent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'int-9', bot_id: BOT } }),
    );
    m.db.botAiIntent.findFirst.mockResolvedValue({ ...fila(), snapshot: { version: 1 } });
    await expect(m.servicio.detalle(ADMIN, BOT, 'int-1')).resolves.toMatchObject({
      id: 'int-1',
      herramienta: { version: 1 },
    });
  });
});

describe('las vistas', () => {
  it('lazoDe: los contadores de otro día cuentan cero', () => {
    const ayer = {
      fallos: 2,
      pausado_hasta: new Date(9),
      ultimo_error: 'x',
      dia: new Date(HOY - 86_400_000),
      llamadas_hoy: 9,
      coste_hoy: '0.9',
    };
    expect(lazoDe(ayer, HOY + 1000)).toEqual({
      fallos: 2,
      pausadoHasta: new Date(9).toISOString(),
      ultimoError: 'x',
      llamadasHoy: 0,
      costeHoy: '0',
    });
    expect(lazoDe({ ...ayer, dia: new Date(HOY) }, HOY + 1000)).toMatchObject({
      llamadasHoy: 9,
      costeHoy: '0.9',
    });
    expect(lazoDe({ ...ayer, dia: null }, HOY)).toMatchObject({ llamadasHoy: 0 });
  });

  it('decisionDe: la elección, la respuesta, el fallo y el coste sin ceros de más', () => {
    const v = decisionDe(fila());
    expect(v).toMatchObject({
      id: 'int-1',
      barT: new Date(1_760_000_300_000).toISOString(),
      estado: 'DECIDIDA',
      eleccion: { opcion: 'REB-L-H1', tamano: 'MEDIO' },
      respuesta: { opcion: 'A', texto: 'Bien.' },
      plan: null,
      fallo: null,
      coste: '0.012',
      promptVersion: 'canal-v1-x',
      latenciaMs: 900,
    });
    const fallida = decisionDe(
      fila({ estado: 'FALLIDA', motivo: 'MODELO', decision: { fallo: 'TIEMPO' }, coste: null }),
    );
    expect(fallida).toMatchObject({
      eleccion: null,
      respuesta: null,
      fallo: 'TIEMPO',
      coste: null,
    });
  });
});
