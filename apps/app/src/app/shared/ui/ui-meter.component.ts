import { Component, computed, input } from '@angular/core';

export type MeterTone = 'up' | 'down' | 'warn' | 'brand' | 'neutral';

export interface MeterSegment {
  value: number;
  tone: MeterTone;
  label?: string;
}

/**
 * Una barra. Para un escalar sobre un techo y para repartos de dos a cuatro
 * partes. Es la misma pista de cinco pixeles de `ui-risk-meter`, sacada a un
 * componente para que el consumo de un limite, la distancia a liquidacion y el
 * reparto maker/taker se pinten igual en todas las pantallas.
 *
 * Dos modos, por `total`:
 *
 *   - Con `total`: el primer segmento es un consumo sobre ese techo, y mandan
 *     los UMBRALES. Los de la liquidacion viven en `core/utils/risk.ts` y los
 *     pinta `ui-liq-meter`; aqui solo se compara. La comparacion es ESTRICTA
 *     (`>`), y no es un detalle: con `>=` la barra se ponia en rojo a un 10,00 %
 *     exacto mientras la cifra de al lado —que usa `<`— seguia en ambar.
 *   - Sin `total`: los segmentos SON el total y se reparten el ancho. Es lo que
 *     sustituye al donut de maker/taker: dos donuts contiguos no se comparan en
 *     paralelo, dos barras si, y a 360 px un donut pierde la etiqueta.
 *
 * `invert` da la vuelta al semaforo para los medidores en los que MAS es
 * mejor —la distancia a liquidacion—, donde el peligro esta en el tramo bajo.
 */
@Component({
  selector: 'ui-meter',
  standalone: true,
  template: `
    <div
      class="track"
      role="meter"
      [attr.aria-label]="label()"
      [attr.aria-valuenow]="valueNow()"
      [attr.aria-valuemin]="0"
      [attr.aria-valuemax]="valueMax()"
    >
      @for (s of shown(); track $index) {
        <i [attr.data-tone]="s.tone" [style.width.%]="s.width"></i>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
      }

      .track {
        display: flex;
        gap: 2px;
        height: 5px;
        border-radius: 999px;
        background: var(--surface-3);
        overflow: hidden;
      }

      i {
        display: block;
        height: 100%;
        border-radius: 999px;
        transition: width 0.25s ease;
      }

      i[data-tone='up'] {
        background: var(--pnl-up);
      }
      i[data-tone='down'] {
        background: var(--pnl-down);
      }
      i[data-tone='warn'] {
        background: var(--signal-warn);
      }
      i[data-tone='brand'] {
        background: var(--brand-2);
      }
      /* Escalon de la rampa de Ionic, no un gris inventado: es el mismo que usa
         la leyenda del grafico para lo apagado. */
      i[data-tone='neutral'] {
        background: #4a4479;
      }
    `,
  ],
})
export class UiMeterComponent {
  readonly segments = input.required<readonly MeterSegment[]>();
  /** Techo. `null` = los segmentos son el total. */
  readonly total = input<number | null>(null);
  readonly warnAt = input<number>(0.75);
  readonly dangerAt = input<number>(0.9);
  /** Con `total`: true si MAS es mejor (distancia a liquidacion). */
  readonly invert = input<boolean>(false);
  readonly label = input.required<string>();

  /** Suma de lo que hay. En modo consumo, el consumo; en reparto, la suma de las partes. */
  private readonly suma = computed(() =>
    this.segments().reduce((a, s) => a + Math.max(s.value, 0), 0),
  );

  readonly valueNow = computed(() => {
    const t = this.total();
    return t !== null ? (this.segments()[0]?.value ?? 0) : this.suma();
  });

  /**
   * El maximo que se anuncia: el techo, o la suma de las partes en un reparto.
   * Antes era 100 fijo y un reparto de 120 + 30 se anunciaba como «150 de 100».
   */
  readonly valueMax = computed(() => this.total() ?? this.suma());

  readonly shown = computed(() => {
    const segs = this.segments();
    const t = this.total();

    if (t !== null) {
      const v = segs[0]?.value ?? 0;
      const ratio = t > 0 ? Math.min(Math.max(v / t, 0), 1) : 0;
      // El nivel que decide el color: el consumo, o lo que queda si mas es mejor.
      const nivel = this.invert() ? 1 - ratio : ratio;
      const tone: MeterTone =
        nivel > this.dangerAt()
          ? 'down'
          : nivel > this.warnAt()
            ? 'warn'
            : (segs[0]?.tone ?? 'brand');
      return [{ tone, width: ratio * 100 }];
    }

    const suma = this.suma();
    if (suma <= 0) return [];
    return segs
      .filter((s) => s.value > 0)
      .map((s) => ({ tone: s.tone, width: (s.value / suma) * 100 }));
  });
}
