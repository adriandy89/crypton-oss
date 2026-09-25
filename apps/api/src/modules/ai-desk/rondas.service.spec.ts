import { ConfigService } from '@nestjs/config';
import {
  DEFAULTS_AGENTE,
  construirPropuesta,
  herramientaAgente,
  type HistorialAgente,
} from '@crypton/strategy-core';
import { TOPE_FALLOS_AGENTE, type SalidaAgente } from '@crypton/shared';
import { AiDeskConfig } from './ai-desk.config';
import { BAR_T, candidatoDePrueba, planDePrueba, salidaDePrueba } from './agentes.fixture-spec';
import { AiDeskConsumoService } from './consumo.service';
import { AiDeskRondasService } from './rondas.service';

/**
 * La ronda de entrada de un agente (spec 074, R-12 a R-18, CA-5 y CA-6).
 *
 * La herramienta y el generador se sustituyen por dobles —su aritmética la
 * prueba `strategy-core`—; la oferta, el juez y la barrera del día son los de
 * verdad. Lo que se fija es la ronda: las barreras en su orden y sin gastar,
 * el cupo contado antes de llamar, sin Redis no se llama, una ronda por vela
 * aunque la pidan dos réplicas, y la propuesta según la autonomía.
 */

jest.mock('@crypton/strategy-core', () => ({
  ...jest.requireActual<Record<string, unknown>>('@crypton/strategy-core'),
  herramientaAgente: jest.fn(),
  construirPropuesta: jest.fn(),
}));
const herramienta = herramientaAgente as jest.MockedFunction<typeof herramientaAgente>;
const generador = construirPropuesta as jest.MockedFunction<typeof construirPropuesta>;

/** Una hora después del cierre de la vela de prueba, más el retraso: su ronda. */
const AHORA = BAR_T + 3_600_000 + 15_000;
const LIMITES = { capital: '1000', ...DEFAULTS_AGENTE };

const HISTORIAL: HistorialAgente = {
  dia: Math.floor(AHORA / 86_400_000) * 86_400_000,
  operacionesHoy: 0,
  realizadoHoy: '0',
  riesgoAbierto: '0',
  vivas: 0,
  pendientes: 0,
  rachaPerdidas: 0,
  ultimaPerdidaEn: null,
  ultimoStopEn: {},
  ocupados: ['SOL'],
};

interface Opciones {
  env?: Record<string, string>;
  agente?: Record<string, unknown>;
  cuenta?: Record<string, unknown>;
  rol?: string;
  entradas?: boolean | null;
  historial?: Partial<HistorialAgente>;
  modelo?: boolean;
  contenido?: string | null;
  cupo?: number;
  huellaPrevia?: string | null;
  duplicada?: boolean;
  salida?: SalidaAgente;
  maxBots?: number | null;
}

/** Lo que devuelve el cliente de una llamada que respondió. */
const USO = {
  tokensEntrada: 3000,
  tokensSalida: 420,
  tokensCacheLeidos: 2500,
  tokensCacheEscritos: 0,
  tokensRazonamiento: 380,
  coste: '0.004',
};

const respuestaModelo = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    opcion: 'A',
    stop: 'NORMAL',
    objetivo: 'ESCALONADO',
    apalancamiento: 'BAJA',
    tamano: 'COMPLETO',
    confianza: 'ALTA',
    motivo1: 'TENDENCIA_CLARA',
    motivo2: 'NINGUNO',
    motivo3: 'NINGUNO',
    riesgo1: 'NINGUNO',
    riesgo2: 'NINGUNO',
    texto: 'Retroceso ordenado.',
    ...extra,
  });

function montar(o: Opciones = {}) {
  const agente = {
    id: 'ag-1',
    name: 'Tendencias',
    user_id: 'u-1',
    state: 'ACTIVO',
    symbols: ['BTC', 'ETH', 'SOL'],
    interval: '1h',
    families: ['TENDENCIA', 'RUPTURA', 'REVERSION'],
    sides: ['LONG', 'SHORT'],
    decision_mode: 'IA',
    limits: LIMITES,
    auto_entry: 'MANUAL',
    auto_reduce: 'AUTO',
    auto_close: 'MANUAL',
    sleeping_until: null,
    failures: 0,
    usage_day: null,
    cost_today: '0',
    exchange_account: {
      id: 'acc-1',
      venue: 'HYPERLIQUID',
      paper: false,
      testnet: false,
      status: 'ACTIVE',
      ...(o.cuenta ?? {}),
    },
    user: { role: o.rol ?? 'ADMIN', disabled: false },
    ...(o.agente ?? {}),
  };
  const rondas: Record<string, unknown>[] = [];
  const db = {
    aiDeskAgent: {
      findUnique: jest.fn(async () => agente),
      // El dueño, para «Analizar ahora».
      findFirst: jest.fn(async () => ({ id: agente.id })),
      update: jest.fn(async () => ({ failures: 0 })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    aiDeskRound: {
      create: jest.fn(async () => {
        if (o.duplicada) throw Object.assign(new Error('única'), { code: 'P2002' });
        return { id: 'r-1' };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rondas.push(data);
        return {};
      }),
      findFirst: jest.fn(async () =>
        o.huellaPrevia === undefined ? null : { huella: o.huellaPrevia },
      ),
      // La fila como está AHORA: EN_CURSO hasta que la ronda se cierra.
      findUnique: jest.fn(async () => filaRonda(rondas[rondas.length - 1])),
    },
    aiDeskProposal: {
      create: jest.fn(async () => ({ id: 'p-1' })),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    aiDeskCandidate: { createMany: jest.fn(async () => ({ count: 0 })) },
    bot: { count: jest.fn(async () => 3) },
  };
  let contador = 0;
  const cache = {
    incrWithExpire: jest.fn(async () => (o.cupo === undefined ? ++contador : o.cupo)),
    setnx: jest.fn(async () => true),
  };
  const cfg = new AiDeskConfig({
    get: (k: string, def?: string) => ({ AI_DESK_ENABLE: 'true', ...(o.env ?? {}) })[k] ?? def,
  } as unknown as ConfigService);
  const interruptores = {
    entradasAbiertas: jest.fn(async () => (o.entradas === undefined ? true : o.entradas)),
  };
  const lectura = {
    par: jest.fn(async (_v: string, simbolo: string) => ({
      par: {
        simbolo,
        market: { symbol: simbolo, quote: 'USDC' },
        ticker: { bid: '1', ask: '1', mark: '1' },
        velas: [],
        fundingBps: null,
        niveles: [],
      },
      sinTramos: false,
    })),
    saldoLibre: jest.fn(async () => '800'),
    maxApalancamiento: jest.fn(async () => null),
  };
  const agentes = { historial: jest.fn(async () => ({ ...HISTORIAL, ...(o.historial ?? {}) })) };
  const modelo = {
    agentesDisponible: o.modelo ?? true,
    agentesEsfuerzo: 'medium',
    decidirAgente: jest.fn(async (_peticion: unknown) => {
      const falla = o.contenido === null;
      return {
        contenido: o.contenido === undefined ? respuestaModelo() : o.contenido,
        // Como el cliente real: un tiempo agotado no trae uso ni coste (spec 078).
        uso: falla ? null : USO,
        fallo: falla ? 'TIEMPO' : null,
        latenciaMs: 1234,
        modelo: 'x/y',
      };
    }),
  };
  const avisos = {
    agente: jest.fn(async () => undefined),
    vale: jest.fn(async () => 'fedcba9876543210fedcba9876543210'),
  };
  const aprobacion = { aprobar: jest.fn(async () => ({ estado: 'EJECUTANDO' })) };
  const risk = { get: jest.fn(async () => ({ max_open_bots: o.maxBots ?? null })) };
  const svc = new AiDeskRondasService(
    db as never,
    cache as never,
    cfg,
    interruptores as never,
    lectura as never,
    agentes as never,
    modelo as never,
    avisos as never,
    aprobacion as never,
    risk as never,
    new AiDeskConsumoService(db as never, cache as never, cfg, avisos as never),
  );
  herramienta.mockReturnValue(o.salida ?? salidaDePrueba());
  generador.mockReturnValue({ plan: planDePrueba(), motivo: null });
  return { svc, db, cache, lectura, modelo, avisos, aprobacion, rondas, agentes };
}

/** Lo que se escribió al cerrar la ronda. */
const cierre = (m: ReturnType<typeof montar>) => m.rondas[m.rondas.length - 1];

/** La fila de la ronda con lo último que se escribió en ella, o recién creada. */
const filaRonda = (cerrada?: Record<string, unknown>) => ({
  id: 'r-1',
  kind: 'ENTRADA',
  bar_t: new Date(BAR_T),
  trigger: 'MANUAL',
  state: cerrada?.['state'] ?? 'EN_CURSO',
  reason: cerrada?.['reason'] ?? null,
  decision_mode: 'IA',
  created_at: new Date(AHORA),
  finished_at: null,
  model: null,
  latency_ms: null,
  cost: null,
  decision: null,
  snapshot: null,
  proposals: [],
});

/** Deja correr lo que se lanzó sin esperar, hasta que se cumpla la condición. */
async function hasta(condicion: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condicion(); i++) {
    await new Promise((r) => setImmediate(r));
  }
  expect(condicion()).toBe(true);
}

beforeEach(() => {
  herramienta.mockReset();
  generador.mockReset();
});

describe('AiDeskRondasService — una ronda por vela', () => {
  it('la de la vela que acaba de cerrar, y si otra réplica ya la hizo, nada', async () => {
    const m = montar();
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(m.db.aiDeskRound.create).toHaveBeenCalledWith({
      data: {
        agent_id: 'ag-1',
        kind: 'ENTRADA',
        bar_t: new Date(BAR_T),
        trigger: 'INTERVALO',
        decision_mode: 'IA',
      },
      select: { id: true },
    });

    const otra = montar({ duplicada: true });
    await expect(otra.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA)).resolves.toBeNull();
    expect(otra.lectura.par).not.toHaveBeenCalled();
    expect(otra.modelo.decidirAgente).not.toHaveBeenCalled();
  });
});

describe('AiDeskRondasService — las barreras, en orden y sin gastar', () => {
  it.each<[string, Opciones, string]>([
    ['el módulo apagado', { env: { AI_DESK_ENABLE: 'false' } }, 'IA_APAGADA'],
    ['modo IA sin clave del modelo', { modelo: false }, 'IA_APAGADA'],
    ['un dueño que ya no es administrador', { rol: 'USER' }, 'DUENO'],
    ['el agente en pausa', { agente: { state: 'PAUSADO' } }, 'AGENTE'],
    [
      'el agente dormido por fallos',
      { agente: { sleeping_until: new Date(AHORA + 60_000) } },
      'DORMIDO',
    ],
    ['Redis caído', { entradas: null }, 'REDIS'],
    ['las entradas cortadas', { entradas: false }, 'INTERRUPTOR'],
    ['la cuenta revocada', { cuenta: { status: 'REVOKED' } }, 'CUENTA'],
    ['las operaciones del día agotadas', { historial: { operacionesHoy: 4 } }, 'OPERACIONES_DIA'],
    ['sin sitio: dos pendientes', { historial: { pendientes: 2 } }, 'CAPACIDAD'],
    ['el tope de bots del usuario', { maxBots: 3 }, 'LIMITES_USUARIO'],
    ['todos los pares ocupados', { historial: { ocupados: ['BTC', 'ETH', 'SOL'] } }, 'SIN_PARES'],
  ])('%s: SALTADA con su motivo, sin leer el mercado ni llamar', async (_, opciones, motivo) => {
    const m = montar(opciones);
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'SALTADA', motivo });
    expect(cierre(m)).toMatchObject({ state: 'SALTADA', reason: motivo });
    expect(m.lectura.par).not.toHaveBeenCalled();
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
  });

  it('un agente de reglas no necesita la clave del modelo', async () => {
    const m = montar({ modelo: false, agente: { decision_mode: 'REGLAS' } });
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r?.motivo).toBe('PROPUESTA');
  });

  it('la pérdida del día pausa el agente, una vez, y lo avisa', async () => {
    const m = montar({ historial: { realizadoHoy: '-25' } });
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r?.motivo).toBe('PERDIDA_DIARIA');
    expect(m.db.aiDeskAgent.updateMany).toHaveBeenCalledWith({
      where: { id: 'ag-1', state: 'ACTIVO' },
      data: { state: 'PAUSADO', pause_reason: 'PERDIDA_DIARIA' },
    });
    expect(m.avisos.agente).toHaveBeenCalledWith(
      'u-1',
      'AGENT_PAUSED',
      'WARN',
      expect.stringContaining('el agente se pausa'),
      { agentId: 'ag-1' },
    );
    // Ya pausado hoy: la barrera sigue cortando, sin pausar ni avisar otra vez.
    const otra = montar({ historial: { realizadoHoy: '-25' } });
    otra.cache.setnx.mockResolvedValue(false);
    await otra.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(otra.db.aiDeskAgent.updateMany).not.toHaveBeenCalled();
    expect(otra.avisos.agente).not.toHaveBeenCalled();
  });

  it('sin saldo legible no se dimensiona nada', async () => {
    const m = montar();
    m.lectura.saldoLibre.mockResolvedValueOnce(null as never);
    expect((await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA))?.motivo).toBe('CUENTA');
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
  });

  it('los pares ocupados no se leen, y quedan en lo que vio la ronda con su motivo', async () => {
    const m = montar();
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(m.lectura.par.mock.calls.map((c: unknown[]) => c[1])).toEqual(['BTC', 'ETH']);
    const snapshot = cierre(m)['snapshot'] as SalidaAgente;
    expect(snapshot.pares.find((p) => p.descartes.includes('OCUPADO'))?.simbolo).toBe('SOL');
  });

  it('sin candidatos no se llama', async () => {
    const vacia = salidaDePrueba({
      pares: [
        {
          simbolo: 'BTC',
          mercado: salidaDePrueba().pares[0].mercado,
          candidatos: [],
          descartes: [],
        },
      ],
    });
    const m = montar({ salida: vacia });
    expect((await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA))?.motivo).toBe('SIN_CANDIDATOS');
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
  });

  it('la misma oferta que la última vez no se vuelve a pagar', async () => {
    const m = montar({ huellaPrevia: salidaDePrueba().huella });
    expect((await m.svc.rondaEntrada('ag-1', 'MANUAL', AHORA))?.motivo).toBe('HUELLA');
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
  });
});

describe('AiDeskRondasService — el cupo, ANTES de llamar', () => {
  it('se cuenta antes de llamar: agotado, no se llama', async () => {
    const m = montar({ cupo: 121 });
    expect((await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA))?.motivo).toBe('CUPO_AGENTE');
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
  });

  it('sin Redis no hay contador, y sin contador no se llama', async () => {
    const m = montar({ cupo: -1 });
    expect((await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA))?.motivo).toBe('REDIS');
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
  });

  it('el gasto del día del agente, también', async () => {
    const hoy = new Date(Math.floor(AHORA / 86_400_000) * 86_400_000);
    const m = montar({ agente: { usage_day: hoy, cost_today: '5' } });
    expect((await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA))?.motivo).toBe('GASTO');
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
  });

  it('manda el menor entre el cupo del agente y el del servidor', async () => {
    const m = montar({ env: { AI_DESK_DAILY_LIMIT: '10' }, cupo: 11 });
    expect((await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA))?.motivo).toBe('CUPO_AGENTE');
  });
});

describe('AiDeskRondasService — la decisión y la propuesta', () => {
  it('la IA elige, se propone con su vale y su aviso, y se guarda todo lo que vio', async () => {
    const m = montar();
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'COMPLETADA', motivo: 'PROPUESTA', propuestaId: 'p-1' });

    // Lo que ve el modelo: la oferta en relativo, con su esquema de letras.
    const peticion = m.modelo.decidirAgente.mock.calls[0][0] as {
      esquema: { schema: { properties: Record<string, { enum?: string[] }> } };
      usuario: string;
    };
    expect(peticion.esquema.schema.properties['opcion'].enum).toEqual(['A', 'B', 'NINGUNA']);
    expect(peticion.usuario).not.toContain('BTC');

    // La propuesta, desde el generador, con la elección de la IA.
    expect(generador.mock.calls[0][1]).toEqual({
      candidatoId: candidatoDePrueba().id,
      stop: 'NORMAL',
      objetivo: 'ESCALONADO',
      apalancamiento: 'BAJA',
      tamano: 'COMPLETO',
      confianza: 'ALTA',
    });
    expect(m.db.aiDeskProposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agent_id: 'ag-1',
        round_id: 'r-1',
        symbol: 'BTC',
        family: 'TENDENCIA',
        side: 'LONG',
        state: 'PROPUESTA',
        reason: null,
        dry_run: false,
        // Nunca más que el intervalo, ni que el TTL: 15 min de fábrica, contados
        // desde que la propuesta existe (lo fija «la vida de la propuesta…»).
        expires_at: expect.any(Date) as Date,
      }),
      select: { id: true },
    });
    expect(m.avisos.vale).toHaveBeenCalledWith(
      { userId: 'u-1', agentId: 'ag-1', propuestaId: 'p-1', accionId: null },
      900,
    );
    expect(m.avisos.agente).toHaveBeenCalledWith(
      'u-1',
      'AGENT_PROPOSAL',
      'WARN',
      expect.stringContaining('DINERO REAL · BTC largo (TENDENCIA)'),
      { agentId: 'ag-1', propuestaId: 'p-1', vale: 'fedcba9876543210fedcba9876543210' },
    );
    expect(m.aprobacion.aprobar).not.toHaveBeenCalled();

    // Los candidatos, se ofrecieran o no, con su letra y quién los eligió.
    const filas = (
      m.db.aiDeskCandidate.createMany.mock.calls[0] as unknown as [
        { data: Record<string, unknown>[] },
      ]
    )[0].data;
    expect(
      filas.map((f) => [f['symbol'], f['letter'], f['eligible'], f['chosen'], f['judge_choice']]),
    ).toEqual([
      ['BTC', 'A', true, true, true],
      ['ETH', 'B', true, false, false],
    ]);
    // Cada uno con su plan medible, y el intervalo y la duración de ESTA ronda: si
    // su dueño edita el agente después, lo ya decidido se sigue midiendo con lo suyo.
    expect(filas[0]['measurable']).toMatchObject({
      lado: 'LONG',
      barT: expect.any(Number) as number,
      intervalo: '1h',
      maxVelas: 24,
    });
    // La ronda, con lo que vio, el modelo, la versión del prompt y el coste.
    expect(cierre(m)).toMatchObject({
      state: 'COMPLETADA',
      reason: 'PROPUESTA',
      model: 'x/y',
      latency_ms: 1234,
      cost: '0.004',
    });
    expect(String(cierre(m)['prompt_version'])).toMatch(/^agentes-v1-/);
  });

  it('NINGUNA: la ronda termina sin propuesta, y el juez queda anotado', async () => {
    const m = montar({ contenido: respuestaModelo({ opcion: 'NINGUNA' }) });
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'COMPLETADA', motivo: 'NINGUNA', propuestaId: null });
    expect(m.db.aiDeskProposal.create).not.toHaveBeenCalled();
    expect((cierre(m)['decision'] as Record<string, unknown>)['juez']).toMatchObject({
      candidatoId: candidatoDePrueba().id,
    });
  });

  it('en modo reglas decide el juez, sin llamar a nadie', async () => {
    const m = montar({ agente: { decision_mode: 'REGLAS' } });
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r?.motivo).toBe('PROPUESTA');
    expect(m.modelo.decidirAgente).not.toHaveBeenCalled();
    expect(m.cache.incrWithExpire).not.toHaveBeenCalled();
  });

  it('«entrar» en automático aprueba solo, por la misma rutina', async () => {
    const m = montar({ agente: { auto_entry: 'AUTO' } });
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(m.aprobacion.aprobar).toHaveBeenCalledWith('u-1', 'p-1', 'AUTO');
    expect(m.avisos.vale).not.toHaveBeenCalled();
    expect(m.avisos.agente).toHaveBeenCalledWith(
      'u-1',
      'AGENT_PROPOSAL',
      'INFO',
      expect.stringContaining('Automático: abre'),
      { agentId: 'ag-1', propuestaId: 'p-1' },
    );
  });

  it('«entrar» en solo medir: se registra en sombra, sin aviso ni aprobación', async () => {
    const m = montar({ agente: { auto_entry: 'OFF' } });
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r?.motivo).toBe('SOMBRA');
    expect(m.db.aiDeskProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'SOMBRA', reason: 'SOLO_MEDIR' }),
      }),
    );
    expect(m.avisos.agente).not.toHaveBeenCalled();
    expect(m.aprobacion.aprobar).not.toHaveBeenCalled();
  });

  it('el freno de solo simulación deja en sombra la entrada con dinero real', async () => {
    const m = montar({ env: { AI_DESK_DRY_RUN_ONLY: 'true' } });
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(m.db.aiDeskProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'SOMBRA', reason: 'SOLO_SIMULACION' }),
      }),
    );
  });

  it('en la cuenta de simulación la propuesta es simulada y no dice «dinero real»', async () => {
    const m = montar({ cuenta: { paper: true } });
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(m.db.aiDeskProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dry_run: true }) }),
    );
    const texto = (m.avisos.agente.mock.calls[0] as unknown as unknown[])[3] as string;
    expect(texto).not.toContain('DINERO REAL');
  });
});

describe('AiDeskRondasService — los fallos del modelo', () => {
  it('sin respuesta: FALLIDA, sin propuesta, y cuenta en la racha', async () => {
    const m = montar({ contenido: null });
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'FALLIDA', motivo: 'MODELO' });
    expect(m.db.aiDeskProposal.create).not.toHaveBeenCalled();
    expect(m.db.aiDeskAgent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failures: { increment: 1 }, last_error: 'MODELO:TIEMPO' }),
      }),
    );
  });

  it('fuera del contrato: FALLIDA, con lo que dijo guardado para mirarlo', async () => {
    const m = montar({ contenido: respuestaModelo({ opcion: 'Z' }) });
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'FALLIDA', motivo: 'CONTRATO' });
    expect((cierre(m)['decision'] as Record<string, unknown>)['bruto']).toContain('"opcion":"Z"');
  });

  it('una respuesta válida rompe la racha', async () => {
    const m = montar();
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(m.db.aiDeskAgent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failures: 0 }) }),
    );
  });

  it('al quinto seguido, el agente duerme seis horas y se avisa una vez', async () => {
    const m = montar({ contenido: null });
    m.db.aiDeskAgent.update.mockResolvedValueOnce({ failures: TOPE_FALLOS_AGENTE });
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(m.db.aiDeskAgent.update).toHaveBeenLastCalledWith({
      where: { id: 'ag-1' },
      data: { sleeping_until: new Date(AHORA + 6 * 3_600_000), failures: 0 },
    });
    expect(m.avisos.agente).toHaveBeenCalledWith(
      'u-1',
      'AGENT_SLEEPING',
      'WARN',
      expect.stringContaining('6 h'),
      { agentId: 'ag-1' },
    );
  });

  it('lo inesperado deja la ronda FALLIDA con ERROR, no a medias', async () => {
    const m = montar();
    m.agentes.historial.mockRejectedValueOnce(new Error('se cayó la base'));
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r).toMatchObject({ estado: 'FALLIDA', motivo: 'ERROR' });
  });
});

describe('AiDeskRondasService — el plazo del modelo (spec 078)', () => {
  it('pide con el plazo configurado: 90 s de fábrica', async () => {
    const m = montar();
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    const peticion = m.modelo.decidirAgente.mock.calls[0][0] as { limiteMs: number };
    expect(peticion.limiteMs).toBe(90_000);
  });

  it('la decisión guarda lo que gastó y lo que pensó el modelo', async () => {
    const m = montar({ contenido: respuestaModelo({ opcion: 'NINGUNA' }) });
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect((cierre(m)['decision'] as Record<string, unknown>)['uso']).toEqual(USO);
  });

  it('un tiempo agotado no trae coste: la ronda lo deja sin importe, no a cero', async () => {
    const m = montar({ contenido: null });
    await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(cierre(m)).toMatchObject({ reason: 'MODELO', model: 'x/y', cost: null });
    expect((cierre(m)['decision'] as Record<string, unknown>)['uso']).toBeNull();
  });

  it('avisa al arrancar si el plazo no deja terminar al razonamiento', () => {
    const corto = montar({ env: { AI_DESK_TIMEOUT_MS: '20000' } });
    expect(corto.svc.avisoPlazo()).toContain('AI_DESK_TIMEOUT_MS=20000');
    expect(corto.svc.avisoPlazo()).toContain('medium');
    expect(montar().svc.avisoPlazo()).toBeNull();
    // Apagado, o sin clave, no se llama a nadie: nada que avisar.
    expect(
      montar({ env: { AI_DESK_ENABLE: 'false', AI_DESK_TIMEOUT_MS: '20000' } }).svc.avisoPlazo(),
    ).toBeNull();
    expect(
      montar({ modelo: false, env: { AI_DESK_TIMEOUT_MS: '20000' } }).svc.avisoPlazo(),
    ).toBeNull();
  });
});

describe('AiDeskRondasService — «Analizar ahora» no espera al modelo (spec 078)', () => {
  it('responde con la ronda en curso, la termina aparte y suelta su hueco al acabar', async () => {
    // Con 90 s de plazo, esperar dentro de la petición chocaría con el proxy (60 s)
    // y con el interceptor global (80 s), mientras la ronda seguía corriendo.
    const m = montar();
    let responder: (v: unknown) => void = () => undefined;
    m.modelo.decidirAgente.mockImplementationOnce(
      () =>
        new Promise((r) => {
          responder = r;
        }) as never,
    );
    const vista = await m.svc.analizarAhora('u-1', 'ag-1');
    expect(vista).toMatchObject({ id: 'r-1', estado: 'EN_CURSO' });

    // El hueco sigue ocupado mientras el modelo piensa.
    await hasta(() => m.modelo.decidirAgente.mock.calls.length === 1);
    expect(m.svc.huecos).toBe(1);
    responder({
      contenido: respuestaModelo({ opcion: 'NINGUNA' }),
      uso: USO,
      fallo: null,
      latenciaMs: 95_000,
      modelo: 'x/y',
    });
    await hasta(() => m.svc.huecos === 2);
    expect(cierre(m)).toMatchObject({ state: 'COMPLETADA', reason: 'NINGUNA' });
  });

  it('el cerrojo dura un minuto más el plazo: dos clics no pagan dos llamadas en vuelo', async () => {
    const m = montar();
    await m.svc.analizarAhora('u-1', 'ag-1');
    expect(m.cache.setnx).toHaveBeenCalledWith('ai-desk:manual:ag-1', 1, 150);
    await hasta(() => m.svc.huecos === 2);
  });

  it('la vida de la propuesta se cuenta desde que existe, no desde que empezó la ronda', async () => {
    let reloj = 1_000_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => reloj);
    try {
      const m = montar();
      m.modelo.decidirAgente.mockImplementationOnce(async () => {
        reloj += 90_000;
        return {
          contenido: respuestaModelo(),
          uso: USO,
          fallo: null,
          latenciaMs: 90_000,
          modelo: 'x/y',
        };
      });
      await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
      expect(m.db.aiDeskProposal.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ expires_at: new Date(AHORA + 90_000 + 15 * 60_000) }),
        }),
      );
    } finally {
      now.mockRestore();
    }
  });
});

describe('AiDeskRondasService — la ronda fallida guarda lo que vio (spec 078)', () => {
  it.each<[string, Opciones]>([
    ['sin respuesta del modelo', { contenido: null }],
    ['fuera del contrato', { contenido: respuestaModelo({ opcion: 'Z' }) }],
  ])('%s: sus candidatos quedan, sin elegido y con el del juez', async (_, opciones) => {
    // Sin ellos, esa vela se perdía para medir si quien elige distingue lo bueno.
    const m = montar(opciones);
    const r = await m.svc.rondaEntrada('ag-1', 'INTERVALO', AHORA);
    expect(r?.estado).toBe('FALLIDA');
    const filas = (
      m.db.aiDeskCandidate.createMany.mock.calls[0] as unknown as [
        { data: Record<string, unknown>[] },
      ]
    )[0].data;
    expect(filas.map((f) => [f['symbol'], f['letter'], f['chosen'], f['judge_choice']])).toEqual([
      ['BTC', 'A', false, true],
      ['ETH', 'B', false, false],
    ]);
  });
});
