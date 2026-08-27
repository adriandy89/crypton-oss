import { Component, computed, input, output } from '@angular/core';
import {
  IonIcon,
  IonInput,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonToggle,
} from '@ionic/angular/standalone';
import type { FieldMeta } from '../../core/models';
import { fieldHelp, fieldLabel, optionLabel } from '../../core/utils';
import { UiMutabilityBadgeComponent } from './ui-mutability-badge.component';

/**
 * Un campo de configuracion, generado a partir de su `FieldMeta`.
 *
 * Este mismo switch estaba escrito TRES veces: en el paso "Parametros" de
 * bot-create y en las secciones HOT y WARM de bot-detail. Cada copia se fue
 * separando un poco de las otras.
 *
 * El rango se muestra siempre que exista: la propia app promete que "cada
 * campo trae su rango y su valor por defecto", y hasta ahora no lo ensenaba.
 *
 * Tres cosas que el descriptor decide y antes se ignoraban:
 *
 * · `unit` — la unidad se pinta DENTRO del campo. Sin ella, un formulario con
 *   bps, segundos, porcentajes y USDC mezclados obliga a adivinar en cada
 *   casilla, y equivocarse cuesta dinero: 40 bps y 40 % no se parecen en nada.
 * · `control: 'segment'` — un enum de dos o tres opciones cortas se lee de un
 *   vistazo como grupo de botones y necesita dos toques como desplegable.
 * · `helpKey` — la ayuda estaba en el modelo desde el principio y no se
 *   mostraba en ninguna parte.
 */
@Component({
  selector: 'ui-field',
  standalone: true,
  imports: [
    IonIcon,
    IonInput,
    IonSegment,
    IonSegmentButton,
    IonSelect,
    IonSelectOption,
    IonToggle,
    UiMutabilityBadgeComponent,
  ],
  template: `
    @if (field().kind === 'boolean') {
      <div class="row">
        <div class="lbl">
          <span>{{ label() }}</span>
          @if (showMutability()) {
            <ui-mutability-badge [level]="field().mutability" />
          }
          @if (field().risky) {
            <ion-icon name="warning-outline" class="risky" />
          }
        </div>
        <ion-toggle
          [checked]="!!value()"
          [disabled]="disabled()"
          (ionChange)="valueChange.emit($event.detail.checked)"
        />
      </div>
      @if (help()) {
        <p class="help">{{ help() }}</p>
      }
    } @else {
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
        @if (range()) {
          <span class="range num">{{ range() }}</span>
        }
      </div>

      @if (isSegment()) {
        <ion-segment
          class="fseg"
          [value]="value()"
          [disabled]="disabled()"
          (ionChange)="valueChange.emit($event.detail.value)"
        >
          @for (opt of field().options; track opt) {
            <ion-segment-button [value]="opt">{{ optionText(opt) }}</ion-segment-button>
          }
        </ion-segment>
      } @else if (field().kind === 'enum' && field().options) {
        <ion-select
          interface="popover"
          [value]="value()"
          [disabled]="disabled()"
          (ionChange)="valueChange.emit($event.detail.value)"
        >
          @for (opt of field().options; track opt) {
            <ion-select-option [value]="opt">{{ optionText(opt) }}</ion-select-option>
          }
        </ion-select>
      } @else {
        <div class="wrap" [class.bad]="!!error()">
          <ion-input
            [type]="field().kind === 'text' ? 'text' : 'number'"
            [inputmode]="field().kind === 'text' ? 'text' : 'decimal'"
            [min]="field().min ?? null"
            [max]="field().max ?? null"
            [step]="field().step ?? 'any'"
            [value]="value()"
            [disabled]="disabled()"
            [style.--padding-end.px]="tailSpace()"
            (ionInput)="valueChange.emit($any($event.target).value)"
          />
          <div class="tail">
            @if (field().unit) {
              <span class="unit num">{{ field().unit }}</span>
            }
            @if (stepper()) {
              <span class="step">
                <button
                  type="button"
                  [disabled]="disabled()"
                  [attr.aria-label]="'Restar en ' + label()"
                  (click)="bump(-1)"
                >
                  −
                </button>
                <button
                  type="button"
                  [disabled]="disabled()"
                  [attr.aria-label]="'Sumar en ' + label()"
                  (click)="bump(1)"
                >
                  +
                </button>
              </span>
            }
          </div>
        </div>
      }

      <!-- El error SUSTITUYE a la ayuda: apilar los dos deja al usuario
           leyendo una explicacion generica encima del motivo concreto. -->
      @if (error()) {
        <p class="err">{{ error() }}</p>
      } @else if (help()) {
        <p class="help">{{ help() }}</p>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
        /* El horizontal NO puede ser cero: estos campos viven dentro de una
           «ui-card flush», que a proposito no tiene relleno para que el
           separador entre campos llegue de borde a borde. Sin esto, las
           etiquetas y las cifras quedaban pegadas al borde de la tarjeta. */
        padding: 12px var(--space-4);
      }

      :host + :host {
        border-top: 1px solid var(--border-subtle);
      }

      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        min-height: 44px;
      }

      .head {
        display: flex;
        /* "flex-start" y no "center": la etiqueta puede ocupar dos lineas y la
           pista de rango tiene que quedarse arriba, no flotando en el medio. */
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

      /*
       * Sin esto, «1 – 30» y «0.05 – 20» salian CORTADOS contra el borde.
       *
       * ".lbl" ya tenia "min-width: 0", pero eso solo autoriza a encoger al
       * contenedor: el <span> de dentro conserva "min-width: auto", asi que no
       * baja de su ancho de contenido y empuja a ".range" fuera de la tarjeta.
       * Y la tarjeta es "<ui-card flush>", que declara "overflow: hidden": lo
       * que se sale no se desplaza, se recorta.
       *
       * Se deja envolver en vez de poner puntos suspensivos: truncar el nombre
       * de un parametro de trading esconde justo lo que hay que leer.
       */
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

      .range {
        flex-shrink: 0;
        font-size: 10.5px;
        color: var(--text-3);
      }

      /* La unidad se superpone al input en vez de ir al lado: asi el campo
         conserva todo el ancho y la cifra no se desplaza al aparecer. */
      .wrap {
        position: relative;
      }

      .wrap.bad ion-input {
        --background: rgba(var(--pnl-down-rgb), 0.08);
        box-shadow: inset 0 0 0 1px var(--pnl-down);
        border-radius: var(--radius-sm);
      }

      /* Unidad y stepper viajan JUNTOS en una sola pila a la derecha.
         Antes la unidad estaba suelta en "right: 12px", que es justo donde el
         navegador dibuja las flechas de "type="number"": se solapaban. Ahora el
         input reserva su hueco con "--padding-end" (ver "tailSpace"), asi que
         una cifra larga tampoco se mete por debajo. */
      .tail {
        position: absolute;
        top: 50%;
        right: 10px;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        gap: 8px;
        /* Este 3 es la diferencia entre que los botones funcionen y que no.
           Ionic 8 le pone «z-index: 2» al host de «ion-input», asi que sin un
           valor mas alto el input se pinta ENCIMA de esta pila y se traga todos
           los clics: los botones se veian perfectamente y no hacian nada.
           «.unit» no lo notaba porque lleva «pointer-events: none». */
        z-index: 3;
      }

      .unit {
        pointer-events: none;
        font-size: 12px;
        color: var(--text-3);
      }

      .step {
        display: flex;
        align-items: center;
        gap: 2px;

        button {
          display: flex;
          align-items: center;
          justify-content: center;
          /* 30px de lado: la flecha nativa que esto sustituye medía unos 13 y
             era imposible de acertar con el pulgar. */
          width: 30px;
          height: 30px;
          padding: 0;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-xs);
          background: var(--surface-3);
          color: var(--text-1);
          font-size: 16px;
          line-height: 1;
          cursor: pointer;

          &:active {
            background: var(--brand);
            color: #fff;
          }

          &:disabled {
            opacity: 0.4;
            cursor: default;
          }
        }
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

      :host([data-disabled='true']) {
        opacity: 0.55;
      }
    `,
  ],
  host: { '[attr.data-disabled]': 'disabled()' },
})
export class UiFieldComponent {
  readonly field = input.required<FieldMeta>();
  readonly value = input<unknown>();
  readonly disabled = input(false);
  readonly showMutability = input(false);
  /**
   * Motivo por el que ESTE campo esta mal, ya en castellano.
   *
   * Opcional a proposito: `bot-detail` pinta este mismo componente en cuatro
   * sitios y no tiene de donde sacarlo. Sin el, el campo se ve exactamente
   * igual que antes.
   */
  readonly error = input<string>('');
  readonly valueChange = output<unknown>();

  readonly label = computed(() => fieldLabel(this.field()));
  readonly help = computed(() => fieldHelp(this.field()));

  /**
   * El descriptor solo PIDE el grupo de botones; aqui se decide si cabe.
   *
   * Cuatro opciones ya no entran en el ancho de un movil sin partir las
   * etiquetas, asi que a partir de ahi se cae al desplegable. Es preferible a
   * que el descriptor tenga que saber el ancho de la pantalla.
   */
  readonly isSegment = computed(() => {
    const f = this.field();
    const options = f.options ?? [];
    return f.control === 'segment' && f.kind === 'enum' && options.length >= 2 && options.length <= 3;
  });

  readonly range = computed(() => {
    const f = this.field();
    if (f.kind === 'text' || f.kind === 'enum' || f.kind === 'boolean') return '';
    if (f.min !== undefined && f.max !== undefined) return `${f.min} – ${f.max}`;
    if (f.min !== undefined) return `min ${f.min}`;
    if (f.max !== undefined) return `max ${f.max}`;
    return '';
  });

  /** Los campos numericos llevan stepper; texto, enum y booleano no. */
  readonly stepper = computed(() => {
    const kind = this.field().kind;
    return kind !== 'text' && kind !== 'enum' && kind !== 'boolean';
  });

  /**
   * Hueco que el input reserva a su derecha para la unidad y el stepper.
   *
   * Se calcula en vez de fijarse: un campo con `USDC` y stepper necesita mucho
   * mas que uno con solo `%`, y con un valor unico o la cifra se metia debajo
   * de la unidad o quedaba un vacio absurdo en los campos sin sufijo.
   */
  readonly tailSpace = computed(() => {
    const unit = this.field().unit;
    // 10 del borde + ~7 px por caracter de unidad + 8 de separacion + 62 del par
    // de botones. Sin unidad ni stepper se deja el relleno normal del tema.
    const unitPx = unit ? unit.length * 7 + 8 : 0;
    const stepPx = this.stepper() ? 62 : 0;
    return unitPx + stepPx === 0 ? 14 : 10 + unitPx + stepPx;
  });

  /**
   * Sube o baja un paso, respetando `min` y `max` del descriptor.
   *
   * Emite un STRING, igual que hace `ion-input`: las estrategias guardan sus
   * importes y porcentajes como cadenas y `D()` los lee tal cual. Emitir un
   * numero aqui habria metido dos tipos distintos en la misma clave segun se
   * hubiera tecleado o pulsado.
   */
  bump(direction: 1 | -1): void {
    const f = this.field();
    const step = f.step ?? 1;
    const current = Number(this.value());
    const from = Number.isFinite(current) ? current : (f.min ?? 0);

    // Se redondea al numero de decimales del paso: sin esto, 0.05 + 0.05 deja
    // «0.15000000000000002» escrito en el campo, que es de las cosas que mas
    // barata parecen y peor se ven.
    const decimals = (String(step).split('.')[1] ?? '').length;
    let next = Number((from + direction * step).toFixed(decimals));

    if (f.min !== undefined && next < f.min) next = f.min;
    if (f.max !== undefined && next > f.max) next = f.max;
    this.valueChange.emit(String(next));
  }

  optionText(value: string): string {
    return optionLabel(value, this.field().labelKey);
  }
}
