import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Clipboard } from '@capacitor/clipboard';
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
import {
  gitCompareOutline,
  openOutline,
  playOutline,
  trashOutline,
  warningOutline,
} from 'ionicons/icons';
import type {
  BacktestFillView,
  BacktestMeta,
  BacktestMetrics,
  BacktestResult,
  BacktestSource,
  Candle,
  CandleInterval,
} from '@crypton/shared';
import { aCsv, candleSpanMs } from '@crypton/shared';
import {
  BacktestsService,
  BotsService,
  ToastService,
  type BacktestFillRow,
  type BacktestRun,
  type BacktestSummary,
} from '../../core/services';
import { errorText, intervalLabel, money, pct, shortDate, signed } from '../../core/utils';
import {
  PriceChartComponent,
  buildFillMarkers,
  levelTitle,
  type OverlayMarker,
} from '../../shared/chart';
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

/** Operaciones que se pintan en la tabla; el CSV lleva todas las que llegaron. */
const MAX_OPERACIONES_EN_PANTALLA = 200;

/**
 * Las métricas que se comparan entre dos ejecuciones, en el orden en que se
 * leen: primero lo que decide, después el coste, después la actividad.
 */
const COMPARABLES: {
  label: string;
  valor: (m: BacktestMetrics) => string;
  numero: (m: BacktestMetrics) => number | null;
  sufijo: string;
}[] = [
  {
    label: 'Resultado neto',
    valor: (m) => signed(m.netPnlPct),
    numero: (m) => Number(m.netPnlPct),
    sufijo: ' %',
  },
  {
    label: 'Comprar y mantener',
    valor: (m) => signed(m.buyAndHoldPct),
    numero: (m) => Number(m.buyAndHoldPct),
    sufijo: ' %',
  },
  {
    label: 'Caída máxima',
    valor: (m) => '−' + m.maxDrawdownPct,
    numero: (m) => -Number(m.maxDrawdownPct),
    sufijo: ' %',
  },
  {
    label: 'Comisiones',
    valor: (m) => money(m.feesPaid),
    numero: (m) => -Number(m.feesPaid),
    sufijo: '',
  },
  {
    label: 'Ciclos cerrados',
    valor: (m) => String(m.cyclesClosed),
    numero: (m) => m.cyclesClosed,
    sufijo: '',
  },
  {
    label: 'Acierto',
    valor: (m) => (m.winRatePct === null ? '—' : m.winRatePct),
    numero: (m) => (m.winRatePct === null ? null : Number(m.winRatePct)),
    sufijo: ' %',
  },
  {
    label: 'Ejecuciones',
    valor: (m) => String(m.fills),
    numero: (m) => m.fills,
    sufijo: '',
  },
  {
    label: 'Liquidaciones',
    valor: (m) => String(m.liquidations),
    numero: (m) => -m.liquidations,
    sufijo: '',
  },
  {
    label: 'Tiempo en mercado',
    valor: (m) => m.timeInMarketPct,
    numero: (m) => Number(m.timeInMarketPct),
    sufijo: ' %',
  },
];

/**
 * Backtest sobre los bots simulados del usuario (spec 004).
 *
 * Nació como pantalla de administración. Se abre a todos —la pregunta que
 * contesta es la de quien decide si poner dinero— después de que el simulador
 * dejara de ejecutar el stop-loss en el acto (001/F-45), porque con eso dentro
 * el resultado mentía justo a quien configura stop. Y gana lo que le faltaba:
 * reabrir una ejecución guardada sin volver a correrla, la tabla de
 * operaciones y la comparación de dos ejecuciones lado a lado.
 */
@Component({
  selector: 'app-backtest',
  standalone: true,
  imports: [
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
export class BacktestPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  readonly backtests = inject(BacktestsService);
  readonly bots = inject(BotsService);

  readonly money = money;
  readonly pct = pct;
  readonly signed = signed;
  readonly intervalLabel = intervalLabel;
  readonly atajos = ATAJOS;

  // ── Formulario ──────────────────────────────────────────────────────────
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
  /** De dónde sale lo que se está viendo: recién lanzado, o guardado tal día. */
  readonly origen = signal<{ tipo: 'nueva' } | { tipo: 'guardada'; en: string } | null>(null);
  readonly error = signal<string | null>(null);
  readonly historial = signal<BacktestSummary[]>([]);
  /** Id de la ejecución guardada que se está descargando para reabrirla. */
  readonly abriendo = signal<string | null>(null);
  /** Las dos ejecuciones marcadas para comparar, en orden de marcado. */
  readonly seleccion = signal<string[]>([]);

  /** Solo los de simulación: el backtest reproduce una configuración, no una cuenta. */
  readonly simulados = computed(() => this.bots.bots().filter((b) => b.dryRun));

  readonly intervalos = computed<CandleInterval[]>(() => {
    const s = this.backtests.sources()?.find((x) => x.id === this.source());
    return s?.intervals ?? [];
  });

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
   * Las dos curvas se pintan como área con `price-chart`: un punto por vela
   * disfrazado de vela plana. Es el «disfraz» que el 002 dejó escrito y que
   * aquí sigue siendo lo correcto: es el gráfico con eje de tiempo manipulable.
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

  /** La comparación que de verdad decide: un +8 % en un mercado que subió un 40 % no es bueno. */
  readonly bateBuyHold = computed(() => {
    const m = this.result()?.metrics;
    if (!m) return null;
    return Number(m.netPnlPct) > Number(m.buyAndHoldPct);
  });

  /** Las últimas operaciones, de la más reciente a la más antigua. El CSV lleva todas. */
  readonly operaciones = computed(() =>
    [...(this.result()?.fills ?? [])].reverse().slice(0, MAX_OPERACIONES_EN_PANTALLA),
  );

  /** Las dos ejecuciones marcadas, lado a lado, con la diferencia. */
  readonly comparacion = computed(() => {
    const [ia, ib] = this.seleccion();
    const a = this.historial().find((h) => h.id === ia);
    const b = this.historial().find((h) => h.id === ib);
    if (!a || !b) return null;
    return {
      a,
      b,
      filas: COMPARABLES.map((c) => {
        const na = c.numero(a.metrics);
        const nb = c.numero(b.metrics);
        // La diferencia va en el sentido «cuánto mejor es B»: las métricas en
        // las que menos es mejor (caída, comisiones, liquidaciones) ya vienen
        // con el signo cambiado en `numero`.
        const mejorB = na !== null && nb !== null ? nb - na : null;
        return {
          label: c.label,
          a: c.valor(a.metrics) + c.sufijo,
          b: c.valor(b.metrics) + c.sufijo,
          tono: mejorB === null || mejorB === 0 ? '' : mejorB > 0 ? 'ok' : 'mal',
        };
      }),
    };
  });

  constructor() {
    addIcons({ playOutline, trashOutline, warningOutline, openOutline, gitCompareOutline });
  }

  /**
   * Arranque en tres partes, cada una tolerante a que las otras fallen.
   *
   * Antes un fallo al pedir las fuentes tiraba el formulario entero: sin
   * fuentes no había intervalos, sin intervalos no se podía lanzar, y sin un
   * solo aviso. Cada parte se recupera por separado: que no haya fuentes no es
   * motivo para perder el bot preseleccionado ni el historial.
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
      this.origen.set({ tipo: 'nueva' });
      await this.cargarHistorial();
    } catch (e) {
      this.error.set(errorText(e));
      this.result.set(null);
      this.origen.set(null);
    } finally {
      this.running.set(false);
    }
  }

  /**
   * Reabre una ejecución guardada SIN volver a correrla (spec 004, R-4).
   *
   * `GET /backtests/:id` trae la fila entera —métricas, curva, velas, avisos—
   * y las ejecuciones van en su tabla aparte. Se recompone el mismo
   * `BacktestResult` que devuelve `run()`, así que las curvas y los marcadores
   * son exactamente los de cuando se lanzó.
   */
  async abrir(h: BacktestSummary): Promise<void> {
    if (this.abriendo()) return;
    this.abriendo.set(h.id);
    this.error.set(null);
    try {
      const [run, fills] = await Promise.all([
        this.backtests.detail(h.id),
        this.backtests.fills(h.id),
      ]);
      const botName = this.bots.bots().find((b) => b.id === run.bot_id)?.name ?? null;
      this.result.set(resultadoDeGuardado(run, fills, botName));
      this.origen.set({ tipo: 'guardada', en: shortDate(run.created_at) });
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.abriendo.set(null);
    }
  }

  /** Marca o desmarca para comparar. Dos como mucho: la tercera sustituye a la más antigua. */
  alternarComparar(id: string): void {
    this.seleccion.update((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id],
    );
  }

  quitarComparacion(): void {
    this.seleccion.set([]);
  }

  async borrar(id: string): Promise<void> {
    try {
      await this.backtests.remove(id);
      this.seleccion.update((s) => s.filter((x) => x !== id));
      await this.cargarHistorial();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  /** Todas las operaciones que llegaron, no solo las de la tabla, como CSV al portapapeles. */
  async copiarOperaciones(): Promise<void> {
    const r = this.result();
    if (!r) return;
    try {
      await Clipboard.write({
        string: aCsv(
          r.fills.map((f) => ({
            fecha: new Date(f.ts).toISOString(),
            lado: f.side,
            nivel: this.nivel(f),
            ciclo: f.cycleSeq,
            precio: f.price,
            cantidad: f.qty,
            comision: f.fee,
            rol: f.isTaker ? 'taker' : 'maker',
            posicion_despues: f.positionAfter,
            realizado_acumulado: f.realizedAccAfter,
            liquidacion: f.liquidation,
          })),
        ),
      });
      await this.toast.success(
        `CSV de ${r.fills.length} operaciones copiado. Los importes van con punto decimal.`,
      );
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  nivel(f: BacktestFillView): string {
    if (f.liquidation) return 'Liquidación';
    if (!f.levelKind || f.levelKind === 'LIQUIDATION') return '—';
    return levelTitle({ level_kind: f.levelKind, level_index: f.levelIndex ?? 0 });
  }

  fecha(ms: string | number): string {
    return new Date(Number(ms)).toLocaleDateString();
  }

  fechaHora(ms: number): string {
    return shortDate(new Date(ms));
  }

  duracion(ms: number | null): string {
    if (!ms) return '—';
    const h = Math.floor(ms / 3_600_000);
    return h >= 24 ? `${Math.round(h / 24)} d` : `${h} h`;
  }
}

/**
 * De la fila guardada al resultado que la pantalla sabe pintar.
 *
 * Las columnas JSON vuelven con la forma con la que se guardaron; los `BigInt`
 * llegan como texto y las ejecuciones, de su tabla. Los ciclos no se persisten
 * y la pantalla no los pinta, así que vuelven vacíos. Los casts son la frontera
 * Prisma-JSON: el servidor los escribió con estos tipos.
 */
function resultadoDeGuardado(
  run: BacktestRun,
  fills: BacktestFillRow[],
  botName: string | null,
): BacktestResult {
  const meta: BacktestMeta = {
    botId: run.bot_id,
    botName,
    strategy: run.strategy as BacktestMeta['strategy'],
    venue: run.venue as BacktestMeta['venue'],
    symbol: run.symbol,
    configVersion: run.config_version,
    source: run.source,
    sourceSymbol: run.source_symbol,
    marketType: run.market_type as BacktestMeta['marketType'],
    interval: run.interval,
    fromMs: Number(run.from_ms),
    toMs: Number(run.to_ms),
    generatedAt: Date.parse(run.created_at),
    durationMs: run.duration_ms,
  };
  return {
    meta,
    params: run.params,
    metrics: run.metrics,
    equity: run.equity_curve,
    candles: run.candles,
    fills: fills.map((f): BacktestFillView => ({
      ts: Number(f.ts),
      side: f.side,
      price: f.price,
      qty: f.qty,
      fee: f.fee,
      isTaker: f.is_taker,
      levelKind: f.liquidation ? 'LIQUIDATION' : (f.level_kind as BacktestFillView['levelKind']),
      levelIndex: f.level_index,
      cycleSeq: f.cycle_seq,
      positionAfter: f.position_after,
      realizedAccAfter: f.realized_acc_after,
      liquidation: f.liquidation,
    })),
    fillsTruncated: run.fills_total > fills.length,
    cycles: [],
    warnings: run.warnings,
  };
}
