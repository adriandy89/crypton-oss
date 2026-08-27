import { Component, OnInit, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
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
import { warningOutline } from 'ionicons/icons';
import { BotsService, NetworkService, StreamService } from '../../core/services';
import type { BotSummary } from '../../core/models';
import { money, pct, pnlColor, price, qty, signed, venueLabel } from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiEmptyStateComponent,
  UiSectionComponent,
  UiStatComponent,
} from '../../shared/ui';

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
          <ui-card tone="inset">
            <ui-stat size="lg" label="Con posición" [value]="withPosition().length" />
          </ui-card>
        </div>

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

                <div class="row">
                  <span class="qty num"
                    >{{ qty(b.positionQty) }} &#64; {{ price(b.averageEntry) }}</span
                  >
                  <span class="num" [class]="'c-' + pnlColor(b.unrealizedPnl)">
                    {{ signed(b.unrealizedPnl) }}
                  </span>
                </div>

                @if (b.liquidationPrice) {
                  <div class="liq" [class.hot]="near(b)">
                    @if (near(b)) {
                      <ion-icon name="warning-outline" />
                    }
                    <span class="num">Liquidación en {{ price(b.liquidationPrice) }}</span>
                  </div>
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

                <div class="row">
                  <span class="qty num"
                    >{{ qty(b.positionQty) }} &#64; {{ price(b.averageEntry) }}</span
                  >
                  <span class="num" [class]="'c-' + pnlColor(b.unrealizedPnl)">
                    {{ signed(b.unrealizedPnl) }}
                  </span>
                </div>

                @if (b.liquidationPrice) {
                  <div class="liq" [class.hot]="near(b)">
                    @if (near(b)) {
                      <ion-icon name="warning-outline" />
                    }
                    <span class="num">Liquidación en {{ price(b.liquidationPrice) }}</span>
                  </div>
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

  readonly money = money;
  readonly price = price;
  readonly qty = qty;
  readonly signed = signed;
  readonly pct = pct;
  readonly pnlColor = pnlColor;
  readonly venueLabel = venueLabel;

  /**
   * La cartera de verdad y la de mentira, separadas.
   *
   * NO se suman, y esto es lo unico importante de esta pantalla: un bot sobre
   * una conexion de simulacion gana y pierde dinero que no existe, y meterlo en
   * el «Resultado total» convertiria la cifra que se mira primero al abrir la
   * app en una que no significa nada.
   */
  private readonly reales = computed(() => this.bots.bots().filter((b) => !b.paper));
  readonly simulados = computed(() => this.bots.bots().filter((b) => b.paper));

  readonly realized = computed(() => this.sumPnl(this.reales(), 'realizedPnl'));
  readonly unrealized = computed(() => this.sumPnl(this.reales(), 'unrealizedPnl'));
  readonly totalPnl = computed(() => this.realized() + this.unrealized());

  /** El mismo total, para los simulados. Vive en su propia tarjeta. */
  readonly simPnl = computed(
    () =>
      this.sumPnl(this.simulados(), 'realizedPnl') + this.sumPnl(this.simulados(), 'unrealizedPnl'),
  );
  readonly simLive = computed(() => this.simulados().filter((b) => this.isLive(b.status)).length);

  readonly live = computed(() => this.reales().filter((b) => this.isLive(b.status)).length);
  readonly openOrders = computed(() => this.reales().reduce((a, b) => a + b.openOrders, 0));
  readonly withPosition = computed(() => this.reales().filter((b) => Number(b.positionQty) !== 0));

  /** Posiciones simuladas. Misma tarjeta que las reales, pero en su seccion. */
  readonly simWithPosition = computed(() =>
    this.simulados().filter((b) => Number(b.positionQty) !== 0),
  );

  /** Suma del capital de los bots vivos. El de un bot parado no está expuesto. */
  readonly deployed = computed(() =>
    this.reales()
      .filter((b) => this.isLive(b.status))
      .reduce((a, b) => a + Number(b.positionQty) * Number(b.averageEntry ?? 0), 0),
  );

  private isLive(status: string): boolean {
    return ['STARTING', 'RUNNING', 'PAUSED'].includes(status);
  }

  private sumPnl(bots: BotSummary[], field: 'realizedPnl' | 'unrealizedPnl'): number {
    return bots.reduce((a, b) => a + Number(b[field]), 0);
  }

  constructor() {
    addIcons({ warningOutline });
    // Atada al ciclo de vida: ver el mismo caso en `bots-list`.
    this.stream.stream.pipe(takeUntilDestroyed()).subscribe(() => void this.bots.refresh());
  }

  ngOnInit(): void {
    void this.bots.refresh();
  }

  /**
   * Liquidación a menos del 10 % del precio de entrada. Por debajo de ahí la
   * línea deja de ser un dato y pasa a ser un aviso.
   */
  near(b: { averageEntry: string | null; liquidationPrice: string | null }): boolean {
    const entry = Number(b.averageEntry ?? 0);
    const liq = Number(b.liquidationPrice ?? 0);
    if (!entry || !liq) return false;
    return (Math.abs(entry - liq) / entry) * 100 < 10;
  }

  async reload(event: CustomEvent): Promise<void> {
    await this.bots.refresh();
    void (event.target as HTMLIonRefresherElement).complete();
  }
}
