import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IonInput } from '@ionic/angular/standalone';

/**
 * Un límite de un agente en su editor (spec 074): el campo, su ayuda y, si no
 * vale, por qué. El texto se deja tal cual lo escribe la persona —con coma o
 * con punto—; quien lo guarda lo convierte y lo valida.
 */
@Component({
  selector: 'app-limite-campo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonInput],
  template: `
    <div class="ia-campo">
      <ion-input
        [label]="nombre()"
        labelPlacement="stacked"
        inputmode="decimal"
        [value]="valor()"
        (ionInput)="cambio.emit(limpio($any($event.target).value))"
      />
      <p class="ia-ayuda">{{ ayuda() }}</p>
      @if (error()) {
        <p class="ia-err">{{ error() }}</p>
      }
    </div>
  `,
})
export class LimiteCampoComponent {
  readonly nombre = input.required<string>();
  readonly ayuda = input('');
  readonly valor = input('');
  readonly error = input('');
  readonly cambio = output<string>();

  /** La coma decimal de un teclado español, como punto: es lo que entiende `Decimal`. */
  limpio(v: unknown): string {
    const texto = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    return texto.trim().replace(',', '.');
  }
}
