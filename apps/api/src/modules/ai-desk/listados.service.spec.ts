import { NotFoundException } from '@nestjs/common';
import { AiDeskListadosService } from './listados.service';

/**
 * Lo que la app lee de los agentes (spec 074): solo lo propio —lo ajeno es un
 * 404, como si no existiera—, lo pendiente primero y, en los resultados, lo
 * real y lo simulado cada uno por su lado.
 */

const dec = (s: string) => ({ toString: () => s });

function montar() {
  const db = {
    aiDeskProposal: {
      findMany: jest.fn(async (): Promise<unknown[]> => []),
      findFirst: jest.fn(async (): Promise<unknown> => null),
    },
    aiDeskAction: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    aiDeskRound: {
      findMany: jest.fn(async (): Promise<unknown[]> => []),
      groupBy: jest.fn(async (): Promise<unknown[]> => []),
    },
    aiDeskAgent: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    aiDeskCandidate: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
  };
  return { servicio: new AiDeskListadosService(db as never), db };
}

type Llamada = { where: Record<string, unknown>; orderBy?: unknown; take?: number };
const llamadas = (f: jest.Mock) => f.mock.calls.map((c) => (c as Llamada[])[0]);

describe('AiDeskListadosService', () => {
  it('las propuestas: solo las suyas, las pendientes por lo que les queda, luego las últimas', async () => {
    const m = montar();
    await m.servicio.propuestas('u-1');
    const [pendientes, recientes] = llamadas(m.db.aiDeskProposal.findMany);
    expect(pendientes.where).toEqual({
      agent: { user_id: 'u-1' },
      state: { in: ['PROPUESTA', 'APROBANDO'] },
    });
    expect(pendientes.orderBy).toEqual({ expires_at: 'asc' });
    expect(recientes.where).toEqual({
      agent: { user_id: 'u-1' },
      state: { notIn: ['PROPUESTA', 'APROBANDO'] },
    });
    expect(recientes.take).toBe(50);

    await m.servicio.propuestas('u-1', 'ag-9');
    // Con un agente, el suyo y SIGUE siendo del que pregunta: uno ajeno no da nada.
    expect(llamadas(m.db.aiDeskProposal.findMany)[2].where).toMatchObject({
      agent: { user_id: 'u-1' },
      agent_id: 'ag-9',
    });
  });

  it('las operaciones: vivas y terminadas, solo las suyas', async () => {
    const m = montar();
    await m.servicio.operaciones('u-1');
    const [vivas, terminadas] = llamadas(m.db.aiDeskProposal.findMany);
    expect(vivas.where).toEqual({
      agent: { user_id: 'u-1' },
      state: { in: ['EJECUTANDO', 'ABIERTA'] },
    });
    expect(terminadas.where).toEqual({
      agent: { user_id: 'u-1' },
      state: { in: ['CERRADA', 'SIN_ENTRADA'] },
    });
  });

  it('una propuesta o la operación de un bot ajenos no existen', async () => {
    const m = montar();
    await expect(m.servicio.propuesta('u-1', 'p-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(m.servicio.operacionDeBot('u-1', 'b-1')).rejects.toBeInstanceOf(NotFoundException);
    const [porId, porBot] = llamadas(m.db.aiDeskProposal.findFirst);
    expect(porId.where).toEqual({ id: 'p-1', agent: { user_id: 'u-1' } });
    expect(porBot.where).toEqual({ bot_id: 'b-1', agent: { user_id: 'u-1' } });
    // Sin la propuesta, no se lee nada más.
    expect(m.db.aiDeskAction.findMany).not.toHaveBeenCalled();
    expect(m.db.aiDeskRound.findMany).not.toHaveBeenCalled();
  });

  it('sin agentes, sin tarjetas', async () => {
    const m = montar();
    expect(await m.servicio.resultados('u-1')).toEqual({ real: null, simulado: null, agentes: [] });
    expect(m.db.aiDeskCandidate.findMany).not.toHaveBeenCalled();
  });

  it('lo real y lo simulado nunca se suman: cada uno su tarjeta, y una por agente', async () => {
    const m = montar();
    const agente = (id: string, cuenta: { paper: boolean; testnet: boolean }) => ({
      id,
      name: id,
      archived_at: id === 'ag-test' ? new Date() : null,
      exchange_account: cuenta,
    });
    m.db.aiDeskAgent.findMany.mockResolvedValue([
      agente('ag-real', { paper: false, testnet: false }),
      agente('ag-sim', { paper: true, testnet: false }),
      // Testnet no es dinero de verdad: va con lo simulado.
      agente('ag-test', { paper: false, testnet: true }),
    ]);
    const cerrada = (agentId: string, resultado: string, r: string) => ({
      agent_id: agentId,
      family: 'TENDENCIA',
      side: 'LONG',
      state: 'CERRADA',
      reason: null,
      outcome: null,
      r_real: dec(r),
      realized_pnl: dec(resultado),
      exit: 'OBJETIVO',
    });
    m.db.aiDeskProposal.findMany.mockResolvedValue([
      cerrada('ag-real', '10', '2'),
      cerrada('ag-sim', '100', '1'),
      cerrada('ag-test', '50', '0.5'),
    ]);
    m.db.aiDeskCandidate.findMany.mockResolvedValue([
      {
        agent_id: 'ag-real',
        eligible: true,
        chosen: true,
        outcome: { resultado: 'OBJETIVO', r: 1.5, en: 1 },
      },
    ]);
    m.db.aiDeskRound.groupBy.mockResolvedValue([
      { agent_id: 'ag-real', _count: { _all: 3 }, _sum: { cost: dec('0.012000') } },
    ]);

    const r = await m.servicio.resultados('u-1');
    expect(r.real).toMatchObject({ resultado: '10', operaciones: { n: 1, rMedio: 2 } });
    expect(r.real?.elegidas).toMatchObject({ n: 1, rMedio: 1.5 });
    expect(r.simulado).toMatchObject({ resultado: '150', operaciones: { n: 2, rMedio: 0.75 } });
    expect(r.simulado?.elegidas.n).toBe(0);
    expect(r.agentes.map((a) => [a.agenteId, a.real, a.archivado, a.consultas, a.coste])).toEqual([
      ['ag-real', true, false, 3, '0.012'],
      ['ag-sim', false, false, 0, '0'],
      ['ag-test', false, true, 0, '0'],
    ]);
    expect(r.agentes[1].tarjeta.resultado).toBe('100');
    // Solo los candidatos que se pudieron medir, y solo las rondas que llamaron al modelo.
    expect(llamadas(m.db.aiDeskCandidate.findMany)[0].where).toMatchObject({
      agent_id: { in: ['ag-real', 'ag-sim', 'ag-test'] },
    });
    expect(llamadas(m.db.aiDeskRound.groupBy)[0].where).toEqual({
      agent_id: { in: ['ag-real', 'ag-sim', 'ag-test'] },
      model: { not: null },
    });
    expect(llamadas(m.db.aiDeskAgent.findMany)[0].where).toEqual({ user_id: 'u-1' });
  });
});
