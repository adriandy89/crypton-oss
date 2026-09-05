import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignerClient } from 'zklighter-sdk';
import { LighterAdapter } from './adapters/lighter';

/**
 * Spec 001 — tests de confirmación de la firma de Lighter (F-46 y F-01).
 *
 * El firmante nativo (koffi) se sustituye por un doble inyectado en el campo
 * privado `signingClient`, igual que hace el propio adaptador con
 * `nonce_manager`: es la única forma de ver QUÉ se firma sin cargar la
 * librería nativa ni tocar la red. El catálogo se sirve desde un servidor HTTP
 * local, como en `lighter-transport.spec.ts`.
 *
 * Están en ROJO a propósito: confirman dos hallazgos. Cuando lleguen las
 * correcciones aprobadas, pasan sin tocarlos.
 */

/** Respuesta canónica del SDK 1.3.0: una TUPLA `[tx, respuesta, error]`, nunca una excepción. */
type Tupla = [unknown, unknown, string | null];
const OK: Tupla = [{}, { code: 200 }, null];

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

class ServidorRest {
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const ruta = (req.url ?? '').split('?')[0];
      if (ruta !== '/api/v1/orderBookDetails') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(CATALOGO);
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

function firmanteFalso() {
  return {
    nonce_manager: {
      initialize: jest.fn(async (): Promise<void> => undefined),
      hard_refresh_nonce: jest.fn(async (_apiKeyIndex: number): Promise<void> => undefined),
    },
    create_order: jest.fn(async (..._args: unknown[]): Promise<Tupla> => OK),
    create_market_order: jest.fn(async (..._args: unknown[]): Promise<Tupla> => OK),
    check_client: (): string | null => null,
    close: async (): Promise<void> => undefined,
  };
}

describe('Lighter — lo que se firma en placeOrder', () => {
  let rest: ServidorRest;
  let adapter: LighterAdapter | null = null;

  beforeEach(async () => {
    rest = new ServidorRest();
    await rest.escuchar();
  });

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
    await rest.cerrar();
  });

  const crear = () => {
    adapter = new LighterAdapter({
      venue: 'LIGHTER',
      accountIndex: 0,
      apiKeyIndex: 4,
      apiPrivateKey: '',
      baseUrl: rest.url,
    });
    const firmante = firmanteFalso();
    (adapter as unknown as { signingClient: unknown }).signingClient = firmante;
    return { adapter, firmante };
  };

  /**
   * F-46. El stop que inyecta el motor es `type: 'MARKET'` con `triggerPrice`
   * (`stop-loss.ts:63-67`). `placeOrder` mira el tipo antes que el disparador
   * (`lighter.ts:1097`) y llama a `create_market_order`, que el SDK expande
   * SIN trigger: sale una IOC inmediata con tope = precio del stop, y para una
   * venta reduce-only con tope por debajo del bid el secuenciador ejecuta al
   * instante. La «protección» cierra la posición nada más colocarse.
   */
  it('el stop inyectado (MARKET + triggerPrice) no sale como orden a mercado inmediata', async () => {
    const { adapter, firmante } = crear();

    await adapter.placeOrder({
      symbol: 'BTC',
      side: 'SELL',
      type: 'MARKET',
      price: '76000',
      triggerPrice: '76000',
      qty: '0.001',
      clientOrderId: 'a1b2c3d4e5f60718.1.SL0',
      reduceOnly: true,
      intent: 'SL',
    });

    expect(firmante.create_market_order).not.toHaveBeenCalled();
    expect(firmante.create_order).toHaveBeenCalledTimes(1);
    const args = firmante.create_order.mock.calls[0];
    // market_id 1 · base 100 (0.001 × 10^5) · is_ask · tipo de stop · reduce_only · trigger 760000 (76000 × 10^1)
    expect(args[0]).toBe(1);
    expect(args[2]).toBe(100);
    expect(args[4]).toBe(true);
    expect([SignerClient.ORDER_TYPE_STOP_LOSS, SignerClient.ORDER_TYPE_STOP_LOSS_LIMIT]).toContain(
      args[5],
    );
    expect(args[7]).toBe(true);
    expect(args[8]).toBe(760000);
  });

  /**
   * F-01. Ante un 400 «invalid nonce», el SDK 1.3.0 no lanza: compara
   * `error.message` («Request failed with status code 400») con «invalid
   * nonce», no casa, decrementa el contador y DEVUELVE `[null, null, 'invalid
   * nonce']`. El `catch` de `signedWrite` nunca ve nada y `hard_refresh_nonce`
   * no se llama: a partir de ahí toda escritura repite el mismo nonce malo.
   */
  it('un «invalid nonce» devuelto en la tupla relee el nonce y reintenta una vez', async () => {
    const { adapter, firmante } = crear();
    firmante.create_order
      .mockResolvedValueOnce([null, null, 'invalid nonce'])
      .mockResolvedValueOnce(OK);

    const ack = await adapter.placeOrder({
      symbol: 'BTC',
      side: 'BUY',
      type: 'LIMIT',
      price: '76000',
      qty: '0.001',
      clientOrderId: 'a1b2c3d4e5f60718.1.B0',
      reduceOnly: false,
    });

    expect(firmante.nonce_manager.hard_refresh_nonce).toHaveBeenCalledTimes(1);
    expect(firmante.create_order).toHaveBeenCalledTimes(2);
    expect(ack.status).toBe('PENDING');
  });
});
