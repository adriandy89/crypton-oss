import {
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  apalancamientoPorStop,
  distanciaLiquidacionAislada,
  maintenanceMarginRateOf,
  maxLeverageWithinDistance,
  precioLiquidacionAislada,
  tramoDeApalancamiento,
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

/**
 * La regla de apalancamiento por stop del canal (spec 058).
 *
 * Las cifras están calculadas a mano con `mmr = 0,0125` (BTC a 40×):
 * `Lstop = floor(1 / (mmr + need · (1 + mmr)))`.
 */
describe('apalancamientoPorStop', () => {
  const base = { liqBufferStops: 3, mantenimiento: 0.0125, topes: [25, 40] };

  it('con un stop del 0,5 % manda el tope de 25×', () => {
    // need = max(3 · 0,005, 3 · 0,004) = 0,015
    // Lstop = floor(1 / (0,0125 + 0,015 · 1,0125)) = floor(36,117…) = 36
    const r = apalancamientoPorStop({ ...base, distanciaStop: '0.005', atr1hRelativo: '0.004' });
    expect(r.necesaria.toFixed()).toBe('0.015');
    expect(r.porStop).toBe(36);
    expect(r.maximo).toBe(25);
  });

  it('un stop más ancho da menos apalancamiento', () => {
    // need = 0,045 → floor(1 / 0,0580625) = floor(17,22…) = 17
    const r = apalancamientoPorStop({ ...base, distanciaStop: '0.015', atr1hRelativo: '0.004' });
    expect(r.porStop).toBe(17);
    expect(r.maximo).toBe(17);
  });

  it('manda el ATR de 1 h cuando el stop es más estrecho que su triple', () => {
    // need = max(0,006, 0,03) = 0,03 → floor(1 / 0,042875) = floor(23,32…) = 23
    const r = apalancamientoPorStop({ ...base, distanciaStop: '0.002', atr1hRelativo: '0.01' });
    expect(r.necesaria.toFixed()).toBe('0.03');
    expect(r.porStop).toBe(23);
  });

  it('un colchón por debajo de 3 stops se sube a 3: la regla solo endurece', () => {
    const blando = apalancamientoPorStop({
      ...base,
      liqBufferStops: 1,
      distanciaStop: '0.005',
      atr1hRelativo: '0.001',
    });
    const tres = apalancamientoPorStop({ ...base, distanciaStop: '0.005', atr1hRelativo: '0.001' });
    expect(blando).toEqual(tres);
  });

  it('un tope con decimales se redondea hacia abajo: nunca más apalancamiento del permitido', () => {
    const r = apalancamientoPorStop({
      ...base,
      topes: [12.9, 40],
      distanciaStop: '0.005',
      atr1hRelativo: '0.004',
    });
    expect(r.porStop).toBe(36);
    expect(r.maximo).toBe(12);
  });

  it('si ni a 1× cabe, es inviable', () => {
    const r = apalancamientoPorStop({ ...base, distanciaStop: '0.5', atr1hRelativo: '0.01' });
    expect(r.porStop).toBe(0);
    expect(r.maximo).toBe(0);
  });

  it('la liquidación queda a la distancia pedida en los dos lados (propiedad)', () => {
    let semilla = 7;
    const azar = () => {
      semilla = (semilla * 16807) % 2147483647;
      return semilla / 2147483647;
    };
    for (let i = 0; i < 2000; i++) {
      const s = 0.0005 + azar() * 0.05;
      const atr = 0.001 + azar() * 0.05;
      const mmr = 0.002 + azar() * 0.05;
      const r = apalancamientoPorStop({
        liqBufferStops: 3,
        mantenimiento: mmr,
        topes: [1000],
        distanciaStop: String(s),
        atr1hRelativo: String(atr),
      });
      if (r.porStop < 1) continue;
      const need = Math.max(3 * s, 3 * atr);
      for (const lado of ['LONG', 'SHORT'] as const) {
        const d = distanciaLiquidacionAislada(r.porStop, mmr, lado).toNumber();
        expect(d).toBeGreaterThanOrEqual(need - 1e-12);
      }
    }
  });
});

describe('precio de liquidación en aislado', () => {
  it('un largo 10× con mantenimiento del 1 %: E·(1 − 1/L)/(1 − mmr)', () => {
    // 100 · 0,9 / 0,99 = 90,9090…
    expect(precioLiquidacionAislada('100', 10, 0.01, 'LONG')?.toFixed(4)).toBe('90.9091');
  });

  it('un corto 10× con mantenimiento del 1 %: E·(1 + 1/L)/(1 + mmr)', () => {
    // 100 · 1,1 / 1,01 = 108,9108…
    expect(precioLiquidacionAislada('100', 10, 0.01, 'SHORT')?.toFixed(4)).toBe('108.9109');
  });

  it('la distancia del corto es la más estrecha de las dos', () => {
    const largo = distanciaLiquidacionAislada(10, 0.01, 'LONG');
    const corto = distanciaLiquidacionAislada(10, 0.01, 'SHORT');
    expect(corto.lt(largo)).toBe(true);
    // (0,1 − 0,01) / 1,01 = 0,0891…
    expect(corto.toFixed(4)).toBe('0.0891');
  });

  it('sin apalancamiento válido no hay liquidación', () => {
    expect(precioLiquidacionAislada('100', 0, 0.01, 'LONG')).toBeNull();
  });
});

describe('tramoDeApalancamiento', () => {
  const tramos = [
    { desdeNocional: '0', maxApalancamiento: 40, mantenimiento: 0.0125 },
    { desdeNocional: '150000000', maxApalancamiento: 20, mantenimiento: 0.025 },
  ];

  it('elige el tramo del nocional', () => {
    expect(tramoDeApalancamiento(tramos, '1000', 50, 0.01).maxApalancamiento).toBe(40);
    expect(tramoDeApalancamiento(tramos, '200000000', 50, 0.01).maxApalancamiento).toBe(20);
  });

  it('sin tramos, el del mercado', () => {
    expect(tramoDeApalancamiento([], '1000', 50, 0.01)).toEqual({
      desdeNocional: '0',
      maxApalancamiento: 50,
      mantenimiento: 0.01,
    });
  });
});
