import { Component, input } from '@angular/core';

/**
 * Un par etiqueta/cifra. Se repetia en portfolio, bots-list, leaderboard,
 * bot-detail, bot-create y plan, siempre como `.k` + `.v` con tamanos
 * ligeramente distintos en cada sitio.
 *
 * `tone` acepta lo que devuelve pnlColor(): 'success' | 'danger' | 'medium'.
 */
@Component({
  selector: 'ui-stat',
  standalone: true,
  template: `
    <span class="k">{{ label() }}</span>
    <span class="v num" [class]="tone() ? 'c-' + tone() : ''">{{ value() }}</span>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }

      .k {
        font-size: 10.5px;
        line-height: 1.3;
        color: var(--text-3);
      }

      /* La cifra manda sobre la caja: en una rejilla de cuatro columnas a 360 px
         un «+1.234,56» mide mas que su columna, y sin esto se salia por encima
         del borde de la tarjeta en vez de partir. Partir un numero es feo;
         verlo pisar el borde de al lado es peor, y ademas engana sobre a que
         etiqueta pertenece. */
      .v {
        font-size: 14px;
        font-weight: 700;
        line-height: 1.25;
        letter-spacing: -0.015em;
        overflow-wrap: anywhere;
      }

      :host([size='lg']) .k {
        font-size: 11px;
      }

      :host([size='lg']) .v {
        font-size: 17px;
      }
    `,
  ],
})
export class UiStatComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string | number>();
  /** '' para el color de texto normal. */
  readonly tone = input<string>('');
}
