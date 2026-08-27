import { Venue } from '@crypton/shared';

/** Par de URLs de un venue en una red concreta. */
export interface VenueEndpoints {
  rest: string;
  ws: string;
}

/**
 * Las URLs de los tres venues, en sus dos redes. Es el ÚNICO sitio del sistema
 * donde vive una dirección de exchange.
 *
 * Antes cada adaptador llevaba las suyas como constantes de módulo y la única
 * forma de apuntar a otra red era un `baseUrl` que venía —sin validar— del
 * cuerpo de la petición del usuario. Eso hacía dos cosas malas a la vez: dejaba
 * elegir el destino de una clave de firma a quien mandaba el formulario, y
 * repartía por tres archivos una decisión que es una sola.
 *
 * Hyperliquid no lee estas URLs: su SDK conoce las dos y solo acepta un
 * booleano. Están aquí igualmente para que la tabla esté completa y para poder
 * comprobarlas de un vistazo.
 */
export const VENUE_ENDPOINTS: Record<Venue, { mainnet: VenueEndpoints; testnet: VenueEndpoints }> =
  {
    [Venue.HYPERLIQUID]: {
      mainnet: { rest: 'https://api.hyperliquid.xyz', ws: 'wss://api.hyperliquid.xyz/ws' },
      testnet: {
        rest: 'https://api.hyperliquid-testnet.xyz',
        ws: 'wss://api.hyperliquid-testnet.xyz/ws',
      },
    },
    [Venue.LIGHTER]: {
      mainnet: {
        rest: 'https://mainnet.zklighter.elliot.ai',
        ws: 'wss://mainnet.zklighter.elliot.ai/stream',
      },
      testnet: {
        rest: 'https://testnet.zklighter.elliot.ai',
        ws: 'wss://testnet.zklighter.elliot.ai/stream',
      },
    },
    [Venue.ASTER]: {
      mainnet: { rest: 'https://fapi.asterdex.com', ws: 'wss://fstream.asterdex.com' },
      testnet: {
        rest: 'https://fapi.asterdex-testnet.com',
        ws: 'wss://fstream5.asterdex-testnet.com',
      },
    },
  };

/**
 * URLs de un venue en la red pedida.
 *
 * OJO CON LIGHTER: su SDK NO recibe la red, la deduce de esta misma URL
 * —`signer.js`: `url.includes("mainnet") ? 304 : 300`—. Eso es una ventaja
 * (el `chain_id` de firma sale correcto sin configurar nada) y una trampa: una
 * URL que no contenga la cadena `mainnet` firma como testnet, y una firma con
 * el chain_id equivocado la rechaza el venue sin decir por qué. Por eso el
 * destino sale de esta tabla y no de un campo que rellene nadie más.
 */
export function endpointsFor(venue: Venue, testnet: boolean): VenueEndpoints {
  return VENUE_ENDPOINTS[venue][testnet ? 'testnet' : 'mainnet'];
}
