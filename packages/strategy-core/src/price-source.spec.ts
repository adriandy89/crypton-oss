import { binanceSymbol, fairPriceKey, fairPriceRedisKey } from '@crypton/shared';

/**
 * Vive aqui y no en `packages/shared` porque ese paquete se declara «de solo
 * tipos» y no tiene ejecutor de pruebas — pero `price-source.ts` no es solo
 * tipos: `binanceSymbol` decide contra que simbolo se ancla el precio de un
 * market maker, y si devuelve uno que no existe en Binance el bot arranca y no
 * cotiza ni una orden.
 *
 * Se quedo sin cobertura al retirar CoinGecko: los unicos tests que la tocaban
 * lo hacian de refilon, validando identificadores de CoinGecko.
 */
describe('binanceSymbol', () => {
  it('fuerza la quote a USDT, ignorando la del venue', () => {
    // Deliberado: en Binance la liquidez de referencia esta en los pares USDT.
    // Un BTCUSDC con la decima parte del volumen daria un precio PEOR que el del
    // propio venue, que es lo contrario de para lo que se pide una fuente
    // externa.
    expect(binanceSymbol('BTC')).toBe('BTCUSDT');
    expect(binanceSymbol('eth')).toBe('ETHUSDT');
  });

  it('el simbolo alternativo manda, y va en mayusculas', () => {
    // Es la unica salida para un par cuya base no case con `<base>USDT`.
    expect(binanceSymbol('PEPE', '1000pepeusdt')).toBe('1000PEPEUSDT');
  });

  it('un alternativo en blanco no cuenta como alternativo', () => {
    // Un campo de texto vaciado a mano llega como espacios, no como null.
    expect(binanceSymbol('SOL', '   ')).toBe('SOLUSDT');
  });
});

describe('claves del feed compartido', () => {
  it('una sola clave por fuente, mercado y simbolo', () => {
    // Es lo que hace que mil bots sobre el mismo par abran UN solo sondeo.
    expect(fairPriceKey('BINANCE', 'PERP', 'btcusdt')).toBe('BINANCE:PERP:BTCUSDT');
  });

  it('la clave de Redis va en minusculas y con el prefijo del proyecto', () => {
    expect(fairPriceRedisKey('BINANCE:PERP:BTCUSDT')).toBe('crypton:fx:binance:perp:btcusdt');
  });
});
