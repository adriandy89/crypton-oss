import { classify } from './errors';
import { feeToUsdc } from './adapters/lighter';

/**
 * La clasificacion decide si un bot SOBREVIVE a un rechazo.
 *
 * No tenia ni un test, y por eso pudo pasar esto: el patron `RULES` conocia el
 * vocabulario de Binance y de Hyperliquid —`size`, `notional`, `lot size`— pero
 * no el de Lighter, que dice `amount`. Su rechazo mas comun caia en FATAL,
 * `place()` relanza todo lo que no sea RULES, y un solo nivel demasiado pequeno
 * tumbaba el tick entero. A los cinco, el cortacircuitos pausaba el bot con la
 * posicion abierta y sin stop loss.
 */
describe('clasificacion de errores del venue', () => {
  describe('el caso que pauso un bot de verdad', () => {
    it('«invalid order base or quote amount» es una regla, no una averia', () => {
      // Lighter dice esto cuando la orden no llega a `min_base_amount` o a
      // `min_quote_amount`. Es informacion, no una caida.
      expect(classify('invalid order base or quote amount')).toBe('RULES');
    });
  });

  describe('los tres venues dicen lo mismo de formas distintas', () => {
    it.each([
      // Lighter
      ['invalid order base or quote amount', 'RULES'],
      ['order quote amount too low', 'RULES'],
      ['min base amount not met', 'RULES'],
      // Binance / Aster
      ['Filter failure: MIN_NOTIONAL', 'RULES'],
      ['Filter failure: LOT_SIZE', 'RULES'],
      ['Precision is over the maximum defined for this asset', 'RULES'],
      // Hyperliquid
      ['Order has invalid price', 'RULES'],
      ['Post only order would immediately match', 'RULES'],
      ['Order size too small', 'RULES'],
    ])('%s -> %s', (mensaje, esperado) => {
      expect(classify(mensaje)).toBe(esperado);
    });
  });

  describe('sin tragarse lo que NO es una regla', () => {
    it.each([
      ['insufficient balance to place order', 'INSUFFICIENT_FUNDS'],
      ['exceeds free collateral', 'INSUFFICIENT_FUNDS'],
      ['unauthorized', 'AUTH'],
      ['invalid api key', 'AUTH'],
      ['socket hang up', 'RETRYABLE'],
      ['ECONNRESET', 'RETRYABLE'],
      ['algo que no habiamos visto nunca', 'FATAL'],
    ])('%s -> %s', (mensaje, esperado) => {
      expect(classify(mensaje)).toBe(esperado);
    });

    it('el corte del cortafuegos manda sobre todo lo demas', () => {
      // Su HTML lleva basura suficiente para hacer saltar cualquier patron por
      // casualidad, asi que se mira ANTES.
      expect(classify('<html>Human Verification</html>')).toBe('THROTTLED');
      expect(classify('x', 429)).toBe('THROTTLED');
    });
  });
});

/**
 * La escala de las comisiones decide el PnL de todo el mundo.
 *
 * En el tipo `Trade` del SDK, `size`, `price` y `usd_amount` son cadenas
 * decimales pero `maker_fee` y `taker_fee` son `number`, en unidades escaladas.
 * Leerlos en crudo multiplicaba cada comision por un millon.
 */
describe('comisiones de Lighter', () => {
  it('el caso real: 50 no son 50 dolares', () => {
    // Ejecucion de 0,00001 BTC a 78.603,3 = 0,79 $, con `maker_fee: 50`.
    // Se registro como 50 $ de comision, y la tarjeta del bot decia
    // «PnL −50,00 · ROI −10 %» sobre una operacion de ochenta centimos.
    expect(feeToUsdc(50)).toBe('0.00005');
    expect(Number(feeToUsdc(50))).toBeLessThan(0.001);
  });

  it('la comision nunca puede comerse la operacion', () => {
    const notionalUsd = 0.786;
    expect(Number(feeToUsdc(50))).toBeLessThan(notionalUsd);
    expect(Number(feeToUsdc(196))).toBeLessThan(notionalUsd);
  });

  it('cero sigue siendo cero, y lo ausente tambien', () => {
    expect(feeToUsdc(0)).toBe('0');
    expect(feeToUsdc(null)).toBe('0');
    expect(feeToUsdc(undefined)).toBe('0');
  });

  it('un valor absurdo no envenena el PnL con NaN', () => {
    expect(feeToUsdc(Number.NaN)).toBe('0');
  });
});
