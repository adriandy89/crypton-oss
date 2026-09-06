import { CommandInbox, type ClaimedCommand } from './command-inbox.service';

/**
 * La bandeja de comandos por la parte que decide si un comando se ejecuta una
 * vez, dos o ninguna (spec 011, F-08).
 */

function build(stale: { id: bigint; bot_id: string; claimed_by: string }[] = []) {
  const db = {
    botCommand: {
      findMany: jest.fn().mockResolvedValue(stale),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  return { inbox: new CommandInbox(db as never), db };
}

const comando = (over: Partial<ClaimedCommand> = {}): ClaimedCommand => ({
  id: 5n,
  botId: 'bot-a',
  userId: 'u1',
  command: 'PAUSE',
  payload: null,
  ...over,
});

describe('CommandInbox.recoverStale', () => {
  /**
   * Antes se devolvian a la cola TODOS los comandos reclamados hace mas de dos
   * minutos, incluidos los que otro worker vivo seguia ejecutando (un venue
   * lento, un enfriamiento de 60-120 s): el siguiente barrido los ejecutaba
   * otra vez. Con una transferencia de margen, eso es dinero movido dos veces.
   */
  it('no desreclama un comando cuyo worker sigue teniendo el lease del bot', async () => {
    const { inbox, db } = build([
      { id: 1n, bot_id: 'bot-a', claimed_by: 'worker-A' },
      { id: 2n, bot_id: 'bot-b', claimed_by: 'worker-B' },
    ]);

    const liberados = await inbox.recoverStale(120_000, async (botId) =>
      botId === 'bot-a' ? 'worker-A' : null,
    );

    expect(liberados).toBe(1);
    expect(db.botCommand.updateMany).toHaveBeenCalledTimes(1);
    expect(db.botCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 2n }) }),
    );
  });
});

describe('CommandInbox.execute', () => {
  it('un comando que mueve dinero se marca ejecutado ANTES de correr', async () => {
    // Si el proceso muere con la transferencia hecha y el comando aun abierto,
    // quien adopte el bot la repetiria. Marcarlo antes lo deja en «como mucho
    // una vez»: si falla, el usuario lo repite a mano con el motivo delante.
    const { inbox, db } = build();
    const orden: string[] = [];
    db.botCommand.update.mockImplementation(async () => {
      orden.push('marcado');
    });

    await inbox.execute(comando({ command: 'ADJUST_MARGIN' }), async () => {
      orden.push('ejecutado');
    });

    expect(orden).toEqual(['marcado', 'ejecutado']);
  });

  it('los demas se marcan al terminar', async () => {
    const { inbox, db } = build();
    const orden: string[] = [];
    db.botCommand.update.mockImplementation(async () => {
      orden.push('marcado');
    });

    await inbox.execute(comando({ command: 'PAUSE' }), async () => {
      orden.push('ejecutado');
    });

    expect(orden).toEqual(['ejecutado', 'marcado']);
  });

  it('un comando que falla queda cerrado con el motivo y el fallo se propaga', async () => {
    const { inbox, db } = build();

    await expect(
      inbox.execute(comando({ command: 'PAUSE' }), async () => {
        throw new Error('el venue no responde');
      }),
    ).rejects.toThrow('el venue no responde');

    expect(db.botCommand.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ error: 'el venue no responde' }) }),
    );
  });
});

describe('CommandInbox.claimForBots', () => {
  it('el id del comando viaja en el payload para que el acuse pueda referirse a el', async () => {
    // La API sube el capital asignado cuando el worker confirma el ajuste de
    // margen; sin el id en el acuse no sabria de que comando se trata.
    const { inbox, db } = build();
    db.botCommand.findMany.mockResolvedValue([
      {
        id: 9n,
        bot_id: 'bot-a',
        command: 'ADJUST_MARGIN',
        payload: { amount: '10', action: 'ADD' },
        bot: { user_id: 'u1' },
      },
    ]);

    const porBot = await inbox.claimForBots(['bot-a'], 'worker-A');

    expect(porBot.get('bot-a')?.[0].payload).toEqual({
      amount: '10',
      action: 'ADD',
      commandId: '9',
    });
  });
});
