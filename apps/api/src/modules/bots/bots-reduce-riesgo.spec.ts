import { configDeOperacion } from '@crypton/strategy-core';
import { planDePrueba } from '../ai-desk/agentes.fixture-spec';
import { BotsService } from './bots.service';

/**
 * Lo que solo reduce el riesgo se aplica siempre (spec 074, R-22).
 *
 * El seguimiento de un agente ciñe el stop o baja el tope de posición por
 * `updateConfig`, el único camino de escritura. Pero «asegurar 1 R» deja el
 * stop de un largo POR ENCIMA de su entrada, que la validación de creación
 * rechaza, y un tope del usuario bajado después de abrir la operación haría
 * que `assertWithinLimits` impidiera protegerla. Como el cambio que solo apaga
 * (spec 062, F-52): la estrategia dice qué reduce el riesgo, y eso se aplica.
 */

const BOT_ID = '44444444-4444-4444-4444-444444444444';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'admin-1';

const MARKET = {
  venue: 'HYPERLIQUID',
  symbol: 'BTC',
  canonical: 'BTC/USDC',
  base: 'BTC',
  quote: 'USDC',
  tickSize: '0.1',
  stepSize: '0.001',
  minNotional: '10',
  minQty: '0.001',
  maxQty: null,
  priceDecimals: 1,
  qtyDecimals: 3,
  maxLeverage: 40,
  active: true,
};

const CONFIG = {
  ...configDeOperacion(planDePrueba(), {
    exchangeAccountId: ACCOUNT_ID,
    agentProposalId: 'p-1',
  }),
} as unknown as Record<string, unknown>;

function build() {
  const bot = {
    id: BOT_ID,
    user_id: USER_ID,
    exchange_account_id: ACCOUNT_ID,
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    strategy: 'AGENT_TRADE',
    status: 'RUNNING',
    margin_mode: 'ISOLATED',
    dry_run: false,
    config_version: 3,
    leverage: 3,
    total_investment: '33.37',
  };
  const db = {
    bot: {
      findFirst: jest.fn().mockResolvedValue(bot),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    botConfigRevision: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ config: CONFIG }),
      create: jest.fn((a: unknown) => a),
    },
    botCycle: { findFirst: jest.fn().mockResolvedValue(null) },
    botEvent: { create: jest.fn((a: unknown) => a) },
    exchangeAccount: {
      findUnique: jest.fn().mockResolvedValue({ testnet: false, paper: false }),
    },
    // AGENT_TRADE es de solo administradores: el servicio lee el rol de la base.
    user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN', disabled: false }) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  // Un tope del usuario bajado después de abrir: ya no cabría ni la operación entera.
  const risk = { assertWithinLimits: jest.fn().mockRejectedValue(new Error('fuera de los topes')) };
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
  return { service, db, risk };
}

describe('updateConfig — lo que solo reduce el riesgo (spec 074)', () => {
  it('ceñir el stop por encima de la entrada se aplica, aunque ni valide ni quepa en los topes', async () => {
    const { service, db, risk } = build();
    // El plan de prueba entra a 100.1: asegurar 1 R deja el stop en 103.
    const res = await service.updateConfig(
      USER_ID,
      BOT_ID,
      { config: { ...CONFIG, stopPrice: '103' } },
      { appliedBy: 'ai-desk:ag-1', expectedVersion: 3 },
    );
    expect(res).toMatchObject({ applied: true, level: 'HOT', version: 4 });
    expect(risk.assertWithinLimits).not.toHaveBeenCalled();
    expect(db.botConfigRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 4, applied_by: 'ai-desk:ag-1' }),
    });
  });

  it('bajar el tope de posición, también', async () => {
    const { service } = build();
    const res = await service.updateConfig(USER_ID, BOT_ID, {
      config: { ...CONFIG, positionCap: '0.5' },
    });
    expect(res).toMatchObject({ applied: true });
  });

  it('ensanchar el stop no es reducir: pasa por los topes, y aquí no cabe', async () => {
    const { service, risk } = build();
    await expect(
      service.updateConfig(USER_ID, BOT_ID, { config: { ...CONFIG, stopPrice: '96' } }),
    ).rejects.toThrow('fuera de los topes');
    expect(risk.assertWithinLimits).toHaveBeenCalled();
  });

  it('y la versión esperada sigue mandando', async () => {
    const { service } = build();
    await expect(
      service.updateConfig(
        USER_ID,
        BOT_ID,
        { config: { ...CONFIG, stopPrice: '99' } },
        { expectedVersion: 2 },
      ),
    ).rejects.toThrow(/ha cambiado/);
  });
});
