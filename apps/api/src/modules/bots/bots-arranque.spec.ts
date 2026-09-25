import { BadRequestException } from '@nestjs/common';
import { StrategyKind } from '@crypton/db';
import { getStrategy } from '@crypton/strategy-core';
import { BotsService } from './bots.service';

/**
 * `START` valida la configuración contra el mercado y los límites de HOY
 * (spec 080, P-5).
 *
 * Se validaba al crear y al editar, nunca al arrancar: un bot parado hace
 * semanas arrancaba con un mantenimiento que había subido o un tope del usuario
 * que había bajado, y tras la migración del 080 podía arrancar con un stop que
 * quedaba detrás de la liquidación.
 */

const BOT_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = 'u1';

// BTC a 40× de máximo: mantenimiento 1,25 %.
const MARKET = {
  venue: 'HYPERLIQUID',
  symbol: 'BTC',
  tickSize: '0.1',
  stepSize: '0.00001',
  minNotional: '10',
  minQty: '0.00001',
  priceDecimals: 1,
  qtyDecimals: 5,
  maxLeverage: 40,
  active: true,
};

const CONFIG = {
  ...getStrategy(StrategyKind.TRAILING_PROFIT).defaults(),
  exchangeAccountId: '11111111-1111-1111-1111-111111111111',
  symbol: 'BTC',
  direction: 'SHORT',
  marginMode: 'ISOLATED',
  leverage: 15,
  totalInvestment: '120',
};

function montar(config: Record<string, unknown>) {
  const bot = {
    id: BOT_ID,
    user_id: USER_ID,
    exchange_account_id: CONFIG.exchangeAccountId,
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    strategy: StrategyKind.TRAILING_PROFIT,
    status: 'STOPPED',
    dry_run: false,
    config_version: 3,
  };
  const db = {
    bot: {
      // La primera es la del dueño; la segunda, la del rival por el par.
      findFirst: jest.fn().mockResolvedValueOnce(bot).mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(bot),
    },
    botConfigRevision: { findUniqueOrThrow: jest.fn().mockResolvedValue({ config }) },
    botEvent: { create: jest.fn().mockResolvedValue(undefined) },
    exchangeAccount: {
      findUnique: jest.fn().mockResolvedValue({ testnet: false, paper: false }),
    },
  };
  const markets = { getSpec: jest.fn().mockResolvedValue(MARKET) };
  const risk = {
    assertCanStart: jest.fn().mockResolvedValue(undefined),
    assertWithinLimits: jest.fn().mockResolvedValue(undefined),
  };
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const service = new BotsService(
    db as never,
    markets as never,
    {} as never,
    risk as never,
    bus as never,
    {} as never,
    { budget: {} } as never,
  );
  return { service, db, risk };
}

describe('BotsService — START valida la configuración de hoy (spec 080, P-5)', () => {
  it('un stop detrás de la liquidación no arranca, y el bot no pasa a STARTING', async () => {
    // A 15× en corto la liquidación llega al perder el 80,2 % del margen: un
    // stop del 90 % no salta nunca.
    const { service, db } = montar({ ...CONFIG, stopLossPct: '90' });

    const error = await service
      .command(USER_ID, BOT_ID, { command: 'START' } as never)
      .catch((e: BadRequestException) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ field: 'stopLossPct', severity: 'ERROR' }),
      ]),
    });
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it('con una configuración válida arranca, mide sus límites y escribe su nocional', async () => {
    const { service, db, risk } = montar({ ...CONFIG, stopLossPct: '10' });

    await service.command(USER_ID, BOT_ID, { command: 'START' } as never);

    expect(risk.assertWithinLimits).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ leverage: 15 }),
      MARKET,
      expect.objectContaining({ excludeBotId: BOT_ID }),
    );
    expect(db.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'STARTING', max_notional: null }),
      }),
    );
  });

  it('un market maker escribe su tope de posición como nocional (079/F-03)', () => {
    const mm = getStrategy(StrategyKind.MARKET_MAKER);
    expect(mm.nocionalMaximo?.({ maxBotPositionValue: '500' } as never)).toBe('500');
    expect(getStrategy(StrategyKind.MARKET_MAKER_V2).nocionalMaximo?.({} as never)).toBeNull();
  });
});
