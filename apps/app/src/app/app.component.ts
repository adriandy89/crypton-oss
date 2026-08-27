import { Component, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Capacitor } from '@capacitor/core';
import { AuthService, oauthFlow } from './core/auth';
import { NetworkService, StreamService } from './core/services';
// Del FICHERO y no del barril `./shared/ui`.
//
// Este componente es la raiz y va en el paquete inicial, asi que importar el
// barril arrastraba alli los quince componentes compartidos —incluidos los tres
// del asistente, que solo necesita una ruta perezosa— y los pagaba todo el
// mundo en el primer arranque.
import { UiNetworkBannerComponent } from './shared/ui/ui-network-banner.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [IonApp, IonRouterOutlet, UiNetworkBannerComponent],
  template: `
    <ion-app>
      <!--
        El aviso de testnet va AQUI, encima del outlet, y no dentro de la barra
        de cada pantalla: no hay cabecera compartida en esta app, asi que en la
        barra habria que repetirlo en catorce sitios y una pantalla nueva
        naceria sin el. Puesto una vez, no puede faltar en ninguna.
      -->
      @if (network.testnet()) {
        <ui-network-banner />
      }
      <ion-router-outlet />
    </ion-app>
  `,
})
export class AppComponent {
  private readonly auth = inject(AuthService);
  private readonly stream = inject(StreamService);
  /** Publico: lo lee la plantilla para decidir si pinta la franja. */
  readonly network = inject(NetworkService);
  private readonly router = inject(Router);

  constructor() {
    void this.initNative();
    this.escucharVueltaDeGoogle();

    // El flujo de eventos se engancha y se suelta con la sesión: mantenerlo
    // abierto sin usuario solo generaría reconexiones fallidas en bucle.
    effect(() => {
      if (this.auth.isAuthenticated()) this.stream.connect();
      else this.stream.disconnect();
    });
  }

  /**
   * La vuelta del acceso con Google en el móvil.
   *
   * La API redirige al enlace profundo de la app; Android lo entrega aquí y no
   * como una navegación del enrutador, así que hay que traducirlo a una ruta.
   * En web no hace falta: la vuelta es una navegación normal a
   * `/auth/callback`, que resuelve el propio enrutador.
   */
  private escucharVueltaDeGoogle(): void {
    oauthFlow.escucharVuelta(({ ticket, error }) => {
      void this.router.navigate(['/auth/callback'], {
        queryParams: { ...(ticket ? { ticket } : {}), ...(error ? { error } : {}) },
        replaceUrl: true,
      });
    });
  }

  private async initNative(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setBackgroundColor({ color: '#141328' });
    } catch {
      // Sin barra de estado (o plugin no disponible): no es motivo de fallo.
    }
    // Se oculta el splash cuando la app YA ha pintado: hacerlo antes deja un
    // parpadeo entre el splash nativo y el WebView.
    await SplashScreen.hide().catch(() => undefined);
  }
}
