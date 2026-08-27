import { Component, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';

/**
 * Pantalla vacia. Estaba repetida en bots-list, portfolio y leaderboard.
 *
 * Un estado vacio bien escrito es la mejor ocasion de explicar para que sirve
 * la pantalla, asi que el texto se proyecta entero desde la pagina.
 */
@Component({
  selector: 'ui-empty-state',
  standalone: true,
  imports: [IonIcon],
  template: `
    @if (icon()) {
      <ion-icon [name]="icon()" />
    }
    <h2>{{ title() }}</h2>
    <ng-content />
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: var(--space-3);
        padding: 56px 28px;
      }

      ion-icon {
        font-size: 40px;
        color: var(--text-3);
        margin-bottom: 2px;
      }

      h2 {
        margin: 0;
        font-family: var(--font-display);
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }

      :host ::ng-deep p {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--text-2);
        max-width: 30ch;
      }

      :host ::ng-deep ion-button {
        margin-top: var(--space-2);
      }
    `,
  ],
})
export class UiEmptyStateComponent {
  readonly title = input.required<string>();
  readonly icon = input<string>('');
}
