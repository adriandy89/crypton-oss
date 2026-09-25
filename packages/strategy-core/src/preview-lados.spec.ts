import {
  ActivationMode,
  D,
  LevelKind,
  StrategyKind,
  type BotConfig,
  type PreviewResult,
  type PreviewSide,
} from '@crypton/shared';
import { getStrategy, listStrategies } from './registry';
import { BASE_CONFIG, CONFIG_MINIMA, makeMarket } from './testing';

/**
 * La previsualización por lado del spec 080: lo que la pantalla Revisión
 * enseña antes de crear un bot, con los números de un exchange —precio,
 * movimiento, resultado en USDC y % sobre el margen— para el objetivo, el stop
 * y la liquidación de cada lado.
 */

const conDefaults = (kind: StrategyKind, extra: Record<string, unknown> = {}): BotConfig => ({
  ...BASE_CONFIG,
  ...getStrategy(kind).defaults(),
  ...CONFIG_MINIMA[kind],
  ...extra,
});

const lado = (p: PreviewResult, direction: 'LONG' | 'SHORT'): PreviewSide => {
  const s = p.sides.find((x) => x.direction === direction);
  if (!s) throw new Error(`sin lado ${direction}: ${JSON.stringify(p.issues)}`);
  return s;
};

describe('CA-1: el corto a 15× del usuario (079)', () => {
  // BTC con 40× de máximo: mantenimiento 1,25 %. 120 USDC a 15× son 1800 de
  // nocional: 0,02127 BTC a 84601.
  const market = makeMarket();
  const trailing = getStrategy(StrategyKind.TRAILING_PROFIT);
  const config = (extra: Record<string, unknown> = {}) =>
    conDefaults(StrategyKind.TRAILING_PROFIT, {
      direction: 'SHORT',
      leverage: 15,
      marginMode: 'ISOLATED',
      totalInvestment: '120',
      ...extra,
    });

  const p = trailing.preview(config(), market, '84601');
  const corto = lado(p, 'SHORT');

  it('la posición: una entrada, 0,02127 BTC, 119,96 de margen', () => {
    expect(p.valid).toBe(true);
    expect(p.sides).toHaveLength(1);
    expect(p.leverage).toBe(15);
    expect(p.marginMode).toBe('ISOLATED');
    expect(corto.entries).toBe(1);
    expect(corto.averageEntry).toBe('84601.0');
    expect(corto.qty).toBe('0.02127');
    expect(corto.notional).toBe('1799.46');
    // Lo que retiene el venue: el nocional de la orden ya redondeada entre el
    // apalancamiento. De los 120 asignados, la cantidad al paso de 0,00001 BTC
    // deja 0,04 sin usar; margen y nocional ya no se contradicen.
    expect(corto.margin).toBe('119.96');
    expect(p.levels[0].marginUsed).toBe('119.96');
    expect(corto.cutAt).toBeNull();
  });

  it('en cada nivel, el margen es su nocional entre el apalancamiento', () => {
    // El caso que lo destapó: un market maker a 1× enseñaba 35,00 de margen al
    // lado de 33,81 de nocional, porque el margen salía del tamaño configurado
    // y el nocional de la cantidad ya redondeada.
    for (const s of listStrategies()) {
      const r = s.preview(conDefaults(s.kind, { leverage: 3 }), makeMarket(), '100');
      for (const l of r.levels.filter((x) => D(x.marginUsed).gt(0))) {
        expect({ kind: s.kind, nivel: l.index, margen: l.marginUsed }).toEqual({
          kind: s.kind,
          nivel: l.index,
          margen: D(l.notional).div(r.leverage).toFixed(2),
        });
      }
    }
  });

  it('la liquidación EXACTA del corto: 89126,9, a un 5,35 %, −96,27 USDC (−80,25 % del margen)', () => {
    // E(1 + 1/L)/(1 + m) = 89126,98, y una recompra redondea a la baja. La
    // pantalla del usuario decía 89184 (la lineal), «aguanta 5,60 %» (desde el
    // precio de hoy) y «~6,7 %» (100/L): tres distancias para una liquidación.
    // El precio SUBE un 5,35 % y el corto pierde: el movimiento va con el signo
    // del precio y el del resultado dice si es en contra.
    const liq = corto.liquidation!;
    expect(liq.price).toBe('89126.9');
    expect(liq.movePct).toBe('5.35');
    expect(liq.fromRefPct).toBe('5.35');
    expect(liq.qty).toBe('0.02127');
    expect(liq.pnl).toBe('-96.27');
    expect(liq.roiPct).toBe('-80.25');
    expect(corto.liquidationIsBound).toBe(false);
  });

  it('el stop de fábrica, un 10 % del margen: 85165, −12,00 USDC', () => {
    // A 15× un 10 % del margen es un 0,667 % del precio.
    const stop = corto.stopLoss!;
    expect(stop.price).toBe('85165.0');
    expect(stop.movePct).toBe('0.67');
    expect(stop.pnl).toBe('-12.00');
    expect(stop.roiPct).toBe('-10.00');
    expect(corto.stopLossEstimated).toBe(false);
  });

  it('el objetivo de fábrica, un 30 % del margen: 82908,9, +35,99 USDC, y es donde empieza a seguir', () => {
    // Antes: «Objetivo de beneficio 71911», un 15 % del PRECIO, que a 15× es un
    // +225 % del margen.
    const tp = corto.takeProfit!;
    expect(tp.price).toBe('82908.9');
    expect(tp.movePct).toBe('-2.00');
    expect(tp.fromRefPct).toBe('-2.00');
    expect(tp.pnl).toBe('35.99');
    expect(tp.roiPct).toBe('30.00');
    expect(corto.takeProfitIsActivation).toBe(true);
  });

  it('beneficio/riesgo en precio: 1692,1 hasta el objetivo entre 564 hasta el stop', () => {
    expect(corto.rewardRisk).toBe('3.00');
  });

  it('un stop del 90 % es un error y propone el más ancho sin aviso, 53,4 %', () => {
    const malo = trailing.preview(config({ stopLossPct: '90' }), market, '84601');
    expect(malo.valid).toBe(false);
    const issue = malo.issues.find((i) => i.field === 'stopLossPct');
    expect(issue?.severity).toBe('ERROR');
    expect(issue?.suggestedValue).toBe('53.4');
  });

  it('y con esa propuesta el stop queda en 87612,7, a −64,06 USDC, sin aviso', () => {
    const bueno = trailing.preview(config({ stopLossPct: '53.4' }), market, '84601');
    const stop = lado(bueno, 'SHORT').stopLoss!;
    expect(stop.price).toBe('87612.7');
    expect(stop.pnl).toBe('-64.06');
    expect(stop.roiPct).toBe('-53.40');
    expect(bueno.issues.filter((i) => i.field === 'stopLossPct')).toEqual([]);
  });
});

describe('todas las estrategias enseñan su stop y su liquidación del lado correcto', () => {
  // A 3×, para que cada lado tenga liquidación.
  for (const s of listStrategies()) {
    it(s.kind, () => {
      const p = s.preview(
        conDefaults(s.kind, { leverage: 3, stopLossPct: '10' }),
        makeMarket(),
        '100',
      );
      expect({
        kind: s.kind,
        valid: p.valid,
        errores: p.issues.filter((i) => i.severity === 'ERROR'),
      }).toEqual({ kind: s.kind, valid: true, errores: [] });
      expect(p.sides.length).toBeGreaterThan(0);
      for (const side of p.sides) {
        const largo = side.direction === 'LONG';
        expect(side.stopLoss).not.toBeNull();
        expect(D(side.stopLoss!.pnl).lt(0)).toBe(true);
        expect(side.liquidation).not.toBeNull();
        const liq = D(side.liquidation!.price);
        expect(largo ? liq.lt(side.averageEntry) : liq.gt(side.averageEntry)).toBe(true);
        expect(D(side.liquidation!.pnl).lt(0)).toBe(true);
        if (side.takeProfit) expect(D(side.takeProfit.pnl).gt(0)).toBe(true);
      }
    });
  }
});

describe('rejilla neutral: un bloque por lado (079/F-10, F-11)', () => {
  const neutral = getStrategy(StrategyKind.NEUTRAL_GRID);
  const config = (direction: string) =>
    conDefaults(StrategyKind.NEUTRAL_GRID, { direction, leverage: 3 });

  it('las compras son el largo y las ventas el corto, cada uno con su media y su liquidación', () => {
    const p = neutral.preview(config('NEUTRAL'), makeMarket(), '100');
    const largo = lado(p, 'LONG');
    const corto = lado(p, 'SHORT');
    expect(D(largo.averageEntry).lt(100)).toBe(true);
    expect(D(corto.averageEntry).gt(100)).toBe(true);
    expect(D(largo.liquidation!.price).lt(largo.averageEntry)).toBe(true);
    expect(D(corto.liquidation!.price).gt(corto.averageEntry)).toBe(true);
    // Lo que comprometen todas las órdenes es la suma; cada posición, la suya.
    const compras = p.levels.filter((l) => l.side === 'BUY');
    expect(largo.entries).toBe(compras.length);
    expect(D(largo.notional).plus(corto.notional).toFixed(2)).toBe(p.worstCaseNotional);
  });

  it('en SHORT la liquidación ya no sale de la media de las compras', () => {
    // La dirección no sesga la retícula neutral: los dos lados son los mismos.
    const corto = neutral.preview(config('SHORT'), makeMarket(), '100');
    const neutro = neutral.preview(config('NEUTRAL'), makeMarket(), '100');
    expect(corto.sides).toEqual(neutro.sides);
  });
});

describe('la escalera se corta donde el stop o la liquidación llegan antes', () => {
  const martingala = getStrategy(StrategyKind.MARTINGALE);

  it('por la liquidación: en cruzado se enseña, cortada, con el nivel que no llega', () => {
    // Volumen constante y separaciones 2, 3 y 4,5 %: a 15× la media de los tres
    // primeros niveles liquida antes de la tercera seguridad.
    const p = martingala.preview(
      conDefaults(StrategyKind.MARTINGALE, {
        leverage: 15,
        marginMode: 'CROSS',
        volumeScale: '1',
        initialSeparationPct: '2',
        stepScale: '1.5',
      }),
      makeMarket(),
      '100',
    );
    const largo = lado(p, 'LONG');
    expect(largo.cutAt).toEqual({ level: 3, by: 'LIQUIDACION' });
    expect(largo.entries).toBe(3);
    expect(largo.liquidationIsBound).toBe(true);
    const tercera = p.levels.find((l) => l.index === 3)!;
    expect(D(largo.liquidation!.price).gt(tercera.price)).toBe(true);
  });

  it('por el stop: lo que queda detrás no se cuenta en la posición', () => {
    // A 2× un 4 % del margen es un 2 % del precio desde la media: con la de las
    // tres primeras entradas salta antes que la tercera seguridad (96,3).
    const p = martingala.preview(
      conDefaults(StrategyKind.MARTINGALE, { leverage: 2, stopLossPct: '4' }),
      makeMarket(),
      '100',
    );
    const largo = lado(p, 'LONG');
    expect(largo.cutAt).toEqual({ level: 3, by: 'STOP' });
    expect(largo.entries).toBe(3);
    const siguiente = p.levels.find((l) => l.index === largo.cutAt!.level)!;
    expect(D(largo.stopLoss!.price).gt(siguiente.price)).toBe(true);
    const dentro = p.levels.filter((l) => l.index < largo.cutAt!.level);
    const qty = dentro.reduce((s, l) => s.plus(l.qty), D(0));
    expect(largo.qty).toBe(qty.toFixed(5));
  });
});

describe('GridMart: el satélite es todo menos el núcleo (079/F-02, F-24)', () => {
  const gm = getStrategy(StrategyKind.GRIDMART);

  it('si el stop corta antes de la primera seguridad, no hay satélite que vender', () => {
    // A 2× un 1 % del margen es un 0,5 % del precio: salta antes de la
    // primera seguridad, a un 1 %.
    const p = gm.preview(
      conDefaults(StrategyKind.GRIDMART, { leverage: 2, stopLossPct: '1' }),
      makeMarket(),
      '100',
    );
    const largo = lado(p, 'LONG');
    expect(largo.cutAt).toEqual({ level: 1, by: 'STOP' });
    expect(largo.takeProfit).toBeNull();
  });

  it('el punto de equilibrio sale de los niveles ya redondeados', () => {
    const p = gm.preview(conDefaults(StrategyKind.GRIDMART), makeMarket(), '100');
    const entradas = p.levels.filter(
      (l) => l.kind === LevelKind.BASE || l.kind === LevelKind.SAFETY,
    );
    const num = entradas.reduce((s, l) => s.plus(D(l.price).mul(l.qty)), D(0));
    const qty = entradas.reduce((s, l) => s.plus(l.qty), D(0));
    expect(lado(p, 'LONG').averageEntry).toBe(num.div(qty).toFixed(1));
  });
});

describe('TDCA proyecta cada compra contra la MEDIA, como el plan (079/F-12)', () => {
  it('con un 2 %: 100, 98 y 97, no 96,04', () => {
    // La tercera compra exige mejorar un 2 % la media de 100 y 98 (98,99):
    // 97,01, y una compra redondea a la baja.
    const p = getStrategy(StrategyKind.TDCA).preview(
      conDefaults(StrategyKind.TDCA, {
        amountPerBuy: '10',
        maxBuysPerCycle: 3,
        marginBelowAveragePct: '2',
      }),
      makeMarket(),
      '100',
    );
    expect(p.levels.map((l) => l.price)).toEqual(['100.0', '98.0', '97.0']);
  });

  // Los topes de posición: `plan()` deja de comprar al llegar y recorta a lo que
  // cabe la compra que no entra entera, midiendo lo abierto a la marca. La vista
  // previa enseñaba las cinco compras aunque el bot se fuera a parar en la
  // tercera (encontrado al rehacer la guía del DCA con el 080).
  const conTope = (extra: Record<string, unknown>) =>
    getStrategy(StrategyKind.TDCA).preview(
      conDefaults(StrategyKind.TDCA, {
        amountPerBuy: '100',
        maxBuysPerCycle: 5,
        marginBelowAveragePct: '2',
        ...extra,
      }),
      makeMarket(),
      '100',
    );

  it('sin tope, las cinco compras', () => {
    expect(conTope({}).levels).toHaveLength(5);
  });

  it('con tope de 250: dos enteras y la tercera recortada a lo que cabe a su precio', () => {
    // A 97,01 lo abierto (2,0204 BTC) vale 196,0: caben 54,0, y la cuarta ya
    // no llegaría al mínimo de 10 del venue.
    const p = conTope({ maxPositionNotional: '250' });
    expect(p.levels.map((l) => l.notional)).toEqual(['100.00', '100.00', '53.99']);
    expect(p.worstCaseNotional).toBe('253.99');
  });

  it('manda el menor de los dos topes, el propio o el común', () => {
    const p = conTope({ maxPositionNotional: '400', maxNotionalCap: '250' });
    expect(p.levels.map((l) => l.notional)).toEqual(['100.00', '100.00', '53.99']);
  });

  it('un recorte que no llega al mínimo del venue no se enseña', () => {
    // Con 205 quedarían 9,0 para la tercera: el motor no la mandaría.
    expect(conTope({ maxPositionNotional: '205' }).levels).toHaveLength(2);
  });
});

describe('el tope de exposición: la Revisión lo aplica como el plan', () => {
  // El plan tiende un nivel si lo abierto, valorado al precio de ahora, más el
  // nivel caben en el tope. La Revisión enseñaba la escalera entera aunque el
  // bot se fuera a parar en él (encontrado al rehacer las guías del 080).
  it('martingala: la base entra sin mirarlo, y las seguridades mientras quepan', () => {
    const m = getStrategy(StrategyKind.MARTINGALE);
    const sin = m.preview(
      conDefaults(StrategyKind.MARTINGALE, { leverage: 2 }),
      makeMarket(),
      '100',
    );
    const con = m.preview(
      conDefaults(StrategyKind.MARTINGALE, { leverage: 2, maxNotionalCap: '1500' }),
      makeMarket(),
      '100',
    );
    expect(lado(sin, 'LONG').entries).toBe(7);
    expect(sin.worstCaseNotional).toBe('1998.86');
    expect(lado(con, 'LONG')).toMatchObject({
      entries: 6,
      notional: '1220.45',
      cutAt: { level: 6, by: 'TOPE' },
    });
    // La sexta seguridad no se coloca nunca: tampoco cuenta en «todas las órdenes».
    expect(con.worstCaseNotional).toBe('1220.45');
  });

  it('rejilla clásica: las líneas de la más cercana hacia fuera', () => {
    // Barrida desde arriba: 110 y 105 caben (≈ 391 a 105); con la de 100, lo
    // comprado valdría 572.
    const p = getStrategy(StrategyKind.GRID_CLASSIC).preview(
      conDefaults(StrategyKind.GRID_CLASSIC, { leverage: 1, maxNotionalCap: '500' }),
      makeMarket(),
      '100',
    );
    expect(lado(p, 'LONG')).toMatchObject({
      entries: 2,
      notional: '400.00',
      cutAt: { level: 2, by: 'TOPE' },
    });
    expect(p.worstCaseNotional).toBe('400.00');
  });

  it('rejilla neutral: cada lado con su tope, sin sumar el otro', () => {
    const p = getStrategy(StrategyKind.NEUTRAL_GRID).preview(
      conDefaults(StrategyKind.NEUTRAL_GRID, { leverage: 1, maxExposure: '300' }),
      makeMarket(),
      '100',
    );
    expect(lado(p, 'LONG')).toMatchObject({ entries: 1, cutAt: { level: 1, by: 'TOPE' } });
    expect(lado(p, 'SHORT')).toMatchObject({ entries: 1, cutAt: { level: 4, by: 'TOPE' } });
    expect(p.worstCaseNotional).toBe('399.96');
  });
});

describe('market makers: los mismos suelos y topes que el plan (079/F-14)', () => {
  const fino = makeMarket({ tickSize: '0.01', priceDecimals: 2 });

  it('V1: el suelo de distancia manda sobre el perfil agresivo', () => {
    // 10 bps × 0,7 son 7, por debajo del suelo de 8: el plan cotiza a 8.
    const p = getStrategy(StrategyKind.MARKET_MAKER).preview(
      conDefaults(StrategyKind.MARKET_MAKER, {
        riskProfile: 'AGGRESSIVE',
        buyDistanceBps: '10',
        sellDistanceBps: '10',
        minAllowedDistanceBps: '8',
        layers: 1,
      }),
      fino,
      '100',
    );
    expect(p.levels.find((l) => l.side === 'BUY')?.price).toBe('99.92');
    expect(p.levels.find((l) => l.side === 'SELL')?.price).toBe('100.08');
  });

  it('V1: una capa que no cabe en el tope de su lado no se enseña', () => {
    const p = getStrategy(StrategyKind.MARKET_MAKER).preview(
      conDefaults(StrategyKind.MARKET_MAKER, {
        layers: 2,
        layerSizeMultiplier: '1',
        maxLongPosition: '60',
      }),
      makeMarket(),
      '100',
    );
    expect(p.levels.filter((l) => l.side === 'BUY')).toHaveLength(1);
    expect(p.levels.filter((l) => l.side === 'SELL')).toHaveLength(2);
    expect(D(lado(p, 'LONG').notional).lte(60)).toBe(true);
  });

  it('V1: capas que el tick junta en el mismo precio son una', () => {
    // 25, 25,25 y 25,5 bps desde 100 caen las tres en 99,7 y en 100,3.
    const p = getStrategy(StrategyKind.MARKET_MAKER).preview(
      conDefaults(StrategyKind.MARKET_MAKER, {
        layers: 3,
        layerDistanceMultiplier: '1.01',
        buyDistanceBps: '25',
        sellDistanceBps: '25',
      }),
      makeMarket(),
      '100',
    );
    expect(p.levels.filter((l) => l.side === 'BUY')).toHaveLength(1);
    expect(p.levels.filter((l) => l.side === 'SELL')).toHaveLength(1);
  });

  it('V2: la última capa se recorta al hueco que queda, y se avisa', () => {
    const p = getStrategy(StrategyKind.MARKET_MAKER_V2).preview(
      conDefaults(StrategyKind.MARKET_MAKER_V2, {
        orderSizePerSide: '50',
        maxBotPositionValue: '120',
        layers: 3,
        layerDistanceMultiplier: '1.5',
        layerSizeMultiplier: '1',
        useFullSizeUntilMax: false,
      }),
      makeMarket(),
      '100',
    );
    const compras = p.levels.filter((l) => l.side === 'BUY');
    expect(compras).toHaveLength(3);
    expect(D(compras[2].notional).lt(compras[0].notional)).toBe(true);
    expect(D(lado(p, 'LONG').notional).lte(120)).toBe(true);
    expect(p.issues.some((i) => i.field === 'layers')).toBe(true);
  });

  it('V2: el aviso de capas también en un market maker solo de venta', () => {
    const p = getStrategy(StrategyKind.MARKET_MAKER_V2).preview(
      conDefaults(StrategyKind.MARKET_MAKER_V2, {
        direction: 'SHORT',
        orderSizePerSide: '50',
        maxBotPositionValue: '120',
        layers: 3,
        layerDistanceMultiplier: '1.5',
      }),
      makeMarket(),
      '100',
    );
    expect(p.sides.map((x) => x.direction)).toEqual(['SHORT']);
    expect(p.issues.some((i) => i.field === 'layers')).toBe(true);
  });
});

describe('seguimiento de beneficio: la condición de entrada ya cumplida (079/F-05)', () => {
  const trailing = getStrategy(StrategyKind.TRAILING_PROFIT);
  const entrada = (activationMode: ActivationMode, activationPrice: string) =>
    trailing.preview(
      conDefaults(StrategyKind.TRAILING_PROFIT, { activationMode, activationPrice }),
      makeMarket(),
      '100',
    );

  it('«por debajo de 110» con el precio en 100 entra ya, a 100', () => {
    const p = entrada(ActivationMode.PRICE_BELOW, '110');
    expect(p.levels[0].price).toBe('100.0');
    expect(p.issues.some((i) => i.message.includes('ya cumple'))).toBe(true);
  });

  it('«por encima de 90» con el precio en 100, igual', () => {
    expect(entrada(ActivationMode.PRICE_ABOVE, '90').levels[0].price).toBe('100.0');
  });

  it('«por debajo de 80» espera, y todo se calcula sobre 80', () => {
    const p = entrada(ActivationMode.PRICE_BELOW, '80');
    expect(p.levels[0].price).toBe('80.0');
    expect(lado(p, 'LONG').averageEntry).toBe('80.0');
    // La distancia desde hoy sigue midiéndose contra hoy.
    expect(p.levels[0].distancePct).toBe('-20.00');
  });
});

describe('las estrategias con su propio stop (079/F-22, F-23)', () => {
  it('tendencia: el stop es una estimación, y se rotula así', () => {
    const p = getStrategy(StrategyKind.TREND_FOLLOW).preview(
      conDefaults(StrategyKind.TREND_FOLLOW),
      makeMarket(),
      '100',
    );
    const largo = lado(p, 'LONG');
    expect(largo.stopLossEstimated).toBe(true);
    expect(D(largo.stopLoss!.price).lt(100)).toBe(true);
  });

  it('la operación de un agente: su stop y su primer objetivo reales', () => {
    const p = getStrategy(StrategyKind.AGENT_TRADE).preview(
      conDefaults(StrategyKind.AGENT_TRADE),
      makeMarket(),
      '100',
    );
    const largo = lado(p, 'LONG');
    expect(largo.stopLoss?.price).toBe('98.0');
    expect(largo.takeProfit?.price).toBe('104.0');
    expect(largo.stopLossEstimated).toBe(false);
    // 0,5 × (98 − 100): la pérdida al stop que el agente declaró, sin costes.
    expect(largo.stopLoss?.pnl).toBe('-1.00');
  });
});
