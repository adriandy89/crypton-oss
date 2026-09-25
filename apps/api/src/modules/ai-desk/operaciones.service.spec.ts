import { planDePrueba } from './agentes.fixture-spec';
import { AiDeskOperacionesService } from './operaciones.service';

/**
 * La conciliación de las operaciones con sus bots (spec 074, R-21): lee lo
 * que está en curso, escribe con el estado leído en el `where` —dos réplicas
 * escriben una vez— y una operación que falla no para a las demás.
 */
describe('AiDeskOperacionesService.conciliar', () => {
  const AHORA = Date.parse('2026-09-24T15:00:00Z');
  const cierre = new Date('2026-09-24T14:30:00Z');

  function montar(filas: unknown[]) {
    const db = {
      aiDeskProposal: {
        findMany: jest.fn().mockResolvedValue(filas),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      botEvent: {
        findFirst: jest.fn().mockResolvedValue({ payload: { motivo: 'OBJETIVO', r: 1.5 } }),
      },
    };
    return { svc: new AiDeskOperacionesService(db as never), db };
  }

  const ciclo = (extra: Record<string, unknown> = {}) => ({
    entries_filled: 1,
    qty: '1',
    realized_pnl: '0',
    opened_at: new Date('2026-09-24T12:00:00Z'),
    last_entry_at: new Date('2026-09-24T12:05:00Z'),
    closed_at: null,
    ...extra,
  });

  it('abre lo que entró y cierra lo que salió, con el estado leído en el where', async () => {
    const { svc, db } = montar([
      {
        id: 'p-1',
        state: 'EJECUTANDO',
        opened_at: null,
        plan: planDePrueba(),
        final_plan: null,
        bot_id: 'b-1',
        bot: { status: 'RUNNING', cycles: [ciclo()] },
      },
      {
        id: 'p-2',
        state: 'ABIERTA',
        opened_at: new Date('2026-09-24T12:05:00Z'),
        plan: planDePrueba({ riesgo: '4' }),
        final_plan: planDePrueba({ riesgo: '5' }),
        bot_id: 'b-2',
        bot: { status: 'STOPPED', cycles: [ciclo({ closed_at: cierre, realized_pnl: '7.5' })] },
      },
    ]);
    await expect(svc.conciliar(AHORA)).resolves.toBe(2);
    expect(db.aiDeskProposal.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 'p-1', state: 'EJECUTANDO' },
          data: { state: 'ABIERTA', opened_at: new Date('2026-09-24T12:05:00Z') },
        },
      ],
      [
        {
          where: { id: 'p-2', state: 'ABIERTA' },
          data: expect.objectContaining({
            state: 'CERRADA',
            exit: 'OBJETIVO',
            realized_pnl: '7.5',
            // Sobre el riesgo del plan APROBADO, no del propuesto.
            r_real: '1.5',
          }),
        },
      ],
    ]);
    // El motivo de la salida solo se busca para lo que ha salido.
    expect(db.botEvent.findFirst).toHaveBeenCalledTimes(1);
    expect(db.botEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bot_id: 'b-2', type: 'AGENT_EXIT' } }),
    );
  });

  it('solo la de un bot, cuando avisa el worker', async () => {
    const { svc, db } = montar([]);
    await svc.conciliar(AHORA, 'b-9');
    expect(db.aiDeskProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { state: { in: ['EJECUTANDO', 'ABIERTA'] }, bot_id: 'b-9' },
      }),
    );
  });

  it('una que falla no para a las demás', async () => {
    const { svc, db } = montar([
      {
        id: 'p-1',
        state: 'EJECUTANDO',
        opened_at: null,
        plan: null,
        final_plan: null,
        bot_id: 'b-1',
        bot: { status: 'RUNNING', cycles: [ciclo()] },
      },
      {
        id: 'p-2',
        state: 'EJECUTANDO',
        opened_at: null,
        plan: null,
        final_plan: null,
        bot_id: 'b-2',
        bot: { status: 'RUNNING', cycles: [ciclo()] },
      },
    ]);
    db.aiDeskProposal.updateMany.mockRejectedValueOnce(new Error('bloqueo'));
    await expect(svc.conciliar(AHORA)).resolves.toBe(1);
    expect(db.aiDeskProposal.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe('AiDeskOperacionesService — lo pendiente muere con la operación', () => {
  it('al cerrarse, sus acciones propuestas dejan de esperar', async () => {
    const db = {
      aiDeskProposal: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'p-1',
            state: 'ABIERTA',
            opened_at: new Date('2026-09-24T12:05:00Z'),
            plan: planDePrueba(),
            final_plan: null,
            bot_id: 'b-1',
            bot: {
              status: 'STOPPED',
              cycles: [
                {
                  entries_filled: 1,
                  qty: '0',
                  realized_pnl: '-5',
                  opened_at: new Date('2026-09-24T12:00:00Z'),
                  last_entry_at: new Date('2026-09-24T12:05:00Z'),
                  closed_at: new Date('2026-09-24T14:00:00Z'),
                },
              ],
            },
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      aiDeskAction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      botEvent: { findFirst: jest.fn().mockResolvedValue({ payload: { motivo: 'STOP' } }) },
    };
    await new AiDeskOperacionesService(db as never).conciliar(Date.now());
    expect(db.aiDeskAction.updateMany).toHaveBeenCalledWith({
      where: { proposal_id: 'p-1', state: 'PROPUESTA' },
      data: { state: 'DESCARTADA', reason: 'CERRADA' },
    });
  });
});
