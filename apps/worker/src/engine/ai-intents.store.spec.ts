import type { EleccionOperacion, MarcaDecision, PlanOperacion, SolicitudIa } from '@crypton/shared';
import { AiIntentStore, eleccionDe } from './ai-intents.store';

/**
 * Spec 058. El almacén de intenciones es la puerta de cada entrada del canal
 * con IA: si dice que no, la entrada no sale. Por eso se prueba sobre todo lo
 * que NO debe dejar pasar.
 */

const BOT = { id: 'bot-1', user_id: 'u1' };
const BAR_T = Date.UTC(2026, 8, 17, 10, 0, 0);

const ELECCION: EleccionOperacion = {
  veredicto: 'OPERAR',
  opcion: 'REB-L-H1',
  stop: 'NORMAL',
  objetivo: 'ESCALONADO',
  apalancamiento: 'MEDIA',
  tamano: 'COMPLETO',
  confianza: 'ALTA',
};

const PLAN = {
  intentId: 'x',
  candidatoId: 'REB-L-H1',
  barT: BAR_T,
  huella: `${BAR_T}|H1|REB-L-H1:LISTO`,
  eleccion: ELECCION,
} as unknown as PlanOperacion;

const unicidad = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

function montar() {
  const db = {
    botAiIntent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    cacheSet: jest.fn().mockResolvedValue(undefined),
  };
  const store = new AiIntentStore(db as never, bus as never);
  return { db, bus, store };
}

describe('AiIntentStore: el vale del botón de pausa (spec 059)', () => {
  it('un vale opaco de un solo uso, con el dueño y el bot, que vive un día', async () => {
    const { bus, store } = montar();
    const vale = await store.valeDePausa(BOT);
    expect(vale).toMatch(/^[0-9a-f]{32}$/);
    expect(bus.cacheSet).toHaveBeenCalledWith(
      `ic:vale:${vale}`,
      { userId: BOT.user_id, botId: BOT.id },
      86_400,
    );
    // Cada aviso, el suyo.
    expect(await store.valeDePausa(BOT)).not.toBe(vale);
  });

  it('sin Redis el aviso sale sin botón, y sin esperar más de un segundo', async () => {
    jest.useFakeTimers();
    try {
      const { bus, store } = montar();
      bus.cacheSet.mockRejectedValueOnce(new Error('caído'));
      await expect(store.valeDePausa(BOT)).resolves.toBeNull();

      bus.cacheSet.mockReturnValueOnce(new Promise(() => undefined));
      const colgado = store.valeDePausa(BOT);
      await jest.advanceTimersByTimeAsync(999);
      let resuelto = false;
      void colgado.then(() => (resuelto = true));
      await Promise.resolve();
      expect(resuelto).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(colgado).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('AiIntentStore (spec 058)', () => {
  describe('vigente', () => {
    it('lee la última intención del bot, por vela', async () => {
      const { db, store } = montar();
      db.botAiIntent.findFirst.mockResolvedValue({
        id: 'i-1',
        estado: 'DECIDIDA',
        origen: 'IA',
        bar_t: new Date(BAR_T),
        huella: 'h',
        decision: ELECCION,
        motivo: null,
        expires_at: new Date(BAR_T + 360_000),
        cycle_seq: 4,
      });

      const d = await store.vigente(BOT.id);

      expect(d).toEqual({
        intentId: 'i-1',
        estado: 'DECIDIDA',
        origen: 'IA',
        barT: BAR_T,
        huella: 'h',
        eleccion: ELECCION,
        motivo: null,
        expiresAt: BAR_T + 360_000,
        cycleSeq: 4,
      });
      expect(db.botAiIntent.findFirst).toHaveBeenCalledWith({
        where: { bot_id: BOT.id, kind: 'ENTRADA' },
        orderBy: [{ bar_t: 'desc' }, { created_at: 'desc' }],
      });
    });

    it('sin intenciones, null', async () => {
      const { store } = montar();
      await expect(store.vigente(BOT.id)).resolves.toBeNull();
    });
  });

  describe('eleccionDe', () => {
    it('acepta la forma del contrato', () => {
      expect(eleccionDe({ ...ELECCION })).toEqual(ELECCION);
    });

    it.each([
      ['un valor fuera del vocabulario', { ...ELECCION, apalancamiento: 'MAXIMA' }],
      ['un número donde va una enumeración', { ...ELECCION, stop: 3 }],
      ['sin opción', { ...ELECCION, opcion: '' }],
      ['un campo que falta', { ...ELECCION, confianza: undefined }],
      ['una lista', [ELECCION]],
      ['nada', null],
    ])('no da por buena %s', (_caso, json) => {
      expect(eleccionDe(json)).toBeNull();
    });
  });

  describe('solicitar', () => {
    const solicitud: SolicitudIa = {
      barT: BAR_T,
      huella: 'h',
      expiresAt: BAR_T + 360_000,
      snapshot: { version: 1 } as never,
    };

    it('escribe la solicitud y avisa a la API', async () => {
      const { db, bus, store } = montar();

      await expect(store.solicitar(BOT, 7, solicitud)).resolves.toBe(true);

      expect(db.botAiIntent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bot_id: BOT.id,
          bar_t: new Date(BAR_T),
          kind: 'ENTRADA',
          origen: 'IA',
          estado: 'SOLICITADA',
          huella: 'h',
          expires_at: new Date(BAR_T + 360_000),
          cycle_seq: 7,
        }),
      });
      expect(bus.publish).toHaveBeenCalledWith(
        'crypton:bot-ai-requests',
        expect.objectContaining({ userId: 'u1', botId: BOT.id }),
      );
    });

    it('si esa vela ya tenía su intención, ni se escribe ni se avisa otra vez', async () => {
      const { db, bus, store } = montar();
      db.botAiIntent.create.mockRejectedValue(unicidad());

      await expect(store.solicitar(BOT, 7, solicitud)).resolves.toBe(false);
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('otro fallo de la base se propaga', async () => {
      const { db, store } = montar();
      db.botAiIntent.create.mockRejectedValue(new Error('base caída'));

      await expect(store.solicitar(BOT, 7, solicitud)).rejects.toThrow('base caída');
    });

    it('un aviso que no sale no deshace la solicitud', async () => {
      const { bus, store } = montar();
      bus.publish.mockRejectedValue(new Error('redis caído'));

      await expect(store.solicitar(BOT, 7, solicitud)).resolves.toBe(true);
    });
  });

  describe('anotar', () => {
    const marca = (over: Partial<MarcaDecision> = {}): MarcaDecision => ({
      intentId: 'i-1',
      estado: 'ACEPTADA',
      motivo: null,
      plan: PLAN,
      ...over,
    });

    it('acepta una decisión de la IA solo desde DECIDIDA', async () => {
      const { db, store } = montar();

      await expect(store.anotar(BOT.id, 3, marca())).resolves.toBe(true);

      expect(db.botAiIntent.updateMany).toHaveBeenCalledWith({
        where: { id: 'i-1', bot_id: BOT.id, estado: 'DECIDIDA' },
        data: expect.objectContaining({ estado: 'ACEPTADA', candidato_id: 'REB-L-H1' }),
      });
    });

    it('una intención que ya se movió no se acepta: sin entrada', async () => {
      const { db, store } = montar();
      db.botAiIntent.updateMany.mockResolvedValue({ count: 0 });

      await expect(store.anotar(BOT.id, 3, marca())).resolves.toBe(false);
    });

    it('con otra operación viva, la base lo impide y no hay entrada', async () => {
      const { db, store } = montar();
      db.botAiIntent.updateMany.mockRejectedValue(unicidad());

      await expect(store.anotar(BOT.id, 3, marca())).resolves.toBe(false);
    });

    it('sin plan no se acepta nada', async () => {
      const { db, store } = montar();

      await expect(store.anotar(BOT.id, 3, marca({ plan: null }))).resolves.toBe(false);
      expect(db.botAiIntent.updateMany).not.toHaveBeenCalled();
    });

    it('la de reglas se crea aceptada, con la vela, la huella, la elección y su plazo', async () => {
      const { db, store } = montar();
      const id = `reglas:${BOT.id}:${BAR_T}`;

      await expect(store.anotar(BOT.id, 3, marca({ intentId: id }))).resolves.toBe(true);

      expect(db.botAiIntent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id,
          bot_id: BOT.id,
          bar_t: new Date(BAR_T),
          origen: 'REGLAS',
          estado: 'ACEPTADA',
          huella: PLAN.huella,
          decision: ELECCION,
          expires_at: new Date(BAR_T + 6 * 60_000),
          cycle_seq: 3,
        }),
      });
      expect(db.botAiIntent.updateMany).not.toHaveBeenCalled();
    });

    it('la de reglas repetida, o con otra viva, no se acepta', async () => {
      const { db, store } = montar();
      db.botAiIntent.create.mockRejectedValue(unicidad());

      await expect(
        store.anotar(BOT.id, 3, marca({ intentId: `reglas:${BOT.id}:${BAR_T}` })),
      ).resolves.toBe(false);
    });

    it('rechaza una decidida o una aceptada, con su motivo', async () => {
      const { db, store } = montar();

      await store.anotar(BOT.id, 3, marca({ estado: 'RECHAZADA', motivo: 'VENUE', plan: null }));

      expect(db.botAiIntent.updateMany).toHaveBeenCalledWith({
        where: { id: 'i-1', bot_id: BOT.id, estado: { in: ['DECIDIDA', 'ACEPTADA'] } },
        data: { estado: 'RECHAZADA', motivo: 'VENUE' },
      });
    });

    it('la de reglas que solo observa se guarda rechazada con sus números', async () => {
      const { db, store } = montar();
      db.botAiIntent.updateMany.mockResolvedValue({ count: 0 });
      const id = `reglas:${BOT.id}:${BAR_T}`;

      await expect(
        store.anotar(BOT.id, 3, marca({ intentId: id, estado: 'RECHAZADA', motivo: 'PUERTA' })),
      ).resolves.toBe(true);

      expect(db.botAiIntent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ id, estado: 'RECHAZADA', motivo: 'PUERTA' }),
      });
    });

    it('una de la IA que ya no estaba para rechazar no crea nada', async () => {
      const { db, store } = montar();
      db.botAiIntent.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        store.anotar(BOT.id, 3, marca({ estado: 'RECHAZADA', motivo: 'HUELLA' })),
      ).resolves.toBe(false);
      expect(db.botAiIntent.create).not.toHaveBeenCalled();
    });
  });

  describe('ciclo de vida', () => {
    it('abrir pasa la aceptada a abierta, y solo esa, y dice si la movió', async () => {
      const { db, store } = montar();
      await expect(store.abrir(BOT.id, 'i-1')).resolves.toBe(true);
      expect(db.botAiIntent.updateMany).toHaveBeenCalledWith({
        where: { id: 'i-1', bot_id: BOT.id, estado: 'ACEPTADA' },
        data: { estado: 'ABIERTA' },
      });
      // Ya estaba abierta (un reinicio con la posición puesta): no se avisa otra vez.
      db.botAiIntent.updateMany.mockResolvedValue({ count: 0 });
      await expect(store.abrir(BOT.id, 'i-1')).resolves.toBe(false);
    });

    it('cerrar cierra lo que estaba vivo', async () => {
      const { db, store } = montar();
      await store.cerrar(BOT.id);
      expect(db.botAiIntent.updateMany).toHaveBeenCalledWith({
        where: { bot_id: BOT.id, estado: { in: ['ACEPTADA', 'ABIERTA'] } },
        data: { estado: 'CERRADA' },
      });
    });

    it('caducar deja fuera lo vivo: solo lo que aún podía acabar en entrada', async () => {
      const { db, store } = montar();
      db.botAiIntent.updateMany.mockResolvedValue({ count: 2 });

      await expect(store.caducarPendientes(BOT.id)).resolves.toBe(2);
      expect(db.botAiIntent.updateMany).toHaveBeenCalledWith({
        where: { bot_id: BOT.id, estado: { in: ['SOLICITADA', 'CONSULTANDO', 'DECIDIDA'] } },
        data: { estado: 'CADUCADA', motivo: 'ESTADO' },
      });
    });
  });
});
