import { Observable, Subject } from 'rxjs';
import {
  D,
  Venue,
  type Balance,
  type Decimal,
  type CycleState,
  type Fill,
  type MarketSpec,
  type OrderAck,
  type OrderUpdate,
  type Position,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';
import {
  DryRunAdapter,
  hyperliquidCodec,
  type ExchangeAdapter,
  type StreamHealth,
} from '@crypton/exchange-core';
import { parseCoid } from '@crypton/strategy-core';
import { BotRunner, type FairFeedRequest, type PriceSourceLike } from './bot-runner';
import type { BotRecord, BotStore } from './bot-store';

/**
 * Integración: cada estrategia REAL, a través del runner REAL, contra el
 * simulador REAL (`DryRunAdapter` sobre una fuente de precios controlada).
 *
 * Lo único falso es la persistencia: un store en memoria que replica la
 * contabilidad de niveles del de verdad (índices llenos, entradas, ancla,
 * liberación al vender). Lo que se comprueba aquí es que el circuito completo
 * —plan → reconcile → colocación → ejecución simulada → fill → estado del
 * ciclo → siguiente plan— hace lo que cada estrategia promete.
 */

const BOT_ID = '1a2b3c4d-0000-4000-8000-000000000000';

const MARKET: MarketSpec = {
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

/** Fuente de precios manejable desde el test. Venue Hyperliquid: ids en hex. */
class PriceSource implements ExchangeAdapter {
  readonly venue = Venue.HYPERLIQUID;
  readonly ticker$ = new Subject<Ticker>();
  current: Ticker = this.at('100');

  private at(price: string): Ticker {
    const p = D(price);
    return {
      venue: Venue.HYPERLIQUID,
      symbol: 'BTC',
      last: price,
      bid: p.minus('0.05').toFixed(),
      ask: p.plus('0.05').toFixed(),
      mark: price,
      ts: Date.now(),
    };
  }

  /** Mueve el precio: es lo que hace que el simulador case órdenes en reposo. */
  move(price: string): void {
    this.current = this.at(price);
    this.ticker$.next(this.current);
  }

  verify = async () => ({ ok: true, publicRef: 'stub' });
  getMarkets = async (): Promise<MarketSpec[]> => [MARKET];
  getBalances = async (): Promise<Balance[]> => [];
  getPositions = async (): Promise<Position[]> => [];
  getOpenOrders = async (): Promise<VenueOrder[]> => [];
  getRecentFills = async (): Promise<Fill[]> => [];
  getTicker = async (): Promise<Ticker> => this.current;
  placeOrder = async (): Promise<OrderAck> => {
    throw new Error('la fuente no recibe órdenes');
  };
  cancelOrder = async () => undefined;
  cancelOwn = async () => undefined;
  cancelAll = async () => undefined;
  setLeverage = async () => undefined;
  streamOrders = (): Observable<OrderUpdate> => new Subject<OrderUpdate>().asObservable();
  streamFills = (): Observable<Fill> => new Subject<Fill>().asObservable();
  streamTicker = (): Observable<Ticker> => this.ticker$.asObservable();
  streamHealth = (): Observable<StreamHealth> => new Subject<StreamHealth>().asObservable();
  close = async () => undefined;
}

interface Row {
  status: string;
  cycleSeq: number;
  venueClientId: string;
  venueOrderId: string | null;
  qty: string;
  filled: string;
  levelKind: string;
}

const ENTRY_KINDS = new Set(['BASE', 'SAFETY', 'GRID_BUY', 'QUOTE_BID', 'QUOTE_ASK']);

/**
 * Store en memoria. Replica lo que el runner necesita del de verdad, incluida
 * la parte de la contabilidad del ciclo que gobierna los planes: índices
 * llenos, nº de entradas, ancla, y la liberación del nivel al venderse.
 */
class MemoryStore {
  readonly rows = new Map<string, Row>();
  readonly fills = new Set<string>();
  readonly events: string[] = [];
  cycle: CycleState = {
    cycleId: 'c1',
    startedAt: Date.now(),
    entriesFilled: 0,
    lastEntryAt: null,
    filledLevelIndexes: [],
    cooldownUntil: null,
    realizedPnl: '0',
    realizedPnlAcc: '0',
    averageEntry: null,
    anchorPrice: null,
    scratch: { cycleSeq: 1 },
  };

  setStatus = async () => undefined;
  touchTick = async () => undefined;
  event = async (_b: unknown, type: string) => {
    this.events.push(type);
  };
  saveSnapshot = async () => undefined;
  /** Marcas de agua de market making. Se guardan para poder comprobarlas. */
  peaks: { inventory: string; margin: string } | null = null;
  trackMmPeaks = async (_id: string, inventory: Decimal, margin: Decimal) => {
    this.peaks = { inventory: inventory.toFixed(), margin: margin.toFixed() };
  };
  saveCycleScratch = async (_id: string, scratch: Record<string, unknown>) => {
    this.cycle = { ...this.cycle, scratch };
  };
  saveCycleAnchor = async () => undefined;
  /** Releer el ciclo es justo lo que hace REPAIR; sin esto no se prueba nada. */
  ensureCycle = async () => this.cycle;
  marketSpec = async () => MARKET;
  drawdownPct = () => null;
  todayRealizedPnl = async () => D(0);
  syncOrderState = async () => undefined;

  findOrderByCoid = async (coid: string) => this.rows.get(coid) ?? null;

  upsertPendingOrder = async (input: {
    cycleSeq: number;
    order: { clientOrderId: string; qty: string; levelKind: string };
    venueClientId: string;
  }) => {
    this.rows.set(input.order.clientOrderId, {
      status: 'PENDING',
      cycleSeq: input.cycleSeq,
      venueClientId: input.venueClientId,
      venueOrderId: null,
      qty: input.order.qty,
      filled: '0',
      levelKind: input.order.levelKind,
    });
  };

  confirmOrder = async (coid: string, ack: OrderAck) => {
    const row = this.rows.get(coid);
    if (row) {
      row.status = ack.status;
      row.venueOrderId = ack.venueOrderId;
    }
  };

  rejectOrder = async (coid: string) => {
    const row = this.rows.get(coid);
    if (row) row.status = 'REJECTED';
  };

  markOrderCanceled = async (_bot: string, venueOrderId: string) => {
    for (const row of this.rows.values()) {
      if (
        row.venueOrderId === venueOrderId &&
        ['PENDING', 'OPEN', 'PARTIALLY_FILLED'].includes(row.status)
      ) {
        row.status = 'CANCELED';
      }
    }
  };

  markCoidsCanceled = async (_bot: string, coids: string[]) => {
    for (const c of coids) {
      const row = this.rows.get(c);
      if (row && ['PENDING', 'OPEN', 'PARTIALLY_FILLED'].includes(row.status))
        row.status = 'CANCELED';
    }
  };

  liveOrderCoids = async (_bot: string, opts?: { keepProtective?: boolean }) =>
    [...this.rows.entries()]
      .filter(([, r]) => ['PENDING', 'OPEN', 'PARTIALLY_FILLED'].includes(r.status))
      .filter(([, r]) => !(opts?.keepProtective && r.levelKind === 'STOP_LOSS'))
      .map(([c]) => c);

  /** El ciclo en memoria nunca diverge del simulador: no hay nada que reparar. */
  repairCycleFromVenue = async () => null;

  ownVenueClientIds = async (_bot: string, seqs: number[]) =>
    [...this.rows.values()].filter((r) => seqs.includes(r.cycleSeq)).map((r) => r.venueClientId);

  /** El fill llega con el id en espacio de venue, como del venue real. */
  private rowOfFill(fill: Fill): [string, Row] | null {
    for (const [coid, row] of this.rows) {
      if (row.venueClientId === fill.clientOrderId || coid === fill.clientOrderId)
        return [coid, row];
    }
    return null;
  }

  /** Como el real: devuelve el id CANÓNICO de la orden, o null. */
  recordFill = async (_bot: string, fill: Fill) => {
    const hit = this.rowOfFill(fill);
    if (!hit) return null;
    if (this.fills.has(fill.venueFillId)) return null;
    this.fills.add(fill.venueFillId);
    const [coid, row] = hit;
    row.filled = D(row.filled).plus(fill.qty).toFixed();
    row.status = D(row.filled).gte(row.qty) ? 'FILLED' : 'PARTIALLY_FILLED';
    return coid;
  };

  /** Recibe el fill ya con id canónico, como el store real. */
  applyFillToCycle = async (
    _bot: string,
    cycle: CycleState,
    fill: Fill,
    opts: { recycleLevelOnExit?: boolean } = {},
  ) => {
    const parsed = fill.clientOrderId ? parseCoid(fill.clientOrderId) : null;
    const isEntry = parsed ? ENTRY_KINDS.has(parsed.kind) : false;
    const idx = new Set(cycle.filledLevelIndexes);
    if (isEntry && parsed) idx.add(parsed.levelIndex);
    if (opts.recycleLevelOnExit && parsed?.kind === 'GRID_SELL') idx.delete(parsed.levelIndex);
    this.cycle = {
      ...cycle,
      entriesFilled: cycle.entriesFilled + (isEntry ? 1 : 0),
      lastEntryAt: isEntry ? fill.ts : cycle.lastEntryAt,
      filledLevelIndexes: [...idx],
      anchorPrice: cycle.anchorPrice ?? (isEntry && parsed?.kind === 'BASE' ? fill.price : null),
    };
    return this.cycle;
  };
}

/**
 * Doble del feed de precios EXTERNO (Binance), el que alimenta `ctx.fairPrice`.
 *
 * No confundir con la clase `PriceSource` de arriba, que es la fuente de precios
 * del VENUE: aquélla es un `ExchangeAdapter` y ésta un `PriceSourceLike`. La
 * colisión de nombres viene del dominio, no del test.
 *
 * Lleva la cuenta de las claves vivas porque lo que hay que comprobar no es solo
 * que llegue un precio, sino que el feed se SUELTA al cambiar de fuente: un
 * contador de referencias que se queda colgado deja un sondeo a Binance vivo
 * para siempre.
 */
class FakeFairFeed implements PriceSourceLike {
  readonly acquired: FairFeedRequest[] = [];
  readonly released: string[] = [];
  /** Claves vivas ahora mismo: adquiridas menos soltadas. */
  readonly live = new Set<string>();
  /** Precio que sirve `peek`, y su antigüedad. Null = la fuente no responde. */
  price: { price: string; ts: number } | null = { price: '100', ts: Date.now() };

  private seq = 0;

  acquire(req: FairFeedRequest): string | null {
    this.acquired.push(req);
    const key = `${req.source}:${req.marketType}:${req.override ?? req.base}#${++this.seq}`;
    this.live.add(key);
    return key;
  }

  release(key: string | null): void {
    if (!key) return;
    this.released.push(key);
    this.live.delete(key);
  }

  peek(key: string | null): { price: string; ts: number } | null {
    if (!key || !this.live.has(key)) return null;
    return this.price;
  }
}

interface Harness {
  runner: BotRunner;
  sim: DryRunAdapter;
  source: PriceSource;
  store: MemoryStore;
  fairFeed: FakeFairFeed;
}

function harness(
  strategy: string,
  config: Record<string, unknown>,
  opts: { withFairFeed?: boolean } = {},
): Harness {
  const source = new PriceSource();
  const fairFeed = new FakeFairFeed();
  // Sin comisiones ni deslizamiento: precios exactos, para poder razonar.
  const sim = new DryRunAdapter(source, {
    makerFeeRate: '0',
    takerFeeRate: '0',
    slippageRate: '0',
  });
  const store = new MemoryStore();

  const bot = {
    id: BOT_ID,
    user_id: 'u1',
    exchange_account_id: 'acc-1',
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    strategy,
    direction: (config.direction as string) ?? 'LONG',
    leverage: Number(config.leverage ?? 1),
    margin_mode: 'ISOLATED',
    config_version: 1,
    dry_run: true,
    total_investment: String(config.totalInvestment ?? '1000'),
  } as unknown as BotRecord;

  const runner = new BotRunner({
    bot,
    adapter: sim,
    testnet: false,
    market: MARKET,
    config: {
      exchangeAccountId: 'acc-1',
      symbol: 'BTC',
      direction: 'LONG',
      leverage: 1,
      marginMode: 'ISOLATED',
      totalInvestment: '1000',
      ...config,
    } as never,
    cycle: store.cycle,
    store: store as unknown as BotStore,
    guards: {
      maxNotionalPerBot: null,
      maxDailyLoss: null,
      killSwitchDrawdownPct: null,
      liquidationAlertPct: null,
      maxLeverage: null,
      maxTotalNotional: null,
    },
    reconcileIntervalMs: 600_000,
    onDetach: () => undefined,
    // Solo cuando el test lo pide: los demás siguen corriendo SIN feed externo,
    // que es el escenario que ya cubrían.
    ...(opts.withFairFeed ? { priceSource: fairFeed } : {}),
  });

  return { runner, sim, source, store, fairFeed };
}

/** Deja que fills, ticks encolados y promesas se asienten. */
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** Precio normalizado a la retícula del mercado, para comparar sin ruido. */
const px = (p: string): string => D(p).toFixed(1);

/** Órdenes simuladas en reposo, por tipo de nivel (descodificando el id hex). */
async function book(
  sim: DryRunAdapter,
): Promise<{ kind: string; index: number; price: string; side: string }[]> {
  const open = await sim.getOpenOrders('BTC');
  return open.map((o) => {
    // El simulador devuelve ids en espacio de venue: se buscan en el mapa de
    // filas por su id codificado para recuperar el canónico.
    const canonical = [...CANONICALS].find((c) => hyperliquidCodec.encode(c) === o.clientOrderId);
    const parsed = canonical ? parseCoid(canonical) : null;
    return {
      kind: parsed?.kind ?? '?',
      index: parsed?.levelIndex ?? -1,
      price: o.price,
      side: o.side,
    };
  });
}

/** Ids canónicos vistos: el simulador solo expone los codificados. */
const CANONICALS = new Set<string>();

async function tick(runner: BotRunner): Promise<void> {
  await (runner as unknown as { exclusive<T>(fn: () => Promise<T>): Promise<T> }).exclusive(() =>
    (runner as unknown as { tick(): Promise<void> }).tick(),
  );
  await settle();
}

async function positionQty(sim: DryRunAdapter): Promise<string> {
  const [p] = await sim.getPositions('BTC');
  return p?.qty ?? '0';
}

describe('Martingale en el simulador', () => {
  it('abre a mercado, tiende seguridades y take profit, y promedia al tocarse una seguridad', async () => {
    const h = harness('MARTINGALE', {
      numLimitBuys: 2,
      initialSeparationPct: '1',
      stepScale: '2',
      volumeScale: '2',
      totalInvestment: '700',
      takeProfitPct: '1',
      baseOrderType: 'MARKET',
      tpMode: 'LIMIT',
    });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    // La base entró a mercado y el ciclo quedó anclado.
    expect(D(await positionQty(h.sim)).gt(0)).toBe(true);
    expect(h.store.cycle.anchorPrice).not.toBeNull();
    expect(h.store.cycle.entriesFilled).toBe(1);

    // Con posición: seguridades por debajo y take profit por encima.
    let orders = await book(h.sim);
    const safeties = orders.filter((o) => o.kind === 'SAFETY');
    expect(safeties.map((s) => s.index).sort()).toEqual([1, 2]);
    expect(safeties.every((s) => D(s.price).lt(100) && s.side === 'BUY')).toBe(true);
    const tp = orders.find((o) => o.kind === 'TAKE_PROFIT');
    expect(tp).toBeDefined();
    expect(D(tp!.price).gt(100)).toBe(true);

    // El precio cae hasta la primera seguridad (1 % bajo el ancla ≈ 99).
    const before = D(await positionQty(h.sim));
    h.source.move('98.9');
    await settle(120);

    expect(D(await positionQty(h.sim)).gt(before)).toBe(true);
    expect(h.store.cycle.filledLevelIndexes).toContain(1);

    // La seguridad ejecutada no se vuelve a tender; el TP cubre la posición nueva.
    orders = await book(h.sim);
    expect(orders.some((o) => o.kind === 'SAFETY' && o.index === 1)).toBe(false);
    expect(orders.some((o) => o.kind === 'SAFETY' && o.index === 2)).toBe(true);
    const tpAfter = orders.find((o) => o.kind === 'TAKE_PROFIT');
    expect(tpAfter).toBeDefined();

    await h.runner.dispose();
  });
});

describe('Grid Classic en el simulador', () => {
  it('compra abajo, vende arriba y REPITE: el nivel vendido vuelve a comprarse', async () => {
    const h = harness('GRID_CLASSIC', {
      gridSpacing: 'ARITHMETIC',
      sizingMode: 'QUOTE',
      lowerPrice: '90',
      upperPrice: '110',
      gridLevels: 5, // 90, 95, 100, 105, 110
      totalInvestment: '1000',
    });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    // Solo compras, en las líneas por debajo del precio.
    let orders = await book(h.sim);
    expect(orders.map((o) => o.kind)).toEqual(['GRID_BUY', 'GRID_BUY']);
    expect(orders.map((o) => px(o.price)).sort()).toEqual(['90.0', '95.0']);

    // Cae a 95: se compra la línea 1 y aparece su venta en la línea superior.
    h.source.move('94.9');
    await settle(120);
    expect(h.store.cycle.filledLevelIndexes).toEqual([1]);
    orders = await book(h.sim);
    expect(
      orders.some((o) => o.kind === 'GRID_SELL' && o.index === 1 && px(o.price) === '100.0'),
    ).toBe(true);
    expect(orders.some((o) => o.kind === 'GRID_BUY' && o.index === 1)).toBe(false);

    // Sube a 100: se vende, el nivel se libera y la compra del 95 VUELVE.
    h.source.move('100.1');
    await settle(120);
    expect(h.store.cycle.filledLevelIndexes).toEqual([]);
    orders = await book(h.sim);
    expect(orders.some((o) => o.kind === 'GRID_SELL')).toBe(false);
    expect(
      orders.some((o) => o.kind === 'GRID_BUY' && o.index === 1 && px(o.price) === '95.0'),
    ).toBe(true);

    await h.runner.dispose();
  });
});

describe('TDCA en el simulador', () => {
  it('compra a mercado, respeta el intervalo y la segunda compra lleva su propio id', async () => {
    const h = harness('TDCA', {
      amountPerBuy: '100',
      intervalMinutes: 60,
      maxBuysPerCycle: 5,
      buyOnlyIfImprovesAverage: true,
      marginBelowAveragePct: '1',
      takeProfitPct: '2',
      totalInvestment: '1000',
    });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    expect(h.store.cycle.entriesFilled).toBe(1);
    expect(h.store.cycle.lastEntryAt).not.toBeNull();

    // Un segundo tick dentro del intervalo NO compra otra vez.
    await tick(h.runner);
    expect(h.store.cycle.entriesFilled).toBe(1);

    // Pasa el intervalo y el precio mejora el medio en más del 1 %: compra.
    h.store.cycle = { ...h.store.cycle, lastEntryAt: Date.now() - 61 * 60_000 };
    (h.runner as unknown as { cycle: CycleState }).cycle = h.store.cycle;
    h.source.move('98');
    await settle();
    await tick(h.runner);

    expect(h.store.cycle.entriesFilled).toBe(2);
    // El id de la segunda compra dice SAFETY y su índice es el nº de compra.
    const kinds = [...h.store.rows.keys()].map((c) => parseCoid(c)).filter(Boolean);
    expect(kinds.some((k) => k!.kind === 'BASE' && k!.levelIndex === 0)).toBe(true);
    expect(kinds.some((k) => k!.kind === 'SAFETY' && k!.levelIndex === 1)).toBe(true);

    await h.runner.dispose();
  });
});

describe('Neutral Grid en el simulador', () => {
  it('cotiza los dos lados fuera de la banda muerta y rearma las líneas solo al alejarse el precio', async () => {
    const h = harness('NEUTRAL_GRID', {
      direction: 'NEUTRAL',
      lowerPrice: '90',
      upperPrice: '110',
      anchorPrice: '100',
      gridLevels: 5,
      gridSpacing: 'ARITHMETIC',
      sizeMultiplier: '1',
      totalInvestment: '1000',
      maxExposure: '100000',
    });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    let orders = await book(h.sim);
    expect(
      orders
        .filter((o) => o.kind === 'GRID_BUY')
        .map((o) => px(o.price))
        .sort(),
    ).toEqual(['90.0', '95.0']);
    expect(
      orders
        .filter((o) => o.kind === 'GRID_SELL')
        .map((o) => px(o.price))
        .sort(),
    ).toEqual(['105.0', '110.0']);
    // La línea del precio (100) cae dentro de la banda muerta: no se cotiza.
    expect(orders.some((o) => px(o.price) === '100.0')).toBe(false);

    // Cae a 95: compra la línea 1; ahora la línea de 100 queda fuera de la banda
    // y pasa a cotizarse como venta. La línea de 95 NO se recotiza de inmediato.
    h.source.move('94.9');
    await settle(120);
    orders = await book(h.sim);
    expect(orders.some((o) => o.kind === 'GRID_SELL' && px(o.price) === '100.0')).toBe(true);
    expect(orders.some((o) => px(o.price) === '95.0')).toBe(false);
    expect(D(await positionQty(h.sim)).gt(0)).toBe(true);

    await h.runner.dispose();
  });
});

describe('GridMart en el simulador', () => {
  it('vende un escalón, anota la recompra, no recotiza el escalón hasta recomprar, y luego lo rearma', async () => {
    const h = harness('GRIDMART', {
      numLimitBuys: 2,
      initialSeparationPct: '1',
      stepScale: '2',
      volumeScale: '2',
      totalInvestment: '700',
      takeProfitPct: '1',
      satelliteTpPct: '0.5',
      gridSellCount: 2,
      gridSellInitialSeparationPct: '1',
      gridSellDistanceMultiplier: '2',
      corePctSoldAtLevel1: '50',
      gridSellQtyMultiplier: '1',
      gridRebuyDiscountPct: '0.5',
      baseOrderType: 'MARKET',
    });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();
    expect(D(await positionQty(h.sim)).gt(0)).toBe(true);

    let orders = await book(h.sim);
    expect(orders.some((o) => o.kind === 'SAFETY')).toBe(true);
    const gs0 = orders.find((o) => o.kind === 'GRID_SELL' && o.index === 0);
    expect(gs0).toBeDefined();

    // Sube hasta el primer escalón de venta: se vende y se anota la recompra.
    const before = D(await positionQty(h.sim));
    h.source.move(D(gs0!.price).plus('0.1').toFixed());
    await settle(120);
    expect(D(await positionQty(h.sim)).lt(before)).toBe(true);

    orders = await book(h.sim);
    const rebuy = orders.find((o) => o.kind === 'GRID_BUY' && o.index === 0);
    expect(rebuy).toBeDefined();
    expect(D(rebuy!.price).lt(gs0!.price)).toBe(true);
    // El escalón vendido NO se recotiza mientras su recompra esté pendiente.
    expect(orders.some((o) => o.kind === 'GRID_SELL' && o.index === 0)).toBe(false);

    // Baja hasta la recompra: se recompra y el escalón de venta VUELVE.
    h.source.move(D(rebuy!.price).minus('0.1').toFixed());
    await settle(120);
    orders = await book(h.sim);
    expect(orders.some((o) => o.kind === 'GRID_BUY' && o.index === 0)).toBe(false);
    expect(orders.some((o) => o.kind === 'GRID_SELL' && o.index === 0)).toBe(true);

    await h.runner.dispose();
  });
});

describe('Market Maker en el simulador', () => {
  it('cotiza por capas a ambos lados y una capa ejecutada vuelve a cotizarse', async () => {
    const h = harness('MARKET_MAKER', {
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
      totalInvestment: '1000',
    });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    let orders = await book(h.sim);
    expect(orders.filter((o) => o.kind === 'QUOTE_BID')).toHaveLength(2);
    expect(orders.filter((o) => o.kind === 'QUOTE_ASK')).toHaveLength(2);
    expect(
      orders.every((o) => (o.kind === 'QUOTE_BID' ? D(o.price).lt(100) : D(o.price).gt(100))),
    ).toBe(true);

    // Cae 30 bps: se ejecuta la primera capa de compra. El desvío supera el
    // mínimo de recotización, así que la capa se recotiza al nuevo precio — y
    // para eso el motor tiene que permitir reutilizar su id ya ejecutado.
    const bid0 = orders.find((o) => o.kind === 'QUOTE_BID' && o.index === 0)!;
    h.source.move(D(bid0.price).minus('0.1').toFixed());
    await settle(150);

    expect(D(await positionQty(h.sim)).gt(0)).toBe(true);
    orders = await book(h.sim);
    const requoted = orders.find((o) => o.kind === 'QUOTE_BID' && o.index === 0);
    expect(requoted).toBeDefined();
    expect(D(requoted!.price).lt(bid0.price)).toBe(true);

    await h.runner.dispose();
  });
});

describe('Market Maker V2 en el simulador', () => {
  const CONFIG = {
    direction: 'NEUTRAL',
    orderSizePerSide: '100',
    maxBotPositionValue: '1000',
    buyDistanceBps: '40',
    sellDistanceBps: '40',
    minAllowedDistanceBps: '8',
    refreshSeconds: 30,
    repriceThresholdBps: '10',
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
    totalInvestment: '1000',
  };

  it('cotiza los dos lados y recotiza tras una ejecución', async () => {
    const h = harness('MARKET_MAKER_V2', CONFIG);
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    let orders = await book(h.sim);
    expect(orders.filter((o) => o.kind === 'QUOTE_BID')).toHaveLength(1);
    expect(orders.filter((o) => o.kind === 'QUOTE_ASK')).toHaveLength(1);

    const bid = orders.find((o) => o.kind === 'QUOTE_BID')!;
    h.source.move(D(bid.price).minus('0.1').toFixed());
    await settle(150);

    expect(D(await positionQty(h.sim)).gt(0)).toBe(true);
    orders = await book(h.sim);
    const requoted = orders.find((o) => o.kind === 'QUOTE_BID');
    expect(requoted).toBeDefined();
    expect(D(requoted!.price).lt(bid.price)).toBe(true);

    await h.runner.dispose();
  });

  it('la espera tras un fill impide recotizar de inmediato', async () => {
    // Es la diferencia observable entre el V2 con y sin cooldown: el mercado
    // acaba de barrer la cotización y perseguirlo es lo que convierte una
    // ejecución rentable en una racha de ejecuciones adversas.
    const h = harness('MARKET_MAKER_V2', { ...CONFIG, fillCooldownSeconds: 600 });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    const bid = (await book(h.sim)).find((o) => o.kind === 'QUOTE_BID')!;
    h.source.move(D(bid.price).minus('0.1').toFixed());
    await settle(150);

    expect(D(await positionQty(h.sim)).gt(0)).toBe(true);
    const after = (await book(h.sim)).find((o) => o.kind === 'QUOTE_BID');
    // La compra que quede tiene que ser la MISMA: el ancla no se ha movido.
    if (after) expect(after.price).toBe(bid.price);

    await h.runner.dispose();
  });

  it('sin precio de la fuente externa no coloca una sola orden', async () => {
    // El worker de este test no tiene `priceSource`, así que `ctx.fairPrice`
    // llega null. Es exactamente el escenario de «Binance dejó de responder»: el
    // bot NO debe caer al mid del venue por su cuenta.
    const h = harness('MARKET_MAKER_V2', { ...CONFIG, priceSource: 'BINANCE' });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    expect(await book(h.sim)).toHaveLength(0);

    await h.runner.dispose();
  });

  it('con precio de la fuente externa SÍ cotiza', async () => {
    // El complementario del test de arriba, que faltaba: hasta ahora solo se
    // probaba la AUSENCIA de feed —omitiendo la dependencia—, así que el camino
    // en el que el precio sí llega no lo recorría nadie.
    const h = harness(
      'MARKET_MAKER_V2',
      { ...CONFIG, priceSource: 'BINANCE' },
      { withFairFeed: true },
    );
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    expect(h.fairFeed.acquired).toHaveLength(1);
    expect(h.fairFeed.acquired[0]!.source).toBe('BINANCE');
    expect((await book(h.sim)).length).toBeGreaterThan(0);

    await h.runner.dispose();
    // Soltar el feed al parar es lo que impide que el sondeo quede vivo.
    expect(h.fairFeed.live.size).toBe(0);
  });

  it('cambiar la fuente en caliente vuelve a pedir el feed y el bot sigue cotizando', async () => {
    // La regresión: los cuatro campos de la fuente son HOT, pero el feed solo se
    // pedía en `start()`. Sin `syncFairPrice`, este bot se quedaba EN MARCHA sin
    // cotizar una sola orden y sin un evento que lo explicara, para siempre.
    const h = harness('MARKET_MAKER_V2', CONFIG, { withFairFeed: true });
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();
    // Arranca contra el venue: ningún feed externo.
    expect(h.fairFeed.acquired).toHaveLength(0);
    expect((await book(h.sim)).length).toBeGreaterThan(0);

    await h.runner.reloadConfig(
      { ...CONFIG, priceSource: 'BINANCE' } as never,
      'HOT',
    );
    await settle(150);

    expect(h.fairFeed.acquired).toHaveLength(1);
    expect(h.fairFeed.live.size).toBe(1);
    // Y lo que de verdad importa: sigue habiendo órdenes en el libro.
    expect((await book(h.sim)).length).toBeGreaterThan(0);

    await h.runner.dispose();
  });

  it('cambiar el símbolo de origen suelta el feed viejo y pide el nuevo', async () => {
    // Peor que el caso anterior porque es SILENCIOSO: el bot seguía cotizando,
    // pero contra la referencia equivocada.
    const h = harness(
      'MARKET_MAKER_V2',
      { ...CONFIG, priceSource: 'BINANCE' },
      { withFairFeed: true },
    );

    await h.runner.start();
    await settle();
    const primera = [...h.fairFeed.live][0]!;

    await h.runner.reloadConfig(
      { ...CONFIG, priceSource: 'BINANCE', sourceSymbolOverride: 'WBTCUSDT' } as never,
      'HOT',
    );
    await settle(100);

    expect(h.fairFeed.released).toContain(primera);
    expect(h.fairFeed.live.size).toBe(1);
    expect(h.fairFeed.acquired[1]!.override).toBe('WBTCUSDT');

    await h.runner.dispose();
  });

  it('un HOT que no toca la fuente no reabre el feed', async () => {
    // Casi todos los campos son HOT: cerrar y reabrir el sondeo en cada recarga
    // sería tirar el contador de referencias que comparten todos los bots.
    const h = harness(
      'MARKET_MAKER_V2',
      { ...CONFIG, priceSource: 'BINANCE' },
      { withFairFeed: true },
    );

    await h.runner.start();
    await settle();
    expect(h.fairFeed.acquired).toHaveLength(1);

    await h.runner.reloadConfig(
      { ...CONFIG, priceSource: 'BINANCE', buyDistanceBps: '60' } as never,
      'HOT',
    );
    await settle(100);

    expect(h.fairFeed.acquired).toHaveLength(1);
    expect(h.fairFeed.released).toHaveLength(0);

    await h.runner.dispose();
  });

  it('anclar al libro del venue no abre feed externo aunque la fuente sea BINANCE', async () => {
    // `resolveAnchor` corta antes de mirar `ctx.fairPrice` con VENUE_MID, así que
    // abrir el feed era sondear Binance cada dos segundos para tirar el dato.
    const h = harness(
      'MARKET_MAKER_V2',
      { ...CONFIG, priceSource: 'BINANCE', fairPriceOrigin: 'VENUE_MID' },
      { withFairFeed: true },
    );

    await h.runner.start();
    await settle();

    expect(h.fairFeed.acquired).toHaveLength(0);
    // Y cotiza igual, porque el ancla sale del libro.
    expect((await book(h.sim)).length).toBeGreaterThan(0);

    await h.runner.dispose();
  });

  it('REPAIR reconoce las órdenes ya puestas y no las duplica', async () => {
    const h = harness('MARKET_MAKER_V2', CONFIG);
    trackCanonicals(h.store);

    await h.runner.start();
    await settle();

    const before = (await book(h.sim)).map((o) => o.kind + '#' + o.index).sort();
    expect(before.length).toBeGreaterThan(0);

    await h.runner.handleCommand('REPAIR');
    await settle(150);

    const after = (await book(h.sim)).map((o) => o.kind + '#' + o.index).sort();
    expect(after).toEqual(before);
    expect(h.store.events).toContain('BOT_REPAIRED');

    await h.runner.dispose();
  });
});

/** Registra cada id canónico que el motor escribe, para descodificar el libro. */
function trackCanonicals(store: MemoryStore): void {
  const original = store.upsertPendingOrder;
  store.upsertPendingOrder = async (input) => {
    CANONICALS.add(input.order.clientOrderId);
    return original(input);
  };
}
