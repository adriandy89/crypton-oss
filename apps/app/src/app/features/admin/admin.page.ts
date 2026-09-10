import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { gridOutline, peopleOutline, pulseOutline, trashOutline } from 'ionicons/icons';
import { UiCardComponent } from '../../shared/ui/ui-card.component';
import { UiNoticeComponent } from '../../shared/ui/ui-notice.component';
import { UiSettingRowComponent } from '../../shared/ui/ui-setting-row.component';

/**
 * El indice de administracion.
 *
 * No pide NADA. Se penso ponerle una franja con «usuarios activos / bots vivos /
 * fallos en 24 h» —el resumen de actividad ya existe— y se dejo fuera: un indice
 * que es puro enrutado no puede fallar, no necesita estado de carga ni manejo de
 * 403, y aparece instantaneo. En el momento en que pida datos hereda todos los
 * estados de las demas pantallas, y lo que gana es adorno.
 */
@Component({
  selector: 'app-admin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    UiCardComponent,
    UiNoticeComponent,
    UiSettingRowComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/tabs/account" text="" />
        </ion-buttons>
        <ion-title>Administración</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        <ui-notice tone="info" icon="information-circle-outline">
          Estas herramientas actúan sobre cuentas y bots de otras personas. Todo lo que se hace aquí
          queda en la bitácora, con tu nombre.
        </ui-notice>

        <ui-card flush>
          <ui-setting-row
            routerLink="/admin/activity"
            icon="pulse-outline"
            title="Actividad"
            subtitle="Qué ha pasado en la plataforma y qué ha fallado"
          />
          <ui-setting-row
            routerLink="/admin/users"
            icon="people-outline"
            title="Usuarios"
            subtitle="Buscar una cuenta, deshabilitarla o cerrarle las sesiones"
          />
          <ui-setting-row
            routerLink="/admin/bots"
            icon="grid-outline"
            title="Bots"
            subtitle="Todos los bots de la plataforma, y cómo contenerlos"
          />
          <ui-setting-row
            routerLink="/admin/maintenance"
            icon="trash-outline"
            title="Mantenimiento"
            subtitle="Qué ocupan los históricos y cómo purgar lo que ya no se usa"
          />
        </ui-card>
      </div>
    </ion-content>
  `,
})
export class AdminPage {
  constructor() {
    addIcons({ pulseOutline, peopleOutline, gridOutline, trashOutline });
  }
}
