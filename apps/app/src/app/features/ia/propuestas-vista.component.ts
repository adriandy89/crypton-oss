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
import type { ListaPropuestas } from '@crypton/shared';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText } from '../../core/utils';
import { reloj } from '../../core/utils/agentes-ia';
import { UiCardComponent, UiEmptyStateComponent, UiNoticeComponent } from '../../shared/ui';
import { PropuestaFilaComponent } from './propuesta-fila.component';

/**
 * Las propuestas de todos los agentes (spec 074): las que esperan a una
 * persona, por lo que les queda, y las últimas decididas o medidas.
 */
@Component({
  selector: 'app-ia-propuestas',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonSpinner,
    UiCardComponent,
    UiEmptyStateComponent,
    UiNoticeComponent,
    PropuestaFilaComponent,
  ],
  template: `
    @if (error(); as e) {
      <ui-notice tone="danger">{{ e }}</ui-notice>
    }
    @if (lista(); as l) {
      <h3 class="ia-sec">Esperando</h3>
      @if (l.pendientes.length) {
        <ui-card flush>
          @for (p of l.pendientes; track p.id) {
            <app-propuesta-fila [propuesta]="p" [ahora]="ahora()" (cambiado)="cargar()" />
          }
        </ui-card>
      } @else {
        <p class="ia-nota">Nada esperando. Las propuestas llegan también por Telegram.</p>
      }

      <h3 class="ia-sec">Últimas</h3>
      @if (l.recientes.length) {
        <ui-card flush>
          @for (p of l.recientes; track p.id) {
            <app-propuesta-fila [propuesta]="p" [ahora]="ahora()" (cambiado)="cargar()" />
          }
        </ui-card>
      } @else if (!l.pendientes.length) {
        <ui-empty-state title="Aún no hay propuestas" icon="hardware-chip-outline">
          <p>Cuando un agente vea una operación que cumpla sus límites, aparecerá aquí.</p>
        </ui-empty-state>
      }
    } @else if (!error()) {
      <div class="center"><ion-spinner name="crescent" /></div>
    }
  `,
})
export class IaPropuestasComponent implements OnInit {
  private readonly servicio = inject(AgentesIaService);
  private readonly destroyRef = inject(DestroyRef);

  readonly lista = signal<ListaPropuestas | null>(null);
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
      const l = await this.servicio.propuestas();
      if (t !== this.turno) return;
      this.lista.set(l);
      this.error.set(null);
    } catch (e) {
      if (t === this.turno) this.error.set(errorText(e));
    }
  }
}
