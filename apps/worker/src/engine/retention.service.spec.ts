import { RetentionService } from './retention.service';

/**
 * Spec 001, F-39. `bot_commands` crecía con cada comando de usuario para
 * siempre y nadie lo mencionaba; `bot_config_revisions` se conserva a
 * propósito (es el historial de configuración y la revisión vigente vive ahí).
 */
describe('RetentionService', () => {
  const sqlDe = (call: unknown[]): string => (call[0] as readonly string[]).join('?');

  function build(commandDays: number | null = null) {
    const db = { $executeRaw: jest.fn().mockResolvedValue(0) };
    const leases = { tryLock: jest.fn().mockResolvedValue(true) };
    const config = {
      get: (k: string, d: unknown) =>
        k === 'RETENTION_COMMAND_DAYS' && commandDays != null ? commandDays : d,
    };
    return { svc: new RetentionService(db as never, leases as never, config as never), db };
  }

  it('purga los comandos ejecutados y conserva las revisiones de configuración', async () => {
    const { svc, db } = build();

    await svc.purge();

    const sqls = db.$executeRaw.mock.calls.map(sqlDe);
    expect(
      sqls.some((s) => s.includes('bot_commands') && s.includes('executed_at IS NOT NULL')),
    ).toBe(true);
    expect(sqls.some((s) => s.includes('bot_config_revisions'))).toBe(false);
  });

  it('con la retención de comandos a 0 no toca la tabla', async () => {
    const { svc, db } = build(0);

    await svc.purge();

    expect(db.$executeRaw.mock.calls.map(sqlDe).some((s) => s.includes('bot_commands'))).toBe(
      false,
    );
  });
});
