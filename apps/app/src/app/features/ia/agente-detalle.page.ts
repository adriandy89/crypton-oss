import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import {
  EstadoRondaAgente,
  PAUSA_FALLOS_AGENTE_MS,
  TOPE_FALLOS_AGENTE,
  type AgenteVista,
  type DetalleAgente,
  type LimitesAgente,
  type ListaOperaciones,
  type ListaPropuestas,
  type RondaVista,
} from '@crypton/shared';
import { NOMBRES_LIMITES_AGENTE } from '@crypton/strategy-core';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText, money, shortDate, venueLabel } from '../../core/utils';
import {
  AUTONOMIA,
  DESCARTE,
  FAMILIA,
  INSIGNIA_AGENTE,
  MOTIVO_PAUSA,
  ladoTexto,
  porcentaje,
  reloj,
  textoDe,
  textoEleccionAgente,
  textoFalloModelo,
  textoRonda,
} from '../../core/utils/agentes-ia';
import { AgentesAccionesService } from '../../shared/ia/agentes-acciones.service';
import { UiBadgeComponent, UiCardComponent, UiNoticeComponent } from '../../shared/ui';
import { AdminForbiddenComponent } from '../admin/admin-forbidden.component';
import { OperacionFilaComponent } from './operacion-fila.component';
import { PropuestaFilaComponent } from './propuesta-fila.component';

/** El orden en que se enseñan los límites: el de su editor. */
const ORDEN_LIMITES: readonly (keyof LimitesAgente)[] = [
  'capital',
  'riesgoPct',
  'perdidaDiariaPct',
  'maxVivas',
  'maxOperacionesDia',
  'apalancamientoMax',
  'margenPct',
  'maxStopPct',
  'maxCosteR',
  'minObjetivoCoste',
  'minObjetivoPct',
  'minRR',
  'fraccionTp1Pct',
  'breakevenTrasTp1',
  'maxVelasOperacion',
  'esperaStopMin',
  'maxPerdidasSeguidas',
  'esperaRachaMin',
  'consultasDia',
  'gastoDiaUsd',
];

/**
 * Un agente con su día (spec 074): su estado, lo que mira, cuánto lleva
 * gastado y perdido frente a sus topes, lo que tiene abierto y esperando, y
 * sus últimos análisis, que responden a «¿por qué no propone nada?».
 */
@Component({
  selector: 'app-agente-detalle',
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
    UiNoticeComponent,
    AdminForbiddenComponent,
    OperacionFilaComponent,
    PropuestaFilaComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/tabs/ia" text="" />
        </ion-buttons>
        <ion-title>{{ detalle()?.agente?.nombre ?? 'Agente' }}</ion-title>
        @if (detalle()?.agente; as a) {
          @if (a.estado !== 'ARCHIVADO') {
            <ion-buttons slot="end">
              <ion-button [routerLink]="['/ia/agentes', a.id, 'editar']">Editar</ion-button>
            </ion-buttons>
          }
        }
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        @if (prohibido()) {
          <app-admin-forbidden />
        } @else if (error(); as e) {
          <ui-notice tone="danger">{{ e }}</ui-notice>
        } @else if (detalle(); as d) {
          @let a = d.agente;
          <div class="chips">
            <ui-badge [tone]="insignia().tono">{{ insignia().texto }}</ui-badge>
            @if (a.cuenta.real) {
              <ui-badge tone="down" variant="outline">dinero real</ui-badge>
            } @else if (a.cuenta.simulacion) {
              <ui-badge tone="warn">simulación</ui-badge>
            } @else {
              <ui-badge tone="warn" variant="outline">testnet</ui-badge>
            }
          </div>
          @if (insignia().porQue) {
            <p class="ia-nota">
              {{ insignia().porQue
              }}{{ a.motivoPausa ? ': ' + textoDe(MOTIVO_PAUSA, a.motivoPausa) : '' }}.
            </p>
          }

          <div class="bts">
            @if (a.estado === 'ACTIVO') {
              <ion-button size="small" fill="outline" [disabled]="ocupado()" (click)="pausar(a)">
                Pausar
              </ion-button>
              <ion-button size="small" fill="outline" [disabled]="ocupado()" (click)="analizar(a)">
                Analizar ahora
              </ion-button>
            } @else if (a.estado === 'PAUSADO') {
              <ion-button size="small" [disabled]="ocupado()" (click)="reanudar(a)">
                Reanudar
              </ion-button>
            }
            @if (a.estado !== 'ARCHIVADO') {
              <ion-button
                size="small"
                fill="clear"
                color="danger"
                [disabled]="ocupado() || a.vivas > 0"
                (click)="archivar(a)"
              >
                Archivar
              </ion-button>
            }
          </div>

          <h3 class="ia-sec">Qué hace</h3>
          <ui-card>
            <dl class="ia-kv">
              <dt>Cuenta</dt>
              <dd>{{ a.cuenta.nombre }} · {{ venueLabel(a.cuenta.venue) }}</dd>
              <dt>Pares</dt>
              <dd>{{ a.pares.join(', ') }}</dd>
              <dt>Velas</dt>
              <dd>{{ a.intervalo }}</dd>
              <dt>Busca</dt>
              <dd>{{ familias(a) }} · {{ lados(a) }}</dd>
              <dt>Decide</dt>
              <dd>{{ a.modo === 'REGLAS' ? 'el juez de reglas, sin coste' : 'la IA' }}</dd>
              <dt>Entrar</dt>
              <dd>{{ autonomia('entrar', a.autonomia.entrar) }}</dd>
              <dt>Reducir el riesgo</dt>
              <dd>{{ autonomia('reducir', a.autonomia.reducir) }}</dd>
              <dt>Cerrar</dt>
              <dd>{{ autonomia('cerrar', a.autonomia.cerrar) }}</dd>
              @if (a.proximaRonda && a.estado === 'ACTIVO') {
                <dt>Próximo análisis</dt>
                <dd>{{ shortDate(a.proximaRonda) }}</dd>
              }
              @if (a.dormidoHasta) {
                <dt>Dormido hasta</dt>
                <dd>{{ shortDate(a.dormidoHasta) }}</dd>
              }
              @if (a.fallos > 0) {
                <dt>Fallos seguidos</dt>
                <dd>
                  {{ a.fallos }} de {{ TOPE_FALLOS_AGENTE
                  }}{{ a.ultimoError ? ' · ' + textoFalloModelo(a.ultimoError) : '' }}
                  <br />
                  <span class="vio"
                    >Al {{ TOPE_FALLOS_AGENTE }}.º seguido deja de consultar
                    {{ horasPausaFallos }} h.</span
                  >
                </dd>
              }
            </dl>
          </ui-card>

          <h3 class="ia-sec">Hoy</h3>
          <ui-card>
            <dl class="ia-kv">
              <dt>Pérdida del día</dt>
              <dd class="num">
                {{ porcentaje(d.uso.perdidaHoyPct) }} de {{ porcentaje(d.uso.topeDiarioPct) }} ·
                peor día {{ money(d.peorDia) }}
              </dd>
              <dt>Al stop, lo abierto</dt>
              <dd class="num">{{ porcentaje(d.uso.riesgoAbiertoPct) }}</dd>
              <dt>Operaciones</dt>
              <dd class="num">{{ d.uso.operacionesHoy }} de {{ d.uso.topeOperaciones }}</dd>
              <dt>A la vez</dt>
              <dd class="num">{{ d.uso.vivas }} de {{ d.uso.topeVivas }}</dd>
              @if (d.uso.rachaPerdidas > 0) {
                <dt>Pérdidas seguidas</dt>
                <dd class="num">{{ d.uso.rachaPerdidas }}</dd>
              }
              <dt>Consultas al modelo</dt>
              <dd class="num">
                {{ a.consultasHoy }} · {{ money(a.costeHoy, 3) }} $
                @if (a.consultasSinCoste > 0) {
                  · {{ a.consultasSinCoste }} sin coste conocido
                }
              </dd>
            </dl>
          </ui-card>

          @if (operaciones(); as o) {
            @if (o.vivas.length) {
              <h3 class="ia-sec">Operaciones vivas</h3>
              <ui-card flush>
                @for (p of o.vivas; track p.id) {
                  <app-operacion-fila [propuesta]="p" [ahora]="ahora()" (cambiado)="cargar()" />
                }
              </ui-card>
            }
          }
          @if (propuestas(); as l) {
            @if (l.pendientes.length) {
              <h3 class="ia-sec">Esperando</h3>
              <ui-card flush>
                @for (p of l.pendientes; track p.id) {
                  <app-propuesta-fila [propuesta]="p" [ahora]="ahora()" (cambiado)="cargar()" />
                }
              </ui-card>
            }
          }

          <h3 class="ia-sec">Últimos análisis</h3>
          @if (d.rondas.length) {
            @for (r of d.rondas; track r.id) {
              <p class="rev">
                <span class="num">{{ shortDate(r.creadaEn) }}</span> ·
                <b>{{ textoRonda(r) }}</b>
                @if (r.eleccion) {
                  · {{ textoEleccionAgente(r.eleccion) }}
                }
                @if (r.respuesta?.texto; as t) {
                  · «{{ t }}»
                }
                @if (vistos(r); as v) {
                  <br />
                  <span class="vio">{{ v }}</span>
                }
              </p>
            }
          } @else {
            <p class="ia-nota">Aún no ha analizado nada.</p>
          }

          <h3 class="ia-sec">Límites</h3>
          <ui-card>
            <dl class="ia-kv">
              @for (k of ORDEN_LIMITES; track k) {
                <dt>{{ NOMBRES_LIMITES_AGENTE[k] }}</dt>
                <dd class="num">{{ valorLimite(a.limites, k) }}</dd>
              }
            </dl>
          </ui-card>
        } @else {
          <div class="center"><ion-spinner name="crescent" /></div>
        }
      </div>
    </ion-content>
  `,
  styles: [
    `
      .chips,
      .bts {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-bottom: var(--space-2);
      }

      .rev {
        margin: 0 0 var(--space-2);
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-2);
      }

      .vio {
        font-size: 11px;
        color: var(--text-3);
      }
    `,
  ],
})
export class AgenteDetallePage implements OnInit {
  private readonly servicio = inject(AgentesIaService);
  private readonly acciones = inject(AgentesAccionesService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly detalle = signal<DetalleAgente | null>(null);
  readonly propuestas = signal<ListaPropuestas | null>(null);
  readonly operaciones = signal<ListaOperaciones | null>(null);
  readonly error = signal<string | null>(null);
  readonly prohibido = signal(false);
  readonly ocupado = signal(false);
  readonly ahora = reloj();

  readonly textoDe = textoDe;
  readonly textoRonda = textoRonda;
  readonly textoFalloModelo = textoFalloModelo;
  readonly TOPE_FALLOS_AGENTE = TOPE_FALLOS_AGENTE;
  readonly horasPausaFallos = PAUSA_FALLOS_AGENTE_MS / 3_600_000;
  readonly venueLabel = venueLabel;
  readonly shortDate = shortDate;
  readonly money = money;
  readonly porcentaje = porcentaje;
  readonly textoEleccionAgente = textoEleccionAgente;
  readonly MOTIVO_PAUSA = MOTIVO_PAUSA;
  readonly NOMBRES_LIMITES_AGENTE = NOMBRES_LIMITES_AGENTE;
  readonly ORDEN_LIMITES = ORDEN_LIMITES;

  private readonly id = this.route.snapshot.paramMap.get('id') ?? '';
  private turno = 0;
  /** Para dejar de esperar una ronda al salir de la pantalla. */
  private abierta = true;

  readonly insignia = computed(() => {
    const a = this.detalle()?.agente;
    return a ? INSIGNIA_AGENTE[a.insignia] : INSIGNIA_AGENTE.ACTIVO;
  });

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => (this.abierta = false));
    void this.cargar();
    this.servicio.cambios
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.cargar());
  }

  async cargar(): Promise<void> {
    const t = ++this.turno;
    try {
      const [d, p, o] = await Promise.all([
        this.servicio.detalle(this.id),
        this.servicio.propuestas(this.id),
        this.servicio.operaciones(this.id),
      ]);
      if (t !== this.turno) return;
      this.detalle.set(d);
      this.propuestas.set(p);
      this.operaciones.set(o);
      this.error.set(null);
    } catch (e) {
      if (t !== this.turno) return;
      if ((e as { status?: number }).status === 403) this.prohibido.set(true);
      else this.error.set(errorText(e));
    }
  }

  familias(a: AgenteVista): string {
    return a.familias.map((f) => textoDe(FAMILIA, f)).join(', ');
  }

  lados(a: AgenteVista): string {
    return a.lados.length === 2 ? 'largos y cortos' : `solo ${ladoTexto(a.lados[0])}s`;
  }

  autonomia(clase: 'entrar' | 'reducir' | 'cerrar', modo: string): string {
    return AUTONOMIA[clase].find((o) => o.valor === modo)?.texto ?? modo;
  }

  /** Lo que vio una ronda, en una línea: cada par con lo que ofreció o por qué no. */
  vistos(r: RondaVista): string {
    return r.pares
      .map((p) => {
        if (p.descartes.length) {
          return `${p.simbolo}: ${p.descartes.map((d) => textoDe(DESCARTE, d)).join(', ')}`;
        }
        const n = p.candidatos.filter((c) => c.elegible).length;
        return `${p.simbolo}: ${n ? `${n} posible${n === 1 ? '' : 's'}` : 'nada'}`;
      })
      .join(' · ');
  }

  valorLimite(l: LimitesAgente, k: keyof LimitesAgente): string {
    const v = l[k];
    if (typeof v === 'boolean') return v ? 'sí' : 'no';
    if (k === 'capital') return money(v);
    return String(v);
  }

  async pausar(a: AgenteVista): Promise<void> {
    await this.hacer(() => this.acciones.pausar(a));
  }

  async reanudar(a: AgenteVista): Promise<void> {
    await this.hacer(() => this.acciones.reanudar(a));
  }

  async archivar(a: AgenteVista): Promise<void> {
    await this.hacer(() => this.acciones.archivar(a));
  }

  async analizar(a: AgenteVista): Promise<void> {
    const r = await this.hacer(() => this.acciones.analizar(a));
    // El servidor responde en cuanto la ronda existe, y el modelo puede tardar
    // hasta su plazo: se recarga hasta verla terminada (spec 078).
    if (r?.estado === EstadoRondaAgente.EN_CURSO) {
      await this.acciones.esperarRonda(
        r.id,
        'Análisis',
        async () => {
          await this.cargar();
          return this.detalle()?.rondas;
        },
        () => this.abierta,
      );
    }
  }

  private async hacer<T>(f: () => Promise<T>): Promise<T | null> {
    if (this.ocupado()) return null;
    this.ocupado.set(true);
    try {
      const r = await f();
      await this.cargar();
      return r;
    } finally {
      this.ocupado.set(false);
    }
  }
}
