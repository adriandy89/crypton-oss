import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { chevronForwardOutline } from 'ionicons/icons';

/**
 * Fila de ajuste con icono, titulo, explicacion y hueco al final.
 *
 * Sustituye al trio `ion-item button` + `ion-icon slot="start"` +
 * `ion-label` con h3/p de account, risk y profile. El `routerLink` se pone
 * sobre la propia etiqueta `<ui-setting-row>` desde la pagina.
 */
@Component({
  selector: 'ui-setting-row',
  standalone: true,
  imports: [IonIcon],
  template: `
    @if (icon()) {
      <div class="ico"><ion-icon [name]="icon()" /></div>
    }
    <div class="id">
      <h4>{{ title() }}</h4>
      @if (subtitle()) {
        <p>{{ subtitle() }}</p>
      }
    </div>
    <ng-content />
    @if (link()) {
      <ion-icon class="chev" name="chevron-forward-outline" />
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        /* Mismo relleno lateral que la tarjeta que las contiene: estas filas
           viven dentro de una tarjeta sin relleno propio, y con 15 px caian un
           pixel adentro respecto del texto de la tarjeta de arriba. */
        padding: 13px var(--space-4);
        /* 56px de alto minimo: por debajo de 44 px un objetivo tactil falla. */
        min-height: 56px;
        cursor: pointer;
      }

      :host + :host {
        border-top: 1px solid var(--border-subtle);
      }

      .ico {
        flex-shrink: 0;
        width: 34px;
        height: 34px;
        border-radius: 11px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--surface-2);
        color: var(--text-2);
      }

      .ico ion-icon {
        font-size: 18px;
      }

      .id {
        flex-grow: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      h4 {
        margin: 0;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--text-1);
      }

      p {
        margin: 0;
        font-size: 11.5px;
        line-height: 1.4;
        color: var(--text-3);
      }

      .chev {
        flex-shrink: 0;
        font-size: 17px;
        color: var(--text-3);
      }
    `,
  ],
})
export class UiSettingRowComponent {
  constructor() {
    // El chevron es del propio componente, asi que lo registra el, no la pagina.
    addIcons({ chevronForwardOutline });
  }

  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
  readonly icon = input<string>('');
  /** Solo controla si se pinta el chevron; la navegacion la pone la pagina. */
  readonly link = input<boolean>(true);
}
