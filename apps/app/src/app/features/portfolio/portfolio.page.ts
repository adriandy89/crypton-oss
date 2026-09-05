import { Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  D,
  PORTFOLIO_CADENCE_MS,
  PORTFOLIO_RANGES,
  SERIES_POINTS,
  gapMsFor,
  repartoPorSimbolo,
  sumaExacta,
  vistaDeSerie,
  type PortfolioEquitySeries,
  type PortfolioRange,
} from '@crypton/shared';
import { liqNum, liqTone } from '../../core/utils/risk';
import {
  IonContent,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { informationCircleOutline, warningOutline } from 'ionicons/icons';
import {
  BotsService,
  NetworkService,
  PortfolioService,
  RiskService,
  StreamService,
} from '../../core/services';
import type { BotSummary } from '../../core/models';
import {
  ago,
  money,
  pct,
  pnlColor,
  price,
  qty,
  signed,
  uptime,
  venueLabel,
} from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiEmptyStateComponent,
  UiLiqMeterComponent,
  UiMeterComponent,
  UiNoticeComponent,
  UiSectionComponent,
  UiSparkComponent,
  UiStatComponent,
} from '../../shared/ui';
import { puntosDeSpark, ventanaDe } from '../../shared/chart/bot-series';

@Component({
  selector: 'app-portfolio',
  standalone: true,
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    IonIcon,
    UiBadgeComponent,
    UiCardComponent,
    UiLiqMeterComponent,
    UiMeterComponent,
    UiNoticeComponent,
    UiSparkComponent,
    UiStatComponent,
    UiSectionComponent,
    UiEmptyStateComponent,
  ],
  template: `
    <ion-header>
      <ion-toolbar><ion-title>Cartera</ion-title></ion-toolbar>
    </ion-header>

    <ion-content>
      <ion-refresher slot="fixed" (ionRefresh)="reload($event)">
        <ion-refresher-content />
      </ion-refresher>

      <div class="pad">
        <!-- Resultado agregado arriba del todo: es la cifra que se mira primero
             al abrir la app, y la única que lleva realce de la dirección.

             Suma SOLO los bots que operan de verdad. Los simulados tienen su
             propio bloque más abajo: meterlos aquí convertiría la cifra más
             mirada de la app en una que no significa nada. -->
        <ui-card tone="hero" class="hero">
          <span class="k">Resultado total</span>
          <span class="v num" [class]="'c-' + pnlColor(totalPnl())">{{ signed(totalPnl()) }}</span>
          <span class="sub num">
            <b>{{ signed(realized()) }}</b> realizado · <b>{{ signed(unrealized()) }}</b> abierto
          </span>

          <!-- La historia de la cifra de arriba (spec 003): una fila cada cinco
               minutos escrita por el worker con los bots reales vivos, servida
               agregada por extremos. Se llama «resultado acumulado», no «equity»
               ni «capital»: es realizado más abierto, no patrimonio. Los tramos
               sin bots vivos no tienen filas y la línea se rompe ahí, con el
               mismo criterio de hueco que la curva de un bot. -->
          @let c = curva();
          @if (c || reales().length > 0) {
            <div class="pf-curve">
              <div class="bd-range">
                @for (r of rangos; track r) {
                  <button type="button" [class.on]="rango() === r" (click)="setRango(r)">
                    {{ r }}
                  </button>
                }
              </div>
              @if (c) {
                <ui-spark
                  mode="area"
                  [points]="c.puntos"
                  [breaks]="c.cortes"
                  [baseline]="0"
                  [height]="64"
                  [label]="
                    'Resultado acumulado de la cartera: de ' +
                    signed(c.primero) +
                    ' a ' +
                    signed(c.ultimo) +
                    ', peor caída ' +
                    money(c.peorCaida)
                  "
                />
                <span class="pf-foot num">
                  Resultado acumulado · cubre {{ cobertura() }}
                  @if (c.peorCaida !== '0') {
                    · peor caída <b class="c-danger">−{{ money(c.peorCaida) }}</b>
                  }
                </span>
                @if (bajaDeBots(); as b) {
                  <ui-notice tone="warn" icon="information-circle-outline">
                    Desde {{ ago(b.en) }} suman {{ b.a }} bots y no {{ b.de }}: uno se borró o dejó
                    de escribir. El pasado no se reescribe.
                  </ui-notice>
                }
              } @else {
                <span class="pf-foot">
                  Sin puntos en esta ventana: la cartera escribe una fila cada cinco minutos
                  mientras haya bots reales vivos.
                </span>
              }
            </div>
          }
        </ui-card>

        <div class="stats">
          <ui-card tone="inset">
            <ui-stat size="lg" label="Capital asignado" [value]="money(deployed())" />
          </ui-card>
          <ui-card tone="inset">
            <ui-stat size="lg" label="Bots activos" [value]="live()" />
          </ui-card>
          <ui-card tone="inset">
            <ui-stat size="lg" label="Órdenes vivas" [value]="openOrders()" />
          </ui-card>
          <!-- Exposición y capital son dos preguntas distintas, y las dos se
               quieren contestar: cuánto puse, y cuánto hay abierto en el mercado. -->
          <ui-card tone="inset">
            <ui-stat size="lg" label="Exposición" [value]="money(exposure())" />
          </ui-card>
        </div>

        <!-- Consumo del unico tope que se puede medir aqui con exactitud: el
             numerador de los bots a la vez es el mismo que usa el servidor. El
             de exposicion total no se pinta a proposito: la nota de
             CapitalSnapshot.limits dice que ese consumo no se recalcula en la
             app para que no pueda discrepar del 403, y llegara con su endpoint. -->
        @if (limits()?.max_open_bots; as tope) {
          <ui-card class="gauge">
            <div class="grow">
              <span class="k">Bots a la vez</span>
              <b class="num">{{ live() }} de {{ tope }}</b>
            </div>
            <ui-meter
              [segments]="[{ value: live(), tone: 'brand' }]"
              [total]="tope"
              label="Bots activos sobre tu tope"
            />
          </ui-card>
        }

        <!-- Cuatro bots pueden parecer diversificados y ser cuatro veces BTC.
             Una sola tonalidad y la identidad en la etiqueta: cinco colores
             categoricos en un movil no se distinguen. -->
        @if (reparto().length > 1) {
          <ui-section title="Dónde está el dinero" />
          <ui-card class="alloc">
            @for (r of reparto(); track r.symbol) {
              <div class="r">
                <span class="sym">{{ r.symbol }}</span>
                <!-- Umbrales por encima de 1: un reparto no es un consumo y no
                     tiene semaforo. -->
                <ui-meter
                  [segments]="[{ value: r.pct, tone: 'brand' }]"
                  [total]="100"
                  [warnAt]="2"
                  [dangerAt]="2"
                  [label]="r.symbol + ': ' + money(r.pct, 0) + ' % de la exposición'"
                />
                <span class="pc num">{{ money(r.pct, 0) }} %</span>
              </div>
            }
            @if (concentracion(); as c) {
              <p class="warn">{{ c }}</p>
            }
          </ui-card>
        }

        @if (withPosition().length) {
          <ui-section title="Posiciones abiertas">
            <ui-badge size="sm" tone="brand" class="num">{{ withPosition().length }}</ui-badge>
          </ui-section>

          <div class="positions">
            @for (b of withPosition(); track b.id) {
              <ui-card class="pos" [routerLink]="['/bots', b.id]">
                <div class="line">
                  <div class="sym">
                    <h3>{{ b.symbol }}</h3>
                    <p class="meta">{{ venueLabel(b.venue) }} · {{ b.name }}</p>
                  </div>
                  <!-- LONG en verde y SHORT en rojo, igual que el resultado: es
                       la misma pregunta —hacia donde apuesta este bot— y merece
                       el mismo codigo de color. -->
                  <ui-badge [tone]="b.direction === 'SHORT' ? 'down' : 'up'" size="sm">
                    {{ b.direction }} {{ b.leverage }}×
                  </ui-badge>
                </div>

                @let puntos = puntosDeSpark(b.spark);
                @if (puntos.length > 1) {
                  <ui-spark
                    mode="line"
                    [points]="puntos"
                    [baseline]="0"
                    [height]="26"
                    [label]="'Resultado de las últimas 24 h de ' + b.name"
                  />
                }

                <div class="row">
                  <span class="qty num"
                    >{{ qty(b.positionQty) }} &#64; {{ price(b.averageEntry) }}</span
                  >
                  <span class="num" [class]="'c-' + pnlColor(b.unrealizedPnl)">
                    {{ signed(b.unrealizedPnl) }}
                  </span>
                </div>

                @if (b.liquidationDistancePct !== null) {
                  <div class="liq" [class.hot]="near(b)">
                    @if (near(b)) {
                      <ion-icon name="warning-outline" />
                    }
                    <ui-liq-meter [pct]="b.liquidationDistancePct" />
                  </div>
                  <p class="liqp num">Liquidación en {{ price(b.liquidationPrice) }}</p>
                }
              </ui-card>
            }
          </div>
        } @else {
          <ui-empty-state
            [title]="testnet() ? 'Sin posiciones en testnet' : 'Sin posiciones abiertas'"
          >
            <p>
              @if (testnet()) {
                Esta pantalla suma solo lo de <b>testnet</b>. Tu cartera real sigue intacta: apaga
                el interruptor de testnet en Cuenta para verla.
              } @else {
                Ningún bot tiene posición ahora mismo. Cuando alguno entre al mercado, aparecerá
                aquí con su resultado en vivo.
              }
            </p>
          </ui-empty-state>
        }

        <!-- La SIMULACION, al final y con su propio total. Nunca sumada a lo de
             arriba: es dinero que no existe, y juntarlas seria mentir en la
             pantalla donde menos se puede. -->
        @if (simulados().length) {
          <ui-section title="Simulación">
            <ui-badge size="sm" tone="warn" caps>no es dinero real</ui-badge>
          </ui-section>

          <ui-card tone="inset" class="simhero">
            <span class="k">Resultado simulado</span>
            <span class="v num" [class]="'c-' + pnlColor(simPnl())">{{ signed(simPnl()) }}</span>
            <span class="sub">{{ simLive() }} bot(s) simulados en marcha</span>
          </ui-card>

          <div class="positions">
            @for (b of simWithPosition(); track b.id) {
              <ui-card class="pos" [routerLink]="['/bots', b.id]">
                <div class="line">
                  <div class="sym">
                    <h3>{{ b.symbol }}</h3>
                    <p class="meta">{{ venueLabel(b.venue) }} · {{ b.name }}</p>
                  </div>
                  <ui-badge [tone]="b.direction === 'SHORT' ? 'down' : 'up'" size="sm">
                    {{ b.direction }} {{ b.leverage }}×
                  </ui-badge>
                </div>

                @let puntos = puntosDeSpark(b.spark);
                @if (puntos.length > 1) {
                  <ui-spark
                    mode="line"
                    [points]="puntos"
                    [baseline]="0"
                    [height]="26"
                    [label]="'Resultado de las últimas 24 h de ' + b.name"
                  />
                }

                <div class="row">
                  <span class="qty num"
                    >{{ qty(b.positionQty) }} &#64; {{ price(b.averageEntry) }}</span
                  >
                  <span class="num" [class]="'c-' + pnlColor(b.unrealizedPnl)">
                    {{ signed(b.unrealizedPnl) }}
                  </span>
                </div>

                @if (b.liquidationDistancePct !== null) {
                  <div class="liq" [class.hot]="near(b)">
                    @if (near(b)) {
                      <ion-icon name="warning-outline" />
                    }
                    <ui-liq-meter [pct]="b.liquidationDistancePct" />
                  </div>
                  <p class="liqp num">Liquidación en {{ price(b.liquidationPrice) }}</p>
                }
              </ui-card>
            }
          </div>
        }
      </div>
    </ion-content>
  `,
  styleUrl: './portfolio.page.scss',
})
export class PortfolioPage implements OnInit {
  private readonly bots = inject(BotsService);
  private readonly network = inject(NetworkService);
  /**
   * La red que se esta mirando. Los totales de arriba salen de `bots()`, que ya
   * viene filtrada, asi que esto solo sirve para DECIRLO: una cartera a cero sin
   * explicacion se lee como que ha desaparecido el dinero.
   */
  readonly testnet = this.network.testnet;
  private readonly stream = inject(StreamService);
  private readonly risk = inject(RiskService);
  /** Los topes del usuario. `null` mientras no se han leido; la pantalla se pinta igual. */
  readonly limits = this.risk.limits;

  readonly money = money;
  readonly ago = ago;
  readonly price = price;
  readonly qty = qty;
  readonly signed = signed;
  readonly pct = pct;
  readonly pnlColor = pnlColor;
  readonly venueLabel = venueLabel;
  readonly puntosDeSpark = puntosDeSpark;

  /**
   * La cartera de verdad y la de mentira, separadas.
   *
   * NO se suman, y esto es lo unico importante de esta pantalla: un bot sobre
   * una conexion de simulacion gana y pierde dinero que no existe, y meterlo en
   * el «Resultado total» convertiria la cifra que se mira primero al abrir la
   * app en una que no significa nada.
   */
  readonly reales = computed(() => this.bots.bots().filter((b) => !b.paper));
  readonly simulados = computed(() => this.bots.bots().filter((b) => b.paper));

  readonly realized = computed(() => this.sumPnl(this.reales(), 'realizedPnl'));
  readonly unrealized = computed(() => this.sumPnl(this.reales(), 'unrealizedPnl'));
  readonly totalPnl = computed(() => sumaExacta([this.realized(), this.unrealized()]));

  /** El mismo total, para los simulados. Vive en su propia tarjeta. */
  readonly simPnl = computed(() =>
    sumaExacta([
      this.sumPnl(this.simulados(), 'realizedPnl'),
      this.sumPnl(this.simulados(), 'unrealizedPnl'),
    ]),
  );
  readonly simLive = computed(() => this.simulados().filter((b) => this.isLive(b.status)).length);

  readonly live = computed(() => this.reales().filter((b) => this.isLive(b.status)).length);
  readonly openOrders = computed(() => this.reales().reduce((a, b) => a + b.openOrders, 0));
  /**
   * Posiciones abiertas ordenadas por RIESGO, no por fecha: el bot mas cerca de
   * liquidar va el primero, que es el que hay que mirar. Sin distancia (sin
   * apalancamiento efectivo) van al final.
   */
  readonly withPosition = computed(() =>
    this.reales()
      .filter((b) => !D(b.positionQty).isZero())
      .sort((a, b) => this.riesgo(a) - this.riesgo(b)),
  );

  /**
   * Reparto de la exposición por símbolo, con la aritmética en `shared`
   * (`repartoPorSimbolo`, con tests): la suma es exacta y el porcentaje de cada
   * parte es la coordenada de su barra.
   */
  private readonly repartoExposicion = computed(() =>
    repartoPorSimbolo(
      this.reales().map((b) => ({ symbol: b.symbol, qty: b.positionQty, price: b.averageEntry })),
    ),
  );
  readonly reparto = computed(() => this.repartoExposicion().partes);

  /** Aviso de concentracion: dos tercios en un solo par se mueven a la vez. */
  readonly concentracion = computed(() => {
    const top = this.reparto()[0];
    if (!top || top.pct < 60) return null;
    const bots = this.reales().filter(
      (b) => b.symbol === top.symbol && !D(b.positionQty).isZero(),
    ).length;
    return `${money(top.pct, 0)} % de la exposición en ${top.symbol}: ${bots > 1 ? `tus ${bots} bots sobre ese par se moverán a la vez` : 'un solo movimiento del par mueve casi toda la cartera'}.`;
  });

  /** Posiciones simuladas. Misma tarjeta que las reales, pero en su seccion. */
  readonly simWithPosition = computed(() =>
    this.simulados().filter((b) => !D(b.positionQty).isZero()),
  );

  /**
   * Capital asignado: lo que el usuario PUSO en los bots vivos. El de un bot
   * parado no está comprometido.
   *
   * Antes esta cifra sumaba `positionQty × averageEntry`, que es el nocional de
   * las posiciones abiertas, y la rotulaba «Capital asignado»: un bot vivo con
   * la escalera tendida y sin ejecutar contaba cero, y uno a 3× contaba el
   * triple de lo que su dueño puso. Son dos preguntas distintas y ahora son dos
   * cifras (spec 002, F-03).
   */
  readonly deployed = computed(() =>
    sumaExacta(
      this.reales()
        .filter((b) => this.isLive(b.status))
        .map((b) => b.totalInvestment),
    ),
  );

  /** Exposición: nocional de las posiciones abiertas de los bots reales. */
  readonly exposure = computed(() => this.repartoExposicion().total);

  // ── La curva del héroe (spec 003) ──────────────────────────────

  private readonly portfolio = inject(PortfolioService);
  readonly rangos = PORTFOLIO_RANGES;
  readonly rango = signal<PortfolioRange>('7d');
  /** La serie tal y como llegó; `null` hasta la primera respuesta. */
  readonly serie = signal<PortfolioEquitySeries | null>(null);
  /** Cuándo se pidió: la tabla cambia cada cinco minutos y no se pide más a menudo. */
  private curvaCargadaEn = 0;

  /**
   * «Resultado acumulado de la cartera», cero visible, huecos rotos con el
   * criterio compartido (`gapMsFor` con el cubo y la cadencia que declara la
   * respuesta). La aritmética es la de `vistaDeSerie`, con sus tests.
   */
  readonly curva = computed(() => {
    const s = this.serie();
    if (!s) return null;
    return vistaDeSerie(
      s.points.map((p) => ({ t: p.t, v: p.pnl })),
      { maxPuntos: SERIES_POINTS, gapMs: gapMsFor(s.bucketMs, s.cadenceMs) },
    );
  });

  /** Lo que la curva cubre DE VERDAD; la ventana pedida la dice el selector. */
  readonly cobertura = computed(() => {
    const ms = ventanaDe(this.curva());
    return ms > 0 ? uptime(Math.round(ms / 1000)) : '—';
  });

  /**
   * El último instante de la ventana en que un bot dejó de sumar: se borró o
   * lleva más de diez minutos sin escribir. El pasado materializado no se
   * reescribe (spec 003, R-4), así que en vez de disimular el escalón se dice.
   */
  readonly bajaDeBots = computed(() => {
    const p = this.serie()?.points ?? [];
    for (let i = p.length - 1; i > 0; i--) {
      if (p[i].bots < p[i - 1].bots) return { en: p[i].t, de: p[i - 1].bots, a: p[i].bots };
    }
    return null;
  });

  async setRango(r: PortfolioRange): Promise<void> {
    if (r === this.rango()) return;
    this.rango.set(r);
    await this.cargarCurva(true);
  }

  /**
   * Como mucho una vez por cadencia salvo que se fuerce (cambio de ventana o de
   * red, tirón de refresco). Si el usuario cambió de ventana mientras llegaba,
   * la respuesta es de otra y se descarta. Un fallo deja la curva anterior.
   */
  private async cargarCurva(forzar = false): Promise<void> {
    if (!forzar && Date.now() - this.curvaCargadaEn < PORTFOLIO_CADENCE_MS) return;
    const r = this.rango();
    const s = await this.portfolio.equity(r).catch((): PortfolioEquitySeries | null => null);
    if (this.rango() !== r || !s) return;
    this.serie.set(s);
    this.curvaCargadaEn = Date.now();
  }

  private isLive(status: string): boolean {
    return ['STARTING', 'RUNNING', 'PAUSED'].includes(status);
  }

  /** Distancia a liquidación como número para ordenar; infinito = no aplica. */
  private riesgo(b: BotSummary): number {
    return liqNum(b.liquidationDistancePct) ?? Number.POSITIVE_INFINITY;
  }

  /** Con `Decimal`, no con `Number`: es la cifra grande de la portada (invariante 1). */
  private sumPnl(bots: BotSummary[], field: 'realizedPnl' | 'unrealizedPnl'): string {
    return sumaExacta(bots.map((b) => b[field]));
  }

  constructor() {
    addIcons({ warningOutline, informationCircleOutline });
    // Atada al ciclo de vida: ver el mismo caso en `bots-list`. La curva se
    // refresca por el mismo camino, pero acotada a su cadencia.
    this.stream.stream.pipe(takeUntilDestroyed()).subscribe(() => {
      void this.bots.refresh();
      void this.cargarCurva();
    });
    // Cambiar de red cambia de libro: la curva se vuelve a pedir entera. El
    // efecto corre también al arrancar, así que es la primera carga.
    effect(() => {
      this.testnet();
      untracked(() => void this.cargarCurva(true));
    });
  }

  ngOnInit(): void {
    void this.bots.refresh();
    // Sin bloquear y tolerante a fallos: los topes solo alimentan un medidor.
    void this.risk.refresh().catch(() => undefined);
  }

  /**
   * Liquidación a menos del 10 % del precio de MERCADO. Por debajo de ahí la
   * línea deja de ser un dato y pasa a ser un aviso.
   *
   * El porcentaje lo calcula el servidor. Antes se medía aquí contra el precio
   * de entrada, que no se mueve con el mercado: un bot con la entrada lejos y el
   * precio pegado a la liquidación no se marcaba nunca (spec 002, F-02).
   */
  near(b: { liquidationDistancePct: string | null }): boolean {
    return liqTone(b.liquidationDistancePct) === 'danger';
  }

  async reload(event: CustomEvent): Promise<void> {
    await Promise.all([this.bots.refresh(), this.cargarCurva(true)]);
    void (event.target as HTMLIonRefresherElement).complete();
  }
}
