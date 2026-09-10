import { BotsService } from './bots.service';

/**
 * QUIEN pide un comando, cuando no es el dueño del bot (spec 033).
 *
 * La consola de administracion manda comandos de contencion sobre bots ajenos.
 * Eso obliga a separar dos cosas que hasta ahora eran la misma: el DUEÑO, que
 * es quien sigue teniendo que pasar por `mustOwn`, y el SOLICITANTE, que es lo
 * que la fila de `bot_commands` tiene que decir para que una investigacion
 * posterior sirva de algo.
 *
 * La mitad de este fichero es regresion del camino de siempre: el parametro
 * nuevo es opcional y NO puede haber cambiado nada de lo que ve un usuario
 * mandando un comando a su propio bot.
 */

const BOT_ID = '33333333-3333-3333-3333-333333333333';
const OWNER = 'duena-del-bot';
const ADMIN = 'la-administradora';

function build() {
  const bot = {
    id: BOT_ID,
    user_id: OWNER,
    exchange_account_id: '11111111-1111-1111-1111-111111111111',
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    status: 'RUNNING',
    strategy: 'GRID_CLASSIC',
    margin_mode: 'ISOLATED',
    dry_run: false,
    config_version: 1,
  };
  const db = {
    bot: { findFirst: jest.fn().mockResolvedValue(bot) },
    botCommand: { create: jest.fn((a: unknown) => a) },
    botEvent: { create: jest.fn((a: unknown) => a) },
    $transaction: jest.fn().mockResolvedValue(undefined),
  };
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const service = new BotsService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    bus as never,
    {} as never,
    { budget: {} } as never,
  );
  return { service, db, bus };
}

/** Lo que se le pasó a `botCommand.create` / `botEvent.create` dentro de la transacción. */
const filaComando = (db: ReturnType<typeof build>['db']) =>
  (db.botCommand.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
const filaEvento = (db: ReturnType<typeof build>['db']) =>
  (db.botEvent.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;

describe('BotsService.command — el camino de siempre no se toca', () => {
  it('sin `requestedBy`, quien lo pide es el dueño', async () => {
    const { service, db } = build();

    await service.command(OWNER, BOT_ID, { command: 'PAUSE' } as never);

    expect(filaComando(db)).toMatchObject({ bot_id: BOT_ID, requested_by: OWNER });
  });

  /**
   * Carácter a carácter, y a propósito: este mensaje lo lee el usuario en la
   * bitácora de su bot. Cambiarlo «de paso» al añadir el caso del administrador
   * sería reescribirle el historial a todos los bots en marcha.
   */
  it('el evento del dueño conserva su severidad y su texto exactos', async () => {
    const { service, db } = build();

    await service.command(OWNER, BOT_ID, { command: 'PAUSE' } as never);

    expect(filaEvento(db)).toMatchObject({
      type: 'COMMAND_PAUSE',
      severity: 'INFO',
      message: 'Comando PAUSE solicitado.',
    });
  });
});

describe('BotsService.command — cuando lo pide un tercero', () => {
  it('la fila guarda al ADMINISTRADOR, no al dueño', async () => {
    const { service, db } = build();

    await service.command(OWNER, BOT_ID, { command: 'PAUSE' } as never, { requestedBy: ADMIN });

    // Poner aqui el id del dueño seria falsificar la trazabilidad justo en la
    // fila que existe para investigar quien toco que.
    expect(filaComando(db)).toMatchObject({ requested_by: ADMIN });
  });

  it('el evento sube a WARN y dice que vino de fuera', async () => {
    const { service, db } = build();

    await service.command(OWNER, BOT_ID, { command: 'PAUSE' } as never, { requestedBy: ADMIN });

    const evento = filaEvento(db);
    expect(evento).toMatchObject({ severity: 'WARN' });
    // El dueño tiene que poder ver en SU bitacora que alguien de fuera le toco
    // el bot, y cuando.
    expect(String(evento['message'])).toContain('soporte');
  });

  /**
   * `BusMessage.userId` está documentado como «el destinatario, lo único que
   * decide a quién se entrega». Iba el id del solicitante, que hasta ahora era
   * siempre el dueño y por eso nadie lo notó: el único consumidor de este canal
   * enruta por `botId`. Con la consola, solicitante y destinatario dejan de ser
   * la misma persona por primera vez, y el sobre tiene que decir la verdad.
   */
  it('el aviso del bus va dirigido al DUEÑO, no a quien lo pidio', async () => {
    const { service, bus } = build();

    await service.command(OWNER, BOT_ID, { command: 'PAUSE' } as never, { requestedBy: ADMIN });

    expect(bus.publish).toHaveBeenCalledTimes(1);
    const sobre = bus.publish.mock.calls[0][1] as { userId: string };
    expect(sobre.userId).toBe(OWNER);
    expect(sobre.userId).not.toBe(ADMIN);
  });
});
