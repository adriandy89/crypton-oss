import { Component, inject } from '@angular/core';
import { IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { gridOutline, personOutline, pieChartOutline, statsChartOutline } from 'ionicons/icons';
import { StreamService } from '../core/services';

@Component({
  selector: 'app-tabs',
  standalone: true,
  imports: [IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel],
  template: `
    <!-- Sin <ion-router-outlet> dentro: en Ionic 8 <ion-tabs> ya ES el outlet.
         Declarar uno aparte crea un SEGUNDO outlet, vacio y posicionado sobre
         toda el area de las pestanas, que se come todos los toques: solo
         respondia la barra de abajo. -->
    <ion-tabs>
      <ion-tab-bar slot="bottom">
        <ion-tab-button tab="portfolio" href="/tabs/portfolio">
          <ion-icon name="pie-chart-outline" />
          <ion-label>Cartera</ion-label>
        </ion-tab-button>

        <!-- Mercados ocupa el sitio que tenia Ranking. Cinco pestanas ya
             aprietan en un movil, y de las dos, Mercados se mira varias veces
             al dia y es la puerta natural a crear un bot; el ranking se visita
             de vez en cuando. Sigue estando entero, en /leaderboard, y se
             entra desde Cuenta. -->
        <ion-tab-button tab="markets" href="/tabs/markets">
          <ion-icon name="stats-chart-outline" />
          <ion-label>Mercados</ion-label>
        </ion-tab-button>

        <ion-tab-button tab="bots" href="/tabs/bots">
          <ion-icon name="grid-outline" />
          <ion-label>Bots</ion-label>
          <!-- Punto de conexión del flujo en tiempo real. Si está apagado, los
               datos que se ven pueden estar desactualizados y conviene saberlo. -->
          <span class="dot" [class.live]="stream.connected()"></span>
        </ion-tab-button>

        <ion-tab-button tab="account" href="/tabs/account">
          <ion-icon name="person-outline" />
          <ion-label>Cuenta</ion-label>
        </ion-tab-button>
      </ion-tab-bar>
    </ion-tabs>
  `,
  styles: [
    `
      ion-tab-button {
        position: relative;
      }

      .dot {
        position: absolute;
        top: 5px;
        right: calc(50% - 22px);
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--text-3);
        transition:
          background 0.3s ease,
          box-shadow 0.3s ease;
      }

      .dot.live {
        background: var(--pnl-up);
        box-shadow: 0 0 7px var(--pnl-up);
      }
    `,
  ],
})
export class TabsPage {
  readonly stream = inject(StreamService);

  constructor() {
    addIcons({ pieChartOutline, statsChartOutline, gridOutline, personOutline });
  }
}
