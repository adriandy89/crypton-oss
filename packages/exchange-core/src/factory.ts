import { Venue } from '@crypton/shared';
import { AsterAdapter } from './adapters/aster';
import { DryRunAdapter, type DryRunOptions } from './adapters/dry-run';
import { HyperliquidAdapter } from './adapters/hyperliquid';
import { LighterAdapter } from './adapters/lighter';
import type { AdapterOptions, ExchangeAdapter, VenueCredentials } from './types';

export interface CreateAdapterOptions extends AdapterOptions {
  /**
   * Envuelve el adaptador real en el simulador: precios de verdad, órdenes
   * ninguna. Es el interruptor que separa "probar" de "operar", y por eso vive
   * en la creación y no en cada llamada: una vez creado, ningún camino del
   * motor puede saltárselo por error.
   */
  dryRun?: boolean;
  dryRunOptions?: DryRunOptions;
}

/**
 * Ajusta las opciones a la red antes de construir nada.
 *
 * Hoy hace una sola cosa: en TESTNET quita el codigo de builder. No es una
 * decision de producto sino de que la orden llegue a existir. Cobrar una
 * comision sobre dinero de juguete no significa nada; lo que si significa algo
 * es el fallo, porque la aprobacion del builder se firma POR RED y la direccion
 * de la plataforma no tiene por que estar registrada en la testnet del venue. Si
 * no lo esta, el exchange rechaza la ORDEN ENTERA —no solo la comision—, que es
 * el mismo modo de fallo que ya obliga a no ponerlo «por si acaso» cuando el
 * usuario no ha aprobado.
 *
 * Vive aqui y no en cada adaptador porque esta es la unica puerta por la que
 * pasan los tres: puesta tres veces, habria tres sitios donde olvidarla. Y esta
 * exportada porque es la unica forma de comprobarla sobre los tres venues en un
 * test: el SDK de Hyperliquid es solo ESM y no se puede construir desde Jest.
 */
export function normalizeOptions<T extends AdapterOptions>(opts: T): T {
  if (opts.testnet !== true) return opts;
  return { ...opts, builderAddress: undefined, builderFeeTenthBps: undefined };
}

export function createAdapter(
  creds: VenueCredentials,
  opts: CreateAdapterOptions = {},
): ExchangeAdapter {
  let adapter: ExchangeAdapter;

  opts = normalizeOptions(opts);

  switch (creds.venue) {
    case Venue.HYPERLIQUID:
      adapter = new HyperliquidAdapter(creds, opts);
      break;
    case Venue.LIGHTER:
      adapter = new LighterAdapter(creds, opts);
      break;
    case Venue.ASTER:
      adapter = new AsterAdapter(creds, opts);
      break;
    default: {
      // Exhaustividad comprobada por el compilador: añadir un venue al enum sin
      // añadirlo aquí rompe el build en lugar de fallar en tiempo de ejecución.
      const never: never = creds;
      throw new Error('Venue no soportado: ' + JSON.stringify(never));
    }
  }

  return opts.dryRun ? new DryRunAdapter(adapter, opts.dryRunOptions) : adapter;
}

/**
 * Credenciales de una cuenta de SERVICIO: propia de la plataforma, sin
 * posiciones y sin órdenes. Existe por una sola razón, y la documentación de
 * Lighter la dice así:
 *
 *   «To bypass IP-based rate limits, clients can authenticate each request so
 *    that only L1-based rate limits apply.»
 *
 * Sin ella, las lecturas públicas salen sin firmar y el cupo son 60 peticiones
 * por minuto para toda la IP de salida, compartidas con cualquier otro que
 * salga por ella. No es la credencial de ningún usuario y no puede serlo: este
 * camino no debe descifrar la clave de nadie para leer un precio.
 */
export interface ServiceCredentials {
  accountIndex: number;
  apiKeyIndex: number;
  apiPrivateKey: string;
}

export interface PublicAdapterOptions extends CreateAdapterOptions {
  service?: ServiceCredentials;
}

/**
 * Credenciales vacías por venue. Los adaptadores crean su firmante de forma
 * perezosa y comprueban la clave, así que estos objetos sirven para leer datos
 * públicos y fallan con un mensaje claro si algo intenta firmar.
 */
const EMPTY_CREDENTIALS: Record<Venue, VenueCredentials> = {
  [Venue.HYPERLIQUID]: { venue: 'HYPERLIQUID', accountAddress: '', agentPrivateKey: '' },
  [Venue.LIGHTER]: { venue: 'LIGHTER', accountIndex: 0, apiKeyIndex: 0, apiPrivateKey: '' },
  [Venue.ASTER]: { venue: 'ASTER', userAddress: '', signerAddress: '', signerPrivateKey: '' },
};

/**
 * Adaptador SIN credenciales, para datos públicos de mercado.
 *
 * Existe porque la lista de mercados y el precio de referencia son información
 * pública, y sin embargo el único modo de leerlos era construir un adaptador
 * autenticado. Eso llevó a que la sincronización de mercados «tomara prestada»
 * la conexión verificada de cualquier usuario y descifrara su clave privada
 * para una consulta que no requiere firma alguna.
 *
 * Solo debe usarse para métodos que no firman: `getMarkets`, `getTicker` y los
 * flujos de precio. Cualquier otro lanza un error explícito.
 *
 * Con `dryRun: true` deja de ser solo de lectura y pasa a ser la base de las
 * CUENTAS DE SIMULACIÓN: el simulador envuelve a este adaptador, sirve sus
 * precios —que son los reales— y ejecuta las órdenes en memoria. Ninguna
 * escritura llega abajo, así que la ausencia de firmante no es una limitación
 * sino la garantía: no existe la pieza que podría mandar una orden de verdad.
 */
export function createPublicAdapter(
  venue: Venue,
  opts: PublicAdapterOptions = {},
): ExchangeAdapter {
  const { service, ...rest } = opts;
  // La cuenta de servicio solo se usa donde el venue la aprovecha. Hoy eso es
  // Lighter y solo Lighter: Hyperliquid publica sus `info` sin credencial, y
  // Aster dice explícitamente que «the limits on the API are based on the IPs,
  // not the API keys», así que firmar allí no cambiaría nada.
  //
  // Y solo en MAINNET: la cuenta de servicio es una cuenta real de Lighter, y su
  // firma contra testnet la rechazaría el venue —otro `chain_id`, otro índice de
  // cuenta— dejando sin precios a toda la red de pruebas. En testnet se lee sin
  // firmar, que es el modo degradado que `serviceCredentials` ya contempla: 60
  // peticiones por minuto y por IP, de sobra para probar.
  if (venue === Venue.LIGHTER && service?.apiPrivateKey && rest.testnet !== true) {
    return createAdapter(
      {
        venue: 'LIGHTER',
        accountIndex: service.accountIndex,
        apiKeyIndex: service.apiKeyIndex,
        apiPrivateKey: service.apiPrivateKey,
      },
      rest,
    );
  }
  return createAdapter(EMPTY_CREDENTIALS[venue], rest);
}
