import {
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  apalancamientoPorStop,
  distanciaDesdeHoyALiquidacion,
  distanciaLiquidacion,
  HOLGURA_LIQUIDACION,
  ladoMasEstrecho,
  liquidationDistancePct,
  liquidationOfPosition,
  maintenanceMarginRateOf,
  maxApalancamientoConDistancia,
  perdidaEnLiquidacionPct,
  precioLiquidacion,
  stopMaximoRoi,
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

describe('maxApalancamientoConDistancia', () => {
  it('es el mayor entero que deja el 5 % hasta la liquidación EXACTA, lado a lado', () => {
    // Largo: 1/(m + 0,05·(1 − m)); corto: 1/(m + 0,05·(1 + m)).
    expect(maxApalancamientoConDistancia(0.0125, 'LONG')).toBe(16);
    expect(maxApalancamientoConDistancia(0.0125, 'SHORT')).toBe(15);
    expect(maxApalancamientoConDistancia(0.005, 'LONG')).toBe(18);
    expect(maxApalancamientoConDistancia(0.005, 'SHORT')).toBe(18);
    expect(maxApalancamientoConDistancia(0.05, 'LONG')).toBe(10);
    expect(maxApalancamientoConDistancia(0.05, 'SHORT')).toBe(9);
  });

  it('BTC en corto a 16× quedaba a un 4,94 %: con la exacta, el máximo es 15× (spec 079, F-07)', () => {
    expect(distanciaLiquidacion(16, 0.0125, 'SHORT').toNumber()).toBeLessThan(0.05);
    expect(distanciaLiquidacion(15, 0.0125, 'SHORT').toNumber()).toBeGreaterThanOrEqual(0.05);
  });

  it('el máximo cumple la distancia y el siguiente ya no (propiedad)', () => {
    for (let i = 1; i <= 400; i++) {
      const mmr = i / 10_000;
      for (const lado of ['LONG', 'SHORT'] as const) {
        const max = maxApalancamientoConDistancia(mmr, lado);
        if (max > 1) {
          expect(distanciaLiquidacion(max, mmr, lado).toNumber()).toBeGreaterThanOrEqual(
            0.05 - 1e-12,
          );
        }
        expect(distanciaLiquidacion(max + 1, mmr, lado).toNumber()).toBeLessThan(0.05);
      }
    }
  });

  it('nunca baja de 1x', () => {
    expect(maxApalancamientoConDistancia(0.99, 'LONG')).toBe(1);
    expect(maxApalancamientoConDistancia(0.99, 'SHORT')).toBe(1);
  });
});

describe('ladoMasEstrecho', () => {
  it('NEUTRAL se mide contra el corto, que liquida antes', () => {
    expect(ladoMasEstrecho('LONG')).toBe('LONG');
    expect(ladoMasEstrecho('SHORT')).toBe('SHORT');
    expect(ladoMasEstrecho('NEUTRAL')).toBe('SHORT');
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
        const d = distanciaLiquidacion(r.porStop, mmr, lado).toNumber();
        expect(d).toBeGreaterThanOrEqual(need - 1e-12);
      }
    }
  });
});

describe('precio de liquidación en aislado', () => {
  it('un largo 10× con mantenimiento del 1 %: E·(1 − 1/L)/(1 − mmr)', () => {
    // 100 · 0,9 / 0,99 = 90,9090…
    expect(precioLiquidacion('100', 10, 0.01, 'LONG')?.toFixed(4)).toBe('90.9091');
  });

  it('un corto 10× con mantenimiento del 1 %: E·(1 + 1/L)/(1 + mmr)', () => {
    // 100 · 1,1 / 1,01 = 108,9108…
    expect(precioLiquidacion('100', 10, 0.01, 'SHORT')?.toFixed(4)).toBe('108.9109');
  });

  it('la distancia del corto es la más estrecha de las dos', () => {
    const largo = distanciaLiquidacion(10, 0.01, 'LONG');
    const corto = distanciaLiquidacion(10, 0.01, 'SHORT');
    expect(corto.lt(largo)).toBe(true);
    // (0,1 − 0,01) / 1,01 = 0,0891…
    expect(corto.toFixed(4)).toBe('0.0891');
  });

  it('sin apalancamiento válido no hay liquidación', () => {
    expect(precioLiquidacion('100', 0, 0.01, 'LONG')).toBeNull();
  });

  it('el caso del spec 079: corto a 15× en BTC (mmr 1,25 %) desde 84601 liquida en 89127, no en 89184', () => {
    const liq = precioLiquidacion('84601', 15, 0.0125, 'SHORT');
    expect(liq?.toFixed(0)).toBe('89127');
    expect(distanciaLiquidacion(15, 0.0125, 'SHORT').mul(100).toFixed(2)).toBe('5.35');
  });

  it('un largo a 1× no se liquida', () => {
    expect(precioLiquidacion('100', 1, 0.01, 'LONG')).toBeNull();
  });
});

describe('el stop frente a la liquidación (spec 080)', () => {
  it('lo perdido del margen al liquidar: el 80,2 % a 15× en corto en BTC', () => {
    expect(perdidaEnLiquidacionPct(15, 0.0125, 'SHORT').toFixed(1)).toBe('80.2');
  });

  it('el stop más ancho con medio stop de holgura: 53,4 % del margen en el caso del 079', () => {
    // d = 5,3498 %; s ≤ d/1,5 = 3,5665 % del precio = 53,498 % del margen,
    // redondeado hacia abajo al paso del campo.
    expect(stopMaximoRoi(15, 0.0125, 'SHORT').toFixed()).toBe('53.4');
  });

  it('el stop propuesto siempre deja medio stop de holgura (propiedad)', () => {
    for (let L = 1; L <= 40; L++) {
      for (const mmr of [0.005, 0.0125, 0.025, 0.05]) {
        for (const lado of ['LONG', 'SHORT'] as const) {
          const d = distanciaLiquidacion(L, mmr, lado);
          if (!d.gt(0)) continue;
          const s = stopMaximoRoi(L, mmr, lado).div(L).div(100);
          expect(s.mul(1 + HOLGURA_LIQUIDACION).lte(d)).toBe(true);
        }
      }
    }
  });

  it('sin distancia a la liquidación no hay stop que proponer', () => {
    expect(stopMaximoRoi(100, 0.02, 'LONG').toFixed()).toBe('0');
  });
});

describe('liquidationDistancePct', () => {
  it('la distancia de una posición viva a su liquidación es siempre positiva', () => {
    expect(liquidationDistancePct(100, 50.5).toNumber()).toBeCloseTo(49.5, 9);
    expect(liquidationDistancePct(100, 119.5).toNumber()).toBeCloseTo(19.5, 9);
  });
});

describe('distanciaDesdeHoyALiquidacion (spec 080)', () => {
  const lado = (direction: 'LONG' | 'SHORT', fromRefPct: string | null) => ({
    direction,
    liquidation: fromRefPct === null ? null : { fromRefPct },
  });

  it('un largo mira hacia abajo y un corto hacia arriba', () => {
    expect(distanciaDesdeHoyALiquidacion([lado('LONG', '-12.50')])).toBe('12.50');
    // El corto del 079: 89126,9 desde 84601.
    expect(distanciaDesdeHoyALiquidacion([lado('SHORT', '5.35')])).toBe('5.35');
  });

  it('con dos lados manda la más cercana', () => {
    expect(distanciaDesdeHoyALiquidacion([lado('LONG', '-30.00'), lado('SHORT', '22.10')])).toBe(
      '22.10',
    );
  });

  it('una liquidación del lado del beneficio no se esconde con un valor absoluto (079/F-07)', () => {
    expect(distanciaDesdeHoyALiquidacion([lado('LONG', '3.00')])).toBe('-3.00');
  });

  it('sin liquidación en ningún lado, null', () => {
    expect(distanciaDesdeHoyALiquidacion([lado('LONG', null)])).toBeNull();
    expect(distanciaDesdeHoyALiquidacion([])).toBeNull();
  });
});

describe('liquidationOfPosition', () => {
  const base = { symbol: 'BTC', entryPrice: '100', leverage: 10, extraMargin: '0' };

  it('en aislado es la exacta con el apalancamiento de la posición', () => {
    const corto = { ...base, qty: '-1', marginMode: 'ISOLATED' as const };
    expect(liquidationOfPosition(corto, [corto], '1000', 0.01)?.toFixed(4)).toBe(
      precioLiquidacion('100', 10, 0.01, 'SHORT')?.toFixed(4),
    );
  });

  it('en cruzado usa el apalancamiento efectivo: con la cuenta detrás, el largo no se liquida', () => {
    const largo = { ...base, qty: '1', marginMode: 'CROSS' as const };
    // 100 de nocional con 1000 de cuenta: apalancamiento efectivo 0,1.
    expect(liquidationOfPosition(largo, [largo], '1000', 0.01)).toBeNull();
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
