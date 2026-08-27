import {
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, throttleTime } from 'rxjs';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonModal,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  chevronBackOutline,
  closeOutline,
  ellipsisVertical,
  optionsOutline,
  star,
  starOutline,
  warningOutline,
} from 'ionicons/icons';
import {
  BotsService,
  MarketDataService,
  MarketsService,
  NetworkService,
  StreamService,
  ToastService,
} from '../../core/services';
import {
  INTERVAL_MS,
  applyHistoryPage,
  candleSpanMs,
  historyStateOf,
  nextHistoryRequest,
} from '@crypton/shared';
import type {
  BotDetail,
  BotFill,
  BotLevel,
  BotSummary,
  Candle,
  CandleInterval,
  Market,
  Venue,
} from '../../core/models';
import {
  compact,
  errorText,
  intervalLabel,
  money,
  pct,
  price,
  qty,
  signed,
  strategyLabel,
  venueLabel,
} from '../../core/utils';
import {
  PriceChartComponent,
  buildBotOverlay,
  buildFillMarkers,
  type ChartSeriesKind,
  type OverlayLine,
  type OverlayMarker,
} from '../../shared/chart';
import {
  UiBadgeComponent,
  UiNoticeComponent,
  UiStatComponent,
  UiStatusPillComponent,
} from '../../shared/ui';
import { FavouriteMarketsService } from './favourites.service';

/** Cuántas velas se piden. 300 llena una pantalla ancha con holgura. */
const BARS = 300;

/**
 * Tamaño de cada página de histórico. El MISMO escalón que `BARS`, a propósito.
 *
 * La API cuantiza `limit` al siguiente escalón de `[2,50,150,300,600,1000,1500]`
 * y ese valor entra en su clave de Redis, así que pedir 300 hace que la página 2
 * de un usuario comparta entrada con la de otro — y con una ventana cerrada
 * cacheada una hora, compartir es lo que de verdad ahorra llamadas al DEX.
 *
 * No se sube a 600 por dos motivos: Lighter sirve **500 velas como máximo**, así
 * que a 600 devolvería una página corta que el cliente leería como el final del
 * histórico; y aunque 600 sea más barato por barra, 300 lo es por GESTO, y lo
 * que ocurre son gestos.
 */
const HISTORY_PAGE_BARS = 300;

/**
 * Techo de barras en memoria.
 *
 * Por debajo del muro de 5000 velas de Hyperliquid, así que quien topa primero
 * es el venue y no nosotros. Unas 3000 velas con sus estructuras internas y la
 * serie de volumen rondan 1 MB por gráfico abierto, que en un móvil está bien;
 * 10 000 no lo estaría.
 */
const MAX_HISTORY_BARS = 3000;

/**
 * Reserva por si el servidor no dice los topes de paginación.
 *
 * Los de verdad vienen por venue en `/market-data/capabilities`, porque el
 * presupuesto de caudal no se parece en nada entre ellos: Hyperliquid cuenta
 * peso y Lighter cuenta PETICIONES —60 por minuto—, así que una constante única
 * en el cliente o ahogaba a Lighter o desperdiciaba a Hyperliquid. Estos valores
 * son los conservadores, para el caso en que las capacidades no hayan llegado.
 */
const HISTORY_FALLBACK = { maxHistoryPages: 3, minPageGapMs: 1500 };

/**
 * Cada cuánto se relee la vela viva en los venues SIN stream de velas.
 *
 * Solo corrige el volumen, que es lo único que un tick de precio no puede
 * traer; el precio ya llega en vivo. Antes esto era el mecanismo de
 * actualización entero y corría cada cinco segundos.
 */
const RECONCILE_MS = 30_000;

/**
 * Ventana de agrupación de los eventos del bot.
 *
 * El evento `FILL` del servidor no trae el precio ni la cantidad como campos
 * —solo dentro de su mensaje de texto—, así que la única forma correcta de
 * pintar una ejecución nueva es volver a pedir el detalle y el ledger. Y un
 * market maker ejecuta a ráfagas: sin esta ventana, cada fill de una ráfaga
 * dispararía su propia tanda de peticiones.
 *
 * Se agrupa con `throttleTime` y NO con `debounceTime`: con rebote, una ráfaga
 * continua reinicia la espera en cada evento y el gráfico no se refrescaría
 * nunca. Con `leading` hay refresco inmediato en el primer evento —que es el
 * que el usuario está mirando— y con `trailing` queda garantizado otro al
 * cerrar la ventana, que recoge todo lo que pasó dentro.
 */
const BOT_COALESCE_MS = 1_500;

/**
 * Cuántas ejecuciones se leen para pintar los marcadores.
 *
 * El ledger llega de la MÁS RECIENTE a la más antigua, así que estas son las
 * últimas: es el subconjunto correcto para un gráfico, pero es fácil suponer lo
 * contrario. El tope de la API es 500.
 */
const FILL_LIMIT = 200;

/**
 * Cuántas velas de una hora se leen para el máximo y el mínimo del día.
 *
 * Se piden 50 y no 24 porque la API cuantiza el `limit` al siguiente escalón:
 * pedir 24 traería 50 igualmente, pero con una clave de caché que no comparte
 * con nadie. El recorte a 24 h se hace por marca de tiempo, no por número de
 * barras.
 */
const RANGE_BARS = 50;

@Component({
  selector: 'app-market-chart',
  standalone: true,
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonBackButton,
    IonIcon,
    IonContent,
    IonModal,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
    PriceChartComponent,
    UiBadgeComponent,
    UiNoticeComponent,
    UiStatComponent,
    UiStatusPillComponent,
  ],
  templateUrl: './chart.page.html',
  styleUrl: './chart.page.scss',
})
export class MarketChartPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly markets = inject(MarketsService);
  private readonly botsSvc = inject(BotsService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly streamSvc = inject(StreamService);
  readonly data = inject(MarketDataService);
  readonly favourites = inject(FavouriteMarketsService);
  readonly network = inject(NetworkService);

  readonly venue = signal<Venue>('HYPERLIQUID');
  readonly symbol = signal('');
  readonly interval = signal<CandleInterval>('1h');
  readonly kind = signal<ChartSeriesKind>('candles');
  readonly showVolume = signal(true);

  readonly candles = signal<Candle[]>([]);
  readonly market = signal<Market | null>(null);
  readonly loading = signal(true);
  readonly chartError = signal<string | null>(null);
  readonly tab = signal<'info' | 'bots' | 'venues'>('info');

  /** El bot desde el que se ha entrado, si se ha entrado desde uno. */
  readonly bot = signal<BotDetail | null>(null);
  readonly layers = signal({ ladder: true, planned: true, fills: true, liquidation: true });

  /** La escalera DESEADA del ciclo vivo, cruda. Ver `overlay`. */
  readonly overlayLevels = signal<BotLevel[]>([]);

  /**
   * La capa del bot, DERIVADA y no fijada al cargar.
   *
   * Depende de los decimales del mercado, y esos llegan en `loadMarket()`, que
   * corre en la misma tanda que `loadBot()`. Fijando las lineas al cargar el bot
   * se colaba una carrera de las malas: si el detalle llegaba antes que la spec,
   * la capa se construia con la precision de reserva —dos decimales— y en un par
   * que cotiza a 0,00004182 el colapso por precio fundia la escalera ENTERA en
   * una sola linea, porque todos los niveles redondean a «0.00». Y no se volvia
   * a construir al llegar la spec.
   *
   * Derivandola, el orden de llegada deja de importar.
   */
  private readonly overlay = computed(() =>
    this.bot()
      ? buildBotOverlay(this.bot()!, this.overlayLevels(), {
          // `price_decimals` del mercado, o nada. Nada NO es «dos»: sin spec se
          // comparan los precios tal cual, que se pierde los empates a nivel de
          // tick pero no funde niveles que estan de verdad separados.
          priceDecimals: this.market()?.price_decimals ?? null,
        })
      : null,
  );

  readonly overlayLines = computed<OverlayLine[]>(() => this.overlay()?.lines ?? []);
  readonly overlaySpan = computed(() => this.overlay()?.span ?? null);

  /**
   * Ordenes vivas que no se han podido situar en el grafico.
   *
   * Se dice en la leyenda. Un cero silencioso donde deberia haber una orden es
   * la clase de omision que hace creer que el bot no tiene nada puesto.
   */
  readonly overlaySkipped = computed(() => this.overlay()?.skipped ?? 0);

  /**
   * El ledger CRUDO, sin agrupar.
   *
   * Los marcadores se derivan de aqui y no se fijan al cargar porque la
   * agrupacion depende del intervalo que se este mirando: al pasar de 1 h a
   * 1 min los mismos fills tienen que repartirse en otros cubos. Fijandolos, el
   * grafico se quedaba con la agrupacion vieja y el error no se veia.
   */
  readonly overlayFills = signal<BotFill[]>([]);

  /** El ledger llegó al tope: hay ejecuciones anteriores que no se pintan. */
  readonly fillsTruncated = signal(false);

  readonly overlayMarkers = computed<OverlayMarker[]>(() =>
    buildFillMarkers(this.overlayFills(), {
      bucketMs: candleSpanMs(this.interval()),
      // Las velas ya cargadas mandan sobre la aritmetica: ver `bucketOf`.
      barsMs: this.candles().map((c) => c.t),
    }),
  );

  /**
   * Por qué no hay escalera pintada.
   *
   * Sin esto, un fallo al pedir el detalle dejaba la pantalla EXACTAMENTE igual
   * que un mercado sin bot: ni líneas, ni banda del bot, ni nada que lo
   * dijera. El único aviso era un toast de tres segundos, y quien llegara medio
   * segundo tarde leía «este bot no tiene órdenes».
   */
  readonly botError = signal<string | null>(null);

  /**
   * El bot que se está mirando. Campo y no variable local de `ngOnInit` porque
   * ahora hay que recargarlo desde el flujo de eventos y desde la reconexión.
   */
  private botId: string | null = null;

  /**
   * Contador de cargas del bot, para descartar respuestas que llegan tarde.
   *
   * Con el refresco por eventos hay varias cargas en vuelo a la vez, y la red
   * no garantiza el orden: sin esta guarda, una respuesta lenta de hace tres
   * segundos puede pisar a la que acaba de llegar y devolver la escalera vieja.
   */
  private botSeq = 0;

  /** El flujo se cayó con un bot atado: al volver hay que releerlo. */
  private botPerdido = false;

  readonly money = money;
  readonly price = price;
  readonly qty = qty;
  readonly pct = pct;
  readonly signed = signed;
  readonly compact = compact;
  readonly intervalLabel = intervalLabel;
  readonly venueLabel = venueLabel;
  readonly strategyLabel = strategyLabel;

  /**
   * Los valores bajo la cruceta.
   *
   * Se leen del hijo con `viewChild` y no con una variable de plantilla porque
   * el grafico vive dentro de un `@else`: una referencia declarada ahi solo
   * existe dentro de ese bloque, y la leyenda se pinta fuera.
   */
  private readonly chartRef = viewChild(PriceChartComponent);
  readonly readout = computed(() => this.chartRef()?.readout() ?? null);

  /** La escala de precios la ha puesto el usuario a mano. Ver `scaleKey`. */
  readonly chartScaled = computed(() => this.chartRef()?.userScaled() ?? false);

  /**
   * Identidad de lo que se está mirando, para el gráfico.
   *
   * Cuando cambia, el gráfico suelta el ajuste manual de la escala: un rango de
   * precios de ETH no significa nada en BTC, ni el de 1 h en 1 min. Se compone
   * aquí —y no se llama a `resetScale()` desde `changeInterval()`— porque hay
   * cinco caminos que cambian lo que se ve, y cuatro de ellos son fáciles de
   * olvidar: saltar de plataforma (`openMarket`), conmutar la lente de red, la
   * recarga tras una reconexión y la entrada desde un bot.
   */
  readonly scaleKey = computed(
    () =>
      `${this.venue()}|${this.symbol()}|${this.interval()}|${this.network.testnet()}|${this.bot()?.id ?? ''}`,
  );

  /**
   * Identidad de la SERIE. Deliberadamente sin el bot, al revés que `scaleKey`.
   *
   * Cambiar de bot no invalida un histórico de velas —es el mismo par y el mismo
   * intervalo—, mientras que cambiar cualquiera de estas cuatro sí. Un único
   * efecto vigila esta clave y reinicia la paginación; repartir esos reinicios
   * entre `changeInterval` y el efecto de la red sería exactamente el descuido
   * contra el que ya avisa el comentario de `scaleKey`: hay más caminos de los
   * que uno recuerda.
   */
  private readonly historyKey = computed(
    () => `${this.venue()}|${this.symbol()}|${this.interval()}|${this.network.testnet()}`,
  );

  /** Hay una página de histórico en vuelo. */
  readonly loadingHistory = signal(false);
  /** El venue se quedó sin pasado que dar. */
  readonly noMoreHistory = signal(false);
  /** Se alcanzó NUESTRO techo. Es otra cosa que `noMoreHistory`, y otro texto. */
  readonly historyCapped = signal(false);

  /** Páginas aceptadas y momento de la última, para el espaciado mínimo. */
  private historyPages = 0;
  private historyAt = 0;

  /** Vuelve al encuadre automático. Lo ofrece también la hoja de ajustes. */
  resetChartScale(): void {
    this.chartRef()?.resetScale();
  }

  /**
   * La vela EN FORMACION, aparte de la serie.
   *
   * Va suelta y no dentro de `candles` a propósito: la serie se pinta con
   * `setData()` —hasta 600 barras, más el reajuste de escala— y esto se aplica
   * con `series.update()`, que toca solo la última. Meterla dentro habría sido
   * más corto de escribir y habría rehecho el gráfico entero varias veces por
   * segundo.
   */
  readonly liveBar = signal<Candle | null>(null);

  /**
   * Máximo y mínimo de 24 h CALCULADOS, para los venues que no los publican.
   *
   * Hyperliquid no los da en `metaAndAssetCtxs` —el adaptador lo documenta— y
   * la cabecera enseñaba dos guiones donde Aster enseña cifras. Se leen una
   * sola vez al abrir, de 24 velas de una hora.
   */
  readonly derivedRange = signal<{ high: string; low: string } | null>(null);

  /**
   * ¿Se ha ido el flujo desde que se cargó la serie?
   *
   * Mientras está caído no llega ninguna vela, y las que se cierren durante ese
   * rato no las manda nadie después: pub/sub no guarda nada. Sin esto, un corte
   * de dos minutos en un gráfico de 1m dejaba dos barras que NO existían para
   * la pantalla —ni entonces ni nunca—, y en un móvil la conexión se pierde
   * constantemente.
   */
  private perdido = false;

  private refresh: ReturnType<typeof setInterval> | null = null;
  /**
   * ¿Sigue la pantalla a la vista?
   *
   * No es una señal a proposito: la lee el efecto de segundo plano y ahi hace
   * falta que NO se rastree. Lo que dispara ese efecto es la app yendose al
   * fondo, no que se entre o se salga de esta pantalla —de eso ya se encargan
   * los hooks de Ionic—.
   */
  private visible = false;

  // ═══════════════════════════════════════════════════════════════
  // Derivados
  // ═══════════════════════════════════════════════════════════════

  readonly favKey = computed(() =>
    this.favourites.keyOf(this.venue(), this.symbol(), this.network.testnet()),
  );
  readonly isFavourite = computed(() => this.favourites.has(this.favKey()));
  readonly decimals = computed(() => this.market()?.price_decimals ?? 2);
  /**
   * El ticker del par, con el máximo y el mínimo del día ya rellenados.
   *
   * La condición es `high24h == null`, no «si es Hyperliquid»: el día que el
   * venue empiece a publicarlos, esto se apaga solo y la cabecera pasa a usar
   * los suyos sin tocar una línea.
   */
  readonly ticker = computed(() => {
    const t = this.data.tickerOf(this.venue(), this.symbol());
    const rango = this.derivedRange();
    if (!t || !rango || (t.high24h !== null && t.low24h !== null)) return t;
    return { ...t, high24h: t.high24h ?? rango.high, low24h: t.low24h ?? rango.low };
  });

  /**
   * Los intervalos que SIRVE esta plataforma, tal y como los declara la API.
   *
   * No hay ninguna lista escrita en la app: si mañana Lighter publica velas de
   * 3 minutos, aparecen aquí sin tocar una línea de este fichero.
   */
  readonly intervals = computed(() => this.data.intervalsOf(this.venue()));

  /** Los seis primeros caben en la barra; el resto vive en el menú. */
  readonly quickIntervals = computed(() => {
    const all = this.intervals();
    const preferred: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
    const quick = preferred.filter((i) => all.includes(i));
    // Si la plataforma no sirve alguno de los preferidos, se rellena con los
    // suyos: la barra nunca sale con huecos.
    for (const i of all) {
      if (quick.length >= 6) break;
      if (!quick.includes(i)) quick.push(i);
    }
    const current = this.interval();
    if (!quick.includes(current) && all.includes(current)) quick[quick.length - 1] = current;
    return quick;
  });

  readonly bots = computed(() =>
    this.botsSvc.bots().filter((b) => b.venue === this.venue() && b.symbol === this.symbol()),
  );

  /** El mismo activo en las otras plataformas, para comparar precio. */
  readonly elsewhere = computed(() => {
    const m = this.market();
    if (!m) return [];
    return this.data.sameBase(m.base, { venue: this.venue(), symbol: this.symbol() });
  });

  /** Distancia del precio a la liquidación del bot. LA métrica de riesgo. */
  readonly liqDistance = computed(() => {
    const b = this.bot();
    const last = Number(this.ticker()?.last ?? this.candles().at(-1)?.c ?? 0);
    const liq = Number(b?.liquidationPrice ?? 0);
    if (!b || !Number.isFinite(liq) || liq <= 0 || !Number.isFinite(last) || last <= 0) return null;
    return Math.abs(((last - liq) / last) * 100);
  });

  /** Capa efectiva: lo que dicen los interruptores, no lo que trae el bot. */
  readonly visibleLines = computed(() => {
    const l = this.layers();
    // El precio medio va con la escalera: es parte de la misma lectura —donde
    // estan mis ordenes y donde esta mi entrada—, y separarlo daria un tercer
    // interruptor para una sola linea.
    return this.overlayLines().filter((line) => {
      if (line.kind === 'liquidation') return l.liquidation;
      // Los planificados van ANIDADOS bajo la escalera: enseñar donde caeria la
      // siguiente orden con las ordenes reales apagadas no significa nada.
      if (line.ghost) return l.ladder && l.planned;
      return l.ladder;
    });
  });

  readonly visibleMarkers = computed(() => (this.layers().fills ? this.overlayMarkers() : []));

  constructor() {
    addIcons({
      star,
      starOutline,
      ellipsisVertical,
      optionsOutline,
      warningOutline,
      chevronBackOutline,
      closeOutline,
    });

    // Los precios se reservan por CONTADOR, no con un interruptor compartido.
    // Antes esta pantalla los apagaba al salir y, como vive fuera de las
    // pestañas, la lista de mercados se quedaba congelada al volver a ella.
    // Aqui hacen falta los TRES venues: la pestaña «Plataformas» compara este
    // par con el mismo activo en los otros dos, y cuesta lo mismo porque el
    // endpoint lee de Redis, no del DEX.
    const release = this.data.watchTickers();
    this.destroyRef.onDestroy(release);

    // La vela en formación, del stream del venue.
    //
    // Es la respuesta a «por qué peticiones y no un SSE mientras se mira el
    // gráfico»: el interés se declara al entrar y se suelta al salir, y quien
    // manda la vela es el WebSocket del venue, con su volumen de verdad. Antes
    // esta pantalla pedía las dos últimas velas cada cinco segundos contra una
    // caché de quince, así que la línea del gráfico iba hasta veinte segundos
    // por detrás de la cifra de su propia cabecera.
    const velas = this.data.watchCandles();
    this.destroyRef.onDestroy(() => velas.release());
    effect(() => {
      // Los tres se leen AQUI y se pasan dentro. `update` acaba llamando a
      // `declare()`, que lee mas señales —el segundo plano, entre otras— y sin
      // `untracked` todas se volverian disparadores de este efecto sin que se
      // viera: el que lee esto no podria saber cuando vuelve a correr.
      //
      // El venue se lee aqui y no al reservar el interes: en el constructor
      // todavia es el valor por defecto, porque `ngOnInit` es quien lo saca de
      // la ruta.
      const venue = this.venue();
      const symbol = this.symbol();
      const interval = this.interval();
      // Y solo si el venue las SIRVE.
      //
      // Declarar una serie que Lighter no da no es inofensivo: el worker
      // responde que no puede y no la apunta, asi que la API se la vuelve a
      // pedir en cada latido —cada cinco segundos, mientras la pantalla este
      // abierta— y encima ocupa uno de los cuatro huecos de velas del cupo,
      // para nada. Ahi la vela se compone desde el precio.
      //
      // Se lee FUERA de `untracked` a proposito: las capacidades llegan por red
      // y pueden no estar todavia al abrir la pantalla. Siendo dependencia del
      // efecto, la serie se declara sola en cuanto lleguen.
      const enVivo = this.data.hasLiveCandles(venue);
      untracked(() => {
        velas.update(symbol && enVivo ? { venue, symbol, interval } : null);
      });
    });

    this.data.candleEvents.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      // Se comprueba que sea LA serie que se está mirando: al cambiar de
      // intervalo pueden llegar velas de la anterior mientras el servidor
      // suelta su suscripción, y aplicarlas mezclaría dos resoluciones en la
      // misma pantalla.
      if (
        event.venue !== this.venue() ||
        event.symbol !== this.symbol() ||
        event.interval !== this.interval() ||
        // La RED, por el mismo motivo que el intervalo: al conmutar la lente
        // pueden llegar velas de la red anterior mientras el servidor suelta
        // su suscripcion, y aplicarlas mezclaria dos libros en un grafico.
        event.testnet !== this.network.testnet()
      ) {
        return;
      }
      this.applyLiveCandle(event.candle);
    });

    // Al VOLVER el flujo, la serie se vuelve a pedir entera.
    //
    // Es la única forma de recuperar lo que se cerró mientras no había línea.
    // No basta con reanudar el stream: las velas viejas no se reemiten, así que
    // el hueco se quedaría en el gráfico hasta cambiar de resolución.
    //
    // Solo si ya había una serie cargada: al abrir la pantalla, `ngOnInit` ya
    // la pide, y sin esta condición se pediría dos veces cada vez.
    effect(() => {
      const conectado = this.streamSvc.connected();
      untracked(() => {
        if (!conectado) {
          if (this.candles().length > 0) this.perdido = true;
          // El bot lleva su propia marca: la de las velas solo se levanta si ya
          // había serie cargada, y la escalera puede estar pintada sin ella.
          if (this.botId) this.botPerdido = true;
          return;
        }
        // Mientras no había línea el bot pudo colocar, cancelar y ejecutar, y
        // esos eventos no se reemiten. La escalera pintada es de antes del
        // corte, así que se relee entera igual que la serie de velas.
        if (this.botPerdido && this.botId) {
          this.botPerdido = false;
          void this.loadBot(this.botId, { silent: true });
        }
        if (!this.perdido) return;
        this.perdido = false;
        // La vela viva también se tira: es de antes del corte, y dejarla puesta
        // la archivaría como barra buena en el siguiente relevo.
        this.liveBar.set(null);
        // Preservando el histórico: en un móvil esto salta constantemente, y
        // reemplazar la serie tiraría todo el pasado que el usuario cargó a
        // mano cada vez que la línea parpadea.
        void this.loadCandles({ preserveHistory: true });
      });
    });

    // El bot, en vivo.
    //
    // Sin esto el overlay era una foto del instante en que se abrió la
    // pantalla: el bot añadía una orden de seguridad, cancelaba un nivel o
    // cerraba un ciclo y la escalera seguía siendo la de antes. Y lo peor no
    // eran las líneas sino `liqDistance()`, que cruza el precio EN VIVO con la
    // liquidación congelada y devuelve un número que no es ninguno de los dos.
    //
    // Mismo patrón que `bot-detail.page.ts`, con la ventana de agrupación que
    // explica `BOT_COALESCE_MS`.
    this.streamSvc.stream
      .pipe(
        filter((ev) => this.botId !== null && ev.botId === this.botId),
        throttleTime(BOT_COALESCE_MS, undefined, { leading: true, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        if (this.botId) void this.loadBot(this.botId, { silent: true });
      });

    // Cambio de lente: la serie que hay pintada es de la OTRA red.
    //
    // No basta con filtrar los eventos nuevos. La serie ya cargada sigue siendo
    // de la red anterior, asi que sin recargarla las velas de la nueva se
    // pegarian encima de las viejas y el grafico enseñaria dos libros a la vez
    // — con el mismo par y el mismo intervalo, sin nada que lo delatara.
    //
    // Se reutiliza el camino de la reconexion, que ya resuelve exactamente esto:
    // tirar la vela viva y volver a pedir la serie entera. Si el par no existe
    // en la otra red, `loadCandles` cae en el estado de error que ya esta
    // escrito.
    let redAnterior: boolean | null = null;
    effect(() => {
      const testnet = this.network.testnet();
      // La primera pasada solo toma nota: `ngOnInit` ya carga la serie.
      if (redAnterior === null) {
        redAnterior = testnet;
        return;
      }
      if (redAnterior === testnet) return;
      redAnterior = testnet;
      untracked(() => {
        this.liveBar.set(null);
        this.candles.set([]);
        void this.loadCandles();
      });
    });

    // Un ÚNICO sitio donde se reinicia la paginación del histórico.
    //
    // Los caminos que invalidan una serie son cinco —cambiar de intervalo, de
    // par, de venue, de red, y volver a entrar—, y repartir el reinicio entre
    // ellos es exactamente el descuido contra el que avisa el comentario de
    // `scaleKey`. La clave los cubre todos por construcción.
    let serieAnterior: string | null = null;
    effect(() => {
      const clave = this.historyKey();
      if (serieAnterior === clave) return;
      serieAnterior = clave;
      untracked(() => this.resetHistoryPaging());
    });

    // Y en los venues SIN stream de velas, la vela se compone desde el precio.
    this.data.tickEvents.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((tick) => {
      if (this.data.hasLiveCandles(this.venue())) return;
      if (tick.venue !== this.venue() || tick.symbol !== this.symbol()) return;
      if (tick.testnet !== this.network.testnet()) return;
      this.foldTick(tick.last, tick.ts ?? Date.now());
    });

    // El par abierto, en vivo y por su nombre.
    //
    // Aqui es donde mas se nota: el gráfico de un par es exactamente el sitio
    // en el que un usuario espera ver moverse el número. La API convierte este
    // interés en UNA suscripción al WebSocket del venue —compartida con
    // cualquier otro usuario mirando el mismo par y con los bots que lo
    // operen—, y la suelta al cerrarse esta pantalla.
    const watch = this.data.watchSymbols();
    this.destroyRef.onDestroy(() => watch.release());
    effect(() => {
      const venue = this.venue();
      const symbol = this.symbol();
      untracked(() => watch.update(symbol ? [`${venue}:${symbol}`] : []));
    });

    // Pantalla apagada o app al fondo: se para la vela viva. En un movil, un
    // temporizador que sigue pidiendo velas en segundo plano gasta bateria sin
    // que nadie mire nada.
    //
    // El oyente de Capacitor es UNO y vive en `MarketDataService`. Estaba aqui,
    // y para que fuera correcto hacia falta contar entradas en la vista y
    // comprobar al resolver el registro asincrono si seguia siendo la vigente
    // —Ionic llama a `ionViewWillEnter` varias veces en la vida de una vista—.
    // Todo eso desaparece leyendo una señal.
    effect(() => {
      if (this.data.background()) this.stopRefresh();
      else if (this.visible) this.startRefresh();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Ciclo de vida
  // ═══════════════════════════════════════════════════════════════

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.paramMap;
    this.venue.set((params.get('venue') as Venue) ?? 'HYPERLIQUID');
    this.symbol.set(params.get('symbol') ?? '');

    await this.data.loadCapabilities().catch(() => undefined);

    // El intervalo por defecto tiene que EXISTIR en esta plataforma. Fijar 1h a
    // ciegas funcionaría en los tres de hoy y fallaría en silencio con el
    // primero que no lo sirva.
    //
    // Antes va el que traiga la URL: es el que se venía mirando al saltar de
    // plataforma (ver `openMarket`). Se acepta solo si esta plataforma lo
    // sirve —la lista viene de la API—, así que un `?iv=` inventado a mano no
    // llega a convertirse en una petición al venue.
    const available = this.intervals();
    const query = this.route.snapshot.queryParamMap;
    const wanted = query.get('iv') as CandleInterval | null;
    if (wanted && available.includes(wanted)) {
      this.interval.set(wanted);
    } else if (available.length && !available.includes(this.interval())) {
      this.interval.set(available.includes('1h') ? '1h' : available[0]);
    }

    const botId = query.get('bot');
    this.botId = botId;
    await Promise.all([
      this.loadMarket(),
      this.loadCandles(),
      // La lista se refresca SIEMPRE, tambien viniendo de un bot: `loadBot` trae
      // el detalle de uno, pero la pestaña «Mis bots» se pinta de la lista, y
      // sin refrescarla salia vacia precisamente en la pantalla a la que se
      // llega desde un bot.
      this.botsSvc.refresh().catch(() => undefined),
      botId ? this.loadBot(botId) : Promise.resolve(),
      this.loadDayRange(),
    ]);
    this.loading.set(false);
  }

  ionViewWillEnter(): void {
    this.visible = true;
    // Si al abrir no habia red, las capacidades se vuelven a pedir aqui: es
    // barato (una peticion, cacheada de por vida en cuanto llega) y es lo que
    // convierte la barra de minimos en la barra real sin reabrir la pantalla.
    void this.data.loadCapabilities().catch(() => undefined);
    // Con la app ya al fondo no se arranca: el efecto lo hara al volver.
    if (!this.data.background()) this.startRefresh();
  }

  ionViewWillLeave(): void {
    this.visible = false;
    // La hoja de ajustes se cierra al salir: es una superposicion a pantalla
    // completa y dejarla abierta la haria reaparecer sobre la pantalla de
    // vuelta, encima de un grafico que ya no es el suyo.
    this.optionsOpen.set(false);
    this.stopRefresh();
  }

  /**
   * Respaldo para los venues SIN stream de velas.
   *
   * Hoy solo Lighter, y lo dice la API en `capabilities`, no una lista escrita
   * aquí. En esos venues la vela se compone desde los ticks de precio —que sí
   * llegan— pero un tick no trae VOLUMEN, así que la barra de volumen se
   * quedaría clavada. Esto lo corrige releyendo las dos últimas velas de vez en
   * cuando, y solo si el panel de volumen está a la vista.
   *
   * Treinta segundos y no cinco: lo que necesitaba ser inmediato —el precio— ya
   * no pasa por aquí. Antes esto era EL mecanismo de actualización y corría
   * cada cinco segundos contra una caché de quince, así que dos de cada tres
   * peticiones volvían con el mismo byte.
   */
  private startRefresh(): void {
    this.stopRefresh();
    this.refresh = setInterval(() => {
      // Las dos condiciones se miran DENTRO y no al armar el reloj. `hasLiveCandles`
      // sale de las capacidades, que llegan por red: al entrar en la pantalla
      // pueden no estar todavia, y decidir ahi dejaria a Hyperliquid releyendo
      // velas que ya recibe por el stream. Y el panel de volumen se enciende y
      // se apaga desde los ajustes, sin volver a entrar.
      if (this.data.hasLiveCandles(this.venue()) || !this.showVolume()) return;
      void this.reconcile();
    }, RECONCILE_MS);
  }

  private stopRefresh(): void {
    if (this.refresh) clearInterval(this.refresh);
    this.refresh = null;
  }

  /**
   * Relee las dos últimas velas y las funde con la serie.
   *
   * El intervalo se captura ANTES de pedir y se comprueba al volver. Sin esta
   * guarda, cambiar de 1H a 1m mientras hay una petición en vuelo fusionaba dos
   * velas horarias dentro de una serie de minutos: el gráfico se quedaba con
   * trescientas barras de una resolución y dos de otra, sin ningún error y con
   * una forma que no corresponde a ningún mercado.
   */
  private async reconcile(): Promise<void> {
    // La clave ENTERA, igual que en `loadCandles`: comprobar solo el intervalo
    // dejaba fuera venue, par y RED, así que un cambio de la lente de red a
    // media petición fundía las dos últimas velas de la otra red sobre la serie
    // buena — sin error y sin que nada lo indicara.
    const asked = this.historyKey();
    try {
      const tail = await this.data.candles(this.venue(), this.symbol(), this.interval(), 2, {
        refresh: true,
      });
      if (this.historyKey() !== asked) return;
      // Nunca sobre una serie vacia: mientras la carga completa esta en vuelo,
      // fusionar las dos velas pintaria un grafico de dos barras y, al llegar
      // la serie, un salto. Se espera a tenerla.
      this.candles.update((prev) =>
        prev.length ? this.data.merge(prev, tail, this.keepBars()) : prev,
      );
    } catch {
      /* el gráfico sigue con lo que tiene; el stream manda */
    }
  }

  /**
   * Aplica una vela que llega del venue.
   *
   * La que se CIERRA entra en la serie y la nueva pasa a ser la viva. Sin eso,
   * la barra que acaba de cerrarse solo viviría en `liveBar` y desaparecería en
   * el siguiente `setData` —al cambiar de tipo de gráfico, por ejemplo—
   * dejando un hueco en el histórico.
   */
  private applyLiveCandle(candle: Candle): void {
    const current = this.liveBar();
    if (current && candle.t > current.t) {
      this.candles.update((prev) => this.data.merge(prev, [current], this.keepBars()));
    }
    this.liveBar.set(candle);
  }

  /**
   * Máximo y mínimo de las últimas 24 h, para los venues que no los publican.
   *
   * Una lectura, al abrir. Se recorta por marca de tiempo y no por número de
   * barras: pedir 50 velas de una hora y quedarse con «las 24 últimas» daría lo
   * mismo hoy, pero un hueco en la serie —un mercado recién listado, un corte
   * del venue— convertiría eso en una ventana de más de un día etiquetada como
   * de 24 h.
   */
  private async loadDayRange(): Promise<void> {
    this.derivedRange.set(null);
    // Se ESPERA a la instantánea antes de decidir.
    //
    // Sin esperar, al abrir la pantalla los precios todavía no han llegado, así
    // que no hay ticker que mirar y esto salía a pedir velas también en los
    // venues que sí publican el máximo y el mínimo —Aster— para tirar el
    // resultado. La llamada está compartida con la que ya está en vuelo, así
    // que esperar no cuesta una petición más.
    await this.data.refreshTickers().catch(() => undefined);
    const t = this.data.tickerOf(this.venue(), this.symbol());
    if (t && t.high24h !== null && t.low24h !== null) return;
    if (!this.data.supports(this.venue(), '1h')) return;

    try {
      const velas = await this.data.candles(this.venue(), this.symbol(), '1h', RANGE_BARS);
      const desde = Date.now() - 86_400_000;
      const ventana = velas.filter((c) => c.t >= desde);
      if (ventana.length === 0) return;
      let high = ventana[0].h;
      let low = ventana[0].l;
      for (const c of ventana) {
        if (Number(c.h) > Number(high)) high = c.h;
        if (Number(c.l) < Number(low)) low = c.l;
      }
      this.derivedRange.set({ high, low });
    } catch {
      /* la cabecera enseña un guion, que es lo que hacia antes */
    }
  }

  /**
   * Pliega un precio suelto dentro de la vela en formación.
   *
   * Solo para los venues sin stream de velas. El cubo se calcula con el mismo
   * `INTERVAL_MS` que usa el resto del sistema, así que un intervalo nuevo
   * encaja sin tocar esto. Al cambiar de cubo, la barra que se cierra entra en
   * la serie —para que sobreviva al siguiente `setData`— y se abre la nueva.
   */
  private foldTick(last: string, ts: number): void {
    // `1M` no tiene duracion fija y por eso no esta en `INTERVAL_MS`. No es un
    // hueco: esto solo corre en los venues SIN stream de velas —hoy solo
    // Lighter— y Lighter no sirve la mensual. Si algun dia la sirviera, la
    // pantalla se quedaria con la vela de la carga inicial y la relectura, que
    // es degradarse, no romperse.
    const span = INTERVAL_MS[this.interval() as Exclude<CandleInterval, '1M'>];
    if (!span) return;
    const bucket = Math.floor(ts / span) * span;
    const price = Number(last);
    if (!Number.isFinite(price)) return;

    // Si todavía no hay vela viva, se toma la de la SERIE cuando es de este
    // mismo cubo.
    //
    // Sin esto, el primer tick abría una barra nueva con apertura, máximo,
    // mínimo y cierre iguales —un doji— y `series.update()` la pintaba encima
    // de la barra en curso que ya se había cargado con su OHLC de verdad: la
    // vela del momento se aplastaba a una raya y volvía a crecer desde ahí,
    // cada vez que se abría la pantalla.
    const enCurso = this.candles().at(-1);
    const current = this.liveBar() ?? (enCurso?.t === bucket ? enCurso : null);

    if (!current || bucket > current.t) {
      // Vela nueva. La anterior, ya cerrada, pasa a la serie: el volumen que
      // lleve es el último que se leyó, y lo corrige la relectura.
      if (current) this.candles.update((prev) => this.data.merge(prev, [current], this.keepBars()));
      this.liveBar.set({ t: bucket, o: last, h: last, l: last, c: last, v: null });
      return;
    }
    if (bucket < current.t) return;
    this.liveBar.set({
      ...current,
      h: price > Number(current.h) ? last : current.h,
      l: price < Number(current.l) ? last : current.l,
      c: last,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Carga
  // ═══════════════════════════════════════════════════════════════

  private async loadMarket(): Promise<void> {
    try {
      const all = await this.markets.list(this.venue());
      this.market.set(all.find((m) => m.symbol === this.symbol()) ?? null);
    } catch {
      // El gráfico funciona sin la spec; solo se pintan menos decimales.
    }
  }

  async loadCandles(opts: { preserveHistory?: boolean } = {}): Promise<void> {
    this.chartError.set(null);
    // La clave ENTERA y no solo el intervalo. La guarda comprobaba
    // `this.interval() !== asked` y dejaba fuera venue, par y RED: un cambio
    // rápido de la lente de red a media petición podía pegar en el gráfico las
    // velas de la otra red, sin error y sin que nada lo indicara.
    const asked = this.historyKey();
    try {
      const data = await this.data.candles(this.venue(), this.symbol(), this.interval(), BARS, {
        refresh: true,
      });
      if (this.historyKey() !== asked) return;

      const prev = this.candles();
      if (!opts.preserveHistory || prev.length === 0) {
        this.candles.set(data);
        this.resetHistoryPaging();
        return;
      }

      // Reconexión: lo que hay a la izquierda son velas CERRADAS, inmutables por
      // definición, así que fundir es correcto y tirarlas sería perder todo el
      // pasado que el usuario cargó a mano.
      //
      // Salvo que el corte durara más que la ventana que acabamos de pedir: ahí
      // queda un AGUJERO entre lo viejo y lo nuevo, y un agujero no es cosmético
      // —`bucketOf` coloca los marcadores de ejecución por bisección sobre los
      // tiempos de las barras y los pondría al lado equivocado—.
      const span = candleSpanMs(this.interval());
      const hueco = data.length > 0 && data[0].t > prev[prev.length - 1].t + span;
      if (hueco) {
        this.candles.set(data);
        this.resetHistoryPaging();
        return;
      }
      this.candles.update((actual) => this.data.merge(actual, data, this.keepBars()));
    } catch (e) {
      if (this.historyKey() !== asked) return;
      if (opts.preserveHistory && this.candles().length > 0) return;
      this.candles.set([]);
      this.resetHistoryPaging();
      this.chartError.set(errorText(e));
    }
  }

  /**
   * Cuántas velas conserva `merge`.
   *
   * El presupuesto de cola viva —600— se conserva LITERAL y el histórico es
   * puramente aditivo. Sin esto, cada relevo de vela y cada reconciliación de
   * treinta segundos borraba en silencio todo lo que pasara de 600 barras.
   */
  private keepBars(): number {
    return 600 + Math.max(0, this.candles().length - BARS);
  }

  private resetHistoryPaging(): void {
    this.historyPages = 0;
    this.historyAt = 0;
    this.loadingHistory.set(false);
    this.noMoreHistory.set(false);
    this.historyCapped.set(false);
  }

  /**
   * Trae una página de pasado. La pide el gráfico al acercarse al borde.
   *
   * Falla en SILENCIO a propósito: `chartError` sustituye el gráfico entero por
   * un mensaje con «Reintentar», y las trescientas barras que hay en pantalla
   * están perfectamente bien. Al no marcar nada, el pestillo del componente se
   * rearma solo cuando el usuario vuelve a la derecha y volver a arrastrar
   * reintenta. Es el mismo criterio que el `catch` vacío de `reconcile()`.
   */
  async loadMoreHistory(): Promise<void> {
    if (this.loadingHistory() || this.noMoreHistory() || this.historyCapped()) return;

    // Los topes los dicta el VENUE, no el cliente. Ver `HISTORY_FALLBACK`.
    const caps = this.data.capabilities()?.[this.venue()]?.candles;
    const maxPages = caps?.maxHistoryPages ?? HISTORY_FALLBACK.maxHistoryPages;
    const gapMs = caps?.minPageGapMs ?? HISTORY_FALLBACK.minPageGapMs;

    if (this.historyPages >= maxPages || this.candles().length >= MAX_HISTORY_BARS) {
      this.historyCapped.set(true);
      return;
    }

    const state = historyStateOf(this.candles());
    const limits = {
      interval: this.interval(),
      // El tamaño de página no puede pasarse del máximo del venue: en Lighter
      // son 500, y pedir más devolvería una página corta que se leería como el
      // final del histórico.
      pageBars: Math.min(HISTORY_PAGE_BARS, caps?.maxBars ?? HISTORY_PAGE_BARS),
      maxBars: MAX_HISTORY_BARS,
      maxPages,
    };
    const req = nextHistoryRequest(state, limits);
    if (!req) return;

    const asked = this.historyKey();
    this.loadingHistory.set(true);
    try {
      const espera = gapMs - (Date.now() - this.historyAt);
      if (espera > 0) await new Promise((r) => setTimeout(r, espera));
      if (this.historyKey() !== asked) return;

      const page = await this.data.candles(
        this.venue(),
        this.symbol(),
        this.interval(),
        req.limit,
        { endMs: req.endMs },
      );
      if (this.historyKey() !== asked) return;

      this.historyAt = Date.now();
      // Se recalcula el estado contra la serie de AHORA y no contra la de antes
      // del await: entre medias pudo entrar una vela viva por el otro camino.
      const next = applyHistoryPage(historyStateOf(this.candles()), page, limits);
      this.historyPages = this.historyPages + (next.pages > 0 ? 1 : 0);
      this.noMoreHistory.set(next.noMore);
      this.historyCapped.set(next.capped);
      if (next.bars.length !== this.candles().length) this.candles.set(next.bars);
    } catch {
      // Ver la cabecera: se falla callando.
    } finally {
      this.loadingHistory.set(false);
    }
  }

  /**
   * El detalle del bot y su ledger de ejecuciones.
   *
   * @param opts.silent no saca toast al fallar. Lo usan las recargas que dispara
   *   el flujo de eventos: son varias por minuto y sin esto una API caída
   *   apilaría avisos encima del gráfico. El aviso persistente de la leyenda
   *   —`botError`— sí se pone siempre, que es donde tiene que leerse.
   */
  private async loadBot(id: string, opts: { silent?: boolean } = {}): Promise<void> {
    const seq = ++this.botSeq;
    try {
      // Las tres en la misma tanda: una ráfaga de eventos ya agrupada cuesta
      // tres peticiones en total, no tres por evento.
      //
      // Los niveles y el ledger caen a lista vacía si fallan. El detalle no: sin
      // él no hay bot que pintar, y ese sí tiene que llegar al `catch`.
      const [detail, fills, levels] = await Promise.all([
        this.botsSvc.detail(id),
        this.botsSvc.fills(id, FILL_LIMIT).catch(() => []),
        this.botsSvc.levels(id).catch(() => []),
      ]);
      // Llegó tarde: hay otra carga más nueva, o se ha cambiado de bot.
      if (seq !== this.botSeq || id !== this.botId) return;
      this.bot.set(detail);
      this.overlayLevels.set(levels);
      this.overlayFills.set(fills);
      this.fillsTruncated.set(fills.length >= FILL_LIMIT);
      this.botError.set(null);
    } catch (e) {
      if (seq !== this.botSeq || id !== this.botId) return;
      this.botError.set(errorText(e));
      if (!opts.silent) await this.toast.error(errorText(e));
    }
  }

  /** Reintento del aviso de la leyenda. */
  retryBot(): void {
    if (this.botId) void this.loadBot(this.botId);
  }

  // ═══════════════════════════════════════════════════════════════
  // Interacción
  // ═══════════════════════════════════════════════════════════════

  async changeInterval(interval: CandleInterval): Promise<void> {
    if (interval === this.interval()) return;
    this.interval.set(interval);
    // La serie anterior y su error se vacian YA: dejarlos puestos mientras
    // llega lo nuevo enseña durante un instante velas de la resolucion vieja
    // —o el error de la resolucion vieja— bajo la etiqueta de la nueva.
    this.candles.set([]);
    // Y la vela viva TAMBIEN: es de la resolucion anterior, y dejarla puesta
    // pintaria una barra horaria dentro de una serie de minutos.
    this.liveBar.set(null);
    this.chartError.set(null);
    await this.loadCandles();
  }

  toggleFavourite(): void {
    this.favourites.toggle(this.favKey());
  }

  /** Mismo destino que el boton de la cabecera: al bot si se vino de uno. */
  goBack(): void {
    const b = this.bot();
    void this.router.navigateByUrl(b ? `/bots/${b.id}` : '/tabs/markets');
  }

  toggleLayer(layer: 'ladder' | 'planned' | 'fills' | 'liquidation'): void {
    this.layers.update((l) => ({ ...l, [layer]: !l[layer] }));
  }

  goToBot(bot: BotSummary | BotDetail): void {
    void this.router.navigate(['/bots', bot.id]);
  }

  createBot(): void {
    void this.router.navigate(['/bots/new'], {
      queryParams: { venue: this.venue(), symbol: this.symbol() },
    });
  }

  /**
   * El mismo activo en otra plataforma.
   *
   * Va con `replaceUrl` y no con un empujón normal. Ionic trata cada par
   * —venue + símbolo— como una pantalla distinta, así que saltar de
   * Hyperliquid a Lighter y de ahí a Aster apilaba tres gráficos: el botón de
   * volver recorría uno a uno los pares mirados en lugar de salir a la lista,
   * y parecía que la app abría pantallas duplicadas. Cambiar de plataforma es
   * cambiar de fuente de precio, no entrar en otro sitio: se sustituye la
   * pantalla y volver sigue llevando a donde se entró.
   *
   * El intervalo viaja en la URL para que el salto no lo pierda: se está
   * comparando el MISMO gráfico en dos plataformas, y volver a 1H cada vez
   * obligaba a rehacer la elección en cada salto. Si la plataforma de destino
   * no sirve esa resolución, `ngOnInit` cae a la suya.
   */
  openMarket(venue: Venue, symbol: string): void {
    void this.router.navigate(['/markets', venue, symbol], {
      queryParams: { iv: this.interval() },
      replaceUrl: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Ajustes del gráfico
  //
  // Era una `ion-action-sheet` con un botón por intervalo. Con quince
  // intervalos, más el tipo de serie y el volumen, la hoja crecía hasta
  // ocupar la pantalla entera: no quedaba fondo que tocar para cerrarla y el
  // botón de cerrar caía fuera de vista. Ahora es una hoja propia con los
  // intervalos en rejilla —quince pastillas caben en cuatro filas— que se
  // cierra tocando fuera, arrastrando hacia abajo, con la aspa o con Cerrar.
  // ═══════════════════════════════════════════════════════════════

  readonly optionsOpen = signal(false);

  /**
   * Los topes de altura de la hoja, en un campo y no escritos en la plantilla:
   * asi la referencia del array no cambia en cada deteccion de cambios y el
   * `ion-modal` no vuelve a reordenarlos sesenta veces por segundo.
   */
  readonly optionBreakpoints = [0, 0.72, 1];

  /**
   * La rejilla de intervalos, ya resuelta.
   *
   * Salen los quince, no solo los que sirve la plataforma: esconder los demás
   * deja al usuario creyendo que la app no sabe hacerlo, cuando el que no
   * puede es el venue. Y va en un `computed` y no en funciones que llame la
   * plantilla porque si no se recalcularían quince veces en cada detección de
   * cambios, con la pantalla refrescando el precio cada cinco segundos.
   */
  readonly intervalOptions = computed(() => {
    const all = this.intervals();
    return ALL_INTERVALS.map((iv) => ({
      value: iv,
      label: intervalLabel(iv),
      ok: all.includes(iv),
      // Decir solo «no disponible» deja al usuario pensando que falla la app.
      // Si otra plataforma sí sirve esa resolución se nombra: ya está en las
      // capacidades y ahorra ir a buscarla a mano.
      hint: all.includes(iv) ? null : this.intervalHint(iv),
    }));
  });

  /** Cuántos de los quince NO sirve esta plataforma. */
  readonly missingCount = computed(() => this.intervalOptions().filter((o) => !o.ok).length);

  readonly totalIntervals = ALL_INTERVALS.length;

  private intervalHint(interval: CandleInterval): string {
    const others = this.data.venuesWith(interval).filter((v) => v !== this.venue());
    const where = others.length ? ` Sí lo sirve ${others.map(venueLabel).join(' y ')}.` : '';
    return `${venueLabel(this.venue())} no sirve velas de ${intervalLabel(interval)}.${where}`;
  }

  openOptions(): void {
    this.optionsOpen.set(true);
  }

  closeOptions(): void {
    this.optionsOpen.set(false);
  }

  /** Elegir intervalo cierra la hoja: es la acción por la que se abrió. */
  pickInterval(interval: CandleInterval): void {
    if (!this.intervals().includes(interval)) return;
    this.closeOptions();
    void this.changeInterval(interval);
  }

  setKind(kind: ChartSeriesKind): void {
    this.kind.set(kind);
  }

  toggleVolume(): void {
    this.showVolume.update((v) => !v);
  }
}

/** La unión completa, para poder decir qué falta en cada plataforma. */
const ALL_INTERVALS: CandleInterval[] = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
];
