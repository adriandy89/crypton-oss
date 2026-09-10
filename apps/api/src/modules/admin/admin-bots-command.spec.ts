import { ForbiddenException } from '@nestjs/common';
import { AdminBotsService } from './admin-bots.service';

/**
 * Lo que un administrador puede pedirle al bot de otra persona.
 *
 * Es el fichero que mas importa de este modulo. CRYPTON es no custodial: el
 * dinero esta en el exchange y la promesa es que nadie de la plataforma puede
 * disponer de el. Un comando que cierre posicion la rompe entera, asi que el
 * vocabulario recortado no es una preferencia de producto — es la invariante que
 * sostiene el resto.
 */

const BOT_ID = '44444444-4444-4444-4444-444444444444';
const OWNER = 'duena';
const ADMIN = { id: 'la-administradora' };

function build() {
  const db = {
    bot: { findUnique: jest.fn().mockResolvedValue({ user_id: OWNER }) },
  };
  const bots = { command: jest.fn().mockResolvedValue({ accepted: true, command: 'PAUSE' }) };
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const audit = { recordNow: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminBotsService(db as never, bots as never, bus as never, audit as never);
  return { service, db, bots, bus, audit };
}

const pedir = (command: string, reason = 'el bot lleva media hora en error') =>
  ({ command, reason }) as never;

describe('lo que un administrador SI puede pedir', () => {
  it.each(['PAUSE', 'STOP_KEEP_POSITION'])('%s se acepta', async (command) => {
    const { service, bots } = build();

    await service.command(ADMIN, BOT_ID, pedir(command));

    expect(bots.command).toHaveBeenCalledTimes(1);
  });

  it('delega con el DUEÑO como primer argumento, no con el administrador', async () => {
    const { service, bots } = build();

    await service.command(ADMIN, BOT_ID, pedir('PAUSE'));

    // Esto es lo que permite reutilizar `BotsService` sin relajar `mustOwn`: la
    // comprobacion de propiedad se sigue haciendo, y se sigue cumpliendo.
    const [userId, botId, dto, opts] = bots.command.mock.calls[0] as unknown[];
    expect(userId).toBe(OWNER);
    expect(botId).toBe(BOT_ID);
    expect(dto).toEqual({ command: 'PAUSE' });
    expect(opts).toEqual({ requestedBy: ADMIN.id });
  });

  it('deja la fila de bitacora con el bot, el dueño y el motivo', async () => {
    const { service, audit } = build();

    await service.command(ADMIN, BOT_ID, pedir('PAUSE', 'liquidacion inminente'));

    expect(audit.recordNow).toHaveBeenCalledTimes(1);
    expect(audit.recordNow.mock.calls[0][0]).toMatchObject({
      actor: 'ADMIN',
      actorId: ADMIN.id,
      // Sin `bot_id` no hay forma de cruzar esta fila con `bot_events`, que es
      // media investigacion.
      botId: BOT_ID,
      action: 'admin.bot.command',
      meta: { command: 'PAUSE', ownerId: OWNER, reason: 'liquidacion inminente' },
    });
  });

  it('avisa al dueño en directo, no cuando abra la pantalla', async () => {
    const { service, bus } = build();

    await service.command(ADMIN, BOT_ID, pedir('PAUSE'));

    const [canal, sobre] = bus.publish.mock.calls[0] as [string, { userId: string; type: string }];
    expect(canal).toBe('crypton:bot-events');
    expect(sobre.userId).toBe(OWNER);
    expect(sobre.type).toBe('ADMIN_COMMAND');
  });
});

describe('lo que un administrador NO puede pedir', () => {
  /**
   * Los once. Enumerados uno a uno y no generados a partir de una resta contra
   * `BOT_COMMANDS`: si mañana alguien añade un comando al enum, la resta lo
   * incluiria sola y este fichero seguiria en verde sin que nadie hubiese
   * decidido nada sobre el. Escritos a mano, el comando nuevo obliga a venir
   * aqui y elegir.
   */
  const PROHIBIDOS = [
    'STOP_AND_CLOSE', // cierra a mercado y realiza el resultado
    'CLOSE_NOW', // idem
    'PANIC', // idem, y cancela el stop
    'TAKE_PROFIT_NOW', // realiza
    'CANCEL_ALL_ORDERS', // retira el stop-loss nativo: deja la posicion desnuda
    'START', // abre riesgo
    'RESUME', // idem
    'REANCHOR_GRID', // vuelve a tender la escalera: margen nuevo
    'ADD_SAFETY_NOW', // margen nuevo
    'ADJUST_MARGIN', // mueve colateral del usuario
    'REPAIR', // toca la reconciliacion de un bot ajeno
  ];

  it.each(PROHIBIDOS)('%s se rechaza y no llega a encolarse', async (command) => {
    const { service, bots, bus, audit } = build();

    const err: unknown = await service.command(ADMIN, BOT_ID, pedir(command)).catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(bots.command).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(audit.recordNow).not.toHaveBeenCalled();
  });

  it('un bot que no existe es 404, no un comando al vacio', async () => {
    const { service, db, bots } = build();
    db.bot.findUnique.mockResolvedValue(null);

    await expect(service.command(ADMIN, BOT_ID, pedir('PAUSE'))).rejects.toThrow(
      'Bot no encontrado.',
    );
    expect(bots.command).not.toHaveBeenCalled();
  });
});
