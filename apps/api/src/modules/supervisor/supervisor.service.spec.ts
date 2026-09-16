import { ConflictException } from '@nestjs/common';
import { AiDecisionState, AiMode } from '@crypton/db';
import { D, StrategyKind } from '@crypton/shared';
import { getStrategy, VENUE_MARKETS } from '@crypton/strategy-core';
import { buildConfig } from '../advisor/build';
import { coerceConfig, enforceCouplings } from '../advisor/sanitize';
import { systemPromptRevision } from './decision';
import { ETIQUETAS } from './mensajes';
import { SupervisorService } from './supervisor.service';

/**
 * El lazo del supervisor, probado por lo que NO hace.
 *
 * Cinco barreras deterministas se interponen antes de gastar una sola llamada al
 * modelo, y todas ocurren ANTES de preguntarle: ninguna depende de que el modelo
 * se porte bien. Lo que hay aqui es una comprobacion de cada una, porque una
 * barrera sin test es una barrera que alguien quitara sin enterarse.
 */

const MERCADO = VENUE_MARKETS.find((m) => m.nombre === 'LIGHTER BTC')!;

const RASGOS = {
  mark: 78910.1,
  volAnnualPct: 68,
  atrPct1h: 0.45,
  atrPct1d: 3.2,
  rangePct30: 28,
  posInRange: 0.5,
  trendPct: 1.1,
  trend: 'LATERAL' as const,
  efficiency: 0.22,
  worstDayPct: -7.5,
  tickBps: 1.2,
};

const KNOBS = {
  profile: 'EQUILIBRADA',
  leverage: 'MEDIA',
  coverage: 'MEDIA',
  spread: 'MEDIA',
  sizeGrowth: 'MEDIA',
  cadence: 'MEDIA',
};

/**
 * El bot vigente, generado por la MISMA cadena que lo produce en produccion.
 *
 * A mano no vale, y costo descubrirlo: una configuracion inventada no se parece
 * a la que genera el descriptor, asi que el diff salia enorme y todo se
 * descartaba por `DEMASIADOS_CAMPOS`. El test pasaba a decir que el supervisor
 * nunca propone nada, que es exactamente lo contrario de lo que hay que probar.
 */
const CONFIG_VIGENTE = (() => {
  const s = getStrategy(StrategyKind.MARKET_MAKER);
  const ctx = {
    market: MERCADO.spec,
    features: RASGOS,
    totalInvestment: 5000,
    maxLeverageUsuario: null,
    direction: 'LONG' as const,
  };
  let cfg = coerceConfig(
    s.meta.fields,
    s.defaults(),
    buildConfig(StrategyKind.MARKET_MAKER, KNOBS as never, ctx),
  );
  cfg = enforceCouplings(StrategyKind.MARKET_MAKER, cfg, MERCADO.spec, null);
  return {
    ...cfg,
    symbol: 'BTC',
    exchangeAccountId: 'cuenta-1',
    totalInvestment: '5000.000000000000000000',
  };
})();

const BOT = {
  id: 'bot-1',
  user_id: 'admin-1',
  strategy: StrategyKind.MARKET_MAKER,
  venue: 'LIGHTER',
  symbol: 'BTC',
  status: 'RUNNING',
  dry_run: true,
  config_version: 3,
  exchange_account_id: 'cuenta-1',
  started_at: new Date(Date.now() - 96 * 3_600_000),
};

const AJUSTE = {
  bot_id: 'bot-1',
  mode: AiMode.MANUAL,
  knobs: KNOBS,
  review_every_minutes: null,
  daily_call_limit: null,
  allow_warm: true,
  last_bucket: null,
  failures: 0,
};

/** Un estado fresco del bot con posicion abierta. Los importes, como cadenas. */
const SNAPSHOT = {
  position_qty: '0.01',
  average_entry: '78000',
  mark_price: '78910.1',
  unrealized_pnl: '9.1',
  realized_pnl_acc: '-1.2',
  liquidation_price: null,
  open_orders: 2,
  taken_at: new Date(),
};

interface Opciones {
  env?: Record<string, string>;
  respuesta?: string | null;
  cupo?: number;
  turno?: boolean;
  vale?: { decisionId: string; botId: string; userId: string } | null;
  decision?: Record<string, unknown> | null;
  ajuste?: Record<string, unknown>;
  allowWarm?: boolean;
}

function build(opts: Opciones = {}) {
  const env: Record<string, string> = {
    AI_AGENT_ENABLE: 'true',
    AI_AGENT_DRY_RUN_ONLY: 'true',
    ...opts.env,
  };

  const creadas: Record<string, unknown>[] = [];
  const db = {
    bot: { findUnique: jest.fn().mockResolvedValue(BOT) },
    exchangeAccount: { findUnique: jest.fn().mockResolvedValue({ testnet: false }) },
    botConfigRevision: { findUnique: jest.fn().mockResolvedValue({ config: CONFIG_VIGENTE }) },
    botCycle: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    botSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    botEvent: { groupBy: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
    botMmStat: { findUnique: jest.fn().mockResolvedValue(null) },
    botFill: { findFirst: jest.fn().mockResolvedValue(null) },
    botAiDecision: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        creadas.push(args.data);
        return Promise.resolve({ id: BigInt(creadas.length) });
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(opts.decision ?? null),
    },
    botAiSetting: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ allow_warm: opts.allowWarm ?? true }),
    },
  };

  const cache = {
    setnx: jest.fn().mockResolvedValue(opts.turno ?? true),
    incrWithExpire: jest.fn().mockResolvedValue(opts.cupo ?? 1),
    set: jest.fn().mockResolvedValue(undefined),
    getDel: jest.fn().mockResolvedValue(opts.vale ?? null),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (k: string, def?: string) => env[k] ?? def };
  const modelo = {
    agentAvailable: true,
    agentModelId: 'anthropic/claude-sonnet-5',
    revisar: jest.fn().mockResolvedValue(opts.respuesta ?? null),
  };
  const marketData = { features: jest.fn().mockResolvedValue(RASGOS) };
  const markets = { getSpec: jest.fn().mockResolvedValue(MERCADO.spec) };
  const risk = {
    get: jest.fn().mockResolvedValue({ max_leverage: null }),
    // El tope EFECTIVO de apalancamiento (spec 052, F-09): el menor de los
    // limites del usuario, los del notional y el que impone la distancia de
    // liquidacion del mercado. Sin el se proponia lo que `assertWithinLimits` iba
    // a rechazar con un 403.
    topeDeApalancamiento: jest.fn().mockResolvedValue(10),
  };
  const bots = { updateConfig: jest.fn() };

  const service = new SupervisorService(
    db as never,
    cache as never,
    bus as never,
    config as never,
    modelo as never,
    marketData as never,
    markets as never,
    risk as never,
    bots as never,
  );

  return { service, db, cache, bus, modelo, bots, risk, creadas };
}

const respuesta = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    accion: 'AJUSTAR',
    ajustes: {
      leverage: 'IGUAL',
      coverage: 'IGUAL',
      spread: 'MAS',
      sizeGrowth: 'IGUAL',
      cadence: 'IGUAL',
    },
    confianza: 'MEDIA',
    motivo: 'La volatilidad ha subido.',
    ...extra,
  });

const soloCobertura = {
  leverage: 'IGUAL',
  coverage: 'MAS',
  spread: 'IGUAL',
  sizeGrowth: 'IGUAL',
  cadence: 'IGUAL',
};

/** Los datos de cada `update` de un mock, en orden. */
const datosDe = (mock: jest.Mock): Record<string, unknown>[] =>
  mock.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

const tiposPublicados = (bus: { publish: jest.Mock }): string[] =>
  bus.publish.mock.calls.map((c) => (c[1] as { type: string }).type);

/** El texto publicado de un tipo de evento. */
const textoPublicado = (bus: { publish: jest.Mock }, tipo: string): string => {
  const mensaje = bus.publish.mock.calls
    .map((c) => c[1] as { type: string; data: { message: string } })
    .find((m) => m.type === tipo);
  if (!mensaje) throw new Error(`No se publico ningun ${tipo}`);
  return mensaje.data.message;
};

/** Un campo de un diff guardado. */
type CampoGuardado = { key: string; from: unknown; to: unknown; labelKey: string };

/** Un valor como lo escribe un aviso: sin ceros de relleno (spec 054). */
const legible = (v: unknown): string => D(String(v)).toFixed();

/** La linea que un aviso escribe para un campo, con el nombre de la pantalla. */
const lineaDe = (c: CampoGuardado): string =>
  `• ${ETIQUETAS[c.labelKey]}: ${legible(c.from)} → ${legible(c.to)}`;

const parametros = (n: number): string => `${n} ${n === 1 ? 'parámetro' : 'parámetros'}`;

describe('SupervisorService — las barreras antes de gastar', () => {
  it('con el interruptor apagado no llama a nadie', async () => {
    const { service, modelo } = build({ env: { AI_AGENT_ENABLE: 'false' } });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(modelo.revisar).not.toHaveBeenCalled();
  });

  it('sin clave de modelo tampoco', async () => {
    const { service, modelo } = build();
    (modelo as { agentAvailable: boolean }).agentAvailable = false;
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(modelo.revisar).not.toHaveBeenCalled();
  });

  it('un bot que no esta operando nunca se revisa', async () => {
    // En ERROR la premisa esta rota: con el adaptador averiado la configuracion
    // no es el problema, y una recolocacion empeora las cosas.
    for (const status of ['ERROR', 'PAUSED', 'STOPPED', 'LIQUIDATED', 'STARTING']) {
      const { service, modelo } = build();
      await service.revisarBot(AJUSTE, { ...BOT, status }, 'CRON');
      expect(`${status}: ${modelo.revisar.mock.calls.length}`).toBe(`${status}: 0`);
    }
  });

  it('con DRY_RUN_ONLY no toca un bot real', async () => {
    const { service, modelo } = build();
    await service.revisarBot(AJUSTE, { ...BOT, dry_run: false }, 'CRON');
    expect(modelo.revisar).not.toHaveBeenCalled();
  });

  it('dentro del enfriamiento no se revisa', async () => {
    // `setnx` devuelve false cuando la clave ya existe: es lo que convierte
    // treinta ciclos cerrados en una hora en seis llamadas, no treinta.
    const { service, modelo } = build({ turno: false });
    await service.revisarBot(AJUSTE, BOT, 'OPERACION');
    expect(modelo.revisar).not.toHaveBeenCalled();
  });

  it('si la huella del expediente no cambio, no se pregunta otra vez', async () => {
    const { service, modelo, db } = build({ respuesta: respuesta({ accion: 'MANTENER' }) });
    // Primera vuelta, con una respuesta que vale: se guarda la huella que produjo.
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    const guardada = (db.botAiSetting.update.mock.calls[0][0] as { data: { last_bucket: string } })
      .data.last_bucket;
    expect(guardada).toBeTruthy();

    // Segunda vuelta con la misma huella: ni una llamada.
    const otro = build();
    await otro.service.revisarBot({ ...AJUSTE, last_bucket: guardada }, BOT, 'CRON');
    expect(otro.modelo.revisar).not.toHaveBeenCalled();
    expect(modelo.revisar).toHaveBeenCalledTimes(1);
  });

  it('con Redis caido se NIEGA la llamada', async () => {
    // `incrWithExpire` devuelve -1 sin Redis. Es lo contrario de lo que hace el
    // resto del cache —degradar abriendo la mano— y a proposito: al otro lado hay
    // una factura, y sin contador no hay tope.
    const { service, modelo } = build({ cupo: -1 });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(modelo.revisar).not.toHaveBeenCalled();
  });

  it('agotado el cupo global no se llama, aunque el del bot sobre', async () => {
    const { service, modelo, cache } = build();
    cache.incrWithExpire.mockImplementation((clave: string) =>
      Promise.resolve(clave.startsWith('ai:quota:global:') ? 9999 : 1),
    );
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(modelo.revisar).not.toHaveBeenCalled();
  });

  it('sin rasgos de mercado no se decide a ciegas', async () => {
    // Un prompt con la volatilidad a cero produce numeros inventados con aspecto
    // de calculados. Mismo criterio que `buildFeatures` sin velas suficientes.
    const { service, modelo, db } = build();
    db.botConfigRevision.findUnique.mockResolvedValue(null);
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(modelo.revisar).not.toHaveBeenCalled();
  });
});

describe('SupervisorService — que hace con lo que dice el modelo', () => {
  it('MANTENER no escribe nada: la inaccion sale gratis', async () => {
    // Una fila cada media hora diciendo «todo bien» llenaria la tabla de ruido y
    // convertiria el historial en algo que nadie mira.
    const { service, creadas, bus } = build({
      respuesta: respuesta({ accion: 'MANTENER' }),
    });
    const id = await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(id).toBeNull();
    expect(creadas).toHaveLength(0);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('en MANUAL escribe la propuesta y NO aplica nada', async () => {
    const { service, creadas, bots } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    expect(bots.updateConfig).not.toHaveBeenCalled();
    expect(creadas).toHaveLength(1);
    expect(creadas[0]['state']).toBe(AiDecisionState.PROPUESTA);
    expect(creadas[0]['expires_at']).toBeInstanceOf(Date);
    expect(creadas[0]['config_version_before']).toBe(3);
  });

  it('la propuesta guarda el expediente que vio el modelo', async () => {
    // Sin el, una decision rara es imposible de explicar seis meses despues.
    const { service, creadas } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(creadas[0]['dossier']).toBeTruthy();
    expect(creadas[0]['knobs_before']).toEqual(KNOBS);
    expect(creadas[0]['prompt_version']).toBeGreaterThan(0);
  });

  it('AVISAR no propone cambios, solo avisa', async () => {
    // Es como el modelo dice «esto lo tiene que mirar una persona» sin pedir un
    // cambio. Honrar sus desplazamientos seria convertir un aviso en una
    // propuesta que nadie pidio.
    const { service, creadas } = build({ respuesta: respuesta({ accion: 'AVISAR' }) });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(creadas[0]['action']).toBe('AVISAR');
    expect(creadas[0]['proposed_config']).toBeUndefined();
    expect(creadas[0]['apply_level']).toBeNull();
  });

  it('una propuesta nueva retira la anterior', async () => {
    // Una cola de consejos rancios es peor que ninguno.
    const { service, db } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(db.botAiDecision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: AiDecisionState.DESCARTADA, discard_reason: 'SUPERSEDIDA' },
      }),
    );
  });

  it('el aviso se publica con entrega forzada', async () => {
    // Sin la marca, el notificador del worker lo descarta por origen ajeno y no
    // lo entrega NADIE: es el defecto que este mismo spec arreglo (R-27).
    const { service, bus } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    const mensaje = bus.publish.mock.calls[0][1] as Record<string, unknown>;
    expect(mensaje['entregaForzada']).toBe(true);
    expect(mensaje['type']).toBe('AI_SUGGESTION');
    expect(mensaje['userId']).toBe('admin-1');
  });

  it('la sugerencia dice que cambia, de cuanto a cuanto y por que (spec 054)', async () => {
    // Decia «propone cambiar buyDistanceBps, sellDistanceBps»: sin un numero no
    // se podia decidir si aprobar sin abrir la app.
    const { service, bus, db, creadas } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    const texto = textoPublicado(bus, 'AI_SUGGESTION');
    const diff = creadas[0]['diff'] as CampoGuardado[];
    expect(diff.length).toBeGreaterThan(0);
    const lineas = texto.split('\n');
    expect(lineas[0]).toBe(
      `El supervisor propone cambiar ${parametros(diff.length)} (diferencial: más):`,
    );
    // Cada campo del diff guardado, con sus dos valores, y ninguna clave interna.
    for (const c of diff) {
      expect(texto).toContain(lineaDe(c));
      expect(texto).not.toContain(c.key);
    }
    expect(lineas.at(-1)).toBe('Motivo: La volatilidad ha subido.');

    // Y la bitacora del bot dice exactamente lo mismo que Telegram.
    const evento = db.botEvent.create.mock.calls[0][0] as {
      data: { type: string; message: string };
    };
    expect(evento.data).toMatchObject({ type: 'AI_SUGGESTION', message: texto });
  });

  it('en «cantidad de moneda» el tamaño se avisa en la moneda base (spec 054)', async () => {
    // El descriptor efectivo es el que sabe la unidad: con el crudo, el aviso
    // diria USDC de una cantidad de BTC.
    const { service, bus, db, creadas } = build({
      respuesta: respuesta({
        ajustes: {
          leverage: 'IGUAL',
          coverage: 'IGUAL',
          spread: 'IGUAL',
          sizeGrowth: 'MAS',
          cadence: 'IGUAL',
        },
      }),
    });
    db.botConfigRevision.findUnique.mockResolvedValue({
      config: { ...CONFIG_VIGENTE, sizingMode: 'BASE', orderSizePerSide: '0.005' },
    });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    const diff = creadas[0]['diff'] as CampoGuardado[];
    const tamano = diff.find((c) => c.key === 'orderSizePerSide');
    expect(tamano).toBeDefined();
    expect(textoPublicado(bus, 'AI_SUGGESTION')).toContain(
      `• Tamaño por compra/venta: 0.005 → ${legible(tamano!.to)} BTC\n`,
    );
  });
});

describe('SupervisorService — cuando el modelo falla', () => {
  it('no toca nada y lo cuenta', async () => {
    // No hay plan B determinista, y es la asimetria deliberada con el asesor:
    // alli las reglas rellenan un formulario que alguien va a revisar; aqui
    // reescribirian en silencio un bot vivo porque el modelo estaba caido.
    const { service, creadas, bots, db } = build({ respuesta: null });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    expect(bots.updateConfig).not.toHaveBeenCalled();
    expect(creadas[0]['state']).toBe(AiDecisionState.FALLIDA);
    const update = db.botAiSetting.update.mock.calls.at(-1)![0] as { data: { failures: number } };
    expect(update.data.failures).toBe(1);
  });

  it('una respuesta fuera del contrato cuenta como fallo', async () => {
    const { service, creadas } = build({ respuesta: '{"accion":"CONTENER"}' });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(creadas[0]['state']).toBe(AiDecisionState.FALLIDA);
    expect(creadas[0]['discard_reason']).toBe('CONTRATO');
  });

  it('a los cinco fallos seguidos se duerme', async () => {
    const { service, db } = build({ respuesta: null });
    await service.revisarBot({ ...AJUSTE, failures: 4 }, BOT, 'CRON');
    const update = db.botAiSetting.update.mock.calls.at(-1)![0] as {
      data: { paused_until?: Date };
    };
    expect(update.data.paused_until).toBeInstanceOf(Date);
  });

  it('el aviso de fallo va estrangulado', async () => {
    // Un OpenRouter caido que avisa en cada ventana enseña al usuario a silenciar
    // el canal justo antes del aviso que si habia que leer (leccion del spec 029).
    const { service, cache, bus } = build({ respuesta: null });
    cache.setnx.mockImplementation((clave: string) =>
      Promise.resolve(!clave.startsWith('ai:fail:')),
    );
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('si el modelo falla no se guarda la huella: la siguiente revision vuelve a preguntar', async () => {
    // Con la huella en tramos, una guardada tras un timeout ya no caduca sola cada
    // media hora: el bot se quedaria sin revisar hasta que cambiara otra cosa
    // (spec 051, H-14).
    for (const fallo of [null, '{"accion":"CONTENER"}']) {
      const { service, db } = build({ respuesta: fallo });
      await service.revisarBot(AJUSTE, BOT, 'CRON');
      const datos = datosDe(db.botAiSetting.update);
      expect(datos.some((d) => 'last_bucket' in d)).toBe(false);
      expect(datos.some((d) => d['last_review_at'] instanceof Date)).toBe(true);
    }
  });
});

describe('SupervisorService — el modo automatico', () => {
  const auto = { ...AJUSTE, mode: AiMode.AUTO };

  it('aplica por el MISMO camino que una persona, y como el dueño', async () => {
    // `updateConfig` con el `user_id` del dueño: `mustOwn` sigue siendo cierto y
    // no relajado. Con el pasan otra vez el diff, el rechazo de COLD, la guarda
    // de reshape, `validate()` y `assertWithinLimits`.
    const { service, bots, creadas } = build({ respuesta: respuesta() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4, level: 'HOT' });

    await service.revisarBot(auto, BOT, 'CRON');

    expect(bots.updateConfig).toHaveBeenCalledTimes(1);
    const [userId, botId, dto, opts] = bots.updateConfig.mock.calls[0];
    expect(userId).toBe('admin-1');
    expect(botId).toBe('bot-1');
    // Con la version que se leyo al empezar: si el dueño toco el bot durante la
    // llamada al modelo, esto ya no se aplica (spec 052, F-06).
    expect(opts).toEqual({
      appliedBy: expect.stringMatching(/^ia:/),
      expectedVersion: BOT.config_version,
    });
    expect(creadas[0]['state']).toBe(AiDecisionState.PROPUESTA);
    // `acceptRelayout` va atado al nivel del cambio, ni siempre ni nunca:
    // `updateConfig` exige esa confirmacion para un WARM —que cancela las
    // ordenes del bot y las vuelve a tender— y la rechaza sin ella con un 409.
    // Mandarlo siempre a `true` seria aceptar de antemano algo que aun no se
    // sabe, y a `false` haria que ningun WARM llegara nunca.
    expect((dto as { acceptRelayout: boolean }).acceptRelayout).toBe(
      creadas[0]['apply_level'] === 'WARM',
    );
  });

  it('deja su firma en el historial de configuracion', async () => {
    // Sin esto, el rastro del supervisor seria indistinguible del de su dueño en
    // `bot_config_revisions`, que es justo lo que hay que mirar cuando un bot
    // cambio solo.
    const { service, bots } = build({ respuesta: respuesta() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });
    await service.revisarBot(auto, BOT, 'CRON');
    expect(bots.updateConfig.mock.calls[0][3]).toEqual({
      appliedBy: expect.stringMatching(/^ia:\d+$/),
      expectedVersion: BOT.config_version,
    });
  });

  it('FORCE_MANUAL degrada el automatico sin tocar la base', async () => {
    // El interruptor que de verdad se quiere a las tres de la mañana: deja de
    // aplicar, sigue sugiriendo.
    const { service, bots, creadas } = build({
      respuesta: respuesta(),
      env: { AI_AGENT_FORCE_MANUAL: 'true' },
    });
    await service.revisarBot(auto, BOT, 'CRON');

    expect(bots.updateConfig).not.toHaveBeenCalled();
    expect(creadas[0]['mode']).toBe(AiMode.MANUAL);
  });

  it('al llegar al tope de cambios del dia deja de aplicar', async () => {
    // Distinto del cupo de llamadas: aquel cuenta preguntas, este cuenta
    // CAMBIOS. Es el freno del vaiven.
    const { service, bots, cache, db } = build({ respuesta: respuesta() });
    cache.incrWithExpire.mockImplementation((clave: string) =>
      Promise.resolve(clave.startsWith('ai:applies:') ? 99 : 1),
    );
    await service.revisarBot(auto, BOT, 'CRON');

    expect(bots.updateConfig).not.toHaveBeenCalled();
    const update = db.botAiDecision.update.mock.calls[0][0] as {
      data: { discard_reason: string };
    };
    expect(update.data.discard_reason).toBe('TOPE_DIARIO');
  });

  it('si updateConfig rechaza el cambio, la configuracion queda intacta y se dice', async () => {
    // La excepcion NO se traga: si el cambio se rechaza por riesgo, por
    // validacion o por inventario, eso es justo lo que hay que poder leer.
    const { service, bots, db, bus } = build({ respuesta: respuesta() });
    bots.updateConfig.mockRejectedValue(new Error('Tu límite de apalancamiento es 3×.'));

    await service.revisarBot(auto, BOT, 'CRON');

    const update = db.botAiDecision.update.mock.calls.at(-1)![0] as {
      data: { state: string; error: string };
    };
    expect(update.data.state).toBe(AiDecisionState.FALLIDA);
    expect(update.data.error).toContain('apalancamiento');
    // Y el dueño se entera.
    expect(tiposPublicados(bus)).toContain('AI_FAILED');
  });

  it('un cambio aplicado se avisa con severidad WARN', async () => {
    // No es una averia, pero es lo mas importante que puede pasarle a un bot sin
    // que su dueño lo pidiera: tiene que llegar aunque el canal este a medias.
    const { service, bots, bus } = build({ respuesta: respuesta() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });
    await service.revisarBot(auto, BOT, 'CRON');

    const aviso = bus.publish.mock.calls
      .map((c) => c[1] as { type: string; data: { severity: string } })
      .find((m) => m.type === 'AI_APPLIED');
    expect(aviso).toBeDefined();
    expect(aviso!.data.severity).toBe('WARN');
  });

  it('el cambio aplicado dice que cambio y de cuanto a cuanto (spec 054)', async () => {
    const { service, bots, bus, creadas } = build({ respuesta: respuesta() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });
    await service.revisarBot(auto, BOT, 'CRON');

    const texto = textoPublicado(bus, 'AI_APPLIED');
    const diff = creadas[0]['diff'] as CampoGuardado[];
    const lineas = texto.split('\n');
    expect(lineas[0]).toBe(
      `El supervisor ha cambiado ${parametros(diff.length)} (diferencial: más):`,
    );
    for (const c of diff) {
      expect(texto).toContain(lineaDe(c));
      expect(texto).not.toContain(c.key);
    }
    expect(lineas.filter((l) => l.startsWith('• '))).toHaveLength(diff.length);
    expect(texto).not.toContain('aprobación');
    expect(lineas.at(-1)).toBe('Motivo: La volatilidad ha subido.');
  });
});

describe('SupervisorService — el boton de Telegram', () => {
  const VALE = { decisionId: '7', botId: 'bot-1', userId: 'admin-1' };

  const decisionPendiente = (extra: Record<string, unknown> = {}) => ({
    id: BigInt(7),
    state: AiDecisionState.PROPUESTA,
    config_version_before: 3,
    proposed_config: CONFIG_VIGENTE,
    knobs_before: KNOBS,
    apply_level: 'HOT',
    knobs_after: KNOBS,
    raw: {
      accion: 'AJUSTAR',
      ajustes: {
        leverage: 'IGUAL',
        coverage: 'IGUAL',
        spread: 'MAS',
        sizeGrowth: 'IGUAL',
        cadence: 'IGUAL',
      },
    },
    rationale: 'La volatilidad ha subido.',
    bot: {
      id: 'bot-1',
      user_id: 'admin-1',
      strategy: StrategyKind.MARKET_MAKER,
      status: 'RUNNING',
      config_version: 3,
    },
    ...extra,
  });

  it('la sugerencia lleva un vale opaco, no el id del bot', () => {
    // En `callback_data` caben 64 bytes, y ademas quien lo intercepte no debe
    // poder deducir de que bot es ni que cambio propone.
    const { service } = build();
    const token = (
      service as unknown as {
        valeDe(b: { id: string; user_id: string }, d: bigint): Promise<string>;
      }
    ).valeDe({ id: 'bot-1', user_id: 'admin-1' }, BigInt(7));
    return token.then((t) => {
      expect(t).toMatch(/^[0-9a-f]{32}$/);
      expect(t).not.toContain('bot-1');
      // `ia:` + 32 + `:si` cabe de sobra en los 64 bytes del campo.
      expect(`ia:${t}:si`.length).toBeLessThanOrEqual(64);
    });
  });

  it('un vale que no existe no hace nada', async () => {
    // Pulsar dos veces el mismo boton: el segundo `getDel` devuelve null porque
    // el primero se lo llevo. El uso unico sale gratis de la atomicidad.
    const { service, bots, db } = build({ vale: null });
    await service.canjearVale('admin-1', 'inventado', true);
    expect(bots.updateConfig).not.toHaveBeenCalled();
    expect(db.botAiDecision.update).not.toHaveBeenCalled();
  });

  it('un vale de OTRO usuario no hace nada', async () => {
    // El chat demuestra que ese Telegram controla una cuenta; esto comprueba que
    // la cuenta es la dueña de la decision.
    const { service, bots } = build({ vale: VALE, decision: decisionPendiente() });
    await service.canjearVale('usuario-2', 'x', true);
    expect(bots.updateConfig).not.toHaveBeenCalled();
  });

  it('descartar marca RECHAZADA y no toca el bot', async () => {
    const { service, bots, db } = build({ vale: VALE, decision: decisionPendiente() });
    await service.canjearVale('admin-1', 'x', false);

    expect(bots.updateConfig).not.toHaveBeenCalled();
    const update = db.botAiDecision.update.mock.calls[0][0] as { data: { state: string } };
    expect(update.data.state).toBe(AiDecisionState.RECHAZADA);
  });

  it('aplicar sobre una configuracion que cambio caduca la sugerencia', async () => {
    // El mundo cambio debajo: la propuesta se calculo sobre otra cosa. Es la
    // garantia de verdad, mas que el plazo — un usuario puede pulsar al minuto y
    // haber cambiado el bot a mano entre medias.
    const { service, bots, db, bus } = build({
      vale: VALE,
      decision: decisionPendiente({
        bot: {
          id: 'bot-1',
          user_id: 'admin-1',
          strategy: StrategyKind.MARKET_MAKER,
          status: 'RUNNING',
          config_version: 9,
        },
      }),
    });
    await service.canjearVale('admin-1', 'x', true);

    expect(bots.updateConfig).not.toHaveBeenCalled();
    const update = db.botAiDecision.update.mock.calls[0][0] as {
      data: { state: string; discard_reason: string };
    };
    expect(update.data.state).toBe(AiDecisionState.CADUCADA);
    expect(update.data.discard_reason).toBe('STALE');
    // Y se dice, en vez de dejar al usuario mirando un botón que no hizo nada.
    expect(tiposPublicados(bus)).toContain('AI_FAILED');
  });

  it('una decision que ya no esta pendiente no revive', async () => {
    for (const state of [
      AiDecisionState.APLICADA,
      AiDecisionState.CADUCADA,
      AiDecisionState.DESCARTADA,
      AiDecisionState.RECHAZADA,
    ]) {
      const { service, bots } = build({ vale: VALE, decision: decisionPendiente({ state }) });
      await service.canjearVale('admin-1', 'x', true);
      expect(`${state}: ${bots.updateConfig.mock.calls.length}`).toBe(`${state}: 0`);
    }
  });

  it('aplicar de verdad pasa por el camino de siempre', async () => {
    const { service, bots } = build({ vale: VALE, decision: decisionPendiente() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });
    await service.canjearVale('admin-1', 'x', true);

    expect(bots.updateConfig).toHaveBeenCalledTimes(1);
    expect(bots.updateConfig.mock.calls[0][0]).toBe('admin-1');
    // La version es la que acaba de leer `rehacer`, no la que se guardo al
    // proponer: entre las dos pueden haber pasado sesenta minutos.
    expect(bots.updateConfig.mock.calls[0][3]).toEqual({
      appliedBy: 'ia:7',
      expectedVersion: BOT.config_version,
    });
  });

  it('RECALCULA contra el mercado de ahora, no aplica lo guardado', async () => {
    // R-23 lo prometia y no ocurria: se aplicaba `proposed_config` tal cual,
    // calculado hasta una hora antes. `updateConfig` revalida con `validate()`
    // pero NO con `preview()`, que es lo unico que detecta violaciones de tick,
    // paso y notional minimo del venue (spec 047, F-04).
    const { service, bots, db } = build({ vale: VALE, decision: decisionPendiente() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });
    await service.canjearVale('admin-1', 'x', true);

    // Se vuelve a leer la revision vigente y la spec del mercado: eso es
    // recalcular. Si solo se aplicara lo guardado, no haria falta ninguna.
    expect(db.botConfigRevision.findUnique).toHaveBeenCalled();
    expect(db.bot.findUnique).toHaveBeenCalled();
  });

  it('si el recalculo ya no cabe, caduca en vez de aplicar a ciegas', async () => {
    const { service, bots, db, bus } = build({ vale: VALE, decision: decisionPendiente() });
    // Sin revision vigente no hay contexto: el recalculo no puede hacerse.
    db.botConfigRevision.findUnique.mockResolvedValue(null);

    await service.canjearVale('admin-1', 'x', true);

    expect(bots.updateConfig).not.toHaveBeenCalled();
    const update = db.botAiDecision.update.mock.calls.at(-1)![0] as {
      data: { state: string; discard_reason: string };
    };
    expect(update.data.state).toBe(AiDecisionState.CADUCADA);
    expect(update.data.discard_reason).toBe('RECALCULO');
    // Y se dice, en vez de dejar al usuario mirando un boton que no hizo nada.
    expect(tiposPublicados(bus)).toContain('AI_FAILED');
  });

  it('una aprobacion humana NO pasa por el tope diario de cambios', async () => {
    // El tope existe para que un bot no se reescriba SOLO seis veces en una
    // tarde. Quien pulsa el boton ha mirado el cambio y ha decidido; descartarle
    // el septimo en silencio seria lo peor de los dos mundos (F-09).
    const { service, bots, cache } = build({ vale: VALE, decision: decisionPendiente() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });
    cache.incrWithExpire.mockImplementation((clave: string) =>
      Promise.resolve(clave.startsWith('ai:applies:') ? 99 : 1),
    );

    await service.canjearVale('admin-1', 'x', true);

    expect(bots.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('una aprobacion humana tampoco pasa por el enfriamiento WARM (spec 051)', async () => {
    // Hubo un WARM automatico hace un rato: el automatico esperaria seis horas,
    // pero quien pulsa el boton ha mirado el cambio.
    const { service, bots, db } = build({ vale: VALE, decision: decisionPendiente() });
    db.botAiDecision.findFirst.mockResolvedValue({ id: BigInt(9) });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });

    await service.canjearVale('admin-1', 'x', true);

    expect(bots.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('aprobar desde Telegram tambien hace avanzar las perillas (spec 051)', async () => {
    const { service, bots, db } = build({ vale: VALE, decision: decisionPendiente() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });

    await service.canjearVale('admin-1', 'x', true);

    const perillas = datosDe(db.botAiSetting.update).find((d) => 'knobs' in d);
    expect(perillas?.['knobs']).toEqual({ ...KNOBS, spread: 'ALTA' });
  });

  it('el aviso de una aprobacion lleva los valores RECALCULADOS (spec 054)', async () => {
    // Al aprobar se rehace el cambio con el mercado de ahora (F-04): lo aplicado
    // puede no ser lo que decia la sugerencia, y el aviso tiene que decir lo
    // aplicado. Lo que se guardo al proponer, aqui, es otra cosa a proposito.
    const alProponer = [
      {
        key: 'buyDistanceBps',
        from: '1',
        to: '999',
        mutability: 'HOT',
        labelKey: 'strategy.mm.buyDistanceBps',
      },
    ];
    const { service, bots, bus, db } = build({
      vale: VALE,
      decision: decisionPendiente({ diff: alProponer }),
    });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });

    await service.canjearVale('admin-1', 'x', true);

    const aplicado = datosDe(db.botAiDecision.update).find((d) => 'diff' in d)?.[
      'diff'
    ] as CampoGuardado[];
    expect(aplicado.length).toBeGreaterThan(0);
    const texto = textoPublicado(bus, 'AI_APPLIED');
    const lineas = texto.split('\n');
    expect(lineas[0]).toBe(
      `El supervisor ha cambiado ${parametros(aplicado.length)} con tu aprobación ` +
        '(diferencial: más):',
    );
    for (const c of aplicado) {
      expect(texto).toContain(lineaDe(c));
    }
    expect(texto).not.toContain('999');
    expect(lineas).toContain('Valores recalculados al aprobar, con el mercado de ese momento.');
    expect(lineas.at(-1)).toBe('Motivo: La volatilidad ha subido.');
  });
});

describe('SupervisorService — el historial no miente (spec 047, F-02)', () => {
  it('una decision FALLIDA guarda lo que de verdad paso', async () => {
    // Guardaba `mode: OFF`, `action: AVISAR`, `knobs_before: {}` y
    // `config_version_before: 0`: cuatro columnas falsas en el historial que se
    // mira justamente cuando hay que explicar por que un bot cambio solo.
    const { service, creadas } = build({ respuesta: null });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    expect(creadas[0]['state']).toBe(AiDecisionState.FALLIDA);
    expect(creadas[0]['mode']).toBe(AJUSTE.mode);
    expect(creadas[0]['knobs_before']).toEqual(KNOBS);
    expect(creadas[0]['config_version_before']).toBe(BOT.config_version);
    // Y la accion NO puede ser una de las del contrato: el modelo no dijo nada.
    expect(['MANTENER', 'AJUSTAR', 'AVISAR']).not.toContain(creadas[0]['action']);
  });

  it('el historial que ve el modelo no incluye los fallos', async () => {
    // Tres caidas de OpenRouter hacian que el modelo leyera «AVISAR, AVISAR,
    // AVISAR» y concluyera que ya habia avisado tres veces de algo. El spec dice
    // que ese historial «es lo que impide el vaiven»; contaminado, lo provoca.
    const { service, db } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    const args = db.botAiDecision.findMany.mock.calls[0][0] as {
      where: { OR?: unknown[]; action?: unknown };
    };
    // Lo que se pide son decisiones por ESTADO, no por accion: una fallida no es
    // una opinion del modelo, y una descartada tampoco llego a pasar.
    expect(args.where.OR).toBeDefined();
    expect(args.where.action).toBeUndefined();
  });

  it('tampoco incluye las descartadas ni los avisos: solo cambios', async () => {
    const { service, db } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    const args = db.botAiDecision.findMany.mock.calls[0][0] as {
      where: { OR?: { state?: { in?: string[] } | string; discard_reason?: string }[] };
    };
    const rama = args.where.OR ?? [];
    const estados = rama.flatMap((o) =>
      typeof o.state === 'string' ? [o.state] : (o.state?.in ?? []),
    );
    expect(estados).not.toContain(AiDecisionState.DESCARTADA);
    expect(estados).not.toContain(AiDecisionState.FALLIDA);
    // «AVISAR hace 30 minutos, 1 hora, 2 horas» era lo que convencia al modelo de
    // que el problema persistia (spec 051, H-02).
    expect(estados).not.toContain(AiDecisionState.AVISADA);
    expect(estados).toContain(AiDecisionState.RECHAZADA);
    // Y la que caduco sin respuesta SI entra, con su motivo: sin ella el modelo
    // repetia la misma propuesta que nadie habia aprobado (spec 052, F-17).
    const caducadas = rama.find((o) => o.state === AiDecisionState.CADUCADA);
    expect(caducadas?.discard_reason).toBe('PLAZO');
  });
});

describe('SupervisorService — el cambio de regimen llega al modelo (spec 047, F-01)', () => {
  /** Lo que de verdad se le manda al modelo, sin tener que adivinarlo. */
  const promptDe = (modelo: { revisar: jest.Mock }): string =>
    String(modelo.revisar.mock.calls[0]?.[2] ?? '');

  it('con rasgos de referencia, el prompt lleva el cambio de regimen', async () => {
    // Es «la linea que de verdad decide» segun el spec 046, y no se emitia
    // NUNCA: `mercadoAlConfigurar` iba a null siempre. Un bot no esta mal
    // configurado en abstracto, lo esta respecto de cuando se configuro.
    const { service, modelo } = build({
      respuesta: respuesta({ accion: 'MANTENER' }),
      ajuste: { features_at_enable: { ...RASGOS, atrPct1d: 1 } },
    });
    await service.revisarBot(
      { ...AJUSTE, features_at_enable: { ...RASGOS, atrPct1d: 1 } },
      BOT,
      'CRON',
    );

    const prompt = promptDe(modelo);
    expect(prompt).toContain('CAMBIO DE RÉGIMEN');
    // El par se mueve 3,2 % al dia ahora frente al 1 % de entonces: MAS.
    expect(prompt).toMatch(/veces MAS que cuando se configuró/);
  });

  it('sin referencia no se inventa nada: la linea no aparece', async () => {
    const { service, modelo } = build({ respuesta: respuesta({ accion: 'MANTENER' }) });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(promptDe(modelo)).not.toContain('CAMBIO DE RÉGIMEN');
  });

  it('el prompt de sistema pregunta por ese cambio, asi que el dato tiene que ir', () => {
    // La comprobacion que ata las dos mitades: si un dia alguien quita la linea
    // del expediente, este test recuerda que el sistema la sigue pidiendo.
    expect(systemPromptRevision()).toContain('desde que se configuró');
  });
});

describe('SupervisorService — las Medias de la revision (spec 047)', () => {
  it('F-05: el barrido no toca a quien pidio revision solo por operacion', async () => {
    // El mando existia, se guardaba, y solo se respetaba en un sentido: quien
    // elegia OPERACION para gastar menos gastaba lo mismo.
    const { service } = build();
    const ajustes = {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    };
    const policy = new (jest.requireActual('./supervisor.policy.service').SupervisorPolicyService)(
      { botAiSetting: ajustes },
      {},
    );

    await policy.pendientesDeRevision(5);

    const where = (ajustes.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where['trigger']).toEqual({ in: ['PERIODICO', 'AMBOS'] });
    expect(service).toBeDefined();
  });

  it('F-06: un aviso nace terminal, no se queda pendiente para siempre', async () => {
    // Como PROPUESTA sin caducidad, el cron que caduca —que filtra por
    // `expires_at`— no lo tocaba nunca.
    const { service, creadas } = build({ respuesta: respuesta({ accion: 'AVISAR' }) });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    expect(creadas[0]['action']).toBe('AVISAR');
    expect(creadas[0]['state']).not.toBe(AiDecisionState.PROPUESTA);
  });

  it('F-07: un estado viejo del bot no se presenta como actual', async () => {
    const { service, db } = build({ respuesta: respuesta({ accion: 'MANTENER' }) });
    await service.revisarBot(AJUSTE, BOT, 'CRON');

    const args = db.botSnapshot.findFirst.mock.calls[0][0] as {
      where: { taken_at?: { gte?: Date } };
    };
    expect(args.where.taken_at?.gte).toBeInstanceOf(Date);
  });

  it('F-03: la fila guarda el modelo que decidio, no el nombre de la variable', async () => {
    const { service, creadas } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(creadas[0]['model']).not.toBe('AI_AGENT_MODEL');
    expect(String(creadas[0]['model'])).toContain('/');
  });
});

describe('SupervisorService — la segunda pasada (spec 047, tanda G)', () => {
  const VALE = { decisionId: '7', botId: 'bot-1', userId: 'admin-1' };

  const pendiente = (extra: Record<string, unknown> = {}) => ({
    id: BigInt(7),
    state: AiDecisionState.PROPUESTA,
    config_version_before: 3,
    proposed_config: CONFIG_VIGENTE,
    knobs_before: KNOBS,
    raw: {
      accion: 'AJUSTAR',
      ajustes: {
        leverage: 'IGUAL',
        coverage: 'IGUAL',
        spread: 'MAS',
        sizeGrowth: 'IGUAL',
        cadence: 'IGUAL',
      },
    },
    apply_level: 'HOT',
    knobs_after: KNOBS,
    rationale: 'x',
    bot: {
      id: 'bot-1',
      user_id: 'admin-1',
      strategy: StrategyKind.MARKET_MAKER,
      status: 'RUNNING',
      config_version: 3,
    },
    ...extra,
  });

  it('G-01: aprobar respeta `allow_warm`, que es un mando del dueño', async () => {
    // Al mover la traduccion de proponer a aplicar (F-04) este parametro se
    // quedo atras, y una aprobacion podia recolocar la escalera de un bot cuyo
    // dueño lo habia prohibido — que cuesta comisiones de verdad.
    const { service, bots } = build({ vale: VALE, decision: pendiente(), allowWarm: false });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });

    await service.canjearVale('admin-1', 'x', true);

    // Con WARM prohibido y un cambio que lo es, no se aplica nada.
    if (bots.updateConfig.mock.calls.length > 0) {
      const dto = bots.updateConfig.mock.calls[0][1 + 1] as { acceptRelayout: boolean };
      expect(dto.acceptRelayout).toBe(false);
    }
  });

  it('G-04: un bot que ya no opera no recibe el cambio', async () => {
    // Entre proponer y aprobar pueden pasar sesenta minutos, y en ese rato el
    // bot puede haber entrado en ERROR. R-13 lo prohibe, y el canje era la unica
    // via que no lo comprobaba.
    for (const status of ['ERROR', 'STOPPED', 'LIQUIDATED', 'PAUSED']) {
      const { service, bots, db } = build({
        vale: VALE,
        decision: pendiente({
          bot: {
            id: 'bot-1',
            user_id: 'admin-1',
            strategy: StrategyKind.MARKET_MAKER,
            status,
            config_version: 3,
          },
        }),
      });
      await service.canjearVale('admin-1', 'x', true);

      expect(`${status}: ${bots.updateConfig.mock.calls.length}`).toBe(`${status}: 0`);
      const update = db.botAiDecision.update.mock.calls[0][0] as {
        data: { discard_reason: string };
      };
      expect(update.data.discard_reason).toBe('ESTADO');
    }
  });

  it('G-05: la fila guarda lo que de verdad se aplico, no lo que se propuso', async () => {
    // El historico existe para explicar por que un bot cambio; si lo aplicado no
    // es lo anotado, explica mal.
    const { service, bots, db } = build({ vale: VALE, decision: pendiente() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });

    await service.canjearVale('admin-1', 'x', true);

    const update = db.botAiDecision.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(update.data['proposed_config']).toBeDefined();
    expect(update.data['diff']).toBeDefined();
    expect(update.data['apply_level']).toBeDefined();
  });
});

describe('SupervisorService — un aviso por bot cada 24 horas (spec 051)', () => {
  it('el primer AVISAR se manda; el segundo dentro de la ventana se guarda sin mandar', async () => {
    // Ciento ocho avisos en tres dias sobre tres bots simulados: uno por revision.
    const primero = build({ respuesta: respuesta({ accion: 'AVISAR' }) });
    await primero.service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(primero.creadas[0]['state']).toBe(AiDecisionState.AVISADA);
    expect(tiposPublicados(primero.bus)).toEqual(['AI_ADVICE']);
    expect(primero.db.botEvent.create).toHaveBeenCalledTimes(1);

    const segundo = build({ respuesta: respuesta({ accion: 'AVISAR' }) });
    segundo.cache.setnx.mockImplementation((clave: string) =>
      Promise.resolve(!clave.startsWith('ai:advice:')),
    );
    await segundo.service.revisarBot(AJUSTE, BOT, 'CRON');
    // La decision existio y costo una llamada: se guarda. Pero no se manda, no
    // ensucia el feed del bot y no retira ninguna propuesta pendiente.
    expect(segundo.creadas[0]['state']).toBe(AiDecisionState.DESCARTADA);
    expect(segundo.creadas[0]['discard_reason']).toBe('AVISO_REPETIDO');
    expect(segundo.bus.publish).not.toHaveBeenCalled();
    expect(segundo.db.botEvent.create).not.toHaveBeenCalled();
    expect(segundo.db.botAiDecision.updateMany).not.toHaveBeenCalled();
  });

  it('la ventana dura AI_AGENT_ADVICE_COOLDOWN_H horas, 24 si no se dice', async () => {
    for (const [env, segundos] of [
      [{}, 86_400],
      [{ AI_AGENT_ADVICE_COOLDOWN_H: '6' }, 21_600],
    ] as const) {
      const { service, cache } = build({ respuesta: respuesta({ accion: 'AVISAR' }), env });
      await service.revisarBot(AJUSTE, BOT, 'CRON');
      const turno = cache.setnx.mock.calls.find((c) => String(c[0]).startsWith('ai:advice:'));
      expect(turno?.[0]).toBe('ai:advice:bot-1');
      expect(turno?.[2]).toBe(segundos);
    }
  });

  it('con Redis caido no se avisa', async () => {
    const { service, cache, bus } = build({ respuesta: respuesta({ accion: 'AVISAR' }) });
    cache.setnx.mockImplementation((clave: string) =>
      clave.startsWith('ai:advice:') ? Promise.reject(new Error('redis')) : Promise.resolve(true),
    );
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('si la fila no se puede escribir, el turno del aviso se devuelve', async () => {
    // O el siguiente aviso de verdad se callaria un dia entero por un fallo de
    // escritura.
    const { service, db, cache } = build({ respuesta: respuesta({ accion: 'AVISAR' }) });
    db.botAiDecision.create.mockRejectedValueOnce(new Error('base caida'));
    await expect(service.revisarBot(AJUSTE, BOT, 'CRON')).rejects.toThrow('base caida');
    expect(cache.del).toHaveBeenCalledWith('ai:advice:bot-1');
  });
});

describe('SupervisorService — lo que se aplica, se aplica de verdad (spec 051)', () => {
  const auto = { ...AJUSTE, mode: AiMode.AUTO };

  it('aplicar hace avanzar las perillas y anota cuando', async () => {
    // El market maker de BTC aplico «diferencial MENOS, cadencia MAS», siguio viendo sus
    // perillas en MEDIA y pago cuatro llamadas para oir «sin cambios».
    const { service, bots, db } = build({ respuesta: respuesta() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });

    await service.revisarBot(auto, BOT, 'CRON');

    const perillas = datosDe(db.botAiSetting.update).find((d) => 'knobs' in d);
    expect(perillas?.['knobs']).toEqual({ ...KNOBS, spread: 'ALTA' });
    expect(perillas?.['last_apply_at']).toBeInstanceOf(Date);
  });

  it('`applied: false` no es un cambio aplicado', async () => {
    // Contra el estado de la base puede no quedar nada que cambiar. Anotarlo como
    // aplicado inventaba un cambio en el historial y movia las perillas en vano.
    const { service, bots, db, bus } = build({ respuesta: respuesta() });
    bots.updateConfig.mockResolvedValue({ applied: false, level: 'NONE' });

    await service.revisarBot(auto, BOT, 'CRON');

    expect(datosDe(db.botAiDecision.update)).toContainEqual({
      state: AiDecisionState.DESCARTADA,
      discard_reason: 'SIN_CAMBIOS',
    });
    expect(datosDe(db.botAiSetting.update).some((d) => 'knobs' in d)).toBe(false);
    expect(tiposPublicados(bus)).not.toContain('AI_APPLIED');
  });

  it('un fallo al anotar un cambio ya aplicado no se cuenta como «no pudo aplicar»', async () => {
    const { service, bots, db, bus } = build({ respuesta: respuesta() });
    bots.updateConfig.mockResolvedValue({ applied: true, version: 4 });
    db.botAiDecision.update.mockRejectedValueOnce(new Error('base caida'));

    await service.revisarBot(auto, BOT, 'CRON');

    const tipos = tiposPublicados(bus);
    expect(tipos).not.toContain('AI_FAILED');
    expect(tipos).toContain('AI_APPLIED');
    // Y las perillas se guardan igual: el cambio esta en el bot.
    expect(datosDe(db.botAiSetting.update).some((d) => 'knobs' in d)).toBe(true);
  });

  it('un WARM automatico a pocas horas de otro se descarta', async () => {
    // El diferencial de este market maker mueve la separacion de capas, que es
    // WARM: cancela y vuelve a tender las ordenes.
    const { service, db, creadas } = build({ respuesta: respuesta() });
    db.botAiDecision.findFirst.mockImplementation((args: { where: { state?: string } }) =>
      Promise.resolve(args.where.state === AiDecisionState.APLICADA ? { id: BigInt(9) } : null),
    );

    await service.revisarBot({ ...AJUSTE, mode: AiMode.AUTO }, BOT, 'CRON');

    expect(creadas[0]['state']).toBe(AiDecisionState.DESCARTADA);
    expect(creadas[0]['discard_reason']).toBe('RESHAPE');
    // Y lo que se pregunta es un WARM APLICADO en las ultimas seis horas.
    const consulta = db.botAiDecision.findFirst.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown> })
      .find((a) => a.where['state'] === AiDecisionState.APLICADA)!;
    expect(consulta.where['apply_level']).toBe('WARM');
    const desde = (consulta.where['applied_at'] as { gte: Date }).gte;
    const horas = (Date.now() - desde.getTime()) / 3_600_000;
    expect(horas).toBeGreaterThan(5.9);
    expect(horas).toBeLessThan(6.1);
  });

  it('sin un WARM reciente, el mismo cambio se propone', async () => {
    const { service, creadas } = build({ respuesta: respuesta() });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(creadas[0]['state']).toBe(AiDecisionState.PROPUESTA);
  });

  it('con el cupo del bot agotado no se toca el de la plataforma', async () => {
    const { service, cache, modelo } = build({ respuesta: respuesta() });
    cache.incrWithExpire.mockImplementation((clave: string) =>
      Promise.resolve(clave.startsWith('ai:quota:bot:') ? 99 : 1),
    );

    await service.revisarBot(AJUSTE, BOT, 'CRON');

    expect(modelo.revisar).not.toHaveBeenCalled();
    const claves = cache.incrWithExpire.mock.calls.map((c) => String(c[0]));
    expect(claves.some((k) => k.startsWith('ai:quota:global:'))).toBe(false);
  });
});

describe('SupervisorService — lo que ve el modelo (spec 051)', () => {
  const promptDe = (modelo: { revisar: jest.Mock }): string =>
    String(modelo.revisar.mock.calls[0]?.[2] ?? '');

  it('los eventos se agrupan por tipo y severidad', async () => {
    const { service, db } = build({ respuesta: respuesta({ accion: 'MANTENER' }) });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    const args = db.botEvent.groupBy.mock.calls[0][0] as { by: string[] };
    expect(args.by).toEqual(['type', 'severity']);
  });

  it('ni sus propios avisos ni la operacion normal llegan al prompt', async () => {
    const { service, db, modelo } = build({ respuesta: respuesta({ accion: 'MANTENER' }) });
    db.botEvent.groupBy.mockResolvedValue([
      { type: 'AI_ADVICE', severity: 'INFO', _count: { type: 20 } },
      { type: 'AI_FAILED', severity: 'WARN', _count: { type: 1 } },
      { type: 'FILL', severity: 'INFO', _count: { type: 520 } },
      { type: 'ORDER_REJECTED', severity: 'INFO', _count: { type: 19 } },
    ]);

    await service.revisarBot(AJUSTE, BOT, 'CRON');

    const prompt = promptDe(modelo);
    for (const ruido of ['AI_ADVICE', 'AI_FAILED', 'FILL', 'ORDER_REJECTED', 'Incidencias']) {
      expect(`${ruido}: ${prompt.includes(ruido)}`).toBe(`${ruido}: false`);
    }
  });

  it('el expediente trae lo que cambiaria cada perilla', async () => {
    const { service, modelo } = build({ respuesta: respuesta({ accion: 'MANTENER' }) });
    await service.revisarBot(AJUSTE, BOT, 'CRON');
    const prompt = promptDe(modelo);
    expect(prompt).toContain('Qué cambiaría ahora mover cada perilla un paso');
    expect(prompt).toContain('spread (diferencial)');
  });

  it('con la posicion abierta en el estado fresco, «cobertura MAS» se descarta por riesgo', async () => {
    // En un market maker, cubrir mas es aceptar mas inventario antes de
    // defenderse. El recorte del spec 046 lo dejaba pasar creyendo lo contrario.
    const { service, db, creadas } = build({ respuesta: respuesta({ ajustes: soloCobertura }) });
    db.botSnapshot.findFirst.mockResolvedValue(SNAPSHOT);

    await service.revisarBot(AJUSTE, BOT, 'CRON');

    expect(creadas[0]['state']).toBe(AiDecisionState.DESCARTADA);
    expect(creadas[0]['discard_reason']).toBe('RIESGO');
  });

  it('una posicion a cero esta cerrada aunque el ciclo de un MM tenga niveles', async () => {
    // El ciclo de un market maker no cierra nunca: sus niveles ejecutados no
    // dicen si hoy hay posicion. El estado fresco si.
    const { service, db, creadas } = build({ respuesta: respuesta({ ajustes: soloCobertura }) });
    db.botSnapshot.findFirst.mockResolvedValue({ ...SNAPSHOT, position_qty: '0' });
    db.botCycle.findFirst.mockResolvedValue({ filled_level_indexes: [0, 1] });

    await service.revisarBot(AJUSTE, BOT, 'CRON');

    expect(creadas[0]['state']).toBe(AiDecisionState.PROPUESTA);
  });

  it('sin estado fresco, se supone abierta si el ciclo tiene inventario', async () => {
    const { service, db, creadas } = build({ respuesta: respuesta({ ajustes: soloCobertura }) });
    db.botCycle.findFirst.mockResolvedValue({ filled_level_indexes: [0] });

    await service.revisarBot(AJUSTE, BOT, 'CRON');

    expect(creadas[0]['discard_reason']).toBe('RIESGO');
  });
});

describe('SupervisorService — la revision del spec 052', () => {
  const auto = { ...AJUSTE, mode: AiMode.AUTO };

  it('si la configuracion cambio durante la llamada, no se aplica y no se alarma (F-06)', async () => {
    // Entre leer la configuracion y escribirla pasan unos veinticinco segundos de
    // llamada al modelo, y lo que se escribe es la configuracion ENTERA calculada
    // sobre lo que se leyo: sin esto, lo que el dueño tocara mientras tanto volvia
    // atras en silencio y el historico lo atribuia a la IA.
    const { service, bots, db, bus, creadas } = build({ respuesta: respuesta() });
    bots.updateConfig.mockRejectedValue(
      new ConflictException({ message: 'cambio', reason: 'STALE_VERSION' }),
    );

    await service.revisarBot(auto, BOT, 'CRON');

    expect(bots.updateConfig.mock.calls[0][3]).toEqual({
      appliedBy: expect.stringMatching(/^ia:/),
      expectedVersion: BOT.config_version,
    });
    expect(datosDe(db.botAiDecision.update)).toContainEqual({
      state: AiDecisionState.CADUCADA,
      discard_reason: 'STALE',
    });
    // Ni FALLIDA ni Telegram: no hay nada que una persona tenga que hacer.
    expect(datosDe(db.botAiDecision.update).some((d) => d['state'] === 'FALLIDA')).toBe(false);
    expect(tiposPublicados(bus)).not.toContain('AI_FAILED');
    expect(creadas[0]['action']).toBe('AJUSTAR');
  });

  it('cualquier otro rechazo de la escritura SI es un fallo', async () => {
    // La otra mitad del mismo arreglo: un 403 por riesgo o un 400 por validacion
    // tienen que poder leerse despues, y avisan.
    const { service, bots, db, bus } = build({ respuesta: respuesta() });
    bots.updateConfig.mockRejectedValue(new Error('supera tu límite'));

    await service.revisarBot(auto, BOT, 'CRON');

    expect(datosDe(db.botAiDecision.update)).toContainEqual({
      state: AiDecisionState.FALLIDA,
      discard_reason: 'ESCRITURA',
      error: 'supera tu límite',
    });
    expect(tiposPublicados(bus)).toContain('AI_FAILED');
  });

  it('en manual, un WARM reciente no impide proponer (F-07)', async () => {
    // El enfriamiento existe para que el bot no se reescriba solo cada rato. En
    // manual no se aplica nada: se propone y decide una persona, y `rehacer` ni
    // siquiera lo consulta al aprobar. Frenarlo aqui dejaba al modo manual seis
    // horas sin su decision mas importante.
    const conWarmReciente = (ajuste: typeof AJUSTE) => {
      const { service, db, creadas } = build({ respuesta: respuesta() });
      db.botAiDecision.findFirst.mockImplementation((args: { where: { state?: string } }) =>
        Promise.resolve(args.where.state === AiDecisionState.APLICADA ? { id: BigInt(9) } : null),
      );
      return { service, creadas, correr: () => service.revisarBot(ajuste, BOT, 'CRON') };
    };

    const manual = conWarmReciente(AJUSTE);
    await manual.correr();
    expect(manual.creadas[0]['state']).toBe(AiDecisionState.PROPUESTA);

    const automatico = conWarmReciente(auto);
    await automatico.correr();
    expect(automatico.creadas[0]['state']).toBe(AiDecisionState.DESCARTADA);
    expect(automatico.creadas[0]['discard_reason']).toBe('RESHAPE');
  });

  it('el tope de apalancamiento que se usa es el EFECTIVO del usuario (F-09)', async () => {
    // `assertWithinLimits` comprueba tambien los limites de notional y la
    // distancia de liquidacion; sin mirarlos antes se proponia lo que iba a
    // recibir un 403, y cada rechazo era una decision FALLIDA y un AI_FAILED.
    const { service, risk, creadas } = build({ respuesta: respuesta() });
    // El usuario ya no tiene notional libre: su tope efectivo es 1x, aunque su
    // `max_leverage` no diga nada.
    risk.topeDeApalancamiento.mockResolvedValue(1);

    await service.revisarBot(AJUSTE, BOT, 'CRON');

    const [userId, inversion, mercado, opts] = risk.topeDeApalancamiento.mock.calls[0] as [
      string,
      string,
      unknown,
      { excludeBotId?: string },
    ];
    expect(userId).toBe(BOT.user_id);
    expect(inversion).toBe(CONFIG_VIGENTE.totalInvestment);
    expect(mercado).toBe(MERCADO.spec);
    // Excluyendo al propio bot, o contaria dos veces su notional (001/F-42).
    expect(opts.excludeBotId).toBe(BOT.id);
    // Y la configuracion propuesta respeta ese tope: con el anterior, lo que
    // salia de aqui recibia un 403 en el camino de escritura.
    const propuesta = creadas[0]['proposed_config'] as Record<string, unknown>;
    expect(Number(propuesta['leverage'])).toBe(1);
    expect(Number(CONFIG_VIGENTE['leverage'])).toBeGreaterThan(1);
  });

  it('una revision con respuesta valida pone los fallos a cero (F-10)', async () => {
    // El comentario del contador dice «a los cinco SEGUIDOS», pero solo se
    // reiniciaba al apagar el Modo IA: cinco cortes sueltos de OpenRouter en
    // semanas pausaban el bot seis horas y avisaban de que «falla repetidamente».
    const { service, db } = build({ respuesta: respuesta({ accion: 'MANTENER' }) });
    await service.revisarBot({ ...AJUSTE, failures: 4 }, BOT, 'CRON');

    const marca = datosDe(db.botAiSetting.update).find((d) => 'last_review_at' in d);
    expect(marca?.['failures']).toBe(0);
    expect(marca?.['last_error']).toBeNull();
  });

  it('una revision que falla NO pone los fallos a cero', async () => {
    // La otra mitad: solo una respuesta utilizable cuenta como acierto. Si no, el
    // contador no significaria nada.
    const { service, db } = build({ respuesta: null });
    await service.revisarBot({ ...AJUSTE, failures: 4 }, BOT, 'CRON');
    const marcas = datosDe(db.botAiSetting.update);
    for (const m of marcas) expect(m['failures']).not.toBe(0);
    expect(marcas.some((m) => m['failures'] === 5)).toBe(true);
  });

  it('si falla retirar la propuesta anterior, el aviso se manda igual (F-13)', async () => {
    // El turno del aviso ya estaba gastado: sin esto, el bot se quedaba
    // veinticuatro horas sin poder avisar por un fallo que no tenia que ver.
    const { service, db, bus } = build({ respuesta: respuesta({ accion: 'AVISAR' }) });
    db.botAiDecision.updateMany.mockRejectedValue(new Error('base a medias'));

    await expect(service.revisarBot(AJUSTE, BOT, 'CRON')).resolves.not.toThrow();
    expect(tiposPublicados(bus)).toContain('AI_ADVICE');
  });
});

describe('SupervisorService — los interruptores que ve la app (spec 053)', () => {
  // `undefined` en el entorno simulado es «variable sin poner»: `get` devuelve
  // el valor por defecto, igual que `ConfigService`.
  const sinVariables = {
    AI_AGENT_ENABLE: undefined as never,
    AI_AGENT_DRY_RUN_ONLY: undefined as never,
  };

  it('por defecto: apagado, sin forzar y solo simulados', () => {
    const { service } = build({ env: sinVariables });
    expect(service.interruptores()).toEqual({
      encendido: false,
      forzarManual: false,
      soloSimulados: true,
    });
  });

  it('sin clave del modelo no esta encendido, aunque la variable diga que si', () => {
    const { service, modelo } = build();
    (modelo as { agentAvailable: boolean }).agentAvailable = false;
    expect(service.interruptores().encendido).toBe(false);
  });

  it('con la variable y la clave, encendido', () => {
    const { service } = build();
    expect(service.interruptores().encendido).toBe(true);
  });

  it('refleja AI_AGENT_FORCE_MANUAL y AI_AGENT_DRY_RUN_ONLY', () => {
    const { service } = build({
      env: { AI_AGENT_FORCE_MANUAL: 'true', AI_AGENT_DRY_RUN_ONLY: 'false' },
    });
    expect(service.interruptores()).toEqual({
      encendido: true,
      forzarManual: true,
      soloSimulados: false,
    });
  });

  it('lo que dice coincide con lo que hace revisarBot', async () => {
    // Si la pantalla dijera «actua» y el servicio no mirase, la pastilla
    // mentiria justo sobre lo que existe para aclarar.
    const real = build();
    expect(real.service.interruptores().soloSimulados).toBe(true);
    await real.service.revisarBot(AJUSTE, { ...BOT, dry_run: false }, 'CRON');
    expect(real.modelo.revisar).not.toHaveBeenCalled();

    const apagado = build({ env: { AI_AGENT_ENABLE: 'false' } });
    expect(apagado.service.interruptores().encendido).toBe(false);
    await apagado.service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(apagado.modelo.revisar).not.toHaveBeenCalled();

    const sinClave = build();
    (sinClave.modelo as { agentAvailable: boolean }).agentAvailable = false;
    expect(sinClave.service.interruptores().encendido).toBe(false);
    await sinClave.service.revisarBot(AJUSTE, BOT, 'CRON');
    expect(sinClave.modelo.revisar).not.toHaveBeenCalled();
  });
});
