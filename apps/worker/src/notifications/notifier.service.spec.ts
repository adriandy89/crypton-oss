import { NotifierService } from './notifier.service';
import { MAX_TEXTO, bienFormado, recortar, trocear } from './telegram-client';

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
  const enviados: { chatId: string; text: string; teclado: unknown }[] = [];
  (service as unknown as { client: { enabled: boolean; sendMessage: unknown } }).client = {
    enabled: true,
    sendMessage: async (chatId: string, text: string, teclado?: unknown) => {
      enviados.push({ chatId, text, teclado });
      return true;
    },
  };

  const onEvent = (m: Record<string, unknown>): Promise<void> =>
    (service as unknown as { onEvent: (m: unknown) => Promise<void> }).onEvent(m);

  // Lo encolado, sin esperar a la ventana de agrupacion de 4 s.
  const lineas = (): string[] => {
    const pending = (service as unknown as { pending: Map<string, { lines: string[] }> }).pending;
    return [...pending.values()].flatMap((b) => b.lines);
  };

  // Manda lo encolado del chat de la prueba, sin esperar a la ventana.
  const vaciar = (): Promise<void> =>
    (service as unknown as { flush: (chatId: string) => Promise<void> }).flush('111');

  // Las pausas entre trozos se cuentan, no se duermen.
  const esperas: number[] = [];
  (service as unknown as { esperar: (ms: number) => Promise<void> }).esperar = (ms) => {
    esperas.push(ms);
    return Promise.resolve();
  };

  return { service, onEvent, lineas, leases, enviados, vaciar, esperas };
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

  it('la caída del venue y su vuelta se entregan con los avisos de errores (spec 050)', async () => {
    // La vuelta es INFO: por la vía genérica, que exige WARN, no llegaba nunca, y
    // un aviso de caída sin su vuelta deja al usuario creyendo que sigue caído.
    const { onEvent, lineas } = buildEntrega();
    const delWorker = (type: string, severity: string) => ({
      userId: 'u-1',
      botId: 'bot-1',
      type,
      origin: 'worker-1',
      ts: 1,
      data: { severity, message: `HYPERLIQUID ${type}` },
    });

    await onEvent(delWorker('VENUE_UNAVAILABLE', 'WARN'));
    await onEvent(delWorker('VENUE_RECOVERED', 'INFO'));

    expect(lineas()).toHaveLength(2);
    expect(lineas()[0]).toContain('📡');
    expect(lineas()[1]).toContain('✅');
  });

  it('con los avisos de errores apagados no llega ni la caída ni la vuelta (spec 050)', async () => {
    const { onEvent, lineas } = buildEntrega({ errors: false });
    for (const [type, severity] of [
      ['VENUE_UNAVAILABLE', 'WARN'],
      ['VENUE_RECOVERED', 'INFO'],
    ]) {
      await onEvent({
        userId: 'u-1',
        botId: 'bot-1',
        type,
        origin: 'worker-1',
        ts: 1,
        data: { severity, message: 'x' },
      });
    }

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

/**
 * Mensajes que Telegram acepta (spec 054).
 *
 * Telegram rechaza entero un texto de más de 4096 caracteres, y el cliente solo
 * lo deja en el log. Mientras cada aviso era una frase, doce líneas cabían en un
 * mensaje; los avisos del supervisor listan ahora sus cambios, y un lote de doce
 * se perdía completo.
 */
const delSupervisor = (n: number, texto: string) => ({
  userId: 'u-1',
  botId: 'bot-1',
  type: 'AI_APPLIED',
  origin: 'api-7',
  ts: 1_700_000_000_000 + n,
  entregaForzada: true,
  data: { severity: 'WARN', message: texto },
});

/** ¿Termina el texto con una entidad HTML a medias? */
const entidadPartida = (texto: string): boolean => /&[a-z#0-9]*$/i.test(texto);

describe('NotifierService — mensajes que Telegram acepta (spec 054)', () => {
  it('doce avisos largos salen en varios mensajes, en orden y sin perder ninguno', async () => {
    const { onEvent, vaciar, enviados } = buildEntrega();
    for (let i = 0; i < 12; i++) {
      await onEvent(delSupervisor(i, `aviso ${String(i).padStart(2, '0')}: ${'x'.repeat(900)}`));
    }
    await vaciar();

    expect(enviados.length).toBeGreaterThan(1);
    for (const e of enviados) expect(e.text.length).toBeLessThanOrEqual(MAX_TEXTO);
    // Las doce, en el orden en que llegaron, y ninguna partida entre dos mensajes.
    const recibidas = enviados.flatMap((e) => e.text.split('\n'));
    expect(recibidas).toHaveLength(12);
    recibidas.forEach((l, i) => expect(l).toContain(`aviso ${String(i).padStart(2, '0')}: x`));
  });

  it('una linea que no cabe sale recortada sin partir una entidad', async () => {
    // Todo `&` se escapa a `&amp;`: con tres mil, el corte cae dentro de una.
    const { onEvent, vaciar, enviados } = buildEntrega();
    await onEvent(delSupervisor(0, '&'.repeat(3000)));
    await vaciar();

    expect(enviados).toHaveLength(1);
    const texto = enviados[0].text;
    expect(texto.length).toBeLessThanOrEqual(MAX_TEXTO);
    expect(texto.endsWith('…')).toBe(true);
    expect(entidadPartida(texto.slice(0, -1))).toBe(false);
    expect(texto.startsWith('🤖 <b>bot (BTC)</b> — &amp;')).toBe(true);
  });

  it('una sugerencia larga se manda recortada y con sus botones', async () => {
    // Va sola y al momento, fuera del lote: el recorte tiene que valer tambien ahi.
    const { onEvent, enviados, lineas } = buildEntrega();
    await onEvent({
      ...delSupervisor(0, `propone: ${'y'.repeat(9000)}`),
      type: 'AI_SUGGESTION',
      data: { severity: 'INFO', message: `propone: ${'y'.repeat(9000)}`, token: 'a'.repeat(32) },
    });

    expect(lineas()).toHaveLength(0);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].text.length).toBeLessThanOrEqual(MAX_TEXTO);
    expect(enviados[0].text.endsWith('…')).toBe(true);
    expect(enviados[0].teclado).toBeTruthy();
  });

  it('recortar no deja medio emoji ni una etiqueta abierta', () => {
    // Un emoji son dos unidades: cortando por la mitad queda un sustituto suelto.
    // Con dos letras delante, el corte a 85 unidades cae entre las dos del emoji.
    const emojis = recortar(`pp${'🤖'.repeat(3000)}`, 101);
    expect(emojis.length).toBeLessThanOrEqual(101);
    const antes = emojis.slice(0, emojis.indexOf('…'));
    const ultimo = antes.charCodeAt(antes.length - 1);
    expect(ultimo >= 0xd800 && ultimo <= 0xdbff).toBe(false);

    // El nombre del bot tan largo que el corte cae dentro de su `<b>`.
    const abierta = recortar(`<b>${'n'.repeat(500)}</b> — mensaje`, 101);
    expect(abierta.length).toBeLessThanOrEqual(101);
    expect(abierta.endsWith('…</b>')).toBe(true);

    // Y una etiqueta a medio escribir no se deja.
    const aMedias = recortar(`${'z'.repeat(83)}</b>${'r'.repeat(100)}`, 101);
    expect(aMedias).toBe(`${'z'.repeat(83)}…`);
  });

  it('entre dos trozos de un lote hay una pausa, y con uno solo no (spec 056, R-5)', async () => {
    // Una rafaga seguida al mismo chat es lo que Telegram corta con un 429, y el
    // cliente no reintenta: el trozo se perderia.
    const largo = buildEntrega();
    for (let i = 0; i < 12; i++) {
      await largo.onEvent(delSupervisor(i, `aviso ${i}: ${'x'.repeat(900)}`));
    }
    await largo.vaciar();
    expect(largo.esperas).toHaveLength(largo.enviados.length - 1);
    expect(largo.esperas.every((ms) => ms >= 1000)).toBe(true);

    const corto = buildEntrega();
    await corto.onEvent(delSupervisor(0, 'uno'));
    await corto.vaciar();
    expect(corto.esperas).toHaveLength(0);
  });

  it('los lotes de un chat salen en fila, aunque un envio tarde (spec 056, R-5)', async () => {
    const { service, onEvent, vaciar } = buildEntrega();
    const orden: string[] = [];
    let soltar: () => void = () => undefined;
    const primeroLento = new Promise<void>((r) => (soltar = r));
    let llamadas = 0;
    (service as unknown as { client: { sendMessage: unknown } }).client.sendMessage = async (
      _chat: string,
      texto: string,
    ) => {
      llamadas++;
      if (llamadas === 1) await primeroLento;
      orden.push(texto.includes('primero') ? 'primero' : 'segundo');
      return true;
    };

    await onEvent(delSupervisor(0, 'primero'));
    const uno = vaciar();
    await onEvent(delSupervisor(1, 'segundo'));
    const dos = vaciar();
    soltar();
    await Promise.all([uno, dos]);

    expect(orden).toEqual(['primero', 'segundo']);
  });

  it('un sustituto suelto no llega a Telegram (spec 056, R-7)', async () => {
    // No es UTF-8 valido: Telegram rechazaria el mensaje entero.
    const { onEvent, lineas } = buildEntrega();
    await onEvent(delSupervisor(0, `emoji partido: ${'🤖'.slice(0, 1)} y sigue`));
    const linea = lineas()[0];
    expect(linea).toContain('emoji partido: � y sigue');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(linea)).toBe(false);
    // Los emojis enteros, en cambio, se quedan como estan.
    expect(bienFormado('🤖 ok')).toBe('🤖 ok');
    expect(bienFormado(`a${'🤖'.slice(1)}b`)).toBe('a�b');
  });

  it('lo que cabe no se toca, y un lote corto sigue siendo un mensaje', () => {
    expect(recortar('corto')).toBe('corto');
    expect(recortar('x'.repeat(MAX_TEXTO))).toBe('x'.repeat(MAX_TEXTO));
    expect(trocear(['a', 'b', 'c'])).toEqual(['a\nb\nc']);
    expect(trocear([])).toEqual([]);
    // Justo en el limite: dos lineas que con su salto suman exactamente el maximo.
    const mil = 'm'.repeat(1000);
    expect(trocear([mil, mil], 2001)).toEqual([`${mil}\n${mil}`]);
    expect(trocear([mil, `${mil}m`], 2001)).toEqual([mil, `${mil}m`]);
  });
});
