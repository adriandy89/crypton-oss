import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';

/**
 * Banda de aviso. Reemplaza a `.liq`, `.err`, `.note`, `.worst`, `.issue`,
 * `.realwarn`, `.aviso-critico`, `.safe` y `.danger`, que eran nueve nombres
 * distintos para la misma caja de texto con un color de fondo.
 *
 * Los tonos NO son decorativos: `danger` significa dinero en riesgo ahora.
 */
@Component({
  selector: 'ui-notice',
  standalone: true,
  imports: [IonIcon],
  template: `
    @if (icon()) {
      <ion-icon [name]="icon()" />
    }
    <div class="body"><ng-content /></div>
  `,
  host: { '[attr.data-tone]': 'tone()' },
  styles: [
    `
      /* El relleno lateral es mayor que el radio de la esquina (12 px): con
         10/12 la primera letra de la segunda linea caia justo sobre la curva y
         el texto se veia pegado al borde de la banda. */
      :host {
        display: flex;
        align-items: flex-start;
        gap: 9px;
        min-width: 0;
        padding: 11px 14px;
        border-radius: var(--radius-sm);
        font-size: 12px;
        line-height: 1.5;
        /* Los avisos llevan a menudo un identificador de orden o un mensaje de
           error del exchange sin espacios: sin punto de corte se salian de la
           banda por el lado derecho. */
        overflow-wrap: anywhere;
      }

      ion-icon {
        flex-shrink: 0;
        font-size: 16px;
        margin-top: 1px;
      }

      .body {
        min-width: 0;
        flex-grow: 1;
      }

      :host([data-tone='info']) {
        background: var(--surface-2);
        color: var(--text-2);
      }

      :host([data-tone='ok']) {
        background: rgba(var(--pnl-up-rgb), 0.1);
        color: var(--pnl-up);
      }

      :host([data-tone='warn']) {
        background: rgba(var(--signal-warn-rgb), 0.1);
        color: var(--signal-warn);
      }

      :host([data-tone='danger']) {
        background: rgba(var(--pnl-down-rgb), 0.11);
        color: var(--pnl-down);
      }

      :host([data-tone='brand']) {
        background: rgba(var(--brand-rgb), 0.12);
        color: var(--text-1);
      }
    `,
  ],
})
export class UiNoticeComponent {
  readonly tone = input<'info' | 'ok' | 'warn' | 'danger' | 'brand'>('info');
  readonly icon = input<string>('');
}
