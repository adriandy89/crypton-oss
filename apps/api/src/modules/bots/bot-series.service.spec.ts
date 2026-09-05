import { Prisma } from '@crypton/db';
import { SERIES_POINTS } from '@crypton/shared';
import { BotSeriesService, SPARK_POINTS } from './bot-series.service';

/**
 * El primer SQL crudo de la API, por la parte que puede mentir.
 *
 * Lo que se comprueba no es la sintaxis de Postgres —eso lo dira la base al
 * arrancar— sino las decisiones que un test puede fijar: el tamano del cubo
 * (dimensionado para cuatro filas por cubo, no para una), que los parametros
 * viajen COMO PARAMETROS y no pegados en la cadena, y que las filas se agrupen
 * en el orden en que Postgres las devuelve. La aritmetica del cubo tiene sus
 * propios tests en `packages/shared/src/series.spec.ts`.
 */

const HORA = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % HORA);

/** CacheService de mentira, con la misma forma que el de verdad. */
function fakeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: unknown) => {
      store.set(k, v);
      return Promise.resolve();
    }),
  };
}

const dec = (v: string) => ({ toString: () => v });

function build(rows: unknown[] = []) {
  const cache = fakeCache();
  const db = { $queryRaw: jest.fn().mockResolvedValue(rows) };
  const service = new BotSeriesService(db as never, cache as never);
  return { service, db, cache };
}

/** Los valores parametrizados de la ultima consulta lanzada. */
const valoresDe = (db: { $queryRaw: jest.Mock }): unknown[] => {
  const sql = db.$queryRaw.mock.calls[0][0] as Prisma.Sql;
  return sql.values;
};

describe('BotSeriesService.inRange', () => {
  it('dimensiona el cubo para cuatro filas por cubo: 480 puntos son 120 cubos', async () => {
    // 24 h en 120 cubos son cubos de 12 min. Dimensionarlo para 480 cubos
    // (3 min) devolvia hasta cuatro veces los puntos pedidos.
    const { service, db } = build();
    await service.inRange('bot-1', T0, T0 + 24 * HORA, SERIES_POINTS);
    expect(valoresDe(db)).toContain(12 * 60_000);
  });

  it('parametriza bot, rango y cubo; nunca los pega en la cadena', async () => {
    const { service, db } = build();
    await service.inRange('bot-1', T0, T0 + 24 * HORA);
    const valores = valoresDe(db);
    expect(valores).toContain('bot-1');
    expect(valores).toContainEqual(new Date(T0));
    expect(valores).toContainEqual(new Date(T0 + 24 * HORA));
    const texto = (db.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
    expect(texto).not.toContain('bot-1');
    expect(texto).toMatch(/row_number\(\) OVER/);
    // Una sola proyeccion de la tabla: la misma forma que la rama sin rango.
    expect(texto).toMatch(/SELECT s\.\*/);
  });

  it('recorta el rango al minuto y no consulta un rango vacio', async () => {
    const { service, db } = build();
    // Dos instantes dentro del mismo minuto: no hay serie que pedir.
    expect(await service.inRange('bot-1', T0 + 10_000, T0 + 40_000)).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('cachea un minuto y las peticiones del mismo minuto no vuelven a la base', async () => {
    const filas = [{ id: 1n, bot_id: 'bot-1', equity: dec('5'), taken_at: new Date(T0) }];
    const { service, db, cache } = build(filas);
    const a = await service.inRange('bot-1', T0, T0 + 24 * HORA);
    const b = await service.inRange('bot-1', T0 + 5_000, T0 + 24 * HORA + 30_000);
    expect(a).toEqual(filas);
    expect(b).toEqual(filas);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(expect.stringMatching(/^bots:series:bot-1:/), filas, 60);
  });
});

describe('BotSeriesService.sparks', () => {
  it('sin bots no consulta nada', async () => {
    const { service, db } = build();
    expect(await service.sparks([])).toEqual(new Map());
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('agrupa por bot en el orden temporal que devuelve Postgres', async () => {
    const filas = [
      { bot_id: 'a', equity: dec('1.5') },
      { bot_id: 'a', equity: dec('2.5') },
      { bot_id: 'b', equity: dec('-0.5') },
    ];
    const { service, db } = build(filas);
    const out = await service.sparks(['b', 'a'], T0);
    expect(out.get('a')).toEqual(['1.5', '2.5']);
    expect(out.get('b')).toEqual(['-0.5']);
    // Un bot sin filas no aparece: la pantalla no le pinta un cero plano.
    expect(out.has('c')).toBe(false);
    // Los ids viajan como parametros y ordenados, para que la clave de cache no
    // dependa del orden de la lista.
    expect(valoresDe(db)).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('un punto por hora sobre las ultimas 24 h', async () => {
    const { service, db } = build([]);
    await service.sparks(['a'], T0);
    const valores = valoresDe(db);
    expect(valores).toContain((24 * HORA) / SPARK_POINTS);
    expect(valores).toContainEqual(new Date(T0 - 24 * HORA));
  });

  it('la cache sobrevive como objeto y vuelve como mapa', async () => {
    const { service, db } = build([{ bot_id: 'a', equity: dec('3') }]);
    const primera = await service.sparks(['a'], T0);
    const segunda = await service.sparks(['a'], T0 + 20_000);
    expect(segunda).toEqual(primera);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
