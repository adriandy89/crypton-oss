import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role, StrategyKind } from '@crypton/db';
import { ESTRATEGIAS_SOLO_ADMIN, type MarketSpec } from '@crypton/shared';
import type { CacheService, DbService } from 'src/libs';
import { AdvisorService } from '../advisor/advisor.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { RiskService } from '../risk/risk.service';
import { BotsService } from './bots.service';

/**
 * El canal con IA es solo para administradores (spec 058, R-14).
 *
 * La regla se comprueba en cada camino que lleva a operar, con el rol leído de
 * la base —no del token—, y en los que llevan a otros usuarios: el listado, el
 * asesor y el ranking. (En el repositorio privado la consulta del rol vive en su
 * módulo de planes; aquí no hay planes, así que la hace `BotsService`.)
 */

const ADMIN = 'admin-1';
const USUARIO = 'user-1';
const APAGADO = 'admin-apagado';

const usuarios: Record<string, { role: Role; disabled: boolean }> = {
  [ADMIN]: { role: Role.ADMIN, disabled: false },
  [USUARIO]: { role: Role.USER, disabled: false },
  [APAGADO]: { role: Role.ADMIN, disabled: true },
};

describe('BotsService: los caminos que llevan a operar', () => {
  const BOT = '22222222-2222-2222-2222-222222222222';

  function montar(dueno: string, status = 'STOPPED') {
    const bot = {
      id: BOT,
      user_id: dueno,
      exchange_account_id: '11111111-1111-1111-1111-111111111111',
      venue: 'HYPERLIQUID',
      symbol: 'BTC',
      status,
      strategy: StrategyKind.AI_CHANNEL,
      dry_run: false,
      config_version: 1,
    };
    const buscarUsuario = jest.fn((args: { where: { id: string } }) =>
      Promise.resolve(usuarios[args.where.id] ?? null),
    );
    const db = {
      bot: { findFirst: jest.fn().mockResolvedValue(bot) },
      user: { findUnique: buscarUsuario },
    };
    const markets = { getSpec: jest.fn().mockRejectedValue(new Error('no debería llegar')) };
    // Si la puerta deja pasar, lo siguiente que corre es esto: se para aquí.
    const risk = { assertCanStart: jest.fn().mockRejectedValue(new Error('pasó la puerta')) };
    const service = new BotsService(
      db as never,
      markets as never,
      {} as never,
      risk as never,
      {} as never,
      {} as never,
      { budget: {} } as never,
    );
    return { service, markets, risk, buscarUsuario };
  }

  it('solo el canal con IA está restringido', () => {
    expect(ESTRATEGIAS_SOLO_ADMIN).toEqual([StrategyKind.AI_CHANNEL]);
  });

  it('el listado la enseña solo a un administrador habilitado (spec 059)', async () => {
    const { service } = montar(ADMIN);
    const para = async (quien: string) => (await service.strategiesMeta(quien)).map((m) => m.kind);
    expect(await para(ADMIN)).toContain(StrategyKind.AI_CHANNEL);
    for (const quien of [USUARIO, APAGADO, 'no-existe']) {
      const kinds = await para(quien);
      expect(kinds).not.toContain(StrategyKind.AI_CHANNEL);
      expect(kinds).toContain(StrategyKind.TRAILING_PROFIT);
    }
    // El mismo formulario para todos: lo único que cambia es qué estrategias salen.
    const delAdmin = (await service.strategiesMeta(ADMIN)).find(
      (m) => m.kind === StrategyKind.TRAILING_PROFIT,
    );
    const delUsuario = (await service.strategiesMeta(USUARIO)).find(
      (m) => m.kind === StrategyKind.TRAILING_PROFIT,
    );
    expect(delAdmin).toEqual(delUsuario);
  });

  it('la vista previa: 403 antes de preguntar al venue', async () => {
    const { service, markets } = montar(USUARIO);
    const dto = {
      strategy: StrategyKind.AI_CHANNEL,
      venue: 'HYPERLIQUID',
      symbol: 'BTC',
      config: {},
    };
    await expect(service.preview(USUARIO, dto as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(markets.getSpec).not.toHaveBeenCalled();
  });

  it('el arranque: 403 para quien no es administrador', async () => {
    const { service, risk } = montar(USUARIO);
    await expect(
      service.command(USUARIO, BOT, { command: 'START' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(risk.assertCanStart).not.toHaveBeenCalled();
  });

  it('el arranque: un administrador pasa la puerta', async () => {
    const { service, risk } = montar(ADMIN);
    await expect(service.command(ADMIN, BOT, { command: 'START' } as never)).rejects.toThrow(
      'pasó la puerta',
    );
    expect(risk.assertCanStart).toHaveBeenCalled();
  });

  it('la edición: 403 para quien ya no es administrador', async () => {
    const { service, markets } = montar(APAGADO, 'RUNNING');
    await expect(service.updateConfig(APAGADO, BOT, { config: {} })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(markets.getSpec).not.toHaveBeenCalled();
  });

  it('las demás estrategias no consultan el rol', async () => {
    const { service, buscarUsuario } = montar(USUARIO);
    await expect(
      service.preview(USUARIO, {
        strategy: StrategyKind.GRID_CLASSIC,
        venue: 'HYPERLIQUID',
        symbol: 'BTC',
        config: {},
      } as never),
    ).rejects.toThrow('no debería llegar');
    expect(buscarUsuario).not.toHaveBeenCalled();
  });
});

describe('RiskService con la regla por stop', () => {
  const mercado = (maxLeverage = 40): MarketSpec => ({
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    canonical: 'BTC/USDC',
    base: 'BTC',
    quote: 'USDC',
    tickSize: '0.1',
    stepSize: '0.00001',
    minNotional: '10',
    minQty: null,
    maxQty: null,
    maxLeverage,
    priceDecimals: 1,
    qtyDecimals: 5,
    active: true,
  });
  const riesgo = (limites: Record<string, unknown> = {}) =>
    new RiskService({
      riskLimit: {
        findUnique: jest.fn().mockResolvedValue({
          max_leverage: null,
          max_notional_per_bot: null,
          max_total_notional: null,
          ...limites,
        }),
      },
    } as unknown as DbService);
  const cfg = (leverage: number) => ({ leverage, totalInvestment: '1000' }) as never;

  it('25x no pasa la regla del 5 %, y sí la del stop', async () => {
    // 40x máximo → mantenimiento del 1,25 % → con el 5 %, 16x como mucho.
    await expect(riesgo().assertWithinLimits(USUARIO, cfg(25), mercado())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      riesgo().assertWithinLimits(USUARIO, cfg(25), mercado(), { reglaLiquidacion: 'POR_STOP' }),
    ).resolves.toBeUndefined();
  });

  it('con la regla del stop, el techo es 25x o el máximo del par', async () => {
    const r = riesgo();
    await expect(
      r.assertWithinLimits(USUARIO, cfg(26), mercado(), { reglaLiquidacion: 'POR_STOP' }),
    ).rejects.toThrow(/como mucho a 25×/);
    await expect(
      r.assertWithinLimits(USUARIO, cfg(25), mercado(20), { reglaLiquidacion: 'POR_STOP' }),
    ).rejects.toThrow(/como mucho a 20×/);
    await expect(r.topeDeApalancamiento(USUARIO, '1000', mercado())).resolves.toBe(16);
    await expect(
      r.topeDeApalancamiento(USUARIO, '1000', mercado(), { reglaLiquidacion: 'POR_STOP' }),
    ).resolves.toBe(25);
  });

  it('el tope por bot mira el nocional que declara la estrategia', async () => {
    const r = riesgo({ max_notional_per_bot: '4000' });
    const opciones = { reglaLiquidacion: 'POR_STOP' as const };
    // Sin él, 25 × 1000 = 25 000 de nocional supuesto.
    await expect(r.assertWithinLimits(USUARIO, cfg(25), mercado(), opciones)).rejects.toThrow(
      /25000\.00/,
    );
    await expect(
      r.assertWithinLimits(USUARIO, cfg(25), mercado(), { ...opciones, nocional: '3000' }),
    ).resolves.toBeUndefined();
  });
});

describe('El asesor y el ranking', () => {
  it('el asesor no propone nada para el canal, y no pregunta al venue', async () => {
    const markets = { getSpec: jest.fn() };
    const asesor = new AdvisorService(
      markets as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn() } as never,
    );
    await expect(
      asesor.suggest(USUARIO, {
        venue: 'HYPERLIQUID',
        symbol: 'BTC',
        strategy: StrategyKind.AI_CHANNEL,
        totalInvestment: '1000',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(markets.getSpec).not.toHaveBeenCalled();
  });

  function ranking(strategy: StrategyKind) {
    const buscarBots = jest.fn().mockResolvedValue([]);
    const db = {
      bot: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'bot-1',
          strategy,
          dry_run: false,
          config_version: 1,
          share: null,
          exchange_account: { testnet: false },
        }),
        findMany: buscarBots,
      },
      botShare: {
        findUnique: jest.fn().mockResolvedValue({
          bot_id: 'bot-1',
          public: true,
          config_blob: { v: 1, strategy, params: {}, ratios: {} },
          bot: { name: 'x', strategy, venue: 'HYPERLIQUID', symbol: 'BTC' },
        }),
      },
      leaderboardEntry: { deleteMany: jest.fn(), createMany: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    } as unknown as DbService;
    const service = new LeaderboardService(db, {
      del: jest.fn(),
      delByPrefix: jest.fn(),
    } as unknown as CacheService);
    return { service, buscarBots };
  }

  it('no se publica', async () => {
    const { service } = ranking(StrategyKind.AI_CHANNEL);
    await expect(service.share(ADMIN, 'bot-1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una publicación anterior a la regla no se copia: como si no existiera', async () => {
    const { service } = ranking(StrategyKind.AI_CHANNEL);
    await expect(
      service.resolveShare(USUARIO, 'codigo', {
        exchangeAccountId: 'c',
        symbol: 'BTC',
        totalInvestment: '1000',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el ranking no la cuenta', async () => {
    const { service, buscarBots } = ranking(StrategyKind.GRID_CLASSIC);
    await service.recomputePeriod('DAY').catch(() => undefined);
    const where = (buscarBots.mock.calls[0] as [{ where: { strategy?: { notIn?: string[] } } }])[0]
      .where;
    expect(where.strategy?.notIn).toEqual([StrategyKind.AI_CHANNEL]);
  });
});
