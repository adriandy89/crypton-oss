import { ExchangeError, Venue } from '@crypton/shared';
import { classify, isRetryable, isThrottled, shortMessage, toExchangeError } from './errors';
import { absoluteChange } from './adapters/lighter';
import {
  VENUE_QUOTA_PER_MINUTE,
  VENUE_QUOTA_UNIT,
  asterWeight,
  hyperliquidWeight,
  lighterCost,
} from './venue-weights';

/**
 * La pagina del cortafuegos de AWS WAF, tal y como la devuelve Lighter.
 *
 * El `nonce` va aparte porque es justo la parte que rompia la clasificacion:
 * son bytes aleatorios en base64 y el patron RETRYABLE busca los literales
 * `429|502|503|504` sobre el mensaje ENTERO.
 */
const paginaWaf = (nonce: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Human Verification</title>
    <script type="text/javascript">
    window.awsWafCookieDomainList = ['app.lighter.xyz','lighter.exchange'];
    window.gokuProps = { "key":"AQIDAHjcYu", "iv":"${nonce}", "context":"S9cIR1jETAzkSD" };
    </script>
    <script src="https://x.captcha.awswaf.com/a/b/c/captcha.js"></script>
</head>
<body><div id="captcha-container"></div>
    <noscript><h1>JavaScript is disabled</h1>
    In order to continue, you need to verify that you're not a robot by solving a CAPTCHA puzzle.
    </noscript>
</body>
</html>`;

describe('cortafuegos del venue — la clasificacion no puede depender del azar', () => {
  /**
   * Este es el fallo que motivo todo: el mismo bloqueo se comportaba de dos
   * maneras segun lo que tocara en la loteria del base64. Con «503» dentro,
   * `withRetry` disparaba cuatro peticiones mas contra un cortafuegos que ya
   * nos tenia en enfriamiento de 60 s — que es exactamente lo que el venue
   * castiga.
   */
  it('la misma pagina se clasifica igual lleve o no un «503» en el nonce', () => {
    const conNumero = paginaWaf('D57dQ503EBKAAADdvd');
    const sinNumero = paginaWaf('D57dQzzEBKAAADdvd');

    expect(conNumero).toContain('503');
    expect(sinNumero).not.toContain('503');

    expect(classify(conNumero)).toBe('THROTTLED');
    expect(classify(sinNumero)).toBe('THROTTLED');
    expect(classify(conNumero)).toBe(classify(sinNumero));
  });

  it('un bloqueo NO se reintenta: insistir es lo que alarga el castigo', () => {
    expect(isRetryable(new ExchangeError('THROTTLED', 'cortado', undefined))).toBe(false);
    expect(isRetryable(paginaWaf('abc'))).toBe(false);
  });

  /**
   * Los codigos que documentan los venues: Lighter «HTTP 429, or HTTP 405»;
   * Aster 429 y **418** con veto de IP «from 2 minutes to 3 days».
   */
  it.each([405, 418, 429])('el estado HTTP %i es un corte del venue, no un fallo', (status) => {
    expect(isThrottled({ response: { status } })).toBe(true);
    expect(classify({ response: { status } })).toBe('THROTTLED');
  });

  it('un timeout de verdad sigue siendo reintentable', () => {
    expect(classify('socket hang up')).toBe('RETRYABLE');
    expect(classify(new Error('ETIMEDOUT'))).toBe('RETRYABLE');
  });

  it('un rechazo por reglas no se confunde con un corte', () => {
    expect(classify('order price violates tick size')).toBe('RULES');
  });

  it('el mensaje que llega a la pantalla cabe en una linea', () => {
    const corto = shortMessage(paginaWaf('abc'));
    expect(corto.length).toBeLessThanOrEqual(200);
    expect(corto).not.toContain('\n');
  });
});

describe('cambio de 24 h a partir del porcentaje del venue', () => {
  /**
   * `daily_price_change` viene en PORCENTAJE, medido contra el venue: ZRO
   * llego con 21.0 sobre un precio de 1,229. Como importe serian 21 dolares
   * sobre una moneda de un dolar.
   */
  it('se redondea a los decimales del precio, sin arrastrar la division', () => {
    // BTC: el caso real que salia con treinta y tantos decimales de ruido
    // («325.71094294759963641510818296582226843»).
    expect(absoluteChange('77382.3', 0.4157)).toBe('320.3');
    // ZRO, con cinco decimales: 1,22939 / 1,2100057 = 1,01602 -> 0,21337.
    expect(absoluteChange('1.22939', 21.00057)).toBe('0.21337');
  });

  it('un porcentaje ausente no inventa un cambio', () => {
    expect(absoluteChange('100', undefined)).toBeNull();
  });

  it('un porcentaje que implicaria un precio previo <= 0 se descarta', () => {
    // -100 % no es una caida total: es un dato roto que daria division por cero.
    expect(absoluteChange('100', -100)).toBeNull();
    expect(absoluteChange('100', -150)).toBeNull();
  });
});

/**
 * Los cuatro fallos que aparecieron al revisar la propia implementacion. Cada
 * uno se colaba por el mismo sitio: un dato correcto usado en la unidad
 * equivocada, o perdido por el camino.
 */
describe('revision — lo que se rompio al implementar esto', () => {
  it('el estado HTTP suelto vale: `publicGet` tiene `res.status`, no un objeto', () => {
    // Sin esto, un corte SIN cuerpo HTML —que es como llega la mayoria— caia en
    // los patrones de texto y se clasificaba como un fallo cualquiera.
    for (const status of [405, 418, 429]) {
      expect(isThrottled(status)).toBe(true);
      expect(classify(status)).toBe('THROTTLED');
    }
    expect(isThrottled(200)).toBe(false);
    expect(isThrottled(500)).toBe(false);
  });

  /**
   * El mas peligroso de los cuatro. El mensaje de un 429 de Aster casa con el
   * patron RETRYABLE («too many requests»), asi que `withRetry` lo reintentaba
   * cuatro veces — que es literalmente lo que su documentacion prohibe y lo que
   * convierte un 429 en un 418 con veto de IP de hasta tres dias.
   */
  it('un 429 con el estado a la vista NO se reintenta', () => {
    const cuerpo = 'Too many requests; current limit is 2400 requests per minute.';

    // Sin el estado, el texto manda y sale reintentable.
    expect(classify(cuerpo)).toBe('RETRYABLE');
    // Con el estado, es un corte del venue y se para.
    expect(classify(cuerpo, 429)).toBe('THROTTLED');
    expect(isRetryable(toExchangeError(cuerpo, undefined, 429))).toBe(false);
  });

  it('el 418 se cuenta como veto, no como un corte de un minuto', () => {
    const e = toExchangeError('banned', undefined, 418);
    expect(e.kind).toBe('THROTTLED');
    expect(e.message).toMatch(/VETADO/);
    // Y el 429 normal no se disfraza de veto.
    expect(toExchangeError('slow down', undefined, 429).message).not.toMatch(/VETADO/);
  });

  it('el cuerpo original se conserva para el log aunque el mensaje se limpie', () => {
    const e = toExchangeError(paginaWaf('abc'), undefined, 405);
    expect(e.message.length).toBeLessThan(200);
    expect(String(e.raw)).toContain('Human Verification');
  });
});

describe('pesos de los venues — la tabla es la del venue, no una parecida', () => {
  /**
   * Tabla oficial de `klines`: [1,100) -> 1 · [100,500) -> 2 · [500,1000] -> 5
   * · >1000 -> 10. Los dos primeros intervalos son SEMIABIERTOS, y con un unico
   * `<=` para todos los limites redondos —los que se piden en la practica—
   * salian por debajo.
   */
  it.each([
    [50, 1],
    [99, 1],
    [100, 2],
    [499, 2],
    [500, 5],
    [1000, 5],
    [1500, 10],
  ])('klines con limit=%i pesa %i', (limit, esperado) => {
    expect(asterWeight('/fapi/v3/klines', { symbol: 'BTCUSDT', limit })).toBe(esperado);
  });

  it('los endpoints SIN simbolo son los caros, y son los que usa el cron', () => {
    // Este es el que corria cada 30 s contabilizado como 1.
    expect(asterWeight('/fapi/v3/ticker/24hr')).toBe(40);
    expect(asterWeight('/fapi/v3/ticker/24hr', { symbol: 'BTCUSDT' })).toBe(1);
    expect(asterWeight('/fapi/v3/openOrders')).toBe(40);
    expect(asterWeight('/fapi/v3/openOrders', { symbol: 'BTCUSDT' })).toBe(1);
  });

  it('depth y las lecturas de cuenta, con sus valores publicados', () => {
    expect(asterWeight('/fapi/v3/depth', { limit: 50 })).toBe(2);
    expect(asterWeight('/fapi/v3/depth', { limit: 100 })).toBe(5);
    expect(asterWeight('/fapi/v3/depth', { limit: 1000 })).toBe(20);
    expect(asterWeight('/fapi/v3/balance')).toBe(5);
    expect(asterWeight('/fapi/v3/userTrades')).toBe(5);
  });

  it('candleSnapshot de Hyperliquid suma por barras, no es un peso plano', () => {
    // 20 mas uno por cada 60 barras. Iba a 2 por el defecto de la funcion.
    expect(hyperliquidWeight('candleSnapshot', 500)).toBe(29);
    expect(hyperliquidWeight('l2Book')).toBe(2);
    expect(hyperliquidWeight('userRole')).toBe(60);
    expect(hyperliquidWeight('metaAndAssetCtxs')).toBe(20);
  });

  /**
   * El fallo mas grave de la revision. El cupo Standard de Lighter son 60
   * PETICIONES por minuto, no 60 de peso: descontar los 300 del peso publicado
   * dejaba una deuda de casi seis minutos por UNA lectura. El venue habria
   * estado abierto y seriamos nosotros los que dejariamos de llamar.
   */
  it('Lighter se cobra en peticiones, que es como publica su cupo', () => {
    expect(VENUE_QUOTA_UNIT[Venue.LIGHTER]).toBe('requests');
    expect(lighterCost('/api/v1/orderBookDetails')).toBe(1);
    expect(lighterCost('/api/v1/candles')).toBe(1);
    // `trades` pesa 600 contra los 300 corrientes: el doble, y asi se cobra.
    expect(lighterCost('trades')).toBe(2);

    // Una lectura tiene que caber en el deposito de un minuto de cupo.
    const porMinuto = VENUE_QUOTA_PER_MINUTE[Venue.LIGHTER];
    expect(lighterCost('trades')).toBeLessThan(porMinuto);

    // Los otros dos SI van en peso, y su escala es otra.
    expect(VENUE_QUOTA_UNIT[Venue.ASTER]).toBe('weight');
    expect(VENUE_QUOTA_UNIT[Venue.HYPERLIQUID]).toBe('weight');
  });

  /**
   * La prueba de que las unidades encajan: el coste de la lectura mas cara de
   * cada venue tiene que ser una fraccion pequena de su cupo por minuto. Si
   * alguien vuelve a mezclar peso con peticiones, esto lo caza.
   */
  it.each([
    [Venue.LIGHTER, lighterCost('trades')],
    [Venue.ASTER, asterWeight('/fapi/v3/ticker/24hr')],
    [Venue.HYPERLIQUID, hyperliquidWeight('candleSnapshot', 5000)],
  ])('en %s la lectura mas cara cabe de sobra en un minuto de cupo', (venue, coste) => {
    const porMinuto = VENUE_QUOTA_PER_MINUTE[venue];
    expect(coste).toBeLessThanOrEqual(porMinuto / 10);
  });
});
