import { Component, computed, input } from '@angular/core';
import { LIQ_METER, liqNum, liqTone } from '../../core/utils/risk';
import { money } from '../../core/utils/format';
import { UiMeterComponent } from './ui-meter.component';

/**
 * La distancia a liquidación como fila: rótulo, barra y cifra.
 *
 * Existe para que el mismo riesgo se pinte igual en la lista, la cartera, el
 * detalle y el gráfico. Antes cada pantalla repetía los cuatro parámetros de la
 * barra y su propio ternario para el color de la cifra, y en la frontera exacta
 * del 10 % la barra y la cifra decían cosas distintas. Aquí no hay umbral
 * alguno: todos viven en `core/utils/risk.ts`.
 *
 * El número que recibe es el del servidor (`liquidationDistancePct`) o, en el
 * gráfico, el mismo cálculo compartido sobre el precio vivo. Este componente no
 * calcula nada: pinta.
 */
@Component({
  selector: 'ui-liq-meter',
  standalone: true,
  imports: [UiMeterComponent],
  template: `
    @if (num(); as d) {
      <span class="lab">{{ label() }}</span>
      <ui-meter
        [segments]="[{ value: d, tone: 'up' }]"
        [total]="meter.total"
        [invert]="meter.invert"
        [warnAt]="meter.warnAt"
        [dangerAt]="meter.dangerAt"
        label="Distancia a la liquidación"
      />
      <span class="d num" [class]="'d num c-' + tone()">{{ money(d, 1) }} %</span>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        gap: 9px;
        width: 100%;
      }

      /* Sin distancia no hay fila: el host no ocupa hueco. */
      :host:empty {
        display: none;
      }

      .lab {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--text-3);
      }

      ui-meter {
        flex-grow: 1;
      }

      .d {
        flex-shrink: 0;
        font-size: 12px;
        font-weight: 700;
      }
    `,
  ],
})
export class UiLiqMeterComponent {
  /** La distancia en %, tal y como viaja: cadena, o número si ya se calculó. */
  readonly pct = input.required<string | number | null | undefined>();
  readonly label = input<string>('Liquidación');

  readonly meter = LIQ_METER;
  readonly money = money;
  readonly num = computed(() => liqNum(this.pct()));
  readonly tone = computed(() => liqTone(this.pct()));
}
