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

function build(filledLevelIndexes: number[]) {
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
    },
    botConfigRevision: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ config: CONFIG_BASE }),
      create: jest.fn((a: unknown) => a),
    },
    botCycle: {
      findFirst: jest.fn().mockResolvedValue({ filled_level_indexes: filledLevelIndexes }),
    },
    botEvent: { create: jest.fn((a: unknown) => a) },
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
