// Los decoradores de `class-validator` leen metadatos de tipo, y quien carga esa
// biblioteca en la aplicación real es `main.ts`. Un test que instancia el DTO por
// su cuenta no pasa por ahí, así que lo carga él.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateRiskLimitsDto } from './dtos';
import { ForbiddenException } from '@nestjs/common';
import { startOfDay } from '@crypton/shared';
import { RiskService } from './risk.service';

/**
 * Los topes de riesgo del usuario, por la parte que puede hacer daño.
 *
 * Este módulo decide si alguien puede operar y hasta dónde, y no tenía ni un
 * test. Lo que se comprueba aquí es lo único que hay que dejar clavado: la
 * diferencia entre «sin límite» y «límite de cero».
 *
 * Un cero guardado no se queda en un mensaje raro. El worker recibe las guardas
 * como CADENAS y las comprueba por veracidad —`if (g.maxNotionalPerBot && …)`—,
 * y `'0'` es veraz en JavaScript: pausaría todos los bots vivos en cuanto
 * tuvieran posición. Alguien escribiendo `0` para decir «sin límite» se apagaría
 * la plataforma entera.
 */

const errores = (payload: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(UpdateRiskLimitsDto, payload), {
    whitelist: true,
  }).map((e) => e.property);

describe('UpdateRiskLimitsDto', () => {
  describe('«sin límite» se dice omitiendo el campo', () => {
    it('un cuerpo vacío es válido: no toca ningún tope', () => {
      expect(errores({})).toEqual([]);
    });

    it('null pasa: es lo que manda el formulario al vaciar un campo', () => {
      // `blank()` en risk.page.ts convierte la cadena vacía en null. Es la vía
      // por la que se quita un límite, y tiene que seguir funcionando.
      expect(errores({ maxNotionalPerBot: null })).toEqual([]);
      expect(errores({ maxTotalNotional: null })).toEqual([]);
    });
  });

  describe('cero NO es una forma de decir «sin límite»', () => {
    it.each([
      ['maxNotionalPerBot', '0'],
      ['maxNotionalPerBot', '0.00'],
      ['maxTotalNotional', '0'],
      ['maxDailyLoss', '0'],
      ['killSwitchDrawdownPct', '0.0'],
    ])('rechaza %s = %s', (campo, valor) => {
      expect(errores({ [campo]: valor })).toContain(campo);
    });

    it('el mensaje dice qué hacer en su lugar', () => {
      // Rechazar sin explicar la alternativa deja al usuario probando cifras.
      const fallos = validateSync(plainToInstance(UpdateRiskLimitsDto, { maxNotionalPerBot: '0' }));
      const texto = JSON.stringify(fallos[0]?.constraints ?? {});
      expect(texto).toContain('vacío');
    });

    it('rechaza un negativo', () => {
      expect(errores({ maxNotionalPerBot: '-500' })).toContain('maxNotionalPerBot');
    });
  });

  describe('un tope de verdad pasa', () => {
    it.each([
      ['maxNotionalPerBot', '10000'],
      ['maxTotalNotional', '25000.50'],
      ['maxDailyLoss', '0.5'],
      ['killSwitchDrawdownPct', '30'],
    ])('acepta %s = %s', (campo, valor) => {
      expect(errores({ [campo]: valor })).toEqual([]);
    });

    it('un decimal por debajo de uno no se confunde con cero', () => {
      // El patrón excluye «0» y «0.00», no «0.5». Sin este caso, una expresión
      // regular de más pasaría desapercibida.
      expect(errores({ maxNotionalPerBot: '0.5' })).toEqual([]);
    });
  });

  describe('la alerta de liquidación es la excepción', () => {
    it('acepta cero: ahí significa «no me avises», no «frena siempre»', () => {
      expect(errores({ liquidationAlertPct: '0' })).toEqual([]);
    });
  });

  describe('los enteros conservan sus topes', () => {
    it.each([
      ['maxLeverage', 0],
      ['maxLeverage', 51],
      ['maxOpenBots', 0],
      ['maxOpenBots', 201],
    ])('rechaza %s = %s', (campo, valor) => {
      expect(errores({ [campo]: valor })).toContain(campo);
    });

    it('acepta los valores razonables', () => {
      expect(errores({ maxLeverage: 10, maxOpenBots: 5 })).toEqual([]);
    });
  });
});

/**
 * Las guardas que decide la API antes de que exista posición (spec 001, F-42,
 * F-44 y F-43): el propio bot no cuenta dos veces al editarlo, la puerta del 5 %
 * usa la tasa de mantenimiento del mercado, y el «día» de la pérdida diaria es
 * el del usuario, como en el worker.
 */
describe('RiskService', () => {
  const MARKET = {
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    tickSize: '0.1',
    stepSize: '0.00001',
    minNotional: '10',
    minQty: null,
    maxQty: null,
    maxLeverage: 40,
    priceDecimals: 1,
    qtyDecimals: 5,
    active: true,
  } as never;
  const config = (over: Record<string, unknown> = {}) =>
    ({
      exchangeAccountId: 'a',
      symbol: 'BTC',
      direction: 'LONG',
      marginMode: 'ISOLATED',
      leverage: 1,
      totalInvestment: '1000',
      ...over,
    }) as never;
  const decimal = (v: string) => ({ toString: () => v, neg: () => decimal('-' + v) });

  function build(
    limits: Record<string, unknown>,
    bots: { id: string; total_investment: string; leverage: number }[],
  ) {
    const db = {
      riskLimit: {
        findUnique: jest.fn().mockResolvedValue({
          user_id: 'u1',
          max_notional_per_bot: null,
          max_total_notional: null,
          max_leverage: null,
          max_open_bots: null,
          max_daily_loss: null,
          ...limits,
        }),
      },
      bot: {
        findMany: jest.fn(async (args: { where: { id?: { not: string } } }) =>
          bots.filter((b) => b.id !== args.where.id?.not),
        ),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest
          .fn()
          .mockResolvedValue({ exchange_account: { status: 'VERIFIED', venue: 'HYPERLIQUID' } }),
      },
      botCycle: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Tokyo' }) },
    };
    return { service: new RiskService(db as never), db };
  }

  it('al editar un bot no lo suma dos veces contra el tope total', async () => {
    const { service } = build({ max_total_notional: 1000 }, [
      { id: 'b1', total_investment: '1000', leverage: 1 },
    ]);
    await expect(service.assertWithinLimits('u1', config(), MARKET)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      service.assertWithinLimits('u1', config(), MARKET, { excludeBotId: 'b1' }),
    ).resolves.toBeUndefined();
  });

  it('la puerta del 5 % usa la tasa de mantenimiento del mercado y dice el tope', async () => {
    const { service } = build({}, []);
    // 40x de máximo → mantenimiento 1,25 % → 16x como mucho.
    await expect(
      service.assertWithinLimits('u1', config({ leverage: 17 }), MARKET),
    ).rejects.toThrow(/16/);
    await expect(
      service.assertWithinLimits('u1', config({ leverage: 16 }), MARKET),
    ).resolves.toBeUndefined();
  });

  it('la pérdida diaria se corta a la medianoche del usuario', async () => {
    const { service, db } = build({ max_daily_loss: decimal('100') }, []);
    await service.assertCanStart('u1', 'b1');
    const args = db.botCycle.findMany.mock.calls[0][0] as {
      where: { closed_at: { gte: Date } };
    };
    const esperado = startOfDay('Asia/Tokyo').getTime();
    expect(Math.abs(args.where.closed_at.gte.getTime() - esperado)).toBeLessThan(60_000);
  });
});
