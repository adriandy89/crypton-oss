import {
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonPopover,
  IonRefresher,
  IonRefresherContent,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  checkmark,
  chevronDownOutline,
  layersOutline,
  searchOutline,
  star,
  starOutline,
  statsChartOutline,
  swapVerticalOutline,
} from 'ionicons/icons';
import {
  BotsService,
  MarketDataService,
  MarketsService,
  NetworkService,
  ToastService,
} from '../../core/services';
import type { Market, Venue } from '../../core/models';
import { compact, errorText, pct, price, venueLabel } from '../../core/utils';
import { UiBadgeComponent, UiEmptyStateComponent } from '../../shared/ui';
import { FavouriteMarketsService } from './favourites.service';

type Tab = 'ALL' | 'FAV' | 'BOT';
type SortKey = 'VOLUME' | 'CHANGE' | 'NAME';

/**
 * Los criterios de orden, con la etiqueta corta que va en la pastilla y la
 * larga —con su porqué— que va en el desplegable.
 */
const SORTS: { key: SortKey; short: string; label: string; hint: string }[] = [
  { key: 'VOLUME', short: 'Volumen', label: 'Volumen 24 h', hint: 'Lo más negociado primero' },
  { key: 'CHANGE', short: 'Cambio', label: 'Cambio 24 h', hint: 'Lo que más sube, primero' },
  { key: 'NAME', short: 'Nombre', label: 'Nombre', hint: 'Alfabético por moneda' },
];

/**
 * Cuántas filas reciben precio en vivo.
 *
 * El mismo tope que aplica la API. Son las que caben en pantalla con holgura
 * en cualquier dispositivo; el resto de la lista vive de la instantánea.
 */
const LIVE_ROWS = 60;

/** Una fila de la lista: el catálogo unido al precio en vivo. */
interface Row {
  venue: Venue;
  symbol: string;
  base: string;
  quote: string;
  decimals: number;
  last: string;
  changePct: number | null;
  volume: string | null;
  bots: number;
  favourite: boolean;
  key: string;
}

@Component({
  selector: 'app-markets-list',
  standalone: true,
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    IonPopover,
    IonRefresher,
    IonRefresherContent,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
    UiBadgeComponent,
    UiEmptyStateComponent,
  ],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Mercados</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="searching.set(!searching())">
            <ion-icon slot="icon-only" name="search-outline" />
          </ion-button>
        </ion-buttons>
      </ion-toolbar>

      @if (searching()) {
        <ion-toolbar>
          <ion-searchbar
            placeholder="Buscar par o moneda"
            [debounce]="200"
            (ionInput)="query.set($any($event.target).value ?? '')"
          />
        </ion-toolbar>
      }

      <ion-toolbar>
        <ion-segment [value]="tab()" (ionChange)="tab.set($any($event.detail.value))">
          <ion-segment-button value="ALL">Todos</ion-segment-button>
          <ion-segment-button value="FAV">Favoritos</ion-segment-button>
          <ion-segment-button value="BOT">Con bot</ion-segment-button>
        </ion-segment>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <ion-refresher slot="fixed" (ionRefresh)="reload($event)">
        <ion-refresher-content />
      </ion-refresher>

      <!-- Filtros. Cada uno abre su lista de opciones: antes rodaban al tocar
           —un toque, la siguiente opción— y eso obliga a adivinar cuántas hay
           y a dar tres toques para volver a la primera. Con la lista a la
           vista se ve el estado, se ve lo que hay y se salta en un toque. -->
      <div class="filters">
        <button
          id="f-venue"
          type="button"
          class="chip"
          [class.on]="venue() !== null"
          [class.open]="venueOpen()"
          aria-haspopup="listbox"
        >
          <ion-icon class="lead" name="layers-outline" />
          <span>{{ venue() ? venueLabel(venue()!) : 'Todas' }}</span>
          <ion-icon class="caret" name="chevron-down-outline" />
        </button>

        <button
          id="f-sort"
          type="button"
          class="chip"
          [class.on]="sort() !== 'VOLUME'"
          [class.open]="sortOpen()"
          aria-haspopup="listbox"
        >
          <ion-icon class="lead" name="swap-vertical-outline" />
          <span>{{ sortShort() }}</span>
          <ion-icon class="caret" name="chevron-down-outline" />
        </button>

        <!-- Cuántos pares está enseñando el filtro. Sin esto, filtrar por una
             plataforma sin mercados deja una pantalla vacía sin explicación. -->
        <span class="count num">{{ visible().length }}</span>

        <!-- Estado del feed, derivado de señales y NUNCA del reloj: leer la
             hora actual aquí da un valor distinto en cada una de las dos
             pasadas de detección de cambios de Angular y dispara NG0100. -->
        @switch (data.tickersState()) {
          @case ('live') {
            <span class="stamp"><i class="dot live"></i>en vivo</span>
          }
          @case ('down') {
            <span class="stamp bad"><i class="dot bad"></i>sin conexión</span>
          }
          @default {
            <span class="stamp"><i class="dot"></i>cargando</span>
          }
        }
      </div>

      @if (loading() && rows().length === 0) {
        <div class="center"><ion-spinner name="crescent" /></div>
      } @else if (visible().length === 0) {
        @if (query()) {
          <ui-empty-state icon="search-outline" title="Nada para «{{ query() }}»">
            <p>No hay ningún par con ese nombre en las plataformas que soportamos.</p>
            <ion-button fill="outline" (click)="query.set(''); searching.set(false)">
              Borrar la búsqueda
            </ion-button>
          </ui-empty-state>
        } @else if (tab() === 'FAV') {
          <ui-empty-state icon="star-outline" title="Todavía no tienes favoritos">
            <p>
              Toca la estrella de un par para tenerlo siempre arriba. Se guarda en este dispositivo,
              no sale de aquí.
            </p>
          </ui-empty-state>
        } @else if (tab() === 'BOT') {
          <ui-empty-state icon="stats-chart-outline" title="Ningún bot operando todavía">
            <p>Aquí aparecerán los pares en los que tengas bots, con su precio en vivo.</p>
          </ui-empty-state>
        } @else if (venue()) {
          <!-- Filtrado por una plataforma que no tiene nada. Sin esta rama caía
               en «todavía no hay mercados», que culpa al catálogo de lo que ha
               hecho el filtro. -->
          <ui-empty-state icon="layers-outline" title="Nada en {{ venueLabel(venue()!) }}">
            <p>Esta plataforma no tiene ningún par que encaje con lo que hay filtrado.</p>
            <ion-button fill="outline" (click)="venue.set(null)">
              Ver todas las plataformas
            </ion-button>
          </ui-empty-state>
        } @else {
          <ui-empty-state
            icon="stats-chart-outline"
            [title]="testnet() ? 'Todavía no hay mercados de testnet' : 'Todavía no hay mercados'"
          >
            <p>
              El catálogo se sincroniza cada 10 minutos y también al arrancar. Si acabas de levantar
              la plataforma, dale un momento.
              @if (testnet()) {
                Los mercados de la red real siguen ahí: apaga el interruptor de testnet en Cuenta
                para verlos.
              }
            </p>
            <ion-button fill="outline" (click)="reload()">Actualizar</ion-button>
          </ui-empty-state>
        }
      } @else {
        <div class="list">
          @for (row of visible(); track row.key) {
            <div class="mkt" (click)="open(row)">
              <button
                type="button"
                class="fav"
                [class.on]="row.favourite"
                (click)="toggleFav($event, row)"
                [attr.aria-label]="row.favourite ? 'Quitar de favoritos' : 'Añadir a favoritos'"
              >
                <ion-icon [name]="row.favourite ? 'star' : 'star-outline'" />
              </button>

              <div class="id">
                <div class="top">
                  <span class="pair">{{ row.base }}/{{ row.quote }}</span>
                  <span class="venue" [attr.data-v]="row.venue">{{ venueLabel(row.venue) }}</span>
                </div>
                <div class="sub">
                  <span class="num">Vol {{ compact(row.volume) }}</span>
                  @if (row.bots > 0) {
                    <ui-badge size="sm" square tone="brand">
                      {{ row.bots }} {{ row.bots === 1 ? 'bot' : 'bots' }}
                    </ui-badge>
                  }
                </div>
              </div>

              <div class="px">
                <b class="num">{{ price(row.last, row.decimals) }}</b>
                <em class="num" [class]="'c-' + tone(row.changePct)">{{ pct(row.changePct) }}</em>
              </div>
            </div>
          }
        </div>
      }
    </ion-content>

    <!-- Los desplegables van FUERA de <ion-content> a propósito: dentro
         quedarían dentro del contenedor que hace scroll, y basta con que la
         lista se mueva bajo un menú abierto para que el menú se quede
         apuntando a donde estaba el botón. -->
    <ion-popover
      class="picker"
      trigger="f-venue"
      side="bottom"
      alignment="start"
      [dismissOnSelect]="true"
      (ionPopoverWillPresent)="venueOpen.set(true)"
      (ionPopoverDidDismiss)="venueOpen.set(false)"
    >
      <ng-template>
        <div class="opts" role="listbox">
          <button
            type="button"
            class="opt"
            role="option"
            [attr.aria-selected]="venue() === null"
            [class.on]="venue() === null"
            (click)="venue.set(null)"
          >
            <span class="txt">Todas las plataformas</span>
            <span class="tally num">{{ rows().length }}</span>
            <ion-icon name="checkmark" />
          </button>
          @for (v of venues(); track v) {
            <button
              type="button"
              class="opt"
              role="option"
              [attr.aria-selected]="venue() === v"
              [class.on]="venue() === v"
              (click)="venue.set(v)"
            >
              <span class="txt">{{ venueLabel(v) }}</span>
              <span class="tally num">{{ countOf(v) }}</span>
              <ion-icon name="checkmark" />
            </button>
          }
        </div>
      </ng-template>
    </ion-popover>

    <ion-popover
      class="picker"
      trigger="f-sort"
      side="bottom"
      alignment="start"
      [dismissOnSelect]="true"
      (ionPopoverWillPresent)="sortOpen.set(true)"
      (ionPopoverDidDismiss)="sortOpen.set(false)"
    >
      <ng-template>
        <div class="opts" role="listbox">
          @for (o of SORTS; track o.key) {
            <button
              type="button"
              class="opt"
              role="option"
              [attr.aria-selected]="sort() === o.key"
              [class.on]="sort() === o.key"
              (click)="sort.set(o.key)"
            >
              <span class="txt"
                >{{ o.label }}<em>{{ o.hint }}</em></span
              >
              <ion-icon name="checkmark" />
            </button>
          }
        </div>
      </ng-template>
    </ion-popover>
  `,
  styleUrl: './markets-list.page.scss',
})
export class MarketsListPage implements OnInit {
  private readonly markets = inject(MarketsService);
  private readonly bots = inject(BotsService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly data = inject(MarketDataService);
  readonly favourites = inject(FavouriteMarketsService);
  private readonly network = inject(NetworkService);
  /** La red que se esta mirando: el catalogo y los favoritos van por ella. */
  readonly testnet = this.network.testnet;

  readonly tab = signal<Tab>('ALL');
  readonly venue = signal<Venue | null>(null);
  readonly sort = signal<SortKey>('VOLUME');
  readonly query = signal('');
  readonly searching = signal(false);
  readonly loading = signal(false);

  private readonly catalogue = signal<Market[]>([]);

  readonly compact = compact;
  readonly price = price;
  readonly pct = pct;
  readonly venueLabel = venueLabel;

  /**
   * El catálogo unido a los precios.
   *
   * Son dos fuentes a propósito: el catálogo vive en Postgres y trae los
   * decimales con los que hay que pintar cada precio; los precios vienen de una
   * caché que se refresca sola. Unirlos aquí evita que la API tenga que servir
   * una tercera forma que sería la suma de las otras dos.
   */
  readonly rows = computed<Row[]>(() => {
    // La instantanea CON los precios en vivo ya puestos: ver `tickerMap`.
    const prices = this.data.tickerMap();
    // Los favoritos llevan la red en su clave; `key` NO, porque `key` es el
    // formato con el que se declara el interes al servidor.
    const testnet = this.network.testnet();
    const botsPerPair = new Map<string, number>();
    for (const bot of this.bots.bots()) {
      const key = `${bot.venue}:${bot.symbol}`;
      botsPerPair.set(key, (botsPerPair.get(key) ?? 0) + 1);
    }

    return this.catalogue().map((m) => {
      const key = `${m.venue}:${m.symbol}`;
      const t = prices.get(key);
      const changePct =
        t?.changePct24h === null || t?.changePct24h === undefined ? null : Number(t.changePct24h);
      return {
        venue: m.venue,
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        decimals: m.price_decimals,
        last: t?.last ?? '',
        changePct: Number.isFinite(changePct) ? changePct : null,
        volume: t?.volume24h ?? null,
        bots: botsPerPair.get(key) ?? 0,
        favourite: this.favourites.has(this.favourites.keyOf(m.venue, m.symbol, testnet)),
        key,
      } satisfies Row;
    });
  });

  readonly visible = computed(() => {
    const q = this.query().trim().toUpperCase();
    const venue = this.venue();
    const tab = this.tab();

    const filtered = this.rows().filter((r) => {
      if (venue && r.venue !== venue) return false;
      if (tab === 'FAV' && !r.favourite) return false;
      if (tab === 'BOT' && r.bots === 0) return false;
      if (q && !r.symbol.toUpperCase().includes(q) && !r.base.toUpperCase().includes(q)) {
        return false;
      }
      return true;
    });

    const key = this.sort();
    return filtered.sort((a, b) => {
      // Los favoritos primero SIEMPRE: es lo que el usuario ha dicho que le
      // importa, y hundirlos bajo el criterio de orden anula el gesto.
      if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
      switch (key) {
        case 'CHANGE':
          // Los que no tienen cambio van al final, y entre ellos el orden es
          // estable. Restar dos `-Infinity` da NaN, y un comparador que
          // devuelve NaN deja el orden de `sort` sin definir.
          if (a.changePct === null || b.changePct === null) {
            return a.changePct === b.changePct ? 0 : a.changePct === null ? 1 : -1;
          }
          return b.changePct - a.changePct;
        case 'NAME':
          return a.base.localeCompare(b.base) || a.venue.localeCompare(b.venue);
        default:
          return Number(b.volume ?? 0) - Number(a.volume ?? 0);
      }
    });
  });

  /** ¿Está abierto cada desplegable? Solo para girar su flecha. */
  readonly venueOpen = signal(false);
  readonly sortOpen = signal(false);

  /** Las opciones de orden, con su porqué. La plantilla las recorre. */
  readonly SORTS = SORTS;

  /**
   * Las plataformas que hay EN EL CATÁLOGO, no una constante.
   *
   * Una cuarta plataforma aparece aquí sola, que es la regla de toda la
   * pantalla; y una que todavía no haya sincronizado no sale como una opción
   * que no filtra nada.
   */
  readonly venues = computed(() => [...new Set(this.catalogue().map((m) => m.venue))].sort());

  /** Cuántos pares hay en cada plataforma, para enseñarlo en el desplegable. */
  private readonly perVenue = computed(() => {
    const counts = new Map<Venue, number>();
    for (const m of this.catalogue()) counts.set(m.venue, (counts.get(m.venue) ?? 0) + 1);
    return counts;
  });

  countOf(venue: Venue): number {
    return this.perVenue().get(venue) ?? 0;
  }

  /** Etiqueta corta para la pastilla; la larga vive en el desplegable. */
  readonly sortShort = computed(() => SORTS.find((o) => o.key === this.sort())?.short ?? 'Volumen');

  constructor() {
    addIcons({
      searchOutline,
      chevronDownOutline,
      star,
      starOutline,
      statsChartOutline,
      layersOutline,
      swapVerticalOutline,
      checkmark,
    });

    // Los precios se reservan aquí y se sueltan al destruir el componente, en
    // el mismo par de líneas.
    //
    // ANTES esto colgaba de `ionViewWillEnter`/`ionViewWillLeave`, y ahí estaba
    // el fallo que se veía como «no se pinta nada hasta que refresco»: el
    // gráfico vive FUERA de las pestañas, así que al volver de él Ionic
    // encuentra `leavingView === enteringView` en el outlet de las pestañas y
    // no emite ningún evento de ciclo de vida. `ionViewWillEnter` no se volvía
    // a disparar, nadie rearrancaba el sondeo y la lista quedaba congelada
    // hasta que el usuario tiraba para refrescar —que repintaba una vez y no
    // reanudaba nada—. Con el ciclo de vida del componente esto no puede pasar:
    // si la pantalla existe, el feed está reservado.
    const release = this.data.watchTickers();
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(release);

    // Y se declara QUE se esta mirando, para recibirlo en vivo.
    //
    // Solo la cabecera de la lista, no los 935 pares: cada par mirado puede
    // acabar en una suscripcion al WebSocket de un venue, que es un recurso
    // contado y compartido con los bots que operan. El tope es el mismo que
    // aplica la API.
    //
    // Con esto, lo que hay en pantalla al abrir se mueve en tiempo real; el
    // resto de la lista se refresca con la instantanea, cada minuto. Seguir el
    // desplazamiento fila a fila pediria virtualizar la lista, que es otro
    // trabajo — y hoy la lista se abre siempre por arriba.
    const watch = this.data.watchSymbols();
    destroyRef.onDestroy(() => watch.release());
    effect(() => {
      // La lista se lee AQUI y se pasa dentro: `update` llama a `declare()`,
      // que lee otras señales, y sin `untracked` este efecto acabaria
      // dependiendo tambien de ellas sin que se viera.
      const claves = this.visible()
        .slice(0, LIVE_ROWS)
        .map((r) => r.key);
      untracked(() => watch.update(claves));
    });

    // Cambio de lente: el catalogo es OTRO.
    //
    // No basta con que el servicio cachee por red: la lista vive en `catalogue`,
    // una señal local que se llena una vez en `ngOnInit`. Sin esto, encender
    // testnet dejaba en pantalla los 935 pares de mainnet con la franja
    // encendida encima — que es justo la mentira que la franja debe evitar.
    let redAnterior: boolean | null = null;
    effect(() => {
      const testnet = this.network.testnet();
      // La primera pasada solo toma nota: `ngOnInit` ya carga el catalogo, y
      // sin esta guarda se pediria dos veces al abrir la pantalla.
      if (redAnterior === null) {
        redAnterior = testnet;
        return;
      }
      if (redAnterior === testnet) return;
      redAnterior = testnet;
      untracked(() => {
        this.catalogue.set([]);
        void this.markets
          .list()
          .then((m) => this.catalogue.set(m))
          .catch(() => undefined);
      });
    });
  }

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      // Las capacidades se piden aquí y no en el gráfico: al abrir un par ya
      // están, y la barra de intervalos no aparece medio segundo después.
      await Promise.all([
        this.data.loadCapabilities().catch(() => undefined),
        this.markets.list().then((m) => this.catalogue.set(m)),
        this.bots.refresh().catch(() => undefined),
      ]);
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.loading.set(false);
    }
  }

  async reload(event?: CustomEvent): Promise<void> {
    try {
      this.markets.invalidate();
      await Promise.all([
        this.markets.list().then((m) => this.catalogue.set(m)),
        this.data.refreshTickers(),
        this.bots.refresh().catch(() => undefined),
      ]);
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      void (event?.target as HTMLIonRefresherElement | undefined)?.complete();
    }
  }

  open(row: Row): void {
    void this.router.navigate(['/markets', row.venue, row.symbol]);
  }

  toggleFav(event: Event, row: Row): void {
    // Sin esto, marcar un favorito abre además el gráfico.
    event.stopPropagation();
    this.favourites.toggle(this.favourites.keyOf(row.venue, row.symbol, this.network.testnet()));
  }

  tone(changePct: number | null): string {
    if (changePct === null || changePct === 0) return 'medium';
    return changePct > 0 ? 'success' : 'danger';
  }
}
