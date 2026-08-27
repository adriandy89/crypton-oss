import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Browser } from '@capacitor/browser';
import { AlertController } from '@ionic/angular/standalone';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { openOutline, warningOutline } from 'ionicons/icons';
import { AuthService } from '../../core/auth';
import { ProfileService, ToastService } from '../../core/services';
import { errorText, parseHttpError } from '../../core/utils';

/**
 * Seguridad de la cuenta.
 *
 * Es corta porque casi todo lo que antes vivía aquí —contraseña, doble factor,
 * códigos de recuperación— ya no existe: se entra con Google, y la
 * verificación en dos pasos y la recuperación las lleva Google. Lo que queda
 * es lo que de verdad depende de esta plataforma: cortar las sesiones y borrar
 * la cuenta.
 */
@Component({
  selector: 'app-security',
  standalone: true,
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonButton,
    IonNote,
    IonSpinner,
    IonIcon,
  ],
  templateUrl: './security.page.html',
  styleUrl: './security.page.scss',
})
export class SecurityPage implements OnInit {
  readonly profile = inject(ProfileService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly alerts = inject(AlertController);
  private readonly router = inject(Router);

  readonly ocupado = signal(false);

  constructor() {
    addIcons({ openOutline, warningOutline });
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.profile.refresh();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  /**
   * Abre los ajustes de seguridad de Google en el navegador del sistema.
   *
   * Fuera de la app a propósito: es la cuenta de Google del usuario y se
   * gestiona en Google, con su barra de direcciones a la vista. Una pantalla
   * nuestra que se pareciera a esa sería justo lo que enseñamos a no creerse.
   */
  async abrirSeguridadDeGoogle(): Promise<void> {
    await Browser.open({ url: 'https://myaccount.google.com/security' });
  }

  async cerrarTodasLasSesiones(): Promise<void> {
    const alerta = await this.alerts.create({
      header: 'Cerrar todas las sesiones',
      message:
        'Se cerrará la sesión en todos los dispositivos, incluido este. Tus bots siguen corriendo: esto solo corta el acceso.',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Cerrar todas',
          role: 'destructive',
          handler: () => {
            void (async () => {
              this.ocupado.set(true);
              try {
                await this.auth.signOutEverywhere();
                await this.toast.success('Sesiones cerradas. Vuelve a entrar.');
              } catch (e) {
                await this.toast.error(errorText(e));
              } finally {
                this.ocupado.set(false);
              }
            })();
          },
        },
      ],
    });
    await alerta.present();
  }

  // ── Borrar la cuenta ────────────────────────────────────────────

  /**
   * Borra la cuenta, con reautenticación por delante.
   *
   * El permiso lo deja el paso por Google y el servidor lo consume al borrar:
   * un token de acceso robado —quince minutos de vida, sin revalidar contra la
   * base de datos— no puede bastar para vaciar una cuenta.
   */
  async borrarCuenta(): Promise<void> {
    if (!(await this.reautenticarSiHaceFalta())) return;

    const alerta = await this.alerts.create({
      header: 'Borrar la cuenta',
      message:
        'Se borra todo: bots, conexiones e histórico. Los bots activos se paran antes. Las posiciones abiertas en el exchange NO se cierran: hazlo tú antes si quieres cerrarlas.',
      inputs: [{ name: 'confirm', type: 'text', placeholder: 'Escribe ELIMINAR' }],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Borrar',
          role: 'destructive',
          handler: (datos: { confirm: string }) => {
            void this.confirmarBorrado((datos.confirm ?? '').trim().toUpperCase());
          },
        },
      ],
    });
    await alerta.present();
  }

  private async confirmarBorrado(confirm: string): Promise<void> {
    try {
      const { stoppedBots } = await this.profile.remove(confirm);
      await this.toast.warn(
        stoppedBots > 0 ? `Cuenta borrada. Se pararon ${stoppedBots} bot(s).` : 'Cuenta borrada.',
      );
      await this.auth.signOut();
      await this.router.navigateByUrl('/auth/login', { replaceUrl: true });
    } catch (e) {
      // Si la reautenticación caducó entre medias, se vuelve a pedir en lugar
      // de soltar un error que el usuario no sabría qué hacer con él.
      if (parseHttpError(e).code === 'STEP_UP_REQUIRED') {
        await this.auth.startStepUp('/security');
        return;
      }
      await this.toast.error(errorText(e));
    }
  }

  /**
   * Se asegura de que hay una reautenticación reciente.
   *
   * Devuelve false cuando ha tenido que mandar al usuario a Google: la app se
   * va, y al volver por `/auth/callback` el enrutador lo devuelve aquí con el
   * permiso ya concedido.
   *
   * Se avisa antes de salir. Mandar a alguien a una pantalla de Google sin
   * decirle por qué es justo el reflejo que no conviene enseñarle a nadie que
   * custodia claves capaces de operar con dinero.
   */
  private async reautenticarSiHaceFalta(): Promise<boolean> {
    try {
      if (await this.auth.hasFreshStepUp()) return true;
    } catch {
      // Si no se puede consultar, se pide igualmente: pedirla de más cuesta un
      // paso; darla por buena sin comprobarla se salta el control entero.
    }

    const alerta = await this.alerts.create({
      header: 'Confirma que eres tú',
      message:
        'Borrar la cuenta es irreversible. Te llevamos a Google para comprobar tu identidad y vuelves aquí enseguida.',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Continuar con Google',
          handler: () => {
            void this.auth.startStepUp('/security');
          },
        },
      ],
    });
    await alerta.present();
    return false;
  }
}
