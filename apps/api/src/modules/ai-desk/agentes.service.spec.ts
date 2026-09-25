import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULTS_AGENTE } from '@crypton/strategy-core';
import { SIN_FRENOS, type InterruptoresAgentes } from '@crypton/shared';
import { AiDeskConfig } from './ai-desk.config';
import { AiDeskAgentesService } from './agentes.service';
import type { CrearAgenteDto, EditarAgenteDto } from './dtos';

/**
 * Los agentes de un administrador (spec 074, R-9, R-11 y R-28).
 *
 * Lo que se fija: cada uno ve y toca solo los suyos; el rol se relee de la
 * base en lo que da poder; el dinero real pide consentimiento al crear, al
 * reanudar y al pasar «entrar» a automático; editar sobre una versión vieja
 * responde 409; y lo pendiente se descarta cuando el agente cambia o se para.
 */

const ADMIN = 'admin-1';
const OTRO = 'admin-2';
const LIMITES = { capital: '1000', ...DEFAULTS_AGENTE };

const INTERRUPTORES: InterruptoresAgentes = {
  encendido: true,
  modeloDisponible: true,
  modelo: 'x/y',
  entradas: 'ABIERTAS',
  motivoEntradas: null,
  frenos: { ...SIN_FRENOS },
  limiteAgente: 200,
  limiteGlobal: 600,
  llamadasGlobalesHoy: 0,
};

type Fila = Record<string, unknown> & { id: string; user_id: string; version: number };

function montar(opciones: { rol?: string; disabled?: boolean; catalogo?: string[] } = {}) {
  const agentes = new Map<string, Fila>();
  const cuentas = new Map<string, Record<string, unknown>>([
    [
      'acc-real',
      {
        id: 'acc-real',
        user_id: ADMIN,
        venue: 'HYPERLIQUID',
        paper: false,
        testnet: false,
        status: 'ACTIVE',
        label: 'Principal',
      },
    ],
    [
      'acc-sim',
      {
        id: 'acc-sim',
        user_id: ADMIN,
        venue: 'HYPERLIQUID',
        paper: true,
        testnet: false,
        status: 'ACTIVE',
        label: 'Simulación',
      },
    ],
    [
      'acc-rev',
      {
        id: 'acc-rev',
        user_id: ADMIN,
        venue: 'HYPERLIQUID',
        paper: false,
        testnet: false,
        status: 'REVOKED',
        label: 'Vieja',
      },
    ],
    [
      'acc-ajena',
      {
        id: 'acc-ajena',
        user_id: OTRO,
        venue: 'HYPERLIQUID',
        paper: false,
        testnet: false,
        status: 'ACTIVE',
        label: 'Suya',
      },
    ],
  ]);
  let n = 0;
  const conCuenta = (f: Fila) => {
    const c = cuentas.get(String(f['exchange_account_id']));
    return {
      ...f,
      exchange_account: c && {
        id: c['id'],
        label: c['label'],
        venue: c['venue'],
        paper: c['paper'],
        testnet: c['testnet'],
      },
    };
  };
  const coincide = (f: Fila, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'not' in v) {
        return f[k] !== v.not;
      }
      return f[k] === v;
    });
  const db = {
    user: {
      findUnique: jest.fn(async () => ({
        role: opciones.rol ?? 'ADMIN',
        disabled: opciones.disabled ?? false,
      })),
    },
    exchangeAccount: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; user_id: string } }) => {
        const c = cuentas.get(where.id);
        return c && c['user_id'] === where.user_id ? c : null;
      }),
    },
    aiDeskAgent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        n++;
        const fila: Fila = {
          id: `ag-${n}`,
          state: 'ACTIVO',
          pause_reason: null,
          failures: 0,
          sleeping_until: null,
          last_error: null,
          usage_day: null,
          calls_today: 0,
          cost_today: '0',
          version: 1,
          created_at: new Date(),
          archived_at: null,
          ...data,
          user_id: String(data['user_id']),
        };
        agentes.set(fila.id, fila);
        return conCuenta(fila);
      }),
      findFirst: jest.fn(async ({ where }: { where: { id: string; user_id: string } }) => {
        const f = agentes.get(where.id);
        return f && f.user_id === where.user_id ? conCuenta(f) : null;
      }),
      findMany: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        [...agentes.values()].filter((f) => f.user_id === where.user_id).map(conCuenta),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const f = agentes.get(String(where['id']));
          if (!f || !coincide(f, where)) return { count: 0 };
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in v) {
              f[k] = Number(f[k]) + (v as { increment: number }).increment;
            } else {
              f[k] = v;
            }
          }
          return { count: 1 };
        },
      ),
    },
    aiDeskProposal: {
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async (): Promise<{ agent_id: string; _count: { _all: number } }[]> => []),
      count: jest.fn(async () => 0),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    bot: { findMany: jest.fn(async () => []) },
    aiDeskRound: {
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async (): Promise<{ agent_id: string; _count: { _all: number } }[]> => []),
    },
  };
  const markets = {
    getSpec: jest.fn(async (_v: string, s: string) => {
      if (!(opciones.catalogo ?? ['BTC', 'ETH', 'SOL']).includes(s)) {
        throw new NotFoundException(`El mercado ${s} no está disponible.`);
      }
      return { symbol: s };
    }),
  };
  const cfg = new AiDeskConfig({
    get: (_k: string, def?: string) => def,
  } as unknown as ConfigService);
  const interruptores = { interruptores: jest.fn(async () => INTERRUPTORES) };
  const audit = { recordNow: jest.fn(async () => undefined) };
  const svc = new AiDeskAgentesService(
    db as never,
    markets as never,
    cfg,
    interruptores as never,
    audit as never,
  );
  return { svc, db, agentes, audit, markets };
}

function crearDto(extra: Partial<CrearAgenteDto> = {}): CrearAgenteDto {
  return {
    nombre: 'Tendencias',
    exchangeAccountId: 'acc-sim',
    pares: ['BTC', 'ETH'],
    intervalo: '1h',
    familias: ['TENDENCIA', 'RUPTURA'],
    lados: ['LONG', 'SHORT'],
    modo: 'IA',
    limites: { ...LIMITES },
    autonomia: { entrar: 'MANUAL', reducir: 'AUTO', cerrar: 'MANUAL' },
    reason: 'probar el agente',
    ...extra,
  };
}

const editarDto = (version: number, extra: Partial<EditarAgenteDto> = {}): EditarAgenteDto => {
  const { exchangeAccountId: _cuenta, ...resto } = crearDto();
  return { ...resto, version, ...extra };
};

/** El cuerpo de un error HTTP de Nest. */
const cuerpo = async (p: Promise<unknown>): Promise<Record<string, unknown>> => {
  try {
    await p;
  } catch (e) {
    return (e as { getResponse(): Record<string, unknown> }).getResponse();
  }
  throw new Error('no ha lanzado');
};

describe('AiDeskAgentesService — crear', () => {
  it('crea en simulación sin consentimiento, con la próxima ronda y auditado', async () => {
    const { svc, audit } = montar();
    const antes = Date.now();
    const a = await svc.crear(ADMIN, crearDto());
    expect(a).toMatchObject({
      nombre: 'Tendencias',
      estado: 'ACTIVO',
      pares: ['BTC', 'ETH'],
      cuenta: { id: 'acc-sim', simulacion: true, real: false },
      autonomia: { entrar: 'MANUAL', reducir: 'AUTO', cerrar: 'MANUAL' },
      version: 1,
    });
    // La próxima ronda es el cierre de la vela de 1 h en curso, más el retraso.
    expect(Date.parse(String(a.proximaRonda))).toBeGreaterThan(antes);
    expect(Date.parse(String(a.proximaRonda)) - antes).toBeLessThanOrEqual(3_600_000 + 15_000);
    expect(audit.recordNow).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'ADMIN',
        actorId: ADMIN,
        action: 'admin.ai_desk.agent_create',
        severity: 'INFO',
      }),
    );
  });

  it('sobre dinero real exige el consentimiento, y lo audita en WARN', async () => {
    const { svc, audit, db } = montar();
    const sin = await cuerpo(svc.crear(ADMIN, crearDto({ exchangeAccountId: 'acc-real' })));
    expect(sin['errores']).toEqual([
      { campo: 'consentimiento', mensaje: 'Falta el consentimiento para operar con dinero real.' },
    ]);
    expect(db.aiDeskAgent.create).not.toHaveBeenCalled();

    const con = await svc.crear(
      ADMIN,
      crearDto({ exchangeAccountId: 'acc-real', consentimiento: true }),
    );
    expect(con.cuenta.real).toBe(true);
    expect(audit.recordNow).toHaveBeenCalledWith(expect.objectContaining({ severity: 'WARN' }));
  });

  it('una cuenta ajena no existe; una revocada no vale', async () => {
    const { svc } = montar();
    await expect(svc.crear(ADMIN, crearDto({ exchangeAccountId: 'acc-ajena' }))).rejects.toThrow(
      NotFoundException,
    );
    await expect(svc.crear(ADMIN, crearDto({ exchangeAccountId: 'acc-rev' }))).rejects.toThrow(
      /revocada/,
    );
  });

  it('todos los errores a la vez, cada uno con su campo', async () => {
    const { svc } = montar();
    const e = await cuerpo(
      svc.crear(
        ADMIN,
        crearDto({
          pares: ['BTC', 'DOGE', 'BTC'],
          familias: [],
          limites: { ...LIMITES, riesgoPct: '9' },
        }),
      ),
    );
    const campos = (e['errores'] as { campo: string }[]).map((x) => x.campo).sort();
    expect(campos).toEqual(['familias', 'limites.riesgoPct', 'pares', 'pares']);
  });

  it('un par que no está en el catálogo del venue se dice por su nombre', async () => {
    const { svc } = montar({ catalogo: ['BTC'] });
    const e = await cuerpo(svc.crear(ADMIN, crearDto({ pares: ['BTC', 'ETH'] })));
    expect(e['errores']).toEqual([{ campo: 'pares', mensaje: '«ETH» no está en HYPERLIQUID.' }]);
  });

  it('el rol se lee de la base: sin él, 403 aunque la sesión diga ADMIN', async () => {
    await expect(montar({ rol: 'USER' }).svc.crear(ADMIN, crearDto())).rejects.toThrow(
      /solo para administradores/,
    );
    await expect(montar({ disabled: true }).svc.crear(ADMIN, crearDto())).rejects.toThrow(
      /solo para administradores/,
    );
  });
});

describe('AiDeskAgentesService — editar', () => {
  it('sube la versión y descarta lo pendiente, que se calculó con la definición de antes', async () => {
    const { svc, db } = montar();
    const a = await svc.crear(ADMIN, crearDto());
    const e = await svc.editar(ADMIN, a.id, editarDto(1, { pares: ['SOL'] }));
    expect(e.version).toBe(2);
    expect(e.pares).toEqual(['SOL']);
    expect(db.aiDeskProposal.updateMany).toHaveBeenCalledWith({
      where: { agent_id: a.id, state: 'PROPUESTA' },
      data: expect.objectContaining({ state: 'DESCARTADA', reason: 'AGENTE_CAMBIADO' }),
    });
  });

  it('sobre una versión vieja responde 409 y no toca nada', async () => {
    const { svc, agentes } = montar();
    const a = await svc.crear(ADMIN, crearDto());
    await svc.editar(ADMIN, a.id, editarDto(1, { nombre: 'Uno' }));
    const e = await cuerpo(svc.editar(ADMIN, a.id, editarDto(1, { nombre: 'Dos' })));
    expect(e['code']).toBe('STALE_VERSION');
    expect(agentes.get(a.id)?.['name']).toBe('Uno');
  });

  it('pasar «entrar» a automático sobre dinero real pide consentimiento', async () => {
    const { svc } = montar();
    const a = await svc.crear(
      ADMIN,
      crearDto({ exchangeAccountId: 'acc-real', consentimiento: true }),
    );
    const auto = { entrar: 'AUTO', reducir: 'AUTO', cerrar: 'MANUAL' } as const;
    await expect(svc.editar(ADMIN, a.id, editarDto(1, { autonomia: { ...auto } }))).rejects.toThrow(
      /consentimiento/,
    );
    const e = await svc.editar(
      ADMIN,
      a.id,
      editarDto(1, { autonomia: { ...auto }, consentimiento: true }),
    );
    expect(e.autonomia.entrar).toBe('AUTO');
    // Ya en automático, otra edición no vuelve a pedirlo.
    const otra = await svc.editar(
      ADMIN,
      a.id,
      editarDto(2, { autonomia: { ...auto }, nombre: 'X' }),
    );
    expect(otra.nombre).toBe('X');
  });

  it('un agente ajeno no existe', async () => {
    const { svc } = montar();
    const a = await svc.crear(ADMIN, crearDto());
    await expect(svc.editar(OTRO, a.id, editarDto(1))).rejects.toThrow(NotFoundException);
    await expect(svc.detalle(OTRO, a.id)).rejects.toThrow(NotFoundException);
    expect((await svc.resumen(OTRO)).agentes).toEqual([]);
  });
});

describe('AiDeskAgentesService — pausar, reanudar y archivar', () => {
  it('pausar corta las entradas y descarta lo pendiente; dos veces, igual', async () => {
    const { svc, db, audit } = montar();
    const a = await svc.crear(ADMIN, crearDto());
    const p = await svc.pausar(ADMIN, a.id, 'me voy de viaje');
    expect(p).toMatchObject({ estado: 'PAUSADO', motivoPausa: 'MANUAL', insignia: 'PAUSADO' });
    expect(db.aiDeskProposal.updateMany).toHaveBeenCalledWith({
      where: { agent_id: a.id, state: 'PROPUESTA' },
      data: expect.objectContaining({ state: 'DESCARTADA', reason: 'AGENTE_PAUSADO' }),
    });
    const auditorias = audit.recordNow.mock.calls.length;
    await svc.pausar(ADMIN, a.id, 'otra vez');
    expect(audit.recordNow.mock.calls.length).toBe(auditorias);
  });

  it('reanudar sobre dinero real pide consentimiento', async () => {
    const { svc } = montar();
    const a = await svc.crear(
      ADMIN,
      crearDto({ exchangeAccountId: 'acc-real', consentimiento: true }),
    );
    await svc.pausar(ADMIN, a.id, 'pausa');
    await expect(svc.reanudar(ADMIN, a.id, { reason: 'vuelta' })).rejects.toThrow(/consentimiento/);
    const r = await svc.reanudar(ADMIN, a.id, { reason: 'vuelta', consentimiento: true });
    expect(r).toMatchObject({ estado: 'ACTIVO', motivoPausa: null });
  });

  it('archivar solo sin operaciones vivas, y no se vuelve', async () => {
    const { svc, db } = montar();
    const a = await svc.crear(ADMIN, crearDto());
    db.aiDeskProposal.count.mockResolvedValueOnce(1);
    await expect(svc.archivar(ADMIN, a.id, 'ya no')).rejects.toThrow(/operación\(es\) viva/);
    const r = await svc.archivar(ADMIN, a.id, 'ya no');
    expect(r).toMatchObject({ estado: 'ARCHIVADO', proximaRonda: null, insignia: 'ARCHIVADO' });
    await expect(svc.reanudar(ADMIN, a.id, { reason: 'vuelta' })).rejects.toThrow(/archivado/);
    await expect(svc.editar(ADMIN, a.id, editarDto(1))).rejects.toThrow(/archivado/);
  });
});

describe('AiDeskAgentesService — resumen y detalle', () => {
  it('el resumen suma lo pendiente y lo vivo de todos sus agentes', async () => {
    const { svc, db } = montar();
    const a = await svc.crear(ADMIN, crearDto());
    const b = await svc.crear(ADMIN, crearDto({ nombre: 'Otro' }));
    db.aiDeskProposal.groupBy
      .mockResolvedValueOnce([{ agent_id: a.id, _count: { _all: 1 } }])
      .mockResolvedValueOnce([
        { agent_id: a.id, _count: { _all: 2 } },
        { agent_id: b.id, _count: { _all: 1 } },
      ]);
    const r = await svc.resumen(ADMIN);
    expect(r.agentes).toHaveLength(2);
    expect([r.vivas, r.pendientes, r.maxPares]).toEqual([1, 3, 12]);
  });

  it('cuenta las consultas de hoy sin coste conocido: una cortada se cobra y no dice cuánto (spec 078)', async () => {
    const { svc, db } = montar();
    const a = await svc.crear(ADMIN, crearDto());
    const b = await svc.crear(ADMIN, crearDto({ nombre: 'Otro' }));
    db.aiDeskRound.groupBy.mockResolvedValueOnce([{ agent_id: a.id, _count: { _all: 2 } }]);
    const antes = Date.now();
    const r = await svc.resumen(ADMIN);
    const de = (id: string) => r.agentes.find((x) => x.id === id)?.consultasSinCoste;
    expect([de(a.id), de(b.id)]).toEqual([2, 0]);
    // Las del día UTC que llamaron al modelo y no trajeron coste, de entrada y de seguimiento.
    const dia = new Date(Math.floor(antes / 86_400_000) * 86_400_000);
    expect(db.aiDeskRound.groupBy).toHaveBeenCalledWith({
      by: ['agent_id'],
      where: {
        agent_id: { in: expect.arrayContaining([a.id, b.id]) as string[] },
        created_at: { gte: dia },
        model: { not: null },
        cost: null,
      },
      _count: { _all: true },
    });
  });

  it('el detalle trae el uso del día frente a los límites y el peor día', async () => {
    const { svc, db } = montar();
    const a = await svc.crear(ADMIN, crearDto());
    const d = await svc.detalle(ADMIN, a.id);
    expect(d.peorDia).toBe('20.00');
    expect(d.uso).toMatchObject({ topeDiarioPct: 2, operacionesHoy: 0, topeVivas: 2 });
    // Las últimas rondas de ENTRADA, de la más reciente hacia atrás: las que dicen por qué
    // no propone. Las de seguimiento, una por vela y operación, las taparían.
    expect(d.rondas).toEqual([]);
    expect(db.aiDeskRound.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agent_id: a.id, kind: 'ENTRADA' },
        orderBy: { created_at: 'desc' },
        take: 10,
      }),
    );
  });
});
