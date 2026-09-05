import { Prisma } from '@crypton/db';
import { PORTFOLIO_CADENCE_MS } from '@crypton/shared';
import { PortfolioService } from './portfolio.service';

/**
 * La curva de la cartera, por la parte que puede mentir (spec 003, R-6).
 *
 * Como en `bot-series.service.spec.ts`: no se prueba la sintaxis de Postgres
 * sino las decisiones. Que el filtro por usuario y red viaje como parámetro y
 * SIEMPRE, que el cubo salga para cuatro filas por cubo, que las filas se
 * traduzcan al contrato con el dinero en cadena, que el corte de retención
 * salga de la variable y que un minuto de caché sea un minuto.
 */

const HORA = 3_600_000;
const DIA = 24 * HORA;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % HORA);

function fakeCache() {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: unknown) => {
      store.set(k, v);
      return Promise.resolve();
    }),
  };
}

const dec = (v: string) => ({ toString: () => v });

const fila = (t: number, pnl: string, bots = 2) => ({
  id: 1n,
  user_id: 'u1',
  testnet: false,
  realized: dec(pnl),
  unrealized: dec('0'),
  pnl: dec(pnl),
  invested: dec('1000'),
  exposure: dec('250.5'),
  bots,
  taken_at: new Date(t),
});

function build(rows: unknown[] = [], retentionDays = '365') {
  const cache = fakeCache();
  const db = { $queryRaw: jest.fn().mockResolvedValue(rows) };
  const config = {
    get: (k: string, d?: unknown) => (k === 'RETENTION_PORTFOLIO_DAYS' ? retentionDays : d),
  };
  const service = new PortfolioService(db as never, cache as never, config as never);
  return { service, db, cache };
}

const ultimaSql = (db: { $queryRaw: jest.Mock }): Prisma.Sql =>
  db.$queryRaw.mock.calls[0][0] as Prisma.Sql;

describe('PortfolioService.equity', () => {
  it('filtra por usuario y red como parámetros, nunca pegados en la cadena', async () => {
    const { service, db } = build();
    await service.equity('u1', '7d', true, T0);
    const sql = ultimaSql(db);
    expect(sql.values).toContain('u1');
    expect(sql.values).toContain(true);
    expect(sql.sql).not.toContain('u1');
    expect(sql.sql).toMatch(/user_id = /);
    expect(sql.sql).toMatch(/testnet = /);
  });

  it('dimensiona el cubo para cuatro filas por cubo: un año son 120 cubos de 73 h', async () => {
    const { service, db } = build();
    const serie = await service.equity('u1', '1y', false, T0);
    expect(serie.bucketMs).toBe(73 * HORA);
    expect(ultimaSql(db).values).toContain(73 * HORA);
    // 7 d en 120 cubos son cubos de 84 min, como la serie de un bot.
    expect((await build().service.equity('u1', '7d', false, T0)).bucketMs).toBe(84 * 60_000);
  });

  it('traduce las filas al contrato: dinero en cadena, tiempo en ms, de más viejo a más nuevo', async () => {
    const { service } = build([fila(T0 - DIA, '-1.5'), fila(T0 - HORA, '2.25', 3)]);
    const serie = await service.equity('u1', '7d', false, T0);
    expect(serie.points).toEqual([
      {
        t: T0 - DIA,
        realized: '-1.5',
        unrealized: '0',
        pnl: '-1.5',
        invested: '1000',
        exposure: '250.5',
        bots: 2,
      },
      expect.objectContaining({ t: T0 - HORA, pnl: '2.25', bots: 3 }),
    ]);
    expect(serie.range).toBe('7d');
    expect(serie.from).toBe(T0 - 7 * DIA);
    expect(serie.to).toBe(T0);
    expect(serie.cadenceMs).toBe(PORTFOLIO_CADENCE_MS);
  });

  it('el corte de retención sale de la variable, y con 0 es null', async () => {
    expect((await build([], '365').service.equity('u1', '24h', false, T0)).retentionFrom).toBe(
      T0 - 365 * DIA,
    );
    expect((await build([], '0').service.equity('u1', '24h', false, T0)).retentionFrom).toBeNull();
    expect((await build([], 'x').service.equity('u1', '24h', false, T0)).retentionFrom).toBeNull();
  });

  it('cachea un minuto por usuario, red y ventana', async () => {
    const { service, db, cache } = build([fila(T0 - HORA, '1')]);
    const a = await service.equity('u1', '24h', false, T0);
    const b = await service.equity('u1', '24h', false, T0 + 30_000);
    expect(b).toEqual(a);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^portfolio:equity:u1:m:24h:/),
      a,
      60,
    );
    // Otra red es otra clave y otra consulta.
    await service.equity('u1', '24h', true, T0);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
