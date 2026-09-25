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
import type { DetallePropuesta, PropuestaVista } from '@crypton/shared';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText, price, qty, shortDate, signed } from '../../core/utils';
import {
  ACCION,
  DESCARTE,
  DISPARADOR,
  ESTADO_PROPUESTA,
  FAMILIA,
  MOTIVO_MODELO,
  MOTIVO_PROPUESTA,
  MOTIVO_RONDA,
  RESULTADO_HIPOTETICO,
  RIESGO_MODELO,
  SALIDA,
  TESIS,
  ladoTexto,
  quedaTexto,
  reloj,
  rTexto,
  textoDe,
  tonoPropuesta,
  textoEleccionAgente,
  tonoR,
} from '../../core/utils/agentes-ia';
import { AccionItemComponent } from '../../shared/ia/accion-item.component';
import { AgentesAccionesService } from '../../shared/ia/agentes-acciones.service';
import { PlanResumenComponent } from '../../shared/ia/plan-resumen.component';
import { UiBadgeComponent, UiCardComponent, UiNoticeComponent } from '../../shared/ui';
import { AdminForbiddenComponent } from '../admin/admin-forbidden.component';

/**
 * Una propuesta de un agente y, si se aprobó, su operación (spec 074): el plan
 * con sus números, por qué la eligió quien decidía, lo que vio, su
 * seguimiento y qué habría pasado con ella se tomara o no.
 *
 * Ejecutar desde aquí es la misma rutina que el botón de Telegram; en una
 * cuenta real, con una confirmación. Sobre una operación viva se puede pedir
 * una revisión o cerrarla a mercado.
 */
@Component({
  selector: 'app-propuesta-detalle',
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
    AccionItemComponent,
    PlanResumenComponent,
    AdminForbiddenComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/tabs/ia" text="" />
        </ion-buttons>
        <ion-title>{{ titulo() }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        @if (prohibido()) {
          <app-admin-forbidden />
        } @else if (error(); as e) {
          <ui-notice tone="danger">{{ e }}</ui-notice>
        } @else if (detalle(); as d) {
          @let p = d.propuesta;
          <div class="chips">
            <ui-badge [tone]="tonoPropuesta(p.estado)">
              {{ textoDe(ESTADO_PROPUESTA, p.estado) }}
            </ui-badge>
            <ui-badge variant="outline">{{ textoDe(FAMILIA, p.familia) }}</ui-badge>
            @if (p.real) {
              <ui-badge tone="down" variant="outline">dinero real</ui-badge>
            } @else {
              <ui-badge tone="warn">simulado</ui-badge>
            }
            @if (p.efecto === 'APLICA') {
              <ui-badge variant="outline">automática</ui-badge>
            }
          </div>
          <p class="ia-nota">
            De <a [routerLink]="['/ia/agentes', p.agenteId]">{{ p.agente }}</a> ·
            {{ shortDate(p.creadaEn) }}
            @if (p.motivo) {
              · {{ textoDe(MOTIVO_PROPUESTA, p.motivo) }}
            }
            @if (p.decididaPor) {
              · decidida
              {{ p.decididaPor === 'AUTO' ? 'sola' : 'desde ' + p.decididaPor.toLowerCase() }}
            }
          </p>

          @if (pendiente()) {
            <div class="bts">
              <ion-button [disabled]="ocupado()" (click)="aprobar(p)">Ejecutar</ion-button>
              <ion-button fill="outline" [disabled]="ocupado()" (click)="rechazar(p)">
                Descartar
              </ion-button>
              <span class="queda">{{ quedaTexto(p.caducaEn, ahora()) }}</span>
            </div>
          }

          <h3 class="ia-sec">El plan</h3>
          <ui-card>
            <app-plan-resumen [plan]="p.plan" [final]="p.planFinal" />
            @if (p.planFinal) {
              <p class="nota">
                Con flecha, lo que cambió al recalcularla con el precio de al aprobar.
              </p>
            }
          </ui-card>

          <h3 class="ia-sec">Por qué</h3>
          <ui-card>
            <p class="linea">{{ textoEleccionAgente(p.eleccion) }}</p>
            @if (p.respuesta; as r) {
              @if (r.texto) {
                <p class="cita">«{{ r.texto }}»</p>
              }
              @if (r.motivos.length) {
                <p class="linea">A favor: {{ lista(MOTIVO_MODELO, r.motivos) }}.</p>
              }
              @if (r.riesgos.length) {
                <p class="linea">Le preocupa: {{ lista(RIESGO_MODELO, r.riesgos) }}.</p>
              }
            } @else {
              <p class="linea">La eligió el juez de reglas, sin modelo.</p>
            }
          </ui-card>

          @if (p.operacion; as op) {
            <h3 class="ia-sec">La operación</h3>
            <ui-card>
              <dl class="ia-kv">
                <dt>Ahora</dt>
                <dd>
                  <ui-badge size="sm" [tone]="tonoR(op.r)">{{ rTexto(op.r) }}</ui-badge>
                  @if (op.resultado !== null) {
                    <span class="num"> {{ signed(op.resultado) }}</span>
                  }
                </dd>
                @if (op.salida) {
                  <dt>Salió por</dt>
                  <dd>{{ textoDe(SALIDA, op.salida) }}</dd>
                }
                @if (op.entrada) {
                  <dt>Entrada media</dt>
                  <dd class="num">{{ price(op.entrada) }}</dd>
                }
                @if (op.marca) {
                  <dt>Precio</dt>
                  <dd class="num">{{ price(op.marca) }}</dd>
                }
                @if (op.stop) {
                  <dt>Stop en el exchange</dt>
                  <dd class="num">{{ price(op.stop) }}</dd>
                }
                @if (op.posicion) {
                  <dt>Posición</dt>
                  <dd class="num">{{ qty(op.posicion) }}</dd>
                }
                <dt>Primer objetivo</dt>
                <dd>{{ op.tp1Hecho ? 'cobrado' : 'aún no' }}</dd>
                @if (op.revision; as rv) {
                  <dt>Última revisión</dt>
                  <dd>
                    {{ shortDate(rv.en) }} · lo mejor {{ rTexto(rv.estado.mfeR) }} · lo peor
                    {{ rTexto(rv.estado.maeR) }} · idea {{ textoDe(TESIS, rv.estado.tesis) }}
                  </dd>
                }
              </dl>
              <div class="bts">
                <ion-button size="small" fill="outline" [routerLink]="['/bots', op.botId]">
                  Ver el bot
                </ion-button>
                @if (viva()) {
                  <ion-button
                    size="small"
                    fill="outline"
                    [disabled]="ocupado()"
                    (click)="revisar(p)"
                  >
                    Revisar ahora
                  </ion-button>
                  <ion-button
                    size="small"
                    fill="clear"
                    color="danger"
                    [disabled]="ocupado()"
                    (click)="cerrar(p)"
                  >
                    Cerrar a mercado
                  </ion-button>
                }
              </div>
            </ui-card>
          }

          @if (d.acciones.length || d.seguimiento.length) {
            <h3 class="ia-sec">Seguimiento</h3>
            <p class="ia-nota">
              Todo lo que puede hacer reduce el riesgo: ceñir el stop, reducir o cerrar. Nunca lo
              aumenta.
            </p>
            @if (d.acciones.length) {
              <ui-card>
                @for (a of d.acciones; track a.id) {
                  <app-accion-item [accion]="a" [ahora]="ahora()" (cambiado)="cargar()" />
                }
              </ui-card>
            }
            @for (r of d.seguimiento; track r.id) {
              <p class="rev">
                <span class="num">{{ shortDate(r.creadaEn) }}</span> ·
                {{ textoDe(DISPARADOR, r.disparador) }} ·
                {{ textoDe(MOTIVO_RONDA, r.motivo) || r.estado }}
                @if (r.accion && r.accion !== 'MANTENER') {
                  · eligió {{ textoDe(ACCION, r.accion) }}
                }
                @if (r.operacion; as o) {
                  · iba {{ rTexto(o.rAhora) }}, idea {{ textoDe(TESIS, o.tesis) }}
                }
              </p>
            }
          }

          <h3 class="ia-sec">Qué habría pasado</h3>
          <p class="ia-nota">{{ hipotetico(p) }}</p>

          @if (d.ronda; as r) {
            <h3 class="ia-sec">Lo que vio</h3>
            <p class="ia-nota">
              Vela de {{ shortDate(r.barT) }} ·
              {{
                r.modo === 'REGLAS'
                  ? 'decidió el juez de reglas'
                  : 'decidió ' + (r.modelo ?? 'el modelo')
              }}
            </p>
            @for (par of r.pares; track par.simbolo) {
              <p class="rev">
                <b>{{ par.simbolo }}</b>
                @if (par.descartes.length) {
                  · {{ lista(DESCARTE, par.descartes) }}
                }
                @for (c of par.candidatos; track $index) {
                  · {{ c.letra ? c.letra + ': ' : '' }}{{ textoDe(FAMILIA, c.familia) }}
                  {{ ladoTexto(c.lado) }}{{ c.elegible ? '' : ' (no elegible)' }}
                }
              </p>
            }
          }
        } @else {
          <div class="center"><ion-spinner name="crescent" /></div>
        }
      </div>
    </ion-content>
  `,
  styles: [
    `
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: var(--space-2);
      }

      .bts {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        margin-top: var(--space-2);
      }

      .queda,
      .nota {
        font-size: 11px;
        color: var(--text-3);
      }

      .linea,
      .cita,
      .rev {
        margin: 0 0 6px;
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--text-2);
      }

      .cita {
        font-style: italic;
      }

      .rev {
        font-size: 11.5px;
        color: var(--text-3);
      }
    `,
  ],
})
export class PropuestaDetallePage implements OnInit {
  private readonly servicio = inject(AgentesIaService);
  private readonly acciones = inject(AgentesAccionesService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly detalle = signal<DetallePropuesta | null>(null);
  readonly error = signal<string | null>(null);
  readonly prohibido = signal(false);
  readonly ocupado = signal(false);
  readonly ahora = reloj(5_000);

  readonly textoDe = textoDe;
  readonly ladoTexto = ladoTexto;
  readonly shortDate = shortDate;
  readonly price = price;
  readonly qty = qty;
  readonly signed = signed;
  readonly rTexto = rTexto;
  readonly tonoR = tonoR;
  readonly quedaTexto = quedaTexto;
  readonly textoEleccionAgente = textoEleccionAgente;
  readonly ACCION = ACCION;
  readonly DESCARTE = DESCARTE;
  readonly DISPARADOR = DISPARADOR;
  readonly ESTADO_PROPUESTA = ESTADO_PROPUESTA;
  readonly FAMILIA = FAMILIA;
  readonly MOTIVO_MODELO = MOTIVO_MODELO;
  readonly MOTIVO_PROPUESTA = MOTIVO_PROPUESTA;
  readonly MOTIVO_RONDA = MOTIVO_RONDA;
  readonly RIESGO_MODELO = RIESGO_MODELO;
  readonly SALIDA = SALIDA;
  readonly TESIS = TESIS;
  readonly tonoPropuesta = tonoPropuesta;

  private readonly id = this.route.snapshot.paramMap.get('id') ?? '';
  private turno = 0;

  readonly titulo = computed(() => {
    const p = this.detalle()?.propuesta;
    return p ? `${p.simbolo} ${ladoTexto(p.lado)}` : 'Propuesta';
  });
  readonly pendiente = computed(() => {
    const p = this.detalle()?.propuesta;
    return !!p && p.estado === 'PROPUESTA' && Date.parse(p.caducaEn) > this.ahora();
  });
  readonly viva = computed(() => {
    const e = this.detalle()?.propuesta.estado;
    return e === 'ABIERTA' || e === 'EJECUTANDO';
  });

  ngOnInit(): void {
    void this.cargar();
    this.servicio.cambios
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.cargar());
  }

  async cargar(): Promise<void> {
    const t = ++this.turno;
    try {
      const d = await this.servicio.propuesta(this.id);
      if (t !== this.turno) return;
      this.detalle.set(d);
      this.error.set(null);
    } catch (e) {
      if (t !== this.turno) return;
      if ((e as { status?: number }).status === 403) this.prohibido.set(true);
      else this.error.set(errorText(e));
    }
  }

  lista(mapa: Readonly<Record<string, string>>, valores: readonly string[]): string {
    return valores.map((v) => textoDe(mapa, v)).join(', ');
  }

  hipotetico(p: PropuestaVista): string {
    if (p.hipotetico) {
      return (
        `Con su plan, entrando al cierre de la vela de la decisión, ` +
        `${textoDe(RESULTADO_HIPOTETICO, p.hipotetico.resultado)} el ${shortDate(new Date(p.hipotetico.en))}: ` +
        `${rTexto(p.hipotetico.r)} con costes. Se mide igual se tomara o no.`
      );
    }
    if (p.medidaEn) return 'No se pudo medir: faltaron las velas.';
    return 'Aún sin medir: se sabrá cuando el precio toque el stop, el objetivo o se acabe su tiempo.';
  }

  async aprobar(p: PropuestaVista): Promise<void> {
    await this.hacer(() => this.acciones.aprobar(p));
  }

  async rechazar(p: PropuestaVista): Promise<void> {
    await this.hacer(() => this.acciones.rechazar(p));
  }

  async revisar(p: PropuestaVista): Promise<void> {
    await this.hacer(() => this.acciones.revisar(p));
  }

  async cerrar(p: PropuestaVista): Promise<void> {
    await this.hacer(() => this.acciones.cerrar(p));
  }

  private async hacer(f: () => Promise<unknown>): Promise<void> {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    try {
      await f();
      await this.cargar();
    } finally {
      this.ocupado.set(false);
    }
  }
}
