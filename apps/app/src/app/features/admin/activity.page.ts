import { ActivatedRoute } from '@angular/router';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import {
  fallosDe,
  resumenPorAccion,
  type ActorKind,
  type EventSeverity,
  type FilaResumenAccion,
} from '@crypton/shared';
import { ActivityService, ToastService, type ActivityEntry } from '../../core/services';
import { ago, errorText } from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiMeterComponent,
  type BadgeTone,
} from '../../shared/ui';

/** Las ventanas del resumen. Las que de verdad se miran. */
const VENTANAS = [
  { horas: 24, label: '24 h' },
  { horas: 72, label: '72 h' },
  { horas: 168, label: '7 d' },
] as const;

/** Filas por página. El tope del servidor es 101. */
const PAGINA = 50;

const ACTORES: { value: ActorKind | ''; label: string }[] = [
  { value: '', label: 'Todos los actores' },
  { value: 'USER', label: 'Usuarios' },
  { value: 'ADMIN', label: 'Administradores' },
  { value: 'WORKER', label: 'Worker' },
  { value: 'SYSTEM', label: 'Sistema' },
  { value: 'ANON', label: 'Sin sesión' },
];

const SEVERIDADES: { value: EventSeverity | ''; label: string }[] = [
  { value: '', label: 'Cualquier gravedad' },
  { value: 'WARN', label: 'Aviso' },
  { value: 'ERROR', label: 'Error' },
  { value: 'CRITICAL', label: 'Crítico' },
];

/**
 * El panel operativo (spec 007): qué ha pasado en la plataforma y qué ha
 * fallado, sobre `activity_log`.
 *
 * Solo lee. La tabla la escribe `AuditService` en la API y en el worker, y los
 * dos endpoints que se consumen ya existían con sus filtros y su paginación. Lo
 * que la pantalla decide es cómo se lee: el resumen por acción como barra
 * apilada, «solo fallos» a un toque, y la `ip` fuera de la lista —es un dato
 * personal— hasta que se despliega una fila.
 */
import { AdminForbiddenComponent } from './admin-forbidden.component';

@Component({
  selector: 'app-admin-activity',
  standalone: true,
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonButton,
    IonContent,
    IonSelect,
    IonSelectOption,
    IonSpinner,
    UiBadgeComponent,
    UiCardComponent,
    UiMeterComponent,
    AdminForbiddenComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/admin" text="" />
        </ion-buttons>
        <ion-title>Actividad</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        @if (forbidden()) {
          <app-admin-forbidden />
        } @else {
          <!-- ── Resumen ── -->
          <div class="bd-range">
            @for (v of ventanas; track v.horas) {
              <button type="button" [class.on]="hours() === v.horas" (click)="setHours(v.horas)">
                {{ v.label }}
              </button>
            }
          </div>

          @let acciones = porAccion();
          @if (acciones.length) {
            <p class="lead">
              <b class="num">{{ totalResumen() }}</b> acciones en las últimas
              {{ etiquetaVentana() }} ·
              <b class="num" [class.c-danger]="fallos() > 0">{{ fallos() }}</b> fallidas o denegadas
            </p>
            <ui-card flush class="acc">
              @for (r of acciones; track r.action) {
                <div class="row">
                  <span class="name mono">{{ r.action }}</span>
                  <!-- Verde lo que salió bien, ámbar lo denegado, rojo lo que
                       falló: la misma barra que reparte maker y taker en el bot. -->
                  <ui-meter
                    [segments]="[
                      { value: r.ok, tone: 'up' },
                      { value: r.denied, tone: 'warn' },
                      { value: r.error, tone: 'down' },
                    ]"
                    [total]="r.total"
                    [warnAt]="2"
                    [dangerAt]="2"
                    [label]="
                      r.action +
                      ': ' +
                      r.ok +
                      ' bien, ' +
                      r.denied +
                      ' denegadas, ' +
                      r.error +
                      ' con error'
                    "
                  />
                  <span class="n num">
                    {{ r.ok }}<i class="d">·</i><i class="w">{{ r.denied }}</i
                    ><i class="d">·</i><i class="e">{{ r.error }}</i>
                  </span>
                </div>
              }
            </ui-card>
          } @else if (!loading()) {
            <p class="empty">
              Nada en las últimas {{ etiquetaVentana() }}. Si esperabas registros, comprueba que
              <span class="mono">AUDIT_LOG_ENABLE</span> esté encendido en la API: apagado, la tabla
              no se escribe.
            </p>
          }

          <!-- ── Filtros ── -->
          <div class="filters">
            @if (actorId()) {
              <button type="button" class="chip on" (click)="quitarActor()">
                usuario filtrado ✕
              </button>
            }
            <button
              type="button"
              class="chip"
              [class.on]="onlyFailures()"
              (click)="toggleFallos()"
              [attr.aria-pressed]="onlyFailures()"
            >
              Solo fallos
            </button>
            <ion-select
              interface="action-sheet"
              class="sel"
              [value]="actor()"
              (ionChange)="setActor($any($event).detail.value)"
              aria-label="Actor"
            >
              @for (a of actores; track a.value) {
                <ion-select-option [value]="a.value">{{ a.label }}</ion-select-option>
              }
            </ion-select>
            <ion-select
              interface="action-sheet"
              class="sel"
              [value]="severity()"
              (ionChange)="setSeverity($any($event).detail.value)"
              aria-label="Gravedad"
            >
              @for (s of severidades; track s.value) {
                <ion-select-option [value]="s.value">{{ s.label }}</ion-select-option>
              }
            </ion-select>
            <input
              class="q mono"
              type="text"
              placeholder="acción, p. ej. bot."
              [value]="action()"
              (change)="setAction($any($event.target).value)"
            />
          </div>

          <!-- ── Registros ── -->
          @if (entries().length) {
            <ui-card flush class="log">
              @for (e of entries(); track e.id) {
                <div class="it" [class.open]="abierta() === e.id" (click)="toggle(e.id)">
                  <div class="l1">
                    <ui-badge size="sm" square [tone]="tonoSeveridad(e.severity)">
                      {{ e.severity }}
                    </ui-badge>
                    <span class="action mono">{{ e.action }}</span>
                    <ui-badge size="sm" [tone]="tonoResultado(e.outcome)">{{ e.outcome }}</ui-badge>
                    <span class="when">{{ cuando(e.createdAt) }}</span>
                  </div>
                  <div class="l2">
                    <span>{{ e.actor }}{{ e.actorId ? ' · ' + corto(e.actorId) : '' }}</span>
                    @if (e.botId) {
                      <span>bot {{ corto(e.botId) }}</span>
                    }
                    @if (e.route) {
                      <span class="mono">
                        {{ e.method }} {{ e.route
                        }}{{ e.statusCode !== null ? ' · ' + e.statusCode : ''
                        }}{{ e.durationMs !== null ? ' · ' + e.durationMs + ' ms' : '' }}
                      </span>
                    }
                  </div>
                  @if (abierta() === e.id) {
                    <div class="more">
                      @if (e.message) {
                        <p>{{ e.message }}</p>
                      }
                      @if (e.meta) {
                        <pre class="mono">{{ json(e.meta) }}</pre>
                      }
                      <span class="fine mono">
                        @if (e.ip) {
                          ip {{ e.ip }} ·
                        }
                        @if (e.requestId) {
                          req {{ e.requestId }} ·
                        }
                        id {{ e.id }}
                      </span>
                    </div>
                  }
                </div>
              }
            </ui-card>
            @if (hasMore()) {
              <ion-button expand="block" fill="outline" [disabled]="loading()" (click)="mas()">
                @if (loading()) {
                  <ion-spinner name="crescent" />
                } @else {
                  Cargar más
                }
              </ion-button>
            }
          } @else if (loading()) {
            <div class="center"><ion-spinner name="crescent" /></div>
          } @else {
            <p class="empty">Ningún registro con estos filtros.</p>
          }
        }
      </div>
    </ion-content>
  `,
  styles: [
    `
      .pad {
        padding: var(--space-4);
      }

      .lead {
        margin: var(--space-3) 0 var(--space-2);
        font-size: 12.5px;
        color: var(--text-2);

        b {
          color: var(--text-1);
        }
      }

      .acc .row {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto;
        align-items: center;
        gap: var(--space-3);
        padding: 9px var(--space-4);
        border-bottom: 1px solid var(--border-subtle);

        &:last-child {
          border-bottom: 0;
        }
      }

      .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11.5px;
        color: var(--text-1);
      }

      .n {
        font-size: 11px;
        color: var(--text-2);

        .d {
          margin: 0 3px;
          color: var(--text-3);
        }

        .w {
          color: var(--signal-warn);
        }

        .e {
          color: var(--pnl-down);
        }
      }

      .filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        margin: var(--space-4) 0 var(--space-3);
      }

      .chip,
      .sel,
      .q {
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

      .q {
        flex-grow: 1;
        min-width: 140px;
      }

      .log .it {
        padding: 9px var(--space-4);
        border-bottom: 1px solid var(--border-subtle);

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

      .l1 .action {
        font-size: 12px;
        color: var(--text-1);
      }

      .l1 .when {
        margin-inline-start: auto;
        font-size: 11px;
        color: var(--text-3);
      }

      .l2 {
        margin-top: 3px;
        font-size: 11px;
        color: var(--text-3);
      }

      .more {
        margin-top: 6px;
        font-size: 12px;
        color: var(--text-2);

        p {
          margin: 0 0 6px;
        }

        pre {
          margin: 0 0 6px;
          padding: 8px;
          border-radius: var(--radius-xs);
          background: var(--surface-2);
          font-size: 10.5px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
      }

      .fine {
        font-size: 10px;
        color: var(--text-3);
      }

      .empty {
        margin: var(--space-4) 0;
        font-size: 12.5px;
        color: var(--text-3);
      }

      .center {
        display: flex;
        justify-content: center;
        padding: var(--space-5);
      }
    `,
  ],
})
export class AdminActivityPage implements OnInit {
  private readonly activity = inject(ActivityService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly ventanas = VENTANAS;
  readonly actores = ACTORES;
  readonly severidades = SEVERIDADES;

  readonly hours = signal<number>(24);
  readonly resumen = signal<FilaResumenAccion[]>([]);
  readonly entries = signal<ActivityEntry[]>([]);
  readonly page = signal(1);
  readonly hasMore = signal(false);
  readonly loading = signal(false);
  readonly forbidden = signal(false);
  /** La fila desplegada, con su `meta` y su `ip`. Una a la vez. */
  readonly abierta = signal<string | null>(null);

  /**
   * Llega por la URL desde la ficha de un usuario («Ver su actividad»).
   *
   * No tiene control propio: es un filtro contextual, no una opcion del menu.
   * Se pinta como un chip que se quita tocandolo.
   */
  readonly actorId = signal<string>('');

  readonly onlyFailures = signal(false);
  readonly actor = signal<ActorKind | ''>('');
  readonly severity = signal<EventSeverity | ''>('');
  readonly action = signal('');

  /** La aritmética del resumen es de `shared`, con sus tests. */
  readonly porAccion = computed(() => resumenPorAccion(this.resumen()));
  readonly fallos = computed(() => fallosDe(this.porAccion()));
  readonly totalResumen = computed(() => this.porAccion().reduce((n, r) => n + r.total, 0));
  readonly etiquetaVentana = computed(
    () => VENTANAS.find((v) => v.horas === this.hours())?.label ?? `${this.hours()} h`,
  );

  ngOnInit(): void {
    this.actorId.set(this.route.snapshot.queryParamMap.get('actorId') ?? '');
    void this.cargar();
  }

  quitarActor(): void {
    this.actorId.set('');
    void this.cargarLista();
  }

  setHours(h: number): void {
    if (h === this.hours()) return;
    this.hours.set(h);
    void this.cargarResumen();
  }

  toggleFallos(): void {
    this.onlyFailures.update((v) => !v);
    void this.cargarLista();
  }

  setActor(v: ActorKind | ''): void {
    this.actor.set(v);
    void this.cargarLista();
  }

  setSeverity(v: EventSeverity | ''): void {
    this.severity.set(v);
    void this.cargarLista();
  }

  setAction(v: string): void {
    this.action.set(v.trim());
    void this.cargarLista();
  }

  toggle(id: string): void {
    this.abierta.update((a) => (a === id ? null : id));
  }

  async mas(): Promise<void> {
    if (this.loading() || !this.hasMore()) return;
    await this.cargarLista(this.page() + 1);
  }

  tonoSeveridad(s: EventSeverity): BadgeTone {
    if (s === 'CRITICAL' || s === 'ERROR') return 'down';
    if (s === 'WARN') return 'warn';
    return 'neutral';
  }

  tonoResultado(o: ActivityEntry['outcome']): BadgeTone {
    return o === 'OK' ? 'up' : o === 'DENIED' ? 'warn' : 'down';
  }

  cuando(iso: string): string {
    return ago(Date.parse(iso));
  }

  /** Los primeros ocho caracteres de un UUID: bastan para seguir el hilo. */
  corto(id: string): string {
    return id.length > 8 ? `${id.slice(0, 8)}…` : id;
  }

  json(v: unknown): string {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  private async cargar(): Promise<void> {
    await Promise.all([this.cargarResumen(), this.cargarLista()]);
  }

  private async cargarResumen(): Promise<void> {
    try {
      this.resumen.set(await this.activity.summary(this.hours()));
    } catch (e) {
      await this.fallo(e);
    }
  }

  /** Página 1 sustituye; las siguientes se añaden. Cambiar un filtro vuelve a la 1. */
  private async cargarLista(page = 1): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.activity.list(
        {
          actorId: this.actorId() || undefined,
          onlyFailures: this.onlyFailures(),
          actor: this.actor() || undefined,
          severity: this.severity() || undefined,
          action: this.action() || undefined,
        },
        page,
        PAGINA,
      );
      this.entries.set(page === 1 ? res.data : [...this.entries(), ...res.data]);
      this.page.set(res.meta.page);
      this.hasMore.set(res.meta.hasNextPage);
    } catch (e) {
      await this.fallo(e);
    } finally {
      this.loading.set(false);
    }
  }

  private async fallo(e: unknown): Promise<void> {
    if ((e as { status?: number }).status === 403) {
      this.forbidden.set(true);
      return;
    }
    await this.toast.error(errorText(e));
  }
}
