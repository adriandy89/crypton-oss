import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { SessionUser, TokenPair } from '../models';
import { oauthFlow } from './oauth-flow';
import { secureStorage } from './secure-storage';

/** Lo que devuelve el canje: o una sesión, o el permiso de operación crítica. */
type Canje = TokenPair | { stepUp: true; expiresIn: number };

const esStepUp = (canje: Canje): canje is { stepUp: true; expiresIn: number } => 'stepUp' in canje;

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly _user = signal<SessionUser | null>(null);
  private readonly _accessToken = signal<string | null>(null);
  private readonly _ready = signal(false);

  readonly user = this._user.asReadonly();
  readonly ready = this._ready.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  /**
   * Una sola renovación en vuelo.
   *
   * Al abrir la app salen varias peticiones a la vez; si cada 401 lanzara su
   * propia renovación, todas menos una consumirían un refresh token ya rotado y
   * la sesión se cerraría sola. Compartiendo la promesa, solo se rota una vez.
   */
  private refreshing: Promise<boolean> | null = null;

  get accessToken(): string | null {
    return this._accessToken();
  }

  /**
   * Corrige la sesion en memoria con lo que el usuario acaba de guardar.
   *
   * `_user` sale de `/auth/me`, que devuelve los claims del token: se queda
   * viejo en cuanto se edita el perfil, y no se vuelve a leer hasta la proxima
   * renovacion. La pestaña Cuenta pinta `user()?.name` y las iniciales del
   * avatar, asi que cambiar el nombre en Perfil no se veia en ningun sitio
   * hasta cerrar sesion.
   *
   * Esto NO toca el token —el nombre no es una credencial— ni pide nada a la
   * red: solo alinea la copia en memoria con lo que el servidor ya confirmo.
   */
  patchUser(patch: Partial<SessionUser>): void {
    const actual = this._user();
    if (!actual) return;
    this._user.set({ ...actual, ...patch });
  }

  /**
   * Restaura la sesión antes del primer render.
   *
   * Se llama desde `provideAppInitializer`: sin esto, el guard de rutas se
   * evaluaría con el usuario todavía a null y mandaría al login a alguien que
   * si tiene sesión.
   */
  async init(): Promise<void> {
    try {
      const access = await secureStorage.get(secureStorage.keys.ACCESS);
      if (access) {
        this._accessToken.set(access);
        try {
          await this.loadMe();
        } catch {
          // El access ha caducado: se intenta rotar antes de rendirse.
          await this.refresh();
        }
      }
    } finally {
      this._ready.set(true);
    }
  }

  // ── Entrar con Google ─────────────────────────────────────────

  /**
   * Arranca el acceso. Devuelve cuando el navegador ya está abierto en Google:
   * la sesión no existe todavía, se completa en `/auth/callback`.
   */
  async signInWithGoogle(): Promise<void> {
    await this.arrancarFlujo('google/start');
  }

  /**
   * Reautenticación antes de una operación crítica.
   *
   * `returnUrl` es a dónde volver cuando Google conteste; se guarda en disco
   * porque en web irse a Google descarga la aplicación entera.
   */
  async startStepUp(returnUrl: string): Promise<void> {
    await secureStorage.set(secureStorage.keys.RETURN_URL, returnUrl);
    await this.arrancarFlujo('google/step-up');
  }

  private async arrancarFlujo(ruta: string): Promise<void> {
    const { verifier, challenge } = await oauthFlow.generarPar();
    // Se guarda ANTES de salir: en web, la línea siguiente abandona la página.
    await secureStorage.set(secureStorage.keys.VERIFIER, verifier);

    const { authorizationUrl } = await firstValueFrom(
      this.http.post<{ authorizationUrl: string }>(`${environment.apiUrl}/auth/${ruta}`, {
        platform: oauthFlow.plataforma(),
        challenge,
      }),
    );

    await oauthFlow.abrir(authorizationUrl);
  }

  /**
   * Cierra el flujo: canjea el vale por la sesión o por el permiso.
   *
   * Devuelve qué era, para que la pantalla de vuelta sepa a dónde llevar al
   * usuario. El verificador se borra pase lo que pase: sirve para un solo
   * intento, y dejarlo vivo alargaría sin motivo la ventana en la que un vale
   * interceptado podría canjearse.
   */
  async completeGoogleFlow(ticket: string): Promise<'session' | 'step-up'> {
    const verifier = await secureStorage.get(secureStorage.keys.VERIFIER);
    if (!verifier) throw new Error('El acceso ha caducado. Inténtalo otra vez.');

    try {
      const canje = await firstValueFrom(
        this.http.post<Canje>(`${environment.apiUrl}/auth/google/exchange`, { ticket, verifier }),
      );

      if (esStepUp(canje)) return 'step-up';

      await this.store(canje);
      await this.loadMe();
      return 'session';
    } finally {
      await secureStorage.remove(secureStorage.keys.VERIFIER);
      await oauthFlow.cerrar();
    }
  }

  /** A dónde volver tras reautenticarse. Se consume al leerlo. */
  async takeReturnUrl(): Promise<string | null> {
    const url = await secureStorage.get(secureStorage.keys.RETURN_URL);
    await secureStorage.remove(secureStorage.keys.RETURN_URL);
    return url;
  }

  /** Si queda una reautenticación reciente válida para una operación crítica. */
  async hasFreshStepUp(): Promise<boolean> {
    const { fresh } = await firstValueFrom(
      this.http.get<{ fresh: boolean }>(`${environment.apiUrl}/auth/step-up`),
    );
    return fresh;
  }

  // ── Sesión ────────────────────────────────────────────────────

  async signOut(): Promise<void> {
    const refreshToken = await secureStorage.get(secureStorage.keys.REFRESH);
    if (refreshToken) {
      // Se avisa al servidor para revocar la familia, pero un fallo de red no
      // debe impedir cerrar sesión en el dispositivo.
      await firstValueFrom(
        this.http.post(`${environment.apiUrl}/auth/sign-out`, { refreshToken }),
      ).catch(() => undefined);
    }
    await this.clear();
    await this.router.navigateByUrl('/auth/login', { replaceUrl: true });
  }

  /**
   * Cierra la sesión en TODOS los dispositivos.
   *
   * Sin contraseña que cambiar, este es el gesto que corta el acceso de un
   * intruso desde dentro de la aplicación.
   */
  async signOutEverywhere(): Promise<void> {
    await firstValueFrom(this.http.post(`${environment.apiUrl}/auth/sign-out-all`, {}));
    await this.clear();
    await this.router.navigateByUrl('/auth/login', { replaceUrl: true });
  }

  /** Rota el par de tokens. Devuelve false si la sesión ya no es válida. */
  async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const refreshToken = await secureStorage.get(secureStorage.keys.REFRESH);
      if (!refreshToken) {
        await this.clear();
        return false;
      }
      try {
        const pair = await firstValueFrom(
          this.http.post<TokenPair>(`${environment.apiUrl}/auth/refresh`, { refreshToken }),
        );
        await this.store(pair);
        await this.loadMe();
        return true;
      } catch {
        await this.clear();
        return false;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  private async loadMe(): Promise<void> {
    const me = await firstValueFrom(this.http.get<SessionUser>(`${environment.apiUrl}/auth/me`));
    this._user.set(me);
  }

  private async store(pair: TokenPair): Promise<void> {
    this._accessToken.set(pair.accessToken);
    await secureStorage.set(secureStorage.keys.ACCESS, pair.accessToken);
    await secureStorage.set(secureStorage.keys.REFRESH, pair.refreshToken);
  }

  private async clear(): Promise<void> {
    this._user.set(null);
    this._accessToken.set(null);
    await secureStorage.remove(secureStorage.keys.ACCESS);
    await secureStorage.remove(secureStorage.keys.REFRESH);
  }
}
