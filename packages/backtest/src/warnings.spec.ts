import { StrategyKind } from '@crypton/shared';
import { fidelityWarnings } from './warnings';

/**
 * Spec 001, F-65. Los avisos del backtest callaban lo que más engaña en un
 * market maker —que se recotiza una vez por vela— y prometían guardas por bot
 * que el replay no ejecuta.
 */
describe('fidelityWarnings', () => {
  const base = {
    source: 'BINANCE' as never,
    sourceSymbol: 'BTCUSDT',
    interval: '5m' as const,
    venue: 'HYPERLIQUID',
  };

  it('un market maker recibe el aviso de una recotización por vela', () => {
    const avisos = fidelityWarnings({
      ...base,
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: {},
    });
    expect(avisos.some((a) => /una vez por vela/i.test(a))).toBe(true);
  });

  it('una rejilla no recibe los avisos del market maker', () => {
    const avisos = fidelityWarnings({ ...base, strategy: StrategyKind.GRID_CLASSIC, config: {} });
    expect(avisos.some((a) => /una vez por vela/i.test(a))).toBe(false);
  });

  it('una caducidad de órdenes menor que la vela cotiza en vela alterna, y se dice', () => {
    const avisos = fidelityWarnings({
      ...base,
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: { orderMaxAgeSeconds: 120 },
    });
    expect(avisos.some((a) => /vela alterna/i.test(a) && /120 s/.test(a))).toBe(true);
    const sinCaducidad = fidelityWarnings({
      ...base,
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: { orderMaxAgeSeconds: 0 },
    });
    expect(sinCaducidad.some((a) => /vela alterna/i.test(a))).toBe(false);
  });

  it('el aviso de guardas no promete guardas por bot', () => {
    const avisos = fidelityWarnings(base);
    const guardas = avisos.find((a) => /guardas/i.test(a)) ?? '';
    expect(guardas).toMatch(/del bot/i);
    expect(guardas).toMatch(/stop-loss/i);
  });
});
