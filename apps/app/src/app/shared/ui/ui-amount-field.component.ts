import { Component, computed, input, output } from '@angular/core';
import { IonIcon, IonInput, IonRange } from '@ionic/angular/standalone';
import type { FieldMeta } from '../../core/models';
import { fieldHelp, fieldLabel, money } from '../../core/utils';
import { UiMutabilityBadgeComponent } from './ui-mutability-badge.component';

/** Los atajos de la fila de chips, en porcentaje del disponible. */
const CHIPS = [25, 50, 75] as const;

/**
 * Reserva sobre el disponible al pulsar «Máx».
 *
 * Poner el 100 % del margen libre deja al bot sin un centimo para comisiones, y
 * la primera orden que las cobre lo empuja por debajo del minimo. Un 2 % es
 * pequeño y evita el caso.
 */
const MAX_RATIO = 0.98;

/**
 * «Capital asignado» como control de primera clase, dimensionado contra el
 * saldo REAL de la cuenta.
 *
 * Es hermano de `<ui-field>`, no su sustituto, y la distincion importa:
 * `ui-field` se pinta tambien en `bot-detail`, en las secciones HOT y WARM,
 * donde no hay contexto de cartera. Un boton «Máx» sin saldo detras seria
 * mentira. Con dos componentes, solo el asistente opta por entrar y el resto de
 * la app sigue exactamente igual.
 *
 * El exceso AVISA y no bloquea, a proposito: el saldo que se compara puede
 * tener quince segundos, el usuario puede estar depositando ahora mismo, y un
 * bot en simulacion no toca ese dinero. Quien manda al arrancar es el venue.
 */
@Component({
  selector: 'ui-amount-field',
  standalone: true,
  imports: [IonIcon, IonInput, IonRange, UiMutabilityBadgeComponent],
  template: `
    <div class="head">
      <div class="lbl">
        <span>{{ label() }}</span>
        @if (field().required) {
          <span class="req">*</span>
        }
        @if (showMutability()) {
          <ui-mutability-badge [level]="field().mutability" />
        }
        @if (field().risky) {
          <ion-icon name="warning-outline" class="risky" />
        }
      </div>
      @if (available() !== null) {
        <span class="cap num">máx {{ money(usableMax()) }}</span>
      } @else if (field().min !== undefined) {
        <span class="cap num">mín {{ field().min }}</span>
      }
    </div>

    <div class="wrap" [class.bad]="!!error()">
      <ion-input
        type="number"
        inputmode="decimal"
        [min]="hardMin()"
        [step]="1"
        [value]="value()"
        [disabled]="disabled()"
        [style.--padding-end.px]="unitSpace()"
        (ionInput)="valueChange.emit($any($event.target).value)"
      />
      @if (field().unit) {
        <span class="unit num">{{ field().unit }}</span>
      }
    </div>

    <!-- Chips y deslizador SOLO con saldo. Sin el no hay contra que calcular un
         porcentaje, y unos chips que reparten sobre un techo inventado son peor
         que no tenerlos: el campo degrada a la entrada de siempre. -->
    @if (available() !== null) {
      <div class="chips">
        @for (p of CHIPS; track p) {
          <button type="button" [disabled]="disabled()" (click)="applyPct(p)">{{ p }} %</button>
        }
        <button type="button" class="max" [disabled]="disabled()" (click)="applyMax()">Máx</button>
      </div>

      <ion-range
        class="slider"
        [min]="hardMin()"
        [max]="sliderMax()"
        [step]="sliderStep()"
        [value]="sliderValue()"
        [disabled]="disabled()"
        (ionInput)="valueChange.emit(String($any($event).detail.value))"
      />
    }

    @if (error()) {
      <p class="err">{{ error() }}</p>
    } @else if (overBalance()) {
      <p class="over">
        Supera tu saldo disponible en {{ money(excess()) }} {{ field().unit }}. Puedes crearlo
        igual: manda el exchange al arrancar.
      </p>
    } @else if (help()) {
      <p class="help">{{ help() }}</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        /* Mismo relleno que «ui-field»: los dos son hermanos dentro de la misma
           «ui-card flush» y desalinearlos se nota al instante. */
        padding: 12px var(--space-4);
      }

      :host + :host {
        border-top: 1px solid var(--border-subtle);
      }

      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-2);
        margin-bottom: 7px;
      }

      .lbl {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.35;
        color: var(--text-1);
      }

      .lbl > span {
        min-width: 0;
      }

      .req {
        color: var(--brand-2);
      }

      .risky {
        font-size: 15px;
        color: var(--signal-warn);
        flex-shrink: 0;
      }

      .cap {
        flex-shrink: 0;
        font-size: 10.5px;
        color: var(--text-3);
      }

      .wrap {
        position: relative;
      }

      .wrap.bad ion-input {
        --background: rgba(var(--pnl-down-rgb), 0.08);
        box-shadow: inset 0 0 0 1px var(--pnl-down);
        border-radius: var(--radius-sm);
      }

      .unit {
        position: absolute;
        top: 50%;
        right: 12px;
        transform: translateY(-50%);
        pointer-events: none;
        font-size: 12px;
        color: var(--text-3);
      }

      .chips {
        display: flex;
        gap: 6px;
        margin-top: 8px;
      }

      .chips button {
        flex: 1;
        padding: 7px 0;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        background: var(--surface-2);
        color: var(--text-2);
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }

      .chips button:active {
        background: var(--brand);
        border-color: var(--brand);
        color: #fff;
      }

      .chips button.max {
        color: var(--brand-2);
      }

      .chips button:disabled {
        opacity: 0.45;
        cursor: default;
      }

      .slider {
        --bar-background: var(--surface-3);
        --bar-background-active: var(--brand);
        --knob-background: #fff;
        --bar-height: 3px;
        padding: 6px 4px 0;
      }

      .help {
        margin: 6px 0 0;
        font-size: 11.5px;
        line-height: 1.45;
        color: var(--text-3);
      }

      .err {
        margin: 6px 0 0;
        font-size: 11.5px;
        line-height: 1.45;
        font-weight: 600;
        color: var(--pnl-down);
      }

      /* Ambar y no rojo: pasarse del saldo NO impide crear el bot. */
      .over {
        margin: 6px 0 0;
        font-size: 11.5px;
        line-height: 1.45;
        font-weight: 600;
        color: var(--signal-warn);
      }
    `,
  ],
})
export class UiAmountFieldComponent {
  readonly field = input.required<FieldMeta>();
  readonly value = input<unknown>();
  readonly disabled = input(false);
  readonly showMutability = input(false);
  readonly error = input<string>('');
  /** Margen libre de la cuenta. `null` = no se pudo leer: sin chips ni barra. */
  readonly available = input<string | null>(null);
  readonly valueChange = output<unknown>();

  readonly CHIPS = CHIPS;
  readonly money = money;
  readonly String = String;

  readonly label = computed(() => fieldLabel(this.field()));
  readonly help = computed(() => fieldHelp(this.field()));

  readonly hardMin = computed(() => this.field().min ?? 0);

  private readonly availableNum = computed(() => {
    const a = Number(this.available());
    return Number.isFinite(a) && a > 0 ? a : null;
  });

  /** El techo que se ofrece: disponible menos el colchon de comisiones. */
  readonly usableMax = computed(() => {
    const a = this.availableNum();
    return a === null ? null : Math.floor(a * MAX_RATIO * 100) / 100;
  });

  /**
   * Tope de la barra.
   *
   * Si el usuario ya ha escrito mas que su saldo —cosa permitida— la barra se
   * estira hasta ese valor en vez de quedarse corta: un deslizador cuyo pomo no
   * puede llegar al numero del campo se lee como que el campo esta mal.
   */
  readonly sliderMax = computed(() => {
    const max = this.usableMax() ?? this.hardMin();
    return Math.max(max, this.numeric() ?? 0, this.hardMin() + 1);
  });

  /** Cien pasos de punta a punta, redondeados a algo que se pueda teclear. */
  readonly sliderStep = computed(() => {
    const span = this.sliderMax() - this.hardMin();
    if (span <= 0) return 1;
    const raw = span / 100;
    return raw < 1 ? 0.1 : Math.max(1, Math.round(raw));
  });

  readonly sliderValue = computed(() => {
    const n = this.numeric();
    if (n === null) return this.hardMin();
    return Math.min(Math.max(n, this.hardMin()), this.sliderMax());
  });

  readonly overBalance = computed(() => {
    const n = this.numeric();
    const a = this.availableNum();
    return n !== null && a !== null && n > a;
  });

  readonly excess = computed(() => {
    const n = this.numeric();
    const a = this.availableNum();
    return n !== null && a !== null ? n - a : null;
  });

  readonly unitSpace = computed(() => (this.field().unit ? 58 : 14));

  private numeric(): number | null {
    const n = Number(this.value());
    return Number.isFinite(n) ? n : null;
  }

  applyPct(percent: number): void {
    const a = this.availableNum();
    if (a === null) return;
    this.emitAmount((a * percent) / 100);
  }

  applyMax(): void {
    const max = this.usableMax();
    if (max === null) return;
    this.emitAmount(max);
  }

  /**
   * Emite SIEMPRE un string, igual que hace `ion-input`.
   *
   * Las estrategias guardan los importes como cadena y `D()` las lee tal cual;
   * emitir un numero aqui habria dejado dos tipos distintos en la misma clave
   * segun se hubiera tecleado o pulsado un chip.
   */
  private emitAmount(raw: number): void {
    const clamped = Math.max(this.hardMin(), Math.round(raw * 100) / 100);
    this.valueChange.emit(String(clamped));
  }
}
