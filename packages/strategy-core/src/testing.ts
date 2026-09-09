import {
  StrategyKind,
  Venue,
  type BotConfig,
  type BotContext,
  type CycleState,
  type MarketSpec,
  type OrderSide,
  type Position,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';

/**
 * Constructores de contexto sintético para los tests del paquete.
 *
 * Viven junto al código y no en una carpeta de tests porque los comparten
 * varios specs (`strategies.spec.ts`, `ladder.spec.ts`) y porque fijan la forma
 * canónica de un `BotContext` mínimo válido. Nadie los importa fuera de los
 * specs: el modo dry-run del motor monta su contexto con el mercado y el ticker
 * reales (001/F-94: el comentario anterior decía que el worker los usaba).
 */

export const TEST_MARKET: MarketSpec = {
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

export function makeMarket(overrides: Partial<MarketSpec> = {}): MarketSpec {
  return { ...TEST_MARKET, ...overrides };
}

export function makeTicker(price: string, spread = '0.1'): Ticker {
  const p = Number(price);
  const s = Number(spread);
  return {
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    last: price,
    bid: (p - s / 2).toString(),
    ask: (p + s / 2).toString(),
    mark: price,
    ts: 0,
  };
}

export function makePosition(qty: string, entryPrice: string, markPrice = entryPrice): Position {
  return {
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    qty,
    entryPrice,
    markPrice,
    unrealizedPnl: '0',
    leverage: 1,
    marginMode: 'ISOLATED',
    liquidationPrice: null,
    marginUsed: '0',
  };
}

export function makeCycle(overrides: Partial<CycleState> = {}): CycleState {
  return {
    cycleId: 'cycle-1',
    startedAt: 0,
    entriesFilled: 0,
    lastEntryAt: null,
    filledLevelIndexes: [],
    cooldownUntil: null,
    realizedPnl: '0',
    realizedPnlAcc: '0',
    averageEntry: null,
    anchorPrice: null,
    scratch: { cycleSeq: 1 },
    ...overrides,
  };
}

/**
 * Una orden viva en el venue, para los planes que miran lo que ya hay puesto.
 *
 * `createdAt` es lo que hace falta de verdad: es de donde salen la edad de una
 * cotizacion y la caducidad de una orden de salida, y sin poder fabricarla no
 * se pueden probar ninguna de las dos.
 */
export function makeVenueOrder(
  clientOrderId: string,
  price: string,
  side: OrderSide = 'BUY',
  createdAt = 0,
): VenueOrder {
  return {
    venue: Venue.HYPERLIQUID,
    symbol: 'BTC',
    clientOrderId,
    venueOrderId: 'v-' + clientOrderId,
    side,
    type: 'POST_ONLY',
    price,
    qty: '1',
    filledQty: '0',
    avgPrice: null,
    status: 'OPEN',
    reduceOnly: false,
    createdAt,
  };
}

export interface MakeContextOptions {
  strategy: StrategyKind;
  config: BotConfig;
  price?: string;
  position?: Position | null;
  cycle?: Partial<CycleState>;
  market?: Partial<MarketSpec>;
  now?: number;
  availableBalance?: string;
  openOrders?: VenueOrder[];
  /** Precio de una fuente externa; null = pedida pero no disponible. */
  fairPrice?: string | null;
  /** Sobrescribe el libro: sirve para un venue que no publica BBO. */
  ticker?: Partial<Ticker>;
}

export function makeContext(opts: MakeContextOptions): BotContext {
  const price = opts.price ?? '100';
  return {
    botId: '1a2b3c4d-0000-0000-0000-000000000000',
    venue: Venue.HYPERLIQUID,
    strategy: opts.strategy,
    config: opts.config,
    market: makeMarket(opts.market),
    ticker: { ...makeTicker(price), ...(opts.ticker ?? {}) },
    position: opts.position ?? null,
    openOrders: opts.openOrders ?? [],
    cycle: makeCycle(opts.cycle),
    availableBalance: opts.availableBalance ?? '100000',
    now: opts.now ?? 1_000_000,
    fairPrice: opts.fairPrice ?? null,
  };
}

/** Config común mínima y válida, para no repetirla en cada test. */
export const BASE_CONFIG = {
  exchangeAccountId: 'acc-1',
  symbol: 'BTC',
  direction: 'LONG' as const,
  leverage: 1,
  marginMode: 'ISOLATED' as const,
  totalInvestment: '1000',
};
