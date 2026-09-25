import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { BusMessage } from 'src/libs';
import { AiDeskScheduler } from './ai-desk.scheduler';

/**
 * El reloj y el bus de los agentes (spec 074). Los `@Cron` disparan en todas
 * las réplicas: cada uno va detrás de su cerrojo. Las pulsaciones se canjean
 * una vez; los avisos del worker adelantan la conciliación de su operación.
 */

const VALE = '0123456789abcdef0123456789abcdef';

function montar(cerrojo = true, opciones: { encendido?: boolean; huecos?: number } = {}) {
  const eventos = new Subject<BusMessage>();
  const bus = { listen: jest.fn(async () => eventos.asObservable()) };
  const cache = { setnx: jest.fn(async () => cerrojo) };
  const debidos = [
    { id: 'ag-1', interval: '1h', next_round_at: new Date('2026-09-24T10:00:15Z') },
    { id: 'ag-2', interval: '15m', next_round_at: new Date('2026-09-24T10:00:15Z') },
  ];
  const db = {
    aiDeskAgent: {
      findMany: jest
        .fn()
        // Los activos, para declarar su interés…
        .mockResolvedValueOnce([
          { venue: 'HYPERLIQUID', symbols: ['BTC'], exchange_account: { testnet: false } },
        ])
        // …y los que ya tienen ronda.
        .mockResolvedValueOnce(debidos),
      // El segundo lo reclama otra réplica antes.
      updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
    },
  };
  const cfg = { encendido: opciones.encendido ?? true, barridoMax: 5 };
  const lectura = { declararInteres: jest.fn() };
  const rondas = {
    huecos: opciones.huecos ?? 2,
    rondaEntrada: jest.fn(async () => null),
    avisoPlazo: jest.fn((): string | null => null),
  };
  const seguimiento = {
    huecos: 0,
    pulsacion: jest.fn(async () => true),
    caducar: jest.fn(async () => 0),
    rondaSeguimiento: jest.fn(async () => null),
  };
  const aprobacion = {
    pulsacion: jest.fn(async () => true),
    caducar: jest.fn(async () => 0),
    recuperar: jest.fn(async () => 0),
  };
  const operaciones = { conciliar: jest.fn(async () => 0) };
  const avisos = {
    canjear: jest.fn(async () => ({
      userId: 'u-1',
      agentId: 'ag-1',
      propuestaId: 'p-1',
      accionId: null,
    })),
  };
  const medicion = { medir: jest.fn(async () => 0) };
  const s = new AiDeskScheduler(
    bus as never,
    cache as never,
    db as never,
    cfg as never,
    lectura as never,
    rondas as never,
    seguimiento as never,
    aprobacion as never,
    operaciones as never,
    avisos as never,
    medicion as never,
  );
  return {
    s,
    eventos,
    cache,
    aprobacion,
    operaciones,
    avisos,
    db,
    lectura,
    rondas,
    seguimiento,
    medicion,
  };
}

describe('AiDeskScheduler — el barrido de las rondas', () => {
  it('declara el interés de los activos, reclama cada agente debido y lanza su ronda', async () => {
    const m = montar();
    await m.s.barrer();
    expect(m.lectura.declararInteres).toHaveBeenCalledWith([
      { venue: 'HYPERLIQUID', symbols: ['BTC'], exchange_account: { testnet: false } },
    ]);
    // Solo a los de dueño administrador, y como mucho tantos como huecos.
    expect(m.db.aiDeskAgent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: 'ACTIVO',
          user: { role: 'ADMIN', disabled: false },
        }),
        take: 2,
      }),
    );
    // El reclamo: condicional sobre la próxima ronda leída.
    expect(m.db.aiDeskAgent.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'ag-1', next_round_at: new Date('2026-09-24T10:00:15Z') },
    });
    // El que ya reclamó otra réplica no se lanza aquí.
    expect(m.rondas.rondaEntrada).toHaveBeenCalledTimes(1);
    expect(m.rondas.rondaEntrada).toHaveBeenCalledWith('ag-1', 'INTERVALO', expect.any(Number));
  });

  it('sin huecos no reclama a nadie', async () => {
    const m = montar(true, { huecos: 0 });
    await m.s.barrer();
    expect(m.db.aiDeskAgent.updateMany).not.toHaveBeenCalled();
    expect(m.rondas.rondaEntrada).not.toHaveBeenCalled();
  });

  it('con el módulo apagado no corre nada, y suelta el interés', async () => {
    const m = montar(true, { encendido: false });
    await m.s.barrer();
    expect(m.lectura.declararInteres).toHaveBeenCalledWith([]);
    expect(m.db.aiDeskAgent.findMany).not.toHaveBeenCalled();
  });
});

const mensaje = (extra: Partial<BusMessage>): BusMessage => ({
  channel: 'crypton:bot-events',
  userId: 'u-1',
  type: 'X',
  data: {},
  ts: 1,
  ...extra,
});

/** Deja correr lo que el `subscribe` lanzó sin esperar. */
const drenar = () => new Promise((r) => setImmediate(r));

describe('AiDeskScheduler — el bus', () => {
  it('una pulsación bien formada se canjea y se atiende con quien pulsó', async () => {
    const m = montar();
    await m.s.onModuleInit();
    m.eventos.next(
      mensaje({ type: 'AGENT_DECISION_TAKEN', data: { vale: VALE, verbo: 'si', chatId: '111' } }),
    );
    await drenar();
    expect(m.avisos.canjear).toHaveBeenCalledWith(VALE);
    expect(m.aprobacion.pulsacion).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ propuestaId: 'p-1' }),
      'si',
    );
  });

  it('lo mal formado no canjea nada, y un vale ya gastado no hace nada', async () => {
    const m = montar();
    for (const data of [
      { vale: 'corto', verbo: 'si' },
      { vale: VALE, verbo: 'pausa' },
      { vale: VALE },
      null,
    ]) {
      await m.s.onPulsacion(mensaje({ type: 'AGENT_DECISION_TAKEN', data: data as never }));
    }
    expect(m.avisos.canjear).not.toHaveBeenCalled();

    m.avisos.canjear.mockResolvedValueOnce(null as never);
    await m.s.onPulsacion(mensaje({ data: { vale: VALE, verbo: 'no' } }));
    expect(m.aprobacion.pulsacion).not.toHaveBeenCalled();
  });

  it('la entrada, la salida o la parada de un bot adelantan la conciliación de su operación', async () => {
    const m = montar();
    await m.s.onModuleInit();
    for (const type of ['AGENT_ENTRY', 'AGENT_EXIT', 'BOT_STOPPED', 'LIQUIDATED']) {
      m.eventos.next(mensaje({ type, botId: `b-${type}` }));
    }
    // Un fill o un evento sin bot no.
    m.eventos.next(mensaje({ type: 'FILL', botId: 'b-fill' }));
    m.eventos.next(mensaje({ type: 'AGENT_EXIT' }));
    await drenar();
    expect(m.operaciones.conciliar.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      'b-AGENT_ENTRY',
      'b-AGENT_EXIT',
      'b-BOT_STOPPED',
      'b-LIQUIDATED',
    ]);
  });
});

describe('AiDeskScheduler — el arranque (spec 078)', () => {
  it('avisa en el log si el plazo del modelo no deja terminar al razonamiento', async () => {
    const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const m = montar();
      m.rondas.avisoPlazo.mockReturnValueOnce('AI_DESK_TIMEOUT_MS=20000 con razonamiento medium');
      await m.s.onModuleInit();
      expect(aviso).toHaveBeenCalledWith('AI_DESK_TIMEOUT_MS=20000 con razonamiento medium');

      aviso.mockClear();
      await montar().s.onModuleInit();
      expect(aviso).not.toHaveBeenCalled();
    } finally {
      aviso.mockRestore();
    }
  });
});

describe('AiDeskScheduler — el reloj', () => {
  it('caducar, mantener y medir, cada uno detrás de su cerrojo', async () => {
    const m = montar();
    await m.s.caducar();
    await m.s.mantener();
    await m.s.medir();
    expect(m.cache.setnx.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'lock:ai-desk-expire',
      'lock:ai-desk-maintain',
      'lock:ai-desk-measure',
    ]);
    expect(m.medicion.medir).toHaveBeenCalledTimes(1);
    expect(m.aprobacion.caducar).toHaveBeenCalled();
    // Primero se recupera, luego se concilia.
    expect(m.aprobacion.recuperar.mock.invocationCallOrder[0]).toBeLessThan(
      m.operaciones.conciliar.mock.invocationCallOrder[0],
    );
  });

  it('sin el cerrojo, otra réplica ya lo está haciendo', async () => {
    const m = montar(false);
    await m.s.caducar();
    await m.s.mantener();
    await m.s.medir();
    expect(m.aprobacion.caducar).not.toHaveBeenCalled();
    expect(m.aprobacion.recuperar).not.toHaveBeenCalled();
    expect(m.operaciones.conciliar).not.toHaveBeenCalled();
    expect(m.medicion.medir).not.toHaveBeenCalled();
  });
});

describe('AiDeskScheduler — el seguimiento', () => {
  it('cada operación abierta a la que le toca, por intervalo o por su primer objetivo', async () => {
    const m = montar();
    m.seguimiento.huecos = 5;
    m.db.aiDeskAgent.findMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const vela = (ms: number) => new Date(Math.floor(ms / 3_600_000) * 3_600_000 - 3_600_000);
    const ahora = Date.now();
    const db = m.db as unknown as { aiDeskProposal: { findMany: jest.Mock } };
    db.aiDeskProposal = {
      findMany: jest.fn().mockResolvedValue([
        // Sin ninguna ronda todavía: intervalo.
        { id: 'p-1', agent: { interval: '1h' }, bot: { cycles: [] }, followup_rounds: [] },
        // Ya mirada en esta vela, y cobró el primer objetivo después: su objetivo.
        {
          id: 'p-2',
          agent: { interval: '1h' },
          bot: {
            cycles: [
              { scratch: { op: { intento: 1, enviadaEn: 1, stopInicial: '1', tp1Hecho: true } } },
            ],
          },
          followup_rounds: [
            { bar_t: vela(ahora), trigger: 'INTERVALO', snapshot: { estado: { tp1Hecho: false } } },
          ],
        },
        // Ya mirada en esta vela y sin novedad: nada.
        {
          id: 'p-3',
          agent: { interval: '1h' },
          bot: { cycles: [] },
          followup_rounds: [{ bar_t: vela(ahora), trigger: 'INTERVALO', snapshot: null }],
        },
      ]),
    };
    await m.s.barrer();
    expect(m.seguimiento.rondaSeguimiento.mock.calls.map((c: unknown[]) => [c[0], c[1]])).toEqual([
      ['p-1', 'INTERVALO'],
      ['p-2', 'OBJETIVO_1'],
    ]);
  });

  it('el botón de una acción lo atiende el seguimiento', async () => {
    const m = montar();
    m.aprobacion.pulsacion.mockResolvedValueOnce(false);
    m.avisos.canjear.mockResolvedValueOnce({
      userId: 'u-1',
      agentId: 'ag-1',
      propuestaId: 'p-1',
      accionId: 'a-1',
    } as never);
    await m.s.onPulsacion(mensaje({ data: { vale: VALE, verbo: 'cierra' } }));
    expect(m.seguimiento.pulsacion).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ accionId: 'a-1' }),
      'cierra',
    );
  });

  it('caducar también caduca las acciones', async () => {
    const m = montar();
    await m.s.caducar();
    expect(m.seguimiento.caducar).toHaveBeenCalled();
  });
});
