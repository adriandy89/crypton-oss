import { NotifierService } from './notifier.service';

/**
 * El resumen diario sumaba el PnL de los bots SIMULADOS al de los reales.
 *
 * La regla de la casa está escrita en `portfolio-aggregate.ts`: «el resultado de
 * un simulado es dinero que no existe y no se suma nunca al de verdad». La
 * cartera, los snapshots y el ranking la respetaban; este resumen —el único
 * mensaje que muchos usuarios leen— no, y daba una cifra de ganancias que
 * mezclaba las dos (spec 029).
 */

type Fila = { realized_pnl: string; fees: string; bot: { dry_run: boolean } };
type BotFila = { status: string; dry_run: boolean };

function build(cycles: Fila[], bots: BotFila[]) {
  const enviados: { chatId: string; text: string }[] = [];

  const db = {
    telegramLink: {
      findMany: jest.fn().mockResolvedValue([
        {
          user_id: 'u-1',
          chat_id: '111',
          prefs: {},
          verified_at: new Date(),
        },
      ]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    botCycle: { findMany: jest.fn().mockResolvedValue(cycles) },
    bot: { findMany: jest.fn().mockResolvedValue(bots), findUnique: jest.fn() },
  };
  const bus = { originId: 'test', listen: jest.fn(), publish: jest.fn() };
  const leases = { tryLock: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn().mockReturnValue('token-de-prueba') };

  const service = new NotifierService(db as never, bus as never, leases as never, config as never);

  // El cliente sale a la red; aquí solo interesa QUÉ se manda.
  (service as unknown as { client: { enabled: boolean; sendMessage: unknown } }).client = {
    enabled: true,
    sendMessage: async (chatId: string, text: string) => {
      enviados.push({ chatId, text });
      return true;
    },
  };

  return { service, enviados, db };
}

const ciclo = (pnl: string, dryRun: boolean): Fila => ({
  realized_pnl: pnl,
  fees: '0',
  bot: { dry_run: dryRun },
});

describe('NotifierService — resumen diario', () => {
  it('no suma el resultado de los bots simulados al de los reales', async () => {
    const { service, enviados } = build(
      [ciclo('10', false), ciclo('100', true)],
      [
        { status: 'RUNNING', dry_run: false },
        { status: 'RUNNING', dry_run: true },
      ],
    );

    await service.dailyDigest();

    expect(enviados).toHaveLength(1);
    const texto = enviados[0].text;
    // El resultado es el REAL, no 110.
    expect(texto).toMatch(/Resultado: <b>\+10\.00<\/b> en 1 ciclo/);
    expect(texto).not.toMatch(/110\.00/);
    // Y el recuento de bots tampoco mezcla.
    expect(texto).toMatch(/Bots: 1 operando/);
  });

  it('el simulado sale aparte, para que no parezca parado', async () => {
    const { service, enviados } = build(
      [ciclo('10', false), ciclo('100', true)],
      [{ status: 'RUNNING', dry_run: true }],
    );

    await service.dailyDigest();

    expect(enviados[0].text).toMatch(
      /Simulado \(no cuenta\): \+100\.00 en 1 ciclo\(s\) · 1 operando/,
    );
  });

  it('sin nada que contar no manda mensaje', async () => {
    const { service, enviados } = build([], []);
    await service.dailyDigest();
    expect(enviados).toHaveLength(0);
  });
});

describe('NotifierService — etiqueta del bot', () => {
  /**
   * Un aviso de un bot de pruebas era indistinguible del de uno con dinero
   * dentro: el usuario no puede decidir si le importa sin saber cuál es.
   */
  it('marca los bots simulados', async () => {
    const { service, db } = build([], []);
    db.bot.findUnique.mockResolvedValue({ name: 'm v1', symbol: 'LIT', dry_run: true });

    const label = await (
      service as unknown as { botLabel: (id: string) => Promise<string> }
    ).botLabel('bot-1');

    expect(label).toBe('m v1 (LIT) · simulado');
  });

  it('no marca los reales', async () => {
    const { service, db } = build([], []);
    db.bot.findUnique.mockResolvedValue({ name: 'real', symbol: 'BTC', dry_run: false });

    const label = await (
      service as unknown as { botLabel: (id: string) => Promise<string> }
    ).botLabel('bot-2');

    expect(label).toBe('real (BTC)');
  });
});

/**
 * Entrega de los eventos que NACEN EN LA API.
 *
 * El filtro de origen de `onEvent` es correcto para lo que lo motivo —N workers
 * publicando el mismo fill y los N mandando el mismo aviso— y equivocado para lo
 * que no publica un worker. `ADMIN_COMMAND` lo publica la API
 * (`admin-bots.service.ts`) y su comentario dice que sin el aviso «el dueño no
 * se enteraria de que le han pausado el bot hasta que abriese esa pantalla. En
 * una plataforma no custodial, que un tercero toque tu bot y no te enteres es
 * indefendible». No se enteraba: el origen no casaba con ningun worker y el
 * evento se descartaba en los N. Spec 046, R-27.
 */
function buildEntrega(prefs: Record<string, boolean> = {}, cerrojo = true) {
  const db = {
    telegramLink: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({
        user_id: 'u-1',
        chat_id: '111',
        prefs,
        verified_at: new Date(),
      }),
    },
    botCycle: { findMany: jest.fn().mockResolvedValue([]) },
    bot: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ name: 'bot', symbol: 'BTC', dry_run: false }),
    },
  };
  const bus = { originId: 'worker-1', listen: jest.fn(), publish: jest.fn() };
  const leases = { tryLock: jest.fn().mockResolvedValue(cerrojo) };
  const config = { get: jest.fn().mockReturnValue('token-de-prueba') };

  const service = new NotifierService(db as never, bus as never, leases as never, config as never);
  (service as unknown as { client: { enabled: boolean; sendMessage: unknown } }).client = {
    enabled: true,
    sendMessage: async () => true,
  };

  const onEvent = (m: Record<string, unknown>): Promise<void> =>
    (service as unknown as { onEvent: (m: unknown) => Promise<void> }).onEvent(m);

  // Lo encolado, sin esperar a la ventana de agrupacion de 4 s.
  const lineas = (): string[] => {
    const pending = (service as unknown as { pending: Map<string, { lines: string[] }> }).pending;
    return [...pending.values()].flatMap((b) => b.lines);
  };

  return { service, onEvent, lineas, leases };
}

const deLaApi = (extra: Record<string, unknown> = {}) => ({
  userId: 'u-1',
  botId: 'bot-1',
  type: 'ADMIN_COMMAND',
  origin: 'api-7',
  ts: 1_700_000_000_000,
  data: { severity: 'WARN', message: 'Soporte ha pausado tu bot: revision de riesgo.' },
  ...extra,
});

describe('NotifierService — entrega forzada (spec 046)', () => {
  it('un evento de la API con entrega forzada llega al dueño', async () => {
    const { onEvent, lineas } = buildEntrega();

    await onEvent(deLaApi({ entregaForzada: true }));

    expect(lineas()).toHaveLength(1);
    expect(lineas()[0]).toContain('Soporte ha pausado tu bot');
  });

  it('sin la marca se sigue descartando por origen ajeno', async () => {
    // El camino de alto volumen no cambia de conducta: es lo que impide que N
    // workers manden N veces el mismo fill.
    const { onEvent, lineas } = buildEntrega();

    await onEvent(deLaApi());

    expect(lineas()).toHaveLength(0);
  });

  it('con la marca, solo entrega la replica que gana el cerrojo', async () => {
    // La segunda replica recibe el mismo mensaje del bus y pide el mismo
    // cerrojo; al no concederselo, no encola nada. Sin esto, la escotilla
    // convertiria un aviso en tantos como replicas haya.
    const { onEvent, lineas } = buildEntrega({}, false);

    await onEvent(deLaApi({ entregaForzada: true }));

    expect(lineas()).toHaveLength(0);
  });

  it('el cerrojo es el mismo en todas las replicas', async () => {
    // La clave la componen datos del MENSAJE —no del proceso—, y el `ts` lo
    // pone quien publica: por eso dos replicas compiten por la misma clave.
    const { onEvent, leases } = buildEntrega();

    await onEvent(deLaApi({ entregaForzada: true }));

    expect(leases.tryLock).toHaveBeenCalledWith(
      'notify:bot-1:ADMIN_COMMAND:1700000000000',
      expect.any(Number),
    );
  });

  it('la preferencia manda: con los avisos de riesgo apagados no se entrega', async () => {
    // Tener entrada propia en `EVENT_PREF` saca a `ADMIN_COMMAND` de la via
    // generica, que dependia de que el publicador mandara la severidad.
    const { onEvent, lineas } = buildEntrega({ risk: false });

    await onEvent(deLaApi({ entregaForzada: true }));

    expect(lineas()).toHaveLength(0);
  });

  it('un evento del propio worker no pide cerrojo', async () => {
    // El camino normal no paga una ida y vuelta a Redis por cada fill.
    const { onEvent, lineas, leases } = buildEntrega();

    await onEvent({
      userId: 'u-1',
      botId: 'bot-1',
      type: 'CYCLE_CLOSED',
      origin: 'worker-1',
      ts: 1,
      data: { severity: 'INFO', message: 'Ciclo #1 cerrado.' },
    });

    expect(lineas()).toHaveLength(1);
    expect(leases.tryLock).not.toHaveBeenCalled();
  });
});
