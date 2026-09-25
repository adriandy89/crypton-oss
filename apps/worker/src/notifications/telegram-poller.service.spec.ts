import { TelegramPollerService } from './telegram-poller.service';

/**
 * Las pulsaciones de los botones (specs 046 y 059).
 *
 * El poller es un mensajero: resuelve de quién es el chat y reenvía el vale a
 * la API por el bus. No aplica, no pausa y no sabe de qué bot es. Lo que se
 * prueba es lo que reenvía y, sobre todo, lo que no.
 */

const VALE = '0123456789abcdef0123456789abcdef';

function montar(vinculado = true, vale: unknown = { botId: 'b-1', userId: 'u-1' }) {
  const db = {
    telegramLink: {
      findFirst: jest.fn().mockResolvedValue(vinculado ? { user_id: 'u-1' } : null),
    },
  };
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    cacheGet: jest.fn().mockResolvedValue(vale),
  };
  const config = { get: jest.fn().mockReturnValue('token-de-prueba') };
  const poller = new TelegramPollerService(db as never, {} as never, config as never, bus as never);
  const respuestas: { id: string; texto?: string }[] = [];
  const sinBotones: { chatId: string; messageId: number }[] = [];
  (poller as unknown as { client: unknown }).client = {
    enabled: true,
    answerCallbackQuery: async (id: string, texto?: string) => {
      respuestas.push({ id, ...(texto ? { texto } : {}) });
      return true;
    },
    quitarTeclado: async (chatId: string, messageId: number) => {
      sinBotones.push({ chatId, messageId });
      return true;
    },
  };
  const pulsar = (data: string, chat: number | null = 111) =>
    (poller as unknown as { onBoton: (cb: unknown) => Promise<void> }).onBoton({
      id: 'cb-1',
      data,
      ...(chat === null ? {} : { message: { message_id: 77, chat: { id: chat } } }),
    });
  return { db, bus, respuestas, pulsar, sinBotones };
}

describe('TelegramPollerService — botones', () => {
  it('«⏸ Pausar» reenvía el vale a la API, sin bot, y contesta', async () => {
    const m = montar();
    await m.pulsar(`ic:${VALE}:pausa`);

    expect(m.db.telegramLink.findFirst).toHaveBeenCalledWith({
      where: { chat_id: '111', verified_at: { not: null } },
      select: { user_id: true },
    });
    expect(m.bus.publish).toHaveBeenCalledWith('crypton:bot-events', {
      userId: 'u-1',
      type: 'AI_CHANNEL_PAUSE',
      data: { vale: VALE, chatId: '111' },
    });
    expect(m.respuestas).toEqual([{ id: 'cb-1', texto: 'Pausando…' }]);
    expect(m.bus.cacheGet).toHaveBeenCalledWith(`ic:vale:${VALE}`);
  });

  /**
   * Spec 062, F-14. Se contestaba «Pausando…» a cualquier pulsacion: un vale ya
   * usado o caducado —el aviso de hace tres horas, el boton pulsado dos veces—
   * no dejaba ni evento ni mensaje, y el usuario se iba creyendo que su bot
   * estaba pausado.
   */
  it('un vale que ya no existe se dice, y no se reenvía nada', async () => {
    const m = montar(true, null);
    await m.pulsar(`ic:${VALE}:pausa`);

    expect(m.bus.publish).not.toHaveBeenCalled();
    expect(m.respuestas).toEqual([
      { id: 'cb-1', texto: 'Ese botón ya no vale: pausa desde la app.' },
    ]);
  });

  it('si no se puede leer el vale, se reenvía igual: quien decide es la API', async () => {
    const m = montar();
    m.bus.cacheGet.mockRejectedValue(new Error('Redis caído'));
    await m.pulsar(`ic:${VALE}:pausa`);

    expect(m.bus.publish).toHaveBeenCalled();
    expect(m.respuestas).toEqual([{ id: 'cb-1', texto: 'Pausando…' }]);
  });

  it('las sugerencias del Modo IA siguen como estaban', async () => {
    const m = montar();
    await m.pulsar('ia:tok:si');
    await m.pulsar('ia:tok:no');
    expect(m.bus.publish.mock.calls).toEqual([
      [
        'crypton:bot-events',
        {
          userId: 'u-1',
          type: 'AI_DECISION_TAKEN',
          data: { token: 'tok', aplicar: true, chatId: '111' },
        },
      ],
      [
        'crypton:bot-events',
        {
          userId: 'u-1',
          type: 'AI_DECISION_TAKEN',
          data: { token: 'tok', aplicar: false, chatId: '111' },
        },
      ],
    ]);
    expect(m.respuestas.map((r) => r.texto)).toEqual(['Aplicando…', 'Sugerencia descartada.']);
  });

  it.each([
    ['otro verbo', `ic:${VALE}:parar`],
    ['un vale corto', 'ic:abc:pausa'],
    ['un vale en mayúsculas', `ic:${VALE.toUpperCase()}:pausa`],
    ['una parte de más', `ic:${VALE}:pausa:x`],
    ['una parte de menos', `ic:${VALE}`],
    ['otro prefijo', `xx:${VALE}:pausa`],
    ['nada', ''],
  ])('con %s solo se contesta', async (_, data) => {
    const m = montar();
    await m.pulsar(data);
    expect(m.db.telegramLink.findFirst).not.toHaveBeenCalled();
    expect(m.bus.publish).not.toHaveBeenCalled();
    expect(m.respuestas).toEqual([{ id: 'cb-1' }]);
  });

  it('sin chat o con un chat sin vincular no se reenvía nada', async () => {
    const sinChat = montar();
    await sinChat.pulsar(`ic:${VALE}:pausa`, null);
    expect(sinChat.bus.publish).not.toHaveBeenCalled();
    expect(sinChat.respuestas).toEqual([{ id: 'cb-1' }]);

    const ajeno = montar(false);
    await ajeno.pulsar(`ic:${VALE}:pausa`);
    expect(ajeno.bus.publish).not.toHaveBeenCalled();
    expect(ajeno.respuestas).toEqual([{ id: 'cb-1', texto: 'No se ha podido procesar.' }]);
  });

  it('los botones del Modo IA y del canal no se quitan: eso es solo de los agentes', async () => {
    const m = montar();
    await m.pulsar(`ic:${VALE}:pausa`);
    await m.pulsar('ia:tok:si');
    expect(m.sinBotones).toEqual([]);
  });
});

/**
 * Los botones de los agentes de IA (spec 074): `ag:<vale>:si|no|cierra`. El
 * poller reenvía la pulsación y quita los botones del mensaje, porque el vale
 * sirve una vez y un «✅ Ejecutar» que se queda en el chat no hace nada.
 */
describe('TelegramPollerService — botones de los agentes (spec 074)', () => {
  const PROPUESTA = { userId: 'u-1', agentId: 'ag-1', propuestaId: 'p-1', accionId: null };
  const ACCION = { ...PROPUESTA, accionId: 'a-1' };

  it('ejecutar una propuesta: reenvía el vale y el verbo, contesta y quita los botones', async () => {
    const m = montar(true, PROPUESTA);
    await m.pulsar(`ag:${VALE}:si`);

    expect(m.bus.cacheGet).toHaveBeenCalledWith(`ag:vale:${VALE}`);
    expect(m.bus.publish).toHaveBeenCalledWith('crypton:bot-events', {
      userId: 'u-1',
      type: 'AGENT_DECISION_TAKEN',
      data: { vale: VALE, verbo: 'si', chatId: '111' },
    });
    expect(m.respuestas).toEqual([{ id: 'cb-1', texto: 'Ejecutando…' }]);
    expect(m.sinBotones).toEqual([{ chatId: '111', messageId: 77 }]);
  });

  it('cada verbo, con lo que se contesta a una propuesta y a una acción', async () => {
    const casos: [unknown, string, string][] = [
      [PROPUESTA, 'no', 'Propuesta descartada.'],
      [ACCION, 'si', 'Aplicando…'],
      [ACCION, 'no', 'Acción descartada.'],
      [ACCION, 'cierra', 'Cerrando la operación…'],
    ];
    for (const [vale, verbo, texto] of casos) {
      const m = montar(true, vale);
      await m.pulsar(`ag:${VALE}:${verbo}`);
      expect(m.bus.publish).toHaveBeenCalledWith('crypton:bot-events', {
        userId: 'u-1',
        type: 'AGENT_DECISION_TAKEN',
        data: { vale: VALE, verbo, chatId: '111' },
      });
      expect(m.respuestas).toEqual([{ id: 'cb-1', texto }]);
    }
  });

  it('un vale que ya no existe se dice, no se reenvía, y los botones se quitan igual', async () => {
    const m = montar(true, null);
    await m.pulsar(`ag:${VALE}:si`);
    expect(m.bus.publish).not.toHaveBeenCalled();
    expect(m.respuestas).toEqual([
      { id: 'cb-1', texto: 'Ya no está pendiente: míralo en la app.' },
    ]);
    expect(m.sinBotones).toEqual([{ chatId: '111', messageId: 77 }]);
  });

  it('si no se puede leer el vale, se reenvía igual y se contesta sin decir qué era', async () => {
    const m = montar();
    m.bus.cacheGet.mockRejectedValue(new Error('Redis caído'));
    await m.pulsar(`ag:${VALE}:si`);
    expect(m.bus.publish).toHaveBeenCalled();
    expect(m.respuestas).toEqual([{ id: 'cb-1', texto: 'Procesando…' }]);
  });

  it.each([
    ['otro verbo', `ag:${VALE}:pausa`],
    ['un vale corto', 'ag:abc:si'],
    ['una parte de más', `ag:${VALE}:si:x`],
    ['en mayúsculas', `AG:${VALE}:si`],
  ])('con %s solo se contesta', async (_, data) => {
    const m = montar();
    await m.pulsar(data);
    expect(m.db.telegramLink.findFirst).not.toHaveBeenCalled();
    expect(m.bus.publish).not.toHaveBeenCalled();
    expect(m.sinBotones).toEqual([]);
    expect(m.respuestas).toEqual([{ id: 'cb-1' }]);
  });

  it('desde un chat sin vincular no se reenvía nada ni se tocan los botones', async () => {
    const m = montar(false, PROPUESTA);
    await m.pulsar(`ag:${VALE}:si`);
    expect(m.bus.publish).not.toHaveBeenCalled();
    expect(m.sinBotones).toEqual([]);
    expect(m.respuestas).toEqual([{ id: 'cb-1', texto: 'No se ha podido procesar.' }]);
  });
});
