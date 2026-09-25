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
import type { ResultadosAgentes } from '@crypton/shared';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText } from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiCollapsibleComponent,
  UiEmptyStateComponent,
  UiNoticeComponent,
} from '../../shared/ui';
import { IaTarjetaComponent } from './tarjeta.component';

/**
 * Los resultados de los agentes (spec 074, R-25): lo de dinero real y lo
 * simulado, cada uno en su tarjeta y nunca sumados, y una por agente. Todo lo
 * que se propuso se mide, se tomara o no: por eso se puede decir si la IA
 * distingue lo bueno de lo malo y qué habría pasado con lo descartado.
 */
@Component({
  selector: 'app-ia-resultados',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonSpinner,
    UiBadgeComponent,
    UiCardComponent,
    UiCollapsibleComponent,
    UiEmptyStateComponent,
    UiNoticeComponent,
    IaTarjetaComponent,
  ],
  template: `
    @if (error(); as e) {
      <ui-notice tone="danger">{{ e }}</ui-notice>
    }
    @if (datos(); as d) {
      @if (!d.agentes.length) {
        <ui-empty-state title="Sin resultados todavía" icon="hardware-chip-outline">
          <p>Cuando tus agentes propongan y operen, aquí verás cómo les va.</p>
        </ui-empty-state>
      } @else {
        <p class="ia-nota">
          Cada propuesta, y cada operación que un agente tuvo delante, se mide aunque no se tome:
          qué habría pasado con su stop, su primer objetivo y su tiempo máximo, con costes. Lo real
          y lo simulado nunca se suman.
        </p>
        @if (d.real; as t) {
          <h3 class="ia-sec">Dinero real</h3>
          <ui-card><app-ia-tarjeta [tarjeta]="t" /></ui-card>
        }
        @if (d.simulado; as t) {
          <h3 class="ia-sec">Simulación y testnet</h3>
          <ui-card><app-ia-tarjeta [tarjeta]="t" /></ui-card>
        }
        <h3 class="ia-sec">Por agente</h3>
        @for (a of d.agentes; track a.agenteId) {
          <ui-collapsible [title]="a.nombre" icon="hardware-chip-outline">
            <div class="chips">
              <ui-badge size="sm" [tone]="a.real ? 'down' : 'warn'" variant="outline">
                {{ a.real ? 'dinero real' : 'simulado' }}
              </ui-badge>
              @if (a.archivado) {
                <ui-badge size="sm">archivado</ui-badge>
              }
            </div>
            <app-ia-tarjeta [tarjeta]="a.tarjeta" [consultas]="a.consultas" [coste]="a.coste" />
          </ui-collapsible>
        }
      }
    } @else if (!error()) {
      <div class="center"><ion-spinner name="crescent" /></div>
    }
  `,
  styles: [
    `
      .chips {
        display: flex;
        gap: 6px;
        margin-bottom: var(--space-2);
      }
    `,
  ],
})
export class IaResultadosComponent implements OnInit {
  private readonly servicio = inject(AgentesIaService);
  private readonly destroyRef = inject(DestroyRef);

  readonly datos = signal<ResultadosAgentes | null>(null);
  readonly error = signal<string | null>(null);

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
      const d = await this.servicio.resultados();
      if (t !== this.turno) return;
      this.datos.set(d);
      this.error.set(null);
    } catch (e) {
      if (t === this.turno) this.error.set(errorText(e));
    }
  }
}
