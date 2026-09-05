import {
  FairPriceOrigin,
  LevelKind,
  Mutability,
  PriceSource,
  StrategyKind,
  type BotConfig,
} from '@crypton/shared';
import { diffConfig } from './mutability';
import { getStrategy, listStrategies } from './registry';
import { parseCoid } from './client-order-id';
import { BASE_CONFIG, makeContext, makeMarket, makePosition, makeVenueOrder } from './testing';

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
   * El stop loss ya NO lo emite la estrategia: lo añade el motor para las siete
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

  it('todo campo obligatorio sin default queda marcado como tal', () => {
    for (const s of listStrategies()) {
      for (const f of s.meta.fields) {
        expect(typeof f.required).toBe('boolean');
        expect(['HOT', 'WARM', 'COLD']).toContain(f.mutability);
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
    // 20 bps por debajo de 200, no de 100.
    expect(byKind(orders, LevelKind.QUOTE_BID)[0].price).toBe('199.6');
    // Con ancla manual no hay nada que recordar entre ticks.
    expect(scratchPatch).toBeUndefined();
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
    const { orders } = plan({ priceSource: 'BINANCE' }, { fairPrice: '200' });
    expect(byKind(orders, LevelKind.QUOTE_BID)[0].price).toBe('199.2');
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
// Se cubren las siete a la vez y desde el registro, no una lista escrita a
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
