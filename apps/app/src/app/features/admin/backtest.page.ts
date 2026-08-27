import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { playOutline, trashOutline, warningOutline } from 'ionicons/icons';
import type { BacktestResult, BacktestSource, Candle, CandleInterval } from '@crypton/shared';
import { candleSpanMs } from '@crypton/shared';
import { BacktestsService, BotsService, ToastService, type BacktestSummary } from '../../core/services';
import { errorText, intervalLabel, money, pct, signed } from '../../core/utils';
import { PriceChartComponent, buildFillMarkers, type OverlayMarker } from '../../shared/chart';
import {
  UiBadgeComponent,
  UiCollapsibleComponent,
  UiEmptyStateComponent,
  UiNoticeComponent,
  UiStatComponent,
} from '../../shared/ui';

/** Atajos de rango. Son los periodos que de verdad se miran. */
const ATAJOS = [
  { label: '7 d', dias: 7 },
  { label: '30 d', dias: 30 },
  { label: '90 d', dias: 90 },
] as const;

/** El mismo tope que aplica el servidor. Se comprueba aquí para avisar ANTES. */
const MAX_BARS = 10_000;

@Component({
  selector: 'app-admin-backtest',
  standalone: true,
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonButton,
    IonIcon,
    IonContent,
    IonInput,
    IonSegment,
    IonSegmentButton,
    IonSelect,
    IonSelectOption,
    IonSpinner,
    PriceChartComponent,
    UiBadgeComponent,
    UiCollapsibleComponent,
    UiEmptyStateComponent,
    UiNoticeComponent,
    UiStatComponent,
  ],
  templateUrl: './backtest.page.html',
  styleUrl: './backtest.page.scss',
})
export class AdminBacktestPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  readonly backtests = inject(BacktestsService);
  readonly bots = inject(BotsService);

  readonly money = money;
  readonly pct = pct;
  readonly signed = signed;
  readonly intervalLabel = intervalLabel;
  readonly atajos = ATAJOS;

  readonly botId = signal('');
  readonly source = signal<BacktestSource>('BINANCE');
  readonly interval = signal<CandleInterval>('15m');
  readonly dias = signal(30);
  readonly symbolOverride = signal('');
  readonly startingBalance = signal('');
  readonly makerFeeRate = signal('0.0002');
  readonly takerFeeRate = signal('0.0005');
  readonly slippageRate = signal('0.0005');
  readonly spreadBps = signal(2);
  readonly barPath = signal<'NEAREST_FIRST' | 'PESSIMISTIC'>('NEAREST_FIRST');

  readonly running = signal(false);
  readonly result = signal<BacktestResult | null>(null);
  readonly error = signal<string | null>(null);
  readonly historial = signal<BacktestSummary[]>([]);

  /** Solo los simulados: es lo único que el servidor acepta. */
  readonly simulados = computed(() => this.bots.bots().filter((b) => b.dryRun));

  /** Los intervalos los dicta el SERVIDOR, por fuente. Aquí no hay tabla. */
  readonly intervalos = computed<CandleInterval[]>(() => {
    const s = this.backtests.sources()?.find((x) => x.id === this.source());
    return s?.intervals ?? [];
  });

  /**
   * Cuántas velas van a salir. Se enseña ANTES de mandar nada.
   *
   * Sin esto, el usuario descubre que se ha pasado del tope después de esperar,
   * y con un mensaje del servidor en lugar de con un número que ya tenía delante.
   */
  readonly barras = computed(() =>
    Math.floor((this.dias() * 86_400_000) / candleSpanMs(this.interval())),
  );
  readonly demasiadas = computed(() => this.barras() > MAX_BARS);

  readonly puedeLanzar = computed(
    () => !!this.botId() && !this.demasiadas() && this.barras() >= 10 && !this.running(),
  );

  // ── Derivados del resultado ────────────────────────────────────────────
  readonly velas = computed<Candle[]>(() => this.result()?.candles ?? []);

  /**
   * La curva de equity con forma de vela.
   *
   * `<app-price-chart>` en modo área solo lee `Number(c.c)`, así que un punto de
   * la curva entra tal cual. Es lo que permite reutilizar el componente del
   * gráfico sin tocarlo — y sin romper la regla de que `lightweight-charts` se
   * importa en un único fichero del proyecto.
   */
  readonly curvaEquity = computed<Candle[]>(() =>
    (this.result()?.equity ?? []).map((p) => ({
      t: p.t,
      o: p.equity,
      h: p.equity,
      l: p.equity,
      c: p.equity,
      v: null,
    })),
  );

  readonly curvaDrawdown = computed<Candle[]>(() =>
    (this.result()?.equity ?? []).map((p) => ({
      t: p.t,
      o: p.ddPct,
      h: p.ddPct,
      l: p.ddPct,
      c: p.ddPct,
      v: null,
    })),
  );

  /** Marcadores de compra y venta sobre el gráfico de precio. */
  readonly marcadores = computed<OverlayMarker[]>(() => {
    const r = this.result();
    if (!r) return [];
    return buildFillMarkers(
      r.fills.map((f) => ({
        executed_at: new Date(f.ts).toISOString(),
        side: f.side,
        price: f.price,
        qty: f.qty,
        order: { level_kind: f.levelKind ?? 'BASE', level_index: f.levelIndex ?? 0 },
      })) as never,
      { bucketMs: candleSpanMs(r.meta.interval), barsMs: r.candles.map((c) => c.t) },
    );
  });

  /** ¿Ha batido a comprar y mantener? Es la comparación que decide. */
  readonly bateBuyHold = computed(() => {
    const m = this.result()?.metrics;
    if (!m) return null;
    return Number(m.netPnlPct) > Number(m.buyAndHoldPct);
  });

  constructor() {
    addIcons({ playOutline, trashOutline, warningOutline });
  }

  /**
   * El enlace entrante va PRIMERO; lo que toca la red, dentro de un `try`.
   *
   * Antes esto era un `Promise.all` a pelo, y un rechazo de `loadSources()` se
   * llevaba por delante las tres líneas siguientes sin que lo viera nadie: el
   * signal `error` solo lo escribía `lanzar()`. La pantalla quedaba con los dos
   * segmentos SIN BOTONES —`sources()` se queda en `null` y tanto la plantilla
   * como `intervalos()` hacen `?? []`—, sin el bot que traía el enlace, sin
   * historial, y sin un solo aviso. El fallo no se descubría hasta pulsar
   * Ejecutar, y entonces salía como un error del `POST`, que no era el problema.
   *
   * Cada parte se recupera por separado a propósito: que no haya fuentes no es
   * motivo para perder el bot preseleccionado ni el historial, que son las dos
   * cosas que sí se pueden seguir enseñando.
   */
  async ngOnInit(): Promise<void> {
    // Se puede llegar desde el detalle de un bot con el id ya puesto. No pasa
    // por la red, así que se aplica antes de que nada pueda fallar.
    const desdeRuta = this.route.snapshot.queryParamMap.get('botId');
    if (desdeRuta) this.botId.set(desdeRuta);

    try {
      await Promise.all([this.backtests.loadSources(), this.bots.refresh()]);
    } catch (e) {
      this.error.set(errorText(e));
    }

    // Fuera del `try`: ya trae el suyo, y es accesorio.
    await this.cargarHistorial();
  }

  async cargarHistorial(): Promise<void> {
    try {
      this.historial.set(await this.backtests.list(this.botId() || undefined));
    } catch {
      // El historial es accesorio: que falle no debe tapar el formulario.
    }
  }

  async lanzar(): Promise<void> {
    if (!this.puedeLanzar()) return;
    this.running.set(true);
    this.error.set(null);
    try {
      const hasta = Date.now();
      const r = await this.backtests.run({
        botId: this.botId(),
        source: this.source(),
        interval: this.interval(),
        fromMs: hasta - this.dias() * 86_400_000,
        toMs: hasta,
        ...(this.symbolOverride() ? { symbolOverride: this.symbolOverride().toUpperCase() } : {}),
        ...(this.startingBalance() ? { startingBalance: this.startingBalance() } : {}),
        makerFeeRate: this.makerFeeRate(),
        takerFeeRate: this.takerFeeRate(),
        slippageRate: this.slippageRate(),
        spreadBps: this.spreadBps(),
        barPath: this.barPath(),
      });
      this.result.set(r);
      await this.cargarHistorial();
    } catch (e) {
      this.error.set(errorText(e));
      this.result.set(null);
    } finally {
      this.running.set(false);
    }
  }

  async borrar(id: string): Promise<void> {
    try {
      await this.backtests.remove(id);
      await this.cargarHistorial();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  fecha(ms: string | number): string {
    return new Date(Number(ms)).toLocaleDateString();
  }

  duracion(ms: number | null): string {
    if (!ms) return '—';
    const h = Math.floor(ms / 3_600_000);
    return h >= 24 ? `${Math.round(h / 24)} d` : `${h} h`;
  }
}
