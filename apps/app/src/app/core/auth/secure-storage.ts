import { Preferences } from '@capacitor/preferences';

/**
 * Almacen del par de tokens y de los secretos efimeros del acceso.
 *
 * Usa `@capacitor/preferences`, que en Android va contra SharedPreferences del
 * paquete: solo accesible para la propia app. En el navegador cae a
 * localStorage, que es aceptable en desarrollo pero NO donde importa — por eso
 * la app de verdad es la nativa.
 */
const ACCESS = 'crypton.access';
const REFRESH = 'crypton.refresh';

/**
 * Verificador del acceso con Google, mientras dura el viaje.
 *
 * Tiene que sobrevivir a una recarga completa de la página: en web, ir a
 * Google es abandonar la aplicación, y al volver el estado en memoria ya no
 * existe. Se borra en cuanto se canjea, valga o no valga.
 */
const VERIFIER = 'crypton.oauth.verifier';

/** A dónde volver después de reautenticarse. Mismo motivo que el anterior. */
const RETURN_URL = 'crypton.oauth.return';

export const secureStorage = {
  async get(key: string): Promise<string | null> {
    const { value } = await Preferences.get({ key });
    return value ?? null;
  },
  async set(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value });
  },
  async remove(key: string): Promise<void> {
    await Preferences.remove({ key });
  },
  keys: { ACCESS, REFRESH, VERIFIER, RETURN_URL },
};
