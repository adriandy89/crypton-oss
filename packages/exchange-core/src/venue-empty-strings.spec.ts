import { D, firstNum, isFiniteNum } from '@crypton/shared';
import { num, numOrNull } from './candles';
import { classify, messageOf } from './errors';

/**
 * La cadena vacía del venue: el fallo que pausó un bot en producción.
 *
 * Un bot de Lighter en testnet (BTC, martingala) acumuló cinco ticks seguidos
 * con `[DecimalError] Invalid argument: ` —el mensaje acaba en el espacio, sin
 * valor detrás— y el cortacircuitos lo pausó.
 *
 * El valor que no se imprime es la CADENA VACÍA: `new Decimal(null)` diría
 * «null» y `new Decimal(undefined)` diría «undefined». Y todo el código de los
 * adaptadores la dejaba pasar, porque escribía `D(campo ?? 0)` y `??` solo tapa
 * `null` y `undefined`.
 *
 * El payload de `PAYLOAD_REAL` está copiado tal cual del WebSocket de
 * `wss://testnet.zklighter.elliot.ai/stream`, canal `market_stats/all`, para
 * BTC. No es inventado ni reducido: así es como responde el venue cuando un
 * mercado no tiene libro, que en testnet es el estado normal de casi todos los
 * pares.
 */

/** `market_stats` de BTC en Lighter testnet, capturado del stream. */
const PAYLOAD_REAL = {
  symbol: 'BTC',
  market_id: 1,
  index_price: '78957.1',
  mark_price: '78957.1',
  mid_price: '',
  best_ask_price: '',
  best_bid_price: '',
  open_interest: '0.000000',
  last_trade_price: '0.0',
  current_funding_rate: '0.0012',
  funding_rate: '0.0012',
  funding_timestamp: 1787608800000,
};

describe('la cadena vacía del venue', () => {
  it('reproduce el fallo: `??` no la tapa y Decimal lanza', () => {
    // Esto es EXACTAMENTE lo que hacía el adaptador, y es lo que rompía el tick.
    expect(() => D(PAYLOAD_REAL.best_bid_price ?? 0)).toThrow(/Invalid argument/);

    // Y el mensaje acaba sin valor: por eso el evento del bot se veía cortado.
    let mensaje = '';
    try {
      D(PAYLOAD_REAL.best_bid_price ?? 0);
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toBe('[DecimalError] Invalid argument: ');
  });

  it('`null` y `undefined` SÍ los tapa: por eso nadie lo vio antes', () => {
    // Se leen de un objeto para que TypeScript no colapse el `??` en
    // compilación: lo que se prueba es el comportamiento en ejecución, que es
    // el que tenía el adaptador leyendo del venue.
    const delVenue: Record<string, string | null | undefined> = {
      nulo: null,
      ausente: undefined,
      vacio: '',
    };
    expect(D(delVenue.nulo ?? 0).toFixed()).toBe('0');
    expect(D(delVenue.ausente ?? 0).toFixed()).toBe('0');
    // La tercera es la que rompe, y es la única que el venue manda de verdad.
    expect(() => D(delVenue.vacio ?? 0)).toThrow(/Invalid argument/);
  });

  it('firstNum la trata como ausente y cae al respaldo', () => {
    expect(firstNum(PAYLOAD_REAL.best_bid_price, 0).toFixed()).toBe('0');
    expect(firstNum(PAYLOAD_REAL.mid_price, PAYLOAD_REAL.mark_price).toFixed()).toBe('78957.1');
  });

  it('firstNum respeta el primer valor utilizable, incluido el cero', () => {
    // `last_trade_price: '0.0'` es un dato REAL —nadie ha operado— y no debe
    // saltarse: saltarlo enseñaría el precio de otro campo como si fuera este.
    expect(firstNum(PAYLOAD_REAL.last_trade_price, 999).toFixed()).toBe('0');
    expect(firstNum('', null, undefined, '12.5').toFixed()).toBe('12.5');
  });

  it('firstNum descarta la basura que Decimal no sabe leer', () => {
    expect(firstNum('n/a', 7).toFixed()).toBe('7');
    expect(firstNum(NaN, 7).toFixed()).toBe('7');
    expect(firstNum(Infinity, 7).toFixed()).toBe('7');
    expect(firstNum({}, 7).toFixed()).toBe('7');
  });

  it('sin ningún valor utilizable devuelve cero en vez de lanzar', () => {
    // Quien llama es un adaptador dentro del tick de un bot: ahí una excepción
    // vale una pausa.
    expect(firstNum('', null).toFixed()).toBe('0');
    expect(firstNum().toFixed()).toBe('0');
  });

  it('isFiniteNum ya conocía la regla: firstNum solo la reutiliza', () => {
    expect(isFiniteNum('')).toBe(false);
    expect(isFiniteNum('0.0')).toBe(true);
  });

  it('num y numOrNull tampoco la dejan pasar ya', () => {
    // Tenían el mismo agujero: comprobaban null pero no la cadena vacía.
    expect(num('')).toBe('0');
    expect(numOrNull('')).toBeNull();
    expect(num('0.0')).toBe('0');
    expect(numOrNull(null)).toBeNull();
  });
});

/**
 * La página de error del proxy.
 *
 * El segundo síntoma del mismo incidente: la ficha del bot enseñaba «5 ticks
 * seguidos fallidos (último: <html> <head><title>503 Service Temporarily
 * Unavailable…» con la página entera dentro.
 */
const HTML_503 =
  '<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n' +
  '<body>\r\n<center><h1>503 Service Temporarily Unavailable</h1></center>\r\n' +
  '<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

describe('páginas de error en vez de respuestas de la API', () => {
  it('no se imprime el HTML: se resume en una línea', () => {
    const salida = messageOf(HTML_503);
    expect(salida).not.toContain('<html>');
    expect(salida).not.toContain('<center>');
    expect(salida.length).toBeLessThan(120);
  });

  it('con estado HTTP, el estado manda', () => {
    const err = Object.assign(new Error('Request failed'), {
      response: { status: 503, data: HTML_503 },
    });
    expect(messageOf(err)).toContain('HTTP 503');
    expect(messageOf(err)).not.toContain('<title>');
  });

  it('sigue clasificándose como REINTENTABLE', () => {
    // El resumen conserva el 503, que es lo que decide si el bot espera o se
    // rinde. Perderlo convertiría una caída pasajera del venue en un fallo
    // fatal.
    expect(classify(HTML_503)).toBe('RETRYABLE');
    expect(
      classify(Object.assign(new Error('x'), { response: { status: 503, data: HTML_503 } })),
    ).toBe('RETRYABLE');
  });

  it('una respuesta normal de la API no se toca', () => {
    expect(messageOf('{"code":21000,"message":"invalid nonce"}')).toBe(
      '{"code":21000,"message":"invalid nonce"}',
    );
    expect(messageOf('order size too small')).toBe('order size too small');
  });
});
