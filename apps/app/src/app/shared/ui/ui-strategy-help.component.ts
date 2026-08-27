import { Component, computed, input, signal } from '@angular/core';
import { IonContent, IonIcon, IonModal } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline, helpCircleOutline, warningOutline } from 'ionicons/icons';
import { getStrategy } from '@crypton/strategy-core';
import type { FieldMeta, StrategyKind } from '../../core/models';
import { optionDoc, strategyGuide } from '../../core/content';
import {
  fieldHelp,
  fieldLabel,
  groupLabel,
  optionLabel,
  strategyLabel,
  textoDeConfig,
} from '../../core/utils';
import { UiBadgeComponent } from './ui-badge.component';
import { UiCollapsibleComponent } from './ui-collapsible.component';
import { UiMutabilityBadgeComponent } from './ui-mutability-badge.component';

/** Orden de las secciones, el mismo que usa el asistente al pintar el formulario. */
const GROUP_ORDER = [
  'core',
  'quoting',
  'risk',
  'timing',
  'levels',
  'dynamicSpread',
  'priceSource',
  'activation',
  'venue',
] as const;

interface OptionRow {
  field: FieldMeta;
  label: string;
  /** Rango, valor por defecto y opciones, ya formateados. */
  facts: string[];
  what: string;
  affects: string;
  tip: string;
}

interface OptionGroup {
  key: string;
  title: string;
  rows: OptionRow[];
}

/**
 * Icono de ayuda que abre el manual completo de una estrategia.
 *
 * El formulario de un bot se genera entero desde `FieldMeta[]`, así que el
 * usuario se encuentra hasta cuarenta y ocho casillas sin nada que le diga qué
 * hace la estrategia ni en qué afecta cada número. Ese era todo el problema.
 *
 * La lista de opciones NO está escrita a mano: se recorre el mismo `FieldMeta[]`
 * que pinta el formulario y de cada campo se busca su ficha en el catálogo. Esa
 * dirección es la que garantiza que el manual no pueda quedarse corto — un campo
 * sin ficha sale igualmente, con su ayuda corta, en vez de desaparecer.
 *
 * El componente incluye el disparador y es dueño del modal, para que añadirlo a
 * una pantalla sea una línea y no un trozo de estado repetido en cada página.
 */
@Component({
  selector: 'ui-strategy-help',
  standalone: true,
  imports: [
    IonContent,
    IonIcon,
    IonModal,
    UiBadgeComponent,
    UiCollapsibleComponent,
    UiMutabilityBadgeComponent,
  ],
  template: `
    <button
      type="button"
      class="trigger"
      [class.inline]="variant() === 'inline'"
      [attr.aria-label]="'Ayuda sobre ' + title()"
      (click)="openPanel($event)"
    >
      <ion-icon name="help-circle-outline" />
      @if (variant() === 'inline') {
        <span>Cómo funciona</span>
      }
    </button>

    <ion-modal class="help" [isOpen]="open()" (ionModalDidDismiss)="open.set(false)">
      <ng-template>
        <ion-content class="helpbody">
          <header class="helphead">
            <h2>{{ title() }}</h2>
            <button type="button" class="x" (click)="open.set(false)" aria-label="Cerrar">
              <ion-icon name="close-outline" />
            </button>
          </header>

          @if (guide(); as g) {
            <p class="lead">{{ g.headline }}</p>
            <div class="tags">
              <ui-badge size="sm" [tone]="riskTone()" caps
                >riesgo {{ g.risk.toLowerCase() }}</ui-badge
              >
              <ui-badge size="sm" tone="neutral" caps square>{{ rows().length }} opciones</ui-badge>
            </div>

            <section>
              <h3>Para qué sirve</h3>
              <p>{{ g.bestFor }}</p>
            </section>

            <section>
              <h3>Cómo funciona</h3>
              <ol class="steps">
                @for (paso of g.howItWorks; track paso) {
                  <li>{{ paso }}</li>
                }
              </ol>
            </section>

            <section>
              <h3>Cuándo usarlo</h3>
              <ul class="marks good">
                @for (item of g.goodWhen; track item) {
                  <li>{{ item }}</li>
                }
              </ul>
              <h3 class="sub">Cuándo no</h3>
              <ul class="marks bad">
                @for (item of g.badWhen; track item) {
                  <li>{{ item }}</li>
                }
              </ul>
            </section>

            <section>
              <h3>Ejemplos con pares reales</h3>
              @for (ej of g.examples; track ej.title) {
                <article class="ej">
                  <h4>{{ ej.title }}</h4>
                  <p class="market">
                    <span class="venue">{{ ej.venue }}</span> · {{ ej.pair }} · {{ ej.price }}
                  </p>
                  <dl class="setup">
                    @for (fila of ej.setup; track fila.label) {
                      <div>
                        <dt>{{ fila.label }}</dt>
                        <dd class="num">{{ fila.value }}</dd>
                      </div>
                    }
                  </dl>
                  <p class="out">{{ ej.outcome }}</p>
                </article>
              }
            </section>
          }

          <section>
            <h3>Todas las opciones</h3>
            <p class="note">
              Cada ajuste indica cuándo se aplica si lo cambias con el bot en marcha:
              <ui-mutability-badge level="HOT" /> en el próximo ciclo,
              <ui-mutability-badge level="WARM" /> recolocando las órdenes, y
              <ui-mutability-badge level="COLD" /> no se puede cambiar.
            </p>

            @for (g of groups(); track g.key) {
              <ui-collapsible
                [title]="g.title"
                [count]="g.rows.length"
                icon="options-outline"
                [startOpen]="g.key === 'core'"
              >
                @for (row of g.rows; track row.field.key) {
                  <div class="opt">
                    <div class="opthead">
                      <span class="name">{{ row.label }}</span>
                      <ui-mutability-badge [level]="row.field.mutability" />
                      @if (row.field.risky) {
                        <ion-icon name="warning-outline" class="risky" aria-hidden="true" />
                      }
                    </div>
                    @if (row.facts.length) {
                      <p class="facts num">{{ row.facts.join(' · ') }}</p>
                    }
                    @if (row.what) {
                      <p class="what">{{ row.what }}</p>
                    }
                    @if (row.affects) {
                      <p class="affects"><span>En qué afecta:</span> {{ row.affects }}</p>
                    }
                    @if (row.tip) {
                      <p class="tipline"><span>Consejo:</span> {{ row.tip }}</p>
                    }
                  </div>
                }
              </ui-collapsible>
            }
          </section>

          <p class="warn">
            Operas derivados con apalancamiento en un exchange descentralizado. Puedes perder todo
            el margen asignado al bot. Prueba primero en modo simulación.
          </p>
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
  styles: [
    `
      /* Solo el disparador. El interior del modal se estila en global.scss,
         colgado de \`ion-modal.help\`: el presupuesto de 6 kB por hoja de
         componente no da para el chrome de una pantalla entera, y es el mismo
         reparto que ya usa la hoja de ajustes del grafico. */
      :host {
        display: inline-flex;
        flex-shrink: 0;
      }

      .trigger {
        width: 44px;
        height: 44px;
        display: grid;
        place-items: center;
        padding: 0;
        border: 0;
        background: none;
        color: var(--brand-2);
        cursor: pointer;

        ion-icon {
          font-size: 22px;
        }
      }

      .trigger.inline {
        width: auto;
        gap: 6px;
        display: inline-flex;
        align-items: center;
        padding: 0 10px;
        font-family: var(--font-ui);
        font-size: 12.5px;
        font-weight: 600;
      }
    `,
  ],
})
export class UiStrategyHelpComponent {
  readonly kind = input.required<StrategyKind>();
  /**
   * Los MISMOS descriptores que la página esta pintando. Se pasan en vez de
   * resolverlos aquí para que el manual documente exactamente lo que el usuario
   * tiene delante; si no llegan, se cae al catálogo de la estrategia.
   */
  readonly fields = input<readonly FieldMeta[]>([]);
  readonly variant = input<'icon' | 'inline'>('icon');

  readonly open = signal(false);

  constructor() {
    addIcons({ closeOutline, helpCircleOutline, warningOutline });
  }

  readonly title = computed(() => strategyLabel(this.kind()));
  readonly guide = computed(() => strategyGuide(this.kind()));
  readonly riskTone = computed(() => {
    const risk = this.guide()?.risk;
    if (risk === 'ALTO') return 'down' as const;
    if (risk === 'MEDIO') return 'warn' as const;
    return 'up' as const;
  });

  /**
   * Se abre sin dejar que el clic llegue al contenedor: en el selector de
   * estrategia el icono vive junto a una tarjeta que navega al pulsarla, y
   * pedir ayuda no puede significar elegir esa estrategia.
   */
  openPanel(event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.open.set(true);
  }

  private readonly resolvedFields = computed<readonly FieldMeta[]>(() => {
    const given = this.fields();
    if (given.length) return given;
    try {
      return getStrategy(this.kind()).meta.fields;
    } catch {
      return [];
    }
  });

  readonly rows = computed<OptionRow[]>(() =>
    this.resolvedFields().map((field) => {
      const doc = optionDoc(this.kind(), field.key);
      return {
        field,
        label: fieldLabel(field),
        facts: this.factsOf(field),
        // Sin ficha larga, la ayuda corta del formulario es mejor que un hueco.
        what: doc?.what ?? fieldHelp(field),
        affects: doc?.affects ?? '',
        tip: doc?.tip ?? '',
      };
    }),
  );

  readonly groups = computed<OptionGroup[]>(() => {
    const byKey = new Map<string, OptionRow[]>();
    for (const row of this.rows()) {
      const key = row.field.group ?? 'core';
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }
    const known = GROUP_ORDER.filter((k) => byKey.has(k)) as string[];
    const rest = [...byKey.keys()].filter((k) => !known.includes(k));
    return [...known, ...rest].map((key) => ({
      key,
      title: groupLabel(key),
      rows: byKey.get(key) ?? [],
    }));
  });

  /**
   * Rango, valor por defecto y opciones de un campo.
   *
   * Es el mismo dato que `ui-field` enseña junto al control, repetido aquí a
   * propósito: el manual se lee entero de una vez, y saber que el mínimo son 15
   * segundos importa tanto como saber para que sirve el campo.
   */
  private factsOf(field: FieldMeta): string[] {
    const facts: string[] = [];
    const { min, max, step, unit, options } = field;
    if (min !== undefined && max !== undefined) facts.push('Rango ' + min + ' – ' + max);
    else if (min !== undefined) facts.push('Mínimo ' + min);
    else if (max !== undefined) facts.push('Máximo ' + max);
    if (step !== undefined) facts.push('Paso ' + step);
    if (unit) facts.push('En ' + unit);
    if (options?.length) {
      facts.push(options.map((o) => optionLabel(o, field.labelKey)).join(' / '));
    }
    if (field.default !== undefined && field.default !== null && field.default !== '') {
      const raw = textoDeConfig(field.default);
      facts.push('Por defecto ' + (field.kind === 'enum' ? optionLabel(raw, field.labelKey) : raw));
    }
    facts.push(field.required ? 'Obligatorio' : 'Opcional');
    return facts;
  }
}
