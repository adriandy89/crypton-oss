import { Component, input } from '@angular/core';
import type { Mutability } from '../../core/models';

/**
 * HOT / WARM / COLD: cuanto cuesta cambiar un ajuste con el bot en marcha.
 * Es vocabulario de marca —se usa igual en la web— y por eso vive en un
 * componente y no en el SCSS de bot-detail, que es donde estaba.
 */
@Component({
  selector: 'ui-mutability-badge',
  standalone: true,
  template: '{{ level() }}',
  host: { '[attr.data-level]': 'level()' },
  styles: [
    `
      /* Misma caja que <ui-badge size="sm" caps square>. El relleno vertical
         sube de 3 a 4 px: con 3 px la mayuscula ocupaba casi todo el alto y la
         etiqueta se leia apretada al lado de un campo de formulario. Y el
         espaciado entre letras se le descuenta al lado de cierre, porque lo
         mete DESPUES de la ultima letra y descentraba la palabra. */
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        box-sizing: border-box;
        min-height: 19px;
        padding: 4px 8px;
        padding-inline-end: calc(8px - 0.08em);
        border-radius: var(--radius-xs);
        font-family: var(--font-ui);
        font-size: 10px;
        font-weight: 800;
        line-height: 1;
        letter-spacing: 0.08em;
        white-space: nowrap;
      }

      :host([data-level='HOT']) {
        color: var(--pnl-up);
        background: rgba(var(--pnl-up-rgb), 0.12);
      }

      :host([data-level='WARM']) {
        color: var(--signal-warn);
        background: rgba(var(--signal-warn-rgb), 0.12);
      }

      :host([data-level='COLD']) {
        color: var(--text-2);
        background: var(--surface-2);
      }
    `,
  ],
})
export class UiMutabilityBadgeComponent {
  readonly level = input.required<Mutability>();
}
