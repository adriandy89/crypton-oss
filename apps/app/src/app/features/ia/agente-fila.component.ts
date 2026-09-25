import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AgenteVista } from '@crypton/shared';
import { money, shortDate, venueLabel } from '../../core/utils';
import { INSIGNIA_AGENTE, MOTIVO_PAUSA, textoDe } from '../../core/utils/agentes-ia';
import { UiBadgeComponent } from '../../shared/ui';

/** Cuántos pares se nombran en la fila de un agente; el resto se cuenta. */
const PARES_A_LA_VISTA = 4;

/** Un agente en una lista (spec 074): su pastilla, su cuenta y su día. */
@Component({
  selector: 'app-agente-fila',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiBadgeComponent],
  template: `
    @let a = agente();
    <a class="ag" [routerLink]="['/ia/agentes', a.id]">
      <div class="l1">
        <span class="nom">{{ a.nombre }}</span>
        <ui-badge size="sm" [tone]="insignia().tono" [attr.title]="insignia().porQue || null">
          {{ insignia().texto }}
        </ui-badge>
        @if (a.cuenta.real) {
          <ui-badge size="sm" tone="down" variant="outline">dinero real</ui-badge>
        } @else if (a.cuenta.simulacion) {
          <ui-badge size="sm" tone="warn">simulación</ui-badge>
        } @else {
          <ui-badge size="sm" tone="warn" variant="outline">testnet</ui-badge>
        }
      </div>
      <p class="l2">
        {{ venueLabel(a.cuenta.venue) }} · {{ pares() }} · {{ a.intervalo }} ·
        {{ a.modo === 'REGLAS' ? 'reglas' : 'IA' }}
      </p>
      <p class="l2 num">
        {{ a.vivas }} {{ a.vivas === 1 ? 'viva' : 'vivas' }} · {{ a.pendientes }} esperando ·
        {{ a.consultasHoy }} consultas hoy ({{ money(a.costeHoy, 3) }} $)
        @if (a.motivoPausa) {
          · {{ textoDe(MOTIVO_PAUSA, a.motivoPausa) }}
        } @else if (a.proximaRonda && a.estado === 'ACTIVO') {
          · próxima ronda {{ shortDate(a.proximaRonda) }}
        }
      </p>
    </a>
  `,
  styles: [
    `
      :host {
        display: block;
        border-bottom: 1px solid rgba(46, 43, 82, 0.6);
      }

      :host(:last-child) {
        border-bottom: 0;
      }

      .ag {
        display: block;
        padding: var(--space-3);
        color: inherit;
        text-decoration: none;
      }

      .l1 {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }

      .nom {
        font-size: 14px;
        font-weight: 600;
      }

      .l2 {
        margin: 3px 0 0;
        font-size: 11.5px;
        color: var(--text-3);
      }
    `,
  ],
})
export class AgenteFilaComponent {
  readonly agente = input.required<AgenteVista>();

  readonly venueLabel = venueLabel;
  readonly money = money;
  readonly shortDate = shortDate;
  readonly textoDe = textoDe;
  readonly MOTIVO_PAUSA = MOTIVO_PAUSA;

  readonly insignia = computed(() => INSIGNIA_AGENTE[this.agente().insignia]);

  readonly pares = computed(() => {
    const p = this.agente().pares;
    const vista = p.slice(0, PARES_A_LA_VISTA).join(', ');
    const resto = p.length - PARES_A_LA_VISTA;
    return resto > 0 ? `${vista} y ${resto} más` : vista;
  });
}
