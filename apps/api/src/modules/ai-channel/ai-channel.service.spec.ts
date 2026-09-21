import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { D, EstadoIntencion, MotivoConsulta, StrategyKind } from '@crypton/shared';
import { DEFAULTS_CANAL } from '@crypton/strategy-core';
import type { OpenRouterClient, PeticionCanal, RespuestaCanal } from '../advisor/openrouter.client';
import {
  AiChannelService,
  MARGEN_ESCRITURA_MS,
  PAUSA_FALLOS_MS,
  esSalidaHerramienta,
  textoDecision,
} from './ai-channel.service';
import { systemPromptCanal, versionPrompt } from './prompt';
import { CAPITAL, corto, largo, salidaDePrueba } from './oferta.fixture-spec';

/**
 * El lazo de la IA del canal (spec 059, CA-3).
 *
 * La base es de mentira pero respeta lo que importa: las actualizaciones son
 * condicionales por estado, como en Postgres. Así se prueba de verdad que dos
 * réplicas no llaman dos veces y que una intención que el worker ya caducó no
 * se pisa.
 */

const BOT = 'b0000000-0000-4000-8000-000000000001';
const USUARIO = 'u0000000-0000-4000-8000-000000000001';
const VALE = '0123456789abcdef0123456789abcdef';
const HOY = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);

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

const respuestaBuena = (extra: Record<string, unknown> = {}) => ({
  veredicto: 'OPERAR',
  opcion: 'A',
  stop: 'AJUSTADO',
  objetivo: 'ESCALONADO',
  apalancamiento: 'MEDIA',
  tamano: 'COMPLETO',
  confianza: 'ALTA',
  motivo1: 'CANAL_CLARO',
  motivo2: 'NINGUNO',
  motivo3: 'NINGUNO',
  riesgo1: 'RUPTURA',
  riesgo2: 'NINGUNO',
  motivo: 'Rebote limpio.',
  ...extra,
});

const llamadaBuena = (extra: Partial<RespuestaCanal> = {}): RespuestaCanal => ({
  contenido: JSON.stringify(respuestaBuena()),
  uso: {
    tokensEntrada: 3000,
    tokensSalida: 500,
    tokensCacheLeidos: 2000,
    tokensCacheEscritos: 0,
    tokensRazonamiento: 400,
    coste: '0.012',
  },
  fallo: null,
  latenciaMs: 1234,
  modelo: 'anthropic/claude-sonnet-5',
  ...extra,
});

interface Opciones {
  entorno?: Record<string, string>;
  canalDisponible?: boolean;
  bot?: Partial<{ strategy: string; status: string; role: string; disabled: boolean }>;
  config?: Record<string, unknown> | null;
}

function montar(o: Opciones = {}) {
  const intenciones = new Map<string, Intencion>();
  const lazos = new Map<string, Lazo>();
  const eventos: Record<string, unknown>[] = [];
  const publicados: { canal: string; mensaje: Record<string, unknown> }[] = [];
  const redis = new Map<string, unknown>();
  const estado = {
    redisCaido: false,
    /** Solo falla el contador cuya clave contiene esto. */
    falla: null as string | null,
    interruptor: null as string | null,
    interruptorFalla: false,
  };
  const bot = {
    id: BOT,
    user_id: USUARIO,
    strategy: o.bot?.strategy ?? StrategyKind.AI_CHANNEL,
    status: o.bot?.status ?? 'RUNNING',
    venue: 'HYPERLIQUID',
    config_version: 3,
    user: { role: o.bot?.role ?? 'ADMIN', disabled: o.bot?.disabled ?? false },
  };
  const configBot =
    o.config === null
      ? null
      : { ...DEFAULTS_CANAL, totalInvestment: CAPITAL, allowedSetups: 'TODOS', ...o.config };

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
      findMany: jest.fn(
        async ({
          where,
          take,
          orderBy,
        }: {
          where: Donde;
          take: number;
          orderBy: { created_at: 'asc' | 'desc' };
        }) =>
          [...intenciones.values()]
            .filter((f) => coincide(f, where, bot))
            .sort(
              (a, b) =>
                (a.created_at.getTime() - b.created_at.getTime()) *
                (orderBy.created_at === 'asc' ? 1 : -1),
            )
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
              const inc = (v as { increment: number | string }).increment;
              fila[k] =
                k === 'coste_hoy'
                  ? D(String(fila[k])).plus(inc).toFixed()
                  : (fila[k] as number) + Number(inc);
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
    user: {
      findUnique: jest.fn(async () => ({ role: bot.user.role, disabled: bot.user.disabled })),
    },
  };

  const cache = {
    getTextoOrThrow: jest.fn(async () => {
      if (estado.interruptorFalla) throw new Error('Redis no responde');
      return estado.interruptor;
    }),
    incrWithExpire: jest.fn(async (clave: string) => {
      if (estado.redisCaido || (estado.falla && clave.includes(estado.falla))) return -1;
      const n = Number(redis.get(clave) ?? 0) + 1;
      redis.set(clave, n);
      return n;
    }),
    setnx: jest.fn(async (clave: string, valor: unknown) => {
      if (redis.has(clave)) return false;
      redis.set(clave, valor);
      return true;
    }),
    get: jest.fn(async (clave: string) => redis.get(clave) ?? null),
    getDel: jest.fn(async (clave: string) => {
      const v = redis.get(clave) ?? null;
      redis.delete(clave);
      return v;
    }),
  };
  const bus = {
    publish: jest.fn(async (canal: string, mensaje: Record<string, unknown>) => {
      publicados.push({ canal, mensaje });
    }),
  };
  const entorno: Record<string, string> = { AI_CHANNEL_ENABLE: 'true', ...o.entorno };
  const config = {
    get: (k: string, def?: string) => entorno[k] ?? def,
  } as unknown as ConfigService;
  const modelo = {
    canalDisponible: o.canalDisponible ?? true,
    canalModelo: 'anthropic/claude-sonnet-5',
    decidirCanal: jest.fn(async (_p: PeticionCanal) => llamadaBuena()),
  };
  const bots = { command: jest.fn(async () => ({ accepted: true, command: 'PAUSE' })) };
  const audit = { recordNow: jest.fn(async () => undefined) };

  const servicio = new AiChannelService(
    db as never,
    cache as never,
    bus as never,
    config,
    modelo as unknown as OpenRouterClient,
    bots as never,
    audit as never,
  );

  /** Una solicitud pendiente que vence dentro de `venceEn` ms. */
  const solicitar = (
    id = 'int-1',
    venceEn = 60_000,
    snapshot: unknown = salidaDePrueba(),
    barT = 1_760_000_300_000,
  ): Intencion => {
    const f: Intencion = {
      id,
      bot_id: BOT,
      bar_t: new Date(barT),
      kind: 'ENTRADA',
      estado: EstadoIntencion.SOLICITADA,
      expires_at: new Date(Date.now() + venceEn),
      snapshot,
      created_at: new Date(Date.now() - intenciones.size * 1000),
    };
    intenciones.set(id, f);
    return f;
  };

  const eventosDe = (tipo: string) => eventos.filter((e) => e['type'] === tipo);
  const publicadosEn = (canal: string) => publicados.filter((p) => p.canal === canal);

  return {
    servicio,
    db,
    cache,
    bus,
    modelo,
    bots,
    audit,
    redis,
    estado,
    intenciones,
    lazos,
    eventos,
    solicitar,
    eventosDe,
    publicadosEn,
  };
}

describe('AiChannelService: la consulta', () => {
  it('de SOLICITADA a DECIDIDA, con la elección efectiva, lo que costó y los avisos', async () => {
    const m = montar();
    const f = m.solicitar('int-1', 60_000);
    const r = await m.servicio.atender('int-1');

    expect(r).toEqual({ estado: 'DECIDIDA', motivo: null, escrita: true });
    expect(f).toMatchObject({
      estado: 'DECIDIDA',
      motivo: null,
      candidato_id: largo().id,
      modelo: 'anthropic/claude-sonnet-5',
      prompt_version: versionPrompt(),
      latencia_ms: 1234,
      coste: '0.012',
    });
    expect(f['decision']).toEqual({
      veredicto: 'OPERAR',
      opcion: largo().id,
      stop: 'AJUSTADO',
      objetivo: 'ESCALONADO',
      apalancamiento: 'MEDIA',
      tamano: 'COMPLETO',
      confianza: 'ALTA',
      respuesta: {
        veredicto: 'OPERAR',
        opcion: 'A',
        stop: 'AJUSTADO',
        objetivo: 'ESCALONADO',
        apalancamiento: 'MEDIA',
        tamano: 'COMPLETO',
        confianza: 'ALTA',
        motivos: ['CANAL_CLARO'],
        riesgos: ['RUPTURA'],
        texto: 'Rebote limpio.',
      },
    });

    // La llamada: el esquema de esta oferta, el prompt fijo y la herramienta.
    const peticion = m.modelo.decidirCanal.mock.calls[0][0];
    const esquema = peticion.esquema.schema as { properties: { opcion: { enum: string[] } } };
    expect(esquema.properties.opcion.enum).toEqual(['A', 'B', 'NINGUNA']);
    expect(peticion.system).toBe(systemPromptCanal());
    expect(peticion.usuario).toContain('Opción A: REBOTE, largo');
    expect(peticion.limiteMs).toBe(20_000);

    // El lazo del bot.
    expect(m.lazos.get(BOT)).toMatchObject({
      fallos: 0,
      llamadas_hoy: 1,
      coste_hoy: '0.012',
      dia: HOY,
    });

    // La decisión en la línea de tiempo, sin ir a Telegram; y el aviso al worker.
    const [decision] = m.eventosDe('AI_DECISION');
    expect(decision).toMatchObject({ bot_id: BOT, severity: 'INFO' });
    expect(decision['message']).toBe(
      'La IA elige REBOTE largo con stop AJUSTADO, salida ESCALONADO, banda MEDIA, tamaño ' +
        'COMPLETO (confianza ALTA). «Rebote limpio.»',
    );
    const [evento] = m.publicadosEn('crypton:bot-events');
    expect(evento.mensaje).toMatchObject({ botId: BOT, userId: USUARIO, type: 'AI_DECISION' });
    expect(evento.mensaje['entregaForzada']).toBeUndefined();
    expect(m.publicadosEn('crypton:bot-ai-intents')).toEqual([
      {
        canal: 'crypton:bot-ai-intents',
        mensaje: {
          userId: USUARIO,
          botId: BOT,
          type: 'AI_INTENT_DECIDED',
          data: { intentId: 'int-1' },
        },
      },
    ]);
  });

  it('el plazo de la llamada deja margen para escribir', async () => {
    const m = montar({ entorno: { AI_CHANNEL_TIMEOUT_MS: '60000' } });
    m.solicitar('int-1', 15_000);
    await m.servicio.atender('int-1');
    const { limiteMs } = m.modelo.decidirCanal.mock.calls[0][0];
    // Tope de 25 s en la configuración; el plazo manda: 15 s menos el margen.
    expect(limiteMs).toBeLessThanOrEqual(15_000 - MARGEN_ESCRITURA_MS);
    expect(limiteMs).toBeGreaterThan(15_000 - MARGEN_ESCRITURA_MS - 1_000);
    expect(m.servicio.plazoLlamadaMs).toBe(25_000);
  });

  it('dos réplicas, una llamada', async () => {
    const m = montar();
    m.solicitar('int-1');
    const otra = new AiChannelService(
      m.db as never,
      m.cache as never,
      m.bus as never,
      { get: (k: string, d?: string) => (k === 'AI_CHANNEL_ENABLE' ? 'true' : d) } as never,
      m.modelo as never,
      m.bots as never,
      m.audit as never,
    );
    const [a, b] = await Promise.all([m.servicio.atender('int-1'), otra.atender('int-1')]);
    expect([a, b].filter((x) => x !== null)).toEqual([
      { estado: 'DECIDIDA', motivo: null, escrita: true },
    ]);
    expect(m.modelo.decidirCanal).toHaveBeenCalledTimes(1);
    expect(m.redis.get(`ai:quota-canal:global:${HOY.toISOString().slice(0, 10)}`)).toBe(1);
  });

  it('una solicitud que ya no está pendiente o venció no se reclama', async () => {
    const m = montar();
    m.solicitar('vieja', -1);
    const f = m.solicitar('movida');
    f.estado = EstadoIntencion.CADUCADA;
    await expect(m.servicio.atender('vieja')).resolves.toBeNull();
    await expect(m.servicio.atender('movida')).resolves.toBeNull();
    await expect(m.servicio.atender('no-existe')).resolves.toBeNull();
    expect(m.modelo.decidirCanal).not.toHaveBeenCalled();
    expect(m.intenciones.get('vieja')?.estado).toBe('SOLICITADA');
  });

  it('la concurrencia está acotada por réplica, y el hueco se libera al terminar', async () => {
    const m = montar({ entorno: { AI_CHANNEL_CONCURRENCY: '1' } });
    m.solicitar('int-1');
    m.solicitar('int-2', 60_000, salidaDePrueba(), 1_760_000_600_000);
    let soltar: (r: RespuestaCanal) => void = () => undefined;
    m.modelo.decidirCanal.mockImplementationOnce(
      () => new Promise<RespuestaCanal>((ok) => (soltar = ok)),
    );
    const primera = m.servicio.atender('int-1');
    expect(m.servicio.huecos).toBe(0);
    await expect(m.servicio.atender('int-2')).resolves.toBeNull();
    expect(m.intenciones.get('int-2')?.estado).toBe('SOLICITADA');
    await new Promise((r) => setImmediate(r));
    expect(m.modelo.decidirCanal).toHaveBeenCalledTimes(1);
    soltar(llamadaBuena());
    await expect(primera).resolves.toMatchObject({ estado: 'DECIDIDA' });
    expect(m.servicio.huecos).toBe(1);
    await expect(m.servicio.atender('int-2')).resolves.toMatchObject({ estado: 'DECIDIDA' });
  });

  it('una concurrencia mal escrita se queda en su valor por defecto', () => {
    expect(montar({ entorno: { AI_CHANNEL_CONCURRENCY: 'muchas' } }).servicio.concurrencia).toBe(4);
    expect(montar({ entorno: { AI_CHANNEL_CONCURRENCY: '0' } }).servicio.concurrencia).toBe(1);
  });
});

describe('AiChannelService: las barreras', () => {
  /** Atiende y comprueba que se cerró sin llamar ni gastar cupo. */
  async function cerrada(
    m: ReturnType<typeof montar>,
    estado: EstadoIntencion,
    motivo: MotivoConsulta,
    id = 'int-1',
  ) {
    const r = await m.servicio.atender(id);
    expect(r).toEqual({ estado, motivo, escrita: true });
    expect(m.intenciones.get(id)).toMatchObject({ estado, motivo });
    expect(m.modelo.decidirCanal).not.toHaveBeenCalled();
    expect(m.eventosDe('AI_DECISION')).toEqual([]);
    return r;
  }

  it('la IA apagada en el servidor, o sin clave', async () => {
    const apagada = montar({ entorno: { AI_CHANNEL_ENABLE: 'false' } });
    apagada.solicitar();
    await cerrada(apagada, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.IA_APAGADA);
    const sinClave = montar({ canalDisponible: false });
    sinClave.solicitar();
    await cerrada(sinClave, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.IA_APAGADA);
    expect(sinClave.cache.incrWithExpire).not.toHaveBeenCalled();
  });

  it('un dueño que no es administrador, o está deshabilitado', async () => {
    for (const bot of [{ role: 'USER' }, { disabled: true }]) {
      const m = montar({ bot });
      m.solicitar();
      await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.DUENO);
    }
  });

  it('un bot que no está en marcha o no es del canal', async () => {
    for (const bot of [{ status: 'PAUSED' }, { status: 'STOPPING' }, { strategy: 'MARTINGALE' }]) {
      const m = montar({ bot });
      m.solicitar();
      await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.ESTADO_BOT);
    }
  });

  it('el lazo en pausa por fallos; una pausa vencida ya no cuenta', async () => {
    const m = montar();
    m.lazos.set(BOT, {
      fallos: 5,
      pausado_hasta: new Date(Date.now() + 60_000),
      ultimo_error: 'MODELO:HTTP',
      dia: HOY,
      llamadas_hoy: 5,
      coste_hoy: '0.05',
    });
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.PAUSA_FALLOS);

    const vencida = montar();
    vencida.lazos.set(BOT, {
      fallos: 5,
      pausado_hasta: new Date(Date.now() - 1),
      ultimo_error: null,
      dia: HOY,
      llamadas_hoy: 0,
      coste_hoy: '0',
    });
    vencida.solicitar();
    await expect(vencida.servicio.atender('int-1')).resolves.toMatchObject({ estado: 'DECIDIDA' });
  });

  it('el interruptor global, con o sin comillas; sin poder leerlo, tampoco', async () => {
    for (const valor of ['off', '"off"', 'OFF']) {
      const m = montar();
      m.estado.interruptor = valor;
      m.solicitar();
      await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.INTERRUPTOR);
    }
    const caido = montar();
    caido.estado.interruptorFalla = true;
    caido.solicitar();
    await cerrada(caido, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.REDIS);
    const encendido = montar();
    encendido.estado.interruptor = 'on';
    encendido.solicitar();
    await expect(encendido.servicio.atender('int-1')).resolves.toMatchObject({
      estado: 'DECIDIDA',
    });
  });

  it('sin tiempo para llamar, caduca', async () => {
    const m = montar();
    m.solicitar('int-1', 7_000);
    await cerrada(m, EstadoIntencion.CADUCADA, MotivoConsulta.PLAZO);
    const justo = montar();
    justo.solicitar('int-1', 9_000);
    await expect(justo.servicio.atender('int-1')).resolves.toMatchObject({ estado: 'DECIDIDA' });
  });

  it('una oferta vacía o ilegible no gasta cupo', async () => {
    const casos: [Opciones, unknown][] = [
      [{}, { version: 2 }],
      [{}, { ...salidaDePrueba(), mercado: null }],
      [{ config: null }, salidaDePrueba()],
      [{ config: { allowedChannels: 'INCLINADO' } }, salidaDePrueba()],
      [{}, salidaDePrueba({ canal: null })],
      [{}, salidaDePrueba({ candidatos: [] })],
    ];
    for (const [opciones, snapshot] of casos) {
      const m = montar(opciones);
      m.solicitar('int-1', 60_000, snapshot);
      await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.OFERTA);
      expect(m.cache.incrWithExpire).not.toHaveBeenCalled();
    }
  });

  it('el cupo del bot es el menor entre el suyo y el del servidor', async () => {
    const propio = montar({ config: { aiDailyCallBudget: 2 } });
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      propio.solicitar(id, 60_000, salidaDePrueba(), 1_760_000_000_000 + i);
    }
    await propio.servicio.atender('a');
    await propio.servicio.atender('b');
    await expect(propio.servicio.atender('c')).resolves.toMatchObject({
      estado: 'SIN_ENTRADA',
      motivo: MotivoConsulta.CUPO_BOT,
    });
    expect(propio.modelo.decidirCanal).toHaveBeenCalledTimes(2);

    const servidor = montar({ entorno: { AI_CHANNEL_DAILY_LIMIT: '1' } });
    servidor.solicitar('a', 60_000, salidaDePrueba(), 1);
    servidor.solicitar('b', 60_000, salidaDePrueba(), 2);
    await servidor.servicio.atender('a');
    await expect(servidor.servicio.atender('b')).resolves.toMatchObject({
      motivo: MotivoConsulta.CUPO_BOT,
    });
  });

  it('el cupo global, y el del bot va primero', async () => {
    const m = montar({ entorno: { AI_CHANNEL_GLOBAL_DAILY_LIMIT: '1' } });
    m.solicitar('a', 60_000, salidaDePrueba(), 1);
    m.solicitar('b', 60_000, salidaDePrueba(), 2);
    await m.servicio.atender('a');
    await expect(m.servicio.atender('b')).resolves.toMatchObject({
      motivo: MotivoConsulta.CUPO_GLOBAL,
    });
    expect(m.modelo.decidirCanal).toHaveBeenCalledTimes(1);

    const agotado = montar({ config: { aiDailyCallBudget: 1 } });
    agotado.solicitar('a', 60_000, salidaDePrueba(), 1);
    agotado.solicitar('b', 60_000, salidaDePrueba(), 2);
    await agotado.servicio.atender('a');
    await agotado.servicio.atender('b');
    const dia = HOY.toISOString().slice(0, 10);
    // El bot sin cupo no gasta el de los demás.
    expect(agotado.redis.get(`ai:quota-canal:global:${dia}`)).toBe(1);
    expect(agotado.redis.get(`ai:quota-canal:bot:${BOT}:${dia}`)).toBe(2);
  });

  it('sin contador no se llama', async () => {
    const m = montar();
    m.estado.redisCaido = true;
    m.solicitar();
    await cerrada(m, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.REDIS);
    // Basta con que falle uno de los dos contadores.
    for (const falla of [':bot:', ':global:']) {
      const parcial = montar();
      parcial.estado.falla = falla;
      parcial.solicitar();
      await cerrada(parcial, EstadoIntencion.SIN_ENTRADA, MotivoConsulta.REDIS);
    }
  });
});

describe('AiChannelService: lo que responde el modelo', () => {
  const sinRespuesta = (fallo: RespuestaCanal['fallo']): RespuestaCanal =>
    llamadaBuena({ contenido: null, fallo, uso: null });

  it('sin respuesta: FALLIDA, cuenta el fallo y avisa una vez por hora', async () => {
    const m = montar();
    m.modelo.decidirCanal.mockResolvedValue(sinRespuesta('HTTP'));
    m.solicitar('a', 60_000, salidaDePrueba(), 1);
    m.solicitar('b', 60_000, salidaDePrueba(), 2);
    await expect(m.servicio.atender('a')).resolves.toEqual({
      estado: 'FALLIDA',
      motivo: MotivoConsulta.MODELO,
      escrita: true,
    });
    expect(m.intenciones.get('a')).toMatchObject({
      decision: { fallo: 'HTTP' },
      coste: null,
      modelo: 'anthropic/claude-sonnet-5',
    });
    expect(m.lazos.get(BOT)).toMatchObject({
      fallos: 1,
      ultimo_error: 'MODELO:HTTP',
      llamadas_hoy: 1,
      coste_hoy: '0',
      pausado_hasta: null,
    });
    const [aviso] = m.eventosDe('AI_FAILED');
    expect(aviso).toMatchObject({ severity: 'WARN' });
    expect(aviso['message']).toMatch(/no ha dado una respuesta válida/);
    const publicado = m
      .publicadosEn('crypton:bot-events')
      .find((p) => p.mensaje['type'] === 'AI_FAILED');
    expect(publicado?.mensaje['entregaForzada']).toBe(true);
    expect(m.eventosDe('AI_DECISION')[0]['message']).toBe(
      'La IA no dio una respuesta válida (HTTP).',
    );
    expect(m.publicadosEn('crypton:bot-ai-intents')).toEqual([]);

    await m.servicio.atender('b');
    expect(m.lazos.get(BOT)?.fallos).toBe(2);
    expect(m.eventosDe('AI_FAILED')).toHaveLength(1);
  });

  it('al quinto fallo seguido, seis horas sin consultas', async () => {
    const m = montar();
    m.modelo.decidirCanal.mockResolvedValue(sinRespuesta('RED'));
    for (let i = 0; i < 5; i++) m.solicitar(`f${i}`, 60_000, salidaDePrueba(), i);
    for (let i = 0; i < 4; i++) await m.servicio.atender(`f${i}`);
    expect(m.lazos.get(BOT)?.pausado_hasta).toBeNull();
    // El limite de un aviso por hora esta puesto desde el primer fallo, y aun
    // asi el de la pausa tiene que salir: es un cambio de estado del bot y
    // pasa una sola vez (spec 062, F-13).
    expect(m.eventosDe('AI_FAILED')).toHaveLength(1);
    const antes = Date.now();
    await m.servicio.atender('f4');
    const lazo = m.lazos.get(BOT);
    expect(lazo?.fallos).toBe(5);
    const pausa = lazo?.pausado_hasta?.getTime() ?? 0;
    expect(pausa).toBeGreaterThanOrEqual(antes + PAUSA_FALLOS_MS);
    expect(pausa).toBeLessThanOrEqual(Date.now() + PAUSA_FALLOS_MS);
    expect(m.eventosDe('AI_FAILED')).toHaveLength(2);
    expect(m.eventosDe('AI_FAILED').at(-1)?.['message']).toMatch(/falla repetidamente/);
  });

  it('una respuesta fuera del contrato es un fallo, y se guarda un trozo', async () => {
    const m = montar();
    const basura = 'x'.repeat(5000);
    m.modelo.decidirCanal.mockResolvedValue(llamadaBuena({ contenido: basura }));
    m.solicitar();
    await expect(m.servicio.atender('int-1')).resolves.toMatchObject({
      estado: 'FALLIDA',
      motivo: MotivoConsulta.CONTRATO,
    });
    const decision = m.intenciones.get('int-1')?.['decision'] as { fallo: string; bruto: string };
    expect(decision.fallo).toBe('CONTRATO');
    expect(decision.bruto).toHaveLength(2_000);
    expect(m.intenciones.get('int-1')?.['coste']).toBe('0.012');
    expect(m.lazos.get(BOT)).toMatchObject({ fallos: 1, ultimo_error: 'CONTRATO:CONTRATO' });
  });

  it('una respuesta válida pone la racha a cero', async () => {
    const m = montar();
    m.lazos.set(BOT, {
      fallos: 3,
      pausado_hasta: null,
      ultimo_error: 'MODELO:HTTP',
      dia: HOY,
      llamadas_hoy: 3,
      coste_hoy: '0.03',
    });
    m.modelo.decidirCanal.mockResolvedValue(
      llamadaBuena({
        contenido: JSON.stringify(respuestaBuena({ veredicto: 'NO_OPERAR', opcion: 'NINGUNA' })),
      }),
    );
    m.solicitar();
    await m.servicio.atender('int-1');
    expect(m.lazos.get(BOT)).toMatchObject({
      fallos: 0,
      llamadas_hoy: 4,
      coste_hoy: '0.042',
      ultimo_error: 'MODELO:HTTP',
    });
  });

  it('un tiempo agotado por un plazo recortado caduca y no cuenta; con el plazo entero, sí', async () => {
    const recortado = montar();
    recortado.modelo.decidirCanal.mockResolvedValue(sinRespuesta('TIEMPO'));
    recortado.solicitar('int-1', 15_000);
    await expect(recortado.servicio.atender('int-1')).resolves.toEqual({
      estado: 'CADUCADA',
      motivo: MotivoConsulta.PLAZO,
      escrita: true,
    });
    expect(recortado.lazos.get(BOT)).toMatchObject({ fallos: 0, llamadas_hoy: 1 });
    expect(recortado.intenciones.get('int-1')?.['decision']).toEqual({ fallo: 'TIEMPO' });
    expect(recortado.eventosDe('AI_FAILED')).toEqual([]);
    expect(recortado.eventosDe('AI_DECISION')[0]['message']).toBe(
      'La IA no respondió a tiempo: la solicitud llegó tarde.',
    );

    const entero = montar();
    entero.modelo.decidirCanal.mockResolvedValue(sinRespuesta('TIEMPO'));
    entero.solicitar('int-1', 60_000);
    await expect(entero.servicio.atender('int-1')).resolves.toMatchObject({
      estado: 'FALLIDA',
      motivo: MotivoConsulta.MODELO,
    });
    expect(entero.lazos.get(BOT)?.fallos).toBe(1);
  });

  it('un contenido vacío es un fallo del modelo', async () => {
    const m = montar();
    m.modelo.decidirCanal.mockResolvedValue(llamadaBuena({ contenido: '', fallo: 'VACIA' }));
    m.solicitar();
    await expect(m.servicio.atender('int-1')).resolves.toMatchObject({ estado: 'FALLIDA' });
    expect(m.intenciones.get('int-1')?.['decision']).toEqual({ fallo: 'VACIA' });
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, MotivoConsulta]>([
    ['no opera', { veredicto: 'NO_OPERAR', opcion: 'NINGUNA' }, {}, MotivoConsulta.NO_OPERAR],
    ['elige lo que no está disponible', { stop: 'AMPLIO' }, {}, MotivoConsulta.OFERTA],
    [
      'la mitad de lo que no admite mitad',
      { opcion: 'B', stop: 'NORMAL', objetivo: 'OPUESTO', confianza: 'MEDIA' },
      {},
      MotivoConsulta.OFERTA,
    ],
    [
      'tiene menos confianza de la pedida',
      { confianza: 'MEDIA' },
      { minAiConfidence: 'ALTA' },
      MotivoConsulta.CONFIANZA,
    ],
  ])('si %s, SIN_ENTRADA con la respuesta guardada', async (_, respuesta, config, motivo) => {
    const m = montar({ config });
    m.modelo.decidirCanal.mockResolvedValue(
      llamadaBuena({ contenido: JSON.stringify(respuestaBuena(respuesta)) }),
    );
    m.solicitar();
    await expect(m.servicio.atender('int-1')).resolves.toEqual({
      estado: 'SIN_ENTRADA',
      motivo,
      escrita: true,
    });
    const f = m.intenciones.get('int-1');
    expect(f?.['decision']).toEqual({
      respuesta: expect.objectContaining({ texto: 'Rebote limpio.' }),
    });
    expect(f?.['candidato_id']).toBeUndefined();
    expect(f?.['coste']).toBe('0.012');
    expect(m.lazos.get(BOT)?.fallos).toBe(0);
    expect(m.publicadosEn('crypton:bot-ai-intents')).toEqual([]);
    expect(m.eventosDe('AI_FAILED')).toEqual([]);
  });

  it('con confianza media, decide la mitad', async () => {
    const m = montar();
    m.modelo.decidirCanal.mockResolvedValue(
      llamadaBuena({ contenido: JSON.stringify(respuestaBuena({ confianza: 'MEDIA' })) }),
    );
    m.solicitar();
    await m.servicio.atender('int-1');
    expect(m.intenciones.get('int-1')).toMatchObject({
      estado: 'DECIDIDA',
      decision: { tamano: 'MEDIO', confianza: 'MEDIA', respuesta: { tamano: 'COMPLETO' } },
    });
  });

  it('la opción B es el corto', async () => {
    const m = montar();
    m.modelo.decidirCanal.mockResolvedValue(
      llamadaBuena({
        contenido: JSON.stringify(
          respuestaBuena({ opcion: 'B', stop: 'NORMAL', objetivo: 'OPUESTO' }),
        ),
      }),
    );
    m.solicitar();
    await m.servicio.atender('int-1');
    expect(m.intenciones.get('int-1')).toMatchObject({
      estado: 'DECIDIDA',
      candidato_id: corto().id,
    });
    expect(m.eventosDe('AI_DECISION')[0]['message']).toMatch(/^La IA elige FALSO_QUIEBRE corto/);
  });

  it('en modo sombra registra la decisión y no la ejecuta', async () => {
    const m = montar({ entorno: { AI_CHANNEL_SHADOW_ONLY: 'true' } });
    m.solicitar();
    await expect(m.servicio.atender('int-1')).resolves.toEqual({
      estado: 'SIN_ENTRADA',
      motivo: MotivoConsulta.SOMBRA,
      escrita: true,
    });
    expect(m.intenciones.get('int-1')).toMatchObject({
      candidato_id: largo().id,
      decision: { veredicto: 'OPERAR', opcion: largo().id, respuesta: { opcion: 'A' } },
    });
    expect(m.publicadosEn('crypton:bot-ai-intents')).toEqual([]);
    expect(m.eventosDe('AI_DECISION')[0]['message']).toMatch(/^Modo sombra: la IA habría elegido/);
  });

  it('si el worker la caducó mientras tanto, no se pisa ni se avisa', async () => {
    const m = montar();
    const f = m.solicitar();
    m.modelo.decidirCanal.mockImplementation(async () => {
      f.estado = EstadoIntencion.CADUCADA;
      return llamadaBuena();
    });
    await expect(m.servicio.atender('int-1')).resolves.toEqual({
      estado: 'DECIDIDA',
      motivo: null,
      escrita: false,
    });
    expect(f.estado).toBe('CADUCADA');
    expect(f['decision']).toBeUndefined();
    expect(m.publicadosEn('crypton:bot-ai-intents')).toEqual([]);
  });

  it('los contadores empiezan de cero al cambiar de día', async () => {
    const m = montar();
    m.lazos.set(BOT, {
      fallos: 0,
      pausado_hasta: null,
      ultimo_error: null,
      dia: new Date(HOY.getTime() - 86_400_000),
      llamadas_hoy: 7,
      coste_hoy: '0.5',
    });
    m.solicitar();
    await m.servicio.atender('int-1');
    expect(m.lazos.get(BOT)).toMatchObject({ dia: HOY, llamadas_hoy: 1, coste_hoy: '0.012' });
  });
});

describe('AiChannelService: mantenimiento', () => {
  it('caduca lo pendiente que venció hace más de 30 s', async () => {
    const m = montar();
    const vieja = m.solicitar('vieja', -31_000);
    const reciente = m.solicitar('reciente', -10_000);
    const decidida = m.solicitar('decidida', -60_000);
    decidida.estado = EstadoIntencion.DECIDIDA;
    const consultando = m.solicitar('consultando', -60_000);
    consultando.estado = EstadoIntencion.CONSULTANDO;
    const aceptada = m.solicitar('aceptada', -60_000);
    aceptada.estado = EstadoIntencion.ACEPTADA;
    await expect(m.servicio.caducarVencidas(Date.now())).resolves.toBe(3);
    expect([vieja, decidida, consultando].map((f) => [f.estado, f['motivo']])).toEqual([
      ['CADUCADA', 'PLAZO'],
      ['CADUCADA', 'PLAZO'],
      ['CADUCADA', 'PLAZO'],
    ]);
    expect(reciente.estado).toBe('SOLICITADA');
    expect(aceptada.estado).toBe('ACEPTADA');
  });

  it('las pendientes vigentes, las más antiguas primero', async () => {
    const m = montar();
    m.solicitar('primera');
    m.solicitar('segunda');
    m.solicitar('vencida', -1);
    const tomada = m.solicitar('tomada');
    tomada.estado = EstadoIntencion.CONSULTANDO;
    await expect(m.servicio.pendientes(5)).resolves.toEqual(['segunda', 'primera']);
    await expect(m.servicio.pendientes(1)).resolves.toEqual(['segunda']);
    await expect(m.servicio.pendientes(0)).resolves.toEqual([]);
  });

  it('la solicitud de una vela', async () => {
    const m = montar();
    m.solicitar('int-1', 60_000, salidaDePrueba(), 5_000);
    await expect(m.servicio.solicitudDe(BOT, 5_000)).resolves.toBe('int-1');
    await expect(m.servicio.solicitudDe(BOT, 6_000)).resolves.toBeNull();
  });

  it('esSalidaHerramienta', () => {
    const s = salidaDePrueba();
    expect(esSalidaHerramienta(s)).toBe(true);
    expect(esSalidaHerramienta({ ...s, canal: null })).toBe(true);
    const rotas: unknown[] = [
      null,
      [],
      { ...s, version: 2 },
      { ...s, barT: '1' },
      { ...s, mercado: { ...s.mercado, precio: 1 } },
      { ...s, mercado: { ...s.mercado, atr15m: undefined } },
      { ...s, uso: null },
      { ...s, candidatos: {} },
      { ...s, canal: { ...s.canal, soporte: 1 } },
    ];
    for (const r of rotas) expect(esSalidaHerramienta(r)).toBe(false);
  });
});

describe('AiChannelService: el botón de pausa', () => {
  const conVale = (m: ReturnType<typeof montar>, userId = USUARIO) =>
    m.redis.set(`ic:vale:${VALE}`, { userId, botId: BOT });

  it('pausa por el camino de siempre, una sola vez, y lo audita', async () => {
    const m = montar();
    conVale(m);
    await expect(m.servicio.canjearPausa(USUARIO, VALE)).resolves.toBe('PAUSADO');
    expect(m.bots.command).toHaveBeenCalledWith(USUARIO, BOT, { command: 'PAUSE' });
    expect(m.audit.recordNow).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'USER',
        actorId: USUARIO,
        botId: BOT,
        action: 'bot.ai_channel.pause_button',
        severity: 'WARN',
        outcome: 'OK',
      }),
    );
    await expect(m.servicio.canjearPausa(USUARIO, VALE)).resolves.toBe('SIN_VALE');
    expect(m.bots.command).toHaveBeenCalledTimes(1);
    // Y lo confirma: el `BOT_PAUSED` del motor es INFO y no se entrega, asi que
    // quien pulsa desde el movil no recibia nada (spec 062, F-14).
    const aviso = m.eventosDe('BOT_PAUSED').at(-1);
    expect(aviso).toMatchObject({ severity: 'WARN' });
    expect(aviso?.['message']).toMatch(/pausado desde el botón/);
  });

  it('un vale mal formado ni se busca', async () => {
    const m = montar();
    for (const v of [undefined, 42, 'corto', VALE.toUpperCase()]) {
      await expect(m.servicio.canjearPausa(USUARIO, v)).resolves.toBe('SIN_VALE');
    }
    expect(m.cache.getDel).not.toHaveBeenCalled();
  });

  it('el vale de otro no sirve, y se gasta', async () => {
    const m = montar();
    conVale(m, 'otro-usuario');
    await expect(m.servicio.canjearPausa(USUARIO, VALE)).resolves.toBe('AJENO');
    expect(m.bots.command).not.toHaveBeenCalled();
    expect(m.redis.has(`ic:vale:${VALE}`)).toBe(false);
  });

  it('un dueño que ya no es administrador no pausa por aquí, y se dice', async () => {
    for (const bot of [{ role: 'USER' }, { disabled: true }]) {
      const m = montar({ bot });
      conVale(m);
      await expect(m.servicio.canjearPausa(USUARIO, VALE)).resolves.toBe('DUENO');
      expect(m.bots.command).not.toHaveBeenCalled();
      expect(m.eventosDe('ACTION_FAILED').at(-1)).toMatchObject({ severity: 'WARN' });
    }
  });

  it('un bot que ya no está vivo no se pausa; otro error no se traga', async () => {
    const m = montar();
    conVale(m);
    m.bots.command.mockRejectedValueOnce(new ConflictException('parado'));
    await expect(m.servicio.canjearPausa(USUARIO, VALE)).resolves.toBe('NO_VIVO');
    expect(m.audit.recordNow).not.toHaveBeenCalled();
    // Sin esto, el boton contestaba «Pausando…» y no quedaba nada en ninguna
    // parte: ni evento, ni mensaje, ni rastro en la app (spec 062, F-14).
    expect(m.eventosDe('ACTION_FAILED').at(-1)?.['message']).toMatch(/no ha pausado el bot/);
    conVale(m);
    m.bots.command.mockRejectedValueOnce(new Error('base caída'));
    await expect(m.servicio.canjearPausa(USUARIO, VALE)).rejects.toThrow('base caída');
  });
});

describe('textoDecision', () => {
  const res = (estado: EstadoIntencion, motivo: string | null) => ({
    estado,
    motivo,
    escrita: true,
  });

  it('cada caso con su frase', () => {
    expect(
      textoDecision(res(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.NO_OPERAR), null, null, null),
    ).toBe('La IA no opera esta vela.');
    expect(
      textoDecision(res(EstadoIntencion.SIN_ENTRADA, MotivoConsulta.CONFIANZA), null, null, null),
    ).toBe('La IA eligió algo que no se puede ejecutar (CONFIANZA).');
    expect(
      textoDecision(res(EstadoIntencion.FALLIDA, MotivoConsulta.MODELO), null, null, 'RED'),
    ).toBe('La IA no dio una respuesta válida (RED).');
  });

  it('sin candidato, el id de la opción', () => {
    const eleccion = {
      veredicto: 'OPERAR' as const,
      opcion: 'REB-L-X',
      stop: 'NORMAL' as const,
      objetivo: 'MEDIA' as const,
      apalancamiento: 'BAJA' as const,
      tamano: 'MEDIO' as const,
      confianza: 'MEDIA' as const,
    };
    expect(
      textoDecision(res(EstadoIntencion.DECIDIDA, null), null, { eleccion, candidato: null }, null),
    ).toBe(
      'La IA elige REB-L-X con stop NORMAL, salida MEDIA, banda BAJA, tamaño MEDIO (confianza MEDIA).',
    );
  });
});
