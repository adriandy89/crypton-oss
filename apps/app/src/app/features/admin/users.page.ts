import { ChangeDetectionStrategy, Component, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { inject } from '@angular/core';
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
  AdminUsersService,
  type AdminUserRow,
  type AdminUsersFilters,
} from '../../core/services/admin-users.service';
import { ago, dayDate, errorText } from '../../core/utils';
import { UiBadgeComponent, UiCardComponent } from '../../shared/ui';
import { AdminForbiddenComponent } from './admin-forbidden.component';

/** El tope del servidor es 101; treinta llena una pantalla de movil de sobra. */
const PAGINA = 30;

type Orden = NonNullable<AdminUsersFilters['sortBy']>;

/**
 * Todas las cuentas de la plataforma (spec 033).
 *
 * Sin tabla: esto es un movil. La unidad es la fila de dos lineas, la misma que
 * usa la pantalla de Actividad, y el correo SE MUESTRA —al contrario que la IP
 * alli— porque es el identificador con el que se busca a alguien: ocultarlo
 * dejaria una lista de nombres repetidos e inservible. La pantalla ya es solo de
 * administracion y cada lectura queda auditada.
 */
@Component({
  selector: 'app-admin-users',
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
    AdminForbiddenComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/admin" text="" />
        </ion-buttons>
        <ion-title>Usuarios</ion-title>
      </ion-toolbar>
      <ion-toolbar>
        <ion-searchbar
          placeholder="Buscar por correo o nombre"
          [debounce]="300"
          (ionInput)="setQ($any($event.target).value ?? '')"
        />
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        @if (forbidden()) {
          <app-admin-forbidden />
        } @else {
          <div class="filters">
            <button
              type="button"
              class="chip"
              [class.on]="soloDeshabilitadas()"
              [attr.aria-pressed]="soloDeshabilitadas()"
              (click)="toggleDeshabilitadas()"
            >
              Deshabilitadas
            </button>
            <button
              type="button"
              class="chip"
              [class.on]="soloAdmins()"
              [attr.aria-pressed]="soloAdmins()"
              (click)="toggleAdmins()"
            >
              Administradores
            </button>
            <button
              type="button"
              class="chip"
              [class.on]="soloConBots()"
              [attr.aria-pressed]="soloConBots()"
              (click)="toggleConBots()"
            >
              Con bots
            </button>
            <select class="sel" [value]="orden()" (change)="setOrden($any($event.target).value)">
              <option value="last_login_at">Últimos en entrar</option>
              <option value="created_at">Más recientes</option>
              <option value="email">Correo</option>
              <option value="name">Nombre</option>
            </select>
          </div>

          @if (cargando() && filas().length === 0) {
            <div class="center"><ion-spinner name="crescent" /></div>
          } @else if (filas().length === 0) {
            <p class="empty">Ningún usuario con estos filtros.</p>
          } @else {
            <ui-card flush class="lista">
              @for (u of filas(); track u.id) {
                <a class="it" [routerLink]="['/admin/users', u.id]">
                  <div class="l1">
                    <span class="name">{{ u.name }}</span>
                    @if (u.role === 'ADMIN') {
                      <ui-badge size="sm" tone="brand">admin</ui-badge>
                    }
                    @if (u.disabled) {
                      <ui-badge size="sm" tone="down">deshabilitada</ui-badge>
                    }
                    @if (!u.emailVerified) {
                      <ui-badge size="sm" tone="warn">sin verificar</ui-badge>
                    }
                    <span class="when">{{ hace(u.lastLoginAt) }}</span>
                  </div>
                  <div class="l2 mono">
                    <span class="mail">{{ u.email }}</span>
                    <span class="d">·</span>
                    <span>{{ u.bots.total }} bots</span>
                    @if (u.bots.live > 0) {
                      <span class="viva">({{ u.bots.live }} vivos)</span>
                    }
                    <span class="d">·</span>
                    <span>alta {{ dayDate(u.createdAt) }}</span>
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

      .l1,
      .l2 {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .name {
        font-size: 12.5px;
        color: var(--text-1);
      }

      .when {
        margin-inline-start: auto;
        font-size: 11px;
        color: var(--text-3);
      }

      .l2 {
        margin-top: 2px;
        font-size: 11px;
        color: var(--text-2);

        .mail {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 60%;
        }

        .d {
          color: var(--text-3);
        }

        .viva {
          color: var(--signal-warn);
        }
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
export class AdminUsersPage implements OnInit {
  private readonly api = inject(AdminUsersService);
  private readonly toast = inject(ToastService);

  readonly filas = signal<AdminUserRow[]>([]);
  readonly cargando = signal(false);
  readonly forbidden = signal(false);
  readonly total = signal(0);
  readonly hayMas = signal(false);
  readonly pagina = signal(1);

  readonly q = signal('');
  readonly soloDeshabilitadas = signal(false);
  readonly soloAdmins = signal(false);
  readonly soloConBots = signal(false);
  readonly orden = signal<Orden>('last_login_at');

  /** Se reexpone para la plantilla: `strictTemplates` no ve las funciones sueltas. */
  readonly dayDate = dayDate;

  /** `ago` quiere epoch en milisegundos y la API manda ISO. Mismo puente que en Actividad. */
  hace(iso: string | null): string {
    return iso ? ago(Date.parse(iso)) : 'nunca entró';
  }

  ngOnInit(): void {
    void this.cargar(1);
  }

  setQ(v: string): void {
    this.q.set(v.trim());
    void this.cargar(1);
  }

  toggleDeshabilitadas(): void {
    this.soloDeshabilitadas.update((v) => !v);
    void this.cargar(1);
  }

  toggleAdmins(): void {
    this.soloAdmins.update((v) => !v);
    void this.cargar(1);
  }

  toggleConBots(): void {
    this.soloConBots.update((v) => !v);
    void this.cargar(1);
  }

  setOrden(v: string): void {
    this.orden.set(v as Orden);
    void this.cargar(1);
  }

  mas(): void {
    if (this.cargando() || !this.hayMas()) return;
    void this.cargar(this.pagina() + 1);
  }

  /**
   * La pagina 1 SUSTITUYE y las siguientes ACUMULAN.
   *
   * Es lo mismo que hace la pantalla de Actividad, y por lo mismo: cambiar un
   * filtro tiene que empezar de cero, y «cargar mas» tiene que añadir sin perder
   * lo que ya estabas leyendo.
   */
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
      // El guard de la app decide con el rol del token de este navegador; el
      // servidor decide de verdad. Cuando no coinciden se dice, no se deja la
      // pantalla en blanco.
      if ((e as { status?: number }).status === 403) this.forbidden.set(true);
      else await this.toast.error(errorText(e));
    } finally {
      this.cargando.set(false);
    }
  }

  private filtros(): AdminUsersFilters {
    return {
      ...(this.q() ? { q: this.q() } : {}),
      ...(this.soloDeshabilitadas() ? { disabled: true } : {}),
      ...(this.soloAdmins() ? { role: 'ADMIN' as const } : {}),
      ...(this.soloConBots() ? { withBots: true } : {}),
      sortBy: this.orden(),
    };
  }
}
