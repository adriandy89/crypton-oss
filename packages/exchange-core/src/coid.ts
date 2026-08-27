import { createHash } from 'node:crypto';
import { Venue } from '@crypton/shared';
import type { ClientOrderIdCodec } from './types';

/**
 * Traducción del id canónico del motor al formato de cada venue.
 *
 * La propiedad que importa es que sea DETERMINISTA: el motor no guarda ninguna
 * tabla de correspondencias, sino que codifica sus ids deseados y compara en
 * espacio de venue. Así, un worker que arranca de cero reconoce como propias
 * las órdenes que ya estaban en el libro sin consultar nada.
 */

const sha = (input: string): Buffer => createHash('sha256').update(input, 'utf8').digest();

/** Hyperliquid: `cloid` de 16 bytes en hexadecimal, con prefijo 0x (34 chars). */
export const hyperliquidCodec: ClientOrderIdCodec = {
  encode: (canonical) => {
    // Passthrough de lo YA codificado. El motor maneja ids en dos espacios: el
    // canónico (lo que genera la estrategia) y el del venue (lo que devuelve el
    // exchange). Al cancelar una huérfana, el id llega en espacio de venue —el
    // reconciliador trabaja ahí— y volver a hashearlo producía un cloid que no
    // correspondía a NINGUNA orden: la cancelación fallaba con "not found", el
    // motor lo trataba como no-op, y la orden vieja se quedaba viva para
    // siempre. En el camino de reemplazo, eso significaba orden vieja + orden
    // nueva conviviendo: exposición duplicada.
    if (/^0x[0-9a-f]{32}$/i.test(canonical)) return canonical;
    return '0x' + sha(canonical).subarray(0, 16).toString('hex');
  },
};

/**
 * Lighter: `client_order_index` es un entero.
 *
 * Se toman 6 bytes (< 2^48) y no 8: con 8 el valor supera
 * Number.MAX_SAFE_INTEGER y JavaScript empieza a redondear, con lo que dos
 * órdenes distintas podrían acabar compartiendo índice.
 */
export const lighterCodec: ClientOrderIdCodec = {
  encode: (canonical) => String(lighterCodec.encodeNumeric!(canonical)),
  encodeNumeric: (canonical) => {
    // Passthrough por la misma razón que en Hyperliquid: un id ya en espacio de
    // venue es un entero, y un id canónico jamás es solo dígitos (lleva puntos
    // y el código de nivel). Re-hashear un entero daría otro entero distinto.
    if (/^\d{1,15}$/.test(canonical)) return Number(canonical);
    return sha(canonical).readUIntBE(0, 6);
  },
};

/**
 * Aster: acepta el id tal cual (estilo Binance), hasta 36 caracteres del juego
 * alfanumérico más `.`, `-` y `_`. El id canónico ya cumple, así que se pasa
 * literal y sigue siendo legible en el panel del venue.
 */
export const asterCodec: ClientOrderIdCodec = {
  encode: (canonical) => {
    const clean = canonical.replace(/[^A-Za-z0-9._:/-]/g, '');
    return clean.length <= 36 ? clean : sha(canonical).toString('hex').slice(0, 32);
  },
};

const CODECS: Record<Venue, ClientOrderIdCodec> = {
  [Venue.HYPERLIQUID]: hyperliquidCodec,
  [Venue.LIGHTER]: lighterCodec,
  [Venue.ASTER]: asterCodec,
};

export const codecFor = (venue: Venue): ClientOrderIdCodec => CODECS[venue];
