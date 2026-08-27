import { Component, input, output } from '@angular/core';
import { IonButton, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { sparklesOutline, warningOutline } from 'ionicons/icons';
import type { RecommendationSet, RecommendedProfile } from '../../core/models';
import { money } from '../../core/utils';
import { UiBadgeComponent } from './ui-badge.component';
import { UiNoticeComponent } from './ui-notice.component';

/**
 * Tres configuraciones ya hechas para la estrategia y el par elegidos.
 *
 * Presentacional puro: no pide nada, no valida nada y no sabe de qué bot se
 * trata. Todo eso lo hace el servidor, que es el único que puede comprobar una
 * configuración contra la spec del mercado y contra los límites del usuario.
 *
 * Cada tarjeta enseña el riesgo ANTES de aplicar —margen del peor caso y
 * distancia a liquidación—, que es lo que convierte esto en una ayuda y no en un
 * botón de la suerte.
 */
@Component({
  selector: 'ui-recommendations',
  standalone: true,
  imports: [IonButton, IonIcon, IonSpinner, UiBadgeComponent, UiNoticeComponent],
  template: `
    <div class="head">
      <ion-icon name="sparkles-outline" />
      <h3>Configuraciones sugeridas</h3>
    </div>

    @if (loading()) {
      <div class="cargando"><ion-spinner name="crescent" /><span>Calculando…</span></div>
    } @else if (error()) {
      <ui-notice tone="warn" icon="warning-outline">
        {{ error() }}
      </ui-notice>
      <ion-button size="small" fill="outline" (click)="retry.emit()">Reintentar</ion-button>
    } @else if (set(); as s) {
      @if (s.market; as m) {
        <p class="ctx">
          Recorrido diario del {{ m.atrPct1d }} % · rango de 30 días del {{ m.rangePct30 }} % ·
          {{ m.trend.toLowerCase() }}
        </p>
      }

      <div class="cards">
        @for (p of s.profiles; track p.profile) {
          <button
            type="button"
            class="reco"
            [class.on]="applied() === p.profile"
            (click)="apply.emit(p)"
          >
            <div class="top">
              <span class="nombre">{{ label(p.profile) }}</span>
              <!-- El origen va POR TARJETA y no por conjunto. Cuando la
                   propuesta del modelo no sobrevive a la validación, su hueco lo
                   ocupa una calculada por reglas: con una sola marca arriba,
                   esa tarjeta se presentaba como salida del modelo. -->
              @if (p.source === 'REGLAS') {
                <ui-badge size="sm" tone="neutral">calculada</ui-badge>
              }
              <ui-badge size="sm" [tone]="tone(p)">{{ p.headline.leverage }}×</ui-badge>
            </div>
            <p class="por">{{ p.rationale }}</p>
            <div class="cifras num">
              <span>
                <em>Margen peor caso</em>
                <b>{{ money(p.headline.worstCaseMargin) }}</b>
              </span>
              <span>
                <em>A liquidación</em>
                <b [class.riesgo]="cerca(p)">
                  {{ p.headline.liquidationDistancePct ?? '—' }}
                  @if (p.headline.liquidationDistancePct) {
                    %
                  }
                </b>
              </span>
              <span>
                <em>Niveles</em>
                <b>{{ p.headline.levels }}</b>
              </span>
            </div>
            @if (applied() === p.profile) {
              <span class="aplicada">Aplicada — revísala antes de crear el bot</span>
            }
          </button>
        }
      </div>

      @if (stale()) {
        <ui-notice tone="warn" icon="warning-outline">
          El precio se ha movido desde que se calcularon. Vuelve a pedirlas antes de aplicar una:
          los rangos de precio podrían haberse quedado fuera de mercado.
        </ui-notice>
        <ion-button size="small" fill="outline" (click)="retry.emit()"> Recalcular </ion-button>
      }
      @if (s.notice) {
        <ui-notice tone="info">{{ s.notice }}</ui-notice>
      }
    } @else {
      <p class="ctx">
        Escribe cuánto capital quieres asignar y te propongo tres configuraciones para este par.
      </p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        margin-bottom: var(--space-3);
      }

      .head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: var(--space-2);
      }

      .head ion-icon {
        font-size: 17px;
        color: var(--brand-2);
      }

      h3 {
        flex-grow: 1;
        margin: 0;
        font-family: var(--font-display);
        font-size: 14px;
        font-weight: 700;
        letter-spacing: -0.015em;
      }

      .ctx {
        margin: 0 0 var(--space-2);
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--text-3);
      }

      .cargando {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-4);
        font-size: 12.5px;
        color: var(--text-2);
      }

      /* Una columna en el móvil: tres tarjetas en fila a 360 px dejarían las
         cifras ilegibles, que son justo lo que hay que comparar. */
      .cards {
        display: grid;
        gap: var(--space-2);
      }

      @media (min-width: 640px) {
        .cards {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }

      .reco {
        display: flex;
        flex-direction: column;
        gap: 7px;
        width: 100%;
        padding: var(--space-3);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: var(--surface-1);
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      /* La aplicada se marca con el color de MARCA, no con el verde: verde en
         esta app significa que estás ganando dinero. */
      .reco.on {
        border-color: var(--brand);
        box-shadow: 0 0 0 1px rgba(var(--brand-rgb), 0.35);
      }

      .top {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .nombre {
        flex-grow: 1;
        font-size: 13.5px;
        font-weight: 700;
        letter-spacing: -0.015em;
      }

      .por {
        margin: 0;
        font-size: 11.5px;
        line-height: 1.45;
        color: var(--text-2);
      }

      .cifras {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
      }

      .cifras span {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }

      .cifras em {
        font-size: 9.5px;
        font-style: normal;
        color: var(--text-3);
      }

      .cifras b {
        font-size: 12.5px;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      /* Menos del 15 % hasta la liquidación es lo que hay que ver antes de
         pulsar, no después. */
      .cifras b.riesgo {
        color: var(--signal-warn);
      }

      .aplicada {
        font-size: 10.5px;
        font-weight: 600;
        color: var(--brand-2);
      }
    `,
  ],
})
export class UiRecommendationsComponent {
  readonly set = input<RecommendationSet | null>(null);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  /** Perfil ya aplicado, para marcarlo. Se limpia al tocar cualquier campo. */
  readonly applied = input<string | null>(null);
  /** El precio se ha movido desde que se calcularon. Ver `recoStale`. */
  readonly stale = input(false);

  readonly apply = output<RecommendedProfile>();
  readonly retry = output<void>();

  readonly money = money;

  constructor() {
    addIcons({ sparklesOutline, warningOutline });
  }

  label(p: string): string {
    return p === 'PRUDENTE' ? 'Prudente' : p === 'AGRESIVA' ? 'Agresiva' : 'Equilibrada';
  }

  tone(p: RecommendedProfile): 'up' | 'warn' | 'down' {
    return p.profile === 'PRUDENTE' ? 'up' : p.profile === 'AGRESIVA' ? 'down' : 'warn';
  }

  /**
   * Menos del 15 % hasta la liquidacion.
   *
   * La comprobacion de nulo va PRIMERO: `Number(null)` es 0, asi que sin ella
   * una estrategia sin liquidacion estimada —las rejillas y los market makers
   * devuelven null— pintaba su guion en ambar, como si la liquidacion llegara
   * con un movimiento adverso del 0 %.
   */
  cerca(p: RecommendedProfile): boolean {
    if (p.headline.liquidationDistancePct === null) return false;
    const d = Number(p.headline.liquidationDistancePct);
    return Number.isFinite(d) && d < 15;
  }
}
