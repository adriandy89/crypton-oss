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
import { capitalActual } from '@crypton/shared';
import { ToastService } from '../../core/services';
import {
  ADMIN_BOT_COMMANDS,
  AdminBotsService,
  ETIQUETA_COMANDO,
  type AdminBotCommand,
  type AdminBotDetail,
} from '../../core/services/admin-bots.service';
import { errorText, money, shortDate, signed, strategyLabel, venueLabel } from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiEmptyStateComponent,
  UiLiqMeterComponent,
  UiNoticeComponent,
  UiSectionComponent,
  UiStatComponent,
  UiStatusPillComponent,
} from '../../shared/ui';
import { AdminActionsService } from './admin-actions.service';
import { AdminForbiddenComponent } from './admin-forbidden.component';

/** Estados en los que el motor tiene el bot y, por tanto, hay algo que contener. */
const CONTENIBLES = ['STARTING', 'RUNNING', 'PAUSED'];

/**
 * El detalle de un bot ajeno (spec 033).
 *
 * Pantalla NUEVA y no `bot-detail` con «modo administrador». Aquella son 30 kB
 * de TypeScript y 37 de plantilla con cinco pestañas, formulario de
 * configuracion editable, publicacion al ranking, hoja de margen y nueve
 * llamadas acotadas por usuario: darle un modo significaria desviar las nueve y
 * esconder media plantilla tras un `@if`, y el fichero creceria en vez de
 * encoger. Lo que un administrador necesita —de quien es, que es, cuanto hay en
 * riesgo, que fallo y dos botones— cabe aqui.
 *
 * Lo que si se reutiliza es la LOGICA: el respaldo de capital sale de
 * `capitalActual` de `@crypton/shared`, porque la app no suma dinero.
 */
@Component({
  selector: 'app-admin-bot-detail',
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
    UiLiqMeterComponent,
    UiNoticeComponent,
    UiSectionComponent,
    UiStatComponent,
    UiStatusPillComponent,
    AdminForbiddenComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/admin/bots" text="" />
        </ion-buttons>
        <ion-title>Bot</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        @if (forbidden()) {
          <app-admin-forbidden />
        } @else if (noExiste()) {
          <ui-empty-state title="Este bot ya no existe" icon="grid-outline" />
        } @else if (!bot()) {
          <div class="center"><ion-spinner name="crescent" /></div>
        } @else {
          @let b = bot()!;

          <ui-card>
            <div class="l1">
              <span class="nom">{{ b.name }}</span>
              <ui-status-pill [status]="b.status" />
              @if (b.dryRun || b.paper) {
                <ui-badge size="sm" tone="warn">simulación</ui-badge>
              }
              @if (b.testnet) {
                <ui-badge size="sm" tone="warn" variant="outline">testnet</ui-badge>
              }
            </div>
            <p class="l2 mono">
              {{ b.symbol }} · {{ venueLabel(b.venue) }} · {{ strategyLabel(b.strategy) }} ·
              {{ b.direction }} · x{{ b.leverage }}
            </p>
            <a class="dueno" [routerLink]="['/admin/users', b.owner.id]">
              {{ b.owner.name }} · {{ b.owner.email }}
              @if (b.owner.disabled) {
                <ui-badge size="sm" tone="down">deshabilitada</ui-badge>
              }
            </a>
          </ui-card>

          <div class="stats">
            <ui-stat label="Capital" [value]="money(capital(b))" />
            <ui-stat label="Resultado" [value]="signed(b.realizedPnl ?? '0')" />
            <ui-stat label="ROI" [value]="(b.roiPct ?? '0') + '%'" />
            <ui-stat label="Órdenes" [value]="String(b.openOrders ?? 0)" />
            <ui-stat label="Margen" [value]="money(b.marginUsed ?? '0')" />
            <ui-stat label="Arrancó" [value]="b.startedAt ? shortDate(b.startedAt) : '—'" />
          </div>

          @if (b.liquidationDistancePct) {
            <ui-liq-meter [pct]="b.liquidationDistancePct" />
          }
          @if (b.lastError) {
            <ui-notice tone="danger" icon="warning-outline">{{ b.lastError }}</ui-notice>
          }
          @if (b.note) {
            <ui-notice tone="info" icon="information-circle-outline">{{ b.note }}</ui-notice>
          }

          <ui-section title="Contención" />
          <!-- Se dice lo que estas acciones NO hacen: es lo que un administrador
               con prisa da por supuesto al reves. -->
          <ui-notice tone="warn" icon="warning-outline">
            Ninguna de estas acciones cierra la posición ni realiza el resultado, y las dos
            conservan el stop-loss del venue. La posición sigue abierta y su dueño sigue siendo el
            responsable.
          </ui-notice>
          <div class="acciones">
            @for (c of comandos; track c) {
              <ion-button
                expand="block"
                fill="outline"
                color="warning"
                [disabled]="!contenible(b)"
                (click)="mandar(b, c)"
              >
                {{ etiqueta(c) }}
              </ion-button>
            }
          </div>
          @if (!contenible(b)) {
            <p class="fina">El bot no está bajo el control del motor: no hay nada que contener.</p>
          }
        }
      </div>
    </ion-content>
  `,
  styles: [
    `
      .l1 {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .nom {
        font-size: 13px;
        color: var(--text-1);
      }

      .l2 {
        margin: 4px 0;
        font-size: 11px;
        color: var(--text-2);
      }

      .dueno {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11.5px;
        color: var(--brand-2);
        text-decoration: none;
        overflow-wrap: anywhere;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
        gap: var(--space-2);
        margin: var(--space-3) 0;
      }

      .acciones {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        margin: var(--space-3) 0;
      }

      .center {
        display: flex;
        justify-content: center;
        padding: var(--space-6) 0;
      }

      .fina {
        margin: 0 0 var(--space-6);
        font-size: 11px;
        color: var(--text-3);
      }
    `,
  ],
})
export class AdminBotDetailPage implements OnInit {
  private readonly api = inject(AdminBotsService);
  private readonly acciones = inject(AdminActionsService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly bot = signal<AdminBotDetail | null>(null);
  readonly forbidden = signal(false);
  readonly noExiste = signal(false);

  readonly comandos = ADMIN_BOT_COMMANDS;
  readonly venueLabel = venueLabel;
  readonly strategyLabel = strategyLabel;
  readonly shortDate = shortDate;
  readonly money = money;
  readonly signed = signed;
  readonly String = String;

  private id = '';

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    void this.cargar();
  }

  etiqueta(c: AdminBotCommand): string {
    return ETIQUETA_COMANDO[c];
  }

  contenible(b: AdminBotDetail): boolean {
    return CONTENIBLES.includes(b.status);
  }

  /**
   * El capital de ahora, con respaldo.
   *
   * Mismo criterio que la lista de bots del usuario: si el servidor manda el
   * capital calculado se usa; si no, se compone con `capitalActual` de
   * `@crypton/shared`. La app NO suma dinero por su cuenta (invariante 1): esa
   * aritmetica vive en el paquete y tiene test.
   */
  capital(b: AdminBotDetail): string {
    return (
      b.currentCapital ??
      capitalActual(b.totalInvestment, b.realizedPnl ?? '0', b.unrealizedPnl ?? '0')
    );
  }

  mandar(b: AdminBotDetail, c: AdminBotCommand): void {
    void this.acciones.comandoDeBot(b, c, () => this.cargar());
  }

  private async cargar(): Promise<void> {
    try {
      this.bot.set(await this.api.detail(this.id));
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
