import { Component, computed, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import type { CapitalSnapshot } from '../../core/models';
import { ago, money, pct, price } from '../../core/utils';

/**
 * El saldo real de la cuenta y el precio del par, fijados arriba del formulario.
 *
 * Nace de un agujero que se veia a simple vista: el asistente pedia «Capital
 * asignado» sobre el vacio. En toda la app no habia una sola cifra de saldo, asi
 * que el usuario tecleaba un numero sin saber si tenia ese dinero, y el desfase
 * salia en marcha como un `INSUFFICIENT_FUNDS` del venue con la escalera ya
 * medio tendida.
 *
 * Tres decisiones que parecen detalles y no lo son:
 *
 * · **Va fijada** (`sticky`). El formulario de GridMart tiene dieciseis campos y
 *   el del market maker V2 treinta y cuatro: sin fijarla, el saldo desaparece en
 *   el primer desplazamiento, justo cuando se esta decidiendo cuanto arriesgar.
 * · **La hora se pinta siempre.** Este dato viaja cacheado hasta 15 s, y mucho
 *   mas si el venue no responde y se sirve el ultimo bueno. Un saldo sin fecha
 *   invita a creerselo al segundo.
 * · **El precio usa `price()` y no `money()`.** Un par a 0,00004182 se enseñaria
 *   como «0,00» con dos decimales fijos.
 *
 * NO puede vivir dentro de un `<ui-card flush>`: ese host declara
 * `overflow: hidden`, que rompe el `sticky` de todo lo que contiene.
 */
@Component({
  selector: 'ui-capital-header',
  standalone: true,
  imports: [IonIcon],
  template: `
    <div class="bar">
      <div class="top">
        <span class="pair">{{ pair() }}</span>

        @if (mark(); as m) {
          <span class="px num">{{ price(m, priceDecimals()) }}</span>
          @if (changePct() !== null) {
            <span class="chg num" [class.up]="changePct()! >= 0">
              {{ pct(changePct()) }}
            </span>
          }
        } @else {
          <span class="px muted">sin precio</span>
        }

        <button type="button" class="at" (click)="refresh.emit()">
          {{ stamp() }}
          <ion-icon name="refresh-outline" />
        </button>
      </div>

      @if (snapshot()?.unavailable; as fallo) {
        <p class="down">
          <ion-icon name="alert-circle-outline" />
          <span>{{ fallo.message }} Puedes seguir: el exchange manda al arrancar.</span>
        </p>
      } @else {
        <div class="funds" [class.stale]="snapshot()?.stale">
          <span>
            Disponible <b class="num">{{ money(snapshot()?.available) }}</b>
          </span>
          <span>
            Total <b class="num">{{ money(snapshot()?.total) }}</b>
          </span>
          @if (committedBots() > 0) {
            <span>
              En otros bots <b class="num">{{ money(committed()) }}</b>
            </span>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        position: sticky;
        top: 0;
        z-index: 3;
        margin: 0 0 var(--space-3);
      }

      /* Fondo propio y opaco: sin el, las filas del formulario se ven por
         debajo al desplazarse y la cifra del saldo deja de leerse. */
      .bar {
        padding: 10px 12px 11px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
        background: var(--surface-1);
        box-shadow: var(--shadow-1);
      }

      .top {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
      }

      .pair {
        font-family: var(--font-display);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--text-1);
      }

      .px {
        font-size: 15px;
        font-weight: 700;
        color: var(--text-1);
      }

      .px.muted {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-3);
      }

      .chg {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--pnl-down);
      }

      .chg.up {
        color: var(--pnl-up);
      }

      /* La marca de tiempo ES el boton de refrescar. Dice cuando es el dato y
         como pedir otro en el mismo sitio, que es donde surge la duda. */
      .at {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: auto;
        padding: 0;
        background: none;
        border: 0;
        font-family: inherit;
        font-size: 10.5px;
        color: var(--text-3);
        cursor: pointer;
      }

      .at ion-icon {
        font-size: 13px;
      }

      .funds {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 14px;
        margin-top: 7px;
        font-size: 11.5px;
        color: var(--text-3);
      }

      .funds b {
        font-weight: 700;
        color: var(--text-1);
      }

      /* Rancio: se enseña, atenuado y con su hora. Un saldo de hace tres
         minutos deja decidir; un guion no. */
      .funds.stale {
        opacity: 0.55;
      }

      .down {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 7px 0 0;
        font-size: 11.5px;
        line-height: 1.45;
        color: var(--signal-warn);
      }

      .down ion-icon {
        flex-shrink: 0;
        font-size: 15px;
      }
    `,
  ],
})
export class UiCapitalHeaderComponent {
  readonly snapshot = input<CapitalSnapshot | null>(null);
  readonly pair = input<string>('');
  /** Ultimo precio, ya como string estable. Ver `mark` en la pagina. */
  readonly mark = input<string | null>(null);
  readonly changePct = input<number | null>(null);
  readonly priceDecimals = input<number | null>(null);
  /** Lo pide el usuario tocando la marca de tiempo. */
  readonly refresh = output<void>();

  readonly money = money;
  readonly price = price;
  readonly pct = pct;

  readonly committed = computed(() => this.snapshot()?.committed.margin ?? null);
  readonly committedBots = computed(() => this.snapshot()?.committed.bots ?? 0);

  /**
   * Cuando se leyo. Se recalcula al repintar y no con un reloj propio: montar
   * un `setInterval` por una etiqueta de texto es gastar bateria para que ponga
   * «hace 13 s» en vez de «hace 12 s».
   */
  readonly stamp = computed(() => {
    const s = this.snapshot();
    if (!s) return 'cargando…';
    if (!s.at) return 'sin datos';
    return ago(s.at);
  });
}
