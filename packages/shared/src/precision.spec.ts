import { D } from './money';
import { normalizeOrder, roundPriceForSide } from './precision';
import type { MarketSpec } from './market';

/**
 * La unica puerta de redondeo. Lo que se defiende aqui (spec 014, F-04): que
 * un venue con tope de cifras significativas —Hyperliquid, cinco— vea el
 * mismo precio desde la estrategia que desde el adaptador, y que el recorte
 * vaya siempre en la direccion segura del lado.
 */

const mercado = (over: Partial<MarketSpec> = {}): MarketSpec => ({
  venue: 'HYPERLIQUID',
  symbol: 'AXS',
  canonical: 'AXS/USDC',
  base: 'AXS',
  quote: 'USDC',
  tickSize: '0.00001',
  stepSize: '0.1',
  minNotional: '10',
  minQty: '0.1',
  maxQty: null,
  maxLeverage: 20,
  priceDecimals: 5,
  qtyDecimals: 1,
  active: true,
  maxSignificantDigits: 5,
  ...over,
});

describe('cifras significativas', () => {
  /**
   * El tick de Hyperliquid se calcula sobre el mid del catalogo (0,94583 para
   * AXS → 0,00001), pero a 1,00001 el venue solo admite cinco cifras
   * significativas: la estrategia planificaba 1,00001 y el adaptador enviaba
   * 1 (HALF_UP), el reconciliador veia dos precios distintos y cancelaba y
   * recolocaba la orden en CADA tick. Ahora la puerta aplica la regla del
   * venue, hacia abajo en la compra y hacia arriba en la venta.
   */
  it('recorta hacia el lado seguro cuando el precio se sale de las cifras del venue', () => {
    expect(roundPriceForSide('1.00001', '0.00001', 'BUY', 5).toFixed()).toBe('1');
    expect(roundPriceForSide('1.00001', '0.00001', 'SELL', 5).toFixed()).toBe('1.0001');
    expect(roundPriceForSide('1.00006', '0.00001', 'BUY', 5).toFixed()).toBe('1');
    expect(roundPriceForSide('0.94583', '0.00001', 'BUY', 5).toFixed()).toBe('0.94583');
  });

  it('los enteros se respetan aunque tengan mas cifras', () => {
    // «Integer prices are always allowed, regardless of the number of
    // significant figures»: 119375 vale tal cual, no 119370 ni 119380.
    expect(roundPriceForSide('119375', '1', 'BUY', 5).toFixed()).toBe('119375');
    expect(roundPriceForSide('119375', '1', 'SELL', 5).toFixed()).toBe('119375');
  });

  it('sin tope declarado, la puerta es la de siempre', () => {
    expect(roundPriceForSide('1.00001', '0.00001', 'BUY').toFixed()).toBe('1.00001');
  });

  it('normalizeOrder aplica la regla del mercado y es idempotente', () => {
    const m = mercado();
    const primera = normalizeOrder(m, '1.00001', '5', 'BUY').price;
    const segunda = normalizeOrder(m, primera, '5', 'BUY').price;
    expect(primera.toFixed()).toBe('1');
    expect(segunda.eq(primera)).toBe(true);
    expect(
      normalizeOrder(mercado({ maxSignificantDigits: null }), '1.00001', '5', 'BUY').price.eq(
        D('1.00001'),
      ),
    ).toBe(true);
  });
});
