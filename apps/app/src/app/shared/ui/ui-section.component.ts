import { Component, input } from '@angular/core';

/** Cabecera de bloque. Antes eran `h2.section` sueltos con tamanos distintos. */
@Component({
  selector: 'ui-section',
  standalone: true,
  template: `
    <h2>{{ title() }}</h2>
    <ng-content />
  `,
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: var(--space-2) 2px var(--space-1);
      }

      h2 {
        margin: 0;
        font-family: var(--font-display);
        font-size: 14px;
        font-weight: 700;
        letter-spacing: -0.015em;
      }
    `,
  ],
})
export class UiSectionComponent {
  readonly title = input.required<string>();
}
