import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AlertController, IonButton, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { informationCircleOutline, warningOutline } from 'ionicons/icons';
import { filter, throttleTime } from 'rxjs';
import {
  operacionCanalDe,
  vistaCanalDe,
  type DecisionCanalVista,
  type EstadoCanalBot,
} from '@crypton/shared';
import { BotsService, ToastService } from '../../core/services';
import { CanalIaService } from '../../core/services/canal-ia.service';
import { errorText, money, price, qty, shortDate, signed } from '../../core/utils';
import {
  REGIMEN,
  SETUP,
  TIPO_CANAL,
  pastillaCanal,
  textoDe,
  textoEleccion,
  textoEstado,
  textoMotivos,
} from '../../core/utils/canal-ia';
import { UiBadgeComponent, UiMeterComponent, UiNoticeComponent } from '../ui';

/** El bot, en lo que al panel le importa: el detalle que ve su dueño. */
export interface BotDelCanal {
  id: string;
  name: string;
  status: string;
  config: Record<string, unknown>;
  config_version: number;
  cycle: { scratch?: unknown } | null;
}

/** Las decisiones que se piden de más cada vez. */
const PAGINA = 20;
const AGRUPAR_EVENTOS_MS = 2_000;

/**
 * El canal con IA de un bot propio (spec 059): el lazo, el mercado, la
 * operación viva, el día y las decisiones, con dos mandos.
 *
 * Lee por su cuenta —el estado del servidor con `CanalIaService` y el mercado
 * del `scratch` del ciclo que le pasan— porque lo alojan dos pantallas, el
 * detalle y la consola, y ninguna tiene nada más que hacer con estos datos. Se
 * relee con los eventos del canal de SU bot.
 *
 * Los dos mandos no son nuevos: pausar es el comando `PAUSE` de siempre, y
 * cortar las entradas es `entriesEnabled` guardado por `updateConfig`, el único
 * camino de escritura. El texto del modelo se enseña como texto: viene de
 * fuera y no se interpreta.
 */
@Component({
  selector: 'app-canal-ia-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonButton, IonSpinner, UiBadgeComponent, UiMeterComponent, UiNoticeComponent],
  template: `
    @if (error(); as fallo) {
      <ui-notice tone="danger" icon="warning-outline">
        No se pudo leer el canal con IA de este bot. {{ fallo }}
      </ui-notice>
      <ion-button size="small" fill="outline" (click)="cargar()">Reintentar</ion-button>
    } @else if (estado(); as e) {
      <div class="cab">
        @if (pastilla(); as p) {
          <ui-badge size="sm" caps [tone]="p.tone" [variant]="p.variant">{{ p.texto }}</ui-badge>
        }
        <span class="fina">{{ e.interruptores.modelo }}</span>
        @if (e.lazo.fallos > 0) {
          <span class="fina">· {{ e.lazo.fallos }} fallos seguidos</span>
        }
      </div>
      @if (pastilla()?.porQue; as porQue) {
        <ui-notice tone="warn" icon="warning-outline">{{ porQue }}</ui-notice>
      }
      @if (reglas()) {
        <ui-notice tone="info" icon="information-circle-outline">
          Modo reglas: elige un juez fijo con el perfil, sin consultar a la IA.
        </ui-notice>
      }
      @if (!entradas()) {
        <ui-notice tone="warn" icon="warning-outline">
          Las entradas de este bot están cortadas: no abre nada nuevo.
        </ui-notice>
      }

      <h4>Mercado</h4>
      @if (vista(); as v) {
        <p>
          {{ regimen(v.regimen) }}{{ v.sentido ? ', ' + v.sentido.toLowerCase() : '' }} · vela de
          las {{ hora(v.barT) }}
        </p>
        @if (v.canal; as c) {
          <dl>
            <dt>Canal</dt>
            <dd>{{ tipo(c.tipo) }}, nota {{ c.calidad }}</dd>
            <dt>Resistencia</dt>
            <dd>{{ px(c.resistencia) }}</dd>
            <dt>Media</dt>
            <dd>{{ px(c.media) }}</dd>
            <dt>Soporte</dt>
            <dd>{{ px(c.soporte) }}</dd>
          </dl>
        } @else {
          <p class="fina">Sin un canal que pase las pruebas ahora mismo.</p>
        }
      } @else {
        <p class="fina">Sin análisis todavía: llega con la próxima vela cerrada.</p>
      }

      @if (op(); as o) {
        <h4>Operación abierta</h4>
        <dl>
          <dt>Lado</dt>
          <dd>{{ o.plan.lado === 'LONG' ? 'Largo' : 'Corto' }} · {{ setup(o.plan.setup) }}</dd>
          <dt>Entrada hasta</dt>
          <dd>{{ px(o.plan.entradaTope) }}</dd>
          <dt>Stop</dt>
          <dd>
            {{ px(o.stopBreakeven ?? o.plan.stop) }}{{ o.stopBreakeven ? ' (en la entrada)' : '' }}
          </dd>
          <dt>Objetivos</dt>
          <dd>{{ objetivos(o.plan.objetivos) }}{{ o.tp1Hecho ? ' · el primero, cobrado' : '' }}</dd>
          <dt>Tamaño</dt>
          <dd>{{ qty(o.plan.cantidad) }} a {{ o.plan.apalancamiento }}x</dd>
          <dt>Riesgo</dt>
          <dd>{{ money(o.plan.riesgo) }} · R {{ o.plan.rNeto.toFixed(2) }}</dd>
          <dt>Cierra a mercado</dt>
          <dd>{{ fecha(o.plan.venceEn) }}</dd>
        </dl>
      }

      <h4>Hoy (UTC)</h4>
      <ui-meter label="Pérdida frente al tope" [segments]="consumo()" [total]="e.hoy.topePct" />
      <dl>
        <dt>Resultado</dt>
        <dd>
          {{ signed(e.hoy.realizado) }} · pierde {{ money(e.hoy.perdidaPct) }} % de
          {{ money(e.hoy.topePct, 1) }} %
        </dd>
        <dt>Operaciones</dt>
        <dd>{{ e.hoy.operaciones }} de {{ e.hoy.topeOperaciones }}</dd>
        <dt>Pérdidas seguidas</dt>
        <dd>{{ e.hoy.rachaPerdidas }}</dd>
        <dt>Consultas</dt>
        <dd>
          {{ e.lazo.llamadasHoy }} de {{ e.hoy.topeConsultas }} ·
          {{ money(e.lazo.costeHoy, 4) }}
          USD
        </dd>
      </dl>

      <h4>Últimas decisiones</h4>
      @for (d of decisiones(); track d.id) {
        <div class="dec">
          <p class="l1">
            <span>{{ fecha(d.creadaEn) }}</span>
            <ui-badge size="sm" [tone]="tono(d)">{{ textoEstado(d) }}</ui-badge>
            @if (d.origen === 'REGLAS') {
              <ui-badge size="sm" variant="outline">reglas</ui-badge>
            }
          </p>
          @if (textoEleccion(d.eleccion); as t) {
            <p>{{ t }}</p>
          }
          @if (d.plan; as pl) {
            <p class="fina">
              {{ pl.lado === 'LONG' ? 'Largo' : 'Corto' }} · entrada hasta
              {{ px(pl.entradaTope) }} · stop {{ px(pl.stop) }} · {{ pl.apalancamiento }}x · riesgo
              {{ money(pl.riesgo) }}
            </p>
          }
          @if (motivos(d); as m) {
            @if (m.motivos) {
              <p class="fina">A favor: {{ m.motivos }}</p>
            }
            @if (m.riesgos) {
              <p class="fina">Riesgos: {{ m.riesgos }}</p>
            }
          }
          @if (d.respuesta?.texto; as texto) {
            <p class="texto">«{{ texto }}»</p>
          }
          @if (d.latenciaMs !== null) {
            <p class="fina">
              {{ d.latenciaMs }} ms{{ d.coste !== null ? ' · ' + money(d.coste, 4) + ' USD' : '' }}
            </p>
          }
        </div>
      } @empty {
        <p class="fina">Ninguna decisión todavía.</p>
      }
      @if (hayMas()) {
        <ion-button size="small" fill="clear" [disabled]="cargandoMas()" (click)="verMas()">
          Ver más
        </ion-button>
      }

      <div class="acciones">
        <ion-button
          size="small"
          fill="outline"
          color="warning"
          [disabled]="ocupado() || bot().status !== 'RUNNING'"
          (click)="pausar()"
        >
          Pausar el bot
        </ion-button>
        <ion-button size="small" fill="outline" [disabled]="ocupado()" (click)="alternarEntradas()">
          {{ entradas() ? 'Cortar las entradas' : 'Abrir las entradas' }}
        </ion-button>
      </div>
    } @else {
      <div class="centro"><ion-spinner name="crescent" /></div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }

      .cab,
      .l1 {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin: 0;
      }

      h4 {
        margin: var(--space-3) 0 0;
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-3);
      }

      p {
        margin: 0;
        font-size: 12px;
        line-height: 1.45;
        color: var(--text-2);
      }

      .fina {
        font-size: 11px;
        color: var(--text-3);
      }

      .texto {
        font-style: italic;
        overflow-wrap: anywhere;
      }

      dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 3px var(--space-3);
        margin: 0;
        font-size: 12px;
      }

      dt {
        color: var(--text-3);
      }

      dd {
        margin: 0;
        color: var(--text-1);
        font-family: var(--font-mono);
        text-align: right;
        overflow-wrap: anywhere;
      }

      .dec {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-2) 0;
        border-bottom: 1px solid var(--border-subtle);
      }

      .acciones {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }

      .centro {
        display: flex;
        justify-content: center;
        padding: var(--space-5) 0;
      }
    `,
  ],
})
export class CanalIaPanelComponent implements OnInit {
  private readonly canal = inject(CanalIaService);
  private readonly bots = inject(BotsService);
  private readonly toast = inject(ToastService);
  private readonly alerts = inject(AlertController);
  private readonly destroyRef = inject(DestroyRef);

  readonly bot = input.required<BotDelCanal>();
  /** Decimales del mercado para los precios; sin ellos se deducen de la magnitud. */
  readonly decimales = input<number | null>(null);
  /** Tras pausar o cambiar las entradas: la pantalla decide cómo recargarse. */
  readonly cambiado = output<void>();

  readonly estado = signal<EstadoCanalBot | null>(null);
  readonly error = signal<string | null>(null);
  readonly ocupado = signal(false);
  private readonly anteriores = signal<DecisionCanalVista[]>([]);
  private readonly sinMas = signal(false);
  readonly cargandoMas = signal(false);
  /** Una lectura que llega después de otra más nueva no la pisa. */
  private turno = 0;

  readonly vista = computed(() => vistaCanalDe(this.bot().cycle?.scratch));
  readonly op = computed(() => operacionCanalDe(this.bot().cycle?.scratch));
  readonly reglas = computed(() => this.bot().config['decisionMode'] === 'REGLAS');
  readonly entradas = computed(() => this.bot().config['entriesEnabled'] !== false);

  readonly pastilla = computed(() => {
    const e = this.estado();
    return e ? pastillaCanal(e.interruptores, e.lazo, this.bot(), Date.now(), e.propio) : null;
  });

  readonly decisiones = computed(() => [
    ...(this.estado()?.decisiones ?? []),
    ...this.anteriores(),
  ]);

  /** Las cinco del estado no dicen si hay más; una página corta, sí. */
  readonly hayMas = computed(() => !this.sinMas() && this.decisiones().length >= 5);

  readonly money = money;
  readonly signed = signed;
  readonly qty = qty;
  readonly textoEleccion = textoEleccion;
  readonly textoEstado = textoEstado;
  readonly motivos = textoMotivos;

  /**
   * El id, y no el bot: la pantalla sustituye el objeto en cada recarga, y un
   * efecto que leyera el bot entero volvería a empezar con cada una.
   */
  private readonly botId = computed(() => this.bot().id);

  /** El consumo del tope diario, con su tipo: un literal en la plantilla sería `string`. */
  readonly consumo = computed(() => {
    const e = this.estado();
    return e ? [{ value: e.hoy.perdidaPct, tone: 'down' as const }] : [];
  });

  constructor() {
    addIcons({ informationCircleOutline, warningOutline });

    // Otro bot en el mismo componente: se empieza de cero.
    effect(() => {
      this.botId();
      untracked(() => {
        this.estado.set(null);
        this.anteriores.set([]);
        this.sinMas.set(false);
        void this.cargar();
      });
    });
  }

  /**
   * Los eventos del canal de SU bot. En `ngOnInit` y no en el constructor: el
   * filtro lee la entrada, y un evento que llegara antes de enlazarla lanzaría.
   */
  ngOnInit(): void {
    this.canal.eventos
      .pipe(
        filter((ev) => ev.botId === this.botId()),
        throttleTime(AGRUPAR_EVENTOS_MS, undefined, { leading: true, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => void this.cargar());
  }

  async cargar(): Promise<void> {
    const id = this.botId();
    const turno = ++this.turno;
    try {
      const estado = await this.canal.estado(id);
      if (turno !== this.turno) return;
      this.estado.set(estado);
      this.error.set(null);
    } catch (e) {
      if (turno !== this.turno) return;
      // Un fallo es un fallo: pintar «sin decisiones» diría algo que no se sabe.
      this.estado.set(null);
      this.error.set(errorText(e));
    }
  }

  async verMas(): Promise<void> {
    const ultima = this.decisiones().at(-1);
    if (!ultima || this.cargandoMas()) return;
    this.cargandoMas.set(true);
    try {
      const pagina = await this.canal.decisiones(this.bot().id, ultima.creadaEn, PAGINA);
      this.anteriores.update((a) => [...a, ...pagina]);
      if (pagina.length < PAGINA) this.sinMas.set(true);
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.cargandoMas.set(false);
    }
  }

  /**
   * El comando `PAUSE`, con lo que hace en ESTE bot dicho antes: cancela los
   * objetivos y deja solo el stop, y un bot pausado tampoco cierra por tiempo.
   */
  async pausar(): Promise<void> {
    const b = this.bot();
    const ok = await this.confirmar(
      'Pausar el bot',
      `${b.name} dejará de abrir operaciones. Si hay una abierta, se cancelan sus objetivos y ` +
        'se queda solo con el stop en el exchange: mientras esté pausado no se cierra con ' +
        'beneficio ni por tiempo.',
    );
    if (!ok) return;
    await this.enviar(async () => {
      await this.bots.command(b.id, 'PAUSE');
      await this.toast.success('Pausa enviada.');
    });
  }

  /**
   * `entriesEnabled` por el camino de siempre, con la versión sobre la que se
   * decidió: si la configuración cambió entretanto, la API lo rechaza.
   */
  async alternarEntradas(): Promise<void> {
    const b = this.bot();
    const abrir = !this.entradas();
    const ok = await this.confirmar(
      abrir ? 'Abrir las entradas' : 'Cortar las entradas',
      abrir
        ? `${b.name} volverá a abrir operaciones cuando el canal y la IA lo decidan.`
        : `${b.name} no abrirá operaciones nuevas. La abierta, si la hay, sigue con su stop y sus ` +
            'objetivos. Queda en el historial de configuración.',
    );
    if (!ok) return;
    await this.enviar(async () => {
      await this.bots.updateConfig(
        b.id,
        { ...b.config, entriesEnabled: abrir },
        false,
        b.config_version,
      );
      await this.toast.success(abrir ? 'Entradas abiertas.' : 'Entradas cortadas.');
    });
  }

  private async enviar(accion: () => Promise<void>): Promise<void> {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    try {
      await accion();
      this.cambiado.emit();
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.ocupado.set(false);
    }
  }

  private async confirmar(header: string, message: string): Promise<boolean> {
    const alerta = await this.alerts.create({
      header,
      message,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Confirmar', role: 'confirm' },
      ],
    });
    await alerta.present();
    const { role } = await alerta.onDidDismiss();
    return role === 'confirm';
  }

  tono(d: DecisionCanalVista): 'up' | 'down' | 'warn' | 'neutral' {
    if (d.estado === 'ABIERTA' || d.estado === 'ACEPTADA' || d.estado === 'CERRADA') return 'up';
    if (d.estado === 'FALLIDA') return 'down';
    if (d.estado === 'RECHAZADA' || d.estado === 'CADUCADA') return 'warn';
    return 'neutral';
  }

  px(valor: string): string {
    return price(valor, this.decimales());
  }

  objetivos(lista: readonly { precio: string }[]): string {
    return lista.map((o) => this.px(o.precio)).join(' · ');
  }

  regimen(v: string): string {
    const t = textoDe(REGIMEN, v);
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  tipo(v: string): string {
    return textoDe(TIPO_CANAL, v);
  }

  setup(v: string): string {
    return textoDe(SETUP, v);
  }

  fecha(valor: string | number): string {
    return shortDate(new Date(valor));
  }

  hora(ms: number): string {
    return new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }
}
