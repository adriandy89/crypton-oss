import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WS } from 'ws';
import type { Fill } from '@crypton/shared';
import { LighterAdapter, resubscribePaced } from './adapters/lighter';

/**
 * Pruebas del transporte de Lighter contra servidores LOCALES.
 *
 * Existen porque contra el venue de verdad no se pueden provocar los casos que
 * importan: no hay forma de pedirle un 405 con la pagina de su cortafuegos, ni
 * un corte de socket en el momento justo, ni una actualizacion parcial de
 * `market_stats`. Y son justo los caminos donde este adaptador fallaba en
 * silencio.
 *
 * Las FORMAS de los mensajes no estan inventadas: son las que devolvio una
 * sonda real contra `wss://mainnet.zklighter.elliot.ai/stream`.
 */

/** La pagina de AWS WAF, con su nonce en base64. */
const PAGINA_WAF = [
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
  '<title>Human Verification</title><script type="text/javascript">',
  "window.awsWafCookieDomainList = ['app.lighter.xyz','lighter.exchange'];",
  'window.gokuProps = {"key":"AQIDAH","iv":"D57dQQEBKAAADdvd"};',
  '</script><script src="https://x.captcha.awswaf.com/a/b/captcha.js"></script>',
  '</head><body><div id="captcha-container"></div></body></html>',
].join('\n');

const ESPERA = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Respuesta {
  status?: number;
  cuerpo: string;
  tipo?: string;
}

/** Servidor REST de mentira: devuelve lo que se le diga por ruta. */
class ServidorRest {
  readonly rutas = new Map<string, Respuesta>();
  readonly pedidos: string[] = [];
  /** Cabeceras de la ultima peticion, para comprobar la autenticacion. */
  ultimasCabeceras: Record<string, string | string[] | undefined> = {};
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      this.pedidos.push(req.url ?? '');
      this.ultimasCabeceras = req.headers;
      const ruta = this.rutas.get((req.url ?? '').split('?')[0]);
      if (!ruta) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(ruta.status ?? 200, { 'content-type': ruta.tipo ?? 'application/json' });
      res.end(ruta.cuerpo);
    });
  }

  escuchar(): Promise<void> {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r()));
  }

  get url(): string {
    return 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
  }

  cerrar(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

const CATALOGO = JSON.stringify({
  order_book_details: [
    {
      symbol: 'BTC',
      market_id: 1,
      market_type: 'perp',
      status: 'active',
      supported_price_decimals: 1,
      supported_size_decimals: 5,
      min_initial_margin_fraction: 200,
      last_trade_price: '77000',
    },
  ],
});

describe('Lighter REST — los casos que el venue no deja provocar', () => {
  let rest: ServidorRest;
  let adapter: LighterAdapter | null = null;

  beforeEach(async () => {
    rest = new ServidorRest();
    await rest.escuchar();
    rest.rutas.set('/api/v1/orderBookDetails', { cuerpo: CATALOGO });
  });

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
    await rest.cerrar();
  });

  const crear = (): LighterAdapter => {
    adapter = new LighterAdapter({
      venue: 'LIGHTER',
      accountIndex: 0,
      apiKeyIndex: 0,
      apiPrivateKey: '',
      baseUrl: rest.url,
    });
    return adapter;
  };

  it('sirve las velas cuando el venue responde JSON', async () => {
    rest.rutas.set('/api/v1/candles', {
      cuerpo: JSON.stringify({
        code: 200,
        c: [
          { t: 1787486400000, o: 77348.1, h: 77356.3, l: 77053.3, c: 77277.4, v: 196.4 },
          { t: 1787500800000, o: 77277.4, h: 77400, l: 77200, c: 77390 },
        ],
      }),
    });

    const velas = await crear().getCandles('BTC', '4h', { startMs: 0, limit: 2 });
    expect(velas).toHaveLength(2);
    expect(velas[0]).toMatchObject({ o: '77348.1', c: '77277.4', v: '196.4' });
    // «Zero values are omitted from the response»: la vela sin volumen sale con
    // 0 y su CIERRE no se pierde, que era el riesgo de tratarlo como ausente.
    expect(velas[1]).toMatchObject({ c: '77390', v: '0' });
  });

  /**
   * El caso del incidente: antes subia como 4 KB de HTML dentro del mensaje y
   * acababa pintado encima del grafico del usuario.
   */
  it('un 405 con la pagina del cortafuegos es THROTTLED y el mensaje cabe en una linea', async () => {
    rest.rutas.set('/api/v1/candles', { status: 405, cuerpo: PAGINA_WAF, tipo: 'text/html' });

    const e = (await crear()
      .getCandles('BTC', '4h', { startMs: 0, limit: 2 })
      .catch((err: unknown) => err)) as { kind: string; message: string; raw: unknown };

    expect(e.kind).toBe('THROTTLED');
    expect(e.message.length).toBeLessThan(200);
    expect(e.message).not.toContain('<');
    // El cuerpo entero sigue disponible para el log.
    expect(String(e.raw)).toContain('Human Verification');
  });

  /**
   * Este fallaba en SILENCIO: un 200 con HTML pasaba las dos comprobaciones y
   * se devolvia como si fuera la respuesta pedida. `body.c` salia undefined, la
   * serie quedaba vacia y el grafico en blanco sin un solo error.
   */
  it('un 200 con HTML NO se devuelve como si fuera la respuesta', async () => {
    rest.rutas.set('/api/v1/candles', { status: 200, cuerpo: PAGINA_WAF, tipo: 'text/html' });
    await expect(crear().getCandles('BTC', '4h', { startMs: 0, limit: 2 })).rejects.toThrow();
  });

  it('un rechazo de parametros llega con 200 y su propio codigo', async () => {
    // Lighter responde asi a una resolucion que no sirve, no con un 4xx.
    rest.rutas.set('/api/v1/candles', {
      cuerpo: JSON.stringify({ code: 20001, message: 'invalid param' }),
    });
    await expect(crear().getCandles('BTC', '4h', { startMs: 0, limit: 2 })).rejects.toThrow(
      /invalid param/,
    );
  });

  it('sin credenciales no se firma: el cupo es el de 60 peticiones por minuto', async () => {
    rest.rutas.set('/api/v1/candles', { cuerpo: JSON.stringify({ code: 200, c: [] }) });
    await crear().getCandles('BTC', '4h', { startMs: 0, limit: 2 });
    expect(rest.ultimasCabeceras.authorization).toBeUndefined();
  });

  const catalogo = JSON.stringify({
    order_book_details: [
      {
        symbol: 'BTC',
        market_id: 1,
        market_type: 'perp',
        status: 'active',
        supported_price_decimals: 1,
        supported_size_decimals: 5,
        min_initial_margin_fraction: 200,
        last_trade_price: '77000',
      },
    ],
  });

  /**
   * Spec 001, F-49. La cabecera `authorization` solo se escribia en las
   * llamadas del SDK DESPUES de pedir velas por publicGet, y un adaptador de bot
   * nunca las pide: `account`, `orderBookDetails` y `orderBookOrders` salian
   * sin firmar y gastaban el cupo de IP (60/min para todos los bots de la
   * maquina) en vez del de la cuenta.
   */
  it('las lecturas de cuenta del SDK van con la cabecera authorization', async () => {
    rest.rutas.set('/api/v1/account', {
      cuerpo: JSON.stringify({
        accounts: [{ collateral: '10', available_balance: '10', positions: [] }],
      }),
    });
    adapter = new LighterAdapter({
      venue: 'LIGHTER',
      accountIndex: 0,
      apiKeyIndex: 0,
      apiPrivateKey: '0x01',
      baseUrl: rest.url,
    });
    (adapter as unknown as { authToken(): string }).authToken = () => 'token-de-prueba';

    await adapter.getBalances();

    expect(rest.pedidos.some((p) => p.includes('/api/v1/account'))).toBe(true);
    expect(rest.ultimasCabeceras.authorization).toBe('token-de-prueba');
  });

  /**
   * Spec 001, F-55. `createdAt` era `Date.now()` en cada sondeo: la caducidad
   * por edad de los market makers (`orderMaxAgeSeconds`) nunca disparaba en
   * Lighter porque todas las ordenes parecian recien puestas.
   */
  it('la hora de creacion de una orden viva es la del venue, no la del sondeo', async () => {
    rest.rutas.set('/api/v1/orderBookDetails', { cuerpo: catalogo });
    rest.rutas.set('/api/v1/accountActiveOrders', {
      cuerpo: JSON.stringify({
        orders: [
          {
            order_index: 7,
            client_order_index: 5,
            is_ask: false,
            type: 'limit',
            price: '77000',
            initial_base_amount: '0.001',
            remaining_base_amount: '0.001',
            filled_quote_amount: '0',
            reduce_only: false,
            timestamp: 1_700_000_000,
            created_at: 1_700_000_000,
          },
        ],
      }),
    });
    const a = crear();
    (a as unknown as { authToken(): string }).authToken = () => 'tok';

    const [orden] = await a.getOpenOrders('BTC');

    expect(orden.createdAt).toBe(1_700_000_000_000);
  });

  /**
   * Spec 001, F-05. El SDK declara `Trade.type` (`trade`, `liquidation`,
   * `deleverage`, `market-settlement`) y el adaptador lo ignoraba: una
   * liquidacion llegaba como un fill normal y el bot seguia operando a ciegas.
   */
  it('una ejecucion forzada por el venue llega marcada como liquidacion', async () => {
    rest.rutas.set('/api/v1/orderBookDetails', { cuerpo: catalogo });
    const trade = (type: string, id: number) => ({
      trade_id: id,
      type,
      market_id: 1,
      size: '0.001',
      price: '77000',
      usd_amount: '77',
      ask_id: 1,
      bid_id: 2,
      ask_account_id: 0,
      bid_account_id: 99,
      ask_client_id: 5,
      bid_client_id: 6,
      is_maker_ask: true,
      maker_fee: 0,
      taker_fee: 0,
      timestamp: 1_700_000_000,
    });
    rest.rutas.set('/api/v1/trades', {
      cuerpo: JSON.stringify({ trades: [trade('liquidation', 1), trade('trade', 2)] }),
    });
    const a = crear();
    (a as unknown as { authToken(): string }).authToken = () => 'tok';

    const fills = await a.getRecentFills('BTC', 0);

    expect(fills.find((f) => f.venueFillId === '1')?.liquidation).toBe(true);
    expect(fills.find((f) => f.venueFillId === '2')?.liquidation).toBeUndefined();
  });

  it('el catalogo se pide con filter=perp, para que filtre el venue', async () => {
    rest.rutas.set('/api/v1/candles', { cuerpo: JSON.stringify({ code: 200, c: [] }) });
    await crear().getCandles('BTC', '4h', { startMs: 0, limit: 2 });
    const catalogo = rest.pedidos.find((p) => p.includes('orderBookDetails'));
    expect(catalogo).toContain('filter=perp');
  });

  /**
   * Spec 001, F-10. Sin simbolo eran tantas peticiones FIRMADAS como mercados
   * activos (216 en mainnet) contra un cupo de 60 por minuto: mas de tres
   * minutos del cupo de toda la IP en una sola llamada.
   */
  it('consultar las ordenes abiertas sin simbolo se rechaza', async () => {
    await expect(crear().getOpenOrders()).rejects.toThrow(/símbolo/);
  });
});

describe('Lighter WebSocket — resuscripcion sin rafaga', () => {
  /**
   * Spec 001, F-56. Al reconectar, `onOpen` reenviaba todos los canales de
   * golpe; con mas de ~200 (el adaptador de datos de mercado con muchos
   * graficos) superaba «200 mensajes por minuto» y entraba en bucle 30009 →
   * desconexion → reconexion.
   */
  it('reenvia los primeros cincuenta canales de golpe y espacia el resto', async () => {
    const enviados: string[] = [];
    const esperas: number[] = [];
    const canales = Array.from({ length: 120 }, (_, i) => 'c' + i);

    await resubscribePaced(
      canales,
      (c) => enviados.push(c),
      async (ms) => {
        esperas.push(ms);
      },
    );

    expect(enviados).toEqual(canales);
    expect(esperas).toHaveLength(70);
    // 200 mensajes por minuto son 300 ms entre mensajes: nunca por debajo.
    expect(Math.min(...esperas)).toBeGreaterThanOrEqual(300);
  });
});

describe('Lighter WebSocket — los casos que el venue no deja provocar', () => {
  let wss: WebSocketServer;
  let puerto: number;
  let clientes: WS[] = [];
  let recibidos: string[] = [];
  let adapter: LighterAdapter | null = null;

  beforeEach(async () => {
    clientes = [];
    recibidos = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      clientes.push(ws);
      ws.send(JSON.stringify({ type: 'connected', session_id: 'test' }));
      ws.on('message', (raw) => {
        const texto = String(raw);
        recibidos.push(texto);
        if (texto.includes('"ping"')) ws.send(JSON.stringify({ type: 'pong' }));
      });
    });
    await new Promise<void>((r) => wss.on('listening', r));
    puerto = (wss.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
    await new Promise<void>((r) => wss.close(() => r()));
  });

  const crear = (): LighterAdapter => {
    adapter = new LighterAdapter(
      { venue: 'LIGHTER', accountIndex: 0, apiKeyIndex: 0, apiPrivateKey: '' },
      { wsUrl: 'ws://127.0.0.1:' + puerto },
    );
    return adapter;
  };

  const emitir = (msg: unknown): void => {
    for (const c of clientes) c.send(JSON.stringify(msg));
  };

  /** Una tabla de `market_stats` con la forma que manda el venue. */
  const stats = (filas: [number, string, string][]): Record<string, unknown> =>
    Object.fromEntries(
      filas.map(([id, symbol, precio]) => [
        String(id),
        {
          symbol,
          market_id: id,
          last_trade_price: precio,
          mark_price: precio,
          best_bid_price: precio,
          best_ask_price: precio,
          daily_price_change: 1,
          daily_price_high: 1,
          daily_price_low: 1,
          daily_quote_token_volume: 1,
        },
      ]),
    );

  const sembrar = async (filas: [number, string, string][]): Promise<void> => {
    emitir({
      type: 'subscribed/market_stats',
      channel: 'market_stats:all',
      market_stats: stats(filas),
    });
    await ESPERA(250);
  };

  /**
   * El fallo que habria borrado 900 pares en cada actualizacion. Medido contra
   * el venue: la primera foto trajo 67 mercados y la siguiente UNO.
   */
  it('una actualizacion parcial de market_stats se FUSIONA, no reemplaza', async () => {
    const a = crear();
    a.streamTicker('BTC').subscribe(() => undefined);
    await ESPERA(250);
    await sembrar([
      [1, 'BTC', '77000'],
      [2, 'SOL', '94'],
      [3, 'DOGE', '0.09'],
    ]);
    expect(await a.getTickers()).toHaveLength(3);

    // Llega SOLO uno, como hace el venue de verdad.
    emitir({
      type: 'update/market_stats',
      channel: 'market_stats:all',
      market_stats: stats([[2, 'SOL', '95']]),
    });
    await ESPERA(200);

    const tras = await a.getTickers();
    expect(tras).toHaveLength(3);
    expect(tras.find((t) => t.symbol === 'SOL')?.last).toBe('95');
    // Y los otros dos siguen con su precio, no borrados.
    expect(tras.find((t) => t.symbol === 'BTC')?.last).toBe('77000');
  });

  /**
   * La averia mas dificil de ver de todas: el socket vuelve, la salud dice UP y
   * no llega un solo dato porque nadie volvio a pedir los canales.
   */
  it('al reconectar se vuelven a pedir TODOS los canales', async () => {
    const a = crear();
    a.streamTicker('BTC').subscribe(() => undefined);
    a.streamCandles('BTC', '1m').subscribe(() => undefined);
    await ESPERA(250);
    await sembrar([[1, 'BTC', '77000']]);

    expect(recibidos.filter((r) => r.includes('"subscribe"')).length).toBeGreaterThanOrEqual(3);

    // Corte por sorpresa, como un despliegue del venue.
    recibidos = [];
    for (const c of clientes) c.terminate();
    await ESPERA(3000);

    const repedidos = recibidos.filter((r) => r.includes('"subscribe"'));
    expect(repedidos.some((r) => r.includes('market_stats/all'))).toBe(true);
    expect(repedidos.some((r) => r.includes('ticker/1'))).toBe(true);
    expect(repedidos.some((r) => r.includes('candle/1/1m'))).toBe(true);
  }, 20000);

  it('las velas llegan al suscriptor: snapshot y actualizacion por igual', async () => {
    const a = crear();
    const velas: { c: string; v: string | null }[] = [];
    a.streamCandles('BTC', '1m').subscribe((c) => velas.push(c));
    await ESPERA(250);
    await sembrar([[1, 'BTC', '77000']]);

    // Las dos formas traen el mismo `candles`: por eso se enruta por canal y no
    // por tipo de mensaje.
    emitir({
      type: 'subscribed/candle',
      channel: 'candle:1:1m',
      candles: [{ t: 1787490300000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }],
    });
    emitir({
      type: 'update/candle',
      channel: 'candle:1:1m',
      candles: [{ t: 1787490300000, o: 1, h: 2, l: 0.5, c: 1.7, v: 12 }],
    });
    await ESPERA(250);

    expect(velas).toHaveLength(2);
    expect(velas[1]).toMatchObject({ c: '1.7', v: '12' });
  });

  it('soltar el ULTIMO suscriptor da de baja el canal en el venue', async () => {
    const a = crear();
    const uno = a.streamCandles('BTC', '1m').subscribe(() => undefined);
    const dos = a.streamCandles('BTC', '1m').subscribe(() => undefined);
    await ESPERA(250);
    await sembrar([[1, 'BTC', '77000']]);

    uno.unsubscribe();
    await ESPERA(200);
    // Todavia queda `dos`: no se da de baja nada.
    expect(recibidos.some((r) => r.includes('"unsubscribe"'))).toBe(false);

    dos.unsubscribe();
    await ESPERA(200);
    expect(recibidos.some((r) => r.includes('"unsubscribe"') && r.includes('candle/1/1m'))).toBe(
      true,
    );
  });

  /** El venue manda los errores SIN campo `type`. Un enrutador por `type` los tira. */
  it('un error del venue se anuncia por salud y no tumba los demas canales', async () => {
    const a = crear();
    const salud: { status: string; detail?: string }[] = [];
    a.streamHealth().subscribe((h) => salud.push(h));
    const velas: unknown[] = [];
    a.streamCandles('BTC', '1m').subscribe((c) => velas.push(c));
    await ESPERA(250);
    await sembrar([[1, 'BTC', '77000']]);

    emitir({ error: { code: 30005, message: 'Invalid Channel:  (invalid resolution)' } });
    await ESPERA(200);
    expect(salud.some((h) => h.status === 'DOWN' && h.detail?.includes('Invalid Channel'))).toBe(
      true,
    );

    // Y el canal bueno sigue entregando.
    emitir({
      type: 'update/candle',
      channel: 'candle:1:1m',
      candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
    });
    await ESPERA(200);
    expect(velas.length).toBeGreaterThan(0);
  });

  /**
   * El ticker combina DOS canales porque ninguno basta solo: `ticker/{id}` trae
   * la mejor oferta y demanda, y `market_stats` el ultimo negociado.
   */
  it('el ticker combina el libro con las estadisticas del mercado', async () => {
    const a = crear();
    const ticks: { last: string; bid: string; ask: string; mark: string }[] = [];
    a.streamTicker('BTC').subscribe((t) => ticks.push(t));
    await ESPERA(250);
    await sembrar([[1, 'BTC', '77000']]);

    emitir({
      type: 'update/ticker',
      channel: 'ticker:1',
      ticker: { s: 'BTC', a: { price: '77010' }, b: { price: '77008' } },
    });
    await ESPERA(200);

    expect(ticks).toHaveLength(1);
    // Oferta y demanda del libro...
    expect(ticks[0]).toMatchObject({ bid: '77008', ask: '77010' });
    // ...y el ultimo negociado y la marca, de las estadisticas.
    expect(ticks[0]).toMatchObject({ last: '77000', mark: '77000' });
  });

  it('el stream resuelve el market_id SIN tocar el REST', async () => {
    // Es lo que hace que el WebSocket funcione con el catalogo bloqueado por el
    // cortafuegos, que es exactamente la situacion del incidente: este
    // adaptador no tiene `baseUrl`, asi que cualquier llamada REST fallaria.
    const a = crear();
    const velas: unknown[] = [];
    a.streamCandles('BTC', '1m').subscribe((c) => velas.push(c));
    await ESPERA(250);
    await sembrar([[1, 'BTC', '77000']]);

    emitir({
      type: 'update/candle',
      channel: 'candle:1:1m',
      candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
    });
    await ESPERA(200);
    expect(velas).toHaveLength(1);
  });
});

/**
 * El canal de cuenta de Lighter (spec 036).
 *
 * F-54 decia «Lighter no tiene stream de cuenta» y era falso: lo tiene
 * documentado y no se usaba. En su lugar se sondeaba cada doce segundos pidiendo
 * `trades`, que pesa 600, lo que dejaba la capacidad en un bot por IP y daba
 * hasta doce segundos de retraso a cada ejecucion.
 *
 * Estos casos son los que el venue no deja provocar: se levanta un servidor
 * WebSocket local y se le manda la forma que documenta Lighter.
 */
describe('Lighter — el canal de cuenta', () => {
  let wss: WebSocketServer;
  let puerto: number;
  let clientes: WS[] = [];
  let recibidos: string[] = [];
  let adapter: LighterAdapter | null = null;

  const CUENTA = 7;

  beforeEach(async () => {
    clientes = [];
    recibidos = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      clientes.push(ws);
      ws.send(JSON.stringify({ type: 'connected', session_id: 'test' }));
      ws.on('message', (raw) => {
        const texto = String(raw);
        recibidos.push(texto);
        if (texto.includes('"ping"')) ws.send(JSON.stringify({ type: 'pong' }));
      });
    });
    await new Promise<void>((r) => wss.on('listening', r));
    puerto = (wss.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
    await new Promise<void>((r) => wss.close(() => r()));
  });

  const crear = (): LighterAdapter => {
    adapter = new LighterAdapter(
      { venue: 'LIGHTER', accountIndex: CUENTA, apiKeyIndex: 0, apiPrivateKey: '' },
      { wsUrl: 'ws://127.0.0.1:' + puerto },
    );
    return adapter;
  };

  const emitir = (msg: unknown): void => {
    for (const c of clientes) c.send(JSON.stringify(msg));
  };

  /**
   * La tabla de mercados, para que `market_id` se pueda traducir a simbolo.
   *
   * Hace falta pedir el ticker antes: `market_stats/all` solo se suscribe
   * cuando alguien quiere precios, y sin esa tabla el adaptador no sabe que el
   * mercado 1 es BTC — asi que descartaria la ejecucion en vez de inventarse un
   * simbolo, que es lo correcto.
   */
  const sembrarMercados = async (a: LighterAdapter): Promise<void> => {
    a.streamTicker('BTC').subscribe(() => undefined);
    await ESPERA(200);
    emitir({
      type: 'subscribed/market_stats',
      channel: 'market_stats:all',
      market_stats: {
        '1': {
          symbol: 'BTC',
          market_id: 1,
          last_trade_price: '77000',
          mark_price: '77000',
          best_bid_price: '76999',
          best_ask_price: '77001',
          daily_price_change: 1,
          daily_price_high: 1,
          daily_price_low: 1,
          daily_quote_token_volume: 1,
        },
      },
    });
    await ESPERA(250);
  };

  /** Una ejecucion nuestra como COMPRADOR, con la forma que documenta el venue. */
  const ejecucion = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    trade_id: 900001,
    market_id: 1,
    type: 'trade',
    ask_account_id: 999,
    bid_account_id: CUENTA,
    ask_id: 11,
    bid_id: 22,
    ask_client_id: 111,
    bid_client_id: 222,
    is_maker_ask: false,
    price: '77000',
    size: '0.01',
    maker_fee: 1500,
    taker_fee: 3000,
    timestamp: 1_700_000_000,
    ...over,
  });

  it('pide el canal de cuenta con el indice de la cuenta', async () => {
    const a = crear();
    a.streamFills().subscribe(() => undefined);
    await ESPERA(300);

    expect(recibidos.join(' ')).toContain('account_all/' + CUENTA);
  });

  /**
   * Y NO pide el de ordenes, que es una decision y no un olvido: empujarlas
   * exigiria un mapeo de estados que hoy no existe —`toVenueOrder` se escribio
   * para el listado de ordenes ACTIVAS y solo sabe decir OPEN—, asi que una
   * cancelacion empujada resucitaria la orden en la base. Las ordenes siguen
   * llegando por el sondeo, que es barato; lo caro era `trades`, de peso 600.
   */
  it('no pide el canal de ordenes: su mapeo de estados no existe todavia', async () => {
    const a = crear();
    a.streamFills().subscribe(() => undefined);
    await ESPERA(300);

    expect(recibidos.join(' ')).not.toContain('account_all_orders/');
  });

  it('una ejecucion del canal llega como Fill, con sus campos', async () => {
    const a = crear();
    const vistos: Fill[] = [];
    a.streamFills().subscribe((f) => vistos.push(f));
    await ESPERA(300);
    await sembrarMercados(a);

    emitir({
      type: 'update/account_all',
      channel: 'account_all:' + CUENTA,
      trades: [ejecucion()],
    });
    await ESPERA(250);

    expect(vistos).toHaveLength(1);
    expect(vistos[0]).toMatchObject({
      venue: 'LIGHTER',
      symbol: 'BTC',
      venueFillId: '900001',
      side: 'BUY',
      price: '77000',
      qty: '0.01',
      // `is_maker_ask: false` y nosotros somos el bid: el maker somos NOSOTROS,
      // asi que la comision que cuenta es la de maker.
      isTaker: false,
    });
    // Los timestamps de Lighter vienen en segundos y el motor los quiere en ms.
    expect(vistos[0].ts).toBe(1_700_000_000_000);
  });

  it('la misma ejecucion dos veces se emite UNA', async () => {
    const a = crear();
    const vistos: Fill[] = [];
    a.streamFills().subscribe((f) => vistos.push(f));
    await ESPERA(300);
    await sembrarMercados(a);

    const msg = {
      type: 'update/account_all',
      channel: 'account_all:' + CUENTA,
      trades: [ejecucion()],
    };
    emitir(msg);
    await ESPERA(150);
    emitir(msg);
    await ESPERA(250);

    // El ledger deduplica por (orden, id), pero emitir dos veces mueve el reloj
    // de `lastFillTs` y ensucia la bitacora.
    expect(vistos).toHaveLength(1);
  });

  it('acepta las ejecuciones agrupadas por mercado, no solo en lista', async () => {
    const a = crear();
    const vistos: Fill[] = [];
    a.streamFills().subscribe((f) => vistos.push(f));
    await ESPERA(300);
    await sembrarMercados(a);

    emitir({
      type: 'update/account_all',
      channel: 'account_all:' + CUENTA,
      trades: { '1': [ejecucion({ trade_id: 900002 })] },
    });
    await ESPERA(250);

    expect(vistos).toHaveLength(1);
    expect(vistos[0].venueFillId).toBe('900002');
  });

  /**
   * La regla que gobierna el spec 036: lo que no se reconoce no cuenta. La forma
   * del mensaje viene de la documentacion, no de una conexion autenticada, asi
   * que si el venue manda otra cosa el bot tiene que quedarse como estaba —
   * sondeando— y no inventarse una ejecucion.
   */
  it('un mensaje con una forma desconocida no produce ninguna ejecucion', async () => {
    const a = crear();
    const vistos: Fill[] = [];
    a.streamFills().subscribe((f) => vistos.push(f));
    await ESPERA(300);
    await sembrarMercados(a);

    emitir({ type: 'subscribed/account_all', channel: 'account_all:' + CUENTA });
    emitir({ type: 'update/account_all', channel: 'account_all:' + CUENTA, positions: [] });
    emitir({
      type: 'update/account_all',
      channel: 'account_all:' + CUENTA,
      trades: [{ lo_que_sea: 1 }],
    });
    await ESPERA(250);

    expect(vistos).toHaveLength(0);
  });

  it('una ejecucion de OTRA cuenta se descarta', async () => {
    const a = crear();
    const vistos: Fill[] = [];
    a.streamFills().subscribe((f) => vistos.push(f));
    await ESPERA(300);
    await sembrarMercados(a);

    emitir({
      type: 'update/account_all',
      channel: 'account_all:' + CUENTA,
      trades: [ejecucion({ bid_account_id: 4242, ask_account_id: 4343 })],
    });
    await ESPERA(250);

    expect(vistos).toHaveLength(0);
  });

  it('al reconectar se vuelve a pedir el canal de cuenta', async () => {
    const a = crear();
    a.streamFills().subscribe(() => undefined);
    await ESPERA(300);

    recibidos = [];
    for (const c of clientes) c.terminate();
    await ESPERA(1500);

    // Sin esto el socket vuelve abierto y mudo, que es la averia mas dificil de
    // ver: la salud dice arriba y no llega un solo dato.
    expect(recibidos.join(' ')).toContain('account_all/' + CUENTA);
  });
});

describe('Lighter — la salud del canal de cuenta manda sobre el sondeo', () => {
  let wss: WebSocketServer;
  let puerto: number;
  let clientes: WS[] = [];
  let adapter: LighterAdapter | null = null;
  const CUENTA = 7;

  beforeEach(async () => {
    clientes = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      clientes.push(ws);
      ws.send(JSON.stringify({ type: 'connected', session_id: 'test' }));
      ws.on('message', (raw) => {
        if (String(raw).includes('"ping"')) ws.send(JSON.stringify({ type: 'pong' }));
      });
    });
    await new Promise<void>((r) => wss.on('listening', r));
    puerto = (wss.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
    await new Promise<void>((r) => wss.close(() => r()));
  });

  /**
   * La salud de CUENTA es la que decide si se sondea, y es distinta de la de
   * precios. Mezclarlas es lo que dejó a un bot sin ver sus ejecuciones: el
   * gráfico entregaba, el adaptador daba el stream por bueno y las órdenes
   * dejaban de mirarse.
   */
  it('una ejecucion del canal anuncia los fills ARRIBA', async () => {
    adapter = new LighterAdapter(
      { venue: 'LIGHTER', accountIndex: CUENTA, apiKeyIndex: 0, apiPrivateKey: '' },
      { wsUrl: 'ws://127.0.0.1:' + puerto },
    );
    const salud: string[] = [];
    adapter.streamHealth().subscribe((h) => salud.push(h.stream + ':' + h.status));
    adapter.streamFills().subscribe(() => undefined);
    adapter.streamTicker('BTC').subscribe(() => undefined);
    await ESPERA(300);

    for (const c of clientes) {
      c.send(
        JSON.stringify({
          type: 'subscribed/market_stats',
          channel: 'market_stats:all',
          market_stats: {
            '1': {
              symbol: 'BTC',
              market_id: 1,
              last_trade_price: '77000',
              mark_price: '77000',
              best_bid_price: '76999',
              best_ask_price: '77001',
              daily_price_change: 1,
              daily_price_high: 1,
              daily_price_low: 1,
              daily_quote_token_volume: 1,
            },
          },
        }),
      );
    }
    await ESPERA(200);

    for (const c of clientes) {
      c.send(
        JSON.stringify({
          type: 'update/account_all',
          channel: 'account_all:' + CUENTA,
          trades: [
            {
              trade_id: 1,
              market_id: 1,
              type: 'trade',
              ask_account_id: 999,
              bid_account_id: CUENTA,
              ask_id: 1,
              bid_id: 2,
              ask_client_id: 3,
              bid_client_id: 4,
              is_maker_ask: false,
              price: '77000',
              size: '0.01',
              maker_fee: 0,
              taker_fee: 0,
              timestamp: 1_700_000_000,
            },
          ],
        }),
      );
    }
    await ESPERA(250);

    expect(salud).toContain('fills:UP');
    // Y NO las ordenes: ese canal no se usa, asi que su salud sigue siendo la
    // del sondeo. Anunciarlas arriba apagaria un sondeo que sigue haciendo falta.
    expect(salud).not.toContain('orders:UP');
  });
});
