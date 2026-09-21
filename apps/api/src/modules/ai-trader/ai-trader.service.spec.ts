import type { ConfigService } from '@nestjs/config';
import { EstadoIntencion, MotivoConsulta, StrategyKind } from '@crypton/shared';
import {
  AiTraderService,
  MARGEN_ESCRITURA_MS,
  PAUSA_FALLOS_MS,
  esEspacioTrader,
} from './ai-trader.service';
import { VERSION_PREGUNTAS } from './preguntas';
import type { PeticionTypeSafe, RespuestaTypeSafe, TypeSafeClient } from './typesafe.client';
import { CAPITAL, espacioDePrueba, respuestaBuena } from './oferta.fixture-spec';

/**
 * El lazo del «Bot de IA» (spec 069).
 *
 * La base es de mentira pero respeta lo que importa: las actualizaciones son
 * CONDICIONALES por estado, como en Postgres. Así se prueba de verdad que dos
 * réplicas no llaman dos veces, que una intención que el worker ya caducó no se
 * pisa, y —lo nuevo de este spec— que los dos lazos que comparten tabla no se
 * roban el trabajo.
 */

const BOT = 'b0000000-0000-4000-8000-000000000002';
const USUARIO = 'u0000000-0000-4000-8000-000000000002';

interface Intencion {
  id: string;
  bot_id: string;
  bar_t: Date;
  kind: string;
  estado: string;
  expires_at: Date;
  snapshot: unknown;
  created_at: Date;
  [campo: string]: unknown;
}

interface Lazo {
  fallos: number;
  pausado_hasta: Date | null;
  ultimo_error: string | null;
  dia: Date | null;
  llamadas_hoy: number;
  coste_hoy: string;
}

type Donde = Record<string, unknown>;

/**
 * `where` de Prisma, incluido el filtro POR RELACION (`bot: { strategy }`), que
 * el codigo usa desde el spec 069 para que cada lazo sonde solo lo suyo. Un
 * doble que lo ignorara daria verde a un filtro que en produccion no filtra.
 */
function coincide(f: Intencion, where: Donde, bot?: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'bot') {
      const cond = v as Record<string, unknown>;
      return Object.entries(cond).every(([campo, valor]) => bot?.[campo] === valor);
    }
    const actual = f[k];
    if (v instanceof Date) return actual instanceof Date && actual.getTime() === v.getTime();
    if (v && typeof v === 'object') {
      const o = v as { in?: unknown[]; gt?: Date; lt?: Date };
      if (o.in) return o.in.includes(actual);
      if (o.gt) return actual instanceof Date && actual.getTime() > o.gt.getTime();
      if (o.lt) return actual instanceof Date && actual.getTime() < o.lt.getTime();
      return false;
    }
    return actual === v;
  });
}

const llamadaBuena = (extra: Partial<RespuestaTypeSafe> = {}): RespuestaTypeSafe => ({
  answers: respuestaBuena(),
  uso: { entrada: 2400, salida: 320 },
  fallo: null,
  latenciaMs: 1180,
  modelo: 'jev-latest',
  ...extra,
});

interface Opciones {
  entorno?: Record<string, string>;
  disponible?: boolean;
  bot?: Partial<{ strategy: string; status: string; role: string; disabled: boolean }>;
  config?: Record<string, unknown> | null;
}

function montar(o: Opciones = {}) {
  const intenciones = new Map<string, Intencion>();
  const lazos = new Map<string, Lazo>();
  const eventos: Record<string, unknown>[] = [];
  const publicados: { canal: string; mensaje: Record<string, unknown> }[] = [];
  const redis = new Map<string, unknown>();
  const estado = { redisCaido: false, interruptor: null as string | null, interruptorFalla: false };
  const bot = {
    id: BOT,
    user_id: USUARIO,
    strategy: o.bot?.strategy ?? StrategyKind.AI_TRADER,
    status: o.bot?.status ?? 'RUNNING',
    venue: 'LIGHTER',
    config_version: 2,
    user: { role: o.bot?.role ?? 'ADMIN', disabled: o.bot?.disabled ?? false },
  };
  const configBot =
    o.config === null
      ? null
      : {
          exchangeAccountId: 'a',
          symbol: 'TEST',
          totalInvestment: CAPITAL,
          makerFeeBps: '0',
          takerFeeBps: '0',
          slippageBps: '2',
          ...o.config,
        };

  const db = {
    botAiIntent: {
      updateMany: jest.fn(async ({ where, data }: { where: Donde; data: Donde }) => {
        let count = 0;
        for (const f of intenciones.values()) {
          if (coincide(f, where, bot)) {
            Object.assign(f, data);
            count++;
          }
        }
        return { count };
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const f = intenciones.get(where.id);
        return f ? { ...f, bot } : null;
      }),
      findMany: jest.fn(async ({ where, take }: { where: Donde; take: number }) =>
        [...intenciones.values()]
          .filter((f) => coincide(f, where, bot))
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
          .slice(0, take)
          .map((f) => ({ id: f.id })),
      ),
      findFirst: jest.fn(async ({ where }: { where: Donde }) => {
        const f = [...intenciones.values()].find((x) => coincide(x, where, bot));
        return f ? { id: f.id } : null;
      }),
    },
    botAiLoop: {
      findUnique: jest.fn(
        async ({ where }: { where: { bot_id: string } }) => lazos.get(where.bot_id) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { bot_id: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const actual = lazos.get(where.bot_id);
          if (!actual) {
            const nueva = {
              fallos: 0,
              pausado_hasta: null,
              ultimo_error: null,
              dia: null,
              llamadas_hoy: 0,
              coste_hoy: '0',
              ...create,
            } as unknown as Lazo;
            lazos.set(where.bot_id, nueva);
            return nueva;
          }
          const fila = actual as unknown as Record<string, unknown>;
          for (const [k, v] of Object.entries(update)) {
            if (v && typeof v === 'object' && 'increment' in v) {
              fila[k] = (fila[k] as number) + Number((v as { increment: number }).increment);
            } else {
              fila[k] = v;
            }
          }
          return actual;
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: { bot_id: string }; data: Partial<Lazo> }) => {
          Object.assign(lazos.get(where.bot_id) ?? {}, data);
        },
      ),
    },
    botConfigRevision: {
      findUnique: jest.fn(async () => (configBot ? { config: configBot } : null)),
    },
    botEvent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        eventos.push(data);
      }),
    },
  };

  const cache = {
    getTextoOrThrow: jest.fn(async () => {
      if (estado.interruptorFalla) throw new Error('Redis no responde');
      return estado.interruptor;
    }),
    incrWithExpire: jest.fn(async (clave: string) => {
      if (estado.redisCaido) return -1;
      const n = Number(redis.get(clave) ?? 0) + 1;
      redis.set(clave, n);
      return n;
    }),
    setnx: jest.fn(async (clave: string, valor: unknown) => {
      if (redis.has(clave)) return false;
      redis.set(clave, valor);
      return true;
    }),
  };
  const bus = {
    publish: jest.fn(async (canal: string, mensaje: Record<string, unknown>) => {
      publicados.push({ canal, mensaje });
    }),
  };
  const entorno: Record<string, string> = { AI_TRADER_ENABLE: 'true', ...o.entorno };
  const config = {
    get: (k: string, def?: string) => entorno[k] ?? def,
  } as unknown as ConfigService;
  const modelo = {
    disponible: o.disponible ?? true,
    modelo: 'jev-latest',
    preguntar: jest.fn(async (_p: PeticionTypeSafe) => llamadaBuena()),
  };

  const servicio = new AiTraderService(
    db as never,
    cache as never,
    bus as never,
    config,
    modelo as unknown as TypeSafeClient,
  );

  const solicitar = (
    id = 'int-1',
    venceEn = 120_000,
    snapshot: unknown = espacioDePrueba(),
  ): Intencion => {
    const f: Intencion = {
      id,
      bot_id: BOT,
      bar_t: new Date(1_788_264_000_000),
      kind: 'ENTRADA',
      estado: EstadoIntencion.SOLICITADA,
      expires_at: new Date(Date.now() + venceEn),
      snapshot,
      created_at: new Date(Date.now() - intenciones.size * 1000),
    };
    intenciones.set(id, f);
    return f;
  };

  return {
    servicio,
    db,
    cache,
    bus,
    modelo,
    redis,
    estado,
    intenciones,
    lazos,
    solicitar,
    eventosDe: (tipo: string) => eventos.filter((e) => e['type'] === tipo),
    publicadosEn: (canal: string) => publicados.filter((p) => p.canal === canal),
  };
}

type Montaje = ReturnType<typeof montar>;

/** Atiende y comprueba cómo quedó la fila. */
async function cerrada(m: Montaje, estado: EstadoIntencion, motivo: string | null, id = 'int-1') {
  const r = await m.servicio.atender(id);
  expect(r?.estado).toBe(estado);
  expect(r?.motivo).toBe(motivo);
  expect(m.intenciones.get(id)?.estado).toBe(estado);
  return r;
}

describe('El lazo del «Bot de IA»: las barreras antes de llamar', () => {
  it('con la IA apagada o sin clave no se llama', async () => {
    const m = montar({ disponible: false });
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.IA_APAGADA);
    expect(m.modelo.preguntar).not.toHaveBeenCalled();
  });

  it('el dueño tiene que seguir siendo administrador habilitado', async () => {
    for (const quien of [{ role: 'USER' }, { disabled: true }]) {
      const m = montar({ bot: quien });
      m.solicitar();
      await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.DUENO);
      expect(m.modelo.preguntar).not.toHaveBeenCalled();
    }
  });

  it('un bot que no está en marcha', async () => {
    const m = montar({ bot: { status: 'PAUSED' } });
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.ESTADO_BOT);
  });

  it('sin Redis no se llama: al otro lado hay una factura', async () => {
    const m = montar();
    m.estado.interruptorFalla = true;
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.REDIS);
    expect(m.modelo.preguntar).not.toHaveBeenCalled();
  });

  it('con el interruptor de entradas cerrado tampoco', async () => {
    const m = montar();
    m.estado.interruptor = 'off';
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.INTERRUPTOR);
  });

  it('el lazo dormido por fallos', async () => {
    const m = montar();
    m.lazos.set(BOT, {
      fallos: 5,
      pausado_hasta: new Date(Date.now() + 3_600_000),
      ultimo_error: null,
      dia: null,
      llamadas_hoy: 0,
      coste_hoy: '0',
    });
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.PAUSA_FALLOS);
  });

  it('sin plazo suficiente no se empieza una llamada que no va a llegar', async () => {
    const m = montar();
    m.solicitar('int-1', 5_000);
    await cerrada(m, EstadoIntencion.CADUCADA, MotivoConsulta.PLAZO);
    expect(m.modelo.preguntar).not.toHaveBeenCalled();
  });

  /** Una oferta ilegible o sin celdas viables no gasta ni una llamada ni una del cupo. */
  it('una oferta que no se puede leer no gasta cupo', async () => {
    const m = montar();
    m.solicitar('int-1', 120_000, { version: 9, roto: true });
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.OFERTA);
    expect(m.modelo.preguntar).not.toHaveBeenCalled();
    expect([...m.redis.keys()].some((k) => k.includes('quota'))).toBe(false);
  });

  it('el cupo del bot se cuenta ANTES de llamar, no después de acertar', async () => {
    const m = montar({ entorno: { AI_TRADER_ENABLE: 'true', AI_TRADER_DAILY_LIMIT: '1' } });
    m.solicitar('int-1');
    m.solicitar('int-2');
    await cerrada(m, EstadoIntencion.DECIDIDA, null, 'int-1');
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.CUPO_BOT, 'int-2');
    expect(m.modelo.preguntar).toHaveBeenCalledTimes(1);
  });

  it('y el global, después del suyo', async () => {
    const m = montar({ entorno: { AI_TRADER_ENABLE: 'true', AI_TRADER_GLOBAL_DAILY_LIMIT: '1' } });
    m.solicitar('int-1');
    m.solicitar('int-2');
    await cerrada(m, EstadoIntencion.DECIDIDA, null, 'int-1');
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.CUPO_GLOBAL, 'int-2');
  });
});

describe('El lazo del «Bot de IA»: el reclamo', () => {
  it('dos réplicas no consultan por la misma solicitud', async () => {
    const m = montar();
    m.solicitar();
    const [a, b] = await Promise.all([m.servicio.atender('int-1'), m.servicio.atender('int-1')]);
    // Una de las dos se queda sin nada: la actualización condicional es la puerta.
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
    expect(m.modelo.preguntar).toHaveBeenCalledTimes(1);
  });

  it('una solicitud que ya no está pendiente no se reclama', async () => {
    const m = montar();
    const f = m.solicitar();
    f.estado = EstadoIntencion.CADUCADA;
    expect(await m.servicio.atender('int-1')).toBeNull();
  });

  /**
   * Los dos lazos comparten tabla. El del canal reclama todo lo que esté
   * pendiente —el filtro no cabe en una actualizacion condicional—, así que lo
   * que no es suyo lo SUELTA para que lo recoja el otro. Cerrarlo mataba la
   * operación y el motivo parecía un problema del bot.
   */
  it('lo que es del otro lazo se suelta, no se cierra', async () => {
    const m = montar({ bot: { strategy: StrategyKind.AI_CHANNEL } });
    m.solicitar();
    const r = await m.servicio.atender('int-1');

    expect(r?.estado).toBe(EstadoIntencion.SOLICITADA);
    expect(m.intenciones.get('int-1')?.estado).toBe(EstadoIntencion.SOLICITADA);
    expect(m.modelo.preguntar).not.toHaveBeenCalled();
    // Ni cupo, ni evento, ni contador: aquí no ha pasado nada.
    expect([...m.redis.keys()].some((k) => k.includes('quota'))).toBe(false);
    expect(m.eventosDe('AI_DECISION')).toHaveLength(0);
  });

  /**
   * Soltar lo ajeno es la red de seguridad del reclamo, donde no cabe el filtro.
   * El SONDEO sí lo lleva: sin él, cada lazo reclamaba y soltaba las solicitudes
   * del otro cada diez segundos —correcto, pero un ir y venir constante contra
   * la base y diez segundos de retraso en cada decisión ajena.
   */
  it('el sondeo no ve las solicitudes de la otra estrategia', async () => {
    const m = montar({ bot: { strategy: StrategyKind.AI_CHANNEL } });
    m.solicitar();
    await expect(m.servicio.pendientes(10)).resolves.toEqual([]);
    await expect(m.servicio.solicitudDe(BOT, 1_788_264_000_000)).resolves.toBeNull();
  });

  it('y sí las suyas', async () => {
    const m = montar();
    m.solicitar();
    await expect(m.servicio.pendientes(10)).resolves.toEqual(['int-1']);
    await expect(m.servicio.solicitudDe(BOT, 1_788_264_000_000)).resolves.toBe('int-1');
  });

  it('pero una estrategia sin lazo sí se cierra: no la va a recoger nadie', async () => {
    const m = montar({ bot: { strategy: StrategyKind.MARTINGALE } });
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.ESTADO_BOT);
  });
});

describe('El lazo del «Bot de IA»: la decisión', () => {
  it('una respuesta buena se escribe y se avisa al worker', async () => {
    const m = montar();
    m.solicitar();
    await cerrada(m, EstadoIntencion.DECIDIDA, null);

    const f = m.intenciones.get('int-1')!;
    expect(f['candidato_id']).toBe('MEDIDO|EN_LA_MEDIA');
    expect(f['modelo']).toBe('jev-latest');
    expect(f['prompt_version']).toBe(VERSION_PREGUNTAS);
    // TypeSafe no publica tarifas: el coste es null y los tokens van dentro.
    expect(f['coste']).toBeNull();
    const decision = f['decision'] as Record<string, unknown>;
    expect(decision['tokens_entrada']).toBe(2400);
    expect(m.publicadosEn('crypton:bot-ai-intents')).toHaveLength(1);
  });

  /**
   * La frontera del invariante 13: lo que el proveedor devuelve son NÚMEROS DE
   * OPINIÓN, y lo que se guarda arriba son enumeraciones. Los crudos quedan
   * dentro, como constancia y nada más.
   */
  it('lo que se guarda arriba son enumeraciones, nunca los números del modelo', async () => {
    const m = montar();
    m.solicitar();
    await m.servicio.atender('int-1');

    const decision = m.intenciones.get('int-1')!['decision'] as Record<string, unknown>;
    for (const campo of ['accion', 'confianza', 'stop', 'objetivo', 'tamano']) {
      expect(typeof decision[campo]).toBe('string');
    }
    expect(typeof decision['acuerdo']).toBe('boolean');
    // Y los crudos siguen ahí para poder explicarla.
    const respuesta = decision['respuesta'] as Record<string, unknown>;
    expect(typeof respuesta['regimenRevierte']).toBe('number');
  });

  it('el modo sombra decide igual y no deja decidir', async () => {
    const m = montar({ entorno: { AI_TRADER_ENABLE: 'true', AI_TRADER_SHADOW_ONLY: 'true' } });
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.SOMBRA);
    expect(m.modelo.preguntar).toHaveBeenCalled();
    expect(m.publicadosEn('crypton:bot-ai-intents')).toHaveLength(0);
  });

  it('si el modelo prefiere esperar, no hay decisión que ejecutar', async () => {
    const m = montar();
    m.modelo.preguntar.mockResolvedValueOnce(
      llamadaBuena({
        answers: respuestaBuena({
          action: {
            choice: 'WAIT_FOR_A_BETTER_TOUCH',
            probabilities: {
              TAKE_THE_TOUCH: 0.2,
              WAIT_FOR_A_BETTER_TOUCH: 0.7,
              WRONG_ENVIRONMENT: 0.1,
            },
            confidence: 0.55,
          },
        }),
      }),
    );
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.NO_OPERAR);
  });

  /**
   * ── EN MODO IA DECIDE LA IA ──
   *
   * Lo que prueban estos tres es lo que cambio en la revision del 069. La
   * primera version ponia tres jueces encima del modelo: un veto de contexto,
   * un suelo de confianza y un umbral que tiraba su eleccion de stop. Con su
   * confianza real —medida contra BTC, nunca paso de 0,61— el que decidia era
   * el juez y el modelo solo opinaba.
   */
  it('una confianza baja NO impide operar: su eleccion es su decision', async () => {
    const m = montar();
    m.modelo.preguntar.mockResolvedValueOnce(
      llamadaBuena({
        answers: respuestaBuena({
          action: {
            choice: 'TAKE_THE_TOUCH',
            probabilities: {
              TAKE_THE_TOUCH: 0.4,
              WAIT_FOR_A_BETTER_TOUCH: 0.35,
              WRONG_ENVIRONMENT: 0.25,
            },
            confidence: 0.1,
          },
        }),
      }),
    );
    m.solicitar();
    await cerrada(m, EstadoIntencion.DECIDIDA, null);
  });

  it('y las tres preguntas de contexto no vetan su enrutado', async () => {
    const m = montar();
    m.modelo.preguntar.mockResolvedValueOnce(
      llamadaBuena({ answers: respuestaBuena({ regime_is_mean_reverting: { noul: 0.1 } }) }),
    );
    m.solicitar();
    await cerrada(m, EstadoIntencion.DECIDIDA, null);
  });

  /**
   * Los mandos siguen siendo del usuario: quien quiera un juez encima del
   * modelo lo enciende en la configuracion de su bot. Lo que cambio es el
   * defecto, no el mecanismo.
   */
  it('pero el dueno puede volver a ponerle un juez encima', async () => {
    const m = montar({ config: { requireAgreement: true } });
    m.modelo.preguntar.mockResolvedValueOnce(
      llamadaBuena({ answers: respuestaBuena({ regime_is_mean_reverting: { noul: 0.1 } }) }),
    );
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.DESACUERDO);
  });

  it('el plazo que se le da al modelo deja margen para escribir la decisión', async () => {
    const m = montar();
    m.solicitar('int-1', 15_000);
    await m.servicio.atender('int-1');

    const p = m.modelo.preguntar.mock.calls[0][0];
    expect(p.limiteMs).toBeLessThanOrEqual(15_000 - MARGEN_ESCRITURA_MS);
  });

  it('una intención que el worker caducó mientras se consultaba no se pisa', async () => {
    const m = montar();
    const f = m.solicitar();
    m.modelo.preguntar.mockImplementationOnce(async () => {
      f.estado = EstadoIntencion.CADUCADA;
      return llamadaBuena();
    });
    const r = await m.servicio.atender('int-1');

    expect(r?.escrita).toBe(false);
    expect(f.estado).toBe(EstadoIntencion.CADUCADA);
  });
});

describe('El lazo del «Bot de IA»: los fallos', () => {
  it('sin respuesta válida no hay decisión, y el fallo cuenta', async () => {
    const m = montar();
    m.modelo.preguntar.mockResolvedValueOnce(llamadaBuena({ answers: null, fallo: 'HTTP' }));
    m.solicitar();
    await cerrada(m, EstadoIntencion.FALLIDA, MotivoConsulta.MODELO);
    expect(m.lazos.get(BOT)?.fallos).toBe(1);
  });

  it('una respuesta fuera del contrato se distingue de una caída', async () => {
    const m = montar();
    m.modelo.preguntar.mockResolvedValueOnce(
      llamadaBuena({ answers: { action: { choice: 'TAKE_THE_TOUCH', confidence: 0.6 } } }),
    );
    m.solicitar();
    await cerrada(m, EstadoIntencion.FALLIDA, MotivoConsulta.CONTRATO);
    // Con las preguntas que fallaron, para poder mirarlo.
    const decision = m.intenciones.get('int-1')!['decision'] as Record<string, unknown>;
    expect(String(decision['bruto'])).toContain('regime_is_mean_reverting');
  });

  it('cinco fallos seguidos duermen las consultas del bot seis horas', async () => {
    const m = montar();
    for (let i = 1; i <= 5; i++) {
      m.modelo.preguntar.mockResolvedValueOnce(llamadaBuena({ answers: null, fallo: 'RED' }));
      m.solicitar(`int-${i}`);
      await m.servicio.atender(`int-${i}`);
    }
    const pausa = m.lazos.get(BOT)?.pausado_hasta;
    expect(pausa).toBeInstanceOf(Date);
    expect(pausa!.getTime()).toBeGreaterThan(Date.now() + PAUSA_FALLOS_MS - 60_000);
    // Y se avisa de la pausa, que es un cambio de estado del bot.
    expect(m.eventosDe('AI_FAILED').some((e) => String(e['message']).includes('6 h'))).toBe(true);
  });

  it('una respuesta válida rompe la racha', async () => {
    const m = montar();
    m.modelo.preguntar.mockResolvedValueOnce(llamadaBuena({ answers: null, fallo: 'SOBRECARGA' }));
    m.solicitar('int-1');
    await m.servicio.atender('int-1');
    expect(m.lazos.get(BOT)?.fallos).toBe(1);

    m.solicitar('int-2');
    await m.servicio.atender('int-2');
    expect(m.lazos.get(BOT)?.fallos).toBe(0);
  });

  /**
   * Un tiempo agotado con el plazo YA recortado es de la solicitud, que llegó
   * tarde, no del proveedor: contarlo como fallo suyo acabaría durmiendo un
   * lazo que funciona.
   */
  it('un tiempo agotado por culpa del plazo no cuenta como fallo del proveedor', async () => {
    const m = montar();
    m.modelo.preguntar.mockResolvedValueOnce(llamadaBuena({ answers: null, fallo: 'TIEMPO' }));
    m.solicitar('int-1', 12_000);
    await cerrada(m, EstadoIntencion.CADUCADA, MotivoConsulta.PLAZO);
    expect(m.lazos.get(BOT)?.fallos).toBe(0);
  });
});

describe('esEspacioTrader', () => {
  it('acepta lo que escribe el motor', () => {
    expect(esEspacioTrader(espacioDePrueba())).toBe(true);
  });

  it.each([
    ['nulo', null],
    ['una cadena', 'espacio'],
    ['sin version', { barT: 1, huella: 'h', esqueletos: [], senal: {}, banda: {} }],
    ['de otra version', { version: 2, barT: 1, huella: 'h', esqueletos: [], senal: {}, banda: {} }],
    ['sin huella', { version: 1, barT: 1, esqueletos: [], senal: {}, banda: {} }],
    ['sin esqueletos', { version: 1, barT: 1, huella: 'h', senal: {}, banda: {} }],
    ['la del canal', { version: 1, barT: 1, huella: 'h', candidatos: [], mercado: {}, uso: {} }],
  ])('rechaza %s', (_caso, v) => {
    expect(esEspacioTrader(v)).toBe(false);
  });
});
