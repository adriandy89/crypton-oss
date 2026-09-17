import { Subject } from 'rxjs';
import type { BusMessage } from 'src/libs';
import { AiChannelScheduler } from './ai-channel.scheduler';

/**
 * Cuándo se consulta (spec 059): el bus adelanta, el sondeo asegura y el
 * cerrojo evita que el barrido corra en todas las réplicas.
 */

const BOT = 'b0000000-0000-4000-8000-000000000001';

function montar() {
  const canales = new Map<string, Subject<BusMessage>>();
  const bus = {
    listen: jest.fn(async (canal: string) => {
      const s = canales.get(canal) ?? new Subject<BusMessage>();
      canales.set(canal, s);
      return s.asObservable();
    }),
  };
  const cerrojos = new Set<string>();
  const cache = {
    setnx: jest.fn(async (clave: string) => {
      if (cerrojos.has(clave)) return false;
      cerrojos.add(clave);
      return true;
    }),
  };
  const canal = {
    huecos: 2,
    atender: jest.fn(async () => null),
    solicitudDe: jest.fn(async (): Promise<string | null> => 'int-1'),
    pendientes: jest.fn(async (n: number) => ['a', 'b', 'c'].slice(0, n)),
    caducarVencidas: jest.fn(async () => 3),
    canjearPausa: jest.fn(async () => 'PAUSADO'),
  };
  const s = new AiChannelScheduler(bus as never, cache as never, canal as never);
  const mensaje = (m: Partial<BusMessage>): BusMessage => ({
    channel: 'x',
    userId: 'u1',
    type: 'AI_REQUEST',
    data: {},
    ts: Date.now(),
    ...m,
  });
  const emitir = (nombre: string, m: BusMessage) => canales.get(nombre)?.next(m);
  return { s, bus, cache, canal, cerrojos, mensaje, emitir };
}

const esperar = () => new Promise((r) => setImmediate(r));

describe('AiChannelScheduler', () => {
  it('una solicitud del worker se busca por bot y vela y se atiende', async () => {
    const m = montar();
    await m.s.onSolicitud(m.mensaje({ botId: BOT, data: { barT: 1_760_000_300_000 } }));
    expect(m.canal.solicitudDe).toHaveBeenCalledWith(BOT, 1_760_000_300_000);
    expect(m.canal.atender).toHaveBeenCalledWith('int-1');
  });

  it('sin bot, sin vela o sin solicitud pendiente, nada', async () => {
    const m = montar();
    await m.s.onSolicitud(m.mensaje({ data: { barT: 1 } }));
    await m.s.onSolicitud(m.mensaje({ botId: BOT, data: { barT: 'ayer' } }));
    await m.s.onSolicitud(m.mensaje({ botId: BOT, data: null as never }));
    expect(m.canal.solicitudDe).not.toHaveBeenCalled();
    m.canal.solicitudDe.mockResolvedValueOnce(null);
    await m.s.onSolicitud(m.mensaje({ botId: BOT, data: { barT: 1 } }));
    expect(m.canal.atender).not.toHaveBeenCalled();
  });

  it('el sondeo toma tantas como huecos haya, sin esperar a que terminen', async () => {
    const m = montar();
    m.canal.atender.mockImplementation(() => new Promise(() => undefined));
    await m.s.sondear();
    expect(m.canal.pendientes).toHaveBeenCalledWith(2);
    expect(m.canal.atender.mock.calls).toEqual([['a'], ['b']]);
  });

  it('un fallo al atender no tumba el sondeo', async () => {
    const m = montar();
    m.canal.atender.mockRejectedValue(new Error('base caída'));
    await expect(m.s.sondear()).resolves.toBeUndefined();
    await esperar();
  });

  it('el barrido caduca con cerrojo: una réplica por minuto', async () => {
    const m = montar();
    await m.s.caducar();
    await m.s.caducar();
    expect(m.canal.caducarVencidas).toHaveBeenCalledTimes(1);
    expect(m.cache.setnx).toHaveBeenCalledWith('lock:ai-channel-expire', expect.any(Number), 50);
  });

  it('escucha las solicitudes y solo las pulsaciones de pausa entre los eventos', async () => {
    const m = montar();
    await m.s.onModuleInit();
    expect(m.bus.listen).toHaveBeenCalledWith('crypton:bot-ai-requests');
    expect(m.bus.listen).toHaveBeenCalledWith('crypton:bot-events');

    m.emitir('crypton:bot-ai-requests', m.mensaje({ botId: BOT, data: { barT: 5 } }));
    m.emitir('crypton:bot-events', m.mensaje({ type: 'CYCLE_CLOSED', botId: BOT }));
    m.emitir('crypton:bot-events', m.mensaje({ type: 'AI_DECISION_TAKEN', data: { token: 'x' } }));
    m.emitir(
      'crypton:bot-events',
      m.mensaje({ type: 'AI_CHANNEL_PAUSE', userId: 'u7', data: { vale: 'v' } }),
    );
    await esperar();
    expect(m.canal.solicitudDe).toHaveBeenCalledWith(BOT, 5);
    expect(m.canal.canjearPausa.mock.calls).toEqual([['u7', 'v']]);
  });

  it('una pulsación que falla no tumba la escucha', async () => {
    const m = montar();
    await m.s.onModuleInit();
    m.canal.canjearPausa.mockRejectedValueOnce(new Error('base caída'));
    m.emitir('crypton:bot-events', m.mensaje({ type: 'AI_CHANNEL_PAUSE', data: { vale: 'v' } }));
    await esperar();
    m.emitir('crypton:bot-events', m.mensaje({ type: 'AI_CHANNEL_PAUSE', data: { vale: 'w' } }));
    await esperar();
    expect(m.canal.canjearPausa).toHaveBeenCalledTimes(2);
  });
});
