import {
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  LogicalRange,
  SeriesMarker,
  SeriesMarkerBar,
  SeriesMarkerPrice,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../../core/models';
import { chartPalette, fade, overlayPalette } from './chart-theme';
import type { OverlayEventMarker, OverlayLine, OverlayMarker, OverlayStyle } from './bot-overlay';

export type ChartSeriesKind = 'candles' | 'bars' | 'line' | 'area';

/**
 * Un punto de una serie auxiliar, ya casado al instante de SU vela. `v: null`
 * es un hueco: la línea se rompe ahí en vez de cruzar el tramo sin dato.
 */
export interface ChartLinePoint {
  t: number;
  v: number | null;
}

/**
 * Cuantas barras de margen quedan a la izquierda antes de pedir mas pasado.
 *
 * Veinticinco a un `barSpacing` normal son unos 150 px: aproximadamente un
 * impulso del dedo. Suficiente para que la pagina llegue antes de que el usuario
 * vea el hueco, y poco como para que un zoom ocioso no dispare peticiones.
 */
const HISTORY_TRIGGER_BARS = 25;

/**
 * Cuanto hay que mover el dedo sobre el eje para que cuente como arrastre.
 *
 * Por debajo es un toque. Sin umbral, el repunte del dedo al levantarlo movia la
 * escala y el doble toque —la vuelta al encuadre automatico— no llegaba a
 * registrarse nunca.
 */
const DRAG_THRESHOLD_PX = 6;

/** Ventana del doble toque sobre el eje. La habitual de los sistemas. */
const DOUBLE_TAP_MS = 300;

/** Lo que se lee de la cruceta y se pinta en la leyenda fija. */
export interface ChartReadout {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  up: boolean;
}

/**
 * El grafico de precios.
 *
 * Es el UNICO sitio del proyecto que importa `lightweight-charts`. Cambiar de
 * motor grafico algun dia es reescribir este fichero y nada mas; el resto de la
 * app habla en `Candle`, `OverlayLine` y `OverlayMarker`.
 *
 * La libreria se carga PEREZOSAMENTE (`await import`) para que no entre en el
 * paquete inicial: quien nunca abre un grafico no paga sus ~45 kB, y en un APK
 * eso importa.
 */
@Component({
  selector: 'app-price-chart',
  standalone: true,
  template: `
    <div class="host" #host></div>
    <!-- La vuelta al encuadre automatico.
         Solo aparece con la escala tocada a mano: un boton permanente seria una
         pieza mas que descifrar en una pantalla que ya va cargada, y mientras el
         encuadre es automatico no hay nada a lo que volver. -->
    @if (userScaled()) {
      <button
        type="button"
        class="autofit"
        (click)="resetScale()"
        aria-label="Volver al encuadre automatico"
      >
        AUTO
      </button>
    }
    @if (!ready()) {
      <div class="skeleton"></div>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: block;
        /* Altura EXPLICITA, nunca 100%. Un contenedor de lightweight-charts con
           height:100% dentro de una columna flex sin base fija colapsa a 0 px y
           el grafico no llega a aparecer — sin error, sin aviso, en blanco. */
        height: var(--chart-h, 260px);
        width: 100%;
      }

      .host {
        position: absolute;
        inset: 0;
      }

      /* Reserva el hueco mientras carga: si la caja no ocupa su altura final,
         al llegar los datos la pagina pega un salto y el usuario pierde el
         sitio por el que iba. */
      .skeleton {
        position: absolute;
        inset: 0;
        border-radius: var(--radius-sm);
        background: linear-gradient(
          100deg,
          var(--surface-1) 30%,
          var(--surface-2) 50%,
          var(--surface-1) 70%
        );
        background-size: 220% 100%;
        animation: sweep 1.4s ease-in-out infinite;
      }

      @keyframes sweep {
        to {
          background-position: -220% 0;
        }
      }

      /* Esquina inferior derecha: el hueco muerto donde se cruzan el eje de
         tiempo y el de precios. Esta siempre vacio —no tapa ni una etiqueta— y
         es donde cualquiera que haya usado un terminal va a buscarlo. */
      .autofit {
        position: absolute;
        right: 4px;
        bottom: 4px;
        z-index: 3;
        min-height: 22px;
        padding: 0 7px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-xs);
        background: var(--surface-2);
        color: var(--brand-2);
        font-family: var(--font-ui);
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.06em;
        line-height: 1;
        cursor: pointer;
      }
    `,
  ],
})
export class PriceChartComponent {
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  readonly candles = input.required<Candle[]>();
  readonly kind = input<ChartSeriesKind>('candles');
  readonly priceDecimals = input<number>(2);
  readonly showVolume = input<boolean>(true);
  /** Lineas de la escalera del bot. Vacio = grafico de mercado normal. */
  readonly lines = input<OverlayLine[]>([]);
  readonly markers = input<OverlayMarker[]>([]);
  /**
   * Sucesos del bot sobre sus velas (spec 005). Vacío = nada: es el valor por
   * defecto y el de los cuatro consumidores que existían antes.
   */
  readonly events = input<OverlayEventMarker[]>([]);
  /**
   * El precio medio de entrada como SERIE en el panel del precio, punteada y con
   * huecos donde el bot no escribió. Vacía = no se crea la serie.
   */
  readonly average = input<ChartLinePoint[]>([]);
  /**
   * El resultado acumulado en un panel propio bajo el precio (y bajo el volumen,
   * si lo hay), con el cero como base. Vacía = no hay panel: sin este input el
   * gráfico ejecuta exactamente el código de antes.
   */
  readonly result = input<ChartLinePoint[]>([]);
  /**
   * Rango que hay que poder ver. Al entrar desde un bot, el grafico se ABRE a
   * la escalera entera: uno ajustado solo a las velas deja fuera justo la orden
   * de seguridad que se venia a mirar.
   */
  readonly fitSpan = input<{ min: number; max: number } | null>(null);

  /**
   * Identidad de lo que se esta mirando: par, red, intervalo, bot.
   *
   * Sirve para UNA cosa: soltar el ajuste manual de la escala cuando cambia el
   * contenido. Un rango de precios de ETH no significa nada en BTC, y el de 1h
   * no significa lo mismo en 1m.
   *
   * Es una cadena y no un objeto a proposito —se compara por valor, asi que no
   * dispara nada mientras no cambie de verdad— y la compone la pagina. La
   * alternativa era llamar a `resetScale()` desde `changeInterval()`, y eso
   * habria dejado fuera los otros cuatro caminos que ya existen: saltar de
   * plataforma, conmutar la red, la reconexion y la entrada desde un bot.
   */
  readonly scaleKey = input<string>('');

  /**
   * La vela EN FORMACION, aparte de la serie.
   *
   * Los dos caminos existen porque cuestan cosas muy distintas. `candles` se
   * pinta con `setData()`, que rehace la serie entera —hasta 600 barras— y
   * vuelve a fijar la escala: correcto al cargar y al cambiar de resolucion,
   * ruinoso varias veces por segundo. `liveBar` se aplica con `update()`, que
   * es la funcion que la libreria tiene para esto: reemplaza la ultima barra si
   * el tiempo coincide y anade una nueva si es posterior.
   *
   * Meter la vela viva dentro de `candles` habria sido mas corto de escribir y
   * habria disparado un `setData` de 600 barras por cada tick.
   */
  readonly liveBar = input<Candle | null>(null);

  /**
   * Valores bajo la cruceta.
   *
   * Es un signal publico y no un `output`: en un movil no hay hover, la cruceta
   * se activa con pulsacion larga y los valores se leen en una leyenda FIJA
   * arriba del grafico, no en un globo flotante que el dedo tapa. El padre lo
   * lee directamente.
   */
  readonly readout = signal<ChartReadout | null>(null);
  readonly ready = signal(false);

  /**
   * «Al usuario se le esta acabando el pasado en pantalla».
   *
   * Es una SALIDA y no una peticion: este fichero es el unico del proyecto que
   * importa `lightweight-charts`, y la otra mitad de ese contrato es que no sabe
   * nada de red. Quien decide si pedir, a quien y con que limites es la pagina,
   * que es ademas quien conoce las cuatro cosas que invalidan un historico
   * —venue, par, intervalo y red—.
   */
  readonly needHistory = output<void>();

  /**
   * La escala de precios la ha puesto el usuario a mano.
   *
   * Publica porque la lee la plantilla —para el boton AUTO— y tambien la pagina,
   * que ofrece la misma vuelta desde su hoja de ajustes.
   */
  readonly userScaled = signal(false);

  private chart: IChartApi | null = null;
  private main: ISeriesApi<SeriesType> | null = null;
  private volume: ISeriesApi<'Histogram'> | null = null;
  private avgSeries: ISeriesApi<'Line'> | null = null;
  private resultSeries: ISeriesApi<'Baseline'> | null = null;
  /** El motor, una vez cargado: las series auxiliares se crean tarde y lo necesitan. */
  private lw: typeof import('lightweight-charts') | null = null;
  /** Con volumen el panel de resultado es el tercero; sin él, el segundo. */
  private hasVolume = false;
  private markersApi: ISeriesMarkersPluginApi<Time> | null = null;
  private priceLines: IPriceLine[] = [];
  /**
   * Los trazos del motor grafico, traducidos.
   *
   * `bot-overlay.ts` habla de trazos con nombre —'solid', 'dashed'…— para no
   * depender de la libreria, y el enum solo existe dentro del `import()`
   * perezoso. Se resuelve una vez al construir el grafico en vez de repetir los
   * numeros crudos, que es lo que habia antes (`lineStyle: dashed ? 2 : 0`) y no
   * dice nada al leerlo.
   */
  private lineStyles: Record<OverlayStyle, number> | null = null;
  private observer: ResizeObserver | null = null;
  /** Ultimo tiempo emitido: la cruceta dispara en cada pixel, la vela no cambia. */
  private lastReadoutTime = -1;
  private disposed = false;
  /**
   * Contador de reconstrucciones.
   *
   * `rebuild` es asincrono —espera al `import()` del motor— y se dispara mas de
   * una vez por carga: los decimales empiezan en 2 y pasan al valor real en
   * cuanto llega la ficha del mercado. Sin esta guarda, la primera llamada
   * resucita despues de la segunda y crea un SEGUNDO grafico sobre el mismo
   * contenedor: dos lienzos superpuestos y el primero huerfano, con su
   * ResizeObserver y su suscripcion a la cruceta vivos para siempre.
   */
  private generation = 0;
  /**
   * Marcas de la ultima barra pintada.
   *
   * `lastSetAt` es la de la serie completa —null hasta el primer `setData`— y
   * `lastAppliedAt` incluye tambien las velas vivas. Las dos hacen falta: la
   * primera dice si ya hay sobre que pintar, la segunda impide aplicar una
   * barra hacia atras, que es lo que hace saltar a la libreria.
   */
  private lastSetAt: number | null = null;
  private lastAppliedAt = 0;

  /**
   * Timestamp de la PRIMERA barra pintada.
   *
   * Es como se detecta que la pagina ha antepuesto historico, y se prefiere a
   * una entrada nueva —un contador de paginas, por ejemplo— porque `candles` se
   * escribe desde SEIS sitios distintos de la pagina: si alguno olvidara
   * incrementar el contador, la funcion dejaria de rearmarse en silencio. Este
   * valor sale del propio dato y no puede quedarse obsoleto.
   */
  private firstBarAt: number | null = null;

  /**
   * Ya se pidio historico y todavia no ha llegado.
   *
   * Pestillo, no antirrebote. `subscribeVisibleLogicalRangeChange` dispara UNA
   * VEZ POR FOTOGRAMA mientras se arrastra, asi que un `debounceTime` seguiria
   * dejando pasar varias emisiones mientras un impulso largo se detiene. El
   * pestillo emite como mucho una vez por pagina aceptada y no gasta ni un
   * temporizador.
   */
  private historyAsked = false;

  /**
   * Indice por tiempo de la serie pintada.
   *
   * Existe por la cruceta: `emitReadout` buscaba la vela con un `find` lineal, y
   * eso se ejecuta UNA VEZ POR BARRA CRUZADA. Con 300 barras un arrastre rapido
   * son unas 45 000 comparaciones; con historico cargado y 3 000 barras son 4,5
   * MILLONES, en el hilo principal y en mitad del gesto.
   */
  private byTime = new Map<number, Candle>();

  /**
   * Espejo plano de `userScaled`, y no es duplicar por gusto.
   *
   * `applyScale` se llama desde DENTRO de dos efectos. Leer alli la señal la
   * convertiria en dependencia suya, y entonces cada vez que el usuario tocara
   * la escala se volveria a ejecutar el efecto entero — con su `setData()` de
   * trescientas barras. El campo es la autoridad; la señal solo sirve para
   * pintar.
   */
  private manual = false;

  /**
   * El ultimo encuadre que se pidio, lo hayamos aplicado o no.
   *
   * Se guarda aunque el ajuste manual mande, porque es a lo que hay que volver
   * al pulsar AUTO: en un bot, «automatico» no es el autoescalado crudo de la
   * libreria sino la escalera entera encajada.
   */
  private currentSpan: { min: number; max: number } | null = null;

  /** Suelta las escuchas del gesto del eje al reconstruir o al destruir. */
  private axisGesture: AbortController | null = null;

  constructor() {
    // Un solo efecto para el ciclo de vida: crear al primer dato y, si cambia
    // el tipo de serie, recrear. Angular lo vuelve a ejecutar solo cuando alguna
    // de las senales leidas cambia.
    effect(() => {
      const kind = this.kind();
      const decimals = this.priceDecimals();
      const withVolume = this.showVolume();
      void this.rebuild(kind, decimals, withVolume);
    });

    effect(() => {
      // Los tres se leen AQUI y se pasan como argumentos. Leerlos dentro de
      // `applyCandles` los convertia igualmente en dependencias del efecto,
      // pero sin que se viera: el que lee esto no podia saber cuando vuelve a
      // correr.
      this.applyCandles(this.candles(), this.kind(), this.fitSpan());
    });

    effect(() => {
      // `kind` se lee AQUI aunque `applyLive` no lo reciba: al cambiar de tipo
      // de serie el grafico se reconstruye y la vela viva hay que volver a
      // ponerla, o desaparece hasta el siguiente tick.
      this.applyLive(this.liveBar(), this.kind());
    });

    effect(() => {
      const lines = this.lines();
      const markers = this.markers();
      const events = this.events();
      const span = this.fitSpan();
      this.applyOverlay(lines, markers, events, span);
    });

    // Las dos series auxiliares, cada una con su efecto: vacías no crean nada.
    effect(() => {
      this.applyAverage(this.average());
    });
    effect(() => {
      this.applyResult(this.result());
    });

    // Cambia lo que se esta mirando -> se suelta el ajuste manual.
    //
    // La primera pasada solo toma nota: al nacer el componente no hay nada que
    // soltar, y forzar el encuadre aqui pelearia con el que ya hace `rebuild`.
    let claveAnterior: string | null = null;
    effect(() => {
      const clave = this.scaleKey();
      if (claveAnterior === null) {
        claveAnterior = clave;
        return;
      }
      if (claveAnterior === clave) return;
      claveAnterior = clave;
      untracked(() => this.resetScale());
    });

    this.destroyRef.onDestroy(() => {
      // Antes del teardown: `rebuild` espera a un `import()` dinamico y, si la
      // pantalla se cierra mientras esa promesa esta en vuelo, sin esta marca
      // crearia un grafico sobre un DOM que ya no existe y lo dejaria vivo —
      // con su ResizeObserver y su suscripcion a la cruceta.
      this.disposed = true;
      this.teardown();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Ciclo de vida del grafico
  // ═══════════════════════════════════════════════════════════════

  private async rebuild(
    kind: ChartSeriesKind,
    decimals: number,
    withVolume: boolean,
  ): Promise<void> {
    const gen = ++this.generation;
    this.teardown();
    if (this.disposed) return;

    const lw = await import('lightweight-charts');
    // Si mientras se cargaba el motor entro otra reconstruccion, esta ya no
    // manda: se abandona sin tocar nada.
    if (this.disposed || gen !== this.generation) return;

    this.lineStyles = {
      solid: lw.LineStyle.Solid,
      dotted: lw.LineStyle.Dotted,
      dashed: lw.LineStyle.Dashed,
      largeDashed: lw.LineStyle.LargeDashed,
    };

    const p = chartPalette();
    const container = this.host().nativeElement;

    // TODO EL MOTOR VIVE FUERA DE LA ZONA DE ANGULAR.
    // La cruceta emite en cada movimiento del puntero; dentro de la zona eso
    // dispararia una deteccion de cambios por cada `mousemove`, con la app
    // entera repintandose mientras se arrastra el grafico.
    this.zone.runOutsideAngular(() => {
      const chart = lw.createChart(container, {
        layout: {
          background: { color: 'transparent' },
          textColor: p.text,
          attributionLogo: false,
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: p.grid, style: lw.LineStyle.Solid },
          horzLines: { color: p.grid, style: lw.LineStyle.Solid },
        },
        rightPriceScale: {
          borderColor: p.grid,
          scaleMargins: { top: 0.08, bottom: 0.08 },
          // Sin esto, la primera y la ultima etiqueta del eje salen cortadas por
          // la mitad cuando caen pegadas al borde.
          entireTextOnly: true,
        },
        timeScale: { borderColor: p.grid, timeVisible: true, secondsVisible: false },
        crosshair: {
          mode: lw.CrosshairMode.Normal,
          vertLine: {
            color: p.crosshair,
            width: 1,
            style: lw.LineStyle.Dashed,
            labelBackgroundColor: p.crosshair,
          },
          horzLine: {
            color: p.crosshair,
            width: 1,
            style: lw.LineStyle.Dashed,
            labelBackgroundColor: p.crosshair,
          },
        },
        localization: { locale: 'es-ES' },

        // ── EL AJUSTE QUE DECIDE SI ESTO SE PUEDE USAR EN UN MOVIL ──
        // Por defecto el grafico se queda con TODOS los gestos tactiles, y la
        // pagina de Ionic que lo contiene deja de poder desplazarse: el dedo
        // arrastra el grafico y la pantalla no se mueve. Con `vertTouchDrag`
        // apagado, el arrastre VERTICAL vuelve a la pagina y el HORIZONTAL
        // sigue moviendo el grafico, que es el reparto que espera cualquiera
        // que haya usado una app de exchange.
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        handleScale: {
          mouseWheel: true,
          pinch: true,
          // El reescalado del eje lo lleva `attachAxisGesture`, no la libreria.
          //
          // Se dejo apagado en su dia porque en un movil convertia cualquier
          // roce del pulgar en el borde en un zoom accidental, y ademas era
          // inalcanzable con el dedo: el widget del eje descarta el arrastre
          // vertical mientras `handleScroll.vertTouchDrag` este en false. El
          // gesto propio arregla las dos cosas —umbral de por medio y sin tocar
          // el desplazamiento de la pagina sobre el lienzo—, asi que esto se
          // queda apagado para que no haya dos implementaciones compitiendo.
          axisPressedMouseMove: false,
          // El doble clic del eje de TIEMPO si es de la libreria. El del eje de
          // precios no: el suyo devuelve autoescalado crudo, y en un grafico
          // abierto desde un bot lo correcto es reencajar la escalera entera.
          axisDoubleClickReset: { time: true, price: false },
        },
      });

      const priceFormat = {
        type: 'price' as const,
        precision: decimals,
        minMove: Math.pow(10, -decimals),
      };

      const main = this.createMain(lw, chart, kind, p, priceFormat);

      if (withVolume) {
        // Panel propio para el volumen: superpuesto sobre el precio aplasta las
        // velas y no se lee ninguna de las dos cosas.
        const vol = chart.addSeries(
          lw.HistogramSeries,
          { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
          1,
        );
        chart.panes()[1]?.setHeight(Math.round(container.clientHeight * 0.18));
        this.volume = vol;
      }

      chart.subscribeCrosshairMove((param) => {
        this.emitReadout(param.time as UTCTimestamp | undefined);
      });

      // Historico perezoso. No hace falta desuscribir a mano: `chart.remove()`
      // en `teardown()` se lleva esta igual que la de la cruceta.
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        this.onRangeChange(range, gen);
      });

      this.chart = chart;
      this.main = main;
      // `zOrder: 'aboveSeries'` y no el reparto por defecto: ahora que el
      // marcador se ancla al PRECIO de la ejecucion, cae dentro del cuerpo de
      // su propia vela, y con el orden normal la vela lo tapaba entero.
      this.markersApi = lw.createSeriesMarkers(main, [], { zOrder: 'aboveSeries' });
      this.lw = lw;
      this.hasVolume = withVolume;

      // El ancho no se fija una vez: girar el movil, abrir el teclado o entrar
      // en apaisado cambian la caja, y sin esto el grafico se queda con el
      // tamano que tenia al nacer.
      this.observer = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
      });
      this.observer.observe(container);
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });

      // Va aqui dentro, con el resto del motor fuera de la zona de Angular: el
      // arrastre emite en cada pixel y dentro de la zona dispararia una
      // deteccion de cambios por movimiento.
      this.attachAxisGesture(chart, gen);
    });

    // Los datos que ya hubiera cuando el motor todavia estaba cargando.
    this.applyCandles(this.candles(), kind, this.fitSpan());
    this.applyOverlay(this.lines(), this.markers(), this.events(), this.fitSpan());
    this.applyAverage(this.average());
    this.applyResult(this.result());
    this.ready.set(true);
  }

  private createMain(
    lw: typeof import('lightweight-charts'),
    chart: IChartApi,
    kind: ChartSeriesKind,
    p: ReturnType<typeof chartPalette>,
    priceFormat: { type: 'price'; precision: number; minMove: number },
  ): ISeriesApi<SeriesType> {
    switch (kind) {
      case 'bars':
        return chart.addSeries(lw.BarSeries, {
          upColor: p.up,
          downColor: p.down,
          thinBars: false,
          priceFormat,
        });
      case 'line':
        return chart.addSeries(lw.LineSeries, {
          color: p.crosshair,
          lineWidth: 2,
          priceFormat,
        });
      case 'area':
        return chart.addSeries(lw.AreaSeries, {
          lineColor: p.crosshair,
          topColor: 'rgba(34, 211, 238, .28)',
          bottomColor: 'rgba(34, 211, 238, 0)',
          lineWidth: 2,
          priceFormat,
        });
      default:
        return chart.addSeries(lw.CandlestickSeries, {
          upColor: p.up,
          downColor: p.down,
          borderUpColor: p.up,
          borderDownColor: p.down,
          wickUpColor: p.up,
          wickDownColor: p.down,
          priceFormat,
        });
    }
  }

  private teardown(): void {
    this.observer?.disconnect();
    this.observer = null;
    // El gesto del eje muere con su grafico: las escuchas cuelgan de un elemento
    // que `chart.remove()` se lleva por delante.
    this.axisGesture?.abort();
    this.axisGesture = null;
    // Y con el se suelta el ajuste manual. Se reconstruye al cambiar el tipo de
    // serie, los decimales o el panel de volumen: la escala anterior ya no
    // existe, asi que conservar la marca dejaria el boton AUTO encendido sin
    // nada que deshacer. Efecto visible: apagar el volumen pierde el zoom
    // manual. Es coherente —se ha rehecho el grafico— pero conviene saberlo.
    this.manual = false;
    this.userScaled.set(false);
    // El pestillo del historico tambien: el grafico nuevo nace sin serie, asi
    // que una peticion pendiente del anterior ya no significa nada.
    this.historyAsked = false;
    this.firstBarAt = null;
    this.byTime = new Map();
    this.priceLines = [];
    this.markersApi = null;
    this.volume = null;
    this.avgSeries = null;
    this.resultSeries = null;
    this.lw = null;
    this.main = null;
    try {
      this.chart?.remove();
    } catch {
      /* ya destruido */
    }
    this.chart = null;
    this.ready.set(false);
    this.lastReadoutTime = -1;
    // Sin serie no hay sobre que pintar: la vela viva vuelve a esperar al
    // primer `setData`. `rebuild` lo hace justo despues, pero dejar el contador
    // apuntando a la serie ANTERIOR haria que una vela que llegue en ese hueco
    // se pintara sola sobre un grafico vacio.
    this.lastSetAt = null;
    this.lastAppliedAt = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // Datos
  // ═══════════════════════════════════════════════════════════════

  /**
   * Pinta la vela en formacion sin rehacer la serie.
   *
   * Con dos guardas que no son opcionales:
   *
   * · Hacia ATRAS no se aplica. La libreria exige que el tiempo sea mayor o
   *   igual que el de la ultima barra y LANZA si no lo es. Comprobado contra la
   *   libreria de verdad: el grafico SOBREVIVE al fallo y se sigue pudiendo
   *   pintar, asi que lo que hay que evitar no es un grafico roto sino que la
   *   excepcion salga del efecto de Angular. Una vela fuera de orden —una
   *   reconexion, el reloj del venue— llega; que reviente el efecto, no.
   *
   * · Antes del primer `setData` tampoco. Una barra suelta sobre una serie
   *   vacia pinta un grafico de UNA vela y, al llegar la serie, un salto.
   */
  private applyLive(bar: Candle | null, kind: ChartSeriesKind): void {
    const series = this.main;
    if (!series || !bar || this.lastSetAt === null) return;
    if (bar.t < this.lastAppliedAt) return;
    this.lastAppliedAt = bar.t;

    const line = kind === 'line' || kind === 'area';
    this.zone.runOutsideAngular(() => {
      series.update(
        line
          ? { time: toTime(bar.t), value: Number(bar.c) }
          : {
              time: toTime(bar.t),
              open: Number(bar.o),
              high: Number(bar.h),
              low: Number(bar.l),
              close: Number(bar.c),
            },
      );
      this.volume?.update({
        time: toTime(bar.t),
        value: Number(bar.v ?? 0),
        color:
          Number(bar.c) >= Number(bar.o) ? 'rgba(45, 212, 167, .28)' : 'rgba(240, 97, 109, .28)',
      });
    });
  }

  private applyCandles(
    candles: Candle[],
    kind: ChartSeriesKind,
    span: { min: number; max: number } | null,
  ): void {
    const series = this.main;
    if (!series || candles.length === 0) return;

    // El motor exige tiempos ESTRICTAMENTE crecientes y unicos; uno repetido
    // lanza y deja el grafico vacio. La API ya los normaliza, pero al fusionar
    // la vela viva con la serie cacheada puede repetirse la ultima.
    const clean = dedupeAscending(candles);
    const line = kind === 'line' || kind === 'area';

    // ¿Ha crecido la serie por DELANTE? Es historico recien cargado.
    //
    // Anteponer no descoloca el viewport, y esto se comprobo leyendo el motor de
    // la 5.2.1 y no la documentacion: `updateTimeScale` se salta su compensacion
    // cuando la primera vela es mas antigua que la anterior, y el viewport se
    // ancla en `rightOffset + baseIndex`, no en un rango logico absoluto. Al
    // subir `baseIndex` en N, la ventana cubre exactamente las mismas barras.
    //
    // Por eso NO se captura y repone `setVisibleLogicalRange`: eso pasa por
    // `setVisibleRange`, que recalcula `barSpacing`, y un rango con una fraccion
    // de diferencia rezoomaria el grafico en mitad del arrastre. Seria una
    // regresion a cambio de nada.
    const anterior = this.firstBarAt;
    const prepend =
      anterior !== null &&
      clean[0].t < anterior &&
      // Y la cola intacta: si tambien cambio el final no fue un prepend puro
      // —es un cambio de intervalo o de par— y toca reencuadrar de verdad.
      clean[clean.length - 1].t === this.lastSetAt;
    this.firstBarAt = clean[0].t;
    if (prepend) this.historyAsked = false;

    this.byTime = new Map(clean.map((c) => [c.t, c]));

    this.zone.runOutsideAngular(() => {
      series.setData(
        clean.map((c) =>
          line
            ? { time: toTime(c.t), value: Number(c.c) }
            : {
                time: toTime(c.t),
                open: Number(c.o),
                high: Number(c.h),
                low: Number(c.l),
                close: Number(c.c),
              },
        ),
      );

      this.volume?.setData(
        clean.map((c) => ({
          time: toTime(c.t),
          value: Number(c.v ?? 0),
          color: Number(c.c) >= Number(c.o) ? 'rgba(45, 212, 167, .28)' : 'rgba(240, 97, 109, .28)',
        })),
      );

      // La serie manda sobre la vela viva: tras un `setData` la ultima barra
      // pintada es la suya, y el contador vuelve ahi. Sin esto, cambiar de 1h a
      // 1m dejaria el listón en el tiempo de una vela horaria y ninguna vela de
      // minuto llegaria a aplicarse nunca.
      const ultima = clean[clean.length - 1];
      this.lastSetAt = ultima ? ultima.t : null;
      this.lastAppliedAt = this.lastSetAt ?? 0;

      // Se REAPLICA el rango despues de cada `setData`.
      //
      // No es redundante: la vela viva se refresca cada cinco segundos, y ese
      // efecto solo depende de `candles`, asi que el de la capa no vuelve a
      // correr. Sin esto, el grafico abierto desde un bot se reajustaba solo a
      // las velas al primer refresco y la escalera se salia de pantalla — con
      // el usuario mirando, y sin que nada pareciera haber cambiado.
      //
      // Salvo al anteponer historico: ahi las barras VISIBLES son las mismas, y
      // sin bot (`span` nulo) esto seria `setAutoScale(true)` sobre un conjunto
      // de datos mas ancho — los precios pegarian un salto vertical en cada
      // pagina cargada, en mitad del gesto del usuario.
      if (!prepend) this.applyScale(span);
    });
  }

  /**
   * Fija el rango vertical, o devuelve el autoescalado.
   *
   * Apagar el autoescalado ANTES de fijar el rango no es opcional: con el
   * encendido, el motor recalcula la escala en el siguiente pintado y el rango
   * que se acaba de fijar desaparece sin dejar rastro.
   */
  /**
   * Encuadra la escala de precios.
   *
   * @param opts.force salta la guarda del ajuste manual. Solo lo usa
   *   `resetScale()`, que es la vuelta explicita al automatico.
   */
  private applyScale(
    span: { min: number; max: number } | null,
    opts: { force?: boolean } = {},
  ): void {
    // SIEMPRE, y antes de la guarda: aunque ahora mismo no se aplique, este es
    // el encuadre al que hay que volver cuando el usuario pulse AUTO.
    this.currentSpan = span;

    // El ajuste manual manda.
    //
    // Sin esta linea, tocar la escala no servia de nada: esto se llama al final
    // de `applyCandles` y de `applyOverlay`, o sea al cerrar cada vela (30-60 s)
    // y con cada evento del bot (1,5 s, porque `fitSpan` llega como objeto
    // nuevo aunque los numeros sean los mismos). El rango que acababa de poner
    // el usuario desaparecia sin dejar rastro, y sin bot era peor todavia: la
    // rama de abajo reactivaba el autoescalado, que es literalmente deshacerlo.
    if (this.manual && !opts.force) return;

    const series = this.main;
    if (!series) return;
    const scale = series.priceScale();
    if (span && span.max > span.min) {
      // Margenes relativos para que las lineas extremas no queden pegadas al
      // borde, donde su etiqueta se recorta.
      const pad = Math.max((span.max - span.min) * 0.12, span.max * 0.002);
      scale.setAutoScale(false);
      scale.setVisibleRange({ from: span.min - pad, to: span.max + pad });
    } else {
      scale.setAutoScale(true);
    }
  }

  /** Marca o suelta el ajuste manual. La señal se escribe DENTRO de la zona. */
  private setManual(on: boolean): void {
    if (this.manual === on) return;
    this.manual = on;
    this.zone.run(() => this.userScaled.set(on));
  }

  /**
   * Vuelve al encuadre automatico.
   *
   * Publico: lo llaman el boton AUTO, el doble toque sobre el eje y la hoja de
   * ajustes de la pagina. Y no es `setAutoScale(true)`: en un grafico abierto
   * desde un bot, «automatico» significa la escalera entera encajada, que es lo
   * que guarda `currentSpan`. Devolverlo al autoescalado crudo dejaria fuera de
   * pantalla justo las ordenes que se venia a mirar.
   */
  resetScale(): void {
    this.setManual(false);
    this.applyScale(this.currentSpan, { force: true });
  }

  /**
   * El arrastre sobre el eje de precios.
   *
   * Se implementa a mano en vez de encender el gesto de la libreria, y no por
   * gusto. `handleScroll.vertTouchDrag` esta apagado para que la pagina de Ionic
   * se pueda desplazar arrastrando sobre el grafico —ver la nota de las opciones
   * de `createChart`— y resulta que el widget del eje construye su manejador con
   * `treatVertTouchDragAsPageScroll: () => !vertTouchDrag`, asi que esa misma
   * bandera descarta tambien el arrastre tactil SOBRE EL EJE. Encenderla para
   * recuperar el gesto habria costado el desplazamiento de la pagina en toda la
   * superficie del grafico; hacerlo aqui lo cuesta solo en una franja de ~55 px.
   *
   * La zona sensible es la celda del eje que crea la propia libreria, no un
   * elemento superpuesto: superponer uno taparia sus dos lienzos y con ellos la
   * etiqueta de la cruceta sobre el eje.
   */
  private attachAxisGesture(chart: IChartApi, gen: number): void {
    // Depende de la ESTRUCTURA INTERNA de la libreria: el panel es un <tr> y su
    // ultima celda es el eje derecho. `getHTMLElement()` si es API publica. Si
    // una version futura cambia el reparto, las guardas dejan la app sin gesto
    // pero sin romper nada — que es la degradacion correcta para un accesorio.
    const fila = chart.panes()[0]?.getHTMLElement();
    const eje = fila?.lastElementChild;
    if (!(eje instanceof HTMLElement) || eje.tagName !== 'TD') return;

    // En TypeScript y no en la hoja de estilos: no gasta presupuesto de CSS por
    // componente, no necesita `::ng-deep` para alcanzar un elemento de la
    // libreria, y se va solo cuando el grafico se destruye. Sin esto, el
    // navegador se queda el arrastre vertical para desplazar la pagina y el
    // gesto no llega nunca.
    eje.style.touchAction = 'none';

    const ac = new AbortController();
    this.axisGesture = ac;
    const { signal } = ac;

    /** Estado del arrastre en curso. null = no hay ninguno. */
    let drag: {
      id: number;
      alto: number;
      /** Borde superior del eje. Se mide UNA vez: ver la nota de `pointermove`. */
      top: number;
      desde: number;
      centro: number;
      semi: number;
      arrastrando: boolean;
    } | null = null;
    /** Para el doble toque: cuando termino el ultimo toque corto. */
    let ultimoToque = 0;

    const scaleApi = () => this.main?.priceScale() ?? null;

    eje.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        if (gen !== this.generation) return;
        const scale = scaleApi();
        if (!scale) return;
        // Porcentaje o logaritmica: la formula de abajo es la de la escala
        // normal. Hoy no se usan otras, pero es una linea.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- 0 es PriceScaleMode.Normal; importar el enum solo para esto arrastraria el paquete entero al bundle
        if (scale.options().mode !== 0) return;
        const rango = scale.getVisibleRange();
        if (!rango || !(rango.to > rango.from)) return;

        const caja = eje.getBoundingClientRect();
        if (caja.height <= 1) return;

        drag = {
          id: e.pointerId,
          alto: caja.height,
          top: caja.top,
          desde: caja.height - (e.clientY - caja.top),
          centro: (rango.from + rango.to) / 2,
          semi: (rango.to - rango.from) / 2,
          arrastrando: false,
        };
        // Con captura, el `pointerup` llega aunque el dedo salga del eje. Sin
        // ella habria que escuchar en `document` y limpiar a mano.
        eje.setPointerCapture(e.pointerId);
      },
      { signal },
    );

    eje.addEventListener(
      'pointermove',
      (e: PointerEvent) => {
        if (!drag || e.pointerId !== drag.id) return;
        // La caja se midio al empezar y NO se vuelve a medir: el eje no se mueve
        // durante un arrastre, y `getBoundingClientRect()` fuerza al navegador a
        // recalcular la maquetacion — una vez por movimiento, o sea sesenta
        // veces por segundo en el peor caso.
        const y = e.clientY - drag.top;

        if (!drag.arrastrando) {
          // Umbral: por debajo de esto es un toque, no un arrastre. Sin el, el
          // repunte del dedo al levantarlo movia la escala y el doble toque no
          // llegaba a registrarse nunca.
          if (Math.abs(drag.alto - y - drag.desde) < DRAG_THRESHOLD_PX) return;
          drag.arrastrando = true;
          // Unica entrada en la zona de Angular del gesto entero: en
          // `pointermove` no se escribe ninguna señal, o la app repintaria a
          // sesenta fotogramas por segundo.
          this.setManual(true);
        }

        const scale = scaleApi();
        if (!scale) return;

        // La formula es la de `PriceScale.scaleTo` de la libreria, para que el
        // gesto propio se sienta exactamente igual que el nativo. La Y va
        // invertida, que es lo que hace que ARRIBA EXPANDA: subir el dedo
        // agranda `x`, encoge el coeficiente y estrecha el rango, o sea estira
        // las velas.
        const k = 0.2 * (drag.alto - 1);
        const x = clamp(drag.alto - y, 0, drag.alto);
        const coeff = clamp((drag.desde + k) / (x + k), 0.1, 10);

        // Tope inferior atado al tick del mercado: sin el, arrastrar a fondo en
        // un par que cotiza a 0,00004182 degenera el rango a anchura cero y el
        // grafico se queda en blanco.
        const minimo = Math.max(drag.semi * 0.02, 5 * 10 ** -this.priceDecimals());
        const semi = clamp(drag.semi * coeff, minimo, drag.semi * 20);
        const from = drag.centro - semi;
        scale.setVisibleRange({
          // Un precio negativo no existe, pero solo se acota si el rango de
          // partida ya era positivo: hay series (un PnL) donde el cero es medio.
          from: drag.centro - drag.semi >= 0 ? Math.max(0, from) : from,
          to: drag.centro + semi,
        });
      },
      { signal },
    );

    const terminar = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      const eraArrastre = drag.arrastrando;
      drag = null;
      if (eje.hasPointerCapture(e.pointerId)) eje.releasePointerCapture(e.pointerId);
      if (eraArrastre) return;

      // Toque corto: cuenta para el doble toque, que es la vuelta al encuadre
      // automatico. Lo implementamos nosotros porque el de la libreria devuelve
      // autoescalado CRUDO —que en un bot no es el encuadre bueno— y ademas no
      // limpiaria la marca de ajuste manual.
      const ahora = e.timeStamp;
      if (ahora - ultimoToque < DOUBLE_TAP_MS) {
        ultimoToque = 0;
        this.zone.run(() => this.resetScale());
      } else {
        ultimoToque = ahora;
      }
    };

    eje.addEventListener('pointerup', terminar, { signal });
    // `pointercancel` cierra igual: una llamada entrante o un gesto del sistema
    // se lo lleva a media faena, y sin esto el arrastre siguiente partiria de
    // una instantanea vieja.
    eje.addEventListener(
      'pointercancel',
      (e: PointerEvent) => {
        if (drag && e.pointerId === drag.id) drag = null;
      },
      { signal },
    );
  }

  private applyOverlay(
    lines: OverlayLine[],
    markers: OverlayMarker[],
    events: OverlayEventMarker[],
    span: { min: number; max: number } | null,
  ): void {
    const series = this.main;
    if (!series) return;
    const o = overlayPalette();

    this.zone.runOutsideAngular(() => {
      for (const pl of this.priceLines) {
        try {
          series.removePriceLine(pl);
        } catch {
          /* la serie pudo recrearse entre medias */
        }
      }
      const estilo = this.lineStyles;

      // Menos marcas de escala cuando hay capa de bot.
      //
      // El espaciado que reparte la libreria es `fontSize x tickMarkDensity`:
      // con letra de 10 px y densidad 2,5 salen unos 25 px por etiqueta, o sea
      // entre diez y dieciseis en la altura del grafico. Sumadas a las N+2 del
      // bot, el eje se vuelve una columna de numeros pisandose unos a otros
      // —«SAF#2 2404,38» encima de «2400,00»—. Subir a 4 deja unos 40 px y
      // reduce las de escala a la mitad, que es sitio de sobra para las del bot
      // sin que el eje se quede sin referencias. Por encima de 5 si se queda
      // desnudo.
      series.priceScale().applyOptions({ tickMarkDensity: lines.length >= 4 ? 4 : 2.5 });

      this.priceLines = lines.map((l) => {
        // Los niveles planificados van atenuados: el TONO dice de que es la
        // linea y la INTENSIDAD dice si ya esta puesta en el exchange.
        const color = l.ghost ? fade(o[l.kind], 0.45) : o[l.kind];
        return series.createPriceLine({
          price: l.price,
          color,
          lineWidth: l.width,
          // Sin mapa todavia (overlay aplicado antes de que el motor cargue) cae
          // a continua: una linea de mas se ve, una linea que no se dibuja no.
          lineStyle: estilo ? estilo[l.style] : 0,
          lineVisible: true,
          // Quien lleva etiqueta en el eje lo decide `bot-overlay.ts`
          // (`conRotulos`): los previstos nunca, y de la escalera solo los
          // extremos cuando hay mas de cuatro ordenes. Su precio exacto importa
          // menos que el de las lineas que dicen donde se acaba la partida, y el
          // ancho del eje lo decide la etiqueta mas larga: quitar rotulos
          // devuelve ancho al grafico. Sin decision (`axisLabel` ausente) vale la
          // regla de antes, `!ghost`.
          axisLabelVisible: l.axisLabel ?? !l.ghost,
          // El rotulo del nivel va en el eje, junto al precio: es donde lo pone
          // cualquier terminal y donde no tapa las velas.
          title: l.title,
          axisLabelColor: color,
          axisLabelTextColor: o.onLight,
        });
      });

      // Marcadores ANCLADOS AL PRECIO de la ejecucion.
      //
      // Antes iban `aboveBar`/`belowBar`, asi que decian cuando se ejecuto pero
      // no a que precio — que es justo la pregunta que se hace mirando un
      // grafico. La v5 de la libreria trae el anclaje por precio de serie
      // (`SeriesMarkerPrice`), asi que no hacen falta series extra.
      //
      // `atPriceMiddle` y no `atPriceTop`/`Bottom`: el centro del marcador cae
      // EN el precio; las otras dos lo desplazan media altura y vuelven a
      // mentir, solo que menos.
      const ejecuciones = markers.map((m): SeriesMarkerPrice<Time> => ({
        time: toTime(m.timeMs),
        position: 'atPriceMiddle',
        price: m.price,
        // Un circulo cuando el marcador AGRUPA varias ejecuciones: una
        // flecha sugiere una operacion concreta, y ahi hay un promedio.
        shape: m.count > 1 ? 'circle' : m.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        color: m.side === 'BUY' ? o.buy : o.sell,
        text: m.text,
        size: m.count >= 3 ? 2 : 1,
      }));
      // Los sucesos van SOBRE la vela, no en un precio: ocurren en un instante.
      // Cuadrado ambar para lo grave —el mismo ambar que el stop—, circulo del
      // color de la cruceta para lo que solo explica (spec 005, R-2).
      const sucesos = events.map((e): SeriesMarkerBar<Time> => ({
        time: toTime(e.timeMs),
        position: 'aboveBar',
        shape: e.tone === 'warn' ? 'square' : 'circle',
        color: e.tone === 'warn' ? o.stopLoss : o.average,
        text: e.text,
        size: e.count >= 3 ? 2 : 1,
      }));
      // El motor exige los marcadores en orden de tiempo, y las dos listas
      // vienen ordenadas por separado.
      const todos: SeriesMarker<Time>[] = [...ejecuciones, ...sucesos].sort(
        (a, b) => (a.time as number) - (b.time as number),
      );
      this.markersApi?.setMarkers(todos);

      this.applyScale(span);
    });
  }

  /**
   * El precio medio como serie en el panel del precio (spec 005, R-3).
   *
   * Se crea la primera vez que llegan puntos y se destruye cuando dejan de
   * llegar: sin bot, sin serie, sin coste. Los huecos (`v: null`) van como datos
   * en blanco del motor, que es como se rompe una linea sin inventar el tramo.
   * Lleva rotulo en el eje —el mismo «MEDIO» que la linea horizontal que
   * sustituye— y va sobre la misma escala que el precio.
   */
  private applyAverage(points: ChartLinePoint[]): void {
    const chart = this.chart;
    const lw = this.lw;
    if (!chart || !lw) return;
    this.zone.runOutsideAngular(() => {
      if (points.length === 0) {
        if (this.avgSeries) chart.removeSeries(this.avgSeries);
        this.avgSeries = null;
        return;
      }
      if (!this.avgSeries) {
        const o = overlayPalette();
        const decimals = untracked(() => this.priceDecimals());
        this.avgSeries = chart.addSeries(
          lw.LineSeries,
          {
            color: o.average,
            lineWidth: 1,
            lineStyle: lw.LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false,
            title: 'MEDIO',
            priceFormat: { type: 'price', precision: decimals, minMove: Math.pow(10, -decimals) },
          },
          0,
        );
      }
      this.avgSeries.setData(
        points.map((pt) =>
          pt.v === null ? { time: toTime(pt.t) } : { time: toTime(pt.t), value: pt.v },
        ),
      );
    });
  }

  /**
   * El resultado acumulado en un panel propio (spec 005, R-5).
   *
   * Serie de linea base con el CERO como base: verde por encima, rojo por
   * debajo, que es la unica lectura que importa de un resultado. Comparte el eje
   * de tiempo con el precio —eso lo da el motor con los paneles— y no tiene eje
   * de precio propio que arrastrar. Sin puntos no hay panel: el grafico es el de
   * siempre, con la misma altura.
   */
  private applyResult(points: ChartLinePoint[]): void {
    const chart = this.chart;
    const lw = this.lw;
    if (!chart || !lw) return;
    this.zone.runOutsideAngular(() => {
      if (points.length === 0) {
        if (this.resultSeries) {
          const idx = this.resultSeries.getPane().paneIndex();
          chart.removeSeries(this.resultSeries);
          // El panel no se va solo con su ultima serie: quedaria una franja en
          // blanco bajo el precio con el ajuste apagado. Se quita si esta vacio.
          const pane = chart.panes()[idx];
          if (pane && pane.getSeries().length === 0) chart.removePane(idx);
        }
        this.resultSeries = null;
        return;
      }
      if (!this.resultSeries) {
        const p = chartPalette();
        const pane = this.hasVolume ? 2 : 1;
        this.resultSeries = chart.addSeries(
          lw.BaselineSeries,
          {
            baseValue: { type: 'price', price: 0 },
            topLineColor: p.up,
            topFillColor1: fade(p.up, 0.28),
            topFillColor2: fade(p.up, 0.04),
            bottomLineColor: p.down,
            bottomFillColor1: fade(p.down, 0.04),
            bottomFillColor2: fade(p.down, 0.28),
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false,
            title: 'RESULTADO',
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
          },
          pane,
        );
        const container = this.host().nativeElement;
        chart.panes()[pane]?.setHeight(Math.round(container.clientHeight * 0.2));
      }
      this.resultSeries.setData(
        points.map((pt) =>
          pt.v === null ? { time: toTime(pt.t) } : { time: toTime(pt.t), value: pt.v },
        ),
      );
    });
  }

  /**
   * El viewport se ha movido. ¿Queda pasado por delante?
   *
   * Se decide con `barsBefore` y no con el `logicalRange.from < 10` de la demo
   * oficial: `from` es un indice logico que puede ser negativo por el margen
   * derecho y no dice nada sobre cuantos DATOS quedan, mientras que `barsBefore`
   * cuenta exactamente las barras que hay a la izquierda de lo visible — y se
   * vuelve negativo cuando ya se ve el hueco, que es justo la señal que
   * interesa.
   */
  private onRangeChange(range: LogicalRange | null, gen: number): void {
    // La guarda de generacion importa mas de lo que parece: `rebuild` corre mas
    // de una vez por carga —los decimales cambian al llegar la ficha del
    // mercado—, asi que sin ella el grafico moribundo emite su ultimo rango y
    // acto seguido el nuevo, vacio, emite otro con `barsBefore` casi cero.
    if (gen !== this.generation || this.disposed) return;
    if (range === null) return;
    // Sin serie no hay nada que ampliar. Misma guarda que usa `applyLive`.
    if (this.lastSetAt === null) return;

    const series = this.main;
    if (!series) return;
    const barsBefore = series.barsInLogicalRange(range)?.barsBefore;
    if (barsBefore === undefined || barsBefore === null) return;

    // Rearme ANTES del pestillo: si el usuario ha vuelto a la derecha y hay
    // margen de sobra, una pagina que fallo puede reintentarse con solo volver a
    // arrastrar. Sin esto, un fallo dejaria el pestillo echado para siempre.
    if (barsBefore > HISTORY_TRIGGER_BARS * 2) {
      this.historyAsked = false;
      return;
    }
    if (this.historyAsked) return;
    if (barsBefore > HISTORY_TRIGGER_BARS) return;

    this.historyAsked = true;
    // Entrar en la zona no es opcional: escribir desde fuera marca la vista
    // sucia pero nadie dispara la deteccion de cambios. Mismo motivo que
    // documenta `emitReadout`.
    this.zone.run(() => this.needHistory.emit());
  }

  /**
   * Llega desde el callback de la cruceta, que corre FUERA de la zona.
   *
   * El filtro por vela va antes de entrar en la zona y es lo que hace viable el
   * reparto: la cruceta dispara en cada pixel, pero dentro de una misma vela el
   * valor no cambia, asi que solo se entra en la zona —y se pinta la leyenda—
   * una vez por vela recorrida, no cientos de veces por arrastre.
   *
   * Entrar en la zona no es opcional. Con zone.js, escribir una senal desde
   * fuera marca la vista como sucia pero NADIE dispara la deteccion de cambios:
   * la senal cambiaba y la leyenda seguia enseñando la vela anterior hasta que
   * cualquier otro evento de la app repintara por casualidad.
   */
  private emitReadout(time: UTCTimestamp | undefined): void {
    if (time === undefined) {
      if (this.lastReadoutTime === -1) return;
      this.lastReadoutTime = -1;
      this.zone.run(() => this.readout.set(null));
      return;
    }
    if (time === this.lastReadoutTime) return;
    this.lastReadoutTime = time;

    const ms = (time as number) * 1000;
    // Indice y no `find`: ver el comentario de `byTime`. Con historico cargado
    // el barrido lineal costaba millones de comparaciones por arrastre.
    const c = this.byTime.get(ms);
    const next: ChartReadout | null = c
      ? {
          time: c.t,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
          up: Number(c.c) >= Number(c.o),
        }
      : null;
    this.zone.run(() => this.readout.set(next));
  }
}

/** ms epoch -> la escala del motor, que trabaja en SEGUNDOS. */
const toTime = (ms: number): UTCTimestamp => Math.floor(ms / 1000) as UTCTimestamp;

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

/** Orden ascendente estricto y sin repetidos, quedandose con la ultima version. */
function dedupeAscending(candles: Candle[]): Candle[] {
  // Comprobar primero y arreglar solo si hace falta.
  //
  // La entrada ya viene limpia por tres caminos —`finishCandles` en el
  // adaptador, `merge` en el servicio y el reductor de paginacion—, y el peligro
  // que justificaba rehacerlo siempre ya no existe: la vela en formacion viaja
  // por su PROPIA entrada (`liveBar`), nunca dentro de `candles`. Reconstruir un
  // Map y reordenar era gratis con 300 barras y deja de serlo con miles, varias
  // veces por arrastre.
  let limpio = true;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].t <= candles[i - 1].t) {
      limpio = false;
      break;
    }
  }
  if (limpio) return candles;

  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.t, c);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
