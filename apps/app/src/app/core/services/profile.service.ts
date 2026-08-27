import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth';

/**
 * Perfil de la cuenta y ajustes de seguridad.
 *
 * El perfil es privado: nadie más lo ve. Se lee de `/users/me` y no de
 * `/auth/me` porque este último devuelve los claims del token, que se quedan
 * viejos justo después de guardar un cambio.
 */
export interface Profile {
  id: string;
  email: string;
  name: string;
  bio: string | null;
  country: string | null;
  timezone: string | null;
  displayCurrency: string | null;
  language: string;
  role: 'USER' | 'ADMIN';
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ProfilePatch {
  name?: string;
  bio?: string;
  country?: string;
  timezone?: string;
  displayCurrency?: string;
  language?: string;
}

@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly base = environment.apiUrl;

  readonly profile = signal<Profile | null>(null);

  async refresh(): Promise<void> {
    const perfil = await firstValueFrom(this.http.get<Profile>(`${this.base}/users/me`));
    this.profile.set(perfil);
    this.sincronizarSesion(perfil);
  }

  async update(patch: ProfilePatch): Promise<void> {
    const perfil = await firstValueFrom(
      this.http.patch<Profile>(`${this.base}/users/me`, patch),
    );
    this.profile.set(perfil);
    this.sincronizarSesion(perfil);
  }

  /**
   * El perfil manda sobre los claims del token.
   *
   * `AuthService.user()` viene de `/auth/me` y no se relee hasta la proxima
   * renovacion, asi que sin esto la cabecera de la pestaña Cuenta y las
   * iniciales del avatar se quedaban con el nombre viejo despues de cambiarlo.
   * Se hace aqui y no en la pagina para que valga desde cualquier sitio que
   * edite el perfil, hoy y mañana.
   */
  private sincronizarSesion(perfil: Profile): void {
    this.auth.patchUser({ name: perfil.name, language: perfil.language });
  }

  /**
   * Borra la cuenta. Exige haberse reautenticado con Google justo antes: la
   * prueba no viaja aquí, la consume el servidor del permiso que dejó el flujo.
   */
  async remove(confirm: string): Promise<{ stoppedBots: number }> {
    // `body` en un DELETE: es poco común, pero es lo que evita escribir la
    // confirmación en la URL, donde acabaría en los logs de cualquier proxy.
    return firstValueFrom(
      this.http.delete<{ stoppedBots: number }>(`${this.base}/users/me`, { body: { confirm } }),
    );
  }
}
