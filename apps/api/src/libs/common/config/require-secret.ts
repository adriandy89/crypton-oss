import { ConfigService } from '@nestjs/config';

/**
 * Valores de ejemplo que llevan los `.env.example`. Arrancar con uno de ellos
 * es tan grave como no tener secreto: son públicos, están en el repositorio.
 */
const PLACEHOLDERS = new Set([
  'change-me-access',
  'change-me-refresh',
  'change-me',
  'changeme',
]);

/** Por debajo de esto no es un secreto, es una contraseña de prueba. */
const MIN_LENGTH = 32;

/**
 * Lee un secreto obligatorio del entorno o **impide que la aplicación arranque**.
 *
 * Antes estos valores tenían un `default` de desarrollo ('dev-access-secret').
 * Con la variable ausente en producción la API arrancaba igualmente y firmaba
 * con un secreto público: cualquiera podía emitirse un token con el `sub` y el
 * `role` que quisiera. Fallar al arrancar es ruidoso y se arregla en un minuto;
 * lo otro es silencioso y no se detecta jamás.
 *
 * `CREDENTIALS_MASTER_KEY` ya se comportaba así (ver `EnvelopeService`); esto
 * extiende el mismo criterio a los secretos de firma.
 */
export function requireSecret(config: ConfigService, key: string): string {
  const value = config.get<string>(key, '').trim();

  if (!value) {
    throw new Error(
      `Falta ${key}. Genera los secretos con "pnpm setup" antes de arrancar la API.`,
    );
  }
  if (PLACEHOLDERS.has(value)) {
    throw new Error(
      `${key} sigue con el valor de ejemplo del .env.example. Ese valor es público: ` +
        'genera uno real con "pnpm setup".',
    );
  }
  if (value.length < MIN_LENGTH) {
    throw new Error(
      `${key} es demasiado corto (${value.length} caracteres, mínimo ${MIN_LENGTH}). ` +
        'Genera uno real con "pnpm setup".',
    );
  }

  return value;
}
