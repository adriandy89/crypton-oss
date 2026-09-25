import {
  BarPath,
  ExchangeError,
  StrategyKind,
  Venue,
  type BacktestParams,
  type Candle,
  type MarketSpec,
} from '@crypton/shared';
import { DryRunAdapter } from '@crypton/exchange-core';
import { runReplay } from './engine';

/** Mismo mercado que usan los tests del motor, para poder contrastar cifras. */
const TEST_MARKET: MarketSpec = {
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  canonical: 'BTC/USDC',
  base: 'BTC',
  quote: 'USDC',
  tickSize: '0.1',
  stepSize: '0.00001',
  minNotional: '10',
  minQty: null,
  maxQty: null,
  maxLeverage: 40,
  priceDecimals: 1,
  qtyDecimals: 5,
  active: true,
};

/**
 * El motor de replay contra series de velas hechas a mano.
 *
 * Los tres casos que de verdad importan —y que ya estuvieron a punto de colarse—
 * son el del apalancamiento, el de la traducción de ids entre venues y el del
 * determinismo. Los tres fallan de la peor forma posible: en silencio, con un
 * resultado que parece bueno.
 */

const SPAN = 900_000; // 15m
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % SPAN);

const PARAMS: BacktestParams = {
  startingBalance: '100000',
  leverage: 1,
  marginMode: 'ISOLATED',
  makerFeeRate: '0',
  takerFeeRate: '0',
  slippageRate: '0',
  maintenanceMarginRate: 0.005,
  spreadBps: 2,
  barPath: BarPath.NEAREST_FIRST,
};

/** Velas planas al precio dado. */
const plano = (n: number, precio: string, desde = T0): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    t: desde + i * SPAN,
    o: precio,
    h: precio,
    l: precio,
    c: precio,
    v: '1',
  }));

/** Rampa lineal de `from` a `to`, con mechas de ±0. */
const rampa = (n: number, from: number, to: number, desde = T0): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const p = (from + ((to - from) * i) / Math.max(1, n - 1)).toFixed(1);
    return { t: desde + i * SPAN, o: p, h: p, l: p, c: p, v: '1' };
  });

const GRID = {
  exchangeAccountId: 'acc-1',
  symbol: 'BTC',
  direction: 'LONG' as const,
  leverage: 1,
  marginMode: 'ISOLATED' as const,
  totalInvestment: '10000',
  lowerPrice: '80',
  upperPrice: '120',
  gridLevels: 8,
  gridSpacing: 'ARITHMETIC',
};

const run = (candles: Candle[], over: Record<string, unknown> = {}, params = PARAMS) =>
  runReplay({
    botId: '1a2b3c4d-0000-4000-8000-000000000000',
    strategy: StrategyKind.GRID_CLASSIC,
    config: { ...GRID, ...over },
    venue: Venue.HYPERLIQUID,
    market: TEST_MARKET,
    interval: '15m',
    candles,
    params,
  });

describe('runReplay', () => {
  it('una operación de un agente no se reproduce (spec 074)', async () => {
    await expect(
      runReplay({
        botId: '1a2b3c4d-0000-4000-8000-000000000000',
        strategy: StrategyKind.AGENT_TRADE,
        config: GRID,
        venue: Venue.HYPERLIQUID,
        market: TEST_MARKET,
        interval: '15m',
        candles: plano(50, '100'),
        params: PARAMS,
      }),
    ).rejects.toThrow(/tarjeta de su agente/);
  });

  it('un mercado plano no ejecuta nada y no gasta comisiones', async () => {
    const r = await run(plano(50, '100'));

    expect(r.fills).toHaveLength(0);
    expect(r.feesPaid.toFixed()).toBe('0');
    expect(r.finalBalance.toFixed()).toBe('100000');
    // Cuatro precios por vela.
    expect(r.ticks).toBe(200);
  });

  it('una caída ejecuta los niveles de compra por debajo del precio', async () => {
    const r = await run(rampa(60, 100, 82));

    expect(r.fills.length).toBeGreaterThan(0);
    expect(r.fills.every((f) => f.side === 'BUY')).toBe(true);
    // Y a precios decrecientes: se van tocando niveles más abajo.
    const precios = r.fills.map((f) => Number(f.price));
    expect(precios).toEqual([...precios].sort((a, b) => b - a));
  });

  it('bajar y volver a subir cierra ciclos con ganancia', async () => {
    const r = await run([...rampa(40, 100, 84), ...rampa(40, 84, 118, T0 + 40 * SPAN)]);

    expect(r.fills.some((f) => f.side === 'SELL')).toBe(true);
    // Sin comisiones y comprando abajo para vender arriba, el resultado no puede
    // ser negativo.
    expect(r.realizedPnl.gte(0)).toBe(true);
    expect(r.grossMatched.gt(0)).toBe(true);
  });

  it('la curva de equity tiene un punto por vela', async () => {
    const r = await run(plano(30, '100'));
    expect(r.equity).toHaveLength(30);
    expect(r.equity[0].ts).toBe(T0);
  });

  describe('las tres trampas', () => {
    it('DETERMINISMO: el mismo rango da exactamente el mismo resultado', async () => {
      // Sin esto, comparar dos configuraciones no significa nada.
      const serie = [...rampa(30, 100, 86), ...rampa(30, 86, 112, T0 + 30 * SPAN)];
      const a = await run(serie);
      const b = await run(serie);

      expect(a.fills).toEqual(b.fills);
      expect(a.realizedPnl.toFixed()).toBe(b.realizedPnl.toFixed());
      expect(a.finalBalance.toFixed()).toBe(b.finalBalance.toFixed());
    });

    it('IDS: Hyperliquid (hash) y Aster (legible) dan el mismo resultado', async () => {
      // El simulador emite las ejecuciones con el id YA CODIFICADO. En
      // Hyperliquid eso es un hash: sin traducirlo de vuelta, `parseCoid`
      // devuelve null, no se cuenta ni una entrada y la escalera se recoloca
      // sola para siempre. En Aster el id es legible, así que el fallo NO se
      // vería probando solo con ese venue.
      const serie = [...rampa(30, 100, 86), ...rampa(30, 86, 112, T0 + 30 * SPAN)];
      const base = {
        botId: '1a2b3c4d-0000-4000-8000-000000000000',
        strategy: StrategyKind.GRID_CLASSIC,
        config: GRID as never,
        market: TEST_MARKET,
        interval: '15m' as const,
        candles: serie,
        params: PARAMS,
      };

      const hl = await runReplay({ ...base, venue: Venue.HYPERLIQUID });
      const aster = await runReplay({ ...base, venue: Venue.ASTER });

      expect(hl.fills.length).toBe(aster.fills.length);
      expect(hl.realizedPnl.toFixed()).toBe(aster.realizedPnl.toFixed());
      // Y lo que delata el fallo: los niveles se reconocen en los dos.
      expect(hl.fills.some((f) => f.levelKind !== null)).toBe(true);
      expect(hl.fills.filter((f) => f.levelIndex !== null).length).toBe(
        aster.fills.filter((f) => f.levelIndex !== null).length,
      );
    });

    it('APALANCAMIENTO: a 10× una caída del 20 % liquida', async () => {
      // `executeFill` cae a `leverage ?? 1` si nadie lo fija. Sin la llamada a
      // `setLeverage` antes del bucle, TODA posición sería 1× y no habría
      // liquidación nunca — la martingala infalible.
      const r = await run(
        [...plano(3, '100'), ...rampa(40, 100, 78, T0 + 3 * SPAN)],
        {
          totalInvestment: '50000',
          leverage: 10,
          lowerPrice: '95',
          upperPrice: '105',
          gridLevels: 4,
        },
        { ...PARAMS, leverage: 10, startingBalance: '6000' },
      );

      expect(r.liquidations).toBeGreaterThan(0);
      expect(r.fills.some((f) => f.liquidation)).toBe(true);
    });
  });

  it('un nivel por debajo del mínimo del venue no se coloca, y se avisa', async () => {
    // La misma puerta que usa el motor real. Sin ella, el replay colocaría
    // órdenes que en producción se rechazan y el resultado saldría mejor.
    const r = await run(plano(10, '100'), { totalInvestment: '20', gridLevels: 8 });

    expect(r.fills).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('no se colocó'))).toBe(true);
  });

  it('los contadores de ejecuciones van sobre el TOTAL, no sobre la lista acotada', async () => {
    // La lista se corta en `MAX_FILLS_RETURNED` para no devolver decenas de
    // miles. Contar sobre ella daría exactamente ese tope en cuanto se pase —un
    // número redondo y falso justo donde se mira si el bot operó mucho.
    const r = await run([...rampa(40, 100, 84), ...rampa(40, 84, 118, T0 + 40 * SPAN)]);

    expect(r.fillsTotal).toBe(r.fills.length);
    expect(r.fillCounts.buy + r.fillCounts.sell).toBe(r.fillsTotal);
    expect(r.fillCounts.maker + r.fillCounts.taker).toBe(r.fillsTotal);
    expect(r.fillCounts.buy).toBe(r.fills.filter((f) => f.side === 'BUY').length);
  });

  it('el reloj de las ejecuciones es el de la vela, no el de hoy', async () => {
    const r = await run(rampa(40, 100, 84));

    expect(r.fills.length).toBeGreaterThan(0);
    for (const f of r.fills) {
      expect(f.ts).toBeGreaterThanOrEqual(T0);
      expect(f.ts).toBeLessThan(T0 + 40 * SPAN);
    }
  });
});

/**
 * El stop-loss en el replay (001/F-45, corregido en el spec 004).
 *
 * El simulador ejecutaba el stop —MARKET con `triggerPrice`— en el acto: toda
 * posición con `stopLossPct` se cerraba nada más abrirse pagando taker, y la
 * estrategia volvía a entrar en bucle. El backtest devolvía resultados falsos
 * para cualquier configuración con stop, que es la de quien más cuidado tiene.
 */
describe('runReplay — rechazos del simulador (spec 001, F-65)', () => {
  /**
   * El `catch` vacío al colocar hacía que un replay pudiera «funcionar» con
   * órdenes que el simulador rechazó una a una, sin que el resultado lo dijera.
   */
  it('los rechazos al colocar se cuentan y salen en los avisos con su motivo', async () => {
    // Rechaza como el simulador real: con una promesa, no con un throw síncrono.
    const spy = jest
      .spyOn(DryRunAdapter.prototype, 'placeOrder')
      .mockImplementationOnce(() =>
        Promise.reject(new ExchangeError('RULES', 'rechazo de prueba', Venue.HYPERLIQUID)),
      );
    try {
      const out = await run(rampa(3, 100, 90));
      expect(out.warnings.some((w) => /rechazad/i.test(w) && /rechazo de prueba/.test(w))).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Spec 057, F-04. `contexto()` no pasaba velas ni extremos a `plan()`:
 * Tendencia decía «esperando velas» en todo el replay y no operaba nunca, y el
 * seguimiento medía el máximo sobre el cierre de cada vela.
 */
describe('runReplay — velas y extremos en el contexto (spec 057, F-04)', () => {
  const HORA = 4 * SPAN;
  const TREND = {
    exchangeAccountId: 'acc-1',
    symbol: 'BTC',
    direction: 'NEUTRAL' as const,
    leverage: 1,
    marginMode: 'ISOLATED' as const,
    totalInvestment: '10000',
    candleInterval: '15m',
    breakoutPeriod: 20,
    atrPeriod: 14,
    atrStopMultiplier: '2.5',
    riskPerTradePct: '1',
    entryEfficiency: '0',
    stopRepriceBps: '20',
    cooldownMinutes: 0,
  };

  /** Lateral en torno a 100 con mechas de ±1, de `span` en `span`. */
  const lateral = (n: number, desde = T0, span = SPAN): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      t: desde + i * span,
      o: '100',
      h: '101',
      l: '99',
      c: i % 2 ? '100.5' : '99.5',
      v: '1',
    }));

  const vela = (t: number, o: string, h: string, l: string, c: string): Candle => ({
    t,
    o,
    h,
    l,
    c,
    v: '1',
  });

  const tendencia = (
    candles: Candle[],
    over: Record<string, unknown> = {},
    interval: '15m' | '1h' = '15m',
  ) =>
    runReplay({
      botId: '1a2b3c4d-0000-4000-8000-000000000000',
      strategy: StrategyKind.TREND_FOLLOW,
      config: { ...TREND, ...over },
      venue: Venue.HYPERLIQUID,
      market: TEST_MARKET,
      interval,
      candles,
      params: PARAMS,
    });

  it('Tendencia opera: entra con la ruptura, al cierre de esa vela', async () => {
    const ruptura = vela(T0 + 30 * SPAN, '100', '111', '100', '110');
    const r = await tendencia([...lateral(30), ruptura, ...rampa(10, 111, 120, T0 + 31 * SPAN)]);

    const entrada = r.fills.find((f) => f.levelKind === 'BASE');
    expect(entrada).toBeDefined();
    expect(entrada!.side).toBe('BUY');
    // Con la vela de la ruptura ya reproducida y ninguna posterior.
    expect(entrada!.ts).toBe(ruptura.t + SPAN - 1);
    expect(Number(entrada!.price)).toBeCloseTo(110, 0);
    expect(r.cycles[0].entries).toBe(1);
  });

  it('con velas de su intervalo agregadas, espera a que CIERRE la hora de la ruptura', async () => {
    // Doce horas laterales en velas de 15 min y la ruptura en la primera vela
    // de la hora siguiente. La hora no está cerrada hasta su cuarta vela: entrar
    // antes sería decidir con una vela que aún no existe.
    const inicio = T0 + 48 * SPAN;
    const hora = [
      vela(inicio, '100', '111', '100', '110'),
      vela(inicio + SPAN, '110', '111', '109', '110.5'),
      vela(inicio + 2 * SPAN, '110', '111', '109', '110.5'),
      vela(inicio + 3 * SPAN, '110', '111', '109', '110.5'),
    ];
    const r = await tendencia(
      [...lateral(48), ...hora, ...lateral(8, inicio + HORA).map((v) => ({ ...v, c: '111' }))],
      { candleInterval: '1h', breakoutPeriod: 5, atrPeriod: 5 },
    );

    const entrada = r.fills.find((f) => f.levelKind === 'BASE');
    expect(entrada?.ts).toBe(inicio + HORA - 1);
  });

  it('sin velas de su intervalo no puede decidir, y el resultado lo dice', async () => {
    const r = await tendencia(lateral(40, T0, HORA), { candleInterval: '15m' }, '1h');

    expect(r.fillsTotal).toBe(0);
    expect(r.warnings.some((w) => w.includes('15m') && w.includes('1h'))).toBe(true);
  });

  it('avisa de las velas que se gastan en calentar los indicadores', async () => {
    const r = await tendencia(lateral(30));
    expect(r.warnings.some((w) => /calentar/.test(w) && w.includes('25'))).toBe(true);
  });

  it('el seguimiento mide el máximo de la vela, no su cierre', async () => {
    // Entrada a ~100 al cierre de la primera vela. La segunda sube a 130 y
    // cierra en 125: con el máximo, el disparador va a 128,7 (130 × 0,99) y
    // salta en la apertura de la tercera; con el cierre iría a 123,75 y no.
    const r = await runReplay({
      botId: '1a2b3c4d-0000-4000-8000-000000000000',
      strategy: StrategyKind.TRAILING_PROFIT,
      config: {
        exchangeAccountId: 'acc-1',
        symbol: 'BTC',
        direction: 'LONG',
        leverage: 1,
        marginMode: 'ISOLATED',
        totalInvestment: '1000',
        activationMode: 'NONE',
        takeProfitPct: '20',
        trailingCallbackPct: '1',
        trailingRepriceBps: 20,
        cooldownMinutes: 0,
      } as never,
      venue: Venue.HYPERLIQUID,
      market: TEST_MARKET,
      interval: '15m',
      candles: [
        vela(T0, '100', '100', '100', '100'),
        vela(T0 + SPAN, '100', '130', '100', '125'),
        ...plano(3, '125', T0 + 2 * SPAN),
      ],
      params: PARAMS,
    });

    const salida = r.fills.find((f) => f.side === 'SELL');
    expect(salida).toMatchObject({ price: '128.7', ts: T0 + 2 * SPAN });
  });
});

describe('runReplay — stop-loss', () => {
  it('una caída que no llega al stop deja la posición abierta y no vende nada', async () => {
    // De 100 a 96 se llena el nivel de compra de ~97,1; el stop, un 10 % por
    // debajo de la entrada, queda en ~87 y no se toca. Antes de la corrección
    // aquí salía una venta en el mismo tick que la compra.
    const r = await run(rampa(20, 100, 96), { stopLossPct: '10' });
    expect(r.fills.filter((f) => f.side === 'BUY').length).toBeGreaterThan(0);
    expect(r.fills.filter((f) => f.side === 'SELL')).toHaveLength(0);
    expect(r.fills.some((f) => f.levelKind === 'STOP_LOSS')).toBe(false);
    // El ciclo sigue abierto al final: la posición no se ha cerrado.
    expect(r.cycles.at(-1)?.closedAt).toBeNull();
  });

  it('una caída que cruza el stop lo ejecuta una vez, y después de la entrada, no con ella', async () => {
    const r = await run(rampa(60, 100, 70), { stopLossPct: '10' });
    const compras = r.fills.filter((f) => f.side === 'BUY');
    const stops = r.fills.filter((f) => f.levelKind === 'STOP_LOSS');
    expect(compras.length).toBeGreaterThan(0);
    expect(stops.length).toBeGreaterThan(0);
    // El stop se dispara DESPUÉS de la primera compra, cuando el precio ha
    // bajado de verdad: como mínimo un 10 % por debajo de la primera entrada.
    const primera = compras[0];
    expect(stops[0].ts).toBeGreaterThan(primera.ts);
    expect(Number(stops[0].price)).toBeLessThanOrEqual(Number(primera.price) * 0.9 + 0.1);
    // Y es una salida como taker: cruza el libro al dispararse.
    expect(stops[0].isTaker).toBe(true);
    expect(r.fills.some((f) => f.liquidation)).toBe(false);
  });

  it('el stop es un % del margen, como en el motor: a 3× un 30 % dispara a un 10 % del precio', async () => {
    // Spec 080. La rejilla compra en varios niveles y el stop se mide desde la
    // media de lo comprado (≈ 91): salta en torno a 82. Con la semántica de
    // antes, un 30 % del PRECIO quedaba en ≈ 64 y la caída hasta 70 no lo
    // tocaba nunca.
    const r = await run(rampa(60, 100, 70), { stopLossPct: '30', leverage: 3 });
    const compras = r.fills.filter((f) => f.side === 'BUY');
    const stops = r.fills.filter((f) => f.levelKind === 'STOP_LOSS');
    expect(stops.length).toBeGreaterThan(0);
    expect(Number(stops[0].price)).toBeLessThanOrEqual(Number(compras[0].price) * 0.9 + 0.1);
    expect(Number(stops[0].price)).toBeGreaterThan(70);
  });
});
