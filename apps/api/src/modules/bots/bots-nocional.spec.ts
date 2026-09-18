import { getStrategy } from '@crypton/strategy-core';
import { BotsService } from './bots.service';

/**
 * El nocional que declara la estrategia (`bots.max_notional`, spec 058).
 *
 * El canal con IA tiene un TOPE de 25x y abre mucho menos. Los agregados de
 * exposición —el tope total del usuario, aquí y en el worker— lo cuentan con
 * esta columna en vez de capital por apalancamiento; sin ella, un solo bot del
 * canal llenaba el tope total. Se escribe al crear y al editar, con la
 * configuración que queda.
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
  stepSize: '0.00001',
  minNotional: '10',
  minQty: '0.00001',
  maxQty: null,
  priceDecimals: 1,
  qtyDecimals: 5,
  maxLeverage: 50,
  active: true,
};

const CANAL = {
  ...getStrategy('AI_CHANNEL').defaults(),
  exchangeAccountId: ACCOUNT_ID,
  symbol: 'BTC',
  direction: 'NEUTRAL',
  marginMode: 'ISOLATED',
  leverage: 25,
  totalInvestment: '1000',
};

const REJILLA = {
  ...getStrategy('GRID_CLASSIC').defaults(),
  exchangeAccountId: ACCOUNT_ID,
  symbol: 'BTC',
  direction: 'LONG',
  marginMode: 'ISOLATED',
  leverage: 1,
  totalInvestment: '100',
  lowerPrice: '90',
  upperPrice: '110',
  gridLevels: 5,
};

function build(strategy: string, config: Record<string, unknown>) {
  const bot = {
    id: BOT_ID,
    user_id: USER_ID,
    exchange_account_id: ACCOUNT_ID,
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    strategy,
    status: 'RUNNING',
    margin_mode: 'ISOLATED',
    dry_run: true,
    config_version: 1,
    leverage: Number(config['leverage']),
    total_investment: String(config['totalInvestment']),
  };
  const db = {
    bot: {
      // `detail()` al final de `create()` empieza por aquí: se corta con un
      // centinela, lo que interesa ya se ha escrito.
      findFirst: jest.fn().mockResolvedValue(bot),
      create: jest.fn().mockResolvedValue(bot),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    botConfigRevision: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ config }),
      create: jest.fn((a: unknown) => a),
    },
    botCycle: { findFirst: jest.fn().mockResolvedValue(null) },
    // El canal con IA es de solo administradores y el rol se lee de la base.
    user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN', disabled: false }) },
    botEvent: { create: jest.fn((a: unknown) => a) },
    exchangeAccount: {
      findFirst: jest.fn().mockResolvedValue({
        id: ACCOUNT_ID,
        venue: 'HYPERLIQUID',
        status: 'VERIFIED',
        testnet: false,
        paper: true,
      }),
      findUnique: jest.fn().mockResolvedValue({ testnet: false, paper: true }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    cacheGet: jest.fn().mockResolvedValue({ mark: '100' }),
  };
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
  return { service, db, risk };
}

type Escritura = { data: Record<string, unknown> };

describe('BotsService: el nocional que declara la estrategia (spec 058)', () => {
  it('al crear un canal con IA se guarda el suyo, y los límites lo reciben', async () => {
    const { service, db, risk } = build('AI_CHANNEL', CANAL);
    db.bot.findFirst.mockRejectedValue(new Error('creado'));

    await expect(
      service.create(USER_ID, {
        exchangeAccountId: ACCOUNT_ID,
        strategy: 'AI_CHANNEL',
        symbol: 'BTC',
        name: 'canal',
        dryRun: true,
        config: CANAL,
      } as never),
    ).rejects.toThrow('creado');

    // 1.000 de capital × 5 de múltiplo por defecto, por debajo de 1.000 × 25.
    const creado = db.bot.create.mock.calls[0][0] as Escritura;
    expect(creado.data['max_notional']).toBe('5000');
    expect(risk.assertWithinLimits).toHaveBeenCalledWith(
      USER_ID,
      expect.anything(),
      MARKET,
      expect.objectContaining({ reglaLiquidacion: 'POR_STOP', nocional: '5000' }),
    );
  });

  it('al editar se recalcula con la configuración nueva', async () => {
    const { service, db } = build('AI_CHANNEL', CANAL);

    const res = await service.updateConfig(USER_ID, BOT_ID, {
      config: { ...CANAL, maxNotionalMultiple: 3 },
    });

    expect(res).toMatchObject({ applied: true });
    const escrito = db.bot.updateMany.mock.calls[0][0] as Escritura;
    expect(escrito.data['max_notional']).toBe('3000');
  });

  /**
   * Spec 062, F-52. «Cortar las entradas» pasaba por `validate` y por los topes
   * del usuario, asi que un minimo del venue que subio o una palanca maxima
   * recortada dejaban al bot sin poder frenar, que es justo lo que se hace
   * cuando algo va mal. Sigue escribiendose por `updateConfig`: no hay otro
   * camino.
   */
  it('cortar las entradas se aplica aunque la configuración ya no valide', async () => {
    const { service, db, risk } = build('AI_CHANNEL', CANAL);
    // El venue sube su minimo: la configuracion guardada ya no pasaria validate.
    db.botConfigRevision.findUniqueOrThrow.mockResolvedValue({
      config: { ...CANAL, totalInvestment: '20' },
    });
    risk.assertWithinLimits.mockRejectedValue(new Error('fuera de los topes'));

    const res = await service.updateConfig(USER_ID, BOT_ID, {
      config: { ...CANAL, totalInvestment: '20', entriesEnabled: false },
    });

    expect(res).toMatchObject({ applied: true });
    expect(risk.assertWithinLimits).not.toHaveBeenCalled();

    // Pero ABRIRLAS con la configuracion rota sigue rechazandose: la exencion es
    // solo para lo que apaga.
    const otro = build('AI_CHANNEL', CANAL);
    otro.db.botConfigRevision.findUniqueOrThrow.mockResolvedValue({
      config: { ...CANAL, totalInvestment: '20', entriesEnabled: false },
    });
    await expect(
      otro.service.updateConfig(USER_ID, BOT_ID, {
        config: { ...CANAL, totalInvestment: '20', entriesEnabled: true },
      }),
    ).rejects.toThrow(/no es válida/);
  });

  it('las estrategias de siempre lo dejan nulo', async () => {
    const { service, db } = build('GRID_CLASSIC', REJILLA);

    await service.updateConfig(USER_ID, BOT_ID, {
      config: { ...REJILLA, cooldownMinutes: 30 },
    });

    const escrito = db.bot.updateMany.mock.calls[0][0] as Escritura;
    expect(escrito.data).toHaveProperty('max_notional', null);
  });
});
