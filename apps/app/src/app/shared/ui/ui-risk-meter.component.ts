import { Component, computed, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import type { PreviewResult } from '../../core/models';
import { money, price } from '../../core/utils';
import { UiBadgeComponent } from './ui-badge.component';

/**
 * Riesgo de la configuracion actual, recalculado mientras se teclea.
 *
 * Lo que pinta NO es una aproximacion para la pantalla: sale de
 * `strategy.preview()`, la misma funcion pura que ejecuta el motor. La app
 * consume `@crypton/strategy-core` como fuente —lo dice el `paths` de su
 * `tsconfig.json`, con esta intencion escrita— asi que no hay una segunda
 * implementacion que pueda desviarse.
 *
 * Por que en local y no llamando a `POST /bots/preview` con rebote: un
 * deslizador emite unos treinta eventos por segundo, y ni con 300 ms de espera
 * se consigue que la cifra acompañe al pulgar. Ademas, `capital x
 * apalancamiento` MIENTE en martingala y GridMart —cada nivel escala el
 * volumen, y el peor caso es varias veces esa cuenta—, que son justo las dos
 * estrategias marcadas como riesgo alto.
 *
 * La liquidacion va SIEMPRE etiquetada como estimacion, y la insignia vive
 * dentro de este componente en vez de en quien lo usa para que no se pueda
 * olvidar al reutilizarlo: `liquidation.ts` documenta que su tasa de
 * mantenimiento del 0,5 % es OPTIMISTA y exige presentarla asi. Ningun venue
 * expone hoy su tabla real en este repositorio.
 */
@Component({
  selector: 'ui-risk-meter',
  standalone: true,
  imports: [IonIcon, UiBadgeComponent],
  template: `
    <div class="head">
      <h4>Con esta configuración</h4>
      <ui-badge size="sm" tone="neutral" caps>estimación</ui-badge>
    </div>

    @if (preview(); as p) {
      <div class="grid">
        <div>
          <span class="k">Exposición total</span>
          <span class="v num">{{ money(p.worstCaseNotional) }}</span>
        </div>
        <div>
          <span class="k">Margen requerido</span>
          <span class="v num" [class.over]="overBalance()">
            {{ money(p.worstCaseMargin) }}
          </span>
        </div>
        <div>
          <span class="k">Precio medio</span>
          <span class="v num">{{ price(p.worstCaseAverageEntry, decimals()) }}</span>
        </div>
        <div>
          <span class="k">Liquidación</span>
          <span class="v num danger">
            {{ price(p.estimatedLiquidationPrice, decimals()) }}
          </span>
        </div>
      </div>

      @if (distance() !== null) {
        <div class="bar">
          <div class="line">
            <span class="k">Aguanta un movimiento adverso de</span>
            <span class="v num" [class]="tone()">{{ distance()!.toFixed(2) }} %</span>
          </div>
          <div class="track">
            <i [class]="tone()" [style.width.%]="fill()"></i>
          </div>
        </div>
      }

      <!-- El aviso que hoy solo aparece en marcha, como un INSUFFICIENT_FUNDS
           con la escalera medio tendida. -->
      @if (overBalance()) {
        <p class="over-note">
          <ion-icon name="warning-outline" />
          <span>
            La escalera completa pide más margen del que tienes libre: los últimos niveles se
            quedarían sin colocar.
          </span>
        </p>
      }
    } @else {
      <p class="empty">{{ emptyText() }}</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        padding: var(--space-3) var(--space-4) var(--space-4);
        margin-top: var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        background: var(--surface-1);
      }

      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        margin-bottom: 11px;
      }

      h4 {
        margin: 0;
        font-family: var(--font-display);
        font-size: 13px;
        font-weight: 700;
        color: var(--text-1);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px var(--space-3);
      }

      .grid > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .k {
        font-size: 10.5px;
        color: var(--text-3);
      }

      .v {
        font-size: 14px;
        font-weight: 700;
        line-height: 1.25;
        color: var(--text-1);
        overflow-wrap: anywhere;
      }

      .v.danger {
        color: var(--pnl-down);
      }

      .v.over {
        color: var(--signal-warn);
      }

      .bar {
        margin-top: 13px;
      }

      .line {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
        margin-bottom: 6px;
      }

      .track {
        height: 5px;
        border-radius: var(--radius-pill);
        background: var(--surface-3);
        overflow: hidden;
      }

      .track i {
        display: block;
        height: 100%;
        border-radius: var(--radius-pill);
        transition: width 0.15s ease;
      }

      /* El mismo semaforo en la cifra y en la barra: leer el color dos veces
         de formas distintas es peor que no tener color. */
      .safe {
        color: var(--pnl-up);
        background: var(--pnl-up);
      }

      .warn {
        color: var(--signal-warn);
        background: var(--signal-warn);
      }

      .danger {
        color: var(--pnl-down);
        background: var(--pnl-down);
      }

      .over-note {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 12px 0 0;
        font-size: 11.5px;
        line-height: 1.45;
        color: var(--signal-warn);
      }

      .over-note ion-icon {
        flex-shrink: 0;
        font-size: 15px;
      }

      .empty {
        margin: 0;
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--text-3);
      }
    `,
  ],
})
export class UiRiskMeterComponent {
  readonly preview = input<PreviewResult | null>(null);
  readonly decimals = input<number | null>(null);
  /** Margen libre, para avisar si la escalera entera no cabe. */
  readonly available = input<string | null>(null);
  /** Por que no hay nada que enseñar todavia. */
  readonly emptyText = input<string>('Rellena los parámetros para ver el riesgo.');

  readonly money = money;
  readonly price = price;

  readonly distance = computed(() => {
    const d = Number(this.preview()?.liquidationDistancePct);
    return Number.isFinite(d) ? d : null;
  });

  /**
   * Cuanto se pinta de la barra.
   *
   * Se satura al 40 %: por encima de ahi la diferencia entre aguantar un 45 % y
   * un 90 % no cambia ninguna decision, y sin tope una configuracion muy
   * conservadora dejaba la barra igual de llena que cualquier otra.
   */
  readonly fill = computed(() => {
    const d = this.distance();
    if (d === null) return 0;
    return Math.min(100, Math.max(2, (d / 40) * 100));
  });

  /** Verde por encima del 25 %, ámbar entre 10 y 25, rojo por debajo de 10. */
  readonly tone = computed(() => {
    const d = this.distance();
    if (d === null) return 'safe';
    if (d < 10) return 'danger';
    if (d < 25) return 'warn';
    return 'safe';
  });

  readonly overBalance = computed(() => {
    const needed = Number(this.preview()?.worstCaseMargin);
    const free = Number(this.available());
    if (!Number.isFinite(needed) || !Number.isFinite(free) || free <= 0) return false;
    return needed > free;
  });
}
