import { Prisma } from '@crypton/db';
import { FRESH_MS, PortfolioSnapshotsService } from './portfolio-snapshots.service';
import type { PortfolioSource } from './portfolio-aggregate';

/**
 * El cron de la cartera, por la parte que puede hacer daño (spec 003, R-3, R-9).
 *
 * No se prueba el SQL —eso lo dirá la base— sino las decisiones: que sin cerrojo
 * no escriba, que apagado ni lo intente, que escriba UNA fila por (usuario, red)
 * con el instante de la pasada, que el corte de frescura sea el declarado, y
 * que un fallo de la base se quede aquí en vez de subir hasta el motor.
 */

const T0 = new Date('2026-09-05T12:00:00.000Z');
const dec = (v: string) => ({ toString: () => v });

const fuente = (o: Partial<PortfolioSource> & { bot_id: string }): PortfolioSource => ({
  user_id: 'u1',
  testnet: false,
  dry_run: false,
  total_investment: dec('100'),
  realized_pnl_acc: dec('1'),
  unrealized_pnl: dec('0'),
  position_qty: dec('0'),
  average_entry: null,
  ...o,
});

function montar(opts: { cerrojo?: boolean; enable?: string; fuentes?: PortfolioSource[] } = {}) {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const db = {
    $queryRaw: jest.fn().mockResolvedValue(opts.fuentes ?? []),
    portfolioSnapshot: { createMany },
  };
  const leases = { tryLock: jest.fn().mockResolvedValue(opts.cerrojo ?? true) };
  const config = {
    get: (k: string, d?: string) => (k === 'PORTFOLIO_SNAPSHOTS_ENABLE' ? (opts.enable ?? d) : d),
  };
  const service = new PortfolioSnapshotsService(db as never, leases as never, config as never);
  return { service, db, createMany, leases };
}

describe('PortfolioSnapshotsService', () => {
  it('sin cerrojo no consulta ni escribe: otra réplica ya está en ello', async () => {
    const { service, db, createMany } = montar({ cerrojo: false });
    await service.tick();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('apagado por variable ni siquiera intenta el cerrojo', async () => {
    const { service, leases, db } = montar({ enable: 'false' });
    await service.tick();
    expect(leases.tryLock).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('por defecto está encendido', async () => {
    const { service, leases } = montar();
    await service.tick();
    expect(leases.tryLock).toHaveBeenCalledWith('portfolio-snapshots', expect.any(Number));
  });

  it('escribe una fila por (usuario, red), todas con el instante de la pasada', async () => {
    const { service, createMany } = montar({
      fuentes: [
        fuente({ bot_id: 'a', realized_pnl_acc: dec('0.1') }),
        fuente({ bot_id: 'b', realized_pnl_acc: dec('0.2') }),
        fuente({ bot_id: 'c', testnet: true, realized_pnl_acc: dec('5') }),
      ],
    });
    expect(await service.snapshot(T0)).toBe(2);
    const { data } = createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
    expect(data).toEqual([
      expect.objectContaining({ user_id: 'u1', testnet: false, pnl: '0.3', bots: 2, taken_at: T0 }),
      expect.objectContaining({ user_id: 'u1', testnet: true, pnl: '5', bots: 1, taken_at: T0 }),
    ]);
  });

  it('sin snapshots recientes no escribe nada: la curva se rompe ahí', async () => {
    const { service, createMany } = montar({ fuentes: [] });
    expect(await service.snapshot(T0)).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('el corte de frescura son dos cadencias, viaja como parámetro y los simulados se filtran en el SQL', async () => {
    const { service, db } = montar();
    await service.snapshot(T0);
    const sql = db.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toContainEqual(new Date(T0.getTime() - FRESH_MS));
    expect(FRESH_MS).toBe(10 * 60_000);
    expect(sql.sql).toMatch(/DISTINCT ON \(s\.bot_id\)/);
    expect(sql.sql).toMatch(/dry_run = false/);
  });

  it('un fallo de la base se registra y no sube: nada de esto toca a un runner', async () => {
    const { service, db } = montar();
    db.$queryRaw.mockRejectedValue(new Error('conexión perdida'));
    await expect(service.tick()).resolves.toBeUndefined();
  });
});
