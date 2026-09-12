import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AiDecisionState, AiMode } from '@crypton/db';
import { SupervisorPolicyService } from './supervisor.policy.service';

/**
 * La frontera del spec 033, probada.
 *
 * «Mirar y contener, nunca disponer del dinero de nadie». Un supervisor que
 * reescribe configuraciones de bots ajenos se la salta entera, y por eso el Modo
 * IA solo se enciende sobre bots PROPIOS — aunque quien lo pida sea
 * administrador, que es justo el caso que hay que probar.
 */

const ADMIN = 'admin-1';
const OTRO = 'usuario-2';

function build(bot: Record<string, unknown> | null) {
  const decisiones = { updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
  const ajustes = {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockImplementation((args: { create: unknown }) => args.create),
    findMany: jest.fn().mockResolvedValue([]),
  };
  const db = {
    bot: { findUnique: jest.fn().mockResolvedValue(bot) },
    exchangeAccount: { findUnique: jest.fn().mockResolvedValue({ testnet: false }) },
    botAiSetting: ajustes,
    botAiDecision: decisiones,
    // Vinculado por defecto: el modo MANUAL lo exige, y lo que se prueba en la
    // mayoria de estos casos es otra cosa.
    telegramLink: { findUnique: jest.fn().mockResolvedValue({ verified_at: new Date() }) },
  };
  const marketData = { features: jest.fn().mockResolvedValue(null) };
  const service = new SupervisorPolicyService(db as never, marketData as never);
  return { service, db, ajustes, decisiones, marketData };
}

const bot = (extra: Record<string, unknown> = {}) => ({
  id: 'bot-1',
  user_id: ADMIN,
  strategy: 'MARKET_MAKER',
  venue: 'LIGHTER',
  symbol: 'BTC',
  status: 'RUNNING',
  dry_run: true,
  config_version: 3,
  exchange_account_id: 'cuenta-1',
  ...extra,
});

describe('SupervisorPolicyService — la frontera del spec 033', () => {
  it('un administrador NO puede encenderlo sobre un bot ajeno', async () => {
    const { service, ajustes } = build(bot({ user_id: OTRO }));

    await expect(service.set(ADMIN, 'bot-1', { mode: AiMode.AUTO })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Y no escribe nada: no es que falle al final, es que ni empieza.
    expect(ajustes.upsert).not.toHaveBeenCalled();
  });

  it('el mensaje dice POR QUE, no solo que no', async () => {
    // Quien lo lea tiene que entender que no le falta un permiso: es que esa
    // herramienta no existe sobre bots ajenos.
    const { service } = build(bot({ user_id: OTRO }));
    await expect(service.set(ADMIN, 'bot-1', { mode: AiMode.MANUAL })).rejects.toThrow(
      /bots propios/i,
    );
    await expect(service.set(ADMIN, 'bot-1', { mode: AiMode.MANUAL })).rejects.toThrow(/033/);
  });

  it('tampoco puede LEER la politica de un bot ajeno', async () => {
    const { service } = build(bot({ user_id: OTRO }));
    await expect(service.get(ADMIN, 'bot-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sobre un bot propio si puede', async () => {
    const { service, ajustes } = build(bot());
    await service.set(ADMIN, 'bot-1', { mode: AiMode.AUTO });
    expect(ajustes.upsert).toHaveBeenCalled();
  });

  it('un bot que no existe es 404, no 403', async () => {
    const { service } = build(null);
    await expect(service.get(ADMIN, 'bot-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SupervisorPolicyService — encender y apagar', () => {
  it('al encender se siembran las perillas de referencia', async () => {
    // Sin punto de partida no hay desde donde desplazarse, y `buildConfig` no es
    // invertible: la configuracion de un bot de tres semanas no dice con que
    // perillas nacio.
    const { service, ajustes } = build(bot());
    await service.set(ADMIN, 'bot-1', { mode: AiMode.MANUAL });

    const creado = ajustes.upsert.mock.calls[0][0] as { create: { knobs: Record<string, string> } };
    expect(creado.create.knobs).toMatchObject({
      profile: expect.any(String),
      leverage: expect.any(String),
      coverage: expect.any(String),
      spread: expect.any(String),
      sizeGrowth: expect.any(String),
      cadence: expect.any(String),
    });
  });

  it('sin rasgos del par se siembra igual, no se niega', async () => {
    // Un par recien listado no tiene velas suficientes. Negarse a encender el
    // modo por eso seria peor: el bot ya existe y el par tendra velas en horas.
    const { service, ajustes, marketData } = build(bot());
    marketData.features.mockRejectedValue(new Error('sin velas'));
    await service.set(ADMIN, 'bot-1', { mode: AiMode.MANUAL });
    expect(ajustes.upsert).toHaveBeenCalled();
  });

  it('las perillas NO se vuelven a sembrar al reconfigurar', async () => {
    // Resembrarlas moveria el origen de los desplazamientos sin que nadie lo
    // hubiera pedido, y todas las decisiones anteriores dejarian de encadenar.
    const { service, ajustes } = build(bot());
    ajustes.findUnique.mockResolvedValue({
      bot_id: 'bot-1',
      mode: AiMode.MANUAL,
      knobs: { profile: 'PRUDENTE', leverage: 'BAJA' },
      enabled_at: new Date(),
    });
    await service.set(ADMIN, 'bot-1', { mode: AiMode.AUTO });

    const args = ajustes.upsert.mock.calls[0][0] as { create: { knobs: unknown } };
    expect(args.create.knobs).toMatchObject({ profile: 'PRUDENTE', leverage: 'BAJA' });
  });

  it('solo las cuatro estrategias del alcance', async () => {
    const { service } = build(bot({ strategy: 'MARTINGALE' }));
    await expect(service.set(ADMIN, 'bot-1', { mode: AiMode.AUTO })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('apagarlo si se permite en una estrategia fuera del alcance', async () => {
    // Si un dia se estrecha el alcance, quien lo tuviera encendido tiene que
    // poder apagarlo. Negarselo lo dejaria atrapado.
    const { service, ajustes } = build(bot({ strategy: 'MARTINGALE' }));
    await service.set(ADMIN, 'bot-1', { mode: AiMode.OFF });
    expect(ajustes.upsert).toHaveBeenCalled();
  });

  it('apagarlo descarta lo que estuviera esperando aprobacion', async () => {
    // Una sugerencia pendiente de un modo que ya no esta encendido es una
    // trampa: alguien la aprobaria mañana sin saber que se apago.
    const { service, decisiones } = build(bot());
    await service.set(ADMIN, 'bot-1', { mode: AiMode.OFF });

    expect(decisiones.updateMany).toHaveBeenCalledWith({
      where: { bot_id: 'bot-1', state: AiDecisionState.PROPUESTA },
      data: { state: AiDecisionState.DESCARTADA, discard_reason: 'MODO_APAGADO' },
    });
  });

  it('encender otra vez perdona los fallos acumulados', async () => {
    const { service, ajustes } = build(bot());
    ajustes.findUnique.mockResolvedValue({
      bot_id: 'bot-1',
      mode: AiMode.OFF,
      knobs: {},
      failures: 3,
    });
    await service.set(ADMIN, 'bot-1', { mode: AiMode.OFF });
    const args = ajustes.upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(args.update['failures']).toBe(0);
    expect(args.update['paused_until']).toBeNull();
  });
});

describe('SupervisorPolicyService — a quien se barre', () => {
  it('la consulta exige que el dueño siga siendo ADMIN y no este deshabilitado', async () => {
    const { service, ajustes } = build(bot());
    await service.pendientesDeRevision(5);

    const where = (ajustes.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    const filtroBot = where['bot'] as { user: Record<string, unknown>; status: string };
    expect(filtroBot.user['role']).toBe('ADMIN');
    expect(filtroBot.user['disabled']).toBe(false);
    // Y que el bot este vivo: en ERROR la premisa esta rota y en STOPPED no hay
    // nada que ajustar.
    expect(filtroBot.status).toBe('RUNNING');
  });

  it('no barre los que estan dormidos por fallos', async () => {
    const { service, ajustes } = build(bot());
    const ahora = new Date('2026-09-12T00:00:00Z');
    await service.pendientesDeRevision(5, ahora);

    const where = (ajustes.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where['OR']).toEqual([{ paused_until: null }, { paused_until: { lt: ahora } }]);
  });

  it('atiende primero a los que llevan mas sin revisar', async () => {
    const { service, ajustes } = build(bot());
    await service.pendientesDeRevision(5);
    const args = ajustes.findMany.mock.calls[0][0] as { orderBy: unknown; take: number };
    expect(args.orderBy).toEqual({ last_review_at: { sort: 'asc', nulls: 'first' } });
    expect(args.take).toBe(5);
  });
});

describe('SupervisorPolicyService — la referencia de regimen no se inventa (spec 047, G-02)', () => {
  it('sin velas suficientes no se guarda referencia: se guarda nada', async () => {
    // El respaldo era razonable cuando esos rasgos solo sembraban PERILLAS —un
    // punto de partida aproximado es tolerable—. Como referencia de MEDIDA no lo
    // es: el expediente diria «el par se mueve tres veces mas que cuando se
    // configuro» comparando contra un numero que nadie calculo.
    const { service, ajustes, marketData } = build(bot());
    marketData.features.mockResolvedValue(null);

    await service.set(ADMIN, 'bot-1', { mode: AiMode.MANUAL });

    const creado = ajustes.upsert.mock.calls[0][0] as {
      create: { features_at_enable?: unknown; knobs: unknown };
    };
    expect(creado.create.features_at_enable).toBeUndefined();
    // Pero las perillas SI se siembran: para eso el respaldo sigue valiendo.
    expect(creado.create.knobs).toBeDefined();
  });

  it('con velas si se guarda, que es para lo que existe', async () => {
    const { service, ajustes, marketData } = build(bot());
    marketData.features.mockResolvedValue({ mark: 100, atrPct1d: 2.5, trend: 'LATERAL' });

    await service.set(ADMIN, 'bot-1', { mode: AiMode.MANUAL });

    const creado = ajustes.upsert.mock.calls[0][0] as {
      create: { features_at_enable?: { atrPct1d?: number } };
    };
    expect(creado.create.features_at_enable?.atrPct1d).toBe(2.5);
  });
});

describe('SupervisorPolicyService — el modo manual necesita donde avisar (spec 047, G-03)', () => {
  function conTelegram(verificado: boolean) {
    const { service, ajustes, db } = build(bot());
    (db as unknown as { telegramLink: { findUnique: jest.Mock } }).telegramLink = {
      findUnique: jest.fn().mockResolvedValue(verificado ? { verified_at: new Date() } : null),
    };
    return { service, ajustes };
  }

  it('sin Telegram vinculado, MANUAL se rechaza diciendo por que', async () => {
    // Las sugerencias se escribirian y no llegarian a ninguna parte: el modo
    // aparece encendido y no pasa nada nunca. El peor sintoma es el silencio.
    const { service, ajustes } = conTelegram(false);

    await expect(service.set(ADMIN, 'bot-1', { mode: AiMode.MANUAL })).rejects.toThrow(
      /Telegram/,
    );
    expect(ajustes.upsert).not.toHaveBeenCalled();
  });

  it('con Telegram vinculado si se puede', async () => {
    const { service, ajustes } = conTelegram(true);
    await service.set(ADMIN, 'bot-1', { mode: AiMode.MANUAL });
    expect(ajustes.upsert).toHaveBeenCalled();
  });

  it('el modo AUTOMATICO no lo necesita: avisa despues, no espera a nadie', async () => {
    const { service, ajustes } = conTelegram(false);
    await service.set(ADMIN, 'bot-1', { mode: AiMode.AUTO });
    expect(ajustes.upsert).toHaveBeenCalled();
  });

  it('apagarlo tampoco lo necesita', async () => {
    // Negarle apagar el modo a quien no tiene Telegram lo dejaria atrapado.
    const { service, ajustes } = conTelegram(false);
    await service.set(ADMIN, 'bot-1', { mode: AiMode.OFF });
    expect(ajustes.upsert).toHaveBeenCalled();
  });
});
