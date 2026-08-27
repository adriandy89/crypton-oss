import {
  D,
  estimateLiquidationPrice,
  liquidationDistancePct,
  normalizeOrder,
} from '@crypton/shared';
import {
  arithmeticPrices,
  geometricPrices,
  geometricWeights,
  scaledLadder,
  stopLossPrice,
  takeProfitPrice,
  weightedAverage,
} from './ladder';
import { makeMarket } from './testing';

describe('arithmeticPrices', () => {
  it('reparte el rango en pasos iguales incluyendo ambos extremos', () => {
    const p = arithmeticPrices(100, 200, 5).map((x) => x.toNumber());
    expect(p).toEqual([100, 125, 150, 175, 200]);
  });

  it('devuelve un único precio cuando solo se pide un nivel', () => {
    expect(arithmeticPrices(100, 200, 1).map((x) => x.toNumber())).toEqual([100]);
  });
});

describe('geometricPrices', () => {
  it('mantiene constante la razón entre niveles consecutivos', () => {
    const p = geometricPrices(100, 400, 3);
    expect(p[0].toNumber()).toBe(100);
    expect(p[1].toNumber()).toBeCloseTo(200, 9);
    expect(p[2].toNumber()).toBeCloseTo(400, 9);
    // La propiedad que define una retícula geométrica: mismo % en cada salto.
    const r1 = p[1].div(p[0]).toNumber();
    const r2 = p[2].div(p[1]).toNumber();
    expect(r1).toBeCloseTo(r2, 12);
  });
});

describe('geometricWeights', () => {
  it('genera la progresión [1, s, s^2, ...]', () => {
    expect(geometricWeights(4, 2).map((x) => x.toNumber())).toEqual([1, 2, 4, 8]);
  });

  it('con escala 1 reparte por igual', () => {
    expect(geometricWeights(3, 1).map((x) => x.toNumber())).toEqual([1, 1, 1]);
  });
});

describe('scaledLadder', () => {
  // Caso calculado a mano:
  //   huecos    : 1 %, luego 1 % × 2 = 2 %  →  acumulado 0 %, 1 %, 3 %
  //   precios   : 100, 99, 97
  //   pesos     : 1, 2, 4  (suma 7)
  //   margen    : 70×1/7 = 10, 70×2/7 = 20, 70×4/7 = 40
  const ladder = scaledLadder({
    anchor: 100,
    safetyCount: 2,
    initialSeparationPct: 1,
    stepScale: 2,
    volumeScale: 2,
    totalMargin: 70,
    leverage: 1,
    direction: 'LONG',
  });

  it('coloca la base en el ancla y aleja cada seguridad por el stepScale', () => {
    expect(ladder.map((l) => l.price.toNumber())).toEqual([100, 99, 97]);
    expect(ladder.map((l) => l.distancePct.toNumber())).toEqual([0, 1, 3]);
  });

  it('reparte el margen según los pesos, sin superar el total', () => {
    expect(ladder.map((l) => l.margin.toNumber())).toEqual([10, 20, 40]);
    const sum = ladder.reduce((a, l) => a.plus(l.margin), D(0));
    expect(sum.toNumber()).toBe(70);
  });

  it('deriva la cantidad del notional al precio de cada nivel', () => {
    expect(ladder[0].qty.toNumber()).toBeCloseTo(0.1, 12);
    expect(ladder[1].qty.toNumber()).toBeCloseTo(20 / 99, 12);
    expect(ladder[2].qty.toNumber()).toBeCloseTo(40 / 97, 12);
  });

  it('en SHORT promedia hacia arriba: los niveles quedan por encima del ancla', () => {
    const short = scaledLadder({
      anchor: 100,
      safetyCount: 2,
      initialSeparationPct: 1,
      stepScale: 2,
      volumeScale: 2,
      totalMargin: 70,
      leverage: 1,
      direction: 'SHORT',
    });
    expect(short.map((l) => l.price.toNumber())).toEqual([100, 101, 103]);
  });

  it('multiplica el notional por el apalancamiento pero no el margen', () => {
    const lev5 = scaledLadder({
      anchor: 100,
      safetyCount: 1,
      initialSeparationPct: 1,
      stepScale: 1,
      volumeScale: 1,
      totalMargin: 100,
      leverage: 5,
      direction: 'LONG',
    });
    expect(lev5[0].margin.toNumber()).toBe(50);
    expect(lev5[0].notional.toNumber()).toBe(250);
  });
});

describe('weightedAverage', () => {
  it('pondera por cantidad, no por número de operaciones', () => {
    const avg = weightedAverage([
      { price: 100, qty: 1 },
      { price: 90, qty: 3 },
    ]);
    expect(avg!.toNumber()).toBe(92.5);
  });

  it('devuelve null sin cantidad', () => {
    expect(weightedAverage([])).toBeNull();
    expect(weightedAverage([{ price: 100, qty: 0 }])).toBeNull();
  });
});

describe('takeProfitPrice / stopLossPrice', () => {
  it('LONG sale por encima y para pérdidas por debajo', () => {
    expect(takeProfitPrice(100, 2, 'LONG').toNumber()).toBe(102);
    expect(stopLossPrice(100, 5, 'LONG').toNumber()).toBe(95);
  });

  it('SHORT es el espejo exacto', () => {
    expect(takeProfitPrice(100, 2, 'SHORT').toNumber()).toBe(98);
    expect(stopLossPrice(100, 5, 'SHORT').toNumber()).toBe(105);
  });
});

describe('estimateLiquidationPrice', () => {
  it('a 2x un LONG liquida cerca del 50 % de caída', () => {
    expect(estimateLiquidationPrice(100, 2, 'LONG', 0.005)!.toNumber()).toBeCloseTo(50.5, 9);
  });

  it('a 5x un SHORT liquida cerca del 20 % de subida', () => {
    expect(estimateLiquidationPrice(100, 5, 'SHORT', 0.005)!.toNumber()).toBeCloseTo(119.5, 9);
  });

  it('sin apalancamiento válido no inventa un número', () => {
    expect(estimateLiquidationPrice(100, 0, 'LONG')).toBeNull();
    expect(estimateLiquidationPrice(0, 2, 'LONG')).toBeNull();
  });

  it('la distancia a liquidación es siempre positiva', () => {
    expect(liquidationDistancePct(100, 50.5).toNumber()).toBeCloseTo(49.5, 9);
    expect(liquidationDistancePct(100, 119.5).toNumber()).toBeCloseTo(19.5, 9);
  });
});

describe('normalizeOrder', () => {
  const market = makeMarket({ tickSize: '0.5', stepSize: '0.001', minNotional: '10' });

  it('una compra redondea el precio hacia abajo y una venta hacia arriba', () => {
    expect(normalizeOrder(market, '100.3', '1', 'BUY').price.toNumber()).toBe(100);
    expect(normalizeOrder(market, '100.3', '1', 'SELL').price.toNumber()).toBe(100.5);
  });

  it('la cantidad siempre se trunca: nunca pide más margen del previsto', () => {
    expect(normalizeOrder(market, '100', '1.9999', 'BUY').qty.toNumber()).toBe(1.999);
  });

  it('explica el motivo cuando el venue rechazaría la orden', () => {
    const tiny = normalizeOrder(market, '100', '0.05', 'BUY');
    expect(tiny.violations.join(' ')).toContain('Notional');

    const zero = normalizeOrder(market, '100', '0.0004', 'BUY');
    expect(zero.violations.join(' ')).toContain('cantidad queda en 0');
  });

  it('una orden válida no genera avisos', () => {
    expect(normalizeOrder(market, '100', '1', 'BUY').violations).toEqual([]);
  });
});
