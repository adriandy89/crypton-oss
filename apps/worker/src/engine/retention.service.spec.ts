import { RetentionService } from './retention.service';

/**
 * Spec 001, F-39. `bot_commands` crecía con cada comando de usuario para
 * siempre y nadie lo mencionaba; `bot_config_revisions` se conserva a
 * propósito (es el historial de configuración y la revisión vigente vive ahí).
 */
describe('RetentionService', () => {
  const sqlDe = (call: unknown[]): string => (call[0] as readonly string[]).join('?');

  function build(commandDays: number | null = null, aiDays: number | null = null) {
    const db = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      botAiDecision: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const leases = { tryLock: jest.fn().mockResolvedValue(true) };
    const config = {
      get: (k: string, d: unknown) => {
        if (k === 'RETENTION_COMMAND_DAYS' && commandDays != null) return commandDays;
        if (k === 'RETENTION_AI_DOSSIER_DAYS' && aiDays != null) return aiDays;
        return d;
      },
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

describe('RetentionService — el expediente del Modo IA (spec 046)', () => {
  function build(aiDays: number | null = null) {
    const updateMany = jest.fn().mockResolvedValue({ count: 3 });
    const db = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      botAiDecision: { updateMany },
    };
    const leases = { tryLock: jest.fn().mockResolvedValue(true) };
    const config = {
      get: (k: string, d: unknown) =>
        k === 'RETENTION_AI_DOSSIER_DAYS' && aiDays != null ? aiDays : d,
    };
    return { svc: new RetentionService(db as never, leases as never, config as never), updateMany };
  }

  it('vacia el expediente pero NO borra la fila', async () => {
    // La fila es la unica explicacion posible de por que un bot con dinero
    // dentro cambio de configuracion solo, y eso no caduca. Lo que caduca es el
    // expediente, que son unos kilobytes y pasado un tiempo ya no explica nada
    // que no se lea en el resto de la fila.
    const { svc, updateMany } = build();

    await svc.purge();

    expect(updateMany).toHaveBeenCalledTimes(1);
    const args = updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(args.data)).toEqual(['dossier']);
  });

  it('solo toca las que todavia lo tienen', async () => {
    // Sin el filtro, cada hora se reescribirian las mismas filas ya vaciadas.
    const { svc, updateMany } = build();
    await svc.purge();
    const args = updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where['dossier']).toBeDefined();
    expect(args.where['created_at']).toBeDefined();
  });

  it('a 0 no toca nada', async () => {
    const { svc, updateMany } = build(0);
    await svc.purge();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
