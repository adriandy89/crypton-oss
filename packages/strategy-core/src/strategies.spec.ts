import {
  D,
  FairPriceOrigin,
  LevelKind,
  estimateLiquidationPrice,
  Mutability,
  PriceSource,
  StrategyKind,
  Venue,
  type BotConfig,
} from '@crypton/shared';
import { camposEfectivos, px } from './common';
import { makeCoid } from './client-order-id';
import { gridSellLevels } from './strategies/gridmart';
import { BASE_LIMIT_TTL_MS } from './ladder';
import { diffConfig } from './mutability';
import { getStrategy, listStrategies } from './registry';
import { comunCon } from './common';
import { parseCoid } from './client-order-id';
import { withStopLoss } from './stop-loss';
import {
  BASE_CONFIG,
  makeContext,
  makeCycle,
  makeMarket,
  makePosition,
  makeVenueOrder,
} from './testing';

const cfg = (extra: Record<string, unknown>): BotConfig => ({ ...BASE_CONFIG, ...extra });

const byKind = <T extends { levelKind: string }>(orders: T[], kind: string): T[] =>
  orders.filter((o) => o.levelKind === kind);

// ═══════════════════════════════════════════════════════════════
// GRID CLASSIC
// ═══════════════════════════════════════════════════════════════

describe('gridClassic.plan', () => {
  const config = cfg({
    gridSpacing: 'ARITHMETIC',
    sizingMode: 'QUOTE',
    lowerPrice: '90',
    upperPrice: '110',
    gridLevels: 5, // → 90, 95, 100, 105, 110
    totalInvestment: '100',
    leverage: 1,
  });

  it('solo tiende compras en las líneas por debajo del precio', () => {
    const ctx = makeContext({ strategy: StrategyKind.GRID_CLASSIC, config, price: '100' });
    const { orders } = getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx);

    expect(byKind(orders, LevelKind.GRID_BUY).map((o) => o.price)).toEqual(['90.0', '95.0']);
    expect(byKind(orders, LevelKind.GRID_SELL)).toHaveLength(0);
  });

  /**
   * Spec 001 — test de confirmación de F-15 (parte Grid Classic).
   *
   * Tras cerrar un ciclo, `cycleAfterFill` devuelve `cycleId: null`
   * (`cycle-accounting.ts:195`) y el motor adopta ese estado tal cual con
   * `scratch.cycleSeq = N+1` (`bot-store.ts:692`); nadie repone el id hasta
   * una readopción. El motor reconcilia, firma el stop y graba las filas con
   * `scratch.cycleSeq`, así que el plan no puede irse a 0 solo porque falte
   * el id. Está en ROJO a propósito hasta que llegue la corrección aprobada.
   */
  it('el id de nivel lleva el mismo cycleSeq que el motor aunque el ciclo no tenga id', () => {
    const plan = (cycleId: string | null) =>
      getStrategy(StrategyKind.GRID_CLASSIC).plan(
        makeContext({
          strategy: StrategyKind.GRID_CLASSIC,
          config,
          price: '100',
          cycle: { cycleId, scratch: { cycleSeq: 3 } },
        }),
      );
    const conId = plan('c-3').orders.map((o) => o.clientOrderId);
    const sinId = plan(null).orders.map((o) => o.clientOrderId);

    expect(parseCoid(conId[0])?.cycleSeq).toBe(3);
    expect(sinId).toEqual(conId);
  });

  it('una línea comprada pasa a vender en la línea inmediatamente superior', () => {
    const ctx = makeContext({
      strategy: StrategyKind.GRID_CLASSIC,
      config,
      price: '100',
      cycle: { filledLevelIndexes: [1] }, // comprada la línea de 95
      position: makePosition('0.2', '95'),
    });
    const { orders } = getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx);

    const sells = byKind(orders, LevelKind.GRID_SELL);
    expect(sells).toHaveLength(1);
    expect(sells[0].price).toBe('100.0');
    expect(sells[0].reduceOnly).toBe(true);
    // La línea comprada ya no vuelve a tender compra.
    expect(byKind(orders, LevelKind.GRID_BUY).map((o) => o.price)).toEqual(['90.0']);
  });

  it('reparte el mismo importe por línea en modo QUOTE: más unidades abajo', () => {
    const ctx = makeContext({ strategy: StrategyKind.GRID_CLASSIC, config, price: '100' });
    const { orders } = getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx);
    const [at90, at95] = byKind(orders, LevelKind.GRID_BUY);
    expect(Number(at90.qty)).toBeGreaterThan(Number(at95.qty));
    expect(Number(at90.qty) * 90).toBeCloseTo(20, 1); // 100 / 5 niveles
  });

  it('compra las mismas unidades en cada línea en modo BASE', () => {
    const ctx = makeContext({
      strategy: StrategyKind.GRID_CLASSIC,
      config: cfg({ ...(config as object), sizingMode: 'BASE' }),
      price: '100',
    });
    const { orders } = getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx);
    const buys = byKind(orders, LevelKind.GRID_BUY);
    expect(buys[0].qty).toBe(buys[1].qty);
  });

  it('fuera de rango deja de entrar pero MANTIENE las salidas', () => {
    const ctx = makeContext({
      strategy: StrategyKind.GRID_CLASSIC,
      config,
      price: '80', // por debajo del rango
      cycle: { filledLevelIndexes: [0, 1] },
      position: makePosition('0.4', '92.5'),
    });
    const { orders, note } = getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx);

    expect(byKind(orders, LevelKind.GRID_BUY)).toHaveLength(0);
    expect(byKind(orders, LevelKind.GRID_SELL)).toHaveLength(2);
    expect(note).toContain('fuera del rango');
  });

  it('el tope de notional corta las entradas nuevas', () => {
    const ctx = makeContext({
      strategy: StrategyKind.GRID_CLASSIC,
      config: cfg({ ...(config as object), maxNotionalCap: '10' }),
      price: '100',
      position: makePosition('0.5', '100'), // 50 de notional, por encima del tope
    });
    const { orders, note } = getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx);
    expect(byKind(orders, LevelKind.GRID_BUY)).toHaveLength(0);
    expect(note).toContain('Tope de notional');
  });

  it('rechaza una retícula con el paso por debajo de 2 ticks', () => {
    const market = makeMarket({ tickSize: '1' });
    const result = getStrategy(StrategyKind.GRID_CLASSIC).validate(
      cfg({ ...(config as object), gridLevels: 200 }),
      market,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === 'gridLevels')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// MARTINGALE
// ═══════════════════════════════════════════════════════════════

describe('px y las cifras significativas del venue', () => {
  /**
   * Spec 001, F-04. En Hyperliquid el precio planificado y el enviado se
   * calculaban con reglas distintas y el reconciliador cancelaba y recolocaba
   * la orden en cada tick. Ahora `px()` aplica la misma regla que la puerta
   * del adaptador: 1,00001 con tick 0,00001 y cinco cifras es 1 en compra y
   * 1,0001 en venta; sin tope declarado, el tick manda.
   */
  it('recorta a las cifras significativas del mercado, hacia el lado seguro', () => {
    const hl = makeMarket({ tickSize: '0.00001', priceDecimals: 5, maxSignificantDigits: 5 });
    expect(px(hl, '1.00001', 'BUY')).toBe('1.00000');
    expect(px(hl, '1.00001', 'SELL')).toBe('1.00010');
    expect(px(makeMarket({ tickSize: '0.00001', priceDecimals: 5 }), '1.00001', 'BUY')).toBe(
      '1.00001',
    );
  });
});

describe('preview y los topes del venue', () => {
  /**
   * Spec 001, F-50 (Lighter) y F-23 (Aster). Los venues limitan las ordenes
   * activas por mercado (Lighter Standard: 30; Aster: 200) y una reticula con
   * mas niveles se recortaba en silencio, orden a orden, ya en marcha. La vista
   * previa avisa antes de crear el bot; sin tope conocido, no dice nada.
   */
  it('avisa cuando la configuracion tiende mas ordenes de las que admite el venue', () => {
    const cfg40 = cfg({
      gridSpacing: 'ARITHMETIC',
      sizingMode: 'QUOTE',
      lowerPrice: '60',
      upperPrice: '140',
      gridLevels: 40,
      totalInvestment: '100000',
      leverage: 1,
    });
    const grid = getStrategy(StrategyKind.GRID_CLASSIC);

    const conTope = grid.preview(cfg40, makeMarket({ maxActiveOrders: 30 }), '100');
    expect(conTope.issues.some((i) => i.severity === 'WARNING' && /30/.test(i.message))).toBe(true);

    const sinTope = grid.preview(cfg40, makeMarket(), '100');
    expect(sinTope.issues.some((i) => /activas/.test(i.message))).toBe(false);
  });
});

describe('validación genérica y parámetros comunes (spec 019)', () => {
  const gridCfg = cfg({
    gridSpacing: 'ARITHMETIC',
    sizingMode: 'QUOTE',
    lowerPrice: '90',
    upperPrice: '110',
    gridLevels: 5,
    totalInvestment: '100',
    leverage: 1,
  });
  const neutralCfg = cfg({
    direction: 'NEUTRAL',
    lowerPrice: '90',
    upperPrice: '110',
    anchorPrice: '100',
    gridLevels: 5,
    gridSpacing: 'ARITHMETIC',
    sizeMultiplier: '1',
    totalInvestment: '100',
    leverage: 1,
    maxExposure: '1000',
  });
  const gmCfg = cfg({
    numLimitBuys: 2,
    initialSeparationPct: '1',
    stepScale: '2',
    volumeScale: '2',
    totalInvestment: '70',
    takeProfitPct: '1',
    satelliteTpPct: '0.5',
    gridSellCount: 2,
    gridSellInitialSeparationPct: '1',
    gridSellDistanceMultiplier: '2',
    corePctSoldAtLevel1: '50',
    gridSellQtyMultiplier: '1',
    gridRebuyDiscountPct: '0.5',
    leverage: 1,
  });
  const grid = getStrategy(StrategyKind.GRID_CLASSIC);
  const neutral = getStrategy(StrategyKind.NEUTRAL_GRID);
  const tdca = getStrategy(StrategyKind.TDCA);
  const gm = getStrategy(StrategyKind.GRIDMART);
  const mm2 = getStrategy(StrategyKind.MARKET_MAKER_V2);
  const errorEn = (
    r: { issues: { field: string | null; severity: string }[] },
    field: string,
  ): boolean => r.issues.some((i) => i.field === field && i.severity === 'ERROR');

  /** Spec 001, F-13: solo el formulario aplicaba min/max/step/options. */
  it('rechaza lo que meta.fields acota y validate() no miraba', () => {
    const m = makeMarket();
    expect(
      errorEn(
        neutral.validate(cfg({ ...(neutralCfg as object), sizeMultiplier: '5' }), m),
        'sizeMultiplier',
      ),
    ).toBe(true);
    expect(
      errorEn(
        tdca.validate(cfg({ ...tdca.defaults(), maxBuysPerCycle: 600 }), m),
        'maxBuysPerCycle',
      ),
    ).toBe(true);
    expect(
      errorEn(
        gm.validate(cfg({ ...(gmCfg as object), gridRebuyDiscountPct: '150' }), m),
        'gridRebuyDiscountPct',
      ),
    ).toBe(true);
    expect(
      errorEn(grid.validate(cfg({ ...(gridCfg as object), leverage: 2.5 }), m), 'leverage'),
    ).toBe(true);
    expect(
      errorEn(
        grid.validate(cfg({ ...(gridCfg as object), gridSpacing: 'RARO' }), m),
        'gridSpacing',
      ),
    ).toBe(true);
    const v2 = cfg({
      ...mm2.defaults(),
      orderSizePerSide: '100',
      maxBotPositionValue: '1000',
      repriceThresholdBps: '0',
    });
    expect(errorEn(mm2.validate(v2, m), 'repriceThresholdBps')).toBe(true);
    expect(grid.validate(gridCfg, m).ok).toBe(true);
  });

  it('GridMart sin multiplicadores devuelve una vista previa inválida, no revienta', () => {
    const sin = { ...(gmCfg as object) } as Record<string, unknown>;
    delete sin['gridSellDistanceMultiplier'];
    delete sin['gridSellQtyMultiplier'];
    const p = gm.preview(sin as never, makeMarket(), '100');
    expect(p.valid).toBe(false);
    expect(p.issues.some((i) => i.field === 'gridSellDistanceMultiplier')).toBe(true);
  });

  /** Spec 001, F-44 y F-93: la misma cuenta que la API, con la tasa del mercado. */
  it('rechaza el apalancamiento que deja la liquidación a menos del 5 % en ese mercado', () => {
    // El mercado de pruebas admite 40x: mantenimiento 1,25 % → 1/(0,05 + 0,0125) = 16x.
    expect(
      errorEn(
        grid.validate(cfg({ ...(gridCfg as object), leverage: 17 }), makeMarket()),
        'leverage',
      ),
    ).toBe(true);
    expect(
      errorEn(
        grid.validate(cfg({ ...(gridCfg as object), leverage: 16 }), makeMarket()),
        'leverage',
      ),
    ).toBe(false);
  });

  it('la liquidación estimada usa la tasa de mantenimiento del mercado', () => {
    const p = grid.preview(cfg({ ...(gridCfg as object), leverage: 2 }), makeMarket(), '100');
    const esperado = estimateLiquidationPrice(p.worstCaseAverageEntry ?? '0', 2, 'LONG', 0.0125);
    expect(
      D(p.estimatedLiquidationPrice ?? '0')
        .minus(esperado ?? 0)
        .abs()
        .lt(0.15),
    ).toBe(true);
  });

  /** Spec 001, F-12: `cooldownMinutes` no se leía en tres estrategias. */
  it('la espera entre ciclos frena las entradas de las rejillas y del DCA', () => {
    const espera = {
      now: 1_000_000,
      cycle: { scratch: { cycleSeq: 2 }, cooldownUntil: 1_060_000 },
    };
    const g = grid.plan(
      makeContext({
        strategy: StrategyKind.GRID_CLASSIC,
        config: gridCfg,
        price: '100',
        ...espera,
      }),
    );
    expect(g.orders.filter((o) => o.levelKind === LevelKind.GRID_BUY)).toHaveLength(0);
    expect(g.note).toMatch(/espera/i);
    const n = neutral.plan(
      makeContext({
        strategy: StrategyKind.NEUTRAL_GRID,
        config: neutralCfg,
        price: '100',
        ...espera,
      }),
    );
    expect(n.orders).toHaveLength(0);
    expect(n.note).toMatch(/espera/i);
    const t = tdca.plan(
      makeContext({
        strategy: StrategyKind.TDCA,
        config: cfg(tdca.defaults()),
        price: '100',
        ...espera,
      }),
    );
    expect(t.immediate).toHaveLength(0);
    expect(t.note).toMatch(/espera/i);
  });

  it('el tope de exposición común también frena en la neutral y en el DCA', () => {
    const n = neutral.plan(
      makeContext({
        strategy: StrategyKind.NEUTRAL_GRID,
        config: cfg({ ...(neutralCfg as object), maxNotionalCap: '50' }),
        price: '100',
        position: makePosition('1', '100'),
      }),
    );
    expect(n.orders.length).toBeGreaterThan(0);
    expect(n.orders.every((o) => o.side === 'SELL')).toBe(true);
    const t = tdca.plan(
      makeContext({
        strategy: StrategyKind.TDCA,
        config: cfg({ ...tdca.defaults(), maxNotionalCap: '50' }),
        price: '100',
        position: makePosition('1', '100'),
        cycle: { scratch: { cycleSeq: 1 }, entriesFilled: 1 },
      }),
    );
    expect(t.immediate).toHaveLength(0);
    expect(t.note).toMatch(/tope/i);
  });

  it('la vista previa de GridMart pinta el TP del satélite, el único que existe', () => {
    const p = gm.preview(gmCfg, makeMarket(), '100');
    const satelite = D(p.worstCaseAverageEntry ?? '0').mul('1.005');
    expect(
      D(p.takeProfitPrice ?? '0')
        .minus(satelite)
        .abs()
        .lt(0.15),
    ).toBe(true);
  });

  it('avisa de que la dirección no sesga la retícula neutral', () => {
    const r = neutral.validate(cfg({ ...(neutralCfg as object), direction: 'LONG' }), makeMarket());
    expect(r.issues.some((i) => i.field === 'direction' && i.severity === 'WARNING')).toBe(true);
  });
});

describe('rejillas: dimensionado y vista previa (spec 017)', () => {
  const neutralCfg = cfg({
    direction: 'NEUTRAL',
    lowerPrice: '90',
    upperPrice: '110',
    anchorPrice: '100',
    gridLevels: 5,
    gridSpacing: 'ARITHMETIC',
    sizeMultiplier: '1',
    totalInvestment: '100',
    leverage: 1,
    maxExposure: '1000',
  });
  const gridCfg = (over: Record<string, unknown> = {}) =>
    cfg({
      gridSpacing: 'ARITHMETIC',
      sizingMode: 'QUOTE',
      lowerPrice: '90',
      upperPrice: '110',
      gridLevels: 5,
      totalInvestment: '100',
      leverage: 1,
      ...over,
    });
  const gmCfg = cfg({
    numLimitBuys: 2,
    initialSeparationPct: '1',
    stepScale: '2',
    volumeScale: '2',
    totalInvestment: '70',
    takeProfitPct: '1',
    satelliteTpPct: '0.5',
    gridSellCount: 2,
    gridSellInitialSeparationPct: '1',
    gridSellDistanceMultiplier: '2',
    corePctSoldAtLevel1: '50',
    gridSellQtyMultiplier: '1',
    gridRebuyDiscountPct: '0.5',
    leverage: 1,
  });

  /**
   * Spec 001, F-81. La banda muerta de medio escalon cancelaba la linea justo
   * antes de que pudiera ejecutarse: una compra en 95 (paso 5) solo vivia con el
   * precio por encima de 97,5. Ahora la banda gobierna solo el CAMBIO de lado
   * (histeresis sobre el lado memorizado) y la compra sigue viva mientras el
   * precio se le acerca desde arriba.
   */
  it('una compra sigue viva mientras el precio se le acerca desde arriba', () => {
    const neutral = getStrategy(StrategyKind.NEUTRAL_GRID);
    const compra95 = (p: { orders: { levelIndex: number; side: string }[] }) =>
      p.orders.find((o) => o.levelIndex === 1 && o.side === 'BUY');
    const primero = neutral.plan(
      makeContext({ strategy: StrategyKind.NEUTRAL_GRID, config: neutralCfg, price: '98' }),
    );
    expect(compra95(primero)).toBeDefined();

    const segundo = neutral.plan(
      makeContext({
        strategy: StrategyKind.NEUTRAL_GRID,
        config: neutralCfg,
        price: '96',
        cycle: { scratch: { cycleSeq: 1, ...primero.scratchPatch } },
      }),
    );
    expect(compra95(segundo)).toBeDefined();
  });

  /** Spec 001, F-82: las recompras de GridMart viven fuera del espacio de indices de las seguridades. */
  it('GridMart declara que sus recompras no marcan escalones', () => {
    expect(getStrategy(StrategyKind.GRIDMART).rebuysOffLevelIndexes).toBe(true);
  });

  /**
   * Spec 001, F-89. Cada trozo de una venta de rejilla SOBRESCRIBIA la recompra
   * anotada: una venta en dos trozos recompraba solo el ultimo. Ahora suman.
   */
  it('los trozos de una venta de rejilla suman en la recompra', () => {
    const gm = getStrategy(StrategyKind.GRIDMART);
    const ctx = makeContext({ strategy: StrategyKind.GRIDMART, config: gmCfg, price: '100' });
    const venta = (qty: string) => ({
      venue: Venue.HYPERLIQUID,
      symbol: 'BTC',
      venueFillId: 'f' + qty,
      venueOrderId: 'o1',
      clientOrderId: makeCoid(ctx.botId, 1, 'GRID_SELL', 0),
      side: 'SELL' as const,
      price: '101',
      qty,
      fee: '0',
      feeAsset: 'USDC',
      isTaker: false,
      ts: 1,
    });
    const c1 = gm.onFill!(ctx, venta('0.03'), makeCycle());
    const c2 = gm.onFill!(ctx, venta('0.02'), c1);
    const rebuys = c2.scratch['rebuys'] as { index: number; qty: string }[];
    expect(rebuys).toHaveLength(1);
    expect(rebuys[0].qty).toBe('0.05000');
  });

  it('el reparto del nucleo entrega el resto al ultimo escalon: sin polvo', () => {
    const niveles = gridSellLevels(
      {
        ...(gmCfg as object),
        gridSellCount: 3,
        corePctSoldAtLevel1: '33.33',
        gridSellQtyMultiplier: '1',
      } as never,
      D(100),
      D('0.00196'),
    );
    const suma = niveles.reduce((acc, n) => acc.plus(n.qty), D(0));
    expect(suma.toFixed()).toBe('0.00196');
  });

  /**
   * Spec 001, F-03. En «Cantidad de moneda» la cantidad por linea se calculaba
   * con el mark de cada tick: la reticula entera se cancelaba y recolocaba con
   * cada movimiento del precio. Ahora el precio de referencia se fija en el
   * primer plan del ciclo.
   */
  it('en Cantidad de moneda la cantidad no cambia con el precio', () => {
    const grid = getStrategy(StrategyKind.GRID_CLASSIC);
    const base = gridCfg({ sizingMode: 'BASE' });
    const qtyDe = (p: { orders: { levelIndex: number; qty: string }[] }, i: number) =>
      p.orders.find((o) => o.levelIndex === i)?.qty;
    const a = grid.plan(
      makeContext({ strategy: StrategyKind.GRID_CLASSIC, config: base, price: '100' }),
    );
    const b = grid.plan(
      makeContext({
        strategy: StrategyKind.GRID_CLASSIC,
        config: base,
        price: '105',
        cycle: { scratch: { cycleSeq: 1, ...a.scratchPatch } },
      }),
    );
    expect(qtyDe(a, 0)).toBeDefined();
    expect(qtyDe(b, 0)).toBe(qtyDe(a, 0));
  });

  /** Spec 001, F-87: el tope acota lo que se tiende (notional proyectado), no solo lo ya abierto. */
  it('el tope de exposicion acota lo que se TIENDE, no solo lo ya abierto', () => {
    const grid = getStrategy(StrategyKind.GRID_CLASSIC);
    const p = grid.plan(
      makeContext({
        strategy: StrategyKind.GRID_CLASSIC,
        config: gridCfg({ maxNotionalCap: '30' }),
        price: '100',
      }),
    );
    const compras = p.orders.filter((o) => o.levelKind === LevelKind.GRID_BUY);
    const tendido = compras.reduce((acc, o) => acc.plus(D(o.price).mul(o.qty)), D(0));
    expect(tendido.lte(30)).toBe(true);
    expect(compras.some((o) => o.levelIndex === 1)).toBe(true);
  });

  /** Spec 001, F-88: el peor caso es que el precio recorra TODA la reticula. */
  it('la vista previa cuenta TODAS las lineas como peor caso', () => {
    const p = getStrategy(StrategyKind.GRID_CLASSIC).preview(gridCfg(), makeMarket(), '100');
    expect(p.worstCaseNotional).toBe('100.00');
    expect(p.worstCaseMargin).toBe('100.00');
  });

  /** Spec 001, F-14. */
  it('TDCA no repite los avisos comunes en la vista previa', () => {
    const tdca = getStrategy(StrategyKind.TDCA);
    const p = tdca.preview(cfg({ ...tdca.defaults(), leverage: 5 }), makeMarket(), '100');
    const mensajes = p.issues.map((i) => i.message);
    expect(new Set(mensajes).size).toBe(mensajes.length);
  });

  it('en cruzado y neutral la vista previa avisa de que la liquidacion es una cota y da la del lado corto', () => {
    const p = getStrategy(StrategyKind.NEUTRAL_GRID).preview(
      cfg({ ...(neutralCfg as object), marginMode: 'CROSS' }),
      makeMarket(),
      '100',
    );
    expect(p.issues.some((i) => /cruzado/i.test(i.message))).toBe(true);
    expect(p.issues.some((i) => /corto/i.test(i.message))).toBe(true);
  });
});

describe('martingale.plan', () => {
  const config = cfg({
    numLimitBuys: 2,
    initialSeparationPct: '1',
    stepScale: '2',
    volumeScale: '2',
    totalInvestment: '70',
    takeProfitPct: '1',
    leverage: 1,
    baseOrderType: 'MARKET',
  });

  it('sin posición abre el ciclo con la entrada base a mercado', () => {
    const ctx = makeContext({ strategy: StrategyKind.MARTINGALE, config, price: '100' });
    const { orders, immediate } = getStrategy(StrategyKind.MARTINGALE).plan(ctx);

    expect(orders).toHaveLength(0);
    expect(immediate).toHaveLength(1);
    expect(immediate[0].type).toBe('MARKET');
    expect(immediate[0].levelKind).toBe(LevelKind.BASE);
    // Peso 1 de 7 sobre 70 de margen = 10 → 0,1 BTC a 100.
    expect(Number(immediate[0].qty)).toBeCloseTo(0.1, 5);
  });

  it('respeta el cooldown antes de abrir el siguiente ciclo', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARTINGALE,
      config,
      price: '100',
      now: 1_000_000,
      cycle: { cooldownUntil: 1_060_000 },
    });
    const plan = getStrategy(StrategyKind.MARTINGALE).plan(ctx);
    expect(plan.immediate).toHaveLength(0);
    expect(plan.orders).toHaveLength(0);
    expect(plan.note).toContain('cooldown');
  });

  /**
   * Spec 001, F-80. Con `tpMode: MARKET` la salida se emitia como MARKET sin
   * disparador: en Aster cerraba la posicion al instante, cerraba el ciclo,
   * esperaba y reabria — un bucle que quema comisiones. Una salida «a mercado»
   * es una orden CONDICIONAL: espera al objetivo y entonces cruza el libro.
   */
  it('con tpMode MARKET la salida es condicional: lleva disparador y no se ejecuta al colocarla', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARTINGALE,
      config: cfg({ ...(config as object), tpMode: 'MARKET' }),
      price: '99.5',
      position: makePosition('0.1', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0], entriesFilled: 1 },
    });
    const tp = byKind(
      getStrategy(StrategyKind.MARTINGALE).plan(ctx).orders,
      LevelKind.TAKE_PROFIT,
    )[0];
    expect(tp.type).toBe('MARKET');
    expect(tp.triggerPrice).toBe('101.0');
    expect(tp.price).toBe('101.0');
  });

  /**
   * Spec 001, F-92. La base LIMIT se recalculaba al mark en cada revision: el
   * motor la cancelaba y recolocaba con cada tick y, como siempre iba pegada al
   * precio, nadie la cruzaba nunca. Ahora el precio se fija al emitirla y se
   * memoriza en el scratch del ciclo; solo caduca pasado BASE_LIMIT_TTL_MS.
   */
  it('la base LIMIT no se recoloca al moverse el precio', () => {
    const limit = cfg({ ...(config as object), baseOrderType: 'LIMIT' });
    const martingale = getStrategy(StrategyKind.MARTINGALE);
    const primera = martingale.plan(
      makeContext({
        strategy: StrategyKind.MARTINGALE,
        config: limit,
        price: '100',
        now: 1_000_000,
      }),
    );
    expect(primera.immediate).toHaveLength(0);
    expect(primera.orders.map((o) => [o.levelKind, o.type, o.price])).toEqual([
      [LevelKind.BASE, 'POST_ONLY', '100.0'],
    ]);
    expect(primera.scratchPatch).toEqual({ baseLimit: { price: '100.0', at: 1_000_000 } });

    // Un minuto despues el precio ha subido un 1 %: la base sigue donde estaba,
    // con el mismo tamaño, y no hay nada nuevo que memorizar.
    const segunda = martingale.plan(
      makeContext({
        strategy: StrategyKind.MARTINGALE,
        config: limit,
        price: '101',
        now: 1_000_000 + 60_000,
        cycle: { scratch: { cycleSeq: 1, ...primera.scratchPatch } },
      }),
    );
    expect(segunda.orders[0].price).toBe('100.0');
    expect(segunda.orders[0].qty).toBe(primera.orders[0].qty);
    expect(segunda.scratchPatch).toBeUndefined();
  });

  it('con posición tiende las seguridades y el take profit', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARTINGALE,
      config,
      price: '99.5',
      position: makePosition('0.1', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0], entriesFilled: 1 },
    });
    const { orders } = getStrategy(StrategyKind.MARTINGALE).plan(ctx);

    const safeties = byKind(orders, LevelKind.SAFETY);
    expect(safeties.map((o) => o.price)).toEqual(['99.0', '97.0']);

    const tp = byKind(orders, LevelKind.TAKE_PROFIT);
    expect(tp).toHaveLength(1);
    expect(tp[0].price).toBe('101.0');
    expect(tp[0].reduceOnly).toBe(true);
    expect(Number(tp[0].qty)).toBeCloseTo(0.1, 5);
  });

  it('ancla la escalera al precio de la base, no al precio de mercado', () => {
    // El mercado se ha ido a 95, pero el ancla sigue en 100: las seguridades
    // NO deben perseguir al precio hacia abajo.
    const ctx = makeContext({
      strategy: StrategyKind.MARTINGALE,
      config,
      price: '95',
      position: makePosition('0.1', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0] },
    });
    const { orders } = getStrategy(StrategyKind.MARTINGALE).plan(ctx);
    expect(byKind(orders, LevelKind.SAFETY).map((o) => o.price)).toEqual(['99.0', '97.0']);
  });

  it('no vuelve a tender una seguridad ya ejecutada', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARTINGALE,
      config,
      price: '98',
      position: makePosition('0.3', '99.3'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0, 1], entriesFilled: 2 },
    });
    const { orders } = getStrategy(StrategyKind.MARTINGALE).plan(ctx);
    expect(byKind(orders, LevelKind.SAFETY).map((o) => o.price)).toEqual(['97.0']);
  });

  it('el tope de notional trunca la escalera en lugar de saltársela', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARTINGALE,
      config: cfg({ ...(config as object), maxNotionalCap: '40' }),
      price: '99.5',
      position: makePosition('0.1', '100'), // 9,95 de notional al precio actual
      cycle: { anchorPrice: '100', filledLevelIndexes: [0] },
    });
    const { orders } = getStrategy(StrategyKind.MARTINGALE).plan(ctx);
    // 9,95 + 20 = 29,95 cabe en el tope; sumar la segunda (40) lo rompería.
    expect(byKind(orders, LevelKind.SAFETY).map((o) => o.price)).toEqual(['99.0']);
  });

  /**
   * El stop loss ya NO lo emite la estrategia: lo añade el motor para todas
   * por igual (`BotRunner.withStopLoss`), porque `stopLossPct` vive en
   * `COMMON_FIELDS` y solo dos de ellas lo leían. Este test vigila que nadie lo
   * reponga aquí: dos emisores del mismo nivel es una duplicidad esperando.
   */
  it('no emite el stop loss: de eso se encarga el motor', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARTINGALE,
      config: cfg({ ...(config as object), stopLossPct: '10' }),
      price: '99',
      position: makePosition('0.1', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0] },
    });
    const { orders } = getStrategy(StrategyKind.MARTINGALE).plan(ctx);
    expect(byKind(orders, LevelKind.STOP_LOSS)).toHaveLength(0);
  });

  it('rechaza una escalera que no llega a la liquidación', () => {
    // 10 niveles al 5 % con stepScale 1,3 cubren muchísimo más que el 10 % que
    // aguanta un 10x: los últimos niveles serían decorativos.
    const result = getStrategy(StrategyKind.MARTINGALE).validate(
      cfg({
        ...(config as object),
        numLimitBuys: 10,
        initialSeparationPct: '5',
        stepScale: '1.3',
        leverage: 10,
      }),
      makeMarket(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('liquidación'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// TDCA
// ═══════════════════════════════════════════════════════════════

describe('tdca.plan', () => {
  const config = cfg({
    amountPerBuy: '100',
    intervalMinutes: 60,
    maxBuysPerCycle: 5,
    buyOnlyIfImprovesAverage: true,
    marginBelowAveragePct: '1',
    takeProfitPct: '2',
    leverage: 1,
    totalInvestment: '1000',
  });

  it('la primera compra sale a mercado sin esperar', () => {
    const ctx = makeContext({ strategy: StrategyKind.TDCA, config, price: '100' });
    const { immediate, note } = getStrategy(StrategyKind.TDCA).plan(ctx);
    expect(immediate).toHaveLength(1);
    expect(immediate[0].type).toBe('MARKET');
    expect(note).toContain('1/5');
  });

  it('no compra antes de que venza el intervalo', () => {
    const ctx = makeContext({
      strategy: StrategyKind.TDCA,
      config,
      price: '100',
      now: 1_000_000,
      cycle: { lastEntryAt: 1_000_000 - 30_000, entriesFilled: 1 },
      position: makePosition('1', '100'),
    });
    const { immediate, note } = getStrategy(StrategyKind.TDCA).plan(ctx);
    expect(immediate).toHaveLength(0);
    expect(note).toContain('siguiente compra');
  });

  it('no compra si el precio no mejora el medio en el margen exigido', () => {
    const ctx = makeContext({
      strategy: StrategyKind.TDCA,
      config,
      price: '99.5', // hace falta <= 99 (1 % por debajo de 100)
      now: 10_000_000,
      cycle: { lastEntryAt: 0, entriesFilled: 1 },
      position: makePosition('1', '100'),
    });
    const { immediate, note } = getStrategy(StrategyKind.TDCA).plan(ctx);
    expect(immediate).toHaveLength(0);
    expect(note).toContain('no mejora el medio');
  });

  it('compra en cuanto el precio cae por debajo del umbral', () => {
    const ctx = makeContext({
      strategy: StrategyKind.TDCA,
      config,
      price: '98.9',
      now: 10_000_000,
      cycle: { lastEntryAt: 0, entriesFilled: 1 },
      position: makePosition('1', '100'),
    });
    expect(getStrategy(StrategyKind.TDCA).plan(ctx).immediate).toHaveLength(1);
  });

  it('deja de comprar al llegar al máximo de compras del ciclo', () => {
    const ctx = makeContext({
      strategy: StrategyKind.TDCA,
      config,
      price: '90',
      now: 10_000_000,
      cycle: { lastEntryAt: 0, entriesFilled: 5 },
      position: makePosition('5', '95'),
    });
    const { immediate, note } = getStrategy(StrategyKind.TDCA).plan(ctx);
    expect(immediate).toHaveLength(0);
    expect(note).toContain('límite de 5 compras');
  });

  it('mantiene el take profit sobre el precio medio mientras haya posición', () => {
    const ctx = makeContext({
      strategy: StrategyKind.TDCA,
      config,
      price: '100',
      cycle: { lastEntryAt: 999_999_999, entriesFilled: 1 },
      position: makePosition('1', '100'),
    });
    const tp = byKind(getStrategy(StrategyKind.TDCA).plan(ctx).orders, LevelKind.TAKE_PROFIT);
    expect(tp[0].price).toBe('102.0');
    expect(tp[0].reduceOnly).toBe(true);
  });

  it('rechaza una config cuyo peor caso supera la inversión declarada', () => {
    const result = getStrategy(StrategyKind.TDCA).validate(
      cfg({ ...(config as object), amountPerBuy: '500', maxBuysPerCycle: 10 }),
      makeMarket(),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === 'maxBuysPerCycle')).toBe(true);
  });

  it('cada compra lleva un id distinto pero estable dentro de su turno', () => {
    const build = (entriesFilled: number) =>
      getStrategy(StrategyKind.TDCA).plan(
        makeContext({
          strategy: StrategyKind.TDCA,
          config,
          price: '90',
          now: 10_000_000,
          cycle: { lastEntryAt: 0, entriesFilled },
          position: makePosition('1', '100'),
        }),
      ).immediate[0].clientOrderId;

    // Mismo estado → mismo id: es lo que impide duplicar la compra si el motor
    // vuelve a planificar antes de que el fill quede registrado.
    expect(build(1)).toBe(build(1));
    expect(build(1)).not.toBe(build(2));
    expect(parseCoid(build(1))!.levelIndex).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// NEUTRAL GRID
// ═══════════════════════════════════════════════════════════════

describe('neutralGrid.plan', () => {
  const config = cfg({
    direction: 'NEUTRAL',
    lowerPrice: '90',
    upperPrice: '110',
    anchorPrice: '100',
    gridLevels: 5,
    gridSpacing: 'ARITHMETIC',
    sizeMultiplier: '1',
    totalInvestment: '100',
    leverage: 1,
    maxExposure: '1000',
  });

  it('cotiza a los dos lados del precio', () => {
    const ctx = makeContext({ strategy: StrategyKind.NEUTRAL_GRID, config, price: '100' });
    const { orders } = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx);
    expect(orders.filter((o) => o.side === 'BUY').map((o) => o.price)).toEqual(['90.0', '95.0']);
    expect(orders.filter((o) => o.side === 'SELL').map((o) => o.price)).toEqual(['105.0', '110.0']);
  });

  it('ninguna orden es reduceOnly: en one-way cada línea solo mueve el neto', () => {
    const ctx = makeContext({ strategy: StrategyKind.NEUTRAL_GRID, config, price: '100' });
    const { orders } = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx);
    expect(orders.every((o) => o.reduceOnly === false)).toBe(true);
  });

  it('la banda muerta evita cotizar encima del precio actual', () => {
    // A 95 exactos, la línea de 95 cae dentro de la banda y no se tiende.
    const ctx = makeContext({ strategy: StrategyKind.NEUTRAL_GRID, config, price: '95' });
    const { orders } = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx);
    expect(orders.map((o) => o.price)).not.toContain('95.0');
  });

  /**
   * Spec 001, F-94. Con espaciado geométrico el paso no es uniforme y la banda
   * de rearme era medio paso MEDIO: abajo, donde las líneas están juntas, una
   * línea cruzada tardaba en volver más de lo que mide su propio escalón.
   */
  it('con espaciado geométrico la banda de rearme es la mitad del paso local de cada línea', () => {
    const geometrica = cfg({
      ...(config as object),
      lowerPrice: '100',
      upperPrice: '400',
      anchorPrice: '200',
      gridLevels: 4,
      gridSpacing: 'GEOMETRIC',
      totalInvestment: '1000',
    });
    // Líneas en 100, 158,7, 252 y 400: paso medio 100, paso local abajo 58,7.
    // La línea de 100 se cruzó y el precio está en 135: a más de medio paso
    // local (29,4) pero a menos de medio paso medio (50).
    const ctx = makeContext({
      strategy: StrategyKind.NEUTRAL_GRID,
      config: geometrica,
      price: '135',
      cycle: { scratch: { cycleSeq: 1, lineSides: { '100': 'CRUZADA' } } },
    });

    const { orders } = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx);

    expect(orders.some((o) => o.side === 'BUY' && o.price === '100.0')).toBe(true);
  });

  it('con el tope de exposición alcanzado solo deja vivas las que reducen', () => {
    const ctx = makeContext({
      strategy: StrategyKind.NEUTRAL_GRID,
      config: cfg({ ...(config as object), maxExposure: '50' }),
      price: '100',
      position: makePosition('1', '100'), // 100 de exposición larga, por encima del tope
    });
    const { orders, note } = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx);
    expect(orders.every((o) => o.side === 'SELL')).toBe(true);
    expect(note).toContain('Tope de exposición');
  });

  it('avisa si no hay tope de exposición configurado', () => {
    const { issues } = getStrategy(StrategyKind.NEUTRAL_GRID).validate(
      cfg({ ...(config as object), maxExposure: undefined }),
      makeMarket(),
    );
    expect(issues.some((i) => i.field === 'maxExposure' && i.severity === 'WARNING')).toBe(true);
  });

  it('sizeMultiplier > 1 pondera más las líneas alejadas del ancla', () => {
    const ctx = makeContext({
      strategy: StrategyKind.NEUTRAL_GRID,
      config: cfg({ ...(config as object), sizeMultiplier: '2' }),
      price: '100',
    });
    const buys = getStrategy(StrategyKind.NEUTRAL_GRID)
      .plan(ctx)
      .orders.filter((o) => o.side === 'BUY');
    // 90 está más lejos del ancla que 95 → más notional.
    const at90 = buys.find((o) => o.price === '90.0')!;
    const at95 = buys.find((o) => o.price === '95.0')!;
    expect(Number(at90.qty) * 90).toBeGreaterThan(Number(at95.qty) * 95);
  });
});

// ═══════════════════════════════════════════════════════════════
// GRIDMART
// ═══════════════════════════════════════════════════════════════

describe('gridmart.plan', () => {
  const config = cfg({
    numLimitBuys: 2,
    initialSeparationPct: '1',
    stepScale: '2',
    volumeScale: '2',
    totalInvestment: '70',
    takeProfitPct: '1',
    satelliteTpPct: '0.5',
    gridSellCount: 2,
    gridSellInitialSeparationPct: '1',
    gridSellDistanceMultiplier: '2',
    corePctSoldAtLevel1: '50',
    gridSellQtyMultiplier: '1',
    gridRebuyDiscountPct: '0.5',
    leverage: 1,
  });

  /**
   * Spec 001, F-92, la otra cara: GridMart mandaba la base LIMIT una sola vez
   * (por `immediate`) y sin caducidad; si el precio se iba, el ciclo no abria
   * jamas. Misma conducta que Martingala: reconciliada, fija y con caducidad.
   */
  it('la base LIMIT de GridMart caduca y se recoloca al precio actual', () => {
    const limit = cfg({ ...(config as object), baseOrderType: 'LIMIT' });
    const gridmart = getStrategy(StrategyKind.GRIDMART);
    const memorizada = { price: '100.0', at: 1_000_000 };
    const planCon = (now: number) =>
      gridmart.plan(
        makeContext({
          strategy: StrategyKind.GRIDMART,
          config: limit,
          price: '101',
          now,
          cycle: { scratch: { cycleSeq: 1, baseLimit: memorizada } },
        }),
      );

    const vigente = planCon(1_000_000 + BASE_LIMIT_TTL_MS - 1);
    expect(vigente.immediate).toHaveLength(0);
    expect(vigente.orders.map((o) => [o.levelKind, o.type, o.price])).toEqual([
      [LevelKind.BASE, 'POST_ONLY', '100.0'],
    ]);
    expect(vigente.scratchPatch).toBeUndefined();

    const caducada = planCon(1_000_000 + BASE_LIMIT_TTL_MS);
    expect(caducada.orders[0].price).toBe('101.0');
    expect(caducada.scratchPatch).toEqual({
      baseLimit: { price: '101.0', at: 1_000_000 + BASE_LIMIT_TTL_MS },
    });
  });

  it('tiende núcleo, satélite y rejilla de ventas a la vez', () => {
    const ctx = makeContext({
      strategy: StrategyKind.GRIDMART,
      config,
      price: '99',
      position: makePosition('0.3', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0, 1] },
    });
    const { orders } = getStrategy(StrategyKind.GRIDMART).plan(ctx);

    expect(byKind(orders, LevelKind.SAFETY).map((o) => o.price)).toEqual(['97.0']);
    // Satélite = posición (0,3) menos el núcleo (0,1) = 0,2 a breakeven + 0,5 %.
    const sat = byKind(orders, LevelKind.TAKE_PROFIT);
    expect(sat[0].price).toBe('100.5');
    expect(Number(sat[0].qty)).toBeCloseTo(0.2, 5);
    // Ventas de rejilla sobre el núcleo: +1 % y +3 %.
    expect(byKind(orders, LevelKind.GRID_SELL).map((o) => o.price)).toEqual(['101.0', '103.0']);
  });

  it('las ventas de rejilla nunca suman más que el núcleo', () => {
    const ctx = makeContext({
      strategy: StrategyKind.GRIDMART,
      config: cfg({ ...(config as object), corePctSoldAtLevel1: '80', gridSellCount: 5 }),
      price: '99',
      position: makePosition('0.3', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0, 1] },
    });
    const sells = byKind(getStrategy(StrategyKind.GRIDMART).plan(ctx).orders, LevelKind.GRID_SELL);
    const total = sells.reduce((a, o) => a + Number(o.qty), 0);
    expect(total).toBeLessThanOrEqual(0.1 + 1e-9); // núcleo = 0,1
  });

  it('en modo Classic solo hay un TP sobre el total, sin rejilla', () => {
    const ctx = makeContext({
      strategy: StrategyKind.GRIDMART,
      config: cfg({ ...(config as object), classicMode: true }),
      price: '99',
      position: makePosition('0.3', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0, 1] },
    });
    const { orders } = getStrategy(StrategyKind.GRIDMART).plan(ctx);
    expect(byKind(orders, LevelKind.GRID_SELL)).toHaveLength(0);
    const tp = byKind(orders, LevelKind.TAKE_PROFIT);
    expect(tp).toHaveLength(1);
    expect(Number(tp[0].qty)).toBeCloseTo(0.3, 5);
  });

  it('onFill anota la recompra al ejecutarse una venta de rejilla', () => {
    const strategy = getStrategy(StrategyKind.GRIDMART);
    const ctx = makeContext({
      strategy: StrategyKind.GRIDMART,
      config,
      price: '101',
      position: makePosition('0.3', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0, 1] },
    });

    const next = strategy.onFill!(
      ctx,
      {
        venue: ctx.venue,
        symbol: 'BTC',
        venueFillId: 'f1',
        venueOrderId: 'o1',
        clientOrderId: '1a2b3c4d.1.GS0',
        side: 'SELL',
        price: '101',
        qty: '0.05',
        fee: '0',
        feeAsset: 'USDC',
        isTaker: false,
        ts: 0,
      },
      ctx.cycle,
    );

    const rebuys = next.scratch['rebuys'] as { index: number; price: string; qty: string }[];
    expect(rebuys).toHaveLength(1);
    // 101 con un 0,5 % de descuento = 100,495. Al ser una COMPRA se redondea
    // hacia abajo sobre el tick de 0,1 → 100,4 (nunca hacia arriba, que sería
    // pagar de más y arriesgar cruzar el libro con una post-only).
    expect(rebuys[0].price).toBe('100.4');
    expect(rebuys[0].qty).toBe('0.05000');
  });

  it('la recompra anotada se tiende como orden en el siguiente plan', () => {
    const ctx = makeContext({
      strategy: StrategyKind.GRIDMART,
      config,
      price: '101',
      position: makePosition('0.25', '100'),
      cycle: {
        anchorPrice: '100',
        filledLevelIndexes: [0, 1],
        scratch: { cycleSeq: 1, rebuys: [{ index: 0, price: '100.5', qty: '0.05' }] },
      },
    });
    const buys = byKind(getStrategy(StrategyKind.GRIDMART).plan(ctx).orders, LevelKind.GRID_BUY);
    expect(buys).toHaveLength(1);
    expect(buys[0].price).toBe('100.5');
  });

  it('un escalón con recompra pendiente NO se vuelve a cotizar', () => {
    // El inventario del escalón 0 ya se vendió; hasta que su recompra se
    // ejecute no hay nada que vender en él. Antes este filtro no existía y lo
    // tapaba un accidente del motor (vetaba recolocar ids ya ejecutados): al
    // permitir la reutilización de ids, el filtro es lo que impide vender dos
    // veces el mismo inventario.
    const ctx = makeContext({
      strategy: StrategyKind.GRIDMART,
      config,
      price: '101',
      position: makePosition('0.25', '100'),
      cycle: {
        anchorPrice: '100',
        filledLevelIndexes: [0, 1],
        scratch: { cycleSeq: 1, rebuys: [{ index: 0, price: '100.5', qty: '0.05' }] },
      },
    });
    const sells = byKind(getStrategy(StrategyKind.GRIDMART).plan(ctx).orders, LevelKind.GRID_SELL);
    expect(sells.some((s) => s.levelIndex === 0)).toBe(false);
    // Los demás escalones siguen cotizados con normalidad.
    expect(sells.length).toBeGreaterThan(0);
  });

  it('avisa si el descuento de recompra vacía el núcleo', () => {
    const { issues } = getStrategy(StrategyKind.GRIDMART).validate(
      cfg({ ...(config as object), gridRebuyDiscountPct: '5' }),
      makeMarket(),
    );
    expect(issues.some((i) => i.field === 'gridRebuyDiscountPct')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// MARKET MAKER
// ═══════════════════════════════════════════════════════════════

describe('marketMaker.plan', () => {
  const config = cfg({
    direction: 'NEUTRAL',
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    buyDistanceBps: '20',
    sellDistanceBps: '20',
    minAllowedDistanceBps: '8',
    refreshSeconds: 30,
    layers: 2,
    layerDistanceMultiplier: '1.5',
    layerSizeMultiplier: '1',
    riskProfile: 'BALANCED',
    dynamicSpread: false,
    inventoryPriceAdjustment: false,
    leverage: 1,
  });

  it('cotiza las capas a distancias crecientes por los dos lados', () => {
    const ctx = makeContext({ strategy: StrategyKind.MARKET_MAKER, config, price: '100' });
    const { orders } = getStrategy(StrategyKind.MARKET_MAKER).plan(ctx);

    // 20 bps = 0,2 % → 99,8 / 100,2. Capa 2 a 30 bps → 99,7 / 100,3.
    expect(byKind(orders, LevelKind.QUOTE_BID).map((o) => o.price)).toEqual(['99.8', '99.7']);
    expect(byKind(orders, LevelKind.QUOTE_ASK).map((o) => o.price)).toEqual(['100.2', '100.3']);
  });

  it('cotiza siempre como maker: nunca cruza el libro', () => {
    const ctx = makeContext({ strategy: StrategyKind.MARKET_MAKER, config, price: '100' });
    const { orders } = getStrategy(StrategyKind.MARKET_MAKER).plan(ctx);
    expect(orders.every((o) => o.type === 'POST_ONLY')).toBe(true);
  });

  it('deja de comprar cuando el inventario llega al tope largo', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER,
      config: cfg({ ...(config as object), maxLongPosition: '50' }),
      price: '100',
      position: makePosition('1', '100'), // 100 de exposición larga
    });
    const { orders } = getStrategy(StrategyKind.MARKET_MAKER).plan(ctx);
    expect(byKind(orders, LevelKind.QUOTE_BID)).toHaveLength(0);
    expect(byKind(orders, LevelKind.QUOTE_ASK).length).toBeGreaterThan(0);
  });

  it('con inventario largo el sesgo baja el centro para soltar antes', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER,
      config: cfg({
        ...(config as object),
        inventoryPriceAdjustment: true,
        inventorySkewFactor: '1',
      }),
      price: '100',
      position: makePosition('5', '100'), // 500 = 50 % del tope
    });
    const { orders } = getStrategy(StrategyKind.MARKET_MAKER).plan(ctx);
    const ask = byKind(orders, LevelKind.QUOTE_ASK)[0];
    // Sin sesgo la primera venta iría a 100,2; con inventario largo baja.
    expect(Number(ask.price)).toBeLessThan(100.2);
  });

  it('no recotiza dentro de la ventana de refresco', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER,
      config,
      price: '100.05', // deriva de 5 bps, por debajo del mínimo de 8
      now: 1_000_000,
      cycle: { scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 5_000 } },
    });
    const plan = getStrategy(StrategyKind.MARKET_MAKER).plan(ctx);
    expect(plan.scratchPatch).toBeUndefined();
    expect(byKind(plan.orders, LevelKind.QUOTE_BID)[0].price).toBe('99.8');
  });

  it('recotiza si el precio se va más allá de la distancia mínima', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER,
      config,
      price: '101', // 100 bps de deriva
      now: 1_000_000,
      cycle: { scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 5_000 } },
    });
    const plan = getStrategy(StrategyKind.MARKET_MAKER).plan(ctx);
    expect(plan.scratchPatch).toEqual({ quotedMid: '101.0', quotedAt: 1_000_000 });
  });

  it('recotiza al vencer el tiempo de refresco', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER,
      config,
      price: '100.01',
      now: 1_000_000,
      cycle: { scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 31_000 } },
    });
    expect(getStrategy(StrategyKind.MARKET_MAKER).plan(ctx).scratchPatch).toBeDefined();
  });

  it('nunca cotiza por debajo de la distancia mínima', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER,
      config: cfg({ ...(config as object), buyDistanceBps: '2', minAllowedDistanceBps: '2' }),
      price: '100',
    });
    const bid = byKind(
      getStrategy(StrategyKind.MARKET_MAKER).plan(ctx).orders,
      LevelKind.QUOTE_BID,
    )[0];
    expect(Number(bid.price)).toBeLessThanOrEqual(99.98);
  });

  it('en dirección LONG solo pone compras', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER,
      config: cfg({ ...(config as object), direction: 'LONG' }),
      price: '100',
    });
    const { orders } = getStrategy(StrategyKind.MARKET_MAKER).plan(ctx);
    expect(orders.every((o) => o.side === 'BUY')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// MUTABILIDAD DE LA CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════

describe('diffConfig', () => {
  const strategy = getStrategy(StrategyKind.MARTINGALE);
  const base = cfg({
    numLimitBuys: 2,
    initialSeparationPct: '1',
    stepScale: '2',
    volumeScale: '2',
    takeProfitPct: '1',
  });

  it('sin cambios reales no propone nada', () => {
    expect(diffConfig(strategy, base, { ...base }).level).toBe('NONE');
  });

  it('ignora diferencias de tipo entre string y número', () => {
    // El formulario devuelve '2' donde la BD guardaba 2: si esto contara como
    // cambio, el bot retendería la escalera cada vez que se abre la pantalla.
    const diff = diffConfig(strategy, base, cfg({ ...(base as object), leverage: '1' }));
    expect(diff.level).toBe('NONE');
  });

  it('un take profit nuevo es HOT: se aplica sin tocar la posición', () => {
    const diff = diffConfig(strategy, base, cfg({ ...(base as object), takeProfitPct: '2' }));
    expect(diff.level).toBe(Mutability.HOT);
    expect(diff.changed.map((c) => c.key)).toEqual(['takeProfitPct']);
  });

  it('cambiar la forma de la escalera es WARM', () => {
    const diff = diffConfig(strategy, base, cfg({ ...(base as object), numLimitBuys: 4 }));
    expect(diff.level).toBe(Mutability.WARM);
  });

  it('cambiar el par es COLD y se puede identificar para rechazarlo', () => {
    const diff = diffConfig(strategy, base, cfg({ ...(base as object), symbol: 'ETH' }));
    expect(diff.level).toBe(Mutability.COLD);
    expect(diff.coldFields).toEqual(['symbol']);
  });

  it('manda el cambio más restrictivo del lote', () => {
    const diff = diffConfig(
      strategy,
      base,
      cfg({ ...(base as object), takeProfitPct: '2', numLimitBuys: 4 }),
    );
    expect(diff.level).toBe(Mutability.WARM);
    expect(diff.changed).toHaveLength(2);
  });

  it('un campo desconocido se trata como COLD, nunca se aplica a ciegas', () => {
    const diff = diffConfig(strategy, base, cfg({ ...(base as object), campoRaro: 'x' }));
    expect(diff.level).toBe(Mutability.COLD);
  });
});

// ═══════════════════════════════════════════════════════════════
// INVARIANTES DEL REGISTRO
// ═══════════════════════════════════════════════════════════════

describe('registro de estrategias', () => {
  /**
   * `meta.default` y `defaults()` tienen que decir lo mismo (spec 037 R-5).
   *
   * No es cosmetico: el formulario se siembra con `defaults()`, pero el panel de
   * ayuda le ensena al usuario `meta.default` como «por defecto: X», y
   * `coerceConfig` del asesor cae a `meta.default` cuando no puede interpretar
   * un valor. Con los dos numeros en desacuerdo, la ayuda miente y el asesor
   * puede materializar un valor que la estrategia nunca eligio.
   *
   * Paso en la V2: el spec 035 bajo la distancia de 40 a 20 y subio la edad
   * maxima de 120 a 300 en `defaults()`, y nadie toco los descriptores.
   *
   * Las cuatro excepciones son campos COMUNES cuyo descriptor vive una sola vez
   * en `COMMON_FIELDS` mientras cada estrategia lo redefine en su `defaults()`.
   * La via para arreglarlo ya existe -`commonFieldsWith`, que es lo que usan los
   * dos market makers- y sale en su propio spec (037/F-08). Esta lista tiene que
   * MENGUAR; si crece, es que alguien ha desincronizado un campo nuevo.
   */
  const DESINCRONIZADOS_CONOCIDOS: Record<string, string[]> = {
    NEUTRAL_GRID: ['marginMode'],
    TDCA: ['leverage'],
    MARTINGALE: ['cooldownMinutes'],
    GRIDMART: ['cooldownMinutes'],
  };

  it('solo la de tendencia pide velas (specs 038 y 040)', () => {
    // El motor reconcilia contra el LIBRO, no contra un grafico. Ese principio
    // sigue valiendo para las SIETE que reconcilian; la de tendencia decide
    // mirando un grafico y por eso es la unica que declara `candles`.
    //
    // Si este test se pone rojo por una estrategia nueva en la lista, que sea a
    // proposito y con su spec: cada `candles` declarado es un sondeo de velas
    // mas contra el cupo del venue.
    const conVelas = listStrategies()
      .filter((s) => s.candles !== undefined)
      .map((s) => s.kind);
    expect(conVelas).toEqual([StrategyKind.TREND_FOLLOW]);
  });

  it('comunCon revienta al cargar si la clave no existe', () => {
    // El motivo de que exista: `COMMON_FIELDS.find(...)!` convertia una clave
    // mal escrita en un descriptor SIN `key`, que `commonFieldsWith` anade como
    // campo basura al final en vez de sustituir nada. Silencioso.
    expect(() => comunCon('marginMode', { default: 'CROSS' })).not.toThrow();
    expect(() => comunCon('margenMode', { default: 'CROSS' })).toThrow(/margenMode/);
  });

  /**
   * La unica excepcion, y esta razonada.
   *
   * GridMart HEREDA la escalera de Martingala y su validacion compartida exige
   * `takeProfitPct`, pero alli no gobierna ninguna orden -sale por el satelite y
   * por la rejilla del nucleo-, asi que el spec 026 lo saco del formulario. Es
   * el unico caso en el que un campo tiene que estar en la config y no puede
   * estar en la meta. Queda anotado para que la proxima estrategia que lo
   * intente tenga que explicarse aqui.
   */
  const NO_DECLARADOS_CONOCIDOS: Record<string, string[]> = {
    GRIDMART: ['takeProfitPct', 'tpMode'],
  };

  it('defaults() no devuelve ningun campo que meta.fields no declare', () => {
    // Spec 044, F-04. `diffConfig` trata como COLD todo campo que la estrategia
    // no declara -la opcion conservadora, y la correcta-. Un campo que vive en
    // la configuracion sin estar en la meta es una trampa cargada: un cliente
    // que reconstruyera la config desde `meta.fields` lo dejaria fuera,
    // `diffConfig` lo veria cambiar a `undefined` y RECHAZARIA la edicion entera
    // de un bot en marcha por un campo que el usuario no puede ni ver.
    for (const s of listStrategies()) {
      const declarados = new Set(s.meta.fields.map((f) => f.key));
      const permitidos = NO_DECLARADOS_CONOCIDOS[s.kind] ?? [];
      const sobran = Object.keys(s.defaults()).filter(
        (k) => !declarados.has(k) && !permitidos.includes(k),
      );
      expect({ kind: s.kind, sobran }).toEqual({ kind: s.kind, sobran: [] });
    }
  });

  it('meta.default coincide con defaults() en toda estrategia', () => {
    for (const s of listStrategies()) {
      const d = s.defaults();
      const permitidos = DESINCRONIZADOS_CONOCIDOS[s.kind] ?? [];
      for (const f of s.meta.fields) {
        if (f.default === undefined || !(f.key in d)) continue;
        if (permitidos.includes(f.key)) continue;
        expect({ kind: s.kind, key: f.key, meta: String(f.default) }).toEqual({
          kind: s.kind,
          key: f.key,
          meta: String(d[f.key]),
        });
      }
    }
  });

  /**
   * Spec 001, F-71. Aster en modo cobertura exige `positionSide` en cada orden
   * y prohibe `reduceOnly`; el adaptador habla solo el dialecto unidireccional.
   * Pedir cobertura cambiaria el modo de TODA la cuenta (afecta a todos sus
   * bots) y a partir de ahi cada orden recibiria -4061. Se rechaza al validar,
   * y solo en Aster: en los otros venues el ajuste no existe y no hace daño.
   */
  it('el modo cobertura se rechaza en Aster en los dos market makers', () => {
    for (const kind of [StrategyKind.MARKET_MAKER, StrategyKind.MARKET_MAKER_V2]) {
      const s = getStrategy(kind);
      const config = {
        ...BASE_CONFIG,
        ...s.defaults(),
        positionMode: 'HEDGE',
      } as unknown as BotConfig;
      const enAster = s.validate(config, makeMarket({ venue: Venue.ASTER })).issues;
      expect(enAster.some((i) => i.field === 'positionMode' && i.severity === 'ERROR')).toBe(true);
      const enHl = s.validate(config, makeMarket()).issues;
      expect(enHl.some((i) => i.field === 'positionMode' && i.severity === 'ERROR')).toBe(false);
    }
  });

  it('todas exponen los campos comunes y valores por defecto', () => {
    for (const s of listStrategies()) {
      const keys = s.meta.fields.map((f) => f.key);
      expect(keys).toContain('leverage');
      expect(keys).toContain('totalInvestment');
      expect(keys).toContain('direction');
      expect(Object.keys(s.defaults()).length).toBeGreaterThan(0);
    }
  });

  it('ningún campo aparece duplicado en la misma estrategia', () => {
    for (const s of listStrategies()) {
      const keys = s.meta.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  /**
   * Spec 026 (001/F-12). Cuatro campos vivieron en el formulario sin que el
   * motor los leyera nunca, y GridMart heredaba de la escalera dos que no
   * gobiernan ninguna de sus órdenes. Fuera del formulario; las configuraciones
   * guardadas los conservan sin efecto.
   */
  it('los campos que no hacen nada no se ofrecen en ningún formulario', () => {
    const retirados = [
      'preloadInventory',
      'fullCycleCooldownMinutes',
      'reanchorOnDrift',
      'reanchorThresholdPct',
    ];
    for (const s of listStrategies()) {
      const keys = s.meta.fields.map((f) => f.key);
      for (const k of retirados) expect(keys).not.toContain(k);
      for (const k of retirados) expect(s.defaults()).not.toHaveProperty(k);
    }
    const gridmart = getStrategy(StrategyKind.GRIDMART).meta.fields.map((f) => f.key);
    expect(gridmart).not.toContain('takeProfitPct');
    expect(gridmart).not.toContain('tpMode');
    // La validación compartida de la escalera los sigue esperando: `defaults()` los fija.
    expect(getStrategy(StrategyKind.GRIDMART).defaults()).toMatchObject({ tpMode: 'LIMIT' });
  });

  /** Spec 026 (001/F-12): `targetLeverage` no tenía consumidor; el apalancamiento se fija al arrancar. */
  it('ningún plan devuelve targetLeverage', () => {
    const grid = getStrategy(StrategyKind.GRID_CLASSIC);
    const plan = grid.plan(
      makeContext({
        strategy: StrategyKind.GRID_CLASSIC,
        config: cfg({ ...grid.defaults(), lowerPrice: '90', upperPrice: '110' }),
        price: '100',
      }),
    );
    expect('targetLeverage' in plan).toBe(false);
  });

  /**
   * Spec 026 (001/F-94 y F-15). Los dos valores de fábrica que engañaban: GridMart
   * reabría la base en el mismo tick de cerrar el ciclo, y el Market Maker V2
   * cotizaba como si operar fuese gratis. Solo afectan a bots nuevos.
   */
  it('GridMart nace con un minuto de espera y el MM V2 con 2 bps de comisión estimada', () => {
    expect(getStrategy(StrategyKind.GRIDMART).defaults()).toMatchObject({ cooldownMinutes: 1 });
    expect(getStrategy(StrategyKind.MARKET_MAKER_V2).defaults()).toMatchObject({
      feeEstimateBps: '2',
    });
    const fee = getStrategy(StrategyKind.MARKET_MAKER_V2).meta.fields.find(
      (f) => f.key === 'feeEstimateBps',
    );
    expect(fee?.default).toBe(2);
  });

  /**
   * Spec 026 (001/F-94). El mínimo del campo (0,05 %) se conserva para no pausar
   * bots existentes al recargar; por debajo del 0,3 % —una entrada taker y una
   * salida maker— se avisa.
   */
  it('un take profit por debajo del 0,3 % avisa, en la martingala y en el satélite de GridMart', () => {
    const mart = getStrategy(StrategyKind.MARTINGALE);
    const corto = mart.validate(cfg({ ...mart.defaults(), takeProfitPct: '0.1' }), makeMarket());
    expect(corto.issues.some((i) => i.field === 'takeProfitPct' && i.severity === 'WARNING')).toBe(
      true,
    );
    const normal = mart.validate(cfg({ ...mart.defaults(), takeProfitPct: '1' }), makeMarket());
    expect(normal.issues.some((i) => i.field === 'takeProfitPct')).toBe(false);

    const gm = getStrategy(StrategyKind.GRIDMART);
    const satelite = gm.validate(cfg({ ...gm.defaults(), satelliteTpPct: '0.1' }), makeMarket());
    expect(
      satelite.issues.some((i) => i.field === 'satelliteTpPct' && i.severity === 'WARNING'),
    ).toBe(true);
  });

  it('todo campo obligatorio sin default queda marcado como tal', () => {
    for (const s of listStrategies()) {
      for (const f of s.meta.fields) {
        expect(typeof f.required).toBe('boolean');
        expect(['HOT', 'WARM', 'COLD']).toContain(f.mutability);
      }
    }
  });

  /**
   * Spec 001, F-13 (parte). `meta.fields` acota `stopLossPct` a 0,1-90 y
   * `maxDailyLossPct` a 0,1-100, pero `validateCommon` no miraba ninguno de los
   * dos: un cliente que saltara el formulario mandaba `stopLossPct: 150`, el
   * disparo salia a precio negativo y la posicion se quedaba sin stop con un
   * WARN. Y una perdida diaria de cero pausaba el bot al arrancar.
   */
  it('validateCommon rechaza un stop loss imposible y una pérdida diaria no positiva, en todas', () => {
    const MINIMOS: Record<string, Record<string, unknown>> = {
      GRID_CLASSIC: { lowerPrice: '90', upperPrice: '110', gridLevels: 5 },
      NEUTRAL_GRID: {
        lowerPrice: '90',
        upperPrice: '110',
        anchorPrice: '100',
        gridLevels: 5,
        maxExposure: '500',
      },
      TDCA: { amountPerBuy: '25' },
      MARTINGALE: {},
      GRIDMART: {},
      MARKET_MAKER: { orderSizePerSide: '50', maxBotPositionValue: '500' },
      MARKET_MAKER_V2: { orderSizePerSide: '50', maxBotPositionValue: '500', feeEstimateBps: '2' },
    };
    const malos: [string, string][] = [
      ['stopLossPct', '150'],
      ['stopLossPct', '0'],
      ['maxDailyLossPct', '-1'],
      ['maxDailyLossPct', '0'],
    ];
    for (const s of listStrategies()) {
      const base = cfg({ ...s.defaults(), ...MINIMOS[s.kind] });
      expect(s.validate(base, makeMarket()).ok).toBe(true);
      for (const [key, value] of malos) {
        const r = s.validate(cfg({ ...(base as object), [key]: value }), makeMarket());
        expect(r.issues.some((i) => i.severity === 'ERROR' && i.field === key)).toBe(true);
      }
    }
  });

  it('plan() es pura: dos llamadas con el mismo contexto dan lo mismo', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARTINGALE,
      config: cfg({
        numLimitBuys: 2,
        initialSeparationPct: '1',
        stepScale: '2',
        volumeScale: '2',
        takeProfitPct: '1',
        totalInvestment: '70',
      }),
      price: '99',
      position: makePosition('0.1', '100'),
      cycle: { anchorPrice: '100', filledLevelIndexes: [0] },
    });
    const a = getStrategy(StrategyKind.MARTINGALE).plan(ctx);
    const b = getStrategy(StrategyKind.MARTINGALE).plan(ctx);
    expect(a).toEqual(b);
  });
});

// ═══════════════════════════════════════════════════════════════
// MARKET MAKER — paridad V1
// ═══════════════════════════════════════════════════════════════

describe('market makers (spec 018)', () => {
  const v1 = cfg({
    direction: 'NEUTRAL',
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    buyDistanceBps: '20',
    sellDistanceBps: '20',
    minAllowedDistanceBps: '8',
    refreshSeconds: 30,
    layers: 2,
    layerDistanceMultiplier: '1.5',
    layerSizeMultiplier: '1',
    riskProfile: 'BALANCED',
    dynamicSpread: false,
    inventoryPriceAdjustment: false,
    leverage: 1,
  });
  const v2 = cfg({
    direction: 'NEUTRAL',
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    buyDistanceBps: '40',
    sellDistanceBps: '40',
    minAllowedDistanceBps: '8',
    refreshSeconds: 30,
    repriceThresholdBps: '30',
    orderMaxAgeSeconds: 0,
    fillCooldownSeconds: 0,
    layers: 1,
    layerDistanceMultiplier: '1',
    layerSizeMultiplier: '1',
    behaviorPreset: 'BALANCED',
    dynamicSpread: false,
    feeEstimateBps: '0',
    safetyBufferBps: '0',
    minProfitMarginBps: '0',
    maxDynamicSpreadBps: '1000',
    leverage: 1,
  });
  const mm = getStrategy(StrategyKind.MARKET_MAKER);
  const mm2 = getStrategy(StrategyKind.MARKET_MAKER_V2);
  const plan1 = (extra: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) =>
    mm.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER,
        config: cfg({ ...(v1 as object), ...extra }),
        price: '100',
        ...ctxExtra,
      }),
    );
  const plan2 = (extra: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) =>
    mm2.plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: cfg({ ...(v2 as object), ...extra }),
        price: '100',
        ...ctxExtra,
      }),
    );

  /** Spec 001, F-57: la vista previa enseñaba 12 USDC por capa y el bot mandaba 8,40. */
  it('la vista previa aplica el x0,7 del perfil conservador al tamaño', () => {
    const p1 = mm.preview(
      cfg({ ...(v1 as object), riskProfile: 'CONSERVATIVE', orderSizePerSide: '12' }),
      makeMarket(),
      '100',
    );
    expect(D(p1.levels[0].notional).lt(10)).toBe(true);
    expect(p1.valid).toBe(false);

    const p2 = mm2.preview(
      cfg({ ...(v2 as object), behaviorPreset: 'CONSERVATIVE', orderSizePerSide: '12' }),
      makeMarket(),
      '100',
    );
    expect(D(p2.levels[0].notional).lt(10)).toBe(true);
    expect(p2.valid).toBe(false);
  });

  /** Spec 001, F-58 y F-62: un par casado no reinicia el bot. */
  it('los market makers declaran que quedar plano no cierra el ciclo', () => {
    expect(mm.keepCycleOnFlat).toBe(true);
    expect(mm2.keepCycleOnFlat).toBe(true);
  });

  /** Spec 001, F-59: el tope por lado era un freno mudo. */
  it('el tope largo dispara la acción al límite y lo dice la nota', () => {
    const p = plan1(
      { maxLongPosition: '200', limitAction: 'CLOSE_ALL' },
      { position: makePosition('2.5', '100') },
    );
    expect(p.immediate).toHaveLength(1);
    expect(p.note).toMatch(/tope largo/i);
  });

  /** Spec 001, F-64: al copiar un bot llegaba '0.00' y el lado moría. */
  it('un tope por lado a cero es «sin tope propio», no un lado muerto', () => {
    const p = plan1({ maxLongPosition: '0.00' });
    expect(byKind(p.orders, LevelKind.QUOTE_BID).length).toBeGreaterThan(0);
  });

  it('rechaza un tope por lado que no deja sitio ni a la cotización más pequeña', () => {
    const r = mm.validate(cfg({ ...(v1 as object), maxLongPosition: '0.40' }), makeMarket());
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === 'maxLongPosition' && i.severity === 'ERROR')).toBe(
      true,
    );
  });

  /** Spec 001, F-60: el techo se aplicaba antes de capa, preset y régimen. */
  it('el techo del spread se aplica después de los multiplicadores', () => {
    const { orders } = plan2({
      buyDistanceBps: '500',
      sellDistanceBps: '500',
      maxDynamicSpreadBps: '50',
      behaviorPreset: 'CONSERVATIVE',
    });
    // 50 bps = 0,5 % → 99,5. Antes el preset Conservador cotizaba a 75 bps.
    expect(byKind(orders, LevelKind.QUOTE_BID)[0].price).toBe('99.5');
  });

  it('avisa si el techo del spread está a cero', () => {
    const r = mm2.validate(cfg({ ...(v2 as object), maxDynamicSpreadBps: '0' }), makeMarket());
    expect(r.issues.some((i) => i.field === 'maxDynamicSpreadBps')).toBe(true);
  });

  /** Spec 001, F-61: la volatilidad se recalculaba en cada tick y movía las órdenes. */
  it('la volatilidad medida no mueve los precios entre recotizaciones', () => {
    const t0 = 1_000_000;
    const extra = {
      dynamicSpread: true,
      volatilityMultiplier: '1',
      orderBookMarginBps: '0',
      volatilitySampleSeconds: 120,
    };
    const primero = plan2(extra, {
      now: t0,
      cycle: {
        scratch: {
          cycleSeq: 1,
          volSamples: [
            [t0 - 110_000, '99'],
            [t0 - 20_000, '101'],
          ],
        },
      },
    });
    expect(primero.scratchPatch?.quotedMid).toBeDefined();
    const segundo = plan2(extra, {
      now: t0 + 15_000,
      cycle: { scratch: { cycleSeq: 1, ...primero.scratchPatch } },
    });
    expect(segundo.scratchPatch).toBeUndefined();
    expect(byKind(segundo.orders, LevelKind.QUOTE_BID)[0].price).toBe(
      byKind(primero.orders, LevelKind.QUOTE_BID)[0].price,
    );
  });

  /** Spec 001, F-63: el recorte al hueco dejaba una capa de 5 USDC que el venue rechazaba cada 30 s. */
  it('el recorte al hueco no deja una capa por debajo del mínimo del par', () => {
    const { orders } = plan2(
      { useFullSizeUntilMax: false },
      { position: makePosition('9.95', '100') },
    );
    expect(byKind(orders, LevelKind.QUOTE_BID)).toHaveLength(0);
    expect(byKind(orders, LevelKind.QUOTE_ASK).length).toBeGreaterThan(0);
  });

  /** Spec 001, F-15 (parte MM): con precio de referencia la espera tras un fill nunca regía. */
  it('la espera tras un fill rige también con precio de referencia', () => {
    const p = plan1(
      { referencePrice: '100', fillCooldownSeconds: 60 },
      { now: 1_000_000, cycle: { scratch: { cycleSeq: 1 }, lastEntryAt: 1_000_000 - 10_000 } },
    );
    expect(p.note).toMatch(/espera/i);
  });

  it('avisa si la comisión estimada de la V2 es cero', () => {
    const r = mm2.validate(cfg({ ...(v2 as object), feeEstimateBps: '0' }), makeMarket());
    expect(r.issues.some((i) => i.field === 'feeEstimateBps' && i.severity === 'WARNING')).toBe(
      true,
    );
  });

  /** Spec 001, F-67: «la app avisa» si el mercado se aleja del ancla; no había aviso. */
  it('la nota avisa cuando el mercado se aleja del precio de referencia', () => {
    const p = plan1({ referencePrice: '100' }, { price: '110' });
    expect(p.note).toMatch(/ancla/i);
  });

  it('el aviso del suelo distingue la distancia mínima de la comisión y el margen', () => {
    const r = mm2.validate(cfg({ ...(v2 as object), minAllowedDistanceBps: '50' }), makeMarket());
    expect(r.issues.some((i) => /distancia mínima/i.test(i.message))).toBe(true);
  });
});

describe('marketMaker.plan — guardas nuevas', () => {
  const base = cfg({
    direction: 'NEUTRAL',
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    buyDistanceBps: '20',
    sellDistanceBps: '20',
    minAllowedDistanceBps: '8',
    refreshSeconds: 30,
    layers: 1,
    layerDistanceMultiplier: '1',
    layerSizeMultiplier: '1',
    riskProfile: 'BALANCED',
    dynamicSpread: false,
    inventoryPriceAdjustment: false,
    leverage: 1,
  });

  const plan = (extra: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) =>
    getStrategy(StrategyKind.MARKET_MAKER).plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER,
        config: cfg({ ...(base as object), ...extra }),
        price: '100',
        ...ctxExtra,
      }),
    );

  it('con post-only desactivado manda limit normales', () => {
    const { orders } = plan({ postOnly: false });
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.type === 'LIMIT')).toBe(true);
  });

  it('sigue siendo POST_ONLY por defecto', () => {
    expect(plan({}).orders.every((o) => o.type === 'POST_ONLY')).toBe(true);
  });

  it('la espera tras un fill congela la cotización vigente', () => {
    const p = plan(
      { fillCooldownSeconds: 60 },
      {
        price: '101', // 100 bps de deriva: sin cooldown recotizaría
        now: 1_000_000,
        cycle: {
          scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 40_000 },
          lastEntryAt: 1_000_000 - 10_000,
        },
      },
    );
    // No se mueve el ancla y, por tanto, tampoco los precios.
    expect(p.scratchPatch).toBeUndefined();
    expect(byKind(p.orders, LevelKind.QUOTE_BID)[0].price).toBe('99.8');
  });

  it('pasada la espera vuelve a recotizar', () => {
    const p = plan(
      { fillCooldownSeconds: 60 },
      {
        price: '101',
        now: 1_000_000,
        cycle: {
          scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 40_000 },
          lastEntryAt: 1_000_000 - 90_000,
        },
      },
    );
    expect(p.scratchPatch?.quotedMid).toBe('101.0');
  });

  it('en modo defensivo aleja el lado que añade y acerca el que reduce', () => {
    // Tick fino a propósito: con el de 0,1 del mercado por defecto, 12 y 20 bps
    // sobre un precio de 100 redondean al MISMO precio y el test no probaría nada.
    const fino = {
      position: makePosition('7.5', '100'),
      market: { tickSize: '0.01', priceDecimals: 2 },
    };
    const normal = plan({}, fino);
    const defensivo = plan(
      { defensiveThresholdPct: '70', highRiskThresholdPct: '95' },
      fino, // 750 = 75 % del tope
    );

    const bidNormal = Number(byKind(normal.orders, LevelKind.QUOTE_BID)[0].price);
    const bidDef = Number(byKind(defensivo.orders, LevelKind.QUOTE_BID)[0].price);
    const askNormal = Number(byKind(normal.orders, LevelKind.QUOTE_ASK)[0].price);
    const askDef = Number(byKind(defensivo.orders, LevelKind.QUOTE_ASK)[0].price);

    expect(bidDef).toBeLessThan(bidNormal); // la compra se aleja
    expect(askDef).toBeLessThan(askNormal); // la venta se acerca
  });

  // spec 037 R-9. Con ancla manual `quotedMid` no se escribe -el centro no se
  // mueve-, asi que `shouldRequote` era `true` para siempre. Con
  // `autoAdjustDistance` eso significa recalcular la distancia del libro vivo y
  // reescribir scratch en CADA tick: el derroche que el 029 congelo, por otra
  // puerta.
  it('con ancla y distancia automatica no se recotiza en cada tick', () => {
    const conAncla = { referencePrice: '100', autoAdjustDistance: true, refreshSeconds: 30 };
    const t0 = 1_000_000;

    const primero = plan(conAncla, { now: t0 });
    expect(primero.scratchPatch?.['quotedAt']).toBe(t0);
    // El centro es el ancla: no hay centro que recordar.
    expect(primero.scratchPatch?.['quotedMid']).toBeUndefined();

    // 15 s despues, dentro del refresco de 30 s y con el libro quieto.
    const segundo = plan(conAncla, {
      now: t0 + 15_000,
      cycle: { scratch: { ...(primero.scratchPatch ?? {}), cycleSeq: 1 } },
    });
    expect(segundo.scratchPatch?.['quotedAutoBps']).toBeUndefined();
    expect(byKind(segundo.orders, LevelKind.QUOTE_BID)[0].price).toBe(
      byKind(primero.orders, LevelKind.QUOTE_BID)[0].price,
    );
  });

  // spec 037 R-1. Los tests de arriba fijan `dynamicSpread: false`, asi que el
  // ensanchado por inventario nunca se habia comprobado con numeros. Se aplicaba
  // a los DOS lados multiplicando al regimen, que si es asimetrico, y con eso el
  // acercamiento de la salida quedaba anulado: a 75 % de carga la venta salia a
  // 20 x 1,75 x 0,6 = 21 bps, MAS lejos que los 20 de inventario cero.
  describe('el ensanchado por inventario no aleja la salida (spec 037 R-1)', () => {
    const fino = { tickSize: '0.01', priceDecimals: 2 };
    const conCarga = (qty: string) =>
      plan(
        { dynamicSpread: true, defensiveThresholdPct: '70', highRiskThresholdPct: '90' },
        { position: makePosition(qty, '100'), market: fino },
      );

    it('en defensivo la venta se acerca pese al ensanchado', () => {
      // 750 = 75 % del tope. 20 bps x 0,6 = 12 bps sobre 100: el ensanchado
      // (x1,75) es cosa del lado que anade.
      expect(byKind(conCarga('7.5').orders, LevelKind.QUOTE_ASK)[0].price).toBe('100.12');
    });

    it('el lado que anade conserva su ensanchado', () => {
      // 20 x 1,75 x 1,5 = 52,5 bps sobre 100, redondeado a la baja al tick.
      expect(byKind(conCarga('7.5').orders, LevelKind.QUOTE_BID)[0].price).toBe('99.47');
    });

    it('en alto riesgo la venta sale a la mitad de la distancia base', () => {
      // 900 = 90 % del tope, justo en el umbral: deja de anadir y solo reduce.
      const { orders } = conCarga('9');
      expect(byKind(orders, LevelKind.QUOTE_BID)).toHaveLength(0);
      expect(byKind(orders, LevelKind.QUOTE_ASK)[0].price).toBe('100.10'); // 20 x 0,5
    });
  });

  it('en alto riesgo deja de añadir y la salida sale reduce-only', () => {
    const { orders } = plan(
      { defensiveThresholdPct: '70', highRiskThresholdPct: '80' },
      { position: makePosition('9', '100') }, // 900 = 90 % del tope
    );
    expect(byKind(orders, LevelKind.QUOTE_BID)).toHaveLength(0);
    const asks = byKind(orders, LevelKind.QUOTE_ASK);
    expect(asks).toHaveLength(1);
    expect(asks[0].reduceOnly).toBe(true);
  });

  it('por encima del techo de precio solo cotiza el lado que reduce', () => {
    const { orders } = plan({ priceCeiling: '90' });
    // Plana y con techo superado: no se abre nada largo.
    expect(byKind(orders, LevelKind.QUOTE_BID)).toHaveLength(0);
    expect(byKind(orders, LevelKind.QUOTE_ASK).length).toBeGreaterThan(0);
  });

  it('por debajo del piso de precio no abre cortos', () => {
    const { orders } = plan({ priceFloor: '110' });
    expect(byKind(orders, LevelKind.QUOTE_ASK)).toHaveLength(0);
    expect(byKind(orders, LevelKind.QUOTE_BID).length).toBeGreaterThan(0);
  });

  it('el precio de referencia sustituye al mercado como ancla', () => {
    const { orders, scratchPatch } = plan({ referencePrice: '200' });
    // 20 bps por encima de 200, no de 100. Se mira la VENTA porque con el libro
    // en 99,95/100,05 es el lado que el ancla deja fuera del toque sin cruzar.
    expect(byKind(orders, LevelKind.QUOTE_ASK)[0].price).toBe('200.4');
    // Con ancla manual no hay nada que recordar entre ticks.
    expect(scratchPatch).toBeUndefined();
  });

  it('un ancla lejos del libro ya no manda una compra cruzada (spec 029)', () => {
    // El ancla pedía comprar a 199,6 con el libro en 99,95/100,05: el venue la
    // rechazaba por post-only tick tras tick, y sin post-only habría comprado
    // en taker al doble de precio. Pegada al toque compra MÁS BARATO de lo que
    // el ancla pedía, así que el clamp nunca empeora la ejecución.
    const { orders } = plan({ referencePrice: '200' });
    const bid = byKind(orders, LevelKind.QUOTE_BID)[0];
    expect(Number(bid.price)).toBeLessThan(100.05);
  });

  it('con tamaños en moneda la cantidad NO se divide por el precio', () => {
    const { orders } = plan({ sizingMode: 'BASE', orderSizePerSide: '0.5' });
    // El texto lleva los decimales del mercado; lo que se compara es la cifra.
    expect(Number(byKind(orders, LevelKind.QUOTE_BID)[0].qty)).toBe(0.5);
  });

  it('al tocar el tope con «cerrar todo» manda un cierre a mercado', () => {
    const p = plan(
      { limitAction: 'CLOSE_ALL' },
      { position: makePosition('10', '100') }, // 1000 = el tope exacto
    );
    expect(p.immediate).toHaveLength(1);
    expect(p.immediate[0].type).toBe('MARKET');
    expect(p.immediate[0].side).toBe('SELL');
    expect(p.immediate[0].reduceOnly).toBe(true);
    expect(p.scratchPatch?.limitActionFiredAt).toBeDefined();
  });

  it('«cerrar todo» no se repite si ya se disparó en este ciclo', () => {
    const p = plan(
      { limitAction: 'CLOSE_ALL' },
      {
        position: makePosition('10', '100'),
        cycle: { scratch: { cycleSeq: 1, limitActionFiredAt: 999 } },
      },
    );
    expect(p.immediate).toHaveLength(0);
  });

  /**
   * Spec 001, F-02. El aplanado salia con `STOP_LOSS#0`, el MISMO id que el
   * stop que inyecta el motor. `withStopLoss` solo miraba `orders`, asi que
   * anadia su stop con ese id; la fila viva del stop vetaba la inmediata y
   * «cerrar todo» no salia jamas — justo cuando mas falta hacia.
   */
  it('el aplanado no reutiliza el id del stop loss: los dos conviven', () => {
    const position = makePosition('10', '100');
    const p = plan({ limitAction: 'CLOSE_ALL', stopLossPct: '10' }, { position });
    const conStop = withStopLoss(p, position, {
      botId: '1a2b3c4d-0000-0000-0000-000000000000',
      cycleSeq: 1,
      market: makeMarket(),
      stopLossPct: '10',
    });
    const stop = conStop.orders.find((o) => o.levelKind === LevelKind.STOP_LOSS);
    expect(p.immediate).toHaveLength(1);
    expect(stop).toBeDefined();
    expect(p.immediate[0].clientOrderId).not.toBe(stop!.clientOrderId);
  });

  it('«apagar» pide además que el motor pare el bot', () => {
    const p = plan({ limitAction: 'SHUTDOWN' }, { position: makePosition('10', '100') });
    expect(p.scratchPatch?.requestStop).toBe('STOP_KEEP_POSITION');
  });

  it('una orden de salida caducada deja de desearse, para reponerla al precio nuevo', () => {
    const ctxExtra = {
      position: makePosition('5', '100'), // largo: la venta es la salida
      now: 1_000_000,
      openOrders: [makeVenueOrder('1a2b3c4d00000000.1.QA0', '100.2', 'SELL', 1_000_000 - 120_000)],
    };
    const vivo = plan({ exitOrderTtlSeconds: 0 }, ctxExtra);
    const caducado = plan({ exitOrderTtlSeconds: 60 }, ctxExtra);

    expect(byKind(vivo.orders, LevelKind.QUOTE_ASK)).toHaveLength(1);
    expect(byKind(caducado.orders, LevelKind.QUOTE_ASK)).toHaveLength(0);
  });
  // ── Anti-cruce: el precio se acota al libro (spec 029) ──────────────────
  //
  // El sesgo por inventario hundía el centro sin ningún tope relativo al
  // libro, así que con la posición al tope TODAS las ventas salían por debajo
  // del mejor bid. Con post-only el venue las rechazaba (el bot dejaba de
  // cotizar y no podía reducir inventario); sin él, vendia en taker.
  //
  // Tick fino a propósito: con el de 0,1 del mercado por defecto el redondeo
  // conservador de `px` disimula el cruce y el test no probaría nada.
  const fino = { market: { tickSize: '0.01', priceDecimals: 2 } };
  const cargado = {
    riskProfile: 'AGGRESSIVE',
    inventoryPriceAdjustment: true,
    inventorySkewFactor: '1',
    dynamicSpread: true,
    defensiveThresholdPct: '70',
    highRiskThresholdPct: '90',
  };

  it('ninguna venta queda en el mejor bid o por debajo, con el inventario al tope', () => {
    const { orders } = plan(cargado, {
      ...fino,
      position: makePosition('10', '100'), // 1000 = 100 % del tope
    });
    const asks = byKind(orders, LevelKind.QUOTE_ASK);
    expect(asks.length).toBeGreaterThan(0);
    // El libro de `makeTicker('100')`: bid 99,95 / ask 100,05.
    for (const a of asks) {
      expect(a.side).toBe('SELL');
      expect(Number(a.price)).toBeGreaterThan(99.95);
    }
  });

  it('tampoco con el sesgo por inventario al máximo', () => {
    const { orders } = plan(
      { ...cargado, inventorySkewFactor: '3' },
      { ...fino, position: makePosition('10', '100') },
    );
    for (const a of byKind(orders, LevelKind.QUOTE_ASK)) {
      expect(Number(a.price)).toBeGreaterThan(99.95);
    }
  });

  it('ninguna compra queda en el mejor ask o por encima, con la posición corta al tope', () => {
    const { orders } = plan(cargado, {
      ...fino,
      position: makePosition('-10', '100'), // corto al tope: la compra es la salida
    });
    const bids = byKind(orders, LevelKind.QUOTE_BID);
    expect(bids.length).toBeGreaterThan(0);
    for (const b of bids) {
      expect(b.side).toBe('BUY');
      expect(Number(b.price)).toBeLessThan(100.05);
    }
  });

  it('sin libro no cotiza: un centro de oráculo no dice donde está el toque', () => {
    const { orders, note } = plan({}, { ticker: { bid: '0', ask: '0' } });
    expect(byKind(orders, LevelKind.QUOTE_BID)).toHaveLength(0);
    expect(byKind(orders, LevelKind.QUOTE_ASK)).toHaveLength(0);
    expect(note).toMatch(/libro/i);
  });

  it('la nota dice cuántas cotizaciones hay de verdad en el libro (spec 029)', () => {
    // Contaba las DESEADAS: un bot al que el venue rechazaba todas decía
    // «2 cotizaciones» con el libro vacío.
    const sinLibro = plan({}, {});
    expect(sinLibro.note).toMatch(/cotizaciones \(0 en el libro\)/);

    // Con las dos colocadas, no se repite el número.
    const conLibro = plan(
      {},
      {
        openOrders: [
          makeVenueOrder('1a2b3c4d00000000.1.QB0', '99.8', 'BUY'),
          makeVenueOrder('1a2b3c4d00000000.1.QA0', '100.2', 'SELL'),
        ],
      },
    );
    expect(conLibro.note).toMatch(/2 cotizaciones\./);
    expect(conLibro.note).not.toMatch(/en el libro/);
  });

  // ── Recotizado por capa (spec 031) ────────────────────────────────────
  //
  // Recotizar movía SIEMPRE las 2·N capas, a cuatro peticiones por capa. En
  // Lighter (60/min por IP) un solo bot de tres capas se comía la cuota. La
  // capa lejana no gana nada moviéndose unos bps, y perder su sitio en la cola
  // sí cuesta.
  const fino2 = { market: { tickSize: '0.01', priceDecimals: 2 } };

  it('una capa que apenas se ha movido conserva su sitio', () => {
    // Deseado 99,80 (20 bps bajo 100). La viva está en 99,83: 3 bps de desvío,
    // por debajo de la tolerancia de 5 (20 × 0,25).
    const { orders } = plan(
      {},
      {
        ...fino2,
        openOrders: [makeVenueOrder('1a2b3c4d00000000.1.QB0', '99.83', 'BUY')],
      },
    );
    expect(byKind(orders, LevelKind.QUOTE_BID)[0].price).toBe('99.83');
  });

  it('pero una que se ha ido de verdad se recoloca', () => {
    const { orders } = plan(
      {},
      {
        ...fino2,
        openOrders: [makeVenueOrder('1a2b3c4d00000000.1.QB0', '99.50', 'BUY')],
      },
    );
    expect(byKind(orders, LevelKind.QUOTE_BID)[0].price).toBe('99.80');
  });

  it('la tolerancia es proporcional: la capa lejana aguanta más', () => {
    // Capa 1 a 30 bps (multiplicador 1,5): tolera 7,5 bps. La misma desviación
    // de 6 bps mueve la capa 0 (tolera 5) y no mueve la 1.
    const ctxExtra = {
      ...fino2,
      openOrders: [
        makeVenueOrder('1a2b3c4d00000000.1.QB0', '99.74', 'BUY'),
        makeVenueOrder('1a2b3c4d00000000.1.QB1', '99.64', 'BUY'),
      ],
    };
    const { orders } = plan({ layers: 2, layerDistanceMultiplier: '1.5' }, ctxExtra);
    const bids = byKind(orders, LevelKind.QUOTE_BID);
    // La capa 0 desea 99,80 y la viva está a 6 bps: se recoloca.
    expect(bids[0].price).toBe('99.80');
    // La capa 1 desea 99,70 y la viva está a 6 bps: se queda.
    expect(bids[1].price).toBe('99.64');
  });

  it('«ajustar distancia» no recotiza por su cuenta entre refrescos (spec 029)', () => {
    // Se leía el libro en vivo fuera de la puerta de recotizado, así que con
    // esta opción los precios cambiaban en cada tick aunque el centro estuviera
    // congelado: 2·N capas canceladas y repuestas cada quince segundos.
    const congelado = {
      now: 1_000_000,
      cycle: {
        scratch: {
          cycleSeq: 1,
          quotedMid: '100',
          quotedAt: 1_000_000 - 1000,
          quotedAutoBps: '30.0000',
        },
      },
    };
    // El libro se ensancha (spread 2 sobre 100 = 200 bps) pero no toca recotizar.
    const p = plan(
      { autoAdjustDistance: true },
      { ...congelado, ticker: { bid: '99', ask: '101' } },
    );
    // 30 bps guardados sobre el centro congelado de 100.
    expect(byKind(p.orders, LevelKind.QUOTE_BID)[0].price).toBe('99.7');
    expect(p.scratchPatch?.quotedAutoBps).toBeUndefined();
  });

  it('el clamp no altera el orden de las capas', () => {
    const { orders } = plan(
      { ...cargado, layers: 3, layerDistanceMultiplier: '1.5' },
      { ...fino, position: makePosition('10', '100') },
    );
    const asks = byKind(orders, LevelKind.QUOTE_ASK);
    for (let i = 1; i < asks.length; i++) {
      expect(Number(asks[i].price)).toBeGreaterThanOrEqual(Number(asks[i - 1].price));
    }
  });
});

describe('en modo moneda el preview suple los avisos de tope (spec 030)', () => {
  // `validate()` no tiene precio, asi que no puede comparar una cantidad de
  // moneda con un tope en nocional y se saltaba las dos comprobaciones. El
  // preview si lo tiene.
  const previewCon = (extra: Record<string, unknown>) =>
    getStrategy(StrategyKind.MARKET_MAKER).preview(
      cfg({
        ...(getStrategy(StrategyKind.MARKET_MAKER).defaults() as object),
        totalInvestment: '5000',
        maxBotPositionValue: '20000',
        sizingMode: 'BASE',
        orderSizePerSide: '1',
        ...extra,
      }),
      makeMarket({ minQty: '0.0001' }),
      '100',
    );

  it('avisa de que las capas no caben en el tope', () => {
    // 3 capas de 1 unidad a 100 = 300 de nocional por lado, con tope 200.
    const p = previewCon({ maxBotPositionValue: '200' });
    expect(p.issues.some((i) => i.field === 'layers')).toBe(true);
  });

  it('avisa del tope por lado que mata una cara del bot (001/F-64)', () => {
    const p = previewCon({ maxLongPosition: '10' });
    expect(p.issues.some((i) => i.field === 'maxLongPosition')).toBe(true);
  });

  it('en modo nocional no duplica el aviso', () => {
    const p = getStrategy(StrategyKind.MARKET_MAKER).preview(
      cfg({
        ...(getStrategy(StrategyKind.MARKET_MAKER).defaults() as object),
        totalInvestment: '5000',
        maxBotPositionValue: '200',
        sizingMode: 'QUOTE',
        orderSizePerSide: '100',
      }),
      makeMarket(),
      '100',
    );
    expect(p.issues.filter((i) => i.field === 'layers').length).toBeLessThanOrEqual(1);
  });
});

describe('un market maker sin stop lo dice al crearlo (spec 031)', () => {
  // No se pone un stop por defecto a propósito: cierra la posición pero NO para
  // el bot, que vuelve a cotizar, así que uno estrecho sería una máquina de
  // vender en el mínimo y recomprar. Lo que faltaba era decirlo al crearlo.
  const valida = (kind: StrategyKind, extra: Record<string, unknown>) =>
    getStrategy(kind).validate(
      cfg({
        ...(getStrategy(kind).defaults() as object),
        totalInvestment: '5000',
        maxBotPositionValue: '20000',
        ...extra,
      }),
      makeMarket(),
    );

  for (const kind of [StrategyKind.MARKET_MAKER, StrategyKind.MARKET_MAKER_V2]) {
    it(`avisa cuando ${kind} no lleva stop`, () => {
      const sin = valida(kind, {});
      expect(sin.issues.some((i) => i.field === 'stopLossPct')).toBe(true);

      const con = valida(kind, { stopLossPct: '15' });
      expect(con.issues.some((i) => i.field === 'stopLossPct')).toBe(false);
    });
  }

  it('y no se ha cambiado el valor de fábrica: sigue sin stop', () => {
    for (const kind of [StrategyKind.MARKET_MAKER, StrategyKind.MARKET_MAKER_V2]) {
      expect(getStrategy(kind).defaults().stopLossPct).toBeUndefined();
    }
  });
});

describe('un parámetro que otro deja inerte lo dice (spec 030)', () => {
  // El patrón ya existía en Neutral Grid («la dirección no sesga la retícula»)
  // y en la V2 («la fuente externa no se usará»). Faltaba en cuatro parejas.
  const avisa = (kind: StrategyKind, extra: Record<string, unknown>, campo: string) => {
    const base = getStrategy(kind).defaults() as object;
    const r = getStrategy(kind).validate(
      cfg({ ...base, totalInvestment: '5000', maxBotPositionValue: '20000', ...extra }),
      makeMarket(),
    );
    return r.issues.some((i) => i.field === campo && i.severity === 'WARNING');
  };

  it('el factor de sesgo con el ajuste por inventario apagado', () => {
    expect(
      avisa(
        StrategyKind.MARKET_MAKER,
        { inventoryPriceAdjustment: false, inventorySkewFactor: '1' },
        'inventorySkewFactor',
      ),
    ).toBe(true);
    expect(
      avisa(
        StrategyKind.MARKET_MAKER,
        { inventoryPriceAdjustment: true, inventorySkewFactor: '1' },
        'inventorySkewFactor',
      ),
    ).toBe(false);
  });

  it('el margen del TDCA sin «solo si mejora el precio medio»', () => {
    expect(
      avisa(
        StrategyKind.TDCA,
        { buyOnlyIfImprovesAverage: false, marginBelowAveragePct: '0.5' },
        'marginBelowAveragePct',
      ),
    ).toBe(true);
  });

  it('lo que alimenta al diferencial dinámico cuando está apagado', () => {
    expect(
      avisa(
        StrategyKind.MARKET_MAKER_V2,
        { dynamicSpread: false, volatilityMultiplier: '1' },
        'volatilityMultiplier',
      ),
    ).toBe(true);
  });

  it('la rejilla de ventas de GridMart en modo Classic', () => {
    expect(avisa(StrategyKind.GRIDMART, { classicMode: true }, 'classicMode')).toBe(true);
    expect(avisa(StrategyKind.GRIDMART, { classicMode: false }, 'classicMode')).toBe(false);
  });
});

describe('el tamaño en moneda no se mide en USDC (spec 030)', () => {
  // `sizingMode` cambia la NATURALEZA del número: con BASE el usuario teclea
  // cantidad de la moneda, no USDC. El descriptor declaraba `min: 1` y
  // `unit: 'USDC'` fijos, así que el modo era inutilizable —1 BTC por capa y
  // lado— y el campo mentía sobre lo que se estaba tecleando.
  const mmCfg = (extra: Record<string, unknown>) =>
    cfg({
      ...(getStrategy(StrategyKind.MARKET_MAKER).defaults() as object),
      totalInvestment: '5000',
      maxBotPositionValue: '20000',
      ...extra,
    });

  it('con BASE admite menos de 1 unidad si el mercado lo admite', () => {
    const market = makeMarket({ minQty: '0.0001', base: 'BTC' });
    const r = getStrategy(StrategyKind.MARKET_MAKER).validate(
      mmCfg({ sizingMode: 'BASE', orderSizePerSide: '0.05' }),
      market,
    );
    expect(r.issues.filter((i) => i.field === 'orderSizePerSide')).toHaveLength(0);
  });

  it('con BASE sigue rechazando por debajo del mínimo del mercado', () => {
    const market = makeMarket({ minQty: '0.01', base: 'BTC' });
    const r = getStrategy(StrategyKind.MARKET_MAKER).validate(
      mmCfg({ sizingMode: 'BASE', orderSizePerSide: '0.001' }),
      market,
    );
    expect(r.issues.some((i) => i.field === 'orderSizePerSide')).toBe(true);
  });

  it('con QUOTE el mínimo sigue siendo 1 USDC', () => {
    const market = makeMarket({ minQty: '0.0001', base: 'BTC' });
    const r = getStrategy(StrategyKind.MARKET_MAKER).validate(
      mmCfg({ sizingMode: 'QUOTE', orderSizePerSide: '0.5' }),
      market,
    );
    expect(r.issues.some((i) => i.field === 'orderSizePerSide')).toBe(true);
  });

  it('la unidad del campo es la que el usuario teclea', () => {
    const market = makeMarket({ minQty: '0.0001', base: 'BTC' });
    const fields = getStrategy(StrategyKind.MARKET_MAKER).meta.fields;
    const enMoneda = camposEfectivos(fields, { sizingMode: 'BASE' }, market).find(
      (x) => x.key === 'orderSizePerSide',
    );
    const enNocional = camposEfectivos(fields, { sizingMode: 'QUOTE' }, market).find(
      (x) => x.key === 'orderSizePerSide',
    );
    expect(enMoneda?.unit).toBe('BTC');
    expect(enMoneda?.min).toBe(0.0001);
    expect(enNocional?.unit).toBe('USDC');
    expect(enNocional?.min).toBe(1);
  });

  it('los topes siguen siendo nocional en los dos modos', () => {
    const market = makeMarket({ minQty: '0.0001', base: 'BTC' });
    const fields = getStrategy(StrategyKind.MARKET_MAKER).meta.fields;
    const tope = camposEfectivos(fields, { sizingMode: 'BASE' }, market).find(
      (x) => x.key === 'maxBotPositionValue',
    );
    expect(tope?.unit).toBe('USDC');
  });
});

describe('marketMaker.validate — coherencia de los umbrales', () => {
  const valid = cfg({
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    buyDistanceBps: '20',
    sellDistanceBps: '20',
    minAllowedDistanceBps: '8',
    refreshSeconds: 30,
    layers: 1,
    layerDistanceMultiplier: '1',
    layerSizeMultiplier: '1',
  });

  it('rechaza un umbral defensivo por encima del de alto riesgo', () => {
    const { issues } = getStrategy(StrategyKind.MARKET_MAKER).validate(
      cfg({ ...(valid as object), defensiveThresholdPct: '90', highRiskThresholdPct: '80' }),
      makeMarket(),
    );
    expect(issues.some((i) => i.field === 'defensiveThresholdPct')).toBe(true);
  });

  it('rechaza un piso de precio por encima del techo', () => {
    const { issues } = getStrategy(StrategyKind.MARKET_MAKER).validate(
      cfg({ ...(valid as object), priceFloor: '120', priceCeiling: '100' }),
      makeMarket(),
    );
    expect(issues.some((i) => i.field === 'priceFloor')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// MARKET MAKER V2
// ═══════════════════════════════════════════════════════════════

describe('marketMakerV2.plan', () => {
  const base = cfg({
    direction: 'NEUTRAL',
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    buyDistanceBps: '40',
    sellDistanceBps: '40',
    minAllowedDistanceBps: '8',
    refreshSeconds: 30,
    repriceThresholdBps: '30',
    orderMaxAgeSeconds: 0,
    fillCooldownSeconds: 0,
    layers: 1,
    layerDistanceMultiplier: '1',
    layerSizeMultiplier: '1',
    behaviorPreset: 'BALANCED',
    dynamicSpread: false,
    feeEstimateBps: '0',
    safetyBufferBps: '0',
    minProfitMarginBps: '0',
    maxDynamicSpreadBps: '1000',
    leverage: 1,
  });

  const plan = (extra: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) =>
    getStrategy(StrategyKind.MARKET_MAKER_V2).plan(
      makeContext({
        strategy: StrategyKind.MARKET_MAKER_V2,
        config: cfg({ ...(base as object), ...extra }),
        price: '100',
        ...ctxExtra,
      }),
    );

  it('cotiza los dos lados a la distancia configurada', () => {
    const { orders } = plan({});
    // 40 bps = 0,4 % → 99,6 / 100,4.
    expect(byKind(orders, LevelKind.QUOTE_BID)[0].price).toBe('99.6');
    expect(byKind(orders, LevelKind.QUOTE_ASK)[0].price).toBe('100.4');
  });

  it('el suelo por coste eleva la distancia: comisión × 2 + margen mínimo', () => {
    // 5 bps de comisión por lado y 20 de margen mínimo = 30 bps de suelo, por
    // encima de los 10 configurados.
    const { orders } = plan({
      buyDistanceBps: '10',
      sellDistanceBps: '10',
      feeEstimateBps: '5',
      minProfitMarginBps: '20',
    });
    expect(Number(byKind(orders, LevelKind.QUOTE_BID)[0].price)).toBeLessThanOrEqual(99.7);
  });

  it('el spread dinámico máximo es un techo del total', () => {
    const { orders } = plan({
      buyDistanceBps: '500',
      sellDistanceBps: '500',
      maxDynamicSpreadBps: '50',
    });
    // 50 bps = 0,5 % → 99,5. Sin el techo serían 95.
    expect(byKind(orders, LevelKind.QUOTE_BID)[0].price).toBe('99.5');
  });

  it('la volatilidad medida ensancha el diferencial', () => {
    const quieto = plan(
      { dynamicSpread: true, volatilityMultiplier: '1', orderBookMarginBps: '0' },
      {
        now: 1_000_000,
        cycle: {
          scratch: {
            cycleSeq: 1,
            volSamples: [
              [1_000_000 - 20_000, '100'],
              [1_000_000 - 10_000, '100'],
            ],
          },
        },
      },
    );
    const movido = plan(
      { dynamicSpread: true, volatilityMultiplier: '1', orderBookMarginBps: '0' },
      {
        now: 1_000_000,
        cycle: {
          scratch: {
            cycleSeq: 1,
            volSamples: [
              [1_000_000 - 20_000, '98'],
              [1_000_000 - 10_000, '102'],
            ],
          },
        },
      },
    );

    const bidQuieto = Number(byKind(quieto.orders, LevelKind.QUOTE_BID)[0].price);
    const bidMovido = Number(byKind(movido.orders, LevelKind.QUOTE_BID)[0].price);
    expect(bidMovido).toBeLessThan(bidQuieto);
  });

  it('poda las muestras de volatilidad fuera de la ventana', () => {
    const p = plan(
      { dynamicSpread: true, volatilitySampleSeconds: 60 },
      {
        now: 1_000_000,
        cycle: {
          scratch: {
            cycleSeq: 1,
            volSamples: [
              [1_000_000 - 600_000, '90'], // fuera de los 60 s
              [1_000_000 - 10_000, '100'],
            ],
          },
        },
      },
    );
    const samples = p.scratchPatch?.volSamples as [number, string][];
    // La vieja fuera, la reciente dentro y la de este tick añadida.
    expect(samples).toHaveLength(2);
    expect(samples.every(([ts]) => 1_000_000 - ts <= 60_000)).toBe(true);
  });

  it('no reescribe las muestras de volatilidad si no toca recotizar', () => {
    // Es lo que evita un UPDATE en la base por cada tick de cada bot: entre
    // recotizaciones el diferencial no se aplica, así que afinarlo no sirve.
    const quieto = plan(
      { dynamicSpread: true },
      {
        price: '100.01', // 1 bps de deriva, por debajo del umbral de 30
        now: 1_000_000,
        cycle: { scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 5_000 } },
      },
    );
    expect(quieto.scratchPatch).toBeUndefined();

    const recotiza = plan(
      { dynamicSpread: true },
      {
        price: '101', // 100 bps: sí toca
        now: 1_000_000,
        cycle: { scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 5_000 } },
      },
    );
    expect(recotiza.scratchPatch?.volSamples).toBeDefined();
  });

  it('una cotización más vieja que el máximo fuerza recotizar sin deriva', () => {
    const ctxExtra = {
      price: '100.01', // deriva de 1 bps, muy por debajo del umbral de 30
      now: 1_000_000,
      cycle: { scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 5_000 } },
      openOrders: [makeVenueOrder('1a2b3c4d00000000.1.QB0', '99.6', 'BUY', 1_000_000 - 300_000)],
    };
    expect(plan({ orderMaxAgeSeconds: 0 }, ctxExtra).scratchPatch?.quotedMid).toBeUndefined();
    expect(plan({ orderMaxAgeSeconds: 120 }, ctxExtra).scratchPatch?.quotedMid).toBeDefined();
  });

  it('la caducidad por edad cancela y repone, en vez de quedarse fijada', () => {
    // Regresión. La caducidad forzaba recotizar pero seguía deseando la orden;
    // con el precio quieto el plan pedía el MISMO precio, el diff lo daba por
    // bueno, la orden no se tocaba, su antigüedad no se renovaba y el bot se
    // quedaba recotizando en cada tick para siempre — escribiendo el scratch en
    // la base cada quince segundos sin mover una sola orden.
    const vieja = makeVenueOrder('1a2b3c4d00000000.1.QB0', '99.6', 'BUY', 1_000_000 - 300_000);

    const tickN = plan(
      { orderMaxAgeSeconds: 60 },
      {
        now: 1_000_000,
        cycle: { scratch: { cycleSeq: 1, quotedMid: '100.0', quotedAt: 1_000_000 - 1_000 } },
        openOrders: [vieja],
      },
    );
    // No se desea: el reconciliador la cancela.
    expect(byKind(tickN.orders, LevelKind.QUOTE_BID)).toHaveLength(0);

    const tickSiguiente = plan(
      { orderMaxAgeSeconds: 60 },
      {
        now: 1_000_015,
        cycle: { scratch: { cycleSeq: 1, quotedMid: '100.0', quotedAt: 1_000_000 } },
        openOrders: [], // ya cancelada
      },
    );
    // Se repone y el bot vuelve a estar quieto: sin esto último, el ciclo de
    // escritura en la base no paraba nunca.
    expect(byKind(tickSiguiente.orders, LevelKind.QUOTE_BID)).toHaveLength(1);
    expect(tickSiguiente.scratchPatch).toBeUndefined();
  });

  it('durante la espera tras un fill no caduca nada', () => {
    // Congelar la cotización es lo que significa esa espera: dejar caducar una
    // orden la cancelaría y la repondría al mismo precio, que es la peor
    // combinación posible —se pierde la prioridad en el libro sin ganar nada.
    const p = plan(
      { orderMaxAgeSeconds: 60, fillCooldownSeconds: 600 },
      {
        now: 1_000_000,
        cycle: {
          scratch: { cycleSeq: 1, quotedMid: '100.0', quotedAt: 1_000_000 - 1_000 },
          lastEntryAt: 1_000_000 - 10_000,
        },
        openOrders: [makeVenueOrder('1a2b3c4d00000000.1.QB0', '99.6', 'BUY', 1_000_000 - 300_000)],
      },
    );
    expect(byKind(p.orders, LevelKind.QUOTE_BID)).toHaveLength(1);
  });

  it('la condición de activación retiene las órdenes hasta que se cruza el precio', () => {
    const esperando = plan({ activationMode: 'PRICE_ABOVE', activationPrice: '110' });
    expect(esperando.orders).toHaveLength(0);
    expect(esperando.note).toContain('110');

    const disparado = plan({ activationMode: 'PRICE_ABOVE', activationPrice: '90' });
    expect(disparado.orders.length).toBeGreaterThan(0);
    expect(disparado.scratchPatch?.armedAt).toBeDefined();
  });

  it('una vez armado sigue cotizando aunque el precio retroceda', () => {
    const p = plan(
      { activationMode: 'PRICE_ABOVE', activationPrice: '110' },
      { cycle: { scratch: { cycleSeq: 1, armedAt: 1 } } },
    );
    expect(p.orders.length).toBeGreaterThan(0);
  });

  it('sin precio de la fuente externa no cotiza nada', () => {
    const p = plan({ priceSource: 'BINANCE' }, { fairPrice: null });
    expect(p.orders).toHaveLength(0);
    expect(p.note).toContain('binance');
  });

  it('con precio de la fuente externa cotiza alrededor de ÉL, no del venue', () => {
    // El libro del venue va por encima de la fuente (200,5 / 200,6) a propósito:
    // si el bot cotizara sobre el mid del venue el bid saldría cerca de 199,75,
    // y sobre la fuente sale en 199,2. Antes bastaba con dejar el libro en 100,
    // pero ese bid habría cruzado el ask y hoy se pega al toque (spec 029).
    const { orders } = plan(
      { priceSource: 'BINANCE' },
      { fairPrice: '200', ticker: { bid: '200.5', ask: '200.6' } },
    );
    expect(byKind(orders, LevelKind.QUOTE_BID)[0].price).toBe('199.2');
  });

  it('una fuente externa que se aleja del libro no manda órdenes cruzadas (spec 029)', () => {
    // Símbolo de origen equivocado o mercado local sin liquidez: el centro
    // externo no tiene por qué parecerse al libro donde se firma la orden.
    const { orders } = plan({ priceSource: 'BINANCE' }, { fairPrice: '200' });
    for (const b of byKind(orders, LevelKind.QUOTE_BID)) {
      expect(Number(b.price)).toBeLessThan(100.05);
    }
    for (const a of byKind(orders, LevelKind.QUOTE_ASK)) {
      expect(Number(a.price)).toBeGreaterThan(99.95);
    }
  });

  it('el tope de posición también frena con los tamaños en moneda', () => {
    // Regresión. El hueco se mide en la quote y el tamaño estaba en la moneda
    // base: 0,5 BTC «cabían» en un hueco de 1000 USDC y se colocaba una orden de
    // 50 000 contra un tope de 1000. El tope no frenaba absolutamente nada.
    const { orders } = plan(
      { sizingMode: 'BASE', orderSizePerSide: '0.5', maxBotPositionValue: '1000' },
      { price: '100000', market: { tickSize: '1', priceDecimals: 0, qtyDecimals: 5 } },
    );
    for (const o of orders) {
      expect(Number(o.qty) * Number(o.price)).toBeLessThanOrEqual(1000);
    }
  });

  it('con tamaños en moneda y hueco de sobra respeta la cantidad exacta', () => {
    const { orders } = plan(
      { sizingMode: 'BASE', orderSizePerSide: '0.5', maxBotPositionValue: '1000000' },
      { price: '100000', market: { tickSize: '1', priceDecimals: 0, qtyDecimals: 5 } },
    );
    expect(Number(byKind(orders, LevelKind.QUOTE_BID)[0].qty)).toBe(0.5);
  });

  it('«usar tamaño normal hasta el máximo» prefiere no colocar antes que recortar', () => {
    // Quedan 50 de hueco y la capa pide 100.
    const ctxExtra = { position: makePosition('9.5', '100') };
    const recorta = plan({ useFullSizeUntilMax: false }, ctxExtra);
    const todoONada = plan({ useFullSizeUntilMax: true }, ctxExtra);

    expect(byKind(recorta.orders, LevelKind.QUOTE_BID)).toHaveLength(1);
    expect(byKind(todoONada.orders, LevelKind.QUOTE_BID)).toHaveLength(0);
  });

  it('plan() es pura: dos llamadas con el mismo contexto dan lo mismo', () => {
    const ctx = makeContext({
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: base,
      price: '100',
    });
    const strategy = getStrategy(StrategyKind.MARKET_MAKER_V2);
    expect(strategy.plan(ctx)).toEqual(strategy.plan(ctx));
  });
  it('sin libro no cotiza (spec 029)', () => {
    const { orders, note } = plan({}, { ticker: { bid: '0', ask: '0' } });
    expect(byKind(orders, LevelKind.QUOTE_BID)).toHaveLength(0);
    expect(byKind(orders, LevelKind.QUOTE_ASK)).toHaveLength(0);
    expect(note).toMatch(/libro/i);
  });

  it('el centro congelado no manda una venta por debajo del mejor bid (spec 029)', () => {
    // El mid se congela entre recotizaciones a propósito, para no perseguir al
    // precio. Si el mercado sube dentro de esa ventana, la venta repuesta al
    // precio viejo quedaba bajo el bid nuevo y el venue la rechazaba.
    const { orders } = plan(
      {},
      {
        price: '110',
        now: 1_000_000,
        cycle: { scratch: { cycleSeq: 1, quotedMid: '100', quotedAt: 1_000_000 - 1000 } },
      },
    );
    for (const a of byKind(orders, LevelKind.QUOTE_ASK)) {
      expect(Number(a.price)).toBeGreaterThan(109.95);
    }
  });

  // spec 037 R-2. `layerDistanceMultiplier` nace en 1 en la V2 (en la V1, en
  // 1,5), asi que subir `layers` sin tocarlo dejaba todas las capas al mismo
  // precio: cuota quemada y ningun beneficio, porque tres ordenes al mismo
  // precio no dan mas profundidad que una.
  it('no repite capas al mismo precio con el multiplicador en 1', () => {
    const { orders } = plan({ layers: 3, layerDistanceMultiplier: '1' });
    for (const lado of [LevelKind.QUOTE_BID, LevelKind.QUOTE_ASK]) {
      const precios = byKind(orders, lado).map((o) => o.price);
      expect(new Set(precios).size).toBe(precios.length);
    }
  });

  it('con multiplicador mayor que 1 sigue colocando todas las capas', () => {
    const { orders } = plan({ layers: 3, layerDistanceMultiplier: '1.5' });
    expect(byKind(orders, LevelKind.QUOTE_BID)).toHaveLength(3);
    expect(byKind(orders, LevelKind.QUOTE_ASK)).toHaveLength(3);
  });

  // spec 037 R-4. El techo se aplica despues de los multiplicadores de capa y
  // preset, y `preview()` no lo aplicaba: prometia el diferencial bruto en la
  // pantalla que el usuario mira ANTES de poner dinero.
  it('la vista previa pinta el mismo precio que coloca el bot, con techo', () => {
    const extra = { buyDistanceBps: '500', sellDistanceBps: '500', maxDynamicSpreadBps: '50' };
    const config = cfg({ ...(base as object), ...extra });
    const vista = getStrategy(StrategyKind.MARKET_MAKER_V2).preview(config, makeMarket(), '100');
    const { orders } = plan(extra);

    for (const kind of [LevelKind.QUOTE_BID, LevelKind.QUOTE_ASK]) {
      const delPlan = byKind(orders, kind)[0];
      const delPreview = vista.levels.find((n) => n.kind === kind)!;
      expect({ kind, price: delPreview.price }).toEqual({ kind, price: delPlan.price });
    }
  });

  // spec 037 R-6. Con NEUTRAL el bot cotiza los dos lados, asi que una sola
  // media ponderada de compras y ventas da una entrada media que no existe.
  // spec 037 R-7. Contaba `orders.length` -las DESEADAS-, asi que decia «2
  // cotizaciones» mientras el venue las rechazaba todas. El 029 lo corrigio en
  // la V1 con parseCoid y no se porto.
  it('la nota cuenta las cotizaciones vivas en el libro, no las deseadas', () => {
    const viva = {
      venue: 'HYPERLIQUID' as const,
      symbol: 'BTC',
      clientOrderId: makeCoid('1a2b3c4d-0000-0000-0000-000000000000', 1, LevelKind.QUOTE_BID, 0),
      venueOrderId: 'v1',
      side: 'BUY' as const,
      type: 'POST_ONLY' as const,
      price: '99.6',
      qty: '1',
      filledQty: '0',
      avgPrice: null,
      status: 'OPEN' as const,
      reduceOnly: false,
      createdAt: 1_000_000,
    };
    // Dos deseadas, UNA viva.
    const { note } = plan({}, { openOrders: [viva] });
    expect(note).toContain('1 cotizaciones');
  });

  // spec 037 R-8. `cooling` miraba `quotedMid != null` en vez de
  // `lastFillAt > 0`: con un reloj sintetico -backtest, dry-run- y sin una sola
  // ejecucion, `now - 0 < cooldownMs` es cierto y el bot no volvia a cotizar.
  it('sin ninguna ejecucion no hay espera, aunque el reloj sea pequeno', () => {
    // El reloj importa: 31 s es MENOS que el enfriamiento de 35 s -asi que la
    // condicion vieja `now - lastFillAt < cooldownMs`, con `lastEntryAt` nulo y
    // por tanto 0, se cumplia- y a la vez el precio se ha movido 100 bps, muy
    // por encima del umbral de reajuste.
    const primero = plan({ fillCooldownSeconds: 35 }, { now: 1000 });
    const bid0 = byKind(primero.orders, LevelKind.QUOTE_BID)[0].price;
    expect(bid0).toBe('99.6');

    const segundo = plan(
      { fillCooldownSeconds: 35 },
      {
        now: 31_000,
        price: '101',
        cycle: { scratch: { ...(primero.scratchPatch ?? {}), cycleSeq: 1 } },
      },
    );
    // Sin enfriamiento el centro sigue al mercado. Congelado, se habria quedado
    // cotizando alrededor de 100 para siempre, sin haber ejecutado nada.
    expect(Number(byKind(segundo.orders, LevelKind.QUOTE_BID)[0].price)).toBeGreaterThan(100);
  });

  it('la vista previa de un market maker NEUTRAL no mezcla los dos lados', () => {
    const vista = (direction: string) =>
      getStrategy(StrategyKind.MARKET_MAKER_V2).preview(
        cfg({ ...(base as object), direction, leverage: 5 }),
        makeMarket(),
        '100',
      );
    const neutral = vista('NEUTRAL');
    const soloLargo = vista('LONG');

    // Las compras de los dos son las MISMAS, asi que la liquidacion del lado
    // largo tiene que salir igual. Mezclando compras y ventas en una sola media
    // ponderada salia otra cosa: una entrada media que no existe.
    expect(neutral.estimatedLiquidationPrice).toBe(soloLargo.estimatedLiquidationPrice);
    // Y el lado corto se avisa aparte, en vez de desaparecer en la media.
    expect(neutral.issues.some((i) => /Lado corto/.test(i.message))).toBe(true);
  });
});

describe('marketMakerV2.validate', () => {
  const valid = cfg({
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    buyDistanceBps: '40',
    sellDistanceBps: '40',
    minAllowedDistanceBps: '8',
    refreshSeconds: 30,
    repriceThresholdBps: '30',
    layers: 1,
    layerDistanceMultiplier: '1',
    layerSizeMultiplier: '1',
  });

  const validate = (extra: Record<string, unknown>) =>
    getStrategy(StrategyKind.MARKET_MAKER_V2).validate(
      cfg({ ...(valid as object), ...extra }),
      makeMarket(),
    );

  it('acepta una configuración razonable', () => {
    expect(validate({}).ok).toBe(true);
  });

  it('rechaza varios niveles con el multiplicador de distancia en 1 (spec 037 R-2)', () => {
    const r = validate({ layers: 3, layerDistanceMultiplier: '1' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === 'layerDistanceMultiplier')).toBe(true);
  });

  it('un solo nivel con el multiplicador en 1 es correcto', () => {
    expect(validate({ layers: 1, layerDistanceMultiplier: '1' }).ok).toBe(true);
  });

  it('rechaza un símbolo de origen con la forma del par del venue', () => {
    // El descuido natural: copiar el par tal y como se ve en la app. Sin esta
    // comprobación el bot se creaba sin queja y luego no colocaba una sola
    // orden, que es la peor forma posible de enterarse de una errata.
    const { issues, ok } = validate({
      priceSource: PriceSource.BINANCE,
      sourceSymbolOverride: 'BTC/USDC',
    });
    expect(ok).toBe(false);
    expect(issues.some((i) => i.field === 'sourceSymbolOverride')).toBe(true);
  });

  it('acepta un símbolo de origen bien escrito', () => {
    // El caso para el que existe el campo: en Binance ese par se llama distinto.
    expect(
      validate({ priceSource: PriceSource.BINANCE, sourceSymbolOverride: '1000PEPEUSDT' }).ok,
    ).toBe(true);
  });

  it('rechaza un símbolo de origen sin fuente externa', () => {
    const { issues, ok } = validate({ sourceSymbolOverride: 'BTCUSDT' });
    expect(ok).toBe(false);
    expect(issues.some((i) => i.field === 'sourceSymbolOverride')).toBe(true);
  });

  it('avisa si se elige fuente externa pero se ancla al libro del venue', () => {
    // Funciona, pero casi siempre es un descuido: el usuario cree que cotiza
    // contra Binance y cotiza contra el mid local.
    const { issues, ok } = validate({
      priceSource: PriceSource.BINANCE,
      fairPriceOrigin: FairPriceOrigin.VENUE_MID,
    });
    expect(ok).toBe(true);
    expect(issues.some((i) => i.field === 'fairPriceOrigin' && i.severity === 'WARNING')).toBe(
      true,
    );
  });

  it('rechaza un techo de spread por debajo del suelo por coste', () => {
    const { issues, ok } = validate({
      feeEstimateBps: '10',
      minProfitMarginBps: '20',
      maxDynamicSpreadBps: '15',
    });
    expect(ok).toBe(false);
    expect(issues.some((i) => i.field === 'maxDynamicSpreadBps')).toBe(true);
  });

  it('avisa cuando el suelo por coste anula la distancia configurada', () => {
    const { issues } = validate({ feeEstimateBps: '30', minProfitMarginBps: '20' });
    expect(issues.some((i) => i.field === 'minProfitMarginBps' && i.severity === 'WARNING')).toBe(
      true,
    );
  });

  it('exige precio de disparo si hay condición de activación', () => {
    const { issues } = validate({ activationMode: 'PRICE_ABOVE' });
    expect(issues.some((i) => i.field === 'activationPrice')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// PREVIEW CON CONFIG INCOMPLETA
//
// El test que faltaba. `POST /bots/preview` respondia un 500 con
// `[DecimalError] Invalid argument: undefined` en cuanto se pulsaba «Calcular
// la escalera» sin haber rellenado «Capital asignado» — que es el estado en el
// que NACE el formulario, porque `totalInvestment` no trae `default` en
// ninguna estrategia.
//
// La causa: varios `preview()` calculaban `this.validate(...)` y seguian
// adelante igual, hasta un `D(cfg.lowerPrice)` o un `D(cfg.totalInvestment)`
// con `undefined` dentro.
//
// Se cubren todas a la vez y desde el registro, no una lista escrita a
// mano: una estrategia nueva entra sola en la bateria.
// ═══════════════════════════════════════════════════════════════

describe('preview() con una config que no vale', () => {
  const market = makeMarket();

  for (const strategy of listStrategies()) {
    describe(strategy.kind, () => {
      it('no lanza con la config vacia', () => {
        expect(() => strategy.preview({} as never, market, '100')).not.toThrow();
      });

      it('la marca invalida y explica por que, en vez de reventar', () => {
        const result = strategy.preview({} as never, market, '100');
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.severity === 'ERROR')).toBe(true);
      });

      // El caso REAL: el usuario elige estrategia, se cargan los defaults del
      // servidor y pulsa el boton. `defaults()` no trae `totalInvestment`.
      it('no lanza con solo los defaults, sin capital asignado', () => {
        const defaults = strategy.defaults();
        expect(defaults['totalInvestment']).toBeUndefined();
        expect(() => strategy.preview(defaults as never, market, '100')).not.toThrow();
        expect(strategy.preview(defaults as never, market, '100').valid).toBe(false);
      });

      it('devuelve un resultado BIEN FORMADO: la app lo pinta sin comprobar nada', () => {
        const result = strategy.preview({} as never, market, '100');
        expect(result.levels).toEqual([]);
        expect(result.worstCaseNotional).toBe('0');
        expect(result.worstCaseMargin).toBe('0');
        expect(result.estimatedLiquidationPrice).toBeNull();
        expect(result.liquidationDistancePct).toBeNull();
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// LOS TOPES ACOTAN LO QUE SE TIENDE (spec 048)
// ═══════════════════════════════════════════════════════════════

/**
 * La misma regla para las cinco estrategias que tienen tope de notional.
 *
 * Un tope que se comprueba contra lo que YA hay abierto no acota: deja pasar
 * todo lo que se vaya a tender y solo reacciona cuando el limite se ha
 * superado. El spec 001 (F-87) lo corrigio en la rejilla clasica, y la
 * correccion no se propago ni a la neutral ni al DCA.
 */
describe('los topes acotan lo que se TIENDE, no lo que ya hay (spec 048)', () => {
  it('H-02 · TDCA: la compra no puede rebasar el tope', () => {
    const config = cfg({
      strategy: StrategyKind.TDCA,
      leverage: 2,
      totalInvestment: '1000',
      amountPerBuy: 100,
      intervalMinutes: 1,
      maxBuysPerCycle: 20,
      buyOnlyIfImprovesAverage: false,
      takeProfitPct: 1.5,
      maxPositionNotional: 1000,
    });
    // Posicion de 990 de notional con el tope en 1000: cabe una compra de 10,
    // no una de 200.
    const ctx = makeContext({
      strategy: StrategyKind.TDCA,
      config,
      price: '100',
      position: makePosition('9.9', '100'),
      cycle: { entriesFilled: 1, filledLevelIndexes: [0] },
    });

    const plan = getStrategy(StrategyKind.TDCA).plan(ctx);
    const compras = plan.immediate.filter(
      (o) => o.levelKind === LevelKind.BASE || o.levelKind === LevelKind.SAFETY,
    );
    const anadido = compras.reduce((a, o) => a.plus(D(o.qty).mul('100')), D(0));

    expect(D('990').plus(anadido).lte(D('1000'))).toBe(true);
  });

  it('H-01 · NEUTRAL_GRID: la reticula tendida cabe en el tope', () => {
    const config = cfg({
      strategy: StrategyKind.NEUTRAL_GRID,
      direction: 'NEUTRAL',
      leverage: 2,
      totalInvestment: '1000',
      lowerPrice: '80',
      upperPrice: '120',
      anchorPrice: '100',
      gridLevels: 10,
      gridSpacing: 'ARITHMETIC',
      sizeMultiplier: 1,
      // El tope es una fraccion pequeña de lo que vale la reticula entera.
      maxExposure: '200',
    });
    const ctx = makeContext({
      strategy: StrategyKind.NEUTRAL_GRID,
      config,
      price: '100',
      position: null,
    });

    const plan = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx);
    // Sin posicion, TODO lo que se tiende aumentaria la exposicion.
    const tendido = plan.orders.reduce((a, o) => a.plus(D(o.qty).mul(D(o.price))), D(0));

    expect(tendido.lte(D('200'))).toBe(true);
  });

  it('H-01 · NEUTRAL_GRID: y con el tope holgado se tiende la reticula entera', () => {
    // La otra mitad: el corte no puede dejar el bot sin operar cuando cabe.
    const base = {
      strategy: StrategyKind.NEUTRAL_GRID,
      direction: 'NEUTRAL',
      leverage: 2,
      totalInvestment: '1000',
      lowerPrice: '80',
      upperPrice: '120',
      anchorPrice: '100',
      gridLevels: 10,
      gridSpacing: 'ARITHMETIC',
      sizeMultiplier: 1,
    };
    const conTope = getStrategy(StrategyKind.NEUTRAL_GRID).plan(
      makeContext({
        strategy: StrategyKind.NEUTRAL_GRID,
        config: cfg({ ...base, maxExposure: '999999' }),
        price: '100',
      }),
    );
    const sinTope = getStrategy(StrategyKind.NEUTRAL_GRID).plan(
      makeContext({
        strategy: StrategyKind.NEUTRAL_GRID,
        config: cfg(base),
        price: '100',
      }),
    );
    expect(conTope.orders.length).toBe(sinTope.orders.length);
  });
});

describe('H-03 · la reticula geometrica proyecta su ultima linea geometricamente', () => {
  it('la venta de la linea superior sigue la progresion, no la resta', () => {
    // Con 5 niveles entre 100 y 200 la progresion es 100 · 118,92 · 141,42 ·
    // 168,18 · 200. La siguiente es 200 × (200/168,18) = 237,84, no
    // 200 + (200 − 168,18) = 231,82: un 2,6 % menos de recorrido justo en el
    // escalon que mas lejos esta.
    const config = cfg({
      strategy: StrategyKind.GRID_CLASSIC,
      direction: 'LONG',
      leverage: 2,
      totalInvestment: '1000',
      lowerPrice: '100',
      upperPrice: '200',
      gridLevels: 5,
      gridSpacing: 'GEOMETRIC',
      sizingMode: 'QUOTE',
    });
    // Con la linea superior comprada, su venta es la que se proyecta.
    const ctx = makeContext({
      strategy: StrategyKind.GRID_CLASSIC,
      config,
      price: '199',
      position: makePosition('1', '200'),
      cycle: { filledLevelIndexes: [4] },
    });

    const plan = getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx);
    const venta = plan.orders.find(
      (o) => o.levelKind === LevelKind.GRID_SELL && o.levelIndex === 4,
    );
    expect(venta).toBeDefined();
    expect(Number(venta!.price)).toBeGreaterThan(236);
    expect(Number(venta!.price)).toBeLessThan(239);
  });

  it('y la aritmetica sigue proyectando con la resta', () => {
    const config = cfg({
      strategy: StrategyKind.GRID_CLASSIC,
      direction: 'LONG',
      leverage: 2,
      totalInvestment: '1000',
      lowerPrice: '100',
      upperPrice: '200',
      gridLevels: 5,
      gridSpacing: 'ARITHMETIC',
      sizingMode: 'QUOTE',
    });
    const ctx = makeContext({
      strategy: StrategyKind.GRID_CLASSIC,
      config,
      price: '199',
      position: makePosition('1', '200'),
      cycle: { filledLevelIndexes: [4] },
    });

    const plan = getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx);
    const venta = plan.orders.find(
      (o) => o.levelKind === LevelKind.GRID_SELL && o.levelIndex === 4,
    );
    // 100 · 125 · 150 · 175 · 200 → la siguiente es 225 en los dos criterios.
    expect(Number(venta!.price)).toBeCloseTo(225, 0);
  });
});
