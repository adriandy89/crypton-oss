import { ChangeDetectionStrategy, Component } from '@angular/core';
import { UiNoticeComponent } from '../../shared/ui/ui-notice.component';

/**
 * Lo que se enseña cuando el SERVIDOR dice que no.
 *
 * El `adminGuard` de la app es comodidad: decide con el rol que viaja dentro del
 * token que guarda este navegador, y ese token puede tener hasta quince minutos.
 * Quien manda es el `RolesGuard` de la API. Cuando los dos no coinciden —a
 * alguien le acaban de quitar el rol, o le acaban de dar uno y aun no ha
 * renovado— la pantalla tiene que decirlo en vez de quedarse en blanco.
 *
 * En un componente y no copiado en cada pagina porque son seis, y seis copias de
 * un aviso son seis textos que se desalinean.
 */
@Component({
  selector: 'app-admin-forbidden',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiNoticeComponent],
  template: `
    <ui-notice tone="danger" icon="warning-outline">
      El servidor no reconoce esta sesión como administrador. Cierra sesión y vuelve a entrar; si
      sigue pasando, el rol de la cuenta ha cambiado.
    </ui-notice>
  `,
})
export class AdminForbiddenComponent {}
