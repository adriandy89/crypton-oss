import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonButton, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, archiveOutline, hardwareChipOutline } from 'ionicons/icons';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { UiCardComponent, UiCollapsibleComponent, UiEmptyStateComponent } from '../../shared/ui';
import { AgenteFilaComponent } from './agente-fila.component';

/**
 * Los agentes del administrador (spec 074), con su pastilla y su día. El
 * resumen ya lo tiene `AgentesIaService`: esta vista no pide nada.
 */
@Component({
  selector: 'app-ia-agentes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IonButton,
    IonIcon,
    IonSpinner,
    UiCardComponent,
    UiCollapsibleComponent,
    UiEmptyStateComponent,
    AgenteFilaComponent,
  ],
  template: `
    <div class="cab">
      <ion-button size="small" routerLink="/ia/agentes/nuevo">
        <ion-icon slot="start" name="add-outline" />
        Nuevo agente
      </ion-button>
    </div>

    @if (servicio.resumen(); as r) {
      @if (activos().length === 0) {
        <ui-empty-state title="Ningún agente todavía" icon="hardware-chip-outline">
          <p>
            Un agente mira los pares que le elijas cada intervalo, te propone operaciones y les da
            seguimiento. Puedes empezar en la cuenta de simulación para verlo trabajar.
          </p>
        </ui-empty-state>
      } @else {
        <ui-card flush>
          @for (a of activos(); track a.id) {
            <app-agente-fila [agente]="a" />
          }
        </ui-card>
      }
      @if (archivados().length) {
        <ui-collapsible title="Archivados" [count]="archivados().length" icon="archive-outline">
          <ui-card flush>
            @for (a of archivados(); track a.id) {
              <app-agente-fila [agente]="a" />
            }
          </ui-card>
        </ui-collapsible>
      }
      <p class="pie">Como mucho {{ r.maxPares }} pares por agente.</p>
    } @else {
      <div class="center"><ion-spinner name="crescent" /></div>
    }
  `,
  styles: [
    `
      .cab {
        display: flex;
        justify-content: flex-end;
        margin-bottom: var(--space-2);
      }

      .pie {
        margin: var(--space-3) 0 0;
        font-size: 11px;
        color: var(--text-3);
      }
    `,
  ],
})
export class IaAgentesComponent {
  readonly servicio = inject(AgentesIaService);

  readonly activos = computed(() =>
    (this.servicio.resumen()?.agentes ?? []).filter((a) => a.estado !== 'ARCHIVADO'),
  );
  readonly archivados = computed(() =>
    (this.servicio.resumen()?.agentes ?? []).filter((a) => a.estado === 'ARCHIVADO'),
  );

  constructor() {
    addIcons({ addOutline, archiveOutline, hardwareChipOutline });
  }
}
