import { Venue, type MarketSpec } from '@crypton/shared';

/**
 * Los mercados REALES de los tres venues, para los tests.
 *
 * No hay ni un número inventado aquí. Todo salió de las APIs públicas el 24 de
 * agosto de 2026, y cada campo se deriva exactamente igual que en su adaptador,
 * para que un test que pase aquí signifique algo sobre producción:
 *
 *   · Lighter — `GET /api/v1/orderBookDetails?filter=perp`
 *     tick = 10^-supported_price_decimals · step = 10^-supported_size_decimals
 *     minQty = min_base_amount · minNotional = min_quote_amount
 *
 *   · Hyperliquid — `POST /info {"type":"meta"}`
 *     step = 10^-szDecimals · minQty = step · tick por `hyperliquidTickSize`
 *     minNotional = 10 USDC, la constante del adaptador
 *
 *   · Aster — `GET /fapi/v1/exchangeInfo`
 *     tick, step, minQty y maxQty de los filtros PRICE_FILTER y LOT_SIZE
 *     minNotional del filtro MIN_NOTIONAL · maxLeverage asumido 50
 *
 * Los mercados elegidos no son los tres de siempre: son los que rompen cosas
 * DISTINTAS. BTC tiene el tick grueso y la cantidad finísima; las monedas
 * baratas tienen el step en unidades enteras —donde el redondeo hacia abajo se
 * come niveles completos de una escalera— y ticks de siete decimales.
 *
 * Un aviso que costó caro: el mínimo de Lighter en TESTNET es el doble que en
 * mainnet para BTC. Por eso están los dos.
 */

export interface VenueMarketFixture {
  nombre: string;
  spec: MarketSpec;
  /** Precio real del día de la captura. */
  mark: string;
}

export const VENUE_MARKETS: readonly VenueMarketFixture[] = [
  // ── Lighter ───────────────────────────────────────────────────────────────
  {
    nombre: 'LIGHTER BTC',
    mark: '78910.1',
    spec: {
      venue: Venue.LIGHTER,
      symbol: 'BTC',
      canonical: 'BTC/USDC',
      base: 'BTC',
      quote: 'USDC',
      tickSize: '0.1',
      stepSize: '0.00001',
      minNotional: '10',
      minQty: '0.0001',
      maxQty: null,
      maxLeverage: 20,
      priceDecimals: 1,
      qtyDecimals: 5,
      active: true,
    },
  },
  {
    // La spec EXACTA con la que un bot real se quedó atascado: el mínimo de
    // testnet es el doble que el de mainnet.
    nombre: 'LIGHTER BTC (testnet, minimo doble)',
    mark: '78603.3',
    spec: {
      venue: Venue.LIGHTER,
      symbol: 'BTC',
      canonical: 'BTC/USDC',
      base: 'BTC',
      quote: 'USDC',
      tickSize: '0.1',
      stepSize: '0.00001',
      minNotional: '10',
      minQty: '0.0002',
      maxQty: null,
      maxLeverage: 20,
      priceDecimals: 1,
      qtyDecimals: 5,
      active: true,
    },
  },
  {
    nombre: 'LIGHTER ETH',
    mark: '2503.35',
    spec: {
      venue: Venue.LIGHTER,
      symbol: 'ETH',
      canonical: 'ETH/USDC',
      base: 'ETH',
      quote: 'USDC',
      tickSize: '0.01',
      stepSize: '0.0001',
      minNotional: '10',
      minQty: '0.005',
      maxQty: null,
      maxLeverage: 20,
      priceDecimals: 2,
      qtyDecimals: 4,
      active: true,
    },
  },
  {
    nombre: 'LIGHTER SOL',
    mark: '138.42',
    spec: {
      venue: Venue.LIGHTER,
      symbol: 'SOL',
      canonical: 'SOL/USDC',
      base: 'SOL',
      quote: 'USDC',
      tickSize: '0.001',
      stepSize: '0.001',
      minNotional: '10',
      minQty: '0.1',
      maxQty: null,
      maxLeverage: 20,
      priceDecimals: 3,
      qtyDecimals: 3,
      active: true,
    },
  },

  // ── Hyperliquid ───────────────────────────────────────────────────────────
  {
    nombre: 'HYPERLIQUID BTC',
    mark: '78910',
    spec: {
      venue: Venue.HYPERLIQUID,
      symbol: 'BTC',
      canonical: 'BTC/USDC',
      base: 'BTC',
      quote: 'USDC',
      tickSize: '1',
      stepSize: '0.00001',
      minNotional: '10',
      minQty: '0.00001',
      maxQty: null,
      maxLeverage: 40,
      priceDecimals: 0,
      qtyDecimals: 5,
      active: true,
    },
  },
  {
    nombre: 'HYPERLIQUID ETH',
    mark: '2503.3',
    spec: {
      venue: Venue.HYPERLIQUID,
      symbol: 'ETH',
      canonical: 'ETH/USDC',
      base: 'ETH',
      quote: 'USDC',
      tickSize: '0.1',
      stepSize: '0.0001',
      minNotional: '10',
      minQty: '0.0001',
      maxQty: null,
      maxLeverage: 25,
      priceDecimals: 1,
      qtyDecimals: 4,
      active: true,
    },
  },
  {
    // szDecimals 0: el step es UNA moneda entera. Aquí es donde el redondeo
    // hacia abajo se come niveles enteros de una escalera.
    nombre: 'HYPERLIQUID DOGE (step entero)',
    mark: '0.09209',
    spec: {
      venue: Venue.HYPERLIQUID,
      symbol: 'DOGE',
      canonical: 'DOGE/USDC',
      base: 'DOGE',
      quote: 'USDC',
      tickSize: '0.00001',
      stepSize: '1',
      minNotional: '10',
      minQty: '1',
      maxQty: null,
      maxLeverage: 10,
      priceDecimals: 5,
      qtyDecimals: 0,
      active: true,
    },
  },
  {
    nombre: 'HYPERLIQUID kPEPE (tick minusculo)',
    // Alineado a su tick de 6 decimales, como llega de verdad del venue: un
    // precio con más decimales que su propio tick no existe en el libro.
    mark: '0.004133',
    spec: {
      venue: Venue.HYPERLIQUID,
      symbol: 'kPEPE',
      canonical: 'kPEPE/USDC',
      base: 'kPEPE',
      quote: 'USDC',
      tickSize: '0.000001',
      stepSize: '1',
      minNotional: '10',
      minQty: '1',
      maxQty: null,
      maxLeverage: 10,
      priceDecimals: 6,
      qtyDecimals: 0,
      active: true,
    },
  },

  // ── Aster ─────────────────────────────────────────────────────────────────
  {
    nombre: 'ASTER BTCUSDT',
    mark: '78910.1',
    spec: {
      venue: Venue.ASTER,
      symbol: 'BTCUSDT',
      canonical: 'BTC/USDT',
      base: 'BTC',
      quote: 'USDT',
      tickSize: '0.1',
      stepSize: '0.001',
      minNotional: '5',
      minQty: '0.001',
      maxQty: '1000',
      maxLeverage: 50,
      priceDecimals: 1,
      qtyDecimals: 3,
      active: true,
    },
  },
  {
    nombre: 'ASTER ETHUSDT',
    mark: '2503.35',
    spec: {
      venue: Venue.ASTER,
      symbol: 'ETHUSDT',
      canonical: 'ETH/USDT',
      base: 'ETH',
      quote: 'USDT',
      tickSize: '0.01',
      stepSize: '0.001',
      minNotional: '5',
      minQty: '0.001',
      maxQty: '10000',
      maxLeverage: 50,
      priceDecimals: 2,
      qtyDecimals: 3,
      active: true,
    },
  },
  {
    nombre: 'ASTER DOGEUSDT (step entero)',
    mark: '0.09209',
    spec: {
      venue: Venue.ASTER,
      symbol: 'DOGEUSDT',
      canonical: 'DOGE/USDT',
      base: 'DOGE',
      quote: 'USDT',
      tickSize: '0.00001',
      stepSize: '1',
      minNotional: '5',
      minQty: '1',
      maxQty: '50000000',
      maxLeverage: 50,
      priceDecimals: 5,
      qtyDecimals: 0,
      active: true,
    },
  },
  {
    nombre: 'ASTER 1000PEPEUSDT (tick de 7 decimales)',
    mark: '0.0041336',
    spec: {
      venue: Venue.ASTER,
      symbol: '1000PEPEUSDT',
      canonical: '1000PEPE/USDT',
      base: '1000PEPE',
      quote: 'USDT',
      tickSize: '0.0000001',
      stepSize: '1',
      minNotional: '5',
      minQty: '1',
      maxQty: '800000000',
      maxLeverage: 50,
      priceDecimals: 7,
      qtyDecimals: 0,
      active: true,
    },
  },
];
