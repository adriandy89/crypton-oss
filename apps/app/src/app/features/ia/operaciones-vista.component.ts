import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { IonSpinner } from '@ionic/angular/standalone';
import type { ListaOperaciones } from '@crypton/shared';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText } from '../../core/utils';
import { reloj } from '../../core/utils/agentes-ia';
import { UiCardComponent, UiNoticeComponent } from '../../shared/ui';
import { OperacionFilaComponent } from './operacion-fila.component';

/**
 * Las operaciones de todos los agentes (spec 074): las vivas, con cómo van y
 * lo que propone su seguimiento, y las últimas terminadas.
 */
@Component({
  selector: 'app-ia-operaciones',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonSpinner, UiCardComponent, UiNoticeComponent, OperacionFilaComponent],
  template: `
    @if (error(); as e) {
      <ui-notice tone="danger">{{ e }}</ui-notice>
    }
    @if (lista(); as l) {
      <h3 class="ia-sec">Vivas</h3>
      @if (l.vivas.length) {
        <ui-card flush>
          @for (p of l.vivas; track p.id) {
            <app-operacion-fila [propuesta]="p" [ahora]="ahora()" (cambiado)="cargar()" />
          }
        </ui-card>
        <p class="ia-nota">
          El R va sobre el riesgo con el que se entró y sin comisiones; el resultado, con ellas. El
          stop y los objetivos están en el exchange: no dependen de esta app ni del modelo.
        </p>
      } @else {
        <p class="ia-nota">Ninguna operación abierta.</p>
      }

      <h3 class="ia-sec">Terminadas</h3>
      @if (l.terminadas.length) {
        <ui-card flush>
          @for (p of l.terminadas; track p.id) {
            <app-operacion-fila [propuesta]="p" [ahora]="ahora()" (cambiado)="cargar()" />
          }
        </ui-card>
      } @else {
        <p class="ia-nota">Aún ninguna.</p>
      }
    } @else if (!error()) {
      <div class="center"><ion-spinner name="crescent" /></div>
    }
  `,
})
export class IaOperacionesComponent implements OnInit {
  private readonly servicio = inject(AgentesIaService);
  private readonly destroyRef = inject(DestroyRef);

  readonly lista = signal<ListaOperaciones | null>(null);
  readonly error = signal<string | null>(null);
  readonly ahora = reloj();

  private turno = 0;

  ngOnInit(): void {
    void this.cargar();
    this.servicio.cambios
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.cargar());
  }

  async cargar(): Promise<void> {
    const t = ++this.turno;
    try {
      const l = await this.servicio.operaciones();
      if (t !== this.turno) return;
      this.lista.set(l);
      this.error.set(null);
    } catch (e) {
      if (t === this.turno) this.error.set(errorText(e));
    }
  }
}
