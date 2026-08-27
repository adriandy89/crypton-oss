import { Component, inject, signal } from '@angular/core';
import { IonButton, IonContent, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { alertCircleOutline } from 'ionicons/icons';
import { AuthService } from '../../core/auth';
import { errorText } from '../../core/utils';
import { UiNoticeComponent } from '../../shared/ui';

/**
 * La única puerta de entrada.
 *
 * No hay formulario porque no hay nada que teclear: ni correo ni contraseña.
 * Se pulsa el botón, se va a google.com —en el navegador del sistema, con su
 * barra de direcciones a la vista— y se vuelve con la sesión hecha.
 *
 * Que no haya campos no es solo comodidad: sin contraseña no hay contraseña
 * que reutilizar de otro sitio, que adivinar por fuerza bruta, ni que pescar
 * con una pantalla parecida a esta.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [IonContent, IonButton, IonSpinner, UiNoticeComponent],
  template: `
    <ion-content>
      <div class="shell">
        <header>
          <div class="mark">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#8b5cf6" />
                  <stop offset="1" stop-color="#22d3ee" />
                </linearGradient>
              </defs>
              <path
                d="M16 3 L29 16 L16 29 L3 16 Z"
                fill="none"
                stroke="url(#lg)"
                stroke-width="2.2"
                stroke-linejoin="round"
              />
              <path d="M16 10 L22 16 L16 22 L10 16 Z" fill="url(#lg)" />
            </svg>
          </div>
          <h1>CRYPTON</h1>
          <p class="claim">Tus fondos no se mueven. Tus órdenes, sí.</p>
        </header>

        @if (error()) {
          <ui-notice tone="danger" icon="alert-circle-outline">{{ error() }}</ui-notice>
        }

        <ion-button expand="block" [disabled]="busy()" (click)="entrar()">
          @if (busy()) {
            <ion-spinner name="crescent" />
          } @else {
            <span class="g">G</span>
            Continuar con Google
          }
        </ion-button>

        <p class="explica">
          Es la única forma de entrar. Solo recibimos tu correo: ni tu nombre, ni tu foto, ni tu
          contraseña, que nunca sale de Google.
        </p>

        <p class="legal">
          Al continuar aceptas los terminos y el aviso de riesgo. Operar con derivados apalancados
          puede hacerte perder todo tu capital.
        </p>
      </div>
    </ion-content>
  `,
  styleUrl: './login.page.scss',
})
export class LoginPage {
  private readonly auth = inject(AuthService);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    addIcons({ alertCircleOutline });
  }

  async entrar(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.signInWithGoogle();
      // No se navega: en web la línea anterior ya ha abandonado la página, y en
      // móvil el navegador del sistema está encima. La sesión se completa en
      // `/auth/callback` cuando Google conteste.
    } catch (e) {
      this.error.set(errorText(e));
      this.busy.set(false);
    }
  }
}
