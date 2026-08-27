import { PriceSource, SourceMarketType } from '@crypton/shared';
import { PriceSourceService, type FairPriceRequest } from './price-source.service';

/**
 * El primer test del repo que simula `fetch`.
 *
 * Hasta ahora la capa HTTP de la fuente externa no la recorría NADIE: lo que se
 * probaba era la lógica pura a cada lado del hueco —el mapeo de símbolos en
 * `shared`, `resolveAnchor` en `strategy-core`— y la ausencia de feed en el
 * runner. El camino en el que Binance responde, o responde mal, no lo ejecutaba
 * ningún test, y ahí es justo donde vive lo que le cuesta dinero al usuario: un
 * bloqueo por territorio que deja al bot mudo sin decir por qué.
 *
 * Se usan temporizadores falsos porque todo lo interesante de este servicio son
 * decisiones sobre CUÁNDO volver a preguntar.
 */

const PERP: FairPriceRequest = {
  source: PriceSource.BINANCE,
  marketType: SourceMarketType.PERP,
  base: 'BTC',
};

/** Respuesta correcta con el libro que se le pida. */
const book = (bid: string, ask: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ bidPrice: bid, askPrice: ask }),
});

/** Respuesta de error: `ok` en false es lo único que mira `getJson`. */
const httpError = (status: number) => ({ ok: false, status, json: async () => ({}) });

describe('PriceSourceService', () => {
  let svc: PriceSourceService;
  let fetchMock: jest.Mock;
  let cacheSet: jest.Mock;
  let cacheGet: jest.Mock;
  let urls: string[];

  beforeEach(() => {
    jest.useFakeTimers();
    urls = [];
    fetchMock = jest.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(book('100', '102'));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    cacheSet = jest.fn().mockResolvedValue(undefined);
    cacheGet = jest.fn().mockResolvedValue(null);
    const bus = { cacheSet, cacheGet };
    // `get` devuelve undefined: se ejercitan los valores por defecto, que son los
    // que corren en cualquier despliegue que no toque el `.env`.
    const config = { get: () => undefined };

    svc = new PriceSourceService(bus as never, config as never);
  });

  afterEach(() => {
    svc.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Deja que el sondeo en vuelo termine sin mover el reloj. */
  const settle = async () => {
    await jest.advanceTimersByTimeAsync(0);
  };

  describe('las tres rutas de Binance', () => {
    it('PERP toma el mid del libro de futuros', async () => {
      const key = svc.acquire(PERP)!;
      await settle();

      expect(urls[0]).toBe('https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT');
      // Mid y no último negociado: el último trade puede estar en cualquiera de
      // los dos lados del diferencial y sesgaría la referencia.
      expect(svc.peek(key)?.price).toBe('101');
    });

    it('SPOT va al REST de contado', async () => {
      svc.acquire({ ...PERP, marketType: SourceMarketType.SPOT });
      await settle();

      expect(urls[0]).toBe('https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT');
    });

    it('INDEX toma el precio de índice, con el de marca como respaldo', async () => {
      fetchMock.mockImplementation((url: string) => {
        urls.push(url);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ markPrice: '55' }) });
      });

      const key = svc.acquire({ ...PERP, marketType: SourceMarketType.INDEX })!;
      await settle();

      expect(urls[0]).toBe('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
      expect(svc.peek(key)?.price).toBe('55');
    });

    it('el símbolo alternativo manda sobre el mapeo automático', async () => {
      // Es el mecanismo que resuelve los pares que en Binance se llaman distinto:
      // `kPEPE` del venue es `1000PEPEUSDT` allí.
      svc.acquire({ ...PERP, base: 'kPEPE', override: '1000PEPEUSDT' });
      await settle();

      expect(urls[0]).toContain('symbol=1000PEPEUSDT');
    });

    it('un libro vacío no se toma por precio', async () => {
      fetchMock.mockResolvedValue(book('0', '0'));
      const key = svc.acquire(PERP)!;
      await settle();

      // Cero no es un precio: cotizar contra él sería regalar el inventario.
      expect(svc.peek(key)).toBeNull();
      expect(svc.status(key)?.cause).toBe('OTHER');
    });
  });

  describe('contador de referencias', () => {
    it('dos bots con la misma petición comparten un solo sondeo', async () => {
      const a = svc.acquire(PERP)!;
      const b = svc.acquire(PERP)!;
      await settle();

      expect(a).toBe(b);
      // Un solo sondeo inicial, no dos: es el punto de compartir el feed.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('soltar uno no le corta el precio al otro; soltar los dos cierra el feed', async () => {
      const key = svc.acquire(PERP)!;
      svc.acquire(PERP);
      await settle();

      svc.release(key);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(svc.peek(key)).not.toBeNull();

      svc.release(key);
      await jest.advanceTimersByTimeAsync(10_000);
      // Ya no hay temporizador: sin esto, un bot parado dejaría el sondeo vivo
      // para siempre.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(svc.peek(key)).toBeNull();
    });
  });

  describe('retroceso ante bloqueo y caudal', () => {
    it('un 451 se marca como bloqueo por territorio y espacia el sondeo', async () => {
      fetchMock.mockResolvedValue(httpError(451));
      const key = svc.acquire(PERP)!;
      await settle();

      // 451 es literalmente «no disponible por razones legales». Reintentarlo
      // cada dos segundos no lo arregla nunca.
      expect(svc.status(key)).toEqual({ cause: 'GEO', failures: 1, pollMs: 4_000 });

      // Y con el ritmo nuevo: a los 2 s todavía no toca.
      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(svc.status(key)?.pollMs).toBe(8_000);
    });

    it('un 429 retrocede y vuelve al ritmo normal en cuanto responde', async () => {
      fetchMock.mockResolvedValue(httpError(429));
      const key = svc.acquire(PERP)!;
      await settle();

      expect(svc.status(key)?.cause).toBe('THROTTLED');
      expect(svc.status(key)?.pollMs).toBe(4_000);

      // El baneo se levanta.
      fetchMock.mockResolvedValue(book('200', '202'));
      await jest.advanceTimersByTimeAsync(4_000);

      // Un retroceso que no se deshace convertiría un corte de treinta segundos
      // en cinco minutos sin cotizar.
      expect(svc.status(key)).toBeNull();
      expect(svc.peek(key)?.price).toBe('201');

      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('el retroceso tiene tope', async () => {
      fetchMock.mockResolvedValue(httpError(451));
      const key = svc.acquire(PERP)!;
      await settle();

      // Ocho fallos seguidos: 2 s · 2^8 son 512 s, por encima del tope de 300 s.
      for (let i = 0; i < 8; i++) {
        await jest.advanceTimersByTimeAsync(svc.status(key)!.pollMs);
      }
      expect(svc.status(key)!.pollMs).toBe(300_000);
    });

    it('un fallo de red NO retrocede: espaciarlo solo alargaría el hueco', async () => {
      fetchMock.mockRejectedValue(new Error('socket hang up'));
      const key = svc.acquire(PERP)!;
      await settle();

      // Nadie al otro lado está contando nuestras peticiones, así que reintentar
      // al ritmo normal es lo correcto.
      expect(svc.status(key)).toEqual({ cause: 'OTHER', failures: 1, pollMs: 2_000 });

      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('soltar el feed con un sondeo en vuelo NO deja un temporizador huérfano', async () => {
      // La carrera: `poll` está esperando a la red, `release` limpia el
      // temporizador y borra la entrada, y entonces el `catch` de aquel sondeo
      // llama a `reschedule`, que crearía un `setInterval` sobre un feed que ya
      // no existe. Nadie volvería a cancelarlo.
      let rechazar: ((e: Error) => void) | null = null;
      fetchMock.mockImplementation(
        () =>
          new Promise((_r, rej) => {
            rechazar = rej;
          }),
      );

      const key = svc.acquire(PERP)!;
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Se suelta mientras la petición sigue en vuelo, y solo entonces falla.
      svc.release(key);
      rechazar!(new Error('HTTP 451'));
      await settle();

      // Si hubiera quedado un temporizador vivo, esto dispararía más sondeos.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('un 500 tampoco retrocede', async () => {
      fetchMock.mockResolvedValue(httpError(500));
      const key = svc.acquire(PERP)!;
      await settle();

      expect(svc.status(key)?.cause).toBe('OTHER');
      expect(svc.status(key)?.pollMs).toBe(2_000);
    });
  });

  describe('detalles que ya estaban y conviene fijar', () => {
    it('un sondeo que tarda más que el intervalo no acumula peticiones', async () => {
      let resolver: ((v: unknown) => void) | null = null;
      fetchMock.mockImplementation(
        () =>
          new Promise((r) => {
            resolver = r;
          }),
      );

      svc.acquire(PERP);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Tres intervalos con la primera petición todavía en vuelo.
      await jest.advanceTimersByTimeAsync(6_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      resolver!(book('100', '102'));
      await settle();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('publica el precio para las demás réplicas', async () => {
      const key = svc.acquire(PERP)!;
      await settle();

      expect(cacheSet).toHaveBeenCalledWith(
        'crypton:fx:' + key.toLowerCase(),
        { price: '101', ts: expect.any(Number) },
        30,
      );
    });

    it('arranca con el precio que dejó otra réplica', async () => {
      // El hueco que cierra: un bot que cambia de worker no cotiza hasta que
      // llega la primera respuesta. Con la semilla cotiza desde el primer tick.
      cacheGet.mockResolvedValue({ price: '999', ts: 111 });
      fetchMock.mockImplementation(() => new Promise(() => undefined)); // nunca responde

      const key = svc.acquire(PERP)!;
      await settle();

      expect(svc.peek(key)).toEqual({ price: '999', ts: 111 });
    });

    it('la semilla nunca pisa un precio propio', async () => {
      // El sondeo inmediato y la lectura de Redis corren a la vez; si gana el
      // sondeo, el suyo es más nuevo por definición.
      cacheGet.mockResolvedValue({ price: '999', ts: 111 });
      const key = svc.acquire(PERP)!;
      await settle();

      expect(svc.peek(key)?.price).toBe('101');
    });

    it('Redis caído no impide abrir el feed', async () => {
      cacheGet.mockRejectedValue(new Error('sin conexión'));
      const key = svc.acquire(PERP)!;
      await settle();

      expect(svc.peek(key)?.price).toBe('101');
    });

    it('una fuente sin símbolo resoluble no abre feed', () => {
      // Una fuente retirada que siguiera guardada en un bot antiguo. Caer a otra
      // por nuestra cuenta sería cambiarle el precio contra el que opera.
      const key = svc.acquire({ ...PERP, source: 'COINGECKO' as never });
      expect(key).toBeNull();
    });

    it('EXCHANGE no es una fuente externa', () => {
      expect(svc.acquire({ ...PERP, source: PriceSource.EXCHANGE })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
