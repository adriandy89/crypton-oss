import { D, normalizeOrder } from '@crypton/shared';
import {
  arithmeticPrices,
  geometricPrices,
  geometricWeights,
  recorridoPeorCaso,
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

describe('takeProfitPrice / stopLossPrice (% del margen, spec 080)', () => {
  it('a 1× el % del margen es el % del precio', () => {
    expect(takeProfitPrice(100, 2, 1, 'LONG').toNumber()).toBe(102);
    expect(stopLossPrice(100, 5, 1, 'LONG').toNumber()).toBe(95);
  });

  it('a 5× un 10 % del margen es un 2 % del precio', () => {
    expect(takeProfitPrice(100, 10, 5, 'LONG').toNumber()).toBe(102);
    expect(stopLossPrice(100, 10, 5, 'LONG').toNumber()).toBe(98);
  });

  it('SHORT es el espejo exacto', () => {
    expect(takeProfitPrice(100, 10, 5, 'SHORT').toNumber()).toBe(98);
    expect(stopLossPrice(100, 10, 5, 'SHORT').toNumber()).toBe(102);
  });

  it('el caso del spec 079: corto a 15× desde 84601, con los valores de fábrica nuevos', () => {
    // Objetivo 30 % del margen = 2 % del precio; stop 10 % = 0,667 %.
    expect(takeProfitPrice('84601', 30, 15, 'SHORT').toFixed(2)).toBe('82908.98');
    expect(stopLossPrice('84601', 10, 15, 'SHORT').toFixed(2)).toBe('85165.01');
  });
});

describe('recorridoPeorCaso', () => {
  // Largo desde 100 con cuatro niveles iguales cada 10 %.
  const niveles = [100, 90, 80, 70].map((p) => ({ price: p, qty: 1 }));

  it('a 1× sin stop se llena entera', () => {
    const r = recorridoPeorCaso(niveles, 'LONG', 1, 0.01);
    expect(r.llenos).toBe(4);
    expect(r.corte).toBeNull();
    expect(r.media?.toNumber()).toBe(85);
  });

  it('la liquidación de la media corta la escalera antes de un nivel', () => {
    // A 10× con mantenimiento del 1 %: tras llenar 100, 95 y 90 la media es 95
    // y liquida en 95·0,9/0,99 = 86,36, por encima del nivel de 85. Con la media
    // de antes (97,5) aún pasaba por 90: la liquidación se mueve con la media.
    const escalonada = [100, 95, 90, 85].map((p) => ({ price: p, qty: 1 }));
    const r = recorridoPeorCaso(escalonada, 'LONG', 10, 0.01);
    expect(r.llenos).toBe(3);
    expect(r.corte).toEqual({ nivel: 3, por: 'LIQUIDACION' });
  });

  it('un stop que salta antes que el siguiente nivel también la corta', () => {
    // A 2× un stop del 10 % del margen es un 5 % del precio: desde 100 salta en
    // 95, antes del nivel de 90.
    const r = recorridoPeorCaso(niveles, 'LONG', 2, 0.01, '10');
    expect(r.llenos).toBe(1);
    expect(r.corte).toEqual({ nivel: 1, por: 'STOP' });
  });

  it('entre stop y liquidación manda el que el precio toca primero', () => {
    // A 10× desde 100 la liquidación queda en 90,91 (un 9,09 %). Un stop del
    // 90 % del margen (9 % del precio, en 91) salta antes que ella; uno del
    // 95 % (9,5 %, en 90,5) queda detrás, y quien corta es la liquidación.
    expect(recorridoPeorCaso(niveles, 'LONG', 10, 0.01, '90').corte?.por).toBe('STOP');
    expect(recorridoPeorCaso(niveles, 'LONG', 10, 0.01, '95').corte?.por).toBe('LIQUIDACION');
  });

  it('en corto recorre hacia arriba', () => {
    // Tras 100, 105 y 110 la media es 105 y liquida en 105·1,1/1,01 = 114,36,
    // antes del nivel de 115.
    const cortos = [100, 105, 110, 115].map((p) => ({ price: p, qty: 1 }));
    const r = recorridoPeorCaso(cortos, 'SHORT', 10, 0.01);
    expect(r.llenos).toBe(3);
    expect(r.corte).toEqual({ nivel: 3, por: 'LIQUIDACION' });
  });

  describe('el tope de exposición, como lo aplica el plan', () => {
    // El plan tiende un nivel si lo abierto, valorado al precio de AHORA, más
    // el nocional del nivel caben en el tope. Cuanto más cae el precio, menos
    // vale lo abierto: lo más tarde que puede tenderse el nivel k es justo
    // encima de su precio, y entonces la condición es que la posición que deja,
    // valorada a ese precio, quepa. Es la cota del peor caso.
    it('un nivel entra si la posición que deja, a su precio, cabe en el tope', () => {
      // 1×100 = 100; 2×90 = 180; 3×80 = 240; 4×70 = 280. Con un tope de 250
      // entran tres, aunque sus nocionales sumen 270: al llegar a 80, lo
      // comprado a 100 y a 90 ya solo vale 160.
      const r = recorridoPeorCaso(niveles, 'LONG', 1, 0.01, null, { nocional: '250' });
      expect(r.llenos).toBe(3);
      expect(r.corte).toEqual({ nivel: 3, por: 'TOPE' });
      expect(r.qty.toNumber()).toBe(3);
    });

    it('desde qué nivel manda: la base de una escalera entra sin mirarlo', () => {
      const conBase = recorridoPeorCaso(niveles, 'LONG', 1, 0.01, null, {
        nocional: '50',
        desde: 1,
      });
      expect(conBase.llenos).toBe(1);
      expect(conBase.corte).toEqual({ nivel: 1, por: 'TOPE' });
      const sinBase = recorridoPeorCaso(niveles, 'LONG', 1, 0.01, null, { nocional: '50' });
      expect(sinBase.llenos).toBe(0);
      expect(sinBase.media).toBeNull();
    });

    it('un nivel que el tope no deja tender no existe: la liquidación no lo corta', () => {
      // A 10× la liquidación llega antes que el nivel 3 (85). Con un tope de
      // 300, ese nivel no se tiende (4×85 = 340): el corte es del tope, y la
      // validación no rechaza una escalera que el tope ya acorta.
      const escalonada = [100, 95, 90, 85].map((p) => ({ price: p, qty: 1 }));
      expect(
        recorridoPeorCaso(escalonada, 'LONG', 10, 0.01, null, { nocional: '300' }).corte,
      ).toEqual({ nivel: 3, por: 'TOPE' });
      // Si el tope lo deja, manda la liquidación.
      expect(
        recorridoPeorCaso(escalonada, 'LONG', 10, 0.01, null, { nocional: '1000' }).corte,
      ).toEqual({ nivel: 3, por: 'LIQUIDACION' });
    });

    it('en corto, con la posición valorada al precio de cada nivel hacia arriba', () => {
      // 100, 2×105 = 210, 3×110 = 330: con un tope de 300 se queda en dos.
      const cortos = [100, 105, 110, 115].map((p) => ({ price: p, qty: 1 }));
      const r = recorridoPeorCaso(cortos, 'SHORT', 1, 0.01, null, { nocional: '300' });
      expect(r.corte).toEqual({ nivel: 2, por: 'TOPE' });
    });

    it('sin tope o con tope cero, nada cambia', () => {
      expect(recorridoPeorCaso(niveles, 'LONG', 1, 0.01, null, null).llenos).toBe(4);
      expect(recorridoPeorCaso(niveles, 'LONG', 1, 0.01, null, { nocional: '0' }).llenos).toBe(4);
    });
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
