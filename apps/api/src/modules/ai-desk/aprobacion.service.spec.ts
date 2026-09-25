import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULTS_AGENTE, recalcularPropuesta } from '@crypton/strategy-core';
import type { PlanAgente } from '@crypton/shared';
import { AiDeskConfig } from './ai-desk.config';
import { planDePrueba } from './agentes.fixture-spec';
import { AiDeskAprobacionService, VIDA_ENTRADA_MS, nombreDelBot } from './aprobacion.service';

/**
 * Aprobar una propuesta: el único camino por el que el dinero sale de la
 * cuenta (spec 074, R-19 a R-21, CA-6).
 *
 * El recálculo se sustituye aquí por un doble: su aritmética la prueba
 * `strategy-core`. Lo que se fija es la rutina: el reclamo condicional (dos
 * aprobaciones, un bot), lo que se relee antes de abrir, que el bot nace por
 * `BotsService` y se enlaza ANTES de arrancar, que un arranque fallido no deja
 * borradores, y que ninguna salida deja la propuesta a medias.
 */

jest.mock('@crypton/strategy-core', () => ({
  ...jest.requireActual<Record<string, unknown>>('@crypton/strategy-core'),
  recalcularPropuesta: jest.fn(),
  atrLiquidacionDe: jest.fn(() => '1.5'),
}));
const recalculo = recalcularPropuesta as jest.MockedFunction<typeof recalcularPropuesta>;

const ADMIN = 'admin-1';
/** Un UUID: el DTO del bot lo exige, como en producción. */
const CUENTA = '44444444-4444-4444-8444-444444444444';
const PLAN = planDePrueba();
const RECALCULADO: PlanAgente = { ...PLAN, entradaTope: '100.3', cantidad: '0.9' };

type Propuesta = Record<string, unknown> & { id: string; state: string };

interface Opciones {
  env?: Record<string, string>;
  rol?: string;
  agente?: string;
  paper?: boolean;
  entradas?: boolean | null;
  botReal?: boolean;
  ticker?: boolean;
  expirada?: boolean;
}

function montar(o: Opciones = {}) {
  const propuestas = new Map<string, Propuesta>();
  propuestas.set('p-1', {
    id: 'p-1',
    state: 'PROPUESTA',
    expires_at: new Date(Date.now() + (o.expirada ? -1 : 1) * 600_000),
    plan: PLAN,
    symbol: 'BTC',
    side: 'LONG',
    bot_id: null,
    decided_at: null,
  });
  const agente = {
    id: 'ag-1',
    name: 'Tendencias',
    user_id: ADMIN,
    state: o.agente ?? 'ACTIVO',
    interval: '1h',
    limits: { capital: '1000', ...DEFAULTS_AGENTE },
    auto_entry: 'MANUAL',
    auto_reduce: 'AUTO',
    auto_close: 'MANUAL',
    venue: 'HYPERLIQUID',
    exchange_account: {
      id: CUENTA,
      venue: 'HYPERLIQUID',
      paper: o.paper ?? false,
      testnet: false,
      status: 'ACTIVE',
    },
    user: { role: o.rol ?? 'ADMIN', disabled: false },
  };
  let claimFalla: Error | null = null;
  const db = {
    aiDeskProposal: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; agent: { user_id: string } } }) => {
          const p = propuestas.get(where.id);
          return p && where.agent.user_id === ADMIN ? { ...p, agent: agente } : null;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; state: string };
          data: Record<string, unknown>;
        }) => {
          const p = propuestas.get(where.id);
          if (!p || p.state !== where.state) return { count: 0 };
          if (claimFalla && data['state'] === 'APROBANDO') throw claimFalla;
          Object.assign(p, data);
          return { count: 1 };
        },
      ),
      findMany: jest.fn(async () => []),
    },
    bot: {
      findFirst: jest.fn(async () => (o.botReal ? { id: 'otro-bot' } : null)),
      findMany: jest.fn(async () => []),
    },
  };
  const cfg = new AiDeskConfig({
    get: (k: string, def?: string) => ({ AI_DESK_ENABLE: 'true', ...(o.env ?? {}) })[k] ?? def,
  } as unknown as ConfigService);
  const interruptores = {
    entradasAbiertas: jest.fn(async () => (o.entradas === undefined ? true : o.entradas)),
  };
  const lectura = {
    par: jest.fn(async () => ({
      par: {
        simbolo: 'BTC',
        market: { symbol: 'BTC' },
        ticker: o.ticker === false ? null : { bid: '100', ask: '100.1', mark: '100.05' },
        velas: [],
        fundingBps: null,
        niveles: [],
      },
      sinTramos: false,
    })),
    saldoLibre: jest.fn(async () => '500'),
    maxApalancamiento: jest.fn(async () => null),
  };
  const agentes = { historial: jest.fn(async () => ({ vivas: 0 })) };
  let n = 0;
  const bots = {
    create: jest.fn(async () => {
      n++;
      return { id: `bot-${n}` };
    }),
    command: jest.fn(async () => ({ accepted: true })),
    remove: jest.fn(async () => undefined),
  };
  const avisos = { agente: jest.fn(async () => undefined) };
  const audit = { recordNow: jest.fn(async () => undefined) };
  const svc = new AiDeskAprobacionService(
    db as never,
    cfg,
    interruptores as never,
    lectura as never,
    agentes as never,
    bots as never,
    avisos as never,
    audit as never,
  );
  return {
    svc,
    db,
    bots,
    avisos,
    audit,
    lectura,
    agentes,
    propuestas,
    p: () => propuestas.get('p-1') as Propuesta,
    fallarReclamo: (code: string) => (claimFalla = Object.assign(new Error(code), { code })),
  };
}

beforeEach(() => {
  recalculo.mockReset();
  recalculo.mockReturnValue({ plan: RECALCULADO, motivo: null });
});

describe('AiDeskAprobacionService — aprobar', () => {
  it('recalcula, crea el bot por BotsService, lo enlaza antes de arrancarlo y queda EJECUTANDO', async () => {
    const m = montar();
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r).toMatchObject({ estado: 'EJECUTANDO', botId: 'bot-1', motivo: null });

    // El recálculo, con el plan guardado, los datos de ahora y la vida de la entrada.
    const [plan, frescos, ctx] = recalculo.mock.calls[0];
    expect(plan).toEqual(PLAN);
    expect(frescos).toMatchObject({ saldoLibre: '500', atrLiquidacion: '1.5' });
    expect(ctx).toMatchObject({ venue: 'HYPERLIQUID', intervalo: '1h', vidaMs: VIDA_ENTRADA_MS });
    // El historial, sin contar la propia propuesta.
    expect(m.agentes.historial).toHaveBeenCalledWith(expect.anything(), expect.any(Number), 'p-1');

    // El bot, con el plan RECALCULADO, en real y sin arrancar al crearlo.
    const [usuario, dto] = m.bots.create.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(usuario).toBe(ADMIN);
    expect(dto).toMatchObject({
      strategy: 'AGENT_TRADE',
      symbol: 'BTC',
      exchangeAccountId: CUENTA,
      dryRun: false,
      startActive: false,
      name: 'Tendencias · BTC largo',
    });
    expect(dto['config']).toMatchObject({
      entryLimitPrice: '100.3',
      quantity: '0.9',
      agentProposalId: 'p-1',
      stopPrice: '97',
    });

    // Enlazado antes del START, con el plan final.
    expect(m.p()).toMatchObject({ state: 'EJECUTANDO', bot_id: 'bot-1', final_plan: RECALCULADO });
    const enlace = m.db.aiDeskProposal.updateMany.mock.invocationCallOrder[1];
    const arranque = m.bots.command.mock.invocationCallOrder[0];
    expect(enlace).toBeLessThan(arranque);
    expect(m.bots.command).toHaveBeenCalledWith(ADMIN, 'bot-1', { command: 'START' });
    expect(m.audit.recordNow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.ai_desk.proposal_approve', severity: 'WARN' }),
    );
  });

  it('dos aprobaciones a la vez —app y Telegram— abren UNA operación', async () => {
    const m = montar();
    const [a, b] = await Promise.all([
      m.svc.aprobar(ADMIN, 'p-1', 'APP'),
      m.svc.aprobar(ADMIN, 'p-1', 'TELEGRAM'),
    ]);
    expect(m.bots.create).toHaveBeenCalledTimes(1);
    // Una la abre; la otra ya no la encuentra pendiente, en el estado que sea.
    const [gana, pierde] = a.botId ? [a, b] : [b, a];
    expect(gana).toMatchObject({ estado: 'EJECUTANDO', botId: 'bot-1' });
    expect(pierde.mensaje).toBe('La propuesta ya no está pendiente.');
    expect(m.p()).toMatchObject({ state: 'EJECUTANDO', bot_id: 'bot-1' });
  });

  it('una propuesta ajena no existe', async () => {
    const m = montar();
    await expect(m.svc.aprobar('otro', 'p-1', 'APP')).rejects.toThrow(NotFoundException);
  });

  it('caducada, no se abre nada', async () => {
    const m = montar({ expirada: true });
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r).toMatchObject({ estado: 'CADUCADA', motivo: 'CADUCIDAD' });
    expect(m.bots.create).not.toHaveBeenCalled();
  });

  it('si el recálculo dice que ya no vale, caduca con su motivo y no crea nada', async () => {
    const m = montar();
    recalculo.mockReturnValue({ plan: null, motivo: 'PRECIO_PASO_STOP' });
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'TELEGRAM');
    expect(r).toMatchObject({ estado: 'CADUCADA', motivo: 'PRECIO_PASO_STOP' });
    expect(m.p().state).toBe('CADUCADA');
    expect(m.bots.create).not.toHaveBeenCalled();
    // Quien pulsó en Telegram solo vio «Ejecutando…»: se le dice.
    expect(m.avisos.agente).toHaveBeenCalledWith(
      ADMIN,
      'AGENT_PROPOSAL_RESULT',
      'WARN',
      expect.stringContaining('El precio ya ha pasado el stop'),
      { agentId: 'ag-1', propuestaId: 'p-1' },
    );
  });

  it('el índice de una operación viva por par salta en el reclamo: PAR_OCUPADO', async () => {
    const m = montar();
    m.fallarReclamo('P2002');
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r).toMatchObject({ estado: 'DESCARTADA', motivo: 'PAR_OCUPADO' });
    expect(m.bots.create).not.toHaveBeenCalled();
  });

  it('un bot real vivo del usuario en ese par lo ocupa (invariante 11)', async () => {
    const m = montar({ botReal: true });
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r).toMatchObject({ estado: 'DESCARTADA', motivo: 'PAR_OCUPADO' });
    expect(m.bots.create).not.toHaveBeenCalled();
  });

  it.each<[string, Opciones, string]>([
    ['el módulo apagado', { env: { AI_DESK_ENABLE: 'false' } }, 'IA_APAGADA'],
    ['un dueño que ya no es administrador', { rol: 'USER' }, 'DUENO'],
    ['el agente en pausa', { agente: 'PAUSADO' }, 'AGENTE_PAUSADO'],
    ['las entradas cortadas', { entradas: false }, 'INTERRUPTOR'],
    ['Redis caído: cerrado ante la duda', { entradas: null }, 'INTERRUPTOR'],
    ['el modo sombra del servidor', { env: { AI_DESK_SHADOW_ONLY: 'true' } }, 'SOLO_SOMBRA'],
    [
      'solo simulación en una cuenta real',
      { env: { AI_DESK_DRY_RUN_ONLY: 'true' } },
      'SOLO_SIMULACION',
    ],
  ])('%s: se descarta sin abrir nada', async (_, opciones, motivo) => {
    const m = montar(opciones);
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r).toMatchObject({ estado: 'DESCARTADA', motivo });
    expect(m.p().state).toBe('DESCARTADA');
    expect(m.bots.create).not.toHaveBeenCalled();
  });

  it('en la cuenta de simulación, el bot es simulado y el freno de solo simulación no lo para', async () => {
    const m = montar({ paper: true, env: { AI_DESK_DRY_RUN_ONLY: 'true' } });
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r.estado).toBe('EJECUTANDO');
    expect(m.bots.create.mock.calls[0]).toEqual([ADMIN, expect.objectContaining({ dryRun: true })]);
  });

  it('sin precio: si lo pidió una persona vuelve a esperar; si fue el automático, caduca', async () => {
    const persona = montar({ ticker: false });
    const r = await persona.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r).toMatchObject({ estado: 'PROPUESTA', motivo: 'SIN_DATOS' });
    expect(persona.p()).toMatchObject({ state: 'PROPUESTA', decided_by: null });

    const auto = montar({ ticker: false });
    const a = await auto.svc.aprobar(ADMIN, 'p-1', 'AUTO');
    expect(a).toMatchObject({ estado: 'CADUCADA', motivo: 'SIN_DATOS' });
  });

  it('si BotsService no lo admite, FALLIDA con su motivo y sin bot', async () => {
    const m = montar();
    m.bots.create.mockRejectedValueOnce(
      new BadRequestException({ message: 'La configuración no es válida.' }),
    );
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'AUTO');
    expect(r).toMatchObject({ estado: 'FALLIDA', motivo: 'CREAR' });
    expect(r.mensaje).toContain('La configuración no es válida.');
    // Una avería en el automático sí se avisa.
    expect(m.avisos.agente).toHaveBeenCalledWith(
      ADMIN,
      'AGENT_PROPOSAL_RESULT',
      'ERROR',
      expect.any(String),
      expect.anything(),
    );
  });

  it('si la propuesta deja de estar en APROBANDO mientras se crea el bot, el borrador sobra', async () => {
    // Por ejemplo, la recuperación la dio por colgada: el bot no se enlaza ni arranca.
    const m = montar();
    m.bots.create.mockImplementationOnce(async () => {
      Object.assign(m.p(), { state: 'FALLIDA' });
      return { id: 'bot-tarde' };
    });
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r.mensaje).toBe('La propuesta ya no está pendiente.');
    expect(m.bots.remove).toHaveBeenCalledWith(ADMIN, 'bot-tarde');
    expect(m.bots.command).not.toHaveBeenCalled();
    expect(m.p().bot_id).toBeNull();
  });

  it('si el arranque falla, el borrador se borra y la propuesta queda FALLIDA', async () => {
    const m = montar();
    m.bots.command.mockRejectedValueOnce(new ConflictException('Ya hay otro bot en marcha.'));
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'TELEGRAM');
    expect(r).toMatchObject({ estado: 'FALLIDA', motivo: 'ARRANCAR' });
    expect(m.bots.remove).toHaveBeenCalledWith(ADMIN, 'bot-1');
    expect(m.p().state).toBe('FALLIDA');
  });

  it('lo inesperado también deja un estado: FALLIDA, nunca APROBANDO', async () => {
    const m = montar();
    m.lectura.saldoLibre.mockRejectedValueOnce(new Error('se cayó la base'));
    const r = await m.svc.aprobar(ADMIN, 'p-1', 'APP');
    expect(r.estado).toBe('FALLIDA');
    expect(m.p().state).toBe('FALLIDA');
  });
});

describe('AiDeskAprobacionService — rechazar y botones', () => {
  it('rechazar la deja RECHAZADA por su dueño; la segunda vez ya no está pendiente', async () => {
    const m = montar();
    expect(await m.svc.rechazar(ADMIN, 'p-1', 'APP')).toMatchObject({
      estado: 'RECHAZADA',
      motivo: 'PERSONA',
    });
    expect(m.p()).toMatchObject({ state: 'RECHAZADA', reason: 'PERSONA', decided_by: 'APP' });
    expect((await m.svc.rechazar(ADMIN, 'p-1', 'APP')).mensaje).toBe(
      'La propuesta ya no está pendiente.',
    );
  });

  it('el botón: «si» aprueba, «no» rechaza, y un vale ajeno no hace nada', async () => {
    const vale = { userId: ADMIN, agentId: 'ag-1', propuestaId: 'p-1', accionId: null };
    const ajeno = montar();
    expect(await ajeno.svc.pulsacion('otro', vale, 'si')).toBe(true);
    expect(ajeno.p().state).toBe('PROPUESTA');

    const si = montar();
    await si.svc.pulsacion(ADMIN, vale, 'si');
    expect(si.p()).toMatchObject({ state: 'EJECUTANDO', decided_by: 'TELEGRAM' });

    const no = montar();
    await no.svc.pulsacion(ADMIN, vale, 'no');
    expect(no.p()).toMatchObject({ state: 'RECHAZADA', decided_by: 'TELEGRAM' });
  });

  it('el vale de una acción no es de aquí', async () => {
    const m = montar();
    expect(
      await m.svc.pulsacion(ADMIN, { userId: ADMIN, propuestaId: 'p-1', accionId: 'a-1' }, 'si'),
    ).toBe(false);
  });
});

describe('AiDeskAprobacionService — mantenimiento', () => {
  it('recupera las aprobaciones colgadas sin duplicar nada, y borra los borradores huérfanos', async () => {
    const m = montar();
    m.db.aiDeskProposal.findMany.mockResolvedValueOnce([
      {
        id: 'p-1',
        bot_id: 'b-1',
        agent: { user_id: ADMIN },
        bot: { id: 'b-1', status: 'RUNNING' },
      },
      { id: 'p-2', bot_id: 'b-2', agent: { user_id: ADMIN }, bot: { id: 'b-2', status: 'DRAFT' } },
      { id: 'p-3', bot_id: null, agent: { user_id: ADMIN }, bot: null },
    ] as never);
    for (const id of ['p-1', 'p-2', 'p-3']) {
      m.propuestas.set(id, { id, state: 'APROBANDO' });
    }
    m.db.bot.findMany.mockResolvedValueOnce([{ id: 'huerfano', user_id: ADMIN }] as never);

    await expect(m.svc.recuperar(Date.now())).resolves.toBe(4);
    expect(m.propuestas.get('p-1')?.state).toBe('EJECUTANDO');
    expect(m.propuestas.get('p-2')).toMatchObject({ state: 'FALLIDA', reason: 'ARRANCAR' });
    expect(m.propuestas.get('p-3')).toMatchObject({ state: 'FALLIDA', reason: 'CREAR' });
    expect(m.bots.remove.mock.calls).toEqual([
      [ADMIN, 'b-2'],
      [ADMIN, 'huerfano'],
    ]);
    // Los huérfanos: solo borradores de agente sin propuesta, y con un rato de edad.
    expect(m.db.bot.findMany).toHaveBeenCalledWith({
      where: {
        strategy: 'AGENT_TRADE',
        status: 'DRAFT',
        created_at: { lt: expect.any(Date) },
        ai_desk_proposal: { is: null },
      },
      select: { id: true, user_id: true },
    });
  });

  it('el nombre del bot cabe en 64 caracteres y dice par y lado', () => {
    expect(nombreDelBot('Tendencias', { simbolo: 'ETH', lado: 'SHORT' })).toBe(
      'Tendencias · ETH corto',
    );
    const largo = nombreDelBot('x'.repeat(80), { simbolo: 'BTC', lado: 'LONG' });
    expect(largo.length).toBeLessThanOrEqual(64);
    expect(largo.endsWith(' · BTC largo')).toBe(true);
  });
});
