import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULTS_AGENTE,
  configDeOperacion,
  estadoOperacion,
  opcionesSeguimiento,
} from '@crypton/strategy-core';
import {
  AccionSeguimiento,
  ClaseAccion,
  type EstadoOperacionAgente,
  type OpcionSeguimiento,
} from '@crypton/shared';
import { AiDeskConfig } from './ai-desk.config';
import { planDePrueba } from './agentes.fixture-spec';
import { AiDeskSeguimientoService } from './seguimiento.service';

/**
 * El seguimiento de una operación viva (spec 074, R-22 a R-24, CA-4 y CA-6).
 *
 * El estado de la operación y sus opciones los calcula el motor —se sustituyen
 * por dobles: su aritmética la prueba `strategy-core`—; el juez, la huella, la
 * autonomía y `soloReduceRiesgo` son los de verdad. Lo que se fija: solo se
 * aplica lo que reduce el riesgo, por `updateConfig` y con la versión leída;
 * un bot pausado por una persona no se toca; y cada acción acaba en un estado.
 */

jest.mock('@crypton/strategy-core', () => ({
  ...jest.requireActual<Record<string, unknown>>('@crypton/strategy-core'),
  estadoOperacion: jest.fn(),
  opcionesSeguimiento: jest.fn(),
}));
const estadoMock = estadoOperacion as jest.MockedFunction<typeof estadoOperacion>;
const opcionesMock = opcionesSeguimiento as jest.MockedFunction<typeof opcionesSeguimiento>;

// El reloj de verdad: la aprobación de una acción mira su caducidad con él.
const AHORA = Date.now();
const CONFIG = configDeOperacion(planDePrueba(), {
  exchangeAccountId: '11111111-1111-1111-1111-111111111111',
  agentProposalId: 'p-1',
}) as unknown as Record<string, unknown>;

const ESTADO: EstadoOperacionAgente = {
  rAhora: 0.5,
  mfeR: 0.9,
  maeR: -0.2,
  minutos: 120,
  fraccionTiempo: 0.2,
  tp1Hecho: false,
  stopR: -1,
  posicionFraccion: 1,
  objetivoR: 1.2,
  tesis: 'INTACTA',
  motivosTesis: [],
  regimen: 'TENDENCIA',
  sentido: 'ALCISTA',
};

const opcion = (
  accion: AccionSeguimiento,
  extra: Partial<OpcionSeguimiento> = {},
): OpcionSeguimiento => ({
  accion,
  clase:
    accion === AccionSeguimiento.MANTENER
      ? null
      : accion === AccionSeguimiento.CERRAR
        ? ClaseAccion.CERRAR
        : ClaseAccion.REDUCIR,
  cambio: {},
  stopNuevo: null,
  posicionNueva: null,
  riesgoRestanteR: 1,
  ...extra,
});

const OPCIONES = [
  opcion(AccionSeguimiento.MANTENER),
  opcion(AccionSeguimiento.PROTEGER, {
    cambio: { stopPrice: '100.2' },
    stopNuevo: '100.2',
    riesgoRestanteR: 0,
  }),
  opcion(AccionSeguimiento.CERRAR, {
    cambio: { positionCap: '0' },
    posicionNueva: '0',
    riesgoRestanteR: 0,
  }),
];

interface Opciones {
  env?: Record<string, string>;
  agente?: Record<string, unknown>;
  bot?: Record<string, unknown>;
  estado?: Partial<EstadoOperacionAgente>;
  pendiente?: number;
  huellaPrevia?: string;
  configStop?: string;
  cantidad?: string;
  respuesta?: Record<string, unknown> | null;
  /** Si hay clave del modelo para los agentes. */
  modelo?: boolean;
}

/** Lo que devuelve el cliente de una llamada que respondió. */
const USO = {
  tokensEntrada: 1800,
  tokensSalida: 300,
  tokensCacheLeidos: 1500,
  tokensCacheEscritos: 0,
  tokensRazonamiento: 250,
  coste: '0.002',
};

function montar(o: Opciones = {}) {
  const agente = {
    id: 'ag-1',
    name: 'Tendencias',
    user_id: 'u-1',
    state: 'ACTIVO',
    interval: '1h',
    decision_mode: 'REGLAS',
    limits: { capital: '1000', ...DEFAULTS_AGENTE },
    auto_entry: 'MANUAL',
    auto_reduce: 'AUTO',
    auto_close: 'MANUAL',
    sleeping_until: null,
    usage_day: null,
    cost_today: '0',
    exchange_account: { id: 'acc-1', venue: 'HYPERLIQUID', paper: false, testnet: false },
    user: { role: 'ADMIN', disabled: false },
    ...(o.agente ?? {}),
  };
  const operacion = {
    id: 'p-1',
    state: 'ABIERTA',
    symbol: 'BTC',
    side: 'LONG',
    plan: planDePrueba(),
    final_plan: null,
    opened_at: new Date(AHORA - 7_200_000),
    bot_id: 'b-1',
    agent: agente,
    bot: {
      id: 'b-1',
      status: 'RUNNING',
      config_version: 3,
      cycles: [
        {
          average_entry: '100.1',
          scratch: {
            op: {
              intento: 1,
              enviadaEn: AHORA - 7_300_000,
              stopInicial: '97',
              maximo: '1',
              abiertaEn: AHORA - 7_200_000,
              stop: '97',
            },
          },
        },
      ],
      snapshots: [{ position_qty: o.cantidad ?? '1', average_entry: '100.1' }],
      ...(o.bot ?? {}),
    },
  };
  const acciones = new Map<string, Record<string, unknown>>();
  const rondas: Record<string, unknown>[] = [];
  let n = 0;
  const db = {
    aiDeskProposal: {
      findUnique: jest.fn(async () => operacion),
      findFirst: jest.fn(async ({ where }: { where: { agent: { user_id: string } } }) =>
        where.agent.user_id === 'u-1'
          ? { id: 'p-1', state: operacion.state, bot_id: 'b-1', agent: { id: 'ag-1' } }
          : null,
      ),
    },
    aiDeskRound: {
      create: jest.fn(async () => ({ id: 'r-1' })),
      // La fila como está AHORA: EN_CURSO hasta que la ronda se cierra.
      findUnique: jest.fn(async () => {
        const cerrada = rondas[rondas.length - 1];
        return {
          id: 'r-1',
          kind: 'SEGUIMIENTO',
          bar_t: new Date(AHORA),
          trigger: 'MANUAL',
          state: cerrada?.['state'] ?? 'EN_CURSO',
          reason: cerrada?.['reason'] ?? null,
          decision_mode: agente.decision_mode,
          created_at: new Date(AHORA),
          finished_at: null,
          model: null,
          latency_ms: null,
          cost: null,
          decision: null,
          snapshot: null,
          proposals: [],
        };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rondas.push(data);
        return {};
      }),
      findFirst: jest.fn(async () => (o.huellaPrevia ? { huella: o.huellaPrevia } : null)),
    },
    aiDeskAction: {
      count: jest.fn(async () => o.pendiente ?? 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        n++;
        const id = `a-${n}`;
        acciones.set(id, { id, ...data });
        return { id };
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const a = acciones.get(where.id);
        if (!a) return null;
        return {
          ...a,
          state: a['state'],
          reason: a['reason'] ?? null,
          proposal: {
            id: 'p-1',
            state: operacion.state,
            symbol: 'BTC',
            side: 'LONG',
            agent: { id: 'ag-1', user_id: 'u-1' },
            bot: { id: 'b-1', status: 'RUNNING', config_version: 3 },
          },
        };
      }),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; proposal: { agent: { user_id: string } } } }) =>
          acciones.has(where.id) && where.proposal.agent.user_id === 'u-1'
            ? { id: where.id }
            : null,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (typeof where['id'] !== 'string') return { count: 0 };
          const a = acciones.get(where['id']);
          if (!a || (where['state'] && a['state'] !== where['state'])) return { count: 0 };
          const vence = (where['expires_at'] as { gt?: Date } | undefined)?.gt;
          if (vence && (a['expires_at'] as Date) <= vence) return { count: 0 };
          Object.assign(a, data);
          return { count: 1 };
        },
      ),
    },
    botConfigRevision: {
      findUnique: jest.fn(async () => ({
        config: { ...CONFIG, ...(o.configStop ? { stopPrice: o.configStop } : {}) },
      })),
    },
  };
  const cfg = new AiDeskConfig({
    get: (k: string, def?: string) => ({ AI_DESK_ENABLE: 'true', ...(o.env ?? {}) })[k] ?? def,
  } as unknown as ConfigService);
  const lectura = {
    par: jest.fn(async () => ({
      par: {
        simbolo: 'BTC',
        market: { symbol: 'BTC', quote: 'USDC' },
        ticker: { bid: '100.4', ask: '100.5', mark: '100.45' },
        velas: [],
        fundingBps: null,
        niveles: [],
      },
      sinTramos: false,
    })),
  };
  const modelo = {
    agentesDisponible: o.modelo ?? true,
    decidirAgente: jest.fn(async (_p: unknown) => ({
      contenido:
        o.respuesta === null
          ? null
          : JSON.stringify({
              accion: 'PROTEGER',
              tesis: 'DEBILITADA',
              confianza: 'ALTA',
              motivo1: 'TESIS_DEBILITADA',
              motivo2: 'NINGUNO',
              motivo3: 'NINGUNO',
              texto: 'Asegurar.',
              ...(o.respuesta ?? {}),
            }),
      // Como el cliente real: un tiempo agotado no trae uso ni coste (spec 078).
      uso: o.respuesta === null ? null : USO,
      fallo: o.respuesta === null ? 'TIEMPO' : null,
      latenciaMs: 900,
      modelo: 'x/y',
    })),
  };
  const consumo = { cupo: jest.fn(async () => null), anotar: jest.fn(async () => undefined) };
  const avisos = {
    vale: jest.fn(async () => 'fedcba9876543210fedcba9876543210'),
    agente: jest.fn(async () => undefined),
  };
  const bots = {
    updateConfig: jest.fn(async () => ({ applied: true, level: 'HOT', version: 4, changed: [] })),
    command: jest.fn(async () => ({ accepted: true })),
  };
  const cache = { setnx: jest.fn(async () => true) };
  const audit = { recordNow: jest.fn(async () => undefined) };
  const svc = new AiDeskSeguimientoService(
    db as never,
    cache as never,
    cfg,
    lectura as never,
    modelo as never,
    consumo as never,
    avisos as never,
    bots as never,
    audit as never,
  );
  estadoMock.mockReturnValue({ ...ESTADO, ...(o.estado ?? {}) });
  opcionesMock.mockReturnValue(OPCIONES);
  return { svc, db, cache, bots, avisos, modelo, consumo, acciones, rondas, operacion };
}

const cierre = (m: ReturnType<typeof montar>) => m.rondas[m.rondas.length - 1];

/** Deja correr lo que se lanzó sin esperar, hasta que se cumpla la condición. */
async function hasta(condicion: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condicion(); i++) {
    await new Promise((r) => setImmediate(r));
  }
  expect(condicion()).toBe(true);
}

beforeEach(() => {
  estadoMock.mockReset();
  opcionesMock.mockReset();
});

describe('AiDeskSeguimientoService — las barreras', () => {
  it.each<[string, Opciones, string]>([
    ['el módulo apagado', { env: { AI_DESK_ENABLE: 'false' } }, 'IA_APAGADA'],
    ['un agente archivado', { agente: { state: 'ARCHIVADO' } }, 'AGENTE'],
    ['un bot pausado por una persona', { bot: { status: 'PAUSED' } }, 'BOT'],
    ['un bot en error', { bot: { status: 'ERROR' } }, 'BOT'],
    ['una acción esperando respuesta', { pendiente: 1 }, 'PENDIENTE'],
    ['sin posición', { cantidad: '0' }, 'SIN_DATOS'],
  ])('%s: SALTADA con su motivo, sin tocar nada', async (_, opciones, motivo) => {
    const m = montar(opciones);
    const r = await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'SALTADA', motivo });
    expect(m.db.aiDeskAction.create).not.toHaveBeenCalled();
    expect(m.bots.updateConfig).not.toHaveBeenCalled();
  });

  it('con el agente en pausa sigue: pausar corta entradas, no el seguimiento', async () => {
    const m = montar({ agente: { state: 'PAUSADO' }, estado: { tesis: 'ROTA' } });
    const r = await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(r?.motivo).toBe('ACCION');
  });

  it('el mismo expediente no se vuelve a mirar por intervalo; a mano, sí', async () => {
    const primero = montar();
    await primero.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    const huella = cierre(primero)['huella'] as string;
    const m = montar({ huellaPrevia: huella });
    expect((await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA))?.motivo).toBe('HUELLA');
    expect((await m.svc.rondaSeguimiento('p-1', 'MANUAL', AHORA))?.motivo).toBe('MANTENER');
  });

  it('si la autonomía no permite nada, mantener sin preguntar a nadie', async () => {
    const m = montar({
      agente: { decision_mode: 'IA', auto_reduce: 'OFF', auto_close: 'OFF' },
    });
    const r = await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(r?.motivo).toBe('MANTENER');
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
  });
});

describe('AiDeskSeguimientoService — decidir y actuar', () => {
  it('con la idea intacta, el juez mantiene y no hay acción', async () => {
    const m = montar();
    expect((await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA))?.motivo).toBe('MANTENER');
    expect(m.db.aiDeskAction.create).not.toHaveBeenCalled();
  });

  it('reducir en automático: se aplica por updateConfig con la versión leída y su firmante', async () => {
    const m = montar({ estado: { tesis: 'DEBILITADA', rAhora: 1.2 } });
    const r = await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(r?.motivo).toBe('ACCION');
    expect(m.bots.updateConfig).toHaveBeenCalledWith(
      'u-1',
      'b-1',
      { config: { ...CONFIG, stopPrice: '100.2' } },
      { appliedBy: 'ai-desk:ag-1', expectedVersion: 3 },
    );
    expect(m.acciones.get('a-1')).toMatchObject({
      action: 'PROTEGER',
      action_class: 'REDUCIR',
      state: 'APLICADA',
      decided_by: 'AUTO',
      applied_version: 4,
    });
    expect(m.avisos.agente).toHaveBeenCalledWith(
      'u-1',
      'AGENT_ACTION',
      'INFO',
      expect.stringContaining('BTC largo: aplicado proteger la entrada · stop a 100.2'),
      expect.objectContaining({ accionId: 'a-1', accion: 'PROTEGER' }),
    );
  });

  it('cerrar se propone, con su vale y sus botones, y no toca el bot', async () => {
    const m = montar({ estado: { tesis: 'ROTA' } });
    await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(m.acciones.get('a-1')).toMatchObject({ action: 'CERRAR', state: 'PROPUESTA' });
    expect(m.bots.updateConfig).not.toHaveBeenCalled();
    expect(m.avisos.vale).toHaveBeenCalledWith(
      { userId: 'u-1', agentId: 'ag-1', propuestaId: 'p-1', accionId: 'a-1' },
      1800,
    );
    expect(m.avisos.agente).toHaveBeenCalledWith(
      'u-1',
      'AGENT_ACTION',
      'INFO',
      expect.stringContaining('propone cerrar la operación'),
      expect.objectContaining({ accion: 'CERRAR', vale: 'fedcba9876543210fedcba9876543210' }),
    );
  });

  it('el freno de forzar manual lo pasa todo a propuesta', async () => {
    const m = montar({
      estado: { tesis: 'DEBILITADA', rAhora: 1.2 },
      env: { AI_DESK_FORCE_MANUAL: 'true' },
    });
    await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(m.acciones.get('a-1')).toMatchObject({ action: 'PROTEGER', state: 'PROPUESTA' });
    expect(m.bots.updateConfig).not.toHaveBeenCalled();
  });

  it('en modo IA, el modelo elige de lo ofrecido; con confianza BAJA se mantiene', async () => {
    const m = montar({ agente: { decision_mode: 'IA' } });
    await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(m.consumo.cupo).toHaveBeenCalled();
    expect(m.bots.updateConfig).toHaveBeenCalled();
    const peticion = m.modelo.decidirAgente.mock.calls[0][0] as { usuario: string };
    expect(peticion.usuario).not.toContain('BTC');

    const baja = montar({ agente: { decision_mode: 'IA' }, respuesta: { confianza: 'BAJA' } });
    expect((await baja.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA))?.motivo).toBe('MANTENER');
    expect(baja.bots.updateConfig).not.toHaveBeenCalled();
  });
});

describe('AiDeskSeguimientoService — sin modelo decide el juez (spec 078, decisión 4 del 075)', () => {
  // La idea debilitada con 1,2 R a favor: el juez protege, y reducir es automático.
  const IA = { decision_mode: 'IA' };
  const DEBIL = { tesis: 'DEBILITADA' as const, rAhora: 1.2 };

  it.each<[string, Opciones, string, boolean, string | null]>([
    ['el modelo no respondió a tiempo', { respuesta: null }, 'MODELO:TIEMPO', true, 'TIEMPO'],
    [
      'respondió fuera del contrato',
      { respuesta: { accion: 'VOLAR' } },
      'CONTRATO',
      true,
      'CONTRATO',
    ],
    [
      'el agente duerme tras sus fallos',
      { agente: { ...IA, sleeping_until: new Date(AHORA + 60_000) } },
      'DORMIDO',
      false,
      null,
    ],
    ['no hay clave del modelo', { modelo: false }, 'SIN_CLAVE', false, null],
  ])('%s: aplica lo del juez, sin huella', async (_, opciones, sinModelo, llama, fallo) => {
    const m = montar({ agente: IA, estado: DEBIL, ...opciones });
    const r = await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'COMPLETADA', motivo: 'ACCION' });
    // Lo del juez, por el camino de siempre: se aplica porque reducir es automático.
    expect(m.acciones.get('a-1')).toMatchObject({ action: 'PROTEGER', state: 'APLICADA' });
    expect(m.bots.updateConfig).toHaveBeenCalled();
    expect(m.modelo.decidirAgente).toHaveBeenCalledTimes(llama ? 1 : 0);
    const decision = cierre(m)['decision'] as Record<string, unknown>;
    expect(decision).toMatchObject({ accion: 'PROTEGER', juez: 'PROTEGER', sinModelo });
    expect(decision['fallo'] ?? null).toBe(fallo);
    // Sin huella: la vela siguiente vuelve a preguntar al modelo.
    expect(cierre(m)).not.toHaveProperty('huella');
  });

  it('un fallo del modelo sigue contando en la racha; dormido o sin clave no se anota nada', async () => {
    const tiempo = montar({ agente: IA, estado: DEBIL, respuesta: null });
    await tiempo.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(tiempo.consumo.anotar).toHaveBeenCalledWith(
      expect.anything(),
      null,
      'MODELO:TIEMPO',
      AHORA,
    );
    const dormido = montar({
      agente: { ...IA, sleeping_until: new Date(AHORA + 60_000) },
      estado: DEBIL,
    });
    await dormido.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(dormido.consumo.anotar).not.toHaveBeenCalled();
  });

  it('sin cupo tampoco se llama, y decide el juez', async () => {
    const m = montar({ agente: IA, estado: DEBIL });
    m.consumo.cupo.mockResolvedValueOnce('CUPO_AGENTE' as never);
    const r = await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'COMPLETADA', motivo: 'ACCION' });
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
    expect(cierre(m)['decision']).toMatchObject({ sinModelo: 'CUPO_AGENTE' });
  });

  it('con la idea intacta, el juez mantiene: nada que hacer, aunque no haya modelo', async () => {
    const m = montar({ agente: IA, respuesta: null });
    const r = await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'COMPLETADA', motivo: 'MANTENER' });
    expect(m.db.aiDeskAction.create).not.toHaveBeenCalled();
  });

  it('con el modelo respondiendo, la ronda sí guarda su huella', async () => {
    const m = montar({ agente: IA, estado: DEBIL });
    await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(cierre(m)['huella']).toEqual(expect.any(String));
    expect(cierre(m)['decision']).not.toHaveProperty('sinModelo');
  });
});

describe('AiDeskSeguimientoService — el plazo del modelo (spec 078)', () => {
  it('pide con el plazo configurado, y la decisión guarda lo que gastó y pensó el modelo', async () => {
    const m = montar({ agente: { decision_mode: 'IA' } });
    await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    const peticion = m.modelo.decidirAgente.mock.calls[0][0] as { limiteMs: number };
    expect(peticion.limiteMs).toBe(90_000);
    expect((cierre(m)['decision'] as Record<string, unknown>)['uso']).toEqual(USO);
  });
});

describe('AiDeskSeguimientoService — «Revisar ahora» no espera al modelo (spec 078)', () => {
  it('responde con la ronda en curso, la termina aparte y suelta su hueco al acabar', async () => {
    const m = montar({ agente: { decision_mode: 'IA' } });
    let responder: (v: unknown) => void = () => undefined;
    m.modelo.decidirAgente.mockImplementationOnce(
      () =>
        new Promise((r) => {
          responder = r;
        }) as never,
    );
    const vista = await m.svc.revisarAhora('u-1', 'p-1');
    expect(vista).toMatchObject({ id: 'r-1', estado: 'EN_CURSO' });
    expect(m.cache.setnx).toHaveBeenCalledWith('ai-desk:revisar:p-1', 1, 150);

    await hasta(() => m.modelo.decidirAgente.mock.calls.length === 1);
    expect(m.svc.huecos).toBe(1);
    responder({
      contenido: JSON.stringify({
        accion: 'MANTENER',
        tesis: 'INTACTA',
        confianza: 'ALTA',
        motivo1: 'NINGUNO',
        motivo2: 'NINGUNO',
        motivo3: 'NINGUNO',
        texto: 'Sigue.',
      }),
      uso: USO,
      fallo: null,
      latenciaMs: 95_000,
      modelo: 'x/y',
    });
    await hasta(() => m.svc.huecos === 2);
    expect(cierre(m)).toMatchObject({ state: 'COMPLETADA', reason: 'MANTENER' });
  });
});

describe('AiDeskSeguimientoService — aplicar, contra la configuración de ahora', () => {
  it('si la configuración ya tiene un stop más ceñido, esto ya no reduce nada: DESCARTADA', async () => {
    const m = montar({ estado: { tesis: 'DEBILITADA', rAhora: 1.2 }, configStop: '100.5' });
    await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(m.acciones.get('a-1')).toMatchObject({ state: 'DESCARTADA', reason: 'CUBIERTA' });
    expect(m.bots.updateConfig).not.toHaveBeenCalled();
  });

  it('si el bot cambió entretanto, FALLIDA por versión', async () => {
    const m = montar({ estado: { tesis: 'DEBILITADA', rAhora: 1.2 } });
    m.bots.updateConfig.mockRejectedValueOnce(
      new ConflictException({ message: 'rancia', code: 'STALE_VERSION' }),
    );
    await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    expect(m.acciones.get('a-1')).toMatchObject({ state: 'FALLIDA', reason: 'VERSION' });
  });
});

describe('AiDeskSeguimientoService — lo que decide una persona', () => {
  async function conPropuesta() {
    const m = montar({ estado: { tesis: 'ROTA' } });
    await m.svc.rondaSeguimiento('p-1', 'INTERVALO', AHORA);
    return m;
  }

  it('aprobar aplica lo propuesto; la segunda vez ya no está pendiente', async () => {
    const m = await conPropuesta();
    const r = await m.svc.aprobarAccion('u-1', 'a-1', 'APP');
    expect(r).toMatchObject({ estado: 'APLICADA', mensaje: 'Aplicado.' });
    expect(m.bots.updateConfig).toHaveBeenCalledWith(
      'u-1',
      'b-1',
      { config: { ...CONFIG, positionCap: '0' } },
      expect.objectContaining({ expectedVersion: 3 }),
    );
    expect((await m.svc.aprobarAccion('u-1', 'a-1', 'APP')).mensaje).toBe(
      'La acción ya no está pendiente.',
    );
  });

  it('caducada, no se aplica; ajena, no existe', async () => {
    const m = await conPropuesta();
    Object.assign(m.acciones.get('a-1') ?? {}, { expires_at: new Date(Date.now() - 1) });
    expect((await m.svc.aprobarAccion('u-1', 'a-1', 'APP')).mensaje).toBe(
      'La acción ya no está pendiente.',
    );
    expect(m.bots.updateConfig).not.toHaveBeenCalled();
    await expect(m.svc.aprobarAccion('otro', 'a-1', 'APP')).rejects.toThrow(NotFoundException);
  });

  it('rechazar la deja RECHAZADA por su dueño', async () => {
    const m = await conPropuesta();
    expect(await m.svc.rechazarAccion('u-1', 'a-1', 'TELEGRAM')).toMatchObject({
      estado: 'RECHAZADA',
    });
    expect(m.acciones.get('a-1')).toMatchObject({ reason: 'PERSONA', decided_by: 'TELEGRAM' });
  });

  it('cerrar la operación: el comando de siempre, y lo pendiente deja de esperar', async () => {
    const m = await conPropuesta();
    const r = await m.svc.cerrarOperacion('u-1', 'p-1', 'APP');
    expect(r.mensaje).toBe('Cerrando la operación a mercado.');
    expect(m.bots.command).toHaveBeenCalledWith('u-1', 'b-1', {
      command: 'STOP_AND_CLOSE',
      confirm: true,
    });
  });

  it('los botones: sí aplica, no descarta, cierra cierra; un vale ajeno o de entrada, nada', async () => {
    const vale = { userId: 'u-1', propuestaId: 'p-1', accionId: 'a-1' };
    const si = await conPropuesta();
    expect(await si.svc.pulsacion('u-1', vale, 'si')).toBe(true);
    expect(si.acciones.get('a-1')?.['state']).toBe('APLICADA');

    const no = await conPropuesta();
    await no.svc.pulsacion('u-1', vale, 'no');
    expect(no.acciones.get('a-1')?.['state']).toBe('RECHAZADA');

    const cierra = await conPropuesta();
    await cierra.svc.pulsacion('u-1', vale, 'cierra');
    expect(cierra.bots.command).toHaveBeenCalled();

    const ajeno = await conPropuesta();
    expect(await ajeno.svc.pulsacion('otro', vale, 'si')).toBe(true);
    expect(ajeno.acciones.get('a-1')?.['state']).toBe('PROPUESTA');
    expect(await ajeno.svc.pulsacion('u-1', { ...vale, accionId: null }, 'si')).toBe(false);
  });
});
