import { Venue } from '@crypton/shared';
import type { ServiceCredentials } from './factory';

/** Lo mínimo que necesita este helper de un `ConfigService`. */
export interface ConfigLike {
  get<T = string>(key: string, fallback?: T): T;
}

export interface ServiceCredentialsResult {
  credentials?: ServiceCredentials;
  /** Qué contar en el arranque. Nunca vacío: el modo elegido siempre se dice. */
  notice: string;
}

/**
 * Credenciales de la cuenta de servicio de un venue, leídas del entorno.
 *
 * Solo Lighter las usa, y no es una simplificación: es el único de los tres en
 * el que autenticar cambia algo.
 *
 *   · Lighter — «To bypass IP-based rate limits, clients can authenticate each
 *     request so that only L1-based rate limits apply».
 *   · Hyperliquid — sus endpoints `info` son públicos y no admiten credencial.
 *   · Aster — «The limits on the API are based on the IPs, not the API keys».
 *
 * Devuelve el modo elegido SIEMPRE, para que el arranque lo anuncie. Escoger en
 * silencio entre dos modos que se diferencian en un factor de dos mil es cómo
 * se llega a un incidente que nadie sabe explicar.
 */
export function serviceCredentials(venue: Venue, config: ConfigLike): ServiceCredentialsResult {
  if (venue !== Venue.LIGHTER) return { notice: '' };

  const apiPrivateKey = String(config.get('LIGHTER_SERVICE_PRIVATE_KEY', '')).trim();
  const accountIndex = Number(config.get('LIGHTER_SERVICE_ACCOUNT_INDEX', ''));
  const apiKeyIndex = Number(config.get('LIGHTER_SERVICE_API_KEY_INDEX', '4'));

  if (!apiPrivateKey || !Number.isFinite(accountIndex)) {
    return {
      notice:
        'Lighter SIN cuenta de servicio: las lecturas van sin firmar y el cupo es de 60 ' +
        'peticiones por minuto para TODA la IP de salida. Configura ' +
        'LIGHTER_SERVICE_ACCOUNT_INDEX y LIGHTER_SERVICE_PRIVATE_KEY para subirlo.',
    };
  }

  // Los índices 0-3 los reserva Lighter para sus clientes de escritorio y
  // móvil: usar uno de esos pisa la sesión de la interfaz oficial del usuario.
  if (!Number.isInteger(apiKeyIndex) || apiKeyIndex < 4 || apiKeyIndex > 254) {
    return {
      notice:
        `LIGHTER_SERVICE_API_KEY_INDEX=${apiKeyIndex} no sirve: Lighter reserva los índices ` +
        '0-3 para sus propias aplicaciones. Usa uno entre 4 y 254. Se seguirá sin firmar.',
    };
  }

  return {
    credentials: { accountIndex, apiKeyIndex, apiPrivateKey },
    notice: `Lighter con cuenta de servicio (índice ${accountIndex}): peticiones firmadas.`,
  };
}
