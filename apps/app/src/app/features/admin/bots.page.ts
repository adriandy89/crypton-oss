import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { ToastService } from '../../core/services';
import {
  AdminBotsService,
  type AdminBotRow,
  type AdminBotsFilters,
} from '../../core/services/admin-bots.service';
import type { BotStatus, StrategyKind, Venue } from '../../core/models';
import { ago, errorText, strategyLabel, venueLabel } from '../../core/utils';
import { UiBadgeComponent, UiCardComponent, UiStatusPillComponent } from '../../shared/ui';
import { AdminForbiddenComponent } from './admin-forbidden.component';

const PAGINA = 30;

const VENUES: Venue[] = ['HYPERLIQUID', 'LIGHTER', 'ASTER'];
const ESTADOS: BotStatus[] = [
  'RUNNING',
  'PAUSED',
  'STARTING',
  'STOPPING',
  'STOPPED',
  'ERROR',
  'LIQUIDATED',
  'DRAFT',
];
const ESTRATEGIAS: StrategyKind[] = [
  'GRID_CLASSIC',
  'NEUTRAL_GRID',
  'TDCA',
  'MARTINGALE',
  'GRIDMART',
  'MARKET_MAKER',
  'MARKET_MAKER_V2',
];

/**
 * Todos los bots de la plataforma (spec 033).
 *
 * El filtro por usuario no tiene control propio: llega por `queryParams` desde
 * la ficha de una cuenta y se pinta como un chip que se quita tocandolo. Es un
 * filtro contextual, no una opcion de un menu.
 */
@Component({
  selector: 'app-admin-bots',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonSearchbar,
    IonSpinner,
    IonTitle,
    IonToolbar,
    UiBadgeComponent,
    UiCardComponent,
    UiStatusPillComponent,
    AdminForbiddenComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/admin" text="" />
        </ion-buttons>
        <ion-title>Bots</ion-title>
      </ion-toolbar>
      <ion-toolbar>
        <ion-searchbar
          placeholder="Buscar por símbolo o correo del dueño"
          [debounce]="300"
          (ionInput)="setBusqueda($any($event.target).value ?? '')"
        />
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        @if (forbidden()) {
          <app-admin-forbidden />
        } @else {
          <div class="filters">
            @if (userId()) {
              <button type="button" class="chip on" (click)="quitarUsuario()">
                usuario filtrado ✕
              </button>
            }
            <select
              class="sel"
              [value]="venue() ?? ''"
              (change)="setVenue($any($event.target).value)"
            >
              <option value="">Todos los venues</option>
              @for (v of venues; track v) {
                <option [value]="v">{{ venueLabel(v) }}</option>
              }
            </select>
            <select
              class="sel"
              [value]="estado() ?? ''"
              (change)="setEstado($any($event.target).value)"
            >
              <option value="">Todos los estados</option>
              @for (s of estados; track s) {
                <option [value]="s">{{ s }}</option>
              }
            </select>
            <select
              class="sel"
              [value]="estrategia() ?? ''"
              (change)="setEstrategia($any($event.target).value)"
            >
              <option value="">Todas las estrategias</option>
              @for (e of estrategias; track e) {
                <option [value]="e">{{ strategyLabel(e) }}</option>
              }
            </select>
            <button
              type="button"
              class="chip"
              [class.on]="soloSimulados()"
              [attr.aria-pressed]="soloSimulados()"
              (click)="toggleSimulados()"
            >
              Simulados
            </button>
            <button
              type="button"
              class="chip"
              [class.on]="soloErrores()"
              [attr.aria-pressed]="soloErrores()"
              (click)="toggleErrores()"
            >
              Con error
            </button>
          </div>

          @if (cargando() && filas().length === 0) {
            <div class="center"><ion-spinner name="crescent" /></div>
          } @else if (filas().length === 0) {
            <p class="empty">Ningún bot con estos filtros.</p>
          } @else {
            <ui-card flush class="lista">
              @for (b of filas(); track b.id) {
                <a class="it" [routerLink]="['/admin/bots', b.id]">
                  <div class="l1">
                    <span class="nom">{{ b.name }}</span>
                    <ui-status-pill [status]="b.status" />
                    @if (b.dryRun || b.paper) {
                      <ui-badge size="sm" tone="warn">simulación</ui-badge>
                    }
                    @if (b.testnet) {
                      <ui-badge size="sm" tone="warn" variant="outline">testnet</ui-badge>
                    }
                    @if (b.lastError) {
                      <ui-badge size="sm" tone="down">error</ui-badge>
                    }
                  </div>
                  <div class="l2 mono">
                    {{ b.symbol }} · {{ venueLabel(b.venue) }} · {{ strategyLabel(b.strategy) }}
                  </div>
                  <div class="l3">
                    {{ b.owner.name }} · {{ b.owner.email }} · tick {{ hace(b.lastTickAt) }}
                  </div>
                </a>
              }
            </ui-card>

            <div class="mas">
              <span class="cuenta">{{ filas().length }} de {{ total() }}</span>
              @if (hayMas()) {
                <button type="button" class="chip" [disabled]="cargando()" (click)="mas()">
                  {{ cargando() ? 'Cargando…' : 'Cargar más' }}
                </button>
              }
            </div>
          }
        }
      </div>
    </ion-content>
  `,
  styles: [
    `
      .filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        margin: var(--space-3) 0;
      }

      .chip,
      .sel {
        min-height: 34px;
        padding: 0 10px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        background: var(--surface-2);
        color: var(--text-2);
        font-family: var(--font-ui);
        font-size: 11.5px;
      }

      .chip.on {
        border-color: transparent;
        background: var(--surface-3);
        color: var(--brand-2);
        font-weight: 700;
      }

      .lista .it {
        display: block;
        padding: 9px var(--space-4);
        border-bottom: 1px solid var(--border-subtle);
        text-decoration: none;

        &:last-child {
          border-bottom: 0;
        }
      }

      .l1 {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .nom {
        font-size: 12.5px;
        color: var(--text-1);
      }

      .l2 {
        margin-top: 2px;
        font-size: 11px;
        color: var(--text-2);
      }

      .l3 {
        margin-top: 1px;
        font-size: 10.5px;
        color: var(--text-3);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .center {
        display: flex;
        justify-content: center;
        padding: var(--space-6) 0;
      }

      .empty {
        padding: var(--space-6) 0;
        color: var(--text-3);
        font-size: 12px;
        text-align: center;
      }

      .mas {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        margin: var(--space-3) 0 var(--space-6);
      }

      .cuenta {
        font-size: 11px;
        color: var(--text-3);
      }
    `,
  ],
})
export class AdminBotsPage implements OnInit {
  private readonly api = inject(AdminBotsService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly venues = VENUES;
  readonly estados = ESTADOS;
  readonly estrategias = ESTRATEGIAS;

  readonly filas = signal<AdminBotRow[]>([]);
  readonly cargando = signal(false);
  readonly forbidden = signal(false);
  readonly total = signal(0);
  readonly hayMas = signal(false);
  readonly pagina = signal(1);

  readonly userId = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly venue = signal<Venue | null>(null);
  readonly estado = signal<BotStatus | null>(null);
  readonly estrategia = signal<StrategyKind | null>(null);
  readonly soloSimulados = signal(false);
  readonly soloErrores = signal(false);

  readonly venueLabel = venueLabel;
  readonly strategyLabel = strategyLabel;

  ngOnInit(): void {
    this.userId.set(this.route.snapshot.queryParamMap.get('userId'));
    void this.cargar(1);
  }

  hace(iso: string | null): string {
    return iso ? ago(Date.parse(iso)) : '—';
  }

  quitarUsuario(): void {
    this.userId.set(null);
    void this.cargar(1);
  }

  /**
   * Una caja para dos cosas: si lleva arroba es un correo, si no un simbolo.
   *
   * El servidor tiene un filtro para cada uno, pero pedirle al administrador que
   * elija cual esta usando en una pantalla de movil es pedirle que piense por el
   * formulario.
   */
  setBusqueda(v: string): void {
    this.busqueda.set(v.trim());
    void this.cargar(1);
  }

  setVenue(v: string): void {
    this.venue.set((v || null) as Venue | null);
    void this.cargar(1);
  }

  setEstado(v: string): void {
    this.estado.set((v || null) as BotStatus | null);
    void this.cargar(1);
  }

  setEstrategia(v: string): void {
    this.estrategia.set((v || null) as StrategyKind | null);
    void this.cargar(1);
  }

  toggleSimulados(): void {
    this.soloSimulados.update((v) => !v);
    void this.cargar(1);
  }

  toggleErrores(): void {
    this.soloErrores.update((v) => !v);
    void this.cargar(1);
  }

  mas(): void {
    if (this.cargando() || !this.hayMas()) return;
    void this.cargar(this.pagina() + 1);
  }

  private async cargar(page: number): Promise<void> {
    this.cargando.set(true);
    try {
      const res = await this.api.list(this.filtros(), page, PAGINA);
      this.filas.set(page === 1 ? res.data : [...this.filas(), ...res.data]);
      this.pagina.set(res.meta.page);
      this.total.set(res.meta.itemCount);
      this.hayMas.set(res.meta.hasNextPage);
      this.forbidden.set(false);
    } catch (e) {
      if ((e as { status?: number }).status === 403) this.forbidden.set(true);
      else await this.toast.error(errorText(e));
    } finally {
      this.cargando.set(false);
    }
  }

  private filtros(): AdminBotsFilters {
    const q = this.busqueda();
    return {
      ...(this.userId() ? { userId: this.userId()! } : {}),
      ...(q.includes('@') ? { email: q } : q ? { symbol: q.toUpperCase() } : {}),
      ...(this.venue() ? { venue: this.venue()! } : {}),
      ...(this.estado() ? { status: this.estado()! } : {}),
      ...(this.estrategia() ? { strategy: this.estrategia()! } : {}),
      ...(this.soloSimulados() ? { dryRun: true } : {}),
      ...(this.soloErrores() ? { withError: true } : {}),
    };
  }
}
