import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { ToastService } from '../../core/services';
import { AdminUsersService, type AdminUserDetail } from '../../core/services/admin-users.service';
import { dayDate, errorText, shortDate, venueLabel } from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiEmptyStateComponent,
  UiNoticeComponent,
  UiSectionComponent,
  UiStatComponent,
} from '../../shared/ui';
import { AdminActionsService } from './admin-actions.service';
import { AdminForbiddenComponent } from './admin-forbidden.component';

/**
 * La ficha de una cuenta (spec 033).
 *
 * Solo lectura mas tres acciones. No hay nada aqui para cambiar el rol, y es
 * deliberado: el servidor tampoco lo ofrece.
 */
@Component({
  selector: 'app-admin-user-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonSpinner,
    IonTitle,
    IonToolbar,
    UiBadgeComponent,
    UiCardComponent,
    UiEmptyStateComponent,
    UiNoticeComponent,
    UiSectionComponent,
    UiStatComponent,
    AdminForbiddenComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/admin/users" text="" />
        </ion-buttons>
        <ion-title>Cuenta</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        @if (forbidden()) {
          <app-admin-forbidden />
        } @else if (noExiste()) {
          <ui-empty-state title="Esta cuenta ya no existe" icon="person-outline" />
        } @else if (!user()) {
          <div class="center"><ion-spinner name="crescent" /></div>
        } @else {
          @let u = user()!;

          <ui-card>
            <div class="cab">
              <span class="nom">{{ u.name }}</span>
              @if (u.role === 'ADMIN') {
                <ui-badge size="sm" tone="brand">admin</ui-badge>
              }
              @if (u.disabled) {
                <ui-badge size="sm" tone="down">deshabilitada</ui-badge>
              }
              @if (!u.emailVerified) {
                <ui-badge size="sm" tone="warn">sin verificar</ui-badge>
              }
            </div>
            <p class="mail mono">{{ u.email }}</p>
            <div class="stats">
              <ui-stat label="Alta" [value]="dayDate(u.createdAt)" />
              <ui-stat
                label="Último acceso"
                [value]="u.lastLoginAt ? shortDate(u.lastLoginAt) : '—'"
              />
              <ui-stat label="Bots" [value]="u.bots.total + ' (' + u.bots.live + ' vivos)'" />
            </div>
          </ui-card>

          @if (u.accounts.length) {
            <ui-section title="Conexiones" />
            <ui-card flush>
              @for (a of u.accounts; track a.id) {
                <div class="it">
                  <div class="l1">
                    <span class="nom">{{ a.label }}</span>
                    <ui-badge size="sm" tone="neutral">{{ venueLabel(a.venue) }}</ui-badge>
                    @if (a.testnet) {
                      <ui-badge size="sm" tone="warn" variant="outline">testnet</ui-badge>
                    }
                    @if (a.paper) {
                      <ui-badge size="sm" tone="warn">simulación</ui-badge>
                    }
                  </div>
                  <div class="l2 mono">{{ a.publicRef }}</div>
                </div>
              }
            </ui-card>
          }

          <ui-section title="Bots" />
          <ui-card flush>
            <a class="it link" [routerLink]="['/admin/bots']" [queryParams]="{ userId: u.id }">
              Ver sus {{ u.bots.total }} bots
            </a>
            <a class="it link" [routerLink]="['/admin/activity']" [queryParams]="{ actorId: u.id }">
              Ver su actividad
            </a>
          </ui-card>

          <ui-section title="Acciones" />
          <!-- Permanente y fuera del diálogo: esto hay que verlo ANTES de tocar
               nada, no en el momento de confirmar. -->
          <ui-notice tone="warn" icon="warning-outline">
            Deshabilitar impide entrar y renovar la sesión, y le cierra las abiertas al instante,
            pero <b>no para sus bots</b>: el motor sigue operando con su credencial. Si quieres que
            deje de operar, hay que contener sus bots uno a uno.
          </ui-notice>
          <ui-card flush>
            <div class="accion">
              <span>Cerrar todas sus sesiones</span>
              <ion-button size="small" fill="clear" (click)="cerrarSesiones()">Cerrar</ion-button>
            </div>
            <div class="accion">
              <span>{{ u.disabled ? 'Rehabilitar la cuenta' : 'Deshabilitar la cuenta' }}</span>
              @if (u.disabled) {
                <ion-button size="small" fill="clear" (click)="rehabilitar()"
                  >Rehabilitar</ion-button
                >
              } @else {
                <ion-button size="small" fill="clear" color="danger" (click)="deshabilitar()">
                  Deshabilitar
                </ion-button>
              }
            </div>
          </ui-card>
          <p class="fina">El rol no se cambia desde aquí, a propósito.</p>
        }
      </div>
    </ion-content>
  `,
  styles: [
    `
      .cab {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .nom {
        font-size: 13px;
        color: var(--text-1);
      }

      .mail {
        margin: 4px 0 var(--space-3);
        font-size: 11.5px;
        color: var(--text-2);
        overflow-wrap: anywhere;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
        gap: var(--space-2);
      }

      .it {
        display: block;
        padding: 9px var(--space-4);
        border-bottom: 1px solid var(--border-subtle);

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

      .l2 {
        margin-top: 2px;
        font-size: 11px;
        color: var(--text-3);
        overflow-wrap: anywhere;
      }

      .link {
        color: var(--brand-2);
        font-size: 12px;
        text-decoration: none;
      }

      .accion {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: 4px var(--space-4);
        border-bottom: 1px solid var(--border-subtle);
        font-size: 12px;
        color: var(--text-1);

        &:last-child {
          border-bottom: 0;
        }
      }

      .center {
        display: flex;
        justify-content: center;
        padding: var(--space-6) 0;
      }

      .fina {
        margin: var(--space-3) 0 var(--space-6);
        font-size: 11px;
        color: var(--text-3);
      }
    `,
  ],
})
export class AdminUserDetailPage implements OnInit {
  private readonly api = inject(AdminUsersService);
  private readonly acciones = inject(AdminActionsService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly user = signal<AdminUserDetail | null>(null);
  readonly forbidden = signal(false);
  /**
   * Una cuenta borrada mientras la mirabas deja la pantalla vacia, y un aviso
   * flotante sobre una pantalla vacia es un callejon sin salida: se dice aqui.
   */
  readonly noExiste = signal(false);

  readonly dayDate = dayDate;
  readonly shortDate = shortDate;
  readonly venueLabel = venueLabel;

  private id = '';

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    void this.cargar();
  }

  deshabilitar(): void {
    const u = this.user();
    if (u) void this.acciones.deshabilitar(u, () => this.cargar());
  }

  rehabilitar(): void {
    const u = this.user();
    if (u) void this.acciones.rehabilitar(u, () => this.cargar());
  }

  cerrarSesiones(): void {
    const u = this.user();
    if (u) void this.acciones.cerrarSesiones(u, () => this.cargar());
  }

  private async cargar(): Promise<void> {
    try {
      this.user.set(await this.api.detail(this.id));
      this.forbidden.set(false);
      this.noExiste.set(false);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) this.forbidden.set(true);
      else if (status === 404) this.noExiste.set(true);
      else await this.toast.error(errorText(e));
    }
  }
}
