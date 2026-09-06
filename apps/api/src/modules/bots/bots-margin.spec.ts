import { ConflictException } from '@nestjs/common';
import { BotsService } from './bots.service';

/**
 * Ajuste de margen de una posición aislada, por la parte que decide la API.
 *
 * Lo que se comprueba aquí es lo que NO puede llegar al venue: un ajuste sobre
 * un bot en cruzado —donde la operación ni siquiera existe—, un importe que la
 * cuenta no tiene, o una retirada sin confirmar. Cada uno de esos, si pasara,
 * se convertiría en un `COMMAND_FAILED` en la bitácora medio minuto después y
 * con el vocabulario del venue en lugar de un motivo legible al instante.
 *
 * Y una que importa tanto como las anteriores: que el interruptor de
 * contabilidad NO se confunda con la transferencia. Subir `totalInvestment` no
 * mueve la liquidación; encolar el comando sí. Son dos efectos y el test los
 * mira por separado.
 */

const BOT_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'u1';

function build(botOver: Record<string, unknown> = {}, available: string | null = '1000') {
  const bot = {
    id: BOT_ID,
    user_id: USER_ID,
    exchange_account_id: ACCOUNT_ID,
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    status: 'RUNNING',
    margin_mode: 'ISOLATED',
    dry_run: false,
    config_version: 1,
    ...botOver,
  };

  const db = {
    bot: {
      findFirst: jest.fn().mockResolvedValue(bot),
      findUnique: jest.fn().mockResolvedValue({ testnet: false }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(bot),
    },
    botCommand: {
      create: jest.fn((a: unknown) => a),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    botEvent: { create: jest.fn((a: unknown) => a) },
    botConfigRevision: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ config: { totalInvestment: '500', leverage: 3 } }),
    },
    exchangeAccount: {
      findUnique: jest.fn().mockResolvedValue({ testnet: false, paper: false }),
      // `fetchWallet` pregunta primero si la conexion es de SIMULACION: si lo
      // es, el saldo se lee de la base y no se sale a la red. Aqui no lo es, y
      // por eso la prueba sigue viendo el saldo del adaptador.
      findFirst: jest.fn().mockResolvedValue({
        id: ACCOUNT_ID,
        venue: 'HYPERLIQUID',
        paper: false,
        paper_balance: null,
      }),
    },
    $transaction: jest.fn().mockResolvedValue(undefined),
  };

  const adapter = {
    getBalances: jest
      .fn()
      .mockResolvedValue([{ asset: 'USDC', total: available, available, used: '0' }]),
    getPositions: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue(undefined),
  };

  const cache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const bus = { publish: jest.fn().mockResolvedValue(undefined) };

  const service = new BotsService(
    db as never,
    {} as never,
    { openAdapter: jest.fn().mockResolvedValue(adapter) } as never,
    {} as never,
    bus as never,
    cache as never,
    { budget: {} } as never,
  );

  return { service, db, bus };
}

/** Igual que `build`, pero el venue no responde al saldo. */
function buildVenueCaido() {
  const b = build();
  jest.spyOn(b.service as never, 'fetchWallet').mockRejectedValue(new Error('venue caido'));
  return b;
}

const ajuste = (over: Record<string, unknown> = {}) =>
  ({
    command: 'ADJUST_MARGIN',
    marginAmount: '100',
    marginAction: 'ADD',
    ...over,
  }) as never;

describe('BotsService.command — ADJUST_MARGIN', () => {
  it('encola el comando con el importe y el sentido en el payload', async () => {
    // Sin payload el comando no significa nada: «ajusta el margen» a secas no
    // dice ni cuánto ni en qué dirección.
    const { service, db } = build();

    const res = await service.command(USER_ID, BOT_ID, ajuste());

    expect(res).toMatchObject({ accepted: true, command: 'ADJUST_MARGIN' });
    expect(db.botCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          command: 'ADJUST_MARGIN',
          payload: { amount: '100', action: 'ADD', countAsBotCapital: false },
        }),
      }),
    );
  });

  it('rechaza el bot en margen CRUZADO', async () => {
    // En cruzado el colateral es el de toda la cuenta: no hay caja por posición
    // que engordar, y el venue lo diría con su propio vocabulario.
    const { service, db } = build({ margin_mode: 'CROSS' });

    await expect(service.command(USER_ID, BOT_ID, ajuste())).rejects.toThrow(ConflictException);
    expect(db.botCommand.create).not.toHaveBeenCalled();
  });

  it('rechaza aportar más margen del libre que hay', async () => {
    const { service } = build({}, '50');

    await expect(service.command(USER_ID, BOT_ID, ajuste({ marginAmount: '100' }))).rejects.toThrow(
      /No tienes tanto margen libre/i,
    );
  });

  it('un saldo de CERO sigue rechazando: es un cero legítimo', async () => {
    // Aster filtra los saldos a cero y devuelve `[]`; eso es no tener dinero,
    // no un fallo de lectura, y ahí el aporte no puede salir.
    const { service } = build({}, null);

    await expect(service.command(USER_ID, BOT_ID, ajuste({ marginAmount: '100' }))).rejects.toThrow(
      /No tienes tanto margen libre/i,
    );
  });

  it('si el venue NO CONTESTA, no bloquea el aporte', async () => {
    // Negar la defensa de una posición porque una lectura de saldo falló es
    // peor que dejar que el venue rechace la transferencia con la cifra de
    // verdad delante.
    const { service, db } = buildVenueCaido();

    await service.command(USER_ID, BOT_ID, ajuste({ marginAmount: '100' }));

    expect(db.botCommand.create).toHaveBeenCalled();
  });

  it('retirar exige confirmación: ACERCA la liquidación', async () => {
    const { service, db } = build();

    await expect(
      service.command(USER_ID, BOT_ID, ajuste({ marginAction: 'REMOVE' })),
    ).rejects.toThrow(ConflictException);
    expect(db.botCommand.create).not.toHaveBeenCalled();
  });

  it('retirar con confirmación pasa, y sin comprobar el saldo libre', async () => {
    // Quien sabe si la retirada rompe el margen de mantenimiento es el venue.
    const { service, db } = build({}, '0');

    await service.command(USER_ID, BOT_ID, ajuste({ marginAction: 'REMOVE', confirm: true }));

    expect(db.botCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: { amount: '100', action: 'REMOVE', countAsBotCapital: false },
        }),
      }),
    );
  });

  it('sin importe o sin sentido no se encola nada', async () => {
    const { service } = build();

    await expect(
      service.command(USER_ID, BOT_ID, { command: 'ADJUST_MARGIN' } as never),
    ).rejects.toThrow(/Indica el importe/i);
  });

  it('el interruptor apagado NO toca el capital asignado', async () => {
    // Es la mitad del contrato que la pantalla promete: el aporte solo mueve la
    // liquidación, y el ROI se sigue calculando sobre el capital de antes.
    const { service } = build();
    const subir = jest.spyOn(service, 'updateConfig').mockResolvedValue({} as never);

    await service.command(USER_ID, BOT_ID, ajuste({ countAsBotCapital: false }));

    expect(subir).not.toHaveBeenCalled();
  });

  it('el interruptor encendido viaja en el comando y NO toca el capital al encolar', async () => {
    // Spec 011 (F-34): el capital sube cuando el margen HA LLEGADO, con el acuse
    // del worker. Al encolar solo se anota la intencion en el propio comando.
    // Antes se subia aqui mismo, y como la transferencia fallaba siempre, el bot
    // se quedaba con un capital que nunca existio.
    const { service, db } = build();
    const subir = jest.spyOn(service, 'updateConfig').mockResolvedValue({} as never);

    await service.command(USER_ID, BOT_ID, ajuste({ countAsBotCapital: true }));

    expect(subir).not.toHaveBeenCalled();
    expect(db.botCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: { amount: '100', action: 'ADD', countAsBotCapital: true },
        }),
      }),
    );
  });

  it('retirar nunca sube el capital asignado, aunque lo pidan', async () => {
    // Sería contabilizar como aportación un dinero que acaba de salir.
    const { service } = build();
    const subir = jest.spyOn(service, 'updateConfig').mockResolvedValue({} as never);

    await service.command(
      USER_ID,
      BOT_ID,
      ajuste({
        marginAction: 'REMOVE',
        confirm: true,
        countAsBotCapital: true,
      }),
    );

    expect(subir).not.toHaveBeenCalled();
  });

  it('un bot parado no atiende el comando', async () => {
    const { service } = build({ status: 'STOPPED' });

    await expect(service.command(USER_ID, BOT_ID, ajuste())).rejects.toThrow(
      /no atiende comandos/i,
    );
  });
});

describe('BotsService.onWorkerEvent — el capital sube con el acuse del worker', () => {
  const acuse = (over: Record<string, unknown> = {}) =>
    ({
      channel: 'crypton:bot-events',
      userId: USER_ID,
      botId: BOT_ID,
      type: 'MARGIN_ADJUSTED',
      ts: 1,
      data: { severity: 'INFO', message: 'x', amount: '100', action: 'ADD', commandId: '7' },
      ...over,
    }) as never;
  const fila = (countAsBotCapital: boolean) => ({
    id: 7n,
    bot_id: BOT_ID,
    command: 'ADJUST_MARGIN',
    payload: { amount: '100', action: 'ADD', countAsBotCapital },
    bot: { user_id: USER_ID },
  });

  it('MARGIN_ADJUSTED de un comando con el interruptor encendido suma el aporte', async () => {
    const { service, db } = build();
    db.botCommand.findUnique.mockResolvedValue(fila(true));
    db.botCommand.updateMany.mockResolvedValue({ count: 1 });
    const subir = jest.spyOn(service, 'updateConfig').mockResolvedValue({} as never);

    await service.onWorkerEvent(acuse());

    expect(subir).toHaveBeenCalledWith(
      USER_ID,
      BOT_ID,
      expect.objectContaining({
        acceptRelayout: true,
        config: expect.objectContaining({ totalInvestment: '600' }),
      }),
    );
  });

  it('con el interruptor apagado no toca el capital', async () => {
    const { service, db } = build();
    db.botCommand.findUnique.mockResolvedValue(fila(false));
    const subir = jest.spyOn(service, 'updateConfig').mockResolvedValue({} as never);

    await service.onWorkerEvent(acuse());

    expect(subir).not.toHaveBeenCalled();
    expect(db.botCommand.updateMany).not.toHaveBeenCalled();
  });

  it('si otra replica de la API ya lo aplico, no suma dos veces', async () => {
    // El bus es pub/sub: con dos replicas escuchando, las dos reciben el acuse.
    // El update condicional sobre la bandera decide quien gana.
    const { service, db } = build();
    db.botCommand.findUnique.mockResolvedValue(fila(true));
    db.botCommand.updateMany.mockResolvedValue({ count: 0 });
    const subir = jest.spyOn(service, 'updateConfig').mockResolvedValue({} as never);

    await service.onWorkerEvent(acuse());

    expect(subir).not.toHaveBeenCalled();
  });

  it('ignora los eventos que no son acuses de margen', async () => {
    const { service, db } = build();

    await service.onWorkerEvent(acuse({ type: 'FILL' }));

    expect(db.botCommand.findUnique).not.toHaveBeenCalled();
  });
});
