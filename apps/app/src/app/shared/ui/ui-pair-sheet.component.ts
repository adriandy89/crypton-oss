import { Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { viewChild } from '@angular/core';
import { IonButton, IonContent, IonIcon, IonModal, IonSearchbar } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { checkmarkOutline, closeOutline, searchOutline } from 'ionicons/icons';
import { BotsService, MarketDataService } from '../../core/services';
import type { Market } from '../../core/models';
import { compact, pct, pnlColor, price } from '../../core/utils';
import { UiBadgeComponent } from './ui-badge.component';
import { UiEmptyStateComponent } from './ui-empty-state.component';

/** Una fila ya compuesta: el mercado del catálogo más lo que sabe la instantánea de precios. */
export interface PairRow {
  symbol: string;
  canonical: string;
  base: string;
  maxLeverage: number;
  decimals: number;
  last: string | null;
  changePct: string | null;
  volume: string | null;
  /** Cuántos bots tiene ya el usuario en este par. Informa, no veta. */
  bots: number;
}

/**
 * Relevancia de una fila frente a lo escrito: 0 exacta, 1 empieza por, 2 contiene.
 *
 * Sin esto, escribir «sol» dejaba `SOL/USDC` por detrás de `SOLV` o `kSOLAMA`
 * en cuanto alguno de los dos movía más volumen, que es justo lo que no espera
 * quien acaba de teclear el nombre entero de lo que busca.
 */
export function relevanciaDePar(row: { symbol: string; base: string }, q: string): number {
  const s = row.symbol.toUpperCase();
  const b = row.base.toUpperCase();
  if (s === q || b === q) return 0;
  if (s.startsWith(q) || b.startsWith(q)) return 1;
  return 2;
}

/**
 * La hoja para elegir el par de un bot, con buscador.
 *
 * El asistente usaba un `ion-select` que desplegaba el catálogo entero del
 * venue en orden alfabético: 177 pares en Hyperliquid, 212 en Lighter y 546 en
 * Aster. Para llegar a `SOL/USDC` había que arrastrar por una lista que empieza
 * en `0G/USDC`, `2Z/USDC`, `AAVE/USDC`, sin forma de escribir para filtrar y
 * sin más dato de cada par que su apalancamiento máximo.
 *
 * Filtra en cliente sobre el catálogo que la pantalla ya tiene cargado: ni una
 * petición más. Sin texto ordena por volumen de 24 h —los que se operan de
 * verdad primero— y con texto por relevancia, para que lo tecleado gane al
 * volumen.
 *
 * No guarda el par elegido: lo emite y manda la señal de quien la abre. Así
 * sobrevive a los reinicios de fuera (cambiar de conexión o de red vacía el par
 * y esta hoja no tiene nada que deshacer).
 */
@Component({
  selector: 'ui-pair-sheet',
  standalone: true,
  imports: [
    IonModal,
    IonContent,
    IonIcon,
    IonSearchbar,
    IonButton,
    UiBadgeComponent,
    UiEmptyStateComponent,
  ],
  template: `
    <ion-modal
      class="pair-sheet"
      [isOpen]="open()"
      (ionModalDidDismiss)="open.set(false)"
      (ionModalDidPresent)="enfocar()"
    >
      <ng-template>
        <ion-content class="pairbody">
          <div class="pairtop">
            <header class="pairhead">
              <h2>Elige un par</h2>
              <button type="button" class="x" (click)="open.set(false)" aria-label="Cerrar">
                <ion-icon name="close-outline" />
              </button>
            </header>

            <!-- Intro elige el primero: quien teclea el nombre entero de su par ya
               ha dicho cuál quiere y no debería tener que apuntar con el dedo. -->
            <ion-searchbar
              placeholder="Buscar par o moneda"
              [debounce]="120"
              (ionInput)="query.set($any($event.target).value ?? '')"
              (keydown.enter)="elegirPrimero()"
            />

            @if (rows().length) {
              <p class="pairwhy num">
                {{ visible().length }} de {{ rows().length }}
                {{ rows().length === 1 ? 'par' : 'pares' }}
              </p>
            }
          </div>

          @if (visible().length) {
            <div class="pairlist" role="listbox">
              @for (r of visible(); track r.symbol) {
                <button
                  type="button"
                  class="pair"
                  role="option"
                  [class.on]="r.symbol === symbol()"
                  [attr.aria-selected]="r.symbol === symbol()"
                  (click)="elegir(r)"
                >
                  <span class="id">
                    <span class="top">
                      <span class="name">{{ r.canonical }}</span>
                      @if (r.bots > 0) {
                        <ui-badge size="sm" square tone="brand">
                          {{ r.bots }} {{ r.bots === 1 ? 'bot' : 'bots' }}
                        </ui-badge>
                      }
                    </span>
                    <span class="sub num">
                      hasta {{ r.maxLeverage }}×
                      @if (r.volume) {
                        · Vol {{ compact(r.volume) }}
                      }
                    </span>
                  </span>

                  <span class="px">
                    <b class="num">{{ price(r.last, r.decimals) }}</b>
                    @if (r.changePct !== null) {
                      <em class="num" [class]="'c-' + pnlColor(r.changePct)">
                        {{ pct(r.changePct) }}
                      </em>
                    }
                  </span>

                  <ion-icon class="tick" name="checkmark-outline" />
                </button>
              }
            </div>
          } @else if (query()) {
            <ui-empty-state icon="search-outline" title="Nada para «{{ query() }}»">
              <p>No hay ningún par con ese nombre en esta conexión.</p>
              <ion-button fill="outline" (click)="query.set('')">Borrar la búsqueda</ion-button>
            </ui-empty-state>
          } @else {
            <ui-empty-state icon="search-outline" title="Sin pares que enseñar">
              <p>
                Esta conexión no ha devuelto ningún mercado. Vuelve a intentarlo en unos segundos.
              </p>
            </ui-empty-state>
          }
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
  styles: [
    `
      /* El chrome cuelga de la clase de la hoja, que solo lleva este componente.
         Sin topes de altura a proposito: asi Ionic la pinta a pantalla completa en
         el movil y como tarjeta centrada en escritorio, y el teclado no pelea
         con los topes de altura de una hoja parcial. */
      ion-modal.pair-sheet {
        --background: var(--surface-base);
        --backdrop-opacity: 0.6;
      }

      ion-content.pairbody {
        --background: var(--surface-base);
        --padding-start: var(--space-4);
        --padding-end: var(--space-4);
        --padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
      }

      /* Cabecera y buscador quietos al desplazar: con 546 pares, perder de
         vista el campo de busqueda obliga a subir del todo para corregir una
         letra. Fondo opaco y borde porque las filas pasan por debajo. */
      .pairtop {
        position: sticky;
        top: 0;
        z-index: 2;
        background: var(--surface-base);
        border-bottom: 1px solid rgba(46, 43, 82, 0.6);
      }

      .pairhead {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding-top: calc(var(--space-2) + env(safe-area-inset-top));

        h2 {
          flex-grow: 1;
          margin: 0;
          font-family: var(--font-display);
          font-size: 19px;
          font-weight: 700;
          letter-spacing: -0.02em;
        }

        /* 44 px: es la unica salida de una pantalla que se abre encima de todo. */
        .x {
          flex-shrink: 0;
          width: 44px;
          height: 44px;
          display: grid;
          place-items: center;
          padding: 0;
          border: 0;
          border-radius: var(--radius-pill);
          background: var(--surface-2);
          color: var(--text-1);

          ion-icon {
            font-size: 20px;
          }
        }
      }

      /* La barra de Ionic viene con su propio relleno y su sombra; se acota AQUI
         y no en la hoja global para no cambiarle el aspecto a la de Mercados. */
      ion-searchbar {
        --background: var(--surface-2);
        --border-radius: var(--radius-sm);
        --box-shadow: none;
        --color: var(--text-1);
        --placeholder-color: var(--text-3);
        --icon-color: var(--text-3);
        padding: var(--space-2) 0 0;
        font-size: 14px;
      }

      .pairwhy {
        margin: var(--space-2) 0 var(--space-2);
        font-size: 11px;
        color: var(--text-3);
      }

      .pairlist {
        display: flex;
        flex-direction: column;
      }

      /* 60 px: dos lineas de texto y sitio para el pulgar. La fila entera es el
         boton, no un div con manejador de click: asi se llega con el tabulador y el
         lector de pantalla anuncia cual esta elegido. */
      .pair {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        width: 100%;
        min-height: 60px;
        padding: 10px var(--space-2);
        border: 0;
        border-bottom: 1px solid rgba(46, 43, 82, 0.6);
        border-radius: var(--radius-xs);
        background: transparent;
        color: var(--text-1);
        text-align: left;

        &:last-child {
          border-bottom: 0;
        }

        &.on {
          background: var(--surface-2);
        }

        .id {
          flex-grow: 1;
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }

        .top {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .name {
          font-size: 14.5px;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .sub {
          font-size: 11px;
          color: var(--text-3);
        }

        .px {
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 2px;

          b {
            font-size: 13.5px;
            font-weight: 600;
          }

          em {
            font-style: normal;
            font-size: 11px;
          }
        }

        /* Reserva su hueco siempre: si apareciera solo en el elegido, la fila
           entera se desplazaria al cambiar de par. */
        .tick {
          flex-shrink: 0;
          font-size: 18px;
          color: var(--brand-2);
          visibility: hidden;
        }

        &.on .tick {
          visibility: visible;
        }
      }
    `,
  ],
})
export class UiPairSheetComponent {
  private readonly md = inject(MarketDataService);
  private readonly botsSvc = inject(BotsService);

  /** El catálogo que la pantalla ya tiene cargado, filtrado por venue y red. */
  readonly markets = input<Market[]>([]);
  /** El par elegido ahora, solo para marcarlo. */
  readonly symbol = input<string>('');
  readonly open = model(false);
  /** Emite `Market.symbol`, nunca el canónico: es lo que espera el resto del asistente. */
  readonly picked = output<string>();

  readonly query = signal('');

  readonly compact = compact;
  readonly price = price;
  readonly pct = pct;
  readonly pnlColor = pnlColor;

  private readonly buscador = viewChild(IonSearchbar);

  /**
   * Los precios salen de la instantánea (`tickers()`), no de `tickerMap()`.
   *
   * `tickerMap()` se rehace cinco veces por segundo al superponer los ticks en
   * vivo, y con 546 pares de Aster eso serían 546 filas repintadas a ese ritmo
   * mientras alguien escribe. Para elegir un par, un precio de hace medio
   * minuto sobra. Tampoco se declara ningún `watch`: la pestaña de Mercados sí
   * lo hace con sus 60 filas visibles y aquí cada tecla dispararía una petición.
   * Si la instantánea aún no ha llegado, no hay precio ni volumen y la lista
   * queda en orden alfabético, que es la caída correcta.
   */
  readonly rows = computed<PairRow[]>(() => {
    const precios = new Map(this.md.tickers().map((t) => [`${t.venue}:${t.symbol}`, t]));
    const porPar = new Map<string, number>();
    for (const b of this.botsSvc.bots()) {
      const k = `${b.venue}:${b.symbol}`;
      porPar.set(k, (porPar.get(k) ?? 0) + 1);
    }

    return this.markets().map((m) => {
      const t = precios.get(`${m.venue}:${m.symbol}`);
      return {
        symbol: m.symbol,
        canonical: m.canonical,
        base: m.base,
        maxLeverage: m.max_leverage,
        decimals: m.price_decimals,
        last: t?.last ?? null,
        changePct: t?.changePct24h ?? null,
        volume: t?.volume24h ?? null,
        bots: porPar.get(`${m.venue}:${m.symbol}`) ?? 0,
      };
    });
  });

  /**
   * Lo que se pinta: filtrado por lo escrito y ordenado.
   *
   * El filtro mira `symbol`, `base` y también `canonical`, que es lo que el
   * usuario tiene delante («BTC/USDC»). Se ordena sobre una copia: `sort` muta,
   * y `rows()` es el resultado cacheado de un `computed`.
   */
  readonly visible = computed<PairRow[]>(() => {
    const q = this.query().trim().toUpperCase();
    const filas = q
      ? this.rows().filter(
          (r) =>
            r.symbol.toUpperCase().includes(q) ||
            r.base.toUpperCase().includes(q) ||
            r.canonical.toUpperCase().includes(q),
        )
      : [...this.rows()];

    return filas.sort((a, b) => {
      if (q) {
        const ra = relevanciaDePar(a, q);
        const rb = relevanciaDePar(b, q);
        if (ra !== rb) return ra - rb;
      }
      const va = Number(a.volume ?? 0);
      const vb = Number(b.volume ?? 0);
      if (va !== vb) return vb - va;
      return a.canonical.localeCompare(b.canonical);
    });
  });

  constructor() {
    addIcons({ closeOutline, checkmarkOutline, searchOutline });
    // Cada apertura empieza en blanco: la búsqueda anterior es de otra sesión y
    // de otra conexión, y encontrarse la lista ya filtrada por algo que uno no
    // recuerda haber escrito parece que faltan pares.
    effect(() => {
      if (this.open()) this.query.set('');
    });
  }

  /** El foco al buscador en cuanto la hoja está presentada. */
  enfocar(): void {
    void this.buscador()?.setFocus();
  }

  elegir(row: PairRow): void {
    this.picked.emit(row.symbol);
    // Elegir cierra la hoja: es la acción por la que se abrió.
    this.open.set(false);
  }

  elegirPrimero(): void {
    const primera = this.visible()[0];
    if (primera) this.elegir(primera);
  }
}
