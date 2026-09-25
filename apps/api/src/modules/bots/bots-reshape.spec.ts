import { ConflictException } from '@nestjs/common';
import { getStrategy } from '@crypton/strategy-core';
import { BotsService } from './bots.service';

/**
 * Revisión WARM de la FORMA de la escalera con inventario (spec 001, F-90).
 *
 * `filledLevelIndexes` guarda ÍNDICES: «la línea 3 está comprada». Cambiar el
 * rango, el número de líneas o el modo de dimensionado hace que el índice 3
 * signifique otro precio y otra cantidad, y la venta de lo comprado se tiende
 * donde no toca (a pérdida, o por una cantidad que no es la que se tiene). El
 * motor no remapea; la API tiene que negarse mientras el ciclo tenga
 * escalones ejecutados, y dejar pasar el mismo cambio con el ciclo limpio.
 */

const BOT_ID = '33333333-3333-3333-3333-333333333333';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'u1';

const MARKET = {
  venue: 'HYPERLIQUID',
  symbol: 'BTC',
  tickSize: '0.1',
  stepSize: '0.00001',
  minNotional: '10',
  minQty: '0.00001',
  priceDecimals: 1,
  qtyDecimals: 5,
  maxLeverage: 50,
  active: true,
};

const CONFIG_BASE = {
  ...getStrategy('GRID_CLASSIC').defaults(),
  exchangeAccountId: ACCOUNT_ID,
  symbol: 'BTC',
  venue: 'HYPERLIQUID',
  direction: 'LONG',
  marginMode: 'ISOLATED',
  positionMode: 'ONE_WAY',
  leverage: 1,
  totalInvestment: '100',
  lowerPrice: '90',
  upperPrice: '110',
  gridLevels: 5,
  gridSpacing: 'ARITHMETIC',
  sizingMode: 'QUOTE',
};

function build(filledLevelIndexes: number[], posicion: string | null = null) {
  const bot = {
    id: BOT_ID,
    user_id: USER_ID,
    exchange_account_id: ACCOUNT_ID,
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    strategy: 'GRID_CLASSIC',
    status: 'RUNNING',
    margin_mode: 'ISOLATED',
    dry_run: false,
    config_version: 1,
    leverage: 1,
    total_investment: '100',
  };

  const db = {
    bot: {
      findFirst: jest.fn().mockResolvedValue(bot),
      update: jest.fn().mockResolvedValue(bot),
      // Desde el spec 052 la version se escribe con la version vieja en el
      // `where`, para que una escritura simultanea no se pise (F-06).
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    botConfigRevision: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ config: CONFIG_BASE }),
      create: jest.fn((a: unknown) => a),
    },
    botCycle: {
      findFirst: jest.fn().mockResolvedValue({ filled_level_indexes: filledLevelIndexes }),
    },
    botEvent: { create: jest.fn((a: unknown) => a) },
    // La última foto del worker: la que dice si hay posición (spec 080, P-3).
    botSnapshot: {
      findFirst: jest.fn().mockResolvedValue(posicion === null ? null : { position_qty: posicion }),
    },
    exchangeAccount: {
      findUnique: jest.fn().mockResolvedValue({ testnet: false, paper: false }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };

  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const risk = { assertWithinLimits: jest.fn().mockResolvedValue(undefined) };
  const markets = { getSpec: jest.fn().mockResolvedValue(MARKET) };

  const service = new BotsService(
    db as never,
    markets as never,
    {} as never,
    risk as never,
    bus as never,
    {} as never,
    { budget: {} } as never,
  );

  return { service, db, bus };
}

const revision = (over: Record<string, unknown>, acceptRelayout = true) =>
  ({ config: { ...CONFIG_BASE, ...over }, acceptRelayout }) as never;

describe('BotsService.updateConfig — forma de la escalera con inventario (F-90)', () => {
  it('rechaza mover el rango con escalones ejecutados en el ciclo', async () => {
    const { service, db } = build([1, 2]);

    await expect(
      service.updateConfig(USER_ID, BOT_ID, revision({ lowerPrice: '80', upperPrice: '100' })),
    ).rejects.toThrow(ConflictException);
    expect(db.botConfigRevision.create).not.toHaveBeenCalled();
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it('el rechazo dice qué campos redibujan y qué escalones hay tomados', async () => {
    const { service } = build([3]);

    const error = await service
      .updateConfig(USER_ID, BOT_ID, revision({ gridLevels: 7, sizingMode: 'BASE' }))
      .catch((e: ConflictException) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      reason: 'RESHAPE_WITH_INVENTORY',
      filledLevelIndexes: [3],
    });
    expect(String((error as ConflictException).getResponse()['message'])).toContain('gridLevels');
  });

  it('con el ciclo limpio el mismo cambio pasa como WARM confirmado', async () => {
    const { service, db, bus } = build([]);

    const res = await service.updateConfig(
      USER_ID,
      BOT_ID,
      revision({ lowerPrice: '80', upperPrice: '100' }),
    );

    expect(res).toMatchObject({ applied: true, level: 'WARM' });
    expect(db.botConfigRevision.create).toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalled();
  });

  it('un cambio HOT con inventario no consulta el ciclo ni se rechaza', async () => {
    // `cooldownMinutes` no toca ninguna línea: no hay nada que remapear.
    const { service, db } = build([1, 2]);

    const res = await service.updateConfig(USER_ID, BOT_ID, revision({ cooldownMinutes: 30 }));

    expect(res).toMatchObject({ applied: true, level: 'HOT' });
    expect(db.botCycle.findFirst).not.toHaveBeenCalled();
  });
});

describe('BotsService.updateConfig — la version que se leyo (spec 052, F-06)', () => {
  const cambioHot = () => revision({ leverage: 2 });

  it('sin `expectedVersion` se aplica, y la escritura exige la version que se leyo', async () => {
    // Una escritura simultanea sin version chocaba con el indice unico de la
    // revision y salia un 500 con el mensaje de Prisma. Con la version leida en
    // el `where`, es un 409 como los demas (spec 056, R-3).
    const { service, db } = build([]);
    const res = (await service.updateConfig(USER_ID, BOT_ID, cambioHot())) as { applied: boolean };
    expect(res.applied).toBe(true);
    const args = db.bot.updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ id: BOT_ID, config_version: 1 });
  });

  it('la fila del bot se escribe ANTES que la revision (spec 056, R-3)', async () => {
    // Asi la segunda de dos escrituras simultaneas espera al bloqueo de la fila,
    // no escribe nada y responde 409, en vez de chocar con el indice unico.
    const { service, db } = build([]);
    await service.updateConfig(USER_ID, BOT_ID, cambioHot());
    const fila = db.bot.updateMany.mock.invocationCallOrder[0] as number;
    const revision = db.botConfigRevision.create.mock.invocationCallOrder[0] as number;
    expect(fila).toBeLessThan(revision);
  });

  it('con la version que el bot tiene, se aplica y la escritura la exige', async () => {
    const { service, db } = build([]);
    await service.updateConfig(USER_ID, BOT_ID, cambioHot(), { expectedVersion: 1 });
    const args = db.bot.updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
    // Dentro de la transaccion, para que una escritura simultanea no se pise:
    // entre leer el bot y escribirlo cabe otra.
    expect(args.where['config_version']).toBe(1);
  });

  it('con una version vieja se rechaza y no se escribe nada', async () => {
    // El caso real: el supervisor de IA lee la configuracion, tarda unos
    // veinticinco segundos en decidir, y mientras tanto el dueño toca el bot. Lo
    // que iba a escribir es la configuracion ENTERA calculada sobre lo que leyo.
    const { service, db } = build([]);

    const error = await service
      .updateConfig(USER_ID, BOT_ID, cambioHot(), { expectedVersion: 0 })
      .catch((e: ConflictException) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      reason: 'STALE_VERSION',
      // Con `code`, el filtro de excepciones lo reenvia entero y la app puede
      // reconocerlo (spec 055, 053/H-05). `reason` es lo que lee el supervisor.
      code: 'STALE_VERSION',
      expectedVersion: 0,
      currentVersion: 1,
    });
    expect(db.botConfigRevision.create).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('si la version cambia entre la lectura y la transaccion, tampoco', async () => {
    // La comprobacion de arriba no basta: la carrera cabe justo ahi. Por eso la
    // version va tambien en el `where` y se cuentan las filas escritas.
    const { service, db } = build([]);
    db.bot.updateMany.mockResolvedValue({ count: 0 });

    const error = await service
      .updateConfig(USER_ID, BOT_ID, cambioHot(), { expectedVersion: 1 })
      .catch((e: ConflictException) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      reason: 'STALE_VERSION',
      code: 'STALE_VERSION',
    });
    // Y sin revision a medias: la transaccion se corta antes de crearla.
    expect(db.botConfigRevision.create).not.toHaveBeenCalled();
  });

  it('sin `expectedVersion`, una escritura simultanea tambien es un 409 (spec 056, R-3)', async () => {
    const { service, db } = build([]);
    db.bot.updateMany.mockResolvedValue({ count: 0 });

    const error = await service
      .updateConfig(USER_ID, BOT_ID, cambioHot())
      .catch((e: ConflictException) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'STALE_VERSION',
      expectedVersion: 1,
    });
    expect(db.botConfigRevision.create).not.toHaveBeenCalled();
  });
});

describe('BotsService.updateConfig — el apalancamiento con la posición abierta (spec 080, P-3)', () => {
  /**
   * El stop y los objetivos son un % del MARGEN: con la posición abierta,
   * cambiar el apalancamiento los desplazaría en silencio, igual que la
   * liquidación de lo ya abierto. Se mira la última foto del worker.
   */
  it('con posición se rechaza, y no se escribe nada', async () => {
    const { service, db } = build([], '0.5');
    const error = await service
      .updateConfig(USER_ID, BOT_ID, revision({ leverage: 2 }))
      .catch((e: ConflictException) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      reason: 'LEVERAGE_WITH_POSITION',
    });
    expect(db.botConfigRevision.create).not.toHaveBeenCalled();
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('en corto también: la cantidad viene con signo', async () => {
    const { service } = build([], '-0.5');
    await expect(
      service.updateConfig(USER_ID, BOT_ID, revision({ leverage: 2 })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('plano, se aplica', async () => {
    const { service } = build([], '0');
    const r = await service.updateConfig(USER_ID, BOT_ID, revision({ leverage: 2 }));
    expect(r.applied).toBe(true);
  });

  it('sin foto del worker no hay posición que proteger', async () => {
    const { service } = build([], null);
    const r = await service.updateConfig(USER_ID, BOT_ID, revision({ leverage: 2 }));
    expect(r.applied).toBe(true);
  });

  it('sin tocar el apalancamiento, la posición no importa', async () => {
    const { service, db } = build([], '0.5');
    const r = await service.updateConfig(USER_ID, BOT_ID, revision({ cooldownMinutes: 5 }));
    expect(r.applied).toBe(true);
    expect(db.botSnapshot.findFirst).not.toHaveBeenCalled();
  });
});
