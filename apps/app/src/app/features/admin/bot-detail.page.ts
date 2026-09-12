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
import { AuthService } from '../../core/auth';
import {
  ADMIN_BOT_COMMANDS,
  AI_MODES,
  AYUDA_MODO_IA,
  AdminBotsService,
  ETIQUETA_COMANDO,
  ETIQUETA_MODO_IA,
  type AdminBotCommand,
  type AdminBotDetail,
  type AiMode,
  type AiSetting,
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

          <!-- El Modo IA solo aparece en los bots del PROPIO administrador: sobre
               uno ajeno el servidor responde 403, y ofrecer un interruptor que va
               a fallar es peor que no ofrecerlo. -->
          @if (esMio(b)) {
            <ui-section title="Modo IA" />
            <ui-notice tone="info" icon="sparkles-outline">
              Un supervisor revisa este bot cada media hora y cuando cierra un ciclo. Puede mover
              cinco ajustes como mucho dos posiciones cada uno. <b>Nunca</b> toca el capital, el
              par, la cuenta ni la dirección, y no puede parar el bot, cerrar su posición ni
              cancelar sus órdenes.
            </ui-notice>

            @if (ia(); as s) {
              <div class="modos">
                @for (m of modos; track m) {
                  <button
                    type="button"
                    class="modo"
                    [class.sel]="s.mode === m"
                    [disabled]="guardando()"
                    (click)="cambiarModo(m)"
                  >
                    <span class="modo-t">{{ etiquetaModo(m) }}</span>
                    <span class="modo-a">{{ ayudaModo(m) }}</span>
                  </button>
                }
              </div>

              @if (s.paused_until) {
                <ui-notice tone="warn" icon="warning-outline">
                  El supervisor se ha dormido tras varios fallos seguidos. Se reactiva solo el
                  {{ shortDate(s.paused_until) }}.
                </ui-notice>
              }
              @if (s.last_review_at) {
                <p class="fina">Última revisión: {{ shortDate(s.last_review_at) }}.</p>
              }
            } @else {
              <div class="center"><ion-spinner name="crescent" /></div>
            }
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

      .modos {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        margin: var(--space-3) 0;
      }

      .modo {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-3);
        text-align: left;
        border: 1px solid var(--line-1);
        border-radius: var(--radius-2);
        background: transparent;
        cursor: pointer;
      }

      .modo:disabled {
        opacity: 0.6;
        cursor: default;
      }

      .modo.sel {
        border-color: var(--brand-2);
        background: color-mix(in srgb, var(--brand-2) 8%, transparent);
      }

      .modo-t {
        font-size: 12.5px;
        color: var(--text-1);
      }

      .modo-a {
        font-size: 11px;
        color: var(--text-2);
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

  private readonly auth = inject(AuthService);

  readonly bot = signal<AdminBotDetail | null>(null);
  readonly forbidden = signal(false);
  readonly noExiste = signal(false);

  readonly ia = signal<AiSetting | null>(null);
  readonly guardando = signal(false);

  readonly comandos = ADMIN_BOT_COMMANDS;
  readonly modos = AI_MODES;
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

  etiquetaModo(m: AiMode): string {
    return ETIQUETA_MODO_IA[m];
  }

  ayudaModo(m: AiMode): string {
    return AYUDA_MODO_IA[m];
  }

  /**
   * ¿Es un bot del propio administrador?
   *
   * El Modo IA solo se enciende sobre bots propios —lo impone el servidor, no
   * esta pantalla— asi que sobre uno ajeno el panel ni aparece: ofrecer un
   * interruptor que va a responder 403 es peor que no ofrecerlo.
   */
  esMio(b: AdminBotDetail): boolean {
    return b.owner.id === this.auth.user()?.id;
  }

  /**
   * Cambia el modo, pidiendo el motivo.
   *
   * El motivo es obligatorio en el servidor, igual que en la contencion y por lo
   * mismo: encender un agente que reescribe la configuracion de un bot con
   * dinero dentro tiene que quedar explicado en la bitacora, y que el bot sea
   * propio no lo hace menos revisable — lo hace mas facil de olvidar.
   */
  async cambiarModo(mode: AiMode): Promise<void> {
    const actual = this.ia();
    const b = this.bot();
    if (!actual || !b || actual.mode === mode || this.guardando()) return;

    this.guardando.set(true);
    try {
      await this.acciones.modoIa(b, mode, (s) => this.ia.set(s));
    } finally {
      this.guardando.set(false);
    }
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
      const b = await this.api.detail(this.id);
      this.bot.set(b);
      this.forbidden.set(false);
      this.noExiste.set(false);

      // El Modo IA solo se pide si el bot es propio: sobre uno ajeno el servidor
      // responde 403, y un 403 esperado no es un error que enseñar.
      if (this.esMio(b)) {
        const sinModo: AiSetting = { bot_id: this.id, mode: 'OFF' };
        this.ia.set(await this.api.aiMode(this.id).catch(() => sinModo));
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) this.forbidden.set(true);
      else if (status === 404) this.noExiste.set(true);
      else await this.toast.error(errorText(e));
    }
  }
}
