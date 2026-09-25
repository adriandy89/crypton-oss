import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { PlanAgente } from '@crypton/shared';
import { money, price, qty } from '../../core/utils';
import { porcentaje, rTexto } from '../../core/utils/agentes-ia';

/**
 * El plan de una operación de un agente, para una persona (spec 074): lo que
 * se abriría —o se abrió— con todos sus números. Lo calculó el motor; aquí
 * solo se enseña. Con `ahora`, al lado va el plan recalculado al aprobar, que
 * es el que de verdad llevó el bot.
 */
@Component({
  selector: 'app-plan-resumen',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (plan(); as p) {
      <dl class="ia-kv">
        <dt>Entrada, como mucho</dt>
        <dd class="num">
          {{ price(p.entradaTope) }}{{ cambio(p.entradaTope, final()?.entradaTope) }}
        </dd>
        <dt>Stop</dt>
        <dd class="num">
          {{ price(p.stop) }} · {{ porcentaje(p.distanciaStop * 100)
          }}{{ cambio(p.stop, final()?.stop) }}
        </dd>
        @for (o of p.objetivos; track $index) {
          <dt>Objetivo {{ $index + 1 }}</dt>
          <dd class="num">{{ price(o.precio) }} · {{ qty(o.cantidad) }}</dd>
        }
        <dt>Tamaño</dt>
        <dd class="num">{{ qty(p.cantidad) }} · {{ money(p.nocional) }} de nocional</dd>
        <dt>Apalancamiento</dt>
        <dd class="num">{{ p.apalancamiento }}× aislado · margen {{ money(p.margen) }}</dd>
        <dt>Riesgo (1 R)</dt>
        <dd class="num">
          {{ money(p.riesgo) }} · {{ porcentaje(p.riesgoPctCapital) }} del capital
        </dd>
        <dt>Si se cumple</dt>
        <dd class="num">{{ rTexto(p.rNeto) }} con costes</dd>
        <dt>Liquidación</dt>
        <dd class="num">
          {{ p.liquidacionEstimada ? price(p.liquidacionEstimada) : '—' }}
        </dd>
        <dt>Duración máxima</dt>
        <dd>{{ duracion() }}</dd>
        <dt>Tras el primer objetivo</dt>
        <dd>{{ p.breakevenTrasTp1 ? 'stop a la entrada' : 'el stop no se mueve' }}</dd>
      </dl>
    }
  `,
})
export class PlanResumenComponent {
  readonly plan = input.required<PlanAgente | null>();
  /** El recalculado al aprobar, si lo hay: se enseña lo que cambió. */
  readonly final = input<PlanAgente | null>(null);

  readonly price = price;
  readonly qty = qty;
  readonly money = money;
  readonly porcentaje = porcentaje;
  readonly rTexto = rTexto;

  readonly duracion = computed(() => {
    const m = this.plan()?.maxMinutos ?? 0;
    if (m <= 0) return '—';
    if (m % 1440 === 0) return `${m / 1440} d`;
    if (m % 60 === 0) return `${m / 60} h`;
    return `${m} min`;
  });

  /** « → 100.3» si al aprobar cambió. */
  cambio(antes: string, despues: string | undefined): string {
    return despues && despues !== antes ? ` → ${price(despues)}` : '';
  }
}
