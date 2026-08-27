import { Component, computed, input, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';

/**
 * Seccion plegable con contador.
 *
 * Nace con el market maker V2, que tiene veintinueve parametros avanzados: en
 * una sola lista el usuario tiene que hacer scroll por veintinueve casillas
 * para llegar al boton de crear, y las cinco que de verdad va a tocar quedan
 * enterradas entre las que casi nadie cambia.
 *
 * El contador va en la cabecera a proposito. Plegado, un titulo suelto no dice
 * si detras hay dos ajustes o treinta, y esa diferencia es justo la que decide
 * si merece la pena abrirlo.
 */
@Component({
  selector: 'ui-collapsible',
  standalone: true,
  imports: [IonIcon],
  template: `
    <button type="button" class="head" (click)="toggle()" [attr.aria-expanded]="open()">
      <ion-icon [name]="icon()" class="lead" />
      <span class="title">{{ title() }}</span>
      @if (count() > 0) {
        <span class="count num">{{ count() }}</span>
      }
      <ion-icon [name]="open() ? 'chevron-up' : 'chevron-down'" class="chev" />
    </button>

    @if (open()) {
      <div class="body">
        <ng-content />
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        width: 100%;
        padding: 14px 0;
        background: none;
        border: 0;
        color: var(--text-1);
        font-family: inherit;
        font-size: 13.5px;
        font-weight: 600;
        cursor: pointer;
      }

      .lead {
        font-size: 17px;
        color: var(--brand-2);
        flex-shrink: 0;
      }

      .title {
        flex: 1;
        text-align: left;
      }

      .count {
        font-size: 12px;
        color: var(--text-3);
      }

      .chev {
        font-size: 15px;
        color: var(--text-3);
        flex-shrink: 0;
      }

      .body {
        padding-bottom: var(--space-2);
      }
    `,
  ],
})
export class UiCollapsibleComponent {
  readonly title = input('Más parámetros');
  readonly count = input(0);
  readonly icon = input('options-outline');
  /** Estado inicial. Los avanzados nacen plegados; una seccion clave, abierta. */
  readonly startOpen = input(false);

  private readonly manual = signal<boolean | null>(null);
  readonly open = computed(() => this.manual() ?? this.startOpen());

  toggle(): void {
    this.manual.set(!this.open());
  }
}
