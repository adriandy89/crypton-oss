import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { D, capitalActual, sumaExacta } from '@crypton/shared';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFab,
  IonFabButton,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addOutline,
  flashOffOutline,
  gridOutline,
  flaskOutline,
  linkOutline,
  shieldOutline,
  warningOutline,
} from 'ionicons/icons';
import {
  BotsService,
  ExchangeAccountsService,
  NetworkService,
  RiskService,
  StreamService,
  ToastService,
} from '../../core/services';
import type { BotSummary } from '../../core/models';
import {
  errorText,
  money,
  pct,
  pnlColor,
  price,
  qty,
  signed,
  strategyLabel,
  uptime,
  venueLabel,
} from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiEmptyStateComponent,
  UiLiqMeterComponent,
  UiNoticeComponent,
  UiSparkComponent,
  UiStatComponent,
  UiStatusPillComponent,
} from '../../shared/ui';
import { puntosDeSpark } from '../../shared/chart/bot-series';
import { LIQ_DANGER_PCT, liqNum } from '../../core/utils/risk';

/**
 * Las tres primeras son de estado y solo miran bots REALES; `SIM` es de modo.
 *
 * Mezclar los dos ejes en un solo selector es deliberado: separar «real» de
 * «simulado» en un interruptor aparte daría ocho combinaciones para un caso
 * —«simulados parados»— que nadie pide, y dos controles donde hoy hay uno.
 */
type Filter = 'ALL' | 'LIVE' | 'STOPPED' | 'SIM';

/**
 * Orden de la lista. Con veinte bots, cuatro filtros no ayudan a encontrar el
 * que hay que mirar hoy; el de riesgo es el que se busca con urgencia y por eso
 * es el de partida.
 */
type Orden = 'RIESGO' | 'RESULTADO' | 'ROI';

/** Estados en los que un bot está bajo el control del motor. */
const VIVOS = ['STARTING', 'RUNNING', 'PAUSED'];

@Component({
  selector: 'app-bots-list',
  standalone: true,
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    IonSegment,
    IonSegmentButton,
    IonIcon,
    IonSpinner,
    IonFab,
    IonFabButton,
    UiBadgeComponent,
    UiCardComponent,
    UiLiqMeterComponent,
    UiSparkComponent,
    UiStatComponent,
    UiStatusPillComponent,
    UiNoticeComponent,
    UiEmptyStateComponent,
  ],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Bots</ion-title>
        <ion-buttons slot="end">
          <!-- Kill-switch siempre a la vista: si hace falta, hace falta ya. -->
          <ion-button
            class="kill"
            fill="clear"
            color="danger"
            (click)="killSwitch()"
            [disabled]="liveCount() === 0"
          >
            <ion-icon slot="icon-only" name="flash-off-outline" />
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
      <ion-toolbar>
        <ion-segment [value]="filter()" (ionChange)="filter.set($any($event.detail.value))">
          <ion-segment-button value="ALL">Todos</ion-segment-button>
          <ion-segment-button value="LIVE">Activos</ion-segment-button>
          <ion-segment-button value="STOPPED">Parados</ion-segment-button>
          <ion-segment-button value="SIM">Simulados</ion-segment-button>
        </ion-segment>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <ion-refresher slot="fixed" (ionRefresh)="reload($event)">
        <ion-refresher-content />
      </ion-refresher>

      <!-- Los totales de LO QUE SE ESTA VIENDO, no de toda la cartera: cambian
           al filtrar, asi que esta franja contesta «cuanto tengo en los
           simulados» o «cuanto en los activos» sin salir de aqui. La suma es
           exacta, con la aritmetica del paquete compartido (invariante 1). -->
      @if (visible().length) {
        <div class="totals">
          <ui-stat
            label="Capital actual"
            [value]="money(capitalTotal())"
            [hint]="visible().length + (visible().length === 1 ? ' bot' : ' bots')"
          />
          <ui-stat label="Asignado" [value]="money(asignadoTotal())" />
          <ui-stat label="PnL" [value]="signed(pnlTotal())" [tone]="pnlColor(pnlTotal())" />
        </div>
      }

      @if (visible().length > 1) {
        <div class="sort">
          <span>Ordenar</span>
          <div class="chips">
            <button type="button" [class.on]="sort() === 'RIESGO'" (click)="sort.set('RIESGO')">
              Riesgo
            </button>
            <button
              type="button"
              [class.on]="sort() === 'RESULTADO'"
              (click)="sort.set('RESULTADO')"
            >
              Resultado
            </button>
            <button type="button" [class.on]="sort() === 'ROI'" (click)="sort.set('ROI')">
              ROI
            </button>
          </div>
        </div>
      }

      @if (bots.loading() && bots.bots().length === 0) {
        <div class="center"><ion-spinner name="crescent" /></div>
      } @else if (visible().length === 0) {
        <!-- El vacío de la pestaña de SIMULADOS es suyo: aquí pedir que se
             conecte un exchange sería mentira, porque para simular no hace
             falta ninguno. -->
        @if (filter() === 'SIM') {
          <ui-empty-state icon="flask-outline" title="Todavía no has simulado nada">
            <p>
              Un bot simulado opera con los precios reales de mainnet y dinero de mentira. Cada uno
              tiene su propio saldo, así que puedes dejar corriendo varias estrategias sobre el
              mismo par y compararlas.
            </p>
            <ion-button routerLink="/bots/new">Crear un bot simulado</ion-button>
          </ui-empty-state>
        } @else if (simulados().length > 0) {
          <!-- El caso que hay que cuidar: alguien que solo ha probado abre Bots,
               cae en «Todos» y se encuentra un vacío que le habla de conectar un
               exchange mientras sus bots están en la pestaña de al lado. Sin
               este puente, el usuario cree haberlos perdido. -->
          <ui-empty-state icon="flask-outline" title="Tus bots están en «Simulados»">
            <p>
              Aquí salen los que operan con dinero de verdad, y todavía no tienes ninguno. Los
              <b>{{ simulados().length }}</b> que has creado están simulando: precios reales y
              dinero de mentira.
            </p>
            <ion-button (click)="filter.set('SIM')">Ver mis bots simulados</ion-button>
            <ion-button
              fill="clear"
              routerLink="/accounts/new"
              [queryParams]="{ next: '/bots/new' }"
            >
              Conectar exchange
            </ion-button>
          </ui-empty-state>
        } @else if (faltaConexion()) {
          <ui-empty-state
            icon="flask-outline"
            [title]="testnet() ? 'Sin conexiones en testnet' : 'Prueba primero, sin conectar nada'"
          >
            <p>
              @if (testnet()) {
                Estás viendo <b>testnet</b> y no tienes ninguna conexión en esa red. Tus cuentas de
                la red real siguen ahí: apaga el interruptor de testnet en Cuenta para volver a
                verlas. La <b>simulación</b> no depende de esto y puedes usarla ya.
              } @else {
                Todavía no has conectado ningún exchange, y para probar no hace falta: tu bot puede
                operar en <b>simulación</b> con los precios reales de mainnet y dinero de mentira.
                Cuando te convenza, conectas el exchange y lo repites de verdad.
              }
            </p>
            <ion-button routerLink="/bots/new">Crear un bot simulado</ion-button>
            <ion-button
              fill="clear"
              routerLink="/accounts/new"
              [queryParams]="{ next: '/bots/new' }"
            >
              Conectar exchange
            </ion-button>
          </ui-empty-state>
        } @else {
          <ui-empty-state
            icon="grid-outline"
            [title]="testnet() ? 'Ningún bot en testnet' : 'Todavía no tienes bots aquí'"
          >
            <p>
              @if (testnet()) {
                Aquí solo salen los bots de <b>testnet</b>. Los que tengas en la red real siguen
                operando: apaga el interruptor de testnet en Cuenta para verlos.
              } @else {
                Empieza en modo simulación: precios reales del exchange y cero órdenes enviadas.
                Cuando te convenza, lo pasas a real.
              }
            </p>
            <ion-button routerLink="/bots/new">Crear mi primer bot</ion-button>
          </ui-empty-state>
        }
      } @else {
        <div class="list">
          @for (bot of visible(); track bot.id) {
            <ui-card class="bot" [routerLink]="['/bots', bot.id]">
              <div class="row">
                <div class="id">
                  <h3>{{ bot.name }}</h3>
                  <p class="meta">
                    <span>
                      {{ bot.symbol }} · {{ venueLabel(bot.venue) }} ·
                      {{ strategyLabel(bot.strategy) }}
                    </span>
                    @if (bot.dryRun) {
                      <ui-badge size="sm" tone="warn" caps>simulación</ui-badge>
                    }
                    <!-- La red va en cada fila ADEMAS de en la franja de arriba:
                         la franja dice que la lista es de testnet, pero esto es
                         lo que se ve en una captura suelta o al volver de otra
                         pantalla, y confundir el libro es confundir el dinero.
                         Va en contorno y no en relleno para que se distinga de
                         «simulación», que comparte el ambar: un bot SIMULADO en
                         testnet no es lo mismo que uno real en testnet. -->
                    @if (bot.testnet) {
                      <ui-badge size="sm" tone="warn" variant="outline" caps>testnet</ui-badge>
                    }
                  </p>
                </div>
                <ui-status-pill [status]="bot.status" />
              </div>

              <!-- Ultimas 24 h, un punto por hora, con el cero visible. Viaja
                   CON la lista: una peticion por tarjeta serian veinte. Con
                   menos de dos puntos no hay linea que pintar. -->
              @let puntos = puntosDeSpark(bot.spark);
              @if (puntos.length > 1) {
                <ui-spark
                  mode="line"
                  [points]="puntos"
                  [baseline]="0"
                  [height]="30"
                  [label]="'Resultado de las últimas 24 h de ' + bot.name"
                />
              }

              <!-- Cuanto dinero hay AHORA, primero: es la pregunta que trae al
                   usuario a esta pantalla y hasta el spec 025 tenia que sumarla de
                   cabeza. Debajo, lo que puso, para leer las dos cifras juntas. La
                   suma la hace el servidor con el paquete compartido: la app no suma dinero. -->
              <div class="grid">
                <ui-stat
                  label="Capital actual"
                  [value]="money(capital(bot))"
                  [hint]="'de ' + money(bot.totalInvestment) + ' asignados'"
                />
                <ui-stat
                  label="PnL total"
                  [value]="signed(total(bot))"
                  [tone]="pnlColor(total(bot))"
                />
                <ui-stat label="ROI" [value]="pct(bot.roiPct)" [tone]="pnlColor(bot.roiPct)" />
                <ui-stat label="Órdenes" [value]="bot.openOrders" />
              </div>

              <!-- Lo que hay en juego, como lo pone un exchange junto a la
                   posicion: cuanta hay y que vale a precio de marca, que margen la
                   sostiene y cuanto lleva el bot en marcha. -->
              <p class="facts num">
                @if (enPosicion(bot)) {
                  <span>
                    Posición <b>{{ qty(bot.positionQty) }}</b>
                    @if (bot.positionValue) {
                      ≈ <b>{{ money(bot.positionValue) }}</b>
                    }
                  </span>
                  @if (conMargen(bot)) {
                    <span
                      >Margen <b>{{ money(bot.marginUsed) }}</b></span
                    >
                  }
                } @else {
                  <span>Sin posición</span>
                }
                <span
                  >Activo <b>{{ uptime(bot.uptimeSeconds) }}</b></span
                >
              </p>

              <!-- La distancia a liquidación es LA métrica de riesgo: se muestra
                   en la tarjeta, no escondida en el detalle. -->
              @if (liqDistance(bot); as dist) {
                <ui-liq-meter [pct]="bot.liquidationDistancePct" />
                @if (dist < liqPeligro) {
                  <ui-notice tone="danger" icon="warning-outline">
                    <span class="num">
                      A un {{ money(dist, 1) }} % de la liquidación, en
                      {{ price(bot.liquidationPrice) }}.
                    </span>
                  </ui-notice>
                }
              }

              @if (bot.lastError) {
                <ui-notice tone="danger" icon="warning-outline">{{ bot.lastError }}</ui-notice>
              } @else if (bot.note) {
                <ui-notice tone="info">{{ bot.note }}</ui-notice>
              }
            </ui-card>
          }
        </div>
      }

      <ion-fab slot="fixed" vertical="bottom" horizontal="end">
        <ion-fab-button routerLink="/bots/new">
          <ion-icon name="add-outline" />
        </ion-fab-button>
      </ion-fab>
    </ion-content>
  `,
  styleUrl: './bots-list.page.scss',
})
export class BotsListPage implements OnInit {
  readonly bots = inject(BotsService);
  private readonly stream = inject(StreamService);
  private readonly toast = inject(ToastService);
  private readonly risk = inject(RiskService);
  private readonly accountsSvc = inject(ExchangeAccountsService);
  private readonly network = inject(NetworkService);
  /** La red que se esta mirando. La lista ya viene filtrada por ella. */
  readonly testnet = this.network.testnet;

  readonly filter = signal<Filter>('ALL');
  readonly sort = signal<Orden>('RIESGO');

  readonly money = money;
  readonly price = price;
  readonly qty = qty;
  readonly signed = signed;
  readonly pct = pct;
  readonly pnlColor = pnlColor;
  readonly uptime = uptime;
  readonly strategyLabel = strategyLabel;
  readonly venueLabel = venueLabel;
  readonly puntosDeSpark = puntosDeSpark;
  readonly liqPeligro = LIQ_DANGER_PCT;

  /**
   * Los que operan de verdad, y los que no.
   *
   * El corte es `dryRun` y no `paper`, y no es lo mismo: `paper` dice que la
   * CONEXIÓN no tiene claves, y `dryRun` que el BOT no manda órdenes. Todo bot
   * de una conexión de simulación es `dryRun`, pero también puede haberlo sobre
   * una conexión REAL —el interruptor «Modo simulación» del asistente— y ese
   * tampoco mueve un euro. Cortando por `paper` se quedaría en «Activos»,
   * mezclado con los de verdad, que es justo lo que aquí se viene a separar.
   */
  private readonly reales = computed(() => this.bots.bots().filter((b) => !b.dryRun));
  readonly simulados = computed(() => this.bots.bots().filter((b) => b.dryRun));

  private readonly filtrados = computed(() => {
    if (this.filter() === 'SIM') return this.simulados();

    // Las tres de estado ya no miran los simulados: el recuento de «Activos» es
    // la cifra que se mira para saber cuánto hay expuesto, y desde que todo el
    // mundo tiene conexión de simulación se llenaba de bots que no arriesgan
    // nada.
    const reales = this.reales();
    switch (this.filter()) {
      case 'LIVE':
        return reales.filter((b) => VIVOS.includes(b.status));
      case 'STOPPED':
        return reales.filter((b) => ['STOPPED', 'ERROR', 'DRAFT', 'LIQUIDATED'].includes(b.status));
      default:
        return reales;
    }
  });

  readonly visible = computed(() => this.ordena(this.filtrados()));

  /** Copia ordenada; `sort` muta y las señales de arriba se comparten. */
  private ordena(bots: BotSummary[]): BotSummary[] {
    const riesgo = (b: BotSummary) => this.liqDistance(b) ?? Number.POSITIVE_INFINITY;
    switch (this.sort()) {
      case 'RESULTADO':
        return [...bots].sort((a, b) => D(this.total(b)).comparedTo(D(this.total(a))));
      case 'ROI':
        return [...bots].sort((a, b) => D(b.roiPct).comparedTo(D(a.roiPct)));
      default:
        return [...bots].sort((a, b) => riesgo(a) - riesgo(b));
    }
  }

  /**
   * Si ya se sabe que no hay ninguna conexión utilizable.
   *
   * El `accountsCargadas` no es ceremonia: sin él, un fallo de red al leer las
   * conexiones dejaría la lista vacía y esta pantalla le diría «conecta un
   * exchange» a alguien que ya tiene uno. Mientras no se sepa, se enseña el
   * CTA de siempre.
   */
  readonly accountsCargadas = signal(false);
  /**
   * No hay ninguna conexion operativa EN LA RED que se esta mirando.
   *
   * La red importa: quien tiene su cuenta en mainnet y enciende la lente no es
   * que no tenga conexiones, es que no tiene ninguna en testnet — y el texto que
   * hay que enseñarle es otro.
   */
  /**
   * No hay ninguna conexión REAL operativa.
   *
   * Ya no bloquea nada —con la de simulación siempre se puede crear un bot—,
   * así que dejó de ser un requisito que avisar y pasó a ser el motivo por el
   * que lo que se ofrece es probar en vez de operar. Las de simulación quedan
   * fuera de la cuenta a propósito: si contaran, esto nunca sería cierto y el
   * mensaje no saldría jamás.
   */
  readonly faltaConexion = computed(
    () =>
      this.accountsCargadas() &&
      !this.accountsSvc
        .accounts()
        .some(
          (a) =>
            !a.paper && ['VERIFIED', 'ACTIVE'].includes(a.status) && a.testnet === this.testnet(),
        ),
  );

  /**
   * Bots vivos, SIMULADOS INCLUIDOS. Es lo que mide el kill-switch.
   *
   * No se restringe a los reales aunque las pestañas sí lo hagan: el servidor
   * para todos los bots vivos del usuario sin mirar el modo, así que el aviso
   * —«vas a parar N bots»— tiene que contar los mismos que van a pararse. Bajar
   * el número para que cuadre con la pestaña haría mentir justo al botón de
   * pánico.
   */
  readonly liveCount = computed(
    () => this.bots.bots().filter((b) => VIVOS.includes(b.status)).length,
  );

  constructor() {
    addIcons({
      addOutline,
      flashOffOutline,
      warningOutline,
      shieldOutline,
      gridOutline,
      flaskOutline,
      linkOutline,
    });

    // Cualquier evento del motor refresca la lista. Es barato y evita que el
    // usuario vea un estado viejo justo después de que salte una guarda.
    //
    // Atada al ciclo de vida: el `Subject` del servicio vive toda la sesion, asi
    // que una suscripcion sin soltar sobrevive al componente y sigue pidiendo
    // datos para una pantalla que ya no existe.
    this.stream.stream.pipe(takeUntilDestroyed()).subscribe(() => void this.bots.refresh());
  }

  ngOnInit(): void {
    void this.bots.refresh();
    // Sin bloquear y tolerante a fallos: esta es la pantalla de aterrizaje, y
    // un error al leer las conexiones no puede dejarla sin su lista de bots.
    void this.cargarConexiones();
  }

  /**
   * Las conexiones, con reintento.
   *
   * Antes esto era un `.catch(() => undefined)` a secas y el fallo era
   * permanente: si la primera lectura no salia —y esta es la pantalla de
   * aterrizaje, la que se abre justo al arrancar, cuando la red del movil
   * todavia puede no estar—, `accountsCargadas` se quedaba en false y el estado
   * vacio no se resolvia NUNCA. Ni volviendo a entrar: es una pestaña, asi que
   * `ngOnInit` no se repite.
   *
   * Tambien lo reintenta el tirar-para-refrescar, que ya llama aqui.
   */
  private async cargarConexiones(): Promise<void> {
    try {
      await this.accountsSvc.refresh();
      this.accountsCargadas.set(true);
    } catch {
      // Silencioso a proposito: lo que el usuario venia a ver es su lista de
      // bots, que se pide aparte. Mientras no se sepa si hay conexiones se
      // enseña el CTA de siempre, que es la lectura segura.
    }
  }

  async reload(event: CustomEvent): Promise<void> {
    await Promise.all([this.bots.refresh(), this.cargarConexiones()]);
    void (event.target as HTMLIonRefresherElement).complete();
  }

  /** Resultado total de la tarjeta. Con `Decimal`, no con `Number`: invariante 1. */
  total(bot: BotSummary): string {
    return sumaExacta([bot.realizedPnl, bot.unrealizedPnl]);
  }

  /**
   * Capital actual del bot, con respaldo.
   *
   * Lo normal es que lo mande el servidor ya calculado. Pero la app se despliega
   * por su cuenta —y un servidor una versión por detrás no manda el campo—, así
   * que aquí se compone con la MISMA función del paquete compartido a partir de
   * lo que cualquier versión sí manda. La cifra que el usuario viene a ver nunca
   * sale como «—» por un despliegue a medias.
   */
  capital(bot: BotSummary): string {
    return (
      bot.currentCapital ?? capitalActual(bot.totalInvestment, bot.realizedPnl, bot.unrealizedPnl)
    );
  }

  /** Los tres totales de lo que se está viendo. Se recalculan al filtrar y al ordenar. */
  readonly capitalTotal = computed(() => sumaExacta(this.visible().map((b) => this.capital(b))));
  readonly asignadoTotal = computed(() => sumaExacta(this.visible().map((b) => b.totalInvestment)));
  readonly pnlTotal = computed(() => sumaExacta(this.visible().map((b) => this.total(b))));

  /** Hay posicion abierta, en cualquiera de los dos sentidos. */
  enPosicion(bot: BotSummary): boolean {
    return D(bot.positionQty ?? 0)
      .abs()
      .gt(0);
  }

  /** El snapshot trae margen usado. `?? 0`: un servidor sin actualizar no manda el campo. */
  conMargen(bot: BotSummary): boolean {
    return D(bot.marginUsed ?? 0).gt(0);
  }

  /**
   * Distancia porcentual del precio de MERCADO a la liquidación; null si no aplica.
   *
   * La calcula el servidor y llega en `liquidationDistancePct`. Antes se
   * calculaba aquí contra `averageEntry` —una propiedad estática de la posición
   * que no se mueve con el mercado— y el aviso no saltaba justo cuando el
   * precio se pegaba a la liquidación (spec 002, F-02). Se convierte a `number`
   * solo para el umbral del semáforo.
   */
  liqDistance(bot: BotSummary): number | null {
    return liqNum(bot.liquidationDistancePct);
  }

  async killSwitch(): Promise<void> {
    const confirmed = window.confirm(
      `Vas a PARAR ${this.liveCount()} bot(s) y cancelar todas sus órdenes. Las posiciones abiertas se cerrarán a mercado. ¿Continuar?`,
    );
    if (!confirmed) return;

    try {
      const { affected } = await this.risk.killSwitch();
      await this.toast.warn(`Kill-switch aplicado a ${affected} bot(s).`);
      await this.bots.refresh();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }
}
