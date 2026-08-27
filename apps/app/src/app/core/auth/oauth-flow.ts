import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

/** Los dos destinos de vuelta que la API tiene configurados. */
export type AppPlatform = 'web' | 'native';

/** Lo que trae la URL de vuelta: o un vale, o el motivo del fallo. */
export interface OAuthResult {
  ticket?: string;
  error?: string;
}

const base64url = (bytes: Uint8Array): string => {
  let binario = '';
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * La mitad del flujo que vive en el dispositivo.
 *
 * El secreto que se genera aquí —el `verifier`— es lo que ata el vale de vuelta
 * a ESTA aplicación. En Android, cualquier app instalada puede declarar que
 * abre `com.crypton.app://`, así que el enlace de vuelta no es un canal de
 * confianza; el verificador nunca sale de aquí, y sin él el vale no vale nada.
 * Es el mismo razonamiento de PKCE, aplicado al último tramo del recorrido.
 */
export const oauthFlow = {
  /**
   * Sortea el verificador y calcula su reto.
   *
   * 32 bytes del generador criptográfico del sistema, no de `Math.random()`,
   * que es predecible y no está pensado para esto.
   */
  async generarPar(): Promise<{ verifier: string; challenge: string }> {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const verifier = base64url(bytes);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: base64url(new Uint8Array(digest)) };
  },

  plataforma(): AppPlatform {
    return Capacitor.isNativePlatform() ? 'native' : 'web';
  },

  /**
   * Abre la pantalla de Google.
   *
   * En el móvil, en el navegador del sistema (`Browser` usa Custom Tabs en
   * Android). NUNCA en un WebView propio: dentro de un WebView el usuario no
   * puede comprobar que la barra de direcciones dice google.com, la sesión de
   * su navegador no está disponible, y Google bloquea ese patrón precisamente
   * por eso. Es lo que manda la RFC 8252 para aplicaciones nativas.
   *
   * En web, navegación completa. Un popup sería más cómodo, pero los
   * bloqueadores lo tratan como tal y el flujo se rompería sin explicación.
   */
  async abrir(url: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await Browser.open({ url, presentationStyle: 'popover' });
      return;
    }
    window.location.assign(url);
  },

  /** Cierra el navegador del sistema. Sin efecto en web. */
  async cerrar(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await Browser.close().catch(() => undefined);
    }
  },

  /**
   * Escucha el enlace profundo con el que la API devuelve el control a la app.
   *
   * Solo en nativo: en web la vuelta es una navegación normal a
   * `/auth/callback`, que resuelve el enrutador.
   */
  escucharVuelta(alRecibir: (resultado: OAuthResult) => void): void {
    if (!Capacitor.isNativePlatform()) return;

    void App.addListener('appUrlOpen', ({ url }) => {
      let params: URLSearchParams;
      try {
        params = new URL(url).searchParams;
      } catch {
        return;
      }
      const ticket = params.get('ticket') ?? undefined;
      const error = params.get('error') ?? undefined;
      // Otros enlaces profundos de la app no son asunto de esto.
      if (!ticket && !error) return;

      alRecibir({ ticket, error });
    });
  },
};

/** Texto para cada motivo de fallo que la API sabe devolver. */
export const explicarErrorOAuth = (codigo: string | undefined): string => {
  switch (codigo) {
    case 'access_denied':
      return 'Has cancelado el acceso con Google.';
    case 'email_unverified':
      return 'Tu cuenta de Google no tiene el correo verificado. Verifícalo y vuelve a intentarlo.';
    case 'account_disabled':
      return 'Esta cuenta está deshabilitada.';
    case 'email_taken':
      return 'Ese correo ya pertenece a otra cuenta.';
    default:
      return 'No se ha podido completar el acceso. Inténtalo de nuevo.';
  }
};
