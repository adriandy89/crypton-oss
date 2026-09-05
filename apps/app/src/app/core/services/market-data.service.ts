import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { App as CapApp } from '@capacitor/app';
import { filter, firstValueFrom, map, type Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { NetworkService } from './network.service';
import { StreamService } from './stream.service';
import type {
  Candle,
  CandleInterval,
  MarketFeatures,
  MarketTicker,
  Venue,
  VenueCapabilities,
  VenueCapabilitiesMap,
} from '../models';

/**
 * Datos de mercado: capacidades, velas y precios de 24 h.
 *
 * Las tres cosas se cachean, pero cada una con una vida distinta, porque cada
 * una caduca por un motivo distinto:
 *
 *   capacidades  una vez por sesion — son estaticas por venue
 *   velas        por clave, con la ventana viva refrescandose
 *   precios      sondeo mientras hay alguien mirando, y solo mientras
 */
/** Lo que trae un mensaje de vela por el flujo. */
interface CandleEvent {
  venue?: Venue;
  symbol?: string;
  interval?: CandleInterval;
  candle?: Candle;
  /**
   * Red del venue. Se NORMALIZA a booleano al entrar (ver `candleEvents`), no se
   * deja opcional hacia dentro: un `undefined` que hay que traducir a «mainnet»
   * en cada comparacion es un olvido esperando a pasar, y el olvido aqui son dos
   * libros mezclados en el mismo grafico.
   */
  testnet?: boolean;
}

/** Lo que trae un mensaje de precio por el flujo. */
interface TickEvent {
  venue?: Venue;
  symbol?: string;
  last?: string;
  ts?: number;
  /** Red del venue, normalizada a booleano al entrar. Ver `CandleEvent`. */
  testnet?: boolean;
}

/** Lo que trae un tick: el ultimo precio y cuando lo puso el venue. */
export interface LivePrice {
  last: string;
  ts: number;
}

/**
 * Pone un precio en vivo sobre una fila de la instantanea.
 *
 * Lo que hay que recalcular es el CAMBIO, no solo el precio. La referencia de
 * hace 24 h se despeja de la instantanea —el precio de entonces es el de ahora
 * menos el cambio absoluto— y con ella los dos numeros se rehacen juntos. Sin
 * referencia utilizable se deja el cambio de la instantanea tal cual: un
 * porcentaje que se queda quieto un minuto es mucho menos malo que uno
 * inventado.
 *
 * Volumen, maximo y minimo no se tocan: un tick no los trae y adivinarlos seria
 * mentir. Los refresca la instantanea.
 */
function applyLive(t: MarketTicker, px: LivePrice): MarketTicker {
  const last = Number(px.last);
  const previous = referenceOf(t);
  if (!Number.isFinite(last) || previous === null || previous <= 0) {
    return { ...t, last: px.last, ts: px.ts };
  }
  return {
    ...t,
    last: px.last,
    change24h: (last - previous).toString(),
    changePct24h: (((last - previous) / previous) * 100).toString(),
    ts: px.ts,
  };
}

/** El precio de hace 24 h, despejado de la instantanea. null si no se puede. */
function referenceOf(t: MarketTicker): number | null {
  const last = Number(t.last);
  if (!Number.isFinite(last)) return null;
  if (t.change24h !== null && t.change24h !== undefined) {
    const change = Number(t.change24h);
    if (Number.isFinite(change)) return last - change;
  }
  if (t.changePct24h !== null && t.changePct24h !== undefined) {
    const pct = Number(t.changePct24h);
    // -100 % dividiria por cero: un mercado a cero no tiene referencia util.
    if (Number.isFinite(pct) && pct > -100) return last / (1 + pct / 100);
  }
  return null;
}

/**
 * Cada cuanto se REPESCA la instantanea completa.
 *
 * No es el mecanismo de actualizacion: los precios llegan empujados por el
 * flujo. Esto solo refresca lo que un tick NO trae —volumen de 24 h, maximo y
 * minimo del dia, y los pares que nadie mira— y sirve de red por si el flujo
 * estuviera caido sin que se hubiera notado.
 *
 * Un minuto, no diez segundos. Antes esta era LA fuente de precios y se pedia
 * cada diez segundos: 212 KB por usuario y por peticion, con el cron de la API
 * refrescando cada treinta segundos, asi que dos de cada tres respuestas
 * llegaban identicas byte a byte y la frescura peor caso era de cuarenta
 * segundos.
 */
const SNAPSHOT_MS = 60_000;

/**
 * Cada cuanto se vuelcan a la interfaz los ticks acumulados.
 *
 * Los ticks entran en un buffer y salen a golpes. Sin esto, un simbolo liquido
 * que late dos veces por segundo por sesenta simbolos mirados serian ciento
 * veinte reconstrucciones por segundo de una lista de 935 filas: la pantalla
 * no puede enseñar eso y el movil se calienta intentandolo.
 *
 * Doscientos milisegundos son cinco refrescos por segundo, mas de lo que el ojo
 * distingue en una lista y mucho menos de lo que cuesta pintarla.
 */
const FLUSH_MS = 200;

/**
 * Tope de pares con precio en vivo.
 *
 * El mismo que aplica la API. Cada par puede acabar en una suscripcion al
 * WebSocket de un venue, que es un recurso contado y compartido con los bots
 * que estan operando.
 */
const MAX_WATCHED = 60;

/**
 * Tope de series de velas en vivo.
 *
 * El mismo que aplica la API, y mucho mas bajo que el de precios porque cuesta
 * mucho mas: un grafico mira UNA resolucion de UN par, y cada serie acaba en
 * una suscripcion propia al venue. Cuatro deja sitio para cambiar de intervalo
 * sin que la nueva se caiga mientras la vieja termina de soltarse.
 */
const MAX_WATCHED_CANDLES = 4;

@Injectable({ providedIn: 'root' })
export class MarketDataService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/market-data`;

  /** Capacidades por venue. Se piden una sola vez y no vuelven a pedirse. */
  readonly capabilities = signal<VenueCapabilitiesMap | null>(null);
  private capsInflight: Promise<VenueCapabilitiesMap> | null = null;
  private tickersInflight: Promise<void> | null = null;

  readonly tickers = signal<MarketTicker[]>([]);
  readonly tickersLoading = signal(false);
  /** Cuando se leyeron. La lista lo enseña: un precio viejo sin avisar engaña. */
  readonly tickersAt = signal<number | null>(null);
  /**
   * Fallos seguidos al pedir precios.
   *
   * Antes los errores se tragaban con `.catch(() => undefined)` y un backend
   * caido se veia EXACTAMENTE igual que una lista sin datos: sin aviso, sin
   * registro, sin nada. Se cuentan los seguidos y no un booleano porque un
   * fallo aislado en un movil es normal y no merece alarmar.
   */
  readonly tickersFailures = signal(0);

  /**
   * Estado del feed, para pintarlo de un vistazo.
   *
   * Se deriva de SEÑALES, nunca del reloj. Un `Date.now()` leido desde la
   * plantilla cambia entre las dos pasadas de deteccion de cambios de Angular
   * en desarrollo y dispara NG0100 —`ExpressionChangedAfterItHasBeenChecked`—,
   * que es justo el error que daba esta pantalla.
   */
  readonly tickersState = computed<'loading' | 'live' | 'down'>(() => {
    if (this.tickersLoading() && this.tickersAt() === null) return 'loading';
    if (this.tickersFailures() >= 2) return 'down';
    if (this.tickersAt() === null) return 'loading';
    // Con la instantanea puesta, quien manda es el flujo: si esta caido, los
    // precios estan congelados aunque la lista se vea llena, y decir «en vivo»
    // entonces seria mentir sobre lo unico que importa de esta pantalla.
    return this.stream.connected() ? 'live' : 'down';
  });

  /**
   * Precios EN VIVO, por par, encima de la instantanea.
   *
   * Van aparte y no dentro de `tickers` a proposito: `tickers` son 935 filas y
   * reescribir ese array en cada tick obligaria a recorrerlas todas —y a
   * reordenarlas— varias veces por segundo. Aqui solo estan los pares que
   * alguien mira, como mucho sesenta.
   */
  readonly live = signal<ReadonlyMap<string, LivePrice>>(new Map());

  /**
   * La instantanea con los precios en vivo ya PUESTOS ENCIMA, por par.
   *
   * Vive aqui y no en cada pantalla porque el calculo tiene una trampa: un tick
   * solo trae el ultimo precio, asi que si se pintara el precio nuevo junto al
   * cambio de 24 h de la instantanea, los dos numeros de la misma fila
   * contarian cosas distintas —el precio de ahora y el porcentaje de hace un
   * minuto— y el porcentaje se quedaria clavado mientras el precio se mueve.
   * Se recalcula desde la referencia de hace 24 h, que se despeja de la propia
   * instantanea, y los dos vuelven a ser consistentes.
   *
   * Un `Map` de 935 entradas cinco veces por segundo es trabajo despreciable —
   * lo caro seria repintar 935 filas, y de eso se encarga el volcado a golpes.
   */
  readonly tickerMap = computed<ReadonlyMap<string, MarketTicker>>(() => {
    const live = this.live();
    const out = new Map<string, MarketTicker>();
    for (const t of this.tickers()) {
      const key = `${t.venue}:${t.symbol}`;
      const px = live.get(key);
      out.set(key, px ? applyLive(t, px) : t);
    }
    return out;
  });

  private readonly stream = inject(StreamService);
  private readonly network = inject(NetworkService);

  /**
   * El buffer de ticks y su reloj de volcado.
   *
   * Se acumula en un `Map` normal —no en la señal— y se vuelca cada `FLUSH_MS`.
   * Escribir la señal en cada tick dispararia la deteccion de cambios de
   * Angular una vez por tick.
   */
  private readonly pending = new Map<string, LivePrice>();
  private flush: ReturnType<typeof setTimeout> | null = null;

  /**
   * Que mira cada pantalla, por reserva.
   *
   * La union de todos los conjuntos es lo que se declara a la API. Por reserva
   * y no una lista global: la lista de mercados y el grafico estan abiertos a
   * la vez —el grafico vive fuera de las pestañas— y con una sola lista el
   * ultimo en escribir dejaria al otro sin precios.
   */
  private readonly interests = new Map<number, string[]>();
  /**
   * Lo mismo para las VELAS, en su propio mapa.
   *
   * Separado de los precios porque son dos intereses distintos con dos topes
   * distintos: un precio comparte el ticker que el worker ya tiene abierto,
   * pero cada serie de velas es una suscripcion propia al venue. Fundirlos en
   * un mapa habria hecho que el tope de sesenta precios se comiera el de
   * cuatro velas, o al reves.
   */
  private readonly candleInterests = new Map<number, string[]>();
  private nextInterest = 1;
  private declared = '';
  private declaring = false;

  private poll: ReturnType<typeof setInterval> | null = null;
  /**
   * Cuantas pantallas quieren precios ahora mismo.
   *
   * ANTES esto era un interruptor global (`startPolling`/`stopPolling`) que
   * compartian la lista y el grafico, y ahi estaba el fallo: el grafico vive
   * FUERA de las pestañas, asi que al volver de el su `ionViewWillLeave`
   * apagaba el unico temporizador y el `ionViewWillEnter` de la lista NO se
   * volvia a disparar —el outlet de las pestañas ve la misma vista entrando y
   * saliendo y no emite ningun evento—. La lista quedaba congelada para
   * siempre y solo el tiron de refresco la repintaba, una vez.
   *
   * Con un contador, que una pantalla suelte su interes no puede apagar el de
   * otra, y ya no hace falta que ningun hook de ciclo de vida se dispare.
   */
  private watchers = 0;

  /**
   * La app en segundo plano: se para el reloj sin perder el interes.
   *
   * Es publica y es una señal porque no solo la usa este servicio: el grafico
   * tiene su propio temporizador —el de la vela viva— y tambien hay que
   * pararlo. Antes se enteraba registrando SU PROPIO oyente de Capacitor, con
   * todo el aparato de «solo uno por pantalla» que eso obliga a escribir; ahora
   * hay un unico oyente en la app y quien quiera pararse lo lee de aqui.
   */
  readonly background = signal(false);
  /**
   * Cache en memoria, ACOTADA.
   *
   * Sin tope crece con cada par que se visita —trescientas velas por entrada— y
   * en una app que vive dias en segundo plano eso es una fuga lenta que solo se
   * nota cuando el sistema mata el proceso. Se desalojan las mas viejas.
   */
  private readonly candleCache = new Map<string, { at: number; data: Candle[] }>();
  private static readonly MAX_CACHED_SERIES = 24;

  constructor() {
    // Un SOLO oyente para toda la app. Estaba en la pantalla del grafico, asi
    // que la lista seguia pidiendo precios con el movil en el bolsillo; y al
    // registrarse por pantalla, entrar y salir deprisa dejaba oyentes
    // huerfanos. Este servicio vive toda la sesion: se registra una vez y no
    // hay que quitarlo nunca.
    void CapApp.addListener('appStateChange', ({ isActive }) =>
      this.setBackground(!isActive),
    ).catch(() => undefined);

    // Lo mismo, pero en WEB.
    //
    // `appStateChange` es del puente nativo y en un navegador no se dispara
    // NUNCA, asi que la version web se quedaba sin la mitad de este mecanismo:
    // una pestaña de fondo seguia pidiendo la instantanea de precios cada
    // minuto, indefinidamente, y ademas volvia con la foto de hace un minuto
    // en vez de pedir una al asomarse.
    //
    // Los dos oyentes pueden convivir: en un WebView de Capacitor
    // `visibilityState` sigue a la app, asi que dicen lo mismo, y `setBackground`
    // fija una señal —no alterna— por lo que llamarlo dos veces con el mismo
    // valor no hace nada. Se comprueba `document` porque este servicio tambien
    // se instancia en pruebas sin DOM.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () =>
        this.setBackground(document.visibilityState === 'hidden'),
      );
    }

    // Los precios en vivo, del flujo que la aplicacion ya tiene abierto.
    //
    // Esta es la respuesta a «por que peticiones y no un SSE». No hace falta
    // ninguna conexion nueva: `app.component.ts` mantiene esta abierta toda la
    // sesion, autenticada y con reconexion exponencial. Lo unico que faltaba
    // era que el worker dijera los precios en voz alta y que la API supiera
    // quien mira que.
    const sub = this.stream.ticks.subscribe((event) => {
      const d = event.data as {
        venue?: Venue;
        symbol?: string;
        last?: string;
        ts?: number;
        testnet?: boolean;
      };
      if (!d.venue || !d.symbol || !d.last) return;
      // De la red que se esta mirando y de ninguna otra.
      //
      // Los temas del flujo ya separan las dos redes, asi que en regimen normal
      // aqui no llega nada ajeno. Lo que esto cierra es la VENTANA del cambio de
      // lente: entre que se conmuta y que el servidor procesa la declaracion
      // nueva, los precios de la red anterior siguen llegando, y las claves de
      // `pending` y `live` son `VENUE:SIMBOLO` —sin red—, asi que caerian en la
      // misma casilla que los de la red nueva.
      if ((d.testnet ?? false) !== this.network.testnet()) return;
      this.pending.set(`${d.venue}:${d.symbol}`, { last: d.last, ts: d.ts ?? Date.now() });
      this.scheduleFlush();
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      if (this.flush) clearTimeout(this.flush);
    });

    // El interes se vuelve a declarar SOLO en cada reconexion.
    //
    // El identificador de conexion cambia cada vez que el flujo se reconecta
    // —y en un movil eso pasa constantemente: cambio de red, pantalla
    // apagada—. Sin esto, la primera reconexion dejaria las pantallas abiertas
    // sin un solo precio, sin nada que lo delatara.
    // Cambio de lente: lo que hay en pantalla es de la OTRA red.
    //
    // Vaciarlo no es cosmetico. Dejarlo mientras llega lo nuevo enseñaria
    // precios de mainnet debajo de la franja de testnet, que es exactamente lo
    // que la franja existe para impedir.
    let redAnterior: boolean | null = null;
    effect(() => {
      const testnet = this.network.testnet();
      // La primera pasada solo toma nota: el efecto corre al construirse el
      // servicio y aqui todavia no hay nada que tirar ni nada que volver a
      // pedir. Sin esta guarda, arrancar la app disparaba una instantanea de
      // mas antes de que ninguna pantalla la hubiera pedido.
      if (redAnterior === null) {
        redAnterior = testnet;
        return;
      }
      if (redAnterior === testnet) return;
      redAnterior = testnet;
      untracked(() => {
        this.pending.clear();
        this.live.set(new Map());
        this.tickers.set([]);
        this.tickersAt.set(null);
        this.tickersFailures.set(0);
        this.candleCache.clear();
        // Y se vuelve a declarar: la huella lleva la red, asi que esto suelta
        // en el servidor lo de la red vieja y reserva lo de la nueva.
        void this.declare();
        if (this.watchers > 0) void this.refreshTickers().catch(() => undefined);
      });
    });

    effect(() => {
      const id = this.stream.streamId();
      if (!id) return;
      // Lo de dentro va en `untracked` porque `declare()` lee mas señales —el
      // segundo plano, entre otras— y sin esto se convertian todas en
      // disparadores de este efecto: irse al fondo y volver forzaba una
      // redeclaracion completa que ya hace `setBackground` por su cuenta.
      // Aqui lo unico que tiene que disparar es que la CONEXION sea otra.
      untracked(() => {
        this.declared = '';
        void this.declare();
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Precios en vivo
  // ═══════════════════════════════════════════════════════════════

  /**
   * Declara que pares mira una pantalla. Devuelve el mando para cambiarlos y
   * soltarlos.
   *
   * Sustituir la lista entera y no acumular es lo que hace que cerrar una
   * pantalla —o filtrar la lista— suelte de verdad lo que ya no se mira: sin
   * eso, la suscripcion al WebSocket del venue se quedaria viva para siempre.
   */
  watchSymbols(pairs: string[] = []): { update(next: string[]): void; release(): void } {
    const id = this.nextInterest++;
    this.interests.set(id, pairs);
    void this.declare();
    return {
      update: (next: string[]) => {
        if (!this.interests.has(id)) return;
        this.interests.set(id, next);
        void this.declare();
      },
      release: () => {
        if (!this.interests.delete(id)) return;
        void this.declare();
      },
    };
  }

  /**
   * Declara que serie de velas mira una pantalla, y devuelve su flujo.
   *
   * Es lo que sustituye al sondeo del grafico. Antes la pantalla pedia las dos
   * ultimas velas cada cinco segundos contra una cache de quince: dos de cada
   * tres respuestas llegaban identicas y el cierre de la vela iba hasta veinte
   * segundos por detras del precio de la cabecera, en la misma pantalla.
   *
   * El flujo solo entrega si el venue SIRVE velas en vivo —Lighter no— y eso se
   * sabe de antemano por `capabilities`. Quien lo use tiene que mirarlo antes:
   * esperar velas de un venue que no las manda es quedarse con el grafico
   * congelado sin nada que lo explique.
   */
  watchCandles(): {
    update(next: { venue: Venue; symbol: string; interval: CandleInterval } | null): void;
    release(): void;
  } {
    const id = this.nextInterest++;
    // Nace VACIA y no con una serie inicial: quien la reserva lo hace en su
    // constructor, cuando el par todavia sale de los valores por defecto y no
    // de la ruta. Declarar ahi habria pedido al venue una serie que nadie mira
    // —`HYPERLIQUID:` con el simbolo vacio— y la habria soltado un instante
    // despues.
    this.candleInterests.set(id, []);
    return {
      update: (next) => {
        if (!this.candleInterests.has(id)) return;
        this.candleInterests.set(
          id,
          next === null ? [] : [`${next.venue}:${next.symbol}:${next.interval}`],
        );
        void this.declare();
      },
      release: () => {
        if (!this.candleInterests.delete(id)) return;
        void this.declare();
      },
    };
  }

  /**
   * Las velas en vivo, ya parseadas y sin las incompletas.
   *
   * Sin filtrar por par: quien las consume es UNA pantalla que cambia de par y
   * de resolucion en caliente, y un flujo con el filtro cocido dentro habria
   * que rehacerlo —y resuscribirlo— en cada cambio de intervalo.
   */
  readonly candleEvents: Observable<Required<CandleEvent>> = this.stream.candles.pipe(
    map((event) => {
      const d = event.data as CandleEvent;
      // Un servidor sin actualizar no manda la red: eso es mainnet.
      return { ...d, testnet: d.testnet === true };
    }),
    filter(
      (d): d is Required<CandleEvent> =>
        d.venue !== undefined &&
        d.symbol !== undefined &&
        d.interval !== undefined &&
        d.candle !== undefined,
    ),
  );

  /** Los precios en vivo, ya parseados. Mismo criterio que `candleEvents`. */
  readonly tickEvents: Observable<Required<TickEvent>> = this.stream.ticks.pipe(
    map((event) => {
      const d = event.data as TickEvent;
      return { ...d, testnet: d.testnet === true };
    }),
    filter(
      (d): d is Required<TickEvent> =>
        d.venue !== undefined && d.symbol !== undefined && d.last !== undefined,
    ),
  );

  /** ¿Sirve este venue velas en vivo? Lo dice la API, no una lista escrita aqui. */
  hasLiveCandles(venue: Venue): boolean {
    return this.capabilities()?.[venue]?.candles.live ?? false;
  }

  /**
   * El parametro de red, solo cuando hace falta.
   *
   * En mainnet se omite en lugar de mandar `testnet=false`: deja la peticion
   * byte a byte como era antes de que existiera testnet, lo que importa porque
   * estas URLs se cachean —en el navegador y en cualquier proxy de por medio— y
   * un parametro nuevo las convertiria a todas en fallos de cache.
   */
  private redParam(): Record<string, string> {
    return this.network.testnet() ? { testnet: 'true' } : {};
  }

  private scheduleFlush(): void {
    if (this.flush) return;
    this.flush = setTimeout(() => {
      this.flush = null;
      if (this.pending.size === 0) return;
      const next = new Map(this.live());
      for (const [key, px] of this.pending) next.set(key, px);
      this.pending.clear();
      this.live.set(next);
      // Un tick TAMBIEN cuenta como noticia fresca: es lo que hace que el
      // indicador diga «en vivo» sin esperar a la siguiente instantanea.
      this.tickersAt.set(Date.now());
      this.tickersFailures.set(0);
    }, FLUSH_MS);
  }

  /**
   * Manda a la API la union de lo que mira la aplicacion.
   *
   * Se manda ENTERA cada vez, no altas y bajas: es lo que permite que un
   * mensaje perdido o una reconexion se corrijan solos en la siguiente
   * declaracion, en vez de dejar interes colgado o pantallas mudas.
   */
  private async declare(): Promise<void> {
    const streamId = this.stream.streamId();
    if (!streamId || this.declaring) return;

    const fingerprint = this.wanted();
    if (fingerprint === this.declared) return;
    const [precios, velas] = fingerprint.split('|');

    this.declaring = true;
    try {
      await firstValueFrom(
        this.http.post(`${this.base}/watch`, {
          streamId,
          symbols: precios ? precios.split(',') : [],
          candles: velas ? velas.split(',') : [],
          // Una bandera para la declaracion entera: la pantalla mira una red a
          // la vez. Entra ademas en la huella, asi que cambiar de lente vuelve
          // a declarar sola y suelta el interes de la red anterior.
          testnet: this.network.testnet(),
        }),
      );
      this.declared = fingerprint;
    } catch {
      // Sin ruido: el efecto de reconexion y el siguiente cambio de pantalla
      // vuelven a intentarlo. Lo que NO se hace es dar por declarado algo que
      // no llego, que dejaria la pantalla muda y sin reintento.
    } finally {
      this.declaring = false;
      // Lo que haya cambiado mientras la peticion estaba en vuelo se declara
      // ahora: sin esto, abrir dos pantallas deprisa dejaba fuera a la segunda.
      if (this.wanted() !== this.declared) void this.declare();
    }
  }

  /**
   * La union de lo que miran todas las pantallas, acotada y estable.
   *
   * Con la aplicacion en segundo plano es VACIA, sin perder lo que cada
   * pantalla quiere: el interes sigue anotado y se recupera entero al volver.
   * Sin esto, el movil en el bolsillo seguiria recibiendo varios precios por
   * segundo —gastando datos y bateria por una pantalla apagada— y el worker
   * mantendria abierta la suscripcion al venue por alguien que no mira nada.
   */
  private wanted(): string {
    if (this.background()) return '|';
    const velas = [...new Set([...this.candleInterests.values()].flat())]
      .sort()
      .slice(0, MAX_WATCHED_CANDLES);
    // Los precios ocupan lo que dejen las velas, igual que hace la API. Pedir
    // de más no rompe nada —el servidor recorta— pero declararlo aquí evita que
    // el cliente crea que mira sesenta pares cuando el cupo daba para
    // cincuenta y nueve.
    const precios = [...new Set([...this.interests.values()].flat())]
      .sort()
      .slice(0, Math.max(0, MAX_WATCHED - velas.length));
    // Las dos listas en una sola cadena, separadas por `|`: es la huella con la
    // que se decide si hay algo nuevo que declarar, y tiene que cambiar cuando
    // cambie CUALQUIERA de las dos.
    // Y la RED al final. Sin ella, cambiar de lente no cambiaba la huella y la
    // declaracion no se repetia: el servidor seguia mandando los precios de la
    // red anterior a unos temas que la pantalla ya no miraba.
    //
    // `declare()` solo desestructura los dos primeros trozos, asi que anadir un
    // tercero no toca nada de lo que ya habia.
    return `${precios.join(',')}|${velas.join(',')}|${this.network.testnet() ? 't' : 'm'}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Capacidades
  // ═══════════════════════════════════════════════════════════════

  /**
   * Que intervalos sirve cada plataforma.
   *
   * La barra de intervalos se dibuja DESDE AQUI y no desde una lista escrita en
   * la app: cuando se anada un cuarto venue, o cuando uno de ellos publique un
   * intervalo nuevo, la interfaz se entera sola.
   */
  async loadCapabilities(): Promise<VenueCapabilitiesMap> {
    const cached = this.capabilities();
    if (cached) return cached;
    // Una sola peticion en vuelo: al abrir la lista y un grafico a la vez, sin
    // esto salen dos identicas.
    this.capsInflight ??= firstValueFrom(
      this.http.get<VenueCapabilitiesMap>(`${this.base}/capabilities`),
    )
      .then((caps) => {
        this.capabilities.set(caps);
        return caps;
      })
      .finally(() => {
        this.capsInflight = null;
      });
    return this.capsInflight;
  }

  /**
   * Intervalos de un venue.
   *
   * Si las capacidades no han llegado —sin red al abrir el grafico—, se
   * devuelve el MINIMO que sirven los tres venues de hoy, no una lista vacia:
   * con la lista vacia la barra salia sin un solo boton y no habia forma de
   * cambiar de intervalo, con el grafico funcionando por debajo. Si un
   * intervalo de este minimo no existiera en un venue futuro, la API responde
   * 400 con un mensaje legible: se degrada a un error explicado, no a una
   * pantalla muda.
   */
  intervalsOf(venue: Venue): CandleInterval[] {
    return this.capabilities()?.[venue]?.candles.intervals ?? FALLBACK_INTERVALS;
  }

  supports(venue: Venue, interval: CandleInterval): boolean {
    return this.intervalsOf(venue).includes(interval);
  }

  /**
   * Los venues que SI sirven un intervalo. Es lo que permite que el estado
   * vacio diga «esto si esta en Aster» en vez de un «no hay datos» seco.
   */
  venuesWith(interval: CandleInterval): Venue[] {
    const caps = this.capabilities();
    if (!caps) return [];
    return (Object.keys(caps) as Venue[]).filter((v) =>
      caps[v]?.candles.intervals.includes(interval),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Velas
  // ═══════════════════════════════════════════════════════════════

  /**
   * Velas de un par.
   *
   * La memoria cachea unos segundos para que volver atras desde el detalle de
   * un bot no vuelva a pedir lo mismo; el refresco de verdad lo hace `refresh`,
   * que salta el cache a proposito.
   */
  /**
   * Rasgos del par para la franja de veredicto del grafico. Los calcula el
   * SERVIDOR con la misma funcion que alimenta al advisor: calcularlos aqui
   * crearia dos verdades, y pediria dos series que el grafico no carga. `null`
   * sin velas suficientes, y la franja no se pinta.
   */
  async features(venue: Venue, symbol: string): Promise<MarketFeatures | null> {
    return firstValueFrom(
      this.http.get<MarketFeatures | null>(`${this.base}/features`, {
        params: { venue, symbol, testnet: String(this.network.testnet()) },
      }),
    );
  }

  async candles(
    venue: Venue,
    symbol: string,
    interval: CandleInterval,
    limit = 300,
    opts: { refresh?: boolean; endMs?: number } = {},
  ): Promise<Candle[]> {
    // `endMs` va DENTRO de las opciones y no como quinto posicional: hay tres
    // llamantes y ninguno lo quiere, asi que un parametro mas les obligaria a
    // escribir `undefined` a todos.
    const historico = opts.endMs !== undefined;

    // La red entra en la clave: las velas de testnet no son las de mainnet, y
    // sin ella cambiar de lente servia la serie anterior desde el cache.
    const key = `${venue}:${symbol}:${interval}:${limit}:${this.network.testnet() ? 't' : 'm'}`;
    const hit = this.candleCache.get(key);
    if (!historico && !opts.refresh && hit && Date.now() - hit.at < 5_000) return hit.data;

    const data = await firstValueFrom(
      this.http.get<Candle[]>(`${this.base}/candles`, {
        params: {
          venue,
          symbol,
          interval,
          limit,
          // Condicional a proposito: `HttpParams` serializa `undefined` como la
          // CADENA "undefined", y el DTO del servidor responderia 400.
          ...(historico ? { endMs: opts.endMs! } : {}),
          ...this.redParam(),
        },
      }),
    );

    // Las paginas de historico NO entran en el cache. La pantalla ya las guarda
    // en su propia serie, la unica forma de volver a pedirlas es un cambio de
    // par o de intervalo —que las invalida igual—, y meterlas aqui desalojaria
    // las series de otros pares del LRU de 24. El servidor ya las cachea una
    // hora por su cuenta, que es donde de verdad importa.
    if (historico) return data;

    // `Map` conserva el orden de insercion: la primera clave es la mas antigua.
    if (this.candleCache.size >= MarketDataService.MAX_CACHED_SERIES) {
      const oldest = this.candleCache.keys().next().value;
      if (oldest !== undefined) this.candleCache.delete(oldest);
    }
    this.candleCache.set(key, { at: Date.now(), data });
    return data;
  }

  /**
   * Fusiona la ultima vela con la serie que ya se tiene.
   *
   * Es lo que hace barato el refresco: en vez de volver a pedir trescientas
   * velas cada pocos segundos, se piden las dos ultimas y se pegan. La vela en
   * formacion sustituye a la que hubiera con su mismo `t`.
   *
   * `keep` es OBLIGATORIO, y quitarle el valor por defecto fue el arreglo. Era
   * `= 600` y ningun llamante lo pasaba, asi que en cuanto el grafico pudo
   * cargar historico hacia atras, cada relevo de vela y cada reconciliacion de
   * treinta segundos BORRABA en silencio todo lo que pasara de 600 barras: sin
   * error, sin traza, y con el usuario mirando. Exigirlo convierte ese fallo
   * diferido en un error de compilacion en los tres sitios que hay que revisar.
   */
  merge(previous: Candle[], incoming: Candle[], keep: number): Candle[] {
    if (incoming.length === 0) return previous;

    // Camino rapido: lo normal es pegar una o dos velas AL FINAL. Reconstruir un
    // Map y reordenar tres mil elementos cada treinta segundos para eso era
    // gratis con 600 barras y deja de serlo con historico cargado.
    const ultima = previous.length ? previous[previous.length - 1].t : -Infinity;
    if (previous.length && incoming.every((c) => c.t > ultima)) {
      const merged = [...previous, ...incoming];
      return merged.length > keep ? merged.slice(merged.length - keep) : merged;
    }

    const byTime = new Map(previous.map((c) => [c.t, c]));
    for (const c of incoming) byTime.set(c.t, c);
    const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
    // Con tope. Cada vez que nace una vela la serie crece en una, y una
    // pantalla de 1m abierta toda una tarde acumulaba cientos de velas que
    // nadie pidio, reordenadas enteras en cada refresco. Se conservan las mas
    // recientes: el pasado lejano ya no esta en pantalla.
    return merged.length > keep ? merged.slice(merged.length - keep) : merged;
  }

  // ═══════════════════════════════════════════════════════════════
  // Precios de 24 h
  // ═══════════════════════════════════════════════════════════════

  /**
   * Los precios de los TRES venues, siempre.
   *
   * La API acepta filtrar por venue y aqui no se usa a proposito: la respuesta
   * sustituye la lista entera, asi que pedir solo uno vaciaba los otros dos —y
   * con ellos la comparacion entre plataformas del grafico— sin que nada
   * pareciera fallar. Como el endpoint lee de Redis, traerlos todos no cuesta
   * mas que traer uno.
   */
  refreshTickers(): Promise<void> {
    // Una sola peticion en vuelo. Abrir un grafico desde la lista reserva la
    // instantanea dos veces —las dos pantallas viven a la vez, el grafico esta
    // fuera de las pestañas— y sin esto salian dos peticiones identicas de 180
    // KB con un milisegundo de diferencia. Mismo patron que `loadCapabilities`.
    this.tickersInflight ??= this.fetchTickers().finally(() => {
      this.tickersInflight = null;
    });
    return this.tickersInflight;
  }

  private async fetchTickers(): Promise<void> {
    this.tickersLoading.set(true);
    try {
      const rows = await firstValueFrom(
        this.http.get<MarketTicker[]>(`${this.base}/tickers`, { params: this.redParam() }),
      );
      this.tickers.set(rows);
      this.tickersAt.set(Date.now());
      this.tickersFailures.set(0);
    } catch (e) {
      // Se cuenta y se propaga. Quien la pide de fondo lo ignora a proposito
      // —no se molesta al usuario por un fallo suelto—, pero la cuenta hace que
      // la pantalla pueda decir «sin conexion» en vez de quedarse muda.
      this.tickersFailures.update((n) => n + 1);
      throw e;
    } finally {
      this.tickersLoading.set(false);
    }
  }

  /**
   * Declara que esta pantalla quiere precios. Devuelve la funcion que lo suelta.
   *
   * Reserva con CONTADOR, no un interruptor: mientras quede una pantalla
   * interesada el reloj sigue, asi que volver del grafico a la lista ya no
   * encuentra el sondeo muerto. Y como se suelta en `ngOnDestroy`, no depende
   * de que se dispare ningun hook de Ionic.
   *
   * La funcion devuelta es idempotente: llamarla dos veces no puede robarle el
   * interes a otra pantalla.
   */
  watchTickers(): () => void {
    this.watchers++;
    // Siembra inmediata: quien acaba de abrir la pantalla no espera al primer
    // tic del reloj para ver un precio.
    void this.refreshTickers().catch(() => undefined);
    this.arm();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers = Math.max(0, this.watchers - 1);
      if (this.watchers === 0) this.disarm();
    };
  }

  /** Arranca el reloj si hay interes y la app esta delante. */
  private arm(): void {
    if (this.poll || this.watchers === 0 || this.background()) return;
    this.poll = setInterval(() => void this.refreshTickers().catch(() => undefined), SNAPSHOT_MS);
  }

  private disarm(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /**
   * La app pasa a segundo plano o vuelve.
   *
   * Vive AQUI y no en una pantalla: es una condicion del proceso entero, y
   * tenerla en el grafico hacia que la lista siguiera pidiendo precios con el
   * movil en el bolsillo. El interes no se pierde, solo se para el reloj.
   */
  setBackground(background: boolean): void {
    this.background.set(background);
    // El interes se suelta al irse al fondo y se recupera al volver: ver
    // `wanted()`. Va en las dos ramas porque las dos lo cambian.
    void this.declare();
    if (background) this.disarm();
    else {
      this.arm();
      if (this.watchers > 0) void this.refreshTickers().catch(() => undefined);
    }
  }

  /** Ticker de un par concreto, con el precio en vivo ya puesto. */
  tickerOf(venue: Venue, symbol: string): MarketTicker | undefined {
    return this.tickerMap().get(`${venue}:${symbol}`);
  }

  /**
   * El mismo activo en las demas plataformas.
   *
   * El emparejamiento NO puede ser un `startsWith` a secas: cada venue nombra
   * sus pares distinto —`BTC` en Hyperliquid, `BTCUSDT` en Aster— pero con un
   * prefijo suelto, buscar ETH devuelve tambien ETHFI, que es otro activo
   * completamente distinto. Se exige que lo que sobra sea una quote conocida.
   */
  sameBase(base: string, exclude?: { venue: Venue; symbol: string }): MarketTicker[] {
    const wanted = base.toUpperCase();
    return [...this.tickerMap().values()].filter((t) => {
      if (exclude && t.venue === exclude.venue && t.symbol === exclude.symbol) return false;
      const symbol = t.symbol.toUpperCase();
      if (symbol === wanted) return true;
      if (!symbol.startsWith(wanted)) return false;
      return QUOTES.has(symbol.slice(wanted.length));
    });
  }

  invalidate(): void {
    this.candleCache.clear();
  }
}

/**
 * Interseccion de los tres venues de hoy. Solo se usa si la API no responde.
 *
 * Sin `1w`: Lighter no lo sirve —su API documenta ocho resoluciones y pedir la
 * semanal devuelve `invalid param`—, asi que ofrecerlo como minimo comun
 * garantizaria un error en el unico caso en el que este respaldo actua.
 */
const FALLBACK_INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d'];

/**
 * Las quotes con las que los tres venues nombran sus pares. Es la lista que
 * separa `ETH` + `USDT` de `ETHFI`, que no es el mismo activo.
 */
const QUOTES = new Set(['USDC', 'USDT', 'USD', 'PERP', '-USD', '-USDC', '-PERP']);

/** Capacidades de un venue, re-exportadas para las plantillas. */
export type { VenueCapabilities };
