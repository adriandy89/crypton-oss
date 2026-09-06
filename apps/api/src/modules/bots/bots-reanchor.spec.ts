import { ConflictException } from '@nestjs/common';
import { BotsService } from './bots.service';

/**
 * «Recentrar la reticula» por la parte que decide la API (spec 010, F-84).
 *
 * Recentrar solo existe en las escaleras: Martingala y GridMart cuelgan sus
 * seguridades del ancla del ciclo. En las demas estrategias el worker lo
 * rechaza igual, pero medio minuto despues y en la bitacora; aqui se dice al
 * instante y con el motivo. Y en las escaleras compromete margen nuevo —la
 * escalera entera se vuelve a tender con la posicion anterior abierta—, asi
 * que se confirma como un cierre a mercado aunque no cierre nada.
 */

const BOT_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = 'u1';

function build(strategy: string) {
  const bot = {
    id: BOT_ID,
    user_id: USER_ID,
    exchange_account_id: '11111111-1111-1111-1111-111111111111',
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    status: 'RUNNING',
    strategy,
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
  return { service, db };
}

const recentrar = (confirm?: boolean) => ({ command: 'REANCHOR_GRID', confirm }) as never;

describe('BotsService.command — REANCHOR_GRID', () => {
  it('en una escalera exige confirmar antes de encolarlo', async () => {
    const { service, db } = build('MARTINGALE');

    const err: unknown = await service.command(USER_ID, BOT_ID, recentrar()).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ requiresConfirmation: true });
    expect(db.botCommand.create).not.toHaveBeenCalled();
  });

  it('en una escalera confirmado se encola', async () => {
    const { service, db } = build('GRIDMART');

    const res = await service.command(USER_ID, BOT_ID, recentrar(true));

    expect(res).toMatchObject({ accepted: true, command: 'REANCHOR_GRID' });
    expect(db.botCommand.create).toHaveBeenCalledTimes(1);
  });

  it('fuera de las escaleras se rechaza al instante con el motivo', async () => {
    const { service, db } = build('NEUTRAL_GRID');

    const err: unknown = await service.command(USER_ID, BOT_ID, recentrar(true)).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toContain('Precio ancla');
    expect(db.botCommand.create).not.toHaveBeenCalled();
  });
});
