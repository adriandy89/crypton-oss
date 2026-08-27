import { BarPath, D, Venue, type Candle, type MarketSpec } from '@crypton/shared';
import { tickPath, tickerAt } from './ticks';

const SPAN = 900_000; // 15m
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % SPAN);

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

const vela = (o: string, h: string, l: string, c: string): Candle => ({
  t: T0,
  o,
  h,
  l,
  c,
  v: '1',
});

describe('tickPath', () => {
  it('emite cuatro precios por vela', () => {
    expect(tickPath(vela('100', '110', '90', '105'), '15m', BarPath.NEAREST_FIRST)).toHaveLength(4);
  });

  it('los tiempos crecen y caen DENTRO de la barra, nunca en la siguiente', () => {
    // `t + S` ya es el instante de la vela siguiente: una ejecución con esa
    // marca aparecería fuera de su propia barra.
    const pasos = tickPath(vela('100', '110', '90', '105'), '15m', BarPath.NEAREST_FIRST);
    const ts = pasos.map((p) => p.ts);

    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(new Set(ts).size).toBe(4);
    expect(ts[0]).toBe(T0);
    expect(ts[3]).toBeLessThan(T0 + SPAN);
  });

  it('empieza en la apertura y acaba en el cierre', () => {
    const pasos = tickPath(vela('100', '110', '90', '105'), '15m', BarPath.NEAREST_FIRST);
    expect(pasos[0].price.toFixed()).toBe('100');
    expect(pasos[0].role).toBe('open');
    expect(pasos[3].price.toFixed()).toBe('105');
    expect(pasos[3].role).toBe('close');
  });

  describe('NEAREST_FIRST: el extremo más cercano a la apertura va primero', () => {
    it('apertura cerca del máximo ⇒ máximo primero', () => {
      const pasos = tickPath(vela('108', '110', '90', '95'), '15m', BarPath.NEAREST_FIRST);
      expect(pasos[1].role).toBe('high');
      expect(pasos[2].role).toBe('low');
    });

    it('apertura cerca del mínimo ⇒ mínimo primero', () => {
      const pasos = tickPath(vela('92', '110', '90', '105'), '15m', BarPath.NEAREST_FIRST);
      expect(pasos[1].role).toBe('low');
      expect(pasos[2].role).toBe('high');
    });
  });

  describe('PESSIMISTIC: primero el extremo que más duele', () => {
    it('vela alcista ⇒ primero el mínimo', () => {
      const pasos = tickPath(vela('100', '110', '90', '108'), '15m', BarPath.PESSIMISTIC);
      expect(pasos[1].role).toBe('low');
    });

    it('vela bajista ⇒ primero el máximo', () => {
      const pasos = tickPath(vela('100', '110', '90', '92'), '15m', BarPath.PESSIMISTIC);
      expect(pasos[1].role).toBe('high');
    });
  });
});

describe('tickerAt', () => {
  const at = (price: string, role: 'open' | 'high' | 'low' | 'close', bps = 20) =>
    tickerAt(Venue.HYPERLIQUID, MARKET, D(price), role, T0, bps);

  it('EN EL MÍNIMO, el ask se pega al mínimo', () => {
    // Es la propiedad de la que depende todo el casado. `matchRestingOrders`
    // ejecuta una compra cuando el ask BAJA hasta el límite: con
    // `ask = mínimo + medio diferencial`, una orden puesta exactamente en el
    // mínimo de la vela no se ejecutaría, aunque el precio la tocó de verdad.
    const t = at('90', 'low');
    expect(t.ask).toBe('90');
    expect(Number(t.bid)).toBeLessThan(90);
  });

  it('EN EL MÁXIMO, el bid se pega al máximo', () => {
    // El simétrico para las ventas.
    const t = at('110', 'high');
    expect(t.bid).toBe('110');
    expect(Number(t.ask)).toBeGreaterThan(110);
  });

  it('en apertura y cierre el precio va centrado', () => {
    const t = at('100', 'open');
    expect(Number(t.bid)).toBeLessThan(100);
    expect(Number(t.ask)).toBeGreaterThan(100);
    expect(Number(t.ask) - 100).toBeCloseTo(100 - Number(t.bid), 8);
  });

  it('el precio de MARCA va también en el extremo', () => {
    // Los venues liquidan en la mecha: suavizarlo aquí regalaría liquidaciones
    // que en el venue sí ocurren.
    expect(at('90', 'low').mark).toBe('90');
    expect(at('110', 'high').mark).toBe('110');
  });

  it('el diferencial tiene suelo de medio tick', () => {
    // Con 0 bps el diferencial sería cero y el libro dejaría de tener dos lados.
    const t = at('100', 'open', 0);
    expect(Number(t.ask) - Number(t.bid)).toBeCloseTo(0.1, 8);
  });

  it('el diferencial escala con los puntos básicos pedidos', () => {
    const estrecho = at('100', 'open', 20);
    const ancho = at('100', 'open', 200);
    expect(Number(ancho.ask) - Number(ancho.bid)).toBeGreaterThan(
      Number(estrecho.ask) - Number(estrecho.bid),
    );
  });

  it('el bid nunca baja de cero', () => {
    const t = at('0.0001', 'open', 100_000);
    expect(Number(t.bid)).toBeGreaterThanOrEqual(0);
  });
});
