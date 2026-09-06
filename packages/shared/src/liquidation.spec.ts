import {
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  maintenanceMarginRateOf,
  maxLeverageWithinDistance,
} from './liquidation';

/**
 * La tasa de mantenimiento por mercado y la puerta del 5 % (spec 001, F-93 y
 * F-44). Antes la estimación usaba un 0,5 % plano —optimista en altcoins— y la
 * API prohibía 19× en todos los pares sin que ningún formulario lo dijera.
 */
describe('maintenanceMarginRateOf', () => {
  it('la ficha manda cuando la trae', () => {
    expect(maintenanceMarginRateOf({ maintenanceMarginRate: 0.02, maxLeverage: 40 })).toBe(0.02);
  });

  it('sin ficha, la mitad del margen inicial al apalancamiento máximo', () => {
    // Hyperliquid: BTC a 40x → 1,25 %; DOGE a 10x → 5 %.
    expect(maintenanceMarginRateOf({ maxLeverage: 40 })).toBeCloseTo(0.0125, 6);
    expect(maintenanceMarginRateOf({ maxLeverage: 10 })).toBeCloseTo(0.05, 6);
  });

  it('sin apalancamiento máximo conocido, la tasa plana', () => {
    expect(maintenanceMarginRateOf({ maxLeverage: 0 })).toBe(DEFAULT_MAINTENANCE_MARGIN_RATE);
  });
});

describe('maxLeverageWithinDistance', () => {
  it('es el mayor entero que deja el 5 % hasta la liquidación', () => {
    expect(maxLeverageWithinDistance(0.0125)).toBe(16);
    expect(maxLeverageWithinDistance(0.005)).toBe(18);
    expect(maxLeverageWithinDistance(0.05)).toBe(10);
  });

  it('nunca baja de 1x', () => {
    expect(maxLeverageWithinDistance(0.99)).toBe(1);
  });
});
