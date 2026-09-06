import { BotsService } from './bots.service';

/**
 * Spec 025. Las cifras de capital que pintan la tarjeta de la lista y el
 * resumen del detalle: lo que hay ahora, lo que se puso y lo que hay en juego.
 * Salen del MISMO cálculo en las dos pantallas (`metricsOf`).
 */
const USER_ID = 'u1';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

const snapshot = {
  realized_pnl_acc: '43.20',
  unrealized_pnl: '-3.20',
  position_qty: '0.5',
  average_entry: '79000',
  mark_price: '78990',
  liquidation_price: '60000',
  margin_used: '395',
  equity: '40',
  open_orders: 6,
  taken_at: new Date('2026-09-06T10:00:00Z'),
};

const bot = {
  id: BOT_ID,
  user_id: USER_ID,
  name: 'BTC noche',
  venue: 'HYPERLIQUID',
  symbol: 'BTC',
  strategy: 'GRID_CLASSIC',
  status: 'RUNNING',
  direction: 'LONG',
  leverage: 2,
  dry_run: false,
  total_investment: '1200',
  config_version: 3,
  exchange_account_id: ACCOUNT_ID,
  note: null,
  last_error: null,
  started_at: new Date('2026-09-01T00:00:00Z'),
  created_at: new Date('2026-09-01T00:00:00Z'),
  updated_at: new Date('2026-09-06T10:00:00Z'),
  snapshots: [snapshot],
  cycles: [],
  exchange_account: { testnet: false, paper: false },
};

function build() {
  const revisiones = new Map<number, { config: Record<string, unknown> }>([
    [1, { config: { totalInvestment: '1000', leverage: 2 } }],
    [3, { config: { totalInvestment: '1200', leverage: 2 } }],
  ]);
  const db = {
    bot: {
      findMany: jest.fn().mockResolvedValue([bot]),
      findFirst: jest.fn().mockResolvedValue(bot),
    },
    botConfigRevision: {
      findUnique: jest.fn(({ where }: { where: { bot_id_version: { version: number } } }) =>
        Promise.resolve(revisiones.get(where.bot_id_version.version) ?? null),
      ),
    },
    botCycle: { findFirst: jest.fn().mockResolvedValue(null) },
    botSnapshot: { findFirst: jest.fn().mockResolvedValue(snapshot) },
    botOrder: { findMany: jest.fn().mockResolvedValue([]) },
    botShare: { findUnique: jest.fn().mockResolvedValue(null) },
    exchangeAccount: {
      findUnique: jest.fn().mockResolvedValue({ testnet: false, paper: false }),
    },
  };
  // Sin tickers en caché: las cifras salen del precio del snapshot.
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  const service = new BotsService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    cache as never,
    { budget: {} } as never,
  );
  return { service, db };
}

describe('BotsService: capital en lista y detalle (spec 025)', () => {
  it('la lista trae el capital actual, el valor de la posición y el margen usado', async () => {
    const { service } = build();

    const [fila] = await service.list(USER_ID, {});

    expect(fila).toMatchObject({
      totalInvestment: '1200',
      // 1200 + 43,20 − 3,20: exacto, sin ruido de coma flotante.
      currentCapital: '1240',
      // 0,5 BTC a 78 990 de marca.
      positionValue: '39495',
      marginUsed: '395',
    });
  });

  it('el detalle trae además lo que se puso al crear el bot (revisión 1)', async () => {
    const { service } = build();

    const detalle = await service.detail(USER_ID, BOT_ID);

    expect(detalle).toMatchObject({
      initialInvestment: '1000',
      totalInvestment: '1200',
      currentCapital: '1240',
    });
  });
});
