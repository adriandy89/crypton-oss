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
    aiDeskAgent: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ name: 'Tendencias', exchange_account: { paper: false } }),
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

  return { service, onEvent, lineas, leases, enviados, vaciar, esperas, db };
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

/**
 * Los avisos del canal con IA (spec 059, CA-5). La entrada va sola y con su
 * botón de pausa; la salida sustituye al ciclo cerrado; lo que pone en juego la
 * posición no depende de la preferencia de errores; y la decisión de la IA no
 * sale de la línea de tiempo.
 */
describe('NotifierService — el canal con IA (spec 059)', () => {
  const VALE = '0123456789abcdef0123456789abcdef';
  const delWorker = (type: string, severity: string, extra: Record<string, unknown> = {}) => ({
    userId: 'u-1',
    botId: 'bot-1',
    type,
    origin: 'worker-1',
    ts: 1,
    data: { severity, message: `${type} de prueba`, ...extra },
  });

  it('la entrada sale sola, al momento y con el botón de pausa', async () => {
    const { onEvent, enviados, lineas } = buildEntrega();
    await onEvent(delWorker('AI_ENTRY', 'INFO', { vale: VALE, intentId: 'ia-1' }));

    expect(lineas()).toEqual([]);
    expect(enviados).toEqual([
      {
        chatId: '111',
        text: '📥 <b>bot (BTC)</b> — AI_ENTRY de prueba',
        teclado: {
          inline_keyboard: [[{ text: '⏸ Pausar el bot', callback_data: `ic:${VALE}:pausa` }]],
        },
      },
    ]);
    // Cabe en los 64 bytes de `callback_data`.
    const boton = (enviados[0].teclado as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0][0].callback_data;
    expect(boton.length).toBeLessThanOrEqual(64);
  });

  it('sin un vale válido, la entrada va al lote sin botón', async () => {
    for (const vale of [undefined, '', 'corto', VALE.toUpperCase(), `${VALE}:x`]) {
      const { onEvent, enviados, lineas } = buildEntrega();
      await onEvent(delWorker('AI_ENTRY', 'INFO', { vale }));
      expect(enviados).toEqual([]);
      expect(lineas()).toEqual(['📥 <b>bot (BTC)</b> — AI_ENTRY de prueba']);
    }
  });

  it('entrada y salida van con los ciclos: se apagan con ellos', async () => {
    const conCiclos = buildEntrega();
    await conCiclos.onEvent(delWorker('AI_EXIT', 'INFO'));
    expect(conCiclos.lineas()).toEqual(['📤 <b>bot (BTC)</b> — AI_EXIT de prueba']);

    const sinCiclos = buildEntrega({ cycles: false });
    await sinCiclos.onEvent(delWorker('AI_EXIT', 'INFO'));
    await sinCiclos.onEvent(delWorker('AI_ENTRY', 'INFO', { vale: VALE }));
    expect(sinCiclos.lineas()).toEqual([]);
    expect(sinCiclos.enviados).toEqual([]);
  });

  it('lo que pone en juego la posición va con los avisos de riesgo, no con los de errores', async () => {
    const tipos: [string, string, string][] = [
      ['AI_DAY_STOP', 'WARN', '⛔'],
      ['SIN_STOP', 'CRITICAL', '🔥'],
      ['AI_CIERRE_FALLIDO', 'CRITICAL', '🔥'],
      ['AI_POSICION_HUERFANA', 'CRITICAL', '🔥'],
    ];
    const sinErrores = buildEntrega({ errors: false });
    for (const [tipo, severidad] of tipos) await sinErrores.onEvent(delWorker(tipo, severidad));
    const lineas = sinErrores.lineas();
    expect(lineas).toHaveLength(tipos.length);
    tipos.forEach(([, , icono], i) => expect(lineas[i].startsWith(`${icono} <b>`)).toBe(true));

    const sinRiesgo = buildEntrega({ risk: false });
    for (const [tipo, severidad] of tipos) await sinRiesgo.onEvent(delWorker(tipo, severidad));
    expect(sinRiesgo.lineas()).toEqual([]);
  });

  it('una entrada descartada avisa si es grave; una IOC sin llenar, no', async () => {
    const { onEvent, lineas } = buildEntrega();
    await onEvent(delWorker('AI_ENTRY_DISCARDED', 'INFO'));
    expect(lineas()).toEqual([]);
    await onEvent(delWorker('AI_ENTRY_DISCARDED', 'WARN'));
    expect(lineas()).toEqual(['↩️ <b>bot (BTC)</b> — AI_ENTRY_DISCARDED de prueba']);

    const sinErrores = buildEntrega({ errors: false });
    await sinErrores.onEvent(delWorker('AI_ENTRY_DISCARDED', 'WARN'));
    expect(sinErrores.lineas()).toEqual([]);
  });

  it('la decisión de la IA y la orden de salir no se notifican', async () => {
    const { onEvent, lineas, enviados } = buildEntrega();
    await onEvent(delWorker('AI_DECISION', 'INFO'));
    await onEvent(delWorker('AI_CIERRE', 'INFO'));
    // Ni aunque llegue de la API con entrega forzada.
    await onEvent({
      ...deLaApi({ entregaForzada: true }),
      type: 'AI_DECISION',
      data: { severity: 'INFO', message: 'x' },
    });
    expect(lineas()).toEqual([]);
    expect(enviados).toEqual([]);
  });

  it('el fallo de la IA del canal llega de la API y va con los errores', async () => {
    const { onEvent, lineas } = buildEntrega();
    await onEvent({
      ...deLaApi({ entregaForzada: true }),
      type: 'AI_FAILED',
      data: { severity: 'WARN', message: 'La IA del canal no ha dado una respuesta válida.' },
    });
    expect(lineas()).toEqual([
      '🤖 <b>bot (BTC)</b> — La IA del canal no ha dado una respuesta válida.',
    ]);
  });
});

/**
 * Los avisos de los agentes de IA (spec 074). Los del agente nacen en la API y
 * no tienen bot; los de sus operaciones los publica el bot `AGENT_TRADE`, como
 * cualquier otro. Las propuestas y las acciones que esperan respuesta llevan
 * botones con su vale; lo que se aplicó solo va al lote.
 */
describe('NotifierService — los agentes de IA (spec 074)', () => {
  const VALE = 'fedcba9876543210fedcba9876543210';
  const delAgente = (
    type: string,
    extra: Record<string, unknown> = {},
    ts = 1_700_000_000_000,
  ) => ({
    userId: 'u-1',
    type,
    origin: 'api-7',
    entregaForzada: true,
    ts,
    data: { severity: 'INFO', message: `${type} de prueba`, agentId: 'ag-1', ...extra },
  });
  const deSuBot = (type: string, severity = 'INFO') => ({
    userId: 'u-1',
    botId: 'bot-1',
    type,
    origin: 'worker-1',
    ts: 1,
    data: { severity, message: `${type} de prueba` },
  });
  const callbacks = (teclado: unknown): string[] =>
    (teclado as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
      .flat()
      .map((b) => b.callback_data);

  it('una propuesta sale sola, al momento, con su agente y los botones de ejecutar o descartar', async () => {
    const { onEvent, enviados, lineas } = buildEntrega();
    await onEvent(delAgente('AGENT_PROPOSAL', { propuestaId: 'p-1', vale: VALE }));

    expect(lineas()).toEqual([]);
    expect(enviados).toEqual([
      {
        chatId: '111',
        text: '💡 <b>Agente «Tendencias»</b> — AGENT_PROPOSAL de prueba',
        teclado: {
          inline_keyboard: [
            [
              { text: '✅ Ejecutar', callback_data: `ag:${VALE}:si` },
              { text: '✖ Descartar', callback_data: `ag:${VALE}:no` },
            ],
          ],
        },
      },
    ]);
  });

  it('en la cuenta de simulación, la etiqueta lo dice', async () => {
    const { onEvent, enviados, db } = buildEntrega();
    db.aiDeskAgent.findUnique.mockResolvedValue({
      name: 'Pruebas',
      exchange_account: { paper: true },
    });
    await onEvent(delAgente('AGENT_PROPOSAL', { propuestaId: 'p-1', vale: VALE }));
    expect(enviados[0].text).toContain('<b>Agente «Pruebas» · simulado</b>');
  });

  it('una acción que espera respuesta: aplicarla, descartarla o cerrar la operación', async () => {
    const { onEvent, enviados } = buildEntrega();
    await onEvent(
      delAgente('AGENT_ACTION', {
        propuestaId: 'p-1',
        accionId: 'a-1',
        vale: VALE,
        accion: 'REDUCIR_MITAD',
      }),
    );
    expect(enviados[0].text.startsWith('🛡 <b>Agente «Tendencias»</b>')).toBe(true);
    expect(callbacks(enviados[0].teclado)).toEqual([
      `ag:${VALE}:si`,
      `ag:${VALE}:no`,
      `ag:${VALE}:cierra`,
    ]);
    for (const data of callbacks(enviados[0].teclado)) expect(data.length).toBeLessThanOrEqual(64);
  });

  it('si lo que propone es cerrar, se cierra o se mantiene', async () => {
    const { onEvent, enviados } = buildEntrega();
    await onEvent(
      delAgente('AGENT_ACTION', {
        propuestaId: 'p-1',
        accionId: 'a-1',
        vale: VALE,
        accion: 'CERRAR',
      }),
    );
    const teclado = enviados[0].teclado as { inline_keyboard: { text: string }[][] };
    expect(teclado.inline_keyboard).toHaveLength(1);
    expect(teclado.inline_keyboard[0].map((b) => b.text)).toEqual(['⏹ Cerrar', '✖ Mantener']);
    expect(callbacks(teclado)).toEqual([`ag:${VALE}:si`, `ag:${VALE}:no`]);
  });

  it('lo que se aplicó solo, sin vale, va al lote sin botones', async () => {
    const { onEvent, enviados, lineas } = buildEntrega();
    await onEvent(
      delAgente('AGENT_ACTION', { propuestaId: 'p-1', accionId: 'a-1', accion: 'PROTEGER' }),
    );
    expect(enviados).toEqual([]);
    expect(lineas()).toEqual(['🛡 <b>Agente «Tendencias»</b> — AGENT_ACTION de prueba']);
  });

  it('sin agente en los datos, lo que no tiene bot no se entrega', async () => {
    const { onEvent, enviados, lineas } = buildEntrega();
    // La pulsación de un botón va del poller a la API, no a Telegram.
    await onEvent({
      userId: 'u-1',
      type: 'AGENT_DECISION_TAKEN',
      origin: 'worker-1',
      ts: 1,
      data: { vale: VALE, verbo: 'si', chatId: '111' },
    });
    // Ni un evento de otra cosa sin bot, aunque traiga un agente.
    await onEvent({ ...delAgente('AI_SUGGESTION'), data: { agentId: 'ag-1', message: 'x' } });
    expect(enviados).toEqual([]);
    expect(lineas()).toEqual([]);
  });

  it('dos propuestas del mismo agente en el mismo milisegundo piden cerrojos distintos', async () => {
    const { onEvent, leases, enviados } = buildEntrega();
    await onEvent(delAgente('AGENT_PROPOSAL', { propuestaId: 'p-1', vale: VALE }));
    await onEvent(
      delAgente('AGENT_PROPOSAL', { propuestaId: 'p-2', vale: VALE.replace('f', 'e') }),
    );

    expect(leases.tryLock.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'notify:ag:ag-1:p-1:AGENT_PROPOSAL:1700000000000',
      'notify:ag:ag-1:p-2:AGENT_PROPOSAL:1700000000000',
    ]);
    expect(enviados).toHaveLength(2);
  });

  it('la acción reparte por acción, no por operación', async () => {
    const { onEvent, leases } = buildEntrega();
    await onEvent(delAgente('AGENT_ACTION', { propuestaId: 'p-1', accionId: 'a-9', vale: VALE }));
    expect(leases.tryLock).toHaveBeenCalledWith(
      'notify:ag:ag-1:a-9:AGENT_ACTION:1700000000000',
      expect.any(Number),
    );
  });

  it('el segundo mensaje con botones espera su pausa detrás del primero', async () => {
    // Dos propuestas de la misma ronda seguidas eran la ráfaga que Telegram
    // corta con un 429.
    const { onEvent, enviados, esperas } = buildEntrega();
    await onEvent(delAgente('AGENT_PROPOSAL', { propuestaId: 'p-1', vale: VALE }));
    expect(esperas).toEqual([]);
    await onEvent(delAgente('AGENT_PROPOSAL', { propuestaId: 'p-2', vale: VALE }));
    expect(enviados).toHaveLength(2);
    expect(esperas).toHaveLength(1);
    expect(esperas[0]).toBeGreaterThanOrEqual(1000);
  });

  it('y un lote detrás de un mensaje con botones, también', async () => {
    const { onEvent, vaciar, enviados, esperas } = buildEntrega();
    await onEvent(delAgente('AGENT_PROPOSAL', { propuestaId: 'p-1', vale: VALE }));
    await onEvent(deSuBot('AGENT_EXIT'));
    await vaciar();
    expect(enviados).toHaveLength(2);
    expect(esperas).toHaveLength(1);
  });

  it('la preferencia de agentes manda en lo suyo; lo que pone en juego una posición, riesgo', async () => {
    const sinAgentes = buildEntrega({ agentes: false });
    await sinAgentes.onEvent(delAgente('AGENT_PROPOSAL', { propuestaId: 'p-1', vale: VALE }));
    await sinAgentes.onEvent(deSuBot('AGENT_ENTRY'));
    await sinAgentes.onEvent(deSuBot('AGENT_EXIT'));
    await sinAgentes.onEvent(deSuBot('AGENT_CIERRE_FALLIDO', 'CRITICAL'));
    await sinAgentes.onEvent(delAgente('AGENT_PAUSED', { severity: 'WARN' }));
    expect(sinAgentes.enviados).toEqual([]);
    expect(sinAgentes.lineas()).toEqual([
      '🔥 <b>bot (BTC)</b> — AGENT_CIERRE_FALLIDO de prueba',
      '⛔ <b>Agente «Tendencias»</b> — AGENT_PAUSED de prueba',
    ]);

    const sinRiesgo = buildEntrega({ risk: false });
    await sinRiesgo.onEvent(deSuBot('AGENT_CIERRE_FALLIDO', 'CRITICAL'));
    await sinRiesgo.onEvent(deSuBot('AGENT_FOREIGN_POSITION', 'CRITICAL'));
    await sinRiesgo.onEvent(delAgente('AGENT_PAUSED', { severity: 'WARN' }));
    expect(sinRiesgo.lineas()).toEqual([]);
  });

  it('la vida de la operación va con los agentes, no con los ciclos', async () => {
    const sinCiclos = buildEntrega({ cycles: false });
    for (const tipo of ['AGENT_ENTRY', 'AGENT_EXIT', 'AGENT_BREAKEVEN', 'AGENT_REDUCED']) {
      await sinCiclos.onEvent(deSuBot(tipo));
    }
    expect(sinCiclos.lineas()).toEqual([
      '📥 <b>bot (BTC)</b> — AGENT_ENTRY de prueba',
      '📤 <b>bot (BTC)</b> — AGENT_EXIT de prueba',
      '🛡 <b>bot (BTC)</b> — AGENT_BREAKEVEN de prueba',
      '✂️ <b>bot (BTC)</b> — AGENT_REDUCED de prueba',
    ]);
  });

  it('la orden de salir no se notifica, y una entrada descartada solo si es grave', async () => {
    const { onEvent, lineas } = buildEntrega();
    await onEvent(deSuBot('AGENT_CIERRE'));
    await onEvent(deSuBot('AGENT_ENTRY_DISCARDED', 'INFO'));
    expect(lineas()).toEqual([]);
    await onEvent(deSuBot('AGENT_ENTRY_DISCARDED', 'WARN'));
    expect(lineas()).toEqual(['↩️ <b>bot (BTC)</b> — AGENT_ENTRY_DISCARDED de prueba']);
  });

  it('el agente dormido y el stop que no se ensancha van con los errores', async () => {
    const sinErrores = buildEntrega({ errors: false });
    await sinErrores.onEvent(delAgente('AGENT_SLEEPING', { severity: 'WARN' }));
    await sinErrores.onEvent(deSuBot('AGENT_STOP_IGNORED', 'WARN'));
    expect(sinErrores.lineas()).toEqual([]);

    const conErrores = buildEntrega();
    await conErrores.onEvent(delAgente('AGENT_SLEEPING', { severity: 'WARN' }));
    expect(conErrores.lineas()).toEqual([
      '💤 <b>Agente «Tendencias»</b> — AGENT_SLEEPING de prueba',
    ]);
  });
});

describe('NotifierService — los agentes en el resumen diario (spec 074)', () => {
  function buildResumen(opciones: {
    prefs?: Record<string, boolean>;
    conAgentes?: boolean;
    bots?: BotFila[];
    agentesFallan?: boolean;
  }) {
    const { service, enviados, db } = build([], opciones.bots ?? []);
    db.telegramLink.findMany.mockResolvedValue([
      { user_id: 'u-1', chat_id: '111', prefs: opciones.prefs ?? {}, verified_at: new Date() },
    ]);
    const propuestas = jest
      .fn()
      .mockResolvedValueOnce([
        { state: 'CERRADA', dry_run: false },
        { state: 'RECHAZADA', dry_run: false },
        { state: 'SOMBRA', dry_run: false },
      ])
      .mockResolvedValueOnce([{ realized_pnl: '12.4', r_real: '1.3', dry_run: false }])
      .mockResolvedValueOnce([]);
    const agentes = opciones.agentesFallan
      ? jest.fn().mockRejectedValue(new Error('base caída'))
      : jest.fn().mockResolvedValue(opciones.conAgentes === false ? [] : [{ user_id: 'u-1' }]);
    Object.assign(db, {
      aiDeskAgent: { findMany: agentes },
      aiDeskProposal: { findMany: propuestas },
    });
    return { service, enviados, propuestas };
  }

  it('con agentes y sin bots, el resumen es el de los agentes', async () => {
    const { service, enviados } = buildResumen({});
    await service.dailyDigest();
    expect(enviados).toHaveLength(1);
    expect(enviados[0].text).toBe(
      [
        '<b>Resumen del día</b>',
        '<b>Agentes</b>',
        'Propuestas: 2 · operadas 1',
        'Cerradas: 1 · <b>+12.40 (+1.30 R)</b>',
      ].join('\n'),
    );
  });

  it('con bots, los agentes van detrás', async () => {
    const { service, enviados } = buildResumen({ bots: [{ status: 'RUNNING', dry_run: false }] });
    await service.dailyDigest();
    const lineas = enviados[0].text.split('\n');
    expect(lineas[1]).toMatch(/^Resultado:/);
    expect(lineas.indexOf('<b>Agentes</b>')).toBeGreaterThan(
      lineas.indexOf('Bots: 1 operando · 0 pausados'),
    );
  });

  it('quien apagó los avisos de agentes no los tiene en el resumen, ni se consultan', async () => {
    const { service, enviados, propuestas } = buildResumen({ prefs: { agentes: false } });
    await service.dailyDigest();
    expect(enviados).toEqual([]);
    expect(propuestas).not.toHaveBeenCalled();
  });

  it('sin agentes no se preguntan sus propuestas', async () => {
    const { service, propuestas } = buildResumen({
      conAgentes: false,
      bots: [{ status: 'RUNNING', dry_run: false }],
    });
    await service.dailyDigest();
    expect(propuestas).not.toHaveBeenCalled();
  });

  it('si fallan los agentes, el resumen sale igual sin ellos', async () => {
    const { service, enviados } = buildResumen({
      agentesFallan: true,
      bots: [{ status: 'RUNNING', dry_run: false }],
    });
    await service.dailyDigest();
    expect(enviados).toHaveLength(1);
    expect(enviados[0].text).not.toContain('Agentes');
  });
});
