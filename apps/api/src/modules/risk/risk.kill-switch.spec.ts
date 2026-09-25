import { RiskService } from './risk.service';

/**
 * El kill-switch del usuario pausa también sus agentes de IA (spec 074, R-27).
 * Parar los bots y dejar a los agentes proponiendo o abriendo operaciones un
 * minuto después sería un kill-switch con una puerta trasera.
 */
describe('RiskService.killSwitch', () => {
  function montar() {
    const db = {
      bot: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      aiDeskAgent: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      aiDeskProposal: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    return { svc: new RiskService(db as never), db };
  }

  it('para los bots, pausa los agentes activos y descarta lo que esperaba respuesta', async () => {
    const { svc, db } = montar();
    await expect(svc.killSwitch('u-1')).resolves.toEqual({ affected: 3, agentesPausados: 2 });
    expect(db.bot.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'u-1', status: { in: ['STARTING', 'RUNNING', 'PAUSED'] } },
      data: { status: 'STOPPING' },
    });
    expect(db.aiDeskAgent.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'u-1', state: 'ACTIVO' },
      data: { state: 'PAUSADO', pause_reason: 'KILL_SWITCH' },
    });
    expect(db.aiDeskProposal.updateMany).toHaveBeenCalledWith({
      where: { agent: { user_id: 'u-1' }, state: 'PROPUESTA' },
      data: expect.objectContaining({ state: 'DESCARTADA', reason: 'AGENTE_PAUSADO' }),
    });
  });
});
