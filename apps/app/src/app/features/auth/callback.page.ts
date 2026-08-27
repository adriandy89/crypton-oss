import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonButton, IonContent, IonNote, IonSpinner } from '@ionic/angular/standalone';
import { AuthService, explicarErrorOAuth } from '../../core/auth';
import { ToastService } from '../../core/services';
import { errorText } from '../../core/utils';

/**
 * La vuelta de Google.
 *
 * Aquí llega el vale de un solo uso, por dos caminos que acaban en el mismo
 * sitio: en web, como la navegación con la que la API devuelve el navegador; en
 * móvil, a través del enlace profundo que `AppComponent` traduce a esta ruta.
 *
 * Sirve para las dos cosas que pueden haber pasado —entrar, o reautenticarse
 * antes de una operación crítica— porque quien lo sabe es el servidor: el vale
 * lleva dentro para qué se pidió, y el canje devuelve qué era.
 *
 * Está fuera del grupo de rutas con `guestGuard` a propósito: la
 * reautenticación ocurre con la sesión ya abierta, y ese guard la habría
 * mandado de vuelta a los bots justo antes de canjear nada.
 */
@Component({
  selector: 'app-auth-callback',
  standalone: true,
  imports: [IonContent, IonSpinner, IonNote, IonButton],
  template: `
    <ion-content class="ion-padding">
      <div class="shell">
        @if (error()) {
          <div class="mark">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <defs>
                <linearGradient id="cb" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#8b5cf6" />
                  <stop offset="1" stop-color="#22d3ee" />
                </linearGradient>
              </defs>
              <path
                d="M16 3 L29 16 L16 29 L3 16 Z"
                fill="none"
                stroke="url(#cb)"
                stroke-width="2.2"
                stroke-linejoin="round"
              />
              <path d="M16 10 L22 16 L16 22 L10 16 Z" fill="url(#cb)" />
            </svg>
          </div>
          <ion-note color="danger">{{ error() }}</ion-note>
          <ion-button expand="block" fill="outline" (click)="volver()">Volver</ion-button>
        } @else {
          <ion-spinner name="crescent" />
          <p>Terminando…</p>
        }
      </div>
    </ion-content>
  `,
  styles: [
    `
      .shell {
        max-width: 420px;
        margin: 0 auto;
        padding-top: 22vh;
        text-align: center;
      }
      .mark svg {
        width: 48px;
        height: 48px;
        margin: 0 auto 18px;
        display: block;
      }
      p {
        color: var(--text-2);
        margin-top: 16px;
      }
      ion-note {
        display: block;
        margin-bottom: 24px;
        font-size: 13px;
        line-height: 1.6;
      }
    `,
  ],
})
export class AuthCallbackPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const ticket = params.get('ticket');
    const fallo = params.get('error');

    if (fallo || !ticket) {
      this.error.set(explicarErrorOAuth(fallo ?? undefined));
      return;
    }

    try {
      const resultado = await this.auth.completeGoogleFlow(ticket);

      if (resultado === 'step-up') {
        // Se vuelve a la pantalla que pidió la reautenticación. El permiso dura
        // unos minutos y se consume en la siguiente operación crítica.
        const destino = (await this.auth.takeReturnUrl()) ?? '/tabs/account';
        await this.toast.success('Identidad confirmada. Ya puedes continuar.');
        await this.router.navigateByUrl(destino, { replaceUrl: true });
        return;
      }

      await this.router.navigateByUrl('/tabs/bots', { replaceUrl: true });
    } catch (e) {
      this.error.set(errorText(e));
    }
  }

  async volver(): Promise<void> {
    const destino = (await this.auth.takeReturnUrl()) ?? '/auth/login';
    await this.router.navigateByUrl(destino, { replaceUrl: true });
  }
}
