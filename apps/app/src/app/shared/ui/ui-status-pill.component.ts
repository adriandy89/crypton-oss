import { Component, computed, input } from '@angular/core';
import type { BotStatus } from '../../core/models';
import { botStatusLabel, botStatusTone } from '../../core/utils';

/**
 * El estado de un bot, con su punto de color.
 *
 * Sustituye al `<ion-badge [color]="statusColor(...)">` que estaba copiado en
 * bots-list, portfolio y bot-detail, cada uno con su propio switch.
 */
@Component({
  selector: 'ui-status-pill',
  standalone: true,
  template: `
    <i></i>
    <span>{{ label() }}</span>
  `,
  host: { '[attr.data-tone]': 'tone()' },
  styles: [
    `
      /* La geometria es la de <ui-badge> y no una propia: las dos pastillas
         salen juntas en la misma fila —estado y red— y basta medio pixel de
         diferencia de alto para que se vea que no estan alineadas. */
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        flex-shrink: 0;
        box-sizing: border-box;
        min-height: 22px;
        padding: 5px 10px;
        border: 1px solid transparent;
        border-radius: var(--radius-pill);
        font-family: var(--font-ui);
        font-size: 11px;
        font-weight: 700;
        /* Sin esto la pastilla hereda el interlineado de quien la contiene y
           crece por debajo del texto: dentro de un parrafo a 1.6 la palabra
           quedaba pegada al borde de arriba. */
        line-height: 1;
        white-space: nowrap;
      }

      i {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: currentColor;
        flex-shrink: 0;
      }

      :host([data-tone='up']) {
        color: var(--pnl-up);
        background: rgba(var(--pnl-up-rgb), 0.14);
      }

      :host([data-tone='down']) {
        color: var(--pnl-down);
        background: rgba(var(--pnl-down-rgb), 0.14);
      }

      :host([data-tone='warn']) {
        color: var(--signal-warn);
        background: rgba(var(--signal-warn-rgb), 0.14);
      }

      :host([data-tone='brand']) {
        color: var(--brand-2);
        background: rgba(var(--brand-2-rgb), 0.16);
      }

      :host([data-tone='flat']) {
        color: var(--text-2);
        background: var(--surface-3);
      }

      /* Liquidado es terminal y se ha perdido el margen: relleno solido para
         que no se lea como un estado mas de la lista. */
      :host([data-tone='critical']) {
        color: var(--surface-base);
        background: var(--pnl-down);
      }
    `,
  ],
})
export class UiStatusPillComponent {
  readonly status = input.required<BotStatus>();
  readonly label = computed(() => botStatusLabel(this.status()));
  readonly tone = computed(() => botStatusTone(this.status()));
}
