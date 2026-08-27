import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WS } from 'ws';
import { LighterAdapter } from './adapters/lighter';

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

  it('el catalogo se pide con filter=perp, para que filtre el venue', async () => {
    rest.rutas.set('/api/v1/candles', { cuerpo: JSON.stringify({ code: 200, c: [] }) });
    await crear().getCandles('BTC', '4h', { startMs: 0, limit: 2 });
    const catalogo = rest.pedidos.find((p) => p.includes('orderBookDetails'));
    expect(catalogo).toContain('filter=perp');
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
    expect(
      recibidos.some((r) => r.includes('"unsubscribe"') && r.includes('candle/1/1m')),
    ).toBe(true);
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
