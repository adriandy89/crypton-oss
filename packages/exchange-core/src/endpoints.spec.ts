import { Venue } from '@crypton/shared';
import { AsterAdapter } from './adapters/aster';
import { LighterAdapter } from './adapters/lighter';
import { venueKey } from '@crypton/shared';
import { VENUE_ENDPOINTS, endpointsFor } from './endpoints';
import { createAdapter, createPublicAdapter, normalizeOptions } from './factory';

/**
 * Lo que se comprueba aquí no es que las URLs sean alcanzables —eso lo dice la
 * red, no un test— sino que la red PEDIDA es la red USADA. Los tres fallos que
 * este archivo tapa son silenciosos: ninguno da error, todos operan contra el
 * libro equivocado.
 */
describe('endpoints por venue y red', () => {
  it('da URLs distintas para mainnet y testnet en los tres venues', () => {
    for (const venue of Object.values(Venue)) {
      const main = endpointsFor(venue, false);
      const test = endpointsFor(venue, true);
      expect(main.rest).not.toBe(test.rest);
      expect(main.ws).not.toBe(test.ws);
    }
  });

  it('mantiene los hosts de mainnet que ya estaban en uso', () => {
    // Una errata aquí manda a producción contra otro host sin que nada chille.
    expect(VENUE_ENDPOINTS.LIGHTER.mainnet.rest).toBe('https://mainnet.zklighter.elliot.ai');
    expect(VENUE_ENDPOINTS.LIGHTER.mainnet.ws).toBe('wss://mainnet.zklighter.elliot.ai/stream');
    expect(VENUE_ENDPOINTS.ASTER.mainnet.rest).toBe('https://fapi.asterdex.com');
    expect(VENUE_ENDPOINTS.ASTER.mainnet.ws).toBe('wss://fstream.asterdex.com');
  });

  /**
   * El SDK de Lighter deduce el `chain_id` de firma de la propia URL
   * (`url.includes("mainnet") ? 304 : 300`). Si alguien renombrara el host de
   * mainnet a algo sin esa palabra, TODAS las órdenes se firmarían con el
   * chain_id de testnet y el venue las rechazaría sin explicar por qué.
   */
  it('deja que el SDK de Lighter deduzca bien el chain_id desde la URL', () => {
    expect(VENUE_ENDPOINTS.LIGHTER.mainnet.rest).toContain('mainnet');
    expect(VENUE_ENDPOINTS.LIGHTER.testnet.rest).not.toContain('mainnet');
  });
});

describe('la red elegida llega al adaptador', () => {
  const lighterCreds = {
    venue: 'LIGHTER' as const,
    accountIndex: 1,
    apiKeyIndex: 4,
    apiPrivateKey: '',
  };
  const asterCreds = {
    venue: 'ASTER' as const,
    userAddress: '',
    signerAddress: '',
    signerPrivateKey: '',
  };

  it('Lighter apunta REST y WS a la red pedida', () => {
    const test = new LighterAdapter(lighterCreds, { testnet: true }) as unknown as {
      url: string;
      wsUrl: string;
    };
    expect(test.url).toBe(VENUE_ENDPOINTS.LIGHTER.testnet.rest);
    expect(test.wsUrl).toBe(VENUE_ENDPOINTS.LIGHTER.testnet.ws);

    const main = new LighterAdapter(lighterCreds) as unknown as { url: string; wsUrl: string };
    expect(main.url).toBe(VENUE_ENDPOINTS.LIGHTER.mainnet.rest);
    expect(main.wsUrl).toBe(VENUE_ENDPOINTS.LIGHTER.mainnet.ws);
  });

  /**
   * El WS de Aster era una constante de módulo usada suelta en los tres sitios
   * que abren socket, así que ignoraba cualquier red: un adaptador de testnet
   * mandaba sus órdenes a testnet y leía el libro de mainnet.
   */
  it('Aster apunta REST y WS a la red pedida', () => {
    const test = new AsterAdapter(asterCreds, { testnet: true }) as unknown as {
      rest: string;
      ws: string;
    };
    expect(test.rest).toBe(VENUE_ENDPOINTS.ASTER.testnet.rest);
    expect(test.ws).toBe(VENUE_ENDPOINTS.ASTER.testnet.ws);

    const main = new AsterAdapter(asterCreds) as unknown as { rest: string; ws: string };
    expect(main.rest).toBe(VENUE_ENDPOINTS.ASTER.mainnet.rest);
    expect(main.ws).toBe(VENUE_ENDPOINTS.ASTER.mainnet.ws);
  });

  it('`baseUrl` heredado sigue ganando sobre la tabla', () => {
    // Los sobres sellados antes de que existiera la tabla lo llevan dentro.
    const a = new LighterAdapter(
      { ...lighterCreds, baseUrl: 'https://sellado.example' },
      { testnet: true },
    ) as unknown as { url: string };
    expect(a.url).toBe('https://sellado.example');
  });
});

/**
 * La regla del sistema es «donde va `venue`, va `testnet`». Esto la comprueba en
 * los tres sitios donde olvidarla no da error, solo resultados equivocados: el
 * host al que se llama, el deposito de caudal del que se gasta, y el codigo de
 * builder que se adjunta a la orden.
 */
describe('paridad entre redes', () => {
  const CREDS = {
    HYPERLIQUID: { venue: 'HYPERLIQUID' as const, accountAddress: '', agentPrivateKey: '' },
    LIGHTER: { venue: 'LIGHTER' as const, accountIndex: 0, apiKeyIndex: 4, apiPrivateKey: '' },
    ASTER: { venue: 'ASTER' as const, userAddress: '', signerAddress: '', signerPrivateKey: '' },
  };

  it.each(Object.values(Venue))('%s: las dos redes usan hosts distintos', (venue) => {
    const main = endpointsFor(venue, false);
    const test = endpointsFor(venue, true);
    expect(new URL(main.rest).host).not.toBe(new URL(test.rest).host);
    expect(new URL(main.ws).host).not.toBe(new URL(test.ws).host);
  });

  /**
   * Depositos separados. Compartirlos no protegia de nada —cada host lleva su
   * propio contador en el venue— y hacia que leer un precio de testnet le
   * quitara caudal a un bot operando con dinero real.
   */
  // Hyperliquid queda fuera de los que CONSTRUYEN un adaptador: su SDK es solo
  // ESM y no se puede cargar desde Jest. Su red se comprueba en la tabla de
  // endpoints de arriba y en la sonda real contra los seis destinos.
  const CONSTRUIBLES = [Venue.LIGHTER, Venue.ASTER] as const;

  it.each(CONSTRUIBLES)('%s: cada red gasta de su propio deposito', async (venue) => {
    const gastado: string[] = [];
    const budget = {
      take: (v: Venue, _w: number, _p: 'read' | 'write', testnet: boolean) => {
        gastado.push(venueKey(v, testnet));
        return Promise.resolve();
      },
    };
    for (const testnet of [false, true]) {
      const a = createAdapter(CREDS[venue], { budget, testnet });
      // `getTickers` es lectura publica: falla por red —aqui no hay salida— pero
      // el presupuesto ya se ha consumido cuando lo hace, que es lo que se mide.
      await a.getTickers().catch(() => undefined);
      await a.close().catch(() => undefined);
    }
    expect(gastado).toContain(venue);
    expect(gastado).toContain(`${venue}:t`);
  });

  /**
   * El builder NO viaja en testnet. Si la direccion de la plataforma no esta
   * registrada en esa red, el venue rechaza la ORDEN ENTERA, no solo la
   * comision.
   */
  it('el builder se descarta en testnet', () => {
    // Sobre la funcion y no sobre un adaptador construido: es la unica forma de
    // cubrir la regla sin depender de que el venue se pueda instanciar en Jest,
    // y es exactamente el punto por el que pasan los tres.
    const opts = { builderAddress: '0xabc', builderFeeTenthBps: 10 };

    expect(normalizeOptions(opts)).toEqual(opts);
    expect(normalizeOptions({ ...opts, testnet: true })).toEqual({
      testnet: true,
      builderAddress: undefined,
      builderFeeTenthBps: undefined,
    });
  });

  it('lo demas de las opciones sobrevive intacto en testnet', () => {
    // La normalizacion solo puede quitar el builder. Si se llevara por delante
    // el presupuesto o el limitador, testnet dejaria de estar acotada y se
    // ganaria un veto de IP en el venue.
    const budget = { take: () => Promise.resolve() };
    const salida = normalizeOptions({ testnet: true, budget, rateLimitPerSecond: 3 });
    expect(salida.budget).toBe(budget);
    expect(salida.rateLimitPerSecond).toBe(3);
  });
});

describe('cuenta de servicio de Lighter', () => {
  const service = { accountIndex: 7, apiKeyIndex: 4, apiPrivateKey: 'a'.repeat(64) };

  it('se usa en mainnet', () => {
    const adapter = createPublicAdapter(Venue.LIGHTER, { service }) as unknown as {
      creds: { accountIndex: number };
    };
    expect(adapter.creds.accountIndex).toBe(7);
  });

  /**
   * Es una cuenta REAL de Lighter: su firma contra testnet la rechaza el venue,
   * y con ella se caerían todas las lecturas de la red de pruebas. Sin firmar
   * quedan 60 peticiones por minuto y por IP, que para probar sobran.
   */
  it('NO se usa en testnet', () => {
    const adapter = createPublicAdapter(Venue.LIGHTER, { service, testnet: true }) as unknown as {
      creds: { accountIndex: number; apiPrivateKey: string };
    };
    expect(adapter.creds.accountIndex).toBe(0);
    expect(adapter.creds.apiPrivateKey).toBe('');
  });
});
