import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ExchangeError,
  candleSpanMs,
  type Candle,
  type CandleInterval,
  venueKey,
  type MarketTicker,
  type VenueCapabilities,
} from '@crypton/shared';
import {
  VENUE_CAPABILITIES,
  createPublicAdapter,
  serviceCredentials,
  shortMessage,
  type ExchangeAdapter,
} from '@crypton/exchange-core';
import { Venue } from '@crypton/db';
import { CacheService, VenueBudgetProvider } from 'src/libs';
import { ConfigService } from '@nestjs/config';
import { MarketsService } from '../markets';

/**
 * Datos de mercado en vivo: capacidades, velas y precios de 24 h.
 *
 * Módulo aparte de `markets` a propósito. Aquel es un CATÁLOGO en Postgres que
 * un cron refresca cada diez minutos y del que dependen la validación de
 * órdenes y el preview; esto es un PROXY en vivo con caché en Redis y otro
 * ciclo de vida. Mezclarlos convertiría el cron del catálogo —del que depende
 * poder operar— en rehén de la latencia de un gráfico.
 *
 * Todo pasa por `createPublicAdapter`: son datos públicos y no hay motivo para
 * descifrar la clave de nadie para leerlos.
 */
@Injectable()
export class MarketDataService implements OnModuleDestroy {
  private readonly logger = new Logger(MarketDataService.name);

  /**
   * Peticiones en vuelo, por clave.
   *
   * Es la pieza que decide si esto aguanta o no: doscientos usuarios mirando
   * BTC/1m a la vez son doscientos fallos de caché simultáneos y, sin esto,
   * doscientas llamadas idénticas al venue en el mismo milisegundo — que es
   * exactamente como se agota el presupuesto de caudal de la IP. Mismo patrón
   * que `MarketSpecCache` en exchange-core.
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * Un adaptador por venue Y RED, vivo mientras viva el proceso. Ver
   * `adapterFor`. La clave lleva la red porque son dos hosts distintos: con un
   * solo adaptador por venue, el primero en pedirse fijaba la red para todos.
   */
  private readonly adapters = new Map<string, ExchangeAdapter>();

  constructor(
    private readonly cache: CacheService,
    private readonly markets: MarketsService,
    private readonly budget: VenueBudgetProvider,
    private readonly config: ConfigService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((a) => a.close()));
    this.adapters.clear();
  }

  // ═══════════════════════════════════════════════════════════════
  // Capacidades
  // ═══════════════════════════════════════════════════════════════

  /**
   * Lo que sabe hacer cada venue.
   *
   * Es lo que hace que la app NO lleve una tabla de intervalos: pinta su barra
   * desde aquí. Añadir un venue es escribir su adaptador y nada más.
   *
   * Sale de una CONSTANTE y no de construir los tres adaptadores. Construirlos
   * levantaba, en cada petición, un limitador de caudal, una caché de specs y
   * —en Hyperliquid— transportes HTTP y WebSocket, todo para leer una lista que
   * no cambia nunca.
   */
  capabilities(): Record<Venue, VenueCapabilities> {
    return VENUE_CAPABILITIES;
  }

  // ═══════════════════════════════════════════════════════════════
  // Velas
  // ═══════════════════════════════════════════════════════════════

  /**
   * Velas de un par, cacheadas en dos plazos.
   *
   * Una vela CERRADA es inmutable: una vez pasado su intervalo, nadie la va a
   * cambiar nunca. La vela en formación cambia cada segundo. Cachear las dos
   * con el mismo TTL obliga a elegir entre servir precios viejos o no cachear
   * nada, así que se separan: la serie se guarda entera con TTL corto —el que
   * marca la vela viva— y la respuesta se sirve de ahí.
   *
   * El TTL corto es la mitad del intervalo con tope de 15 s: en 1m eso son 15 s
   * de retraso máximo, y en 1d evita mantener durante horas un cierre que
   * todavía se mueve.
   */
  async candles(
    venue: Venue,
    symbol: string,
    interval: CandleInterval,
    opts: { limit?: number; endMs?: number; testnet?: boolean } = {},
  ): Promise<Candle[]> {
    const testnet = opts.testnet === true;
    this.assertSupported(venue, interval);
    // El símbolo se comprueba contra el CATÁLOGO de Postgres, no contra el
    // venue. Sin esto, cada símbolo inventado era una llamada al DEX para
    // descubrir que no existe — con el presupuesto de caudal que comparten los
    // bots—, y una clave de Redis inerte por cada uno. El catálogo ya está
    // aquí y responde 404 sin salir a la red.
    await this.markets.getSpec(venue, symbol, testnet);

    // `limit` y `endMs` se CUANTIZAN antes de entrar en la clave.
    //
    // Es una medida de seguridad, no de tamaño. La clave decide qué cuenta
    // como «la misma petición», y con los dos valores libres un usuario
    // autenticado podía generar claves nuevas a voluntad —limit=1, 2, 3…—,
    // cada una un fallo de caché y una llamada al DEX. El presupuesto de
    // caudal de la IP es el MISMO que usan los bots para operar: vaciarlo
    // desde un endpoint de solo lectura es dejar a los bots sin poder
    // cancelar. Cuantizados, la cardinalidad queda acotada y el single-flight
    // vuelve a cubrir a todos los que piden lo mismo.
    // Y se acota al techo REAL del venue DESPUÉS de cuantizar.
    //
    // Sin esto, un `limit=1500` en Lighter —cuyo máximo son 500— guardaba 500
    // velas bajo una clave que decía 1500: un nombre que miente, y que nunca
    // casaría con la clave legítima que pide quien conoce el límite. Dos
    // entradas para el mismo contenido y ningún acierto compartido.
    //
    // El orden importa y no es intercambiable: `quantizeLimit` redondea hacia
    // ARRIBA, así que acotar primero y cuantizar después vuelve a pasarse del
    // techo —500 se convertiría en 600— y el problema seguiría ahí. Acotando al
    // final, TODAS las peticiones por encima del máximo del venue colapsan en la
    // misma clave, que es justo lo que se quiere: el venue les va a devolver lo
    // mismo a todas.
    const techo = VENUE_CAPABILITIES[venue].candles.maxBars;
    const limit = Math.min(quantizeLimit(opts.limit), techo);
    const endMs = quantizeEnd(interval, opts.endMs);
    const key = `md:candles:${venueKey(venue, testnet)}:${symbol}:${interval}:${limit}:${endMs ?? 'now'}`;

    const cached = await this.cache.get<Candle[]>(key);
    if (cached) return cached;

    return this.single(key, async () => {
      const fresh = await this.withAdapter(
        venue,
        (a) => a.getCandles(symbol, interval, { startMs: 0, endMs, limit }),
        testnet,
      );
      await this.cache.set(key, fresh, this.candleTtl(interval, endMs));
      return fresh;
    });
  }

  /**
   * Segundos que vive una entrada de velas.
   *
   * Una ventana cerrada —con `endMs` en el pasado— no contiene ninguna vela
   * viva, así que se puede cachear una hora entera. Es lo que hace barato
   * desplazarse hacia atrás en el gráfico.
   */
  private candleTtl(interval: CandleInterval, endMs?: number): number {
    if (endMs !== undefined && endMs < Date.now() - candleSpanMs(interval))
      return 3600;
    // Una DÉCIMA del intervalo, entre 3 y 15 segundos.
    //
    // Antes era la mitad, y en 1m eso daba los 15 s del tope: la vela viva se
    // quedaba congelada un cuarto de su propia duración, con la pantalla
    // sondeando cada 5 s y recibiendo tres veces el mismo valor. Con una décima
    // sale 6 s en 1m y el tope sigue mandando en los intervalos largos.
    return Math.max(
      3,
      Math.min(15, Math.floor(candleSpanMs(interval) / 10_000)),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Precios de 24 h
  // ═══════════════════════════════════════════════════════════════

  /**
   * Precio y sesión de 24 h. SIEMPRE se lee de Redis, nunca del venue.
   *
   * Quien habla con el DEX es el cron de abajo. Si el venue se cayera, este
   * método devuelve lo último bueno en vez de propagar el fallo: una lista de
   * mercados con precios de hace un minuto sigue siendo útil, y una pantalla en
   * blanco no.
   *
   * Es la FOTO INICIAL, no el mecanismo de actualización. La aplicación la pide
   * una vez al abrir la pantalla y a partir de ahí los precios de lo que está
   * mirando llegan empujados por el flujo SSE, símbolo a símbolo. Lo que sigue
   * saliendo solo de aquí es lo que un tick no trae —volumen de 24 h, máximo y
   * mínimo del día— y los pares que nadie mira.
   */
  async tickers(venue?: Venue, testnet = false): Promise<MarketTicker[]> {
    const venues = venue ? [venue] : Object.values(Venue);
    const rows = await Promise.all(
      venues.map((v) => this.cache.get<MarketTicker[]>(tickerKey(v, testnet))),
    );
    const flat = rows.flatMap((r) => r ?? []);

    // Vacío del todo = el cron no ha corrido nunca (arranque en frío). Se
    // refresca una vez en caliente en lugar de devolver una lista vacía, que
    // la app leería como «este venue no tiene mercados».
    if (flat.length === 0) {
      await this.fetchTickers(testnet);
      const retry = await Promise.all(
        venues.map((v) =>
          this.cache.get<MarketTicker[]>(tickerKey(v, testnet)),
        ),
      );
      return retry.flatMap((r) => r ?? []);
    }
    return flat;
  }

  /**
   * Refresca la instantánea de los tres venues.
   *
   * Cada 30 s, y bajarlo no serviría de nada: lo que necesita ser inmediato
   * —el precio del par que alguien mira— ya no pasa por aquí, llega empujado
   * por el flujo. Esto solo mantiene fresco el volumen del día y los pares que
   * nadie está mirando, que se mueven despacio.
   *
   * Y bajarlo tendría un coste real: son tres llamadas al DEX por ciclo, con
   * peso alto —los `ticker/24hr` de todos los símbolos son de lo más caro que
   * publica un venue— contra el MISMO presupuesto de caudal por IP que usan los
   * bots para cancelar órdenes. Sondear más rápido aquí es quitarle caudal a lo
   * que mueve dinero, y el coste sería O(venues) igualmente inútil.
   *
   * El TTL de 5 minutos es diez veces el periodo a propósito: si el cron falla
   * un par de veces seguidas, la lista sigue enseñando algo con una marca de
   * tiempo que dice cuándo se tomó, en vez de vaciarse.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async refreshTickers(): Promise<void> {
    // Una sola réplica sondea. `@Cron` dispara en todas y, sin este cerrojo,
    // tres réplicas multiplicarían por tres las llamadas a los tres venues.
    if (!(await this.cache.setnx('lock:market-data-tickers', Date.now(), 25)))
      return;
    // LAS DOS REDES. Dejar testnet fuera del cron la condenaba a poblarse solo
    // por el camino de arranque en frío, o sea a que la primera pantalla que la
    // mirase se encontrara la lista vacía y tuviera que esperar a que llegara.
    // Un precio que tarda en aparecer es exactamente la diferencia que esto no
    // debe tener con mainnet.
    //
    // En paralelo y no en serie: son dos conjuntos independientes de venues y
    // encadenarlos doblaría el tiempo del ciclo por nada. Cada red gasta ya de
    // su propio depósito de caudal, así que no compiten.
    await Promise.all([this.fetchTickers(false), this.fetchTickers(true)]);
  }

  /**
   * El trabajo de verdad, SIN el cerrojo del cron.
   *
   * La separación importa: el cerrojo existe para que tres réplicas no
   * multipliquen por tres las llamadas cada 30 s, pero el arranque en frío
   * —primera petición de un usuario con la caché vacía— pasaba por él y se
   * encontraba el cerrojo tomado por un ciclo del cron que acababa de fallar.
   * Resultado: lista vacía durante 25 segundos y nada que lo explicara.
   *
   * Aquí la deduplicación es de proceso, con `single`: mil peticiones en frío
   * comparten una sola llamada a cada venue.
   */
  private fetchTickers(testnet = false): Promise<void> {
    return this.single(
      `md:tickers:refresh:${testnet ? 't' : 'm'}`,
      async () => {
        await Promise.all(
          Object.values(Venue).map(async (venue) => {
            try {
              const rows = await this.withAdapter(
                venue,
                (a) => a.getTickers(),
                testnet,
              );
              await this.cache.set(tickerKey(venue, testnet), rows, 300);
            } catch (e) {
              // Se avisa y se sigue: que Aster no responda no puede dejar sin
              // precios a Hyperliquid y a Lighter.
              // Recortado: esto corre cada 30 s y por tres venues. El detalle
              // crudo ya lo ha registrado `withAdapter` en `debug`.
              this.logger.warn(
                `No se pudieron leer los precios de ${venue}: ${shortMessage(messageOf(e))}`,
              );
            }
          }),
        );
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Interno
  // ═══════════════════════════════════════════════════════════════

  /**
   * Rechaza el intervalo ANTES de llegar al venue.
   *
   * El adaptador también lo comprueba, pero hacerlo aquí evita construirlo y
   * convierte el fallo en un 400 con un mensaje que se puede enseñar tal cual:
   * «Lighter no sirve velas de 3m. Intervalos disponibles: …».
   */
  private assertSupported(venue: Venue, interval: CandleInterval): void {
    const caps = this.capabilities()[venue];
    if (caps.candles.intervals.includes(interval)) return;
    throw new BadRequestException(
      `${venue} no sirve velas de ${interval}. Intervalos disponibles: ` +
        caps.candles.intervals.join(', ') +
        '.',
    );
  }

  /**
   * Adaptador PÚBLICO por venue, creado una vez y reutilizado.
   *
   * Antes se construía uno NUEVO en cada petición y se cerraba al terminar. Eso
   * tenía dos costes que se sumaban justo en el peor momento:
   *
   * · Su `MarketSpecCache` nacía vacía, así que traducir el símbolo a
   *   `market_id` obligaba a releer el catálogo entero. Una petición de velas
   *   costaba DOS llamadas al venue —el catálogo y las velas—, y el catálogo se
   *   volvía a descargar en la siguiente. El TTL de cinco minutos de la caché no
   *   llegaba a actuar nunca porque el objeto no sobrevivía a la petición.
   *
   * · Se creaba SIN `budget`, o sea con `NO_BUDGET`: la API no contabilizaba ni
   *   una de esas llamadas contra el cupo por IP que comparte con el worker.
   *
   * Reutilizado, la caché de specs hace su trabajo y el presupuesto es el mismo
   * que el de los bots — que es como lo cuenta el venue.
   */
  private adapterFor(venue: Venue, testnet = false): ExchangeAdapter {
    const clave = venueKey(venue, testnet);
    let adapter = this.adapters.get(clave);
    if (!adapter) {
      const { credentials, notice } = serviceCredentials(venue, this.config);
      // El modo elegido se dice UNA vez por venue. Es la diferencia entre 60
      // peticiones por minuto y el cupo de una cuenta autenticada, y elegirlo en
      // silencio es como se llega a un incidente que nadie sabe explicar.
      //
      // En testnet no se dice nada porque no hay nada que elegir: la cuenta de
      // servicio es de mainnet y `createPublicAdapter` la descarta allí.
      if (notice && !testnet) this.logger.log(notice);
      adapter = createPublicAdapter(venue, {
        budget: this.budget.budget,
        service: credentials,
        testnet,
      });
      this.adapters.set(clave, adapter);
    }
    return adapter;
  }

  /**
   * Ejecuta algo con el adaptador del venue.
   *
   * Ya NO lo cierra: el adaptador vive lo que viva el proceso y se cierra en
   * `onModuleDestroy`. Cerrarlo aquí era lo que obligaba a construir uno nuevo
   * en la siguiente petición.
   */
  private async withAdapter<T>(
    venue: Venue,
    fn: (adapter: ExchangeAdapter) => Promise<T>,
    testnet = false,
  ): Promise<T> {
    try {
      // Con TOPE de tiempo. El `fetch` de los adaptadores no lo tiene, y sin
      // esto un venue colgado retenía la petición hasta los 80 s del
      // interceptor global, el cron de precios se solapaba con el de la
      // siguiente réplica al caducar su cerrojo de 25 s, y cada usuario que
      // abría el par se quedaba esperando en el mismo single-flight. Los 12 s
      // cubren de sobra una respuesta normal y quedan por debajo del cerrojo.
      return await withTimeout(
        fn(this.adapterFor(venue, testnet)),
        VENUE_TIMEOUT_MS,
        venue,
      );
    } catch (e) {
      // Un intervalo no soportado que se cuele hasta aquí es petición mala, no
      // fallo del servicio: distinguirlos es lo que hace que el 400 lleve el
      // mensaje del adaptador y el 503 no mienta sobre de quién es el problema.
      if (e instanceof ExchangeError && e.kind === 'RULES') {
        throw new BadRequestException(e.message);
      }
      // El detalle COMPLETO va al log; a la pantalla va una línea.
      //
      // La página del cortafuegos de Lighter son cuatro kilobytes de HTML y se
      // vieron impresos encima del gráfico, con el CAPTCHA y todo. Ningún
      // cuerpo de error de un venue puede llegar entero a un usuario.
      const detail = messageOf(e);
      this.logger.warn(`${venue} no ha servido estos datos: ${detail}`);
      // El cuerpo CRUDO del venue, solo en debug. Es donde está la pista real
      // —la página del cortafuegos, el código de error del exchange— y son
      // kilobytes: en `warn` inundaría el log cada 30 s.
      const crudo = e instanceof ExchangeError ? e.raw : undefined;
      if (crudo !== undefined)
        this.logger.debug(
          `${venue} respondió: ${shortMessage(String(crudo), 600)}`,
        );

      // Un corte del venue no es una avería nuestra y se dice distinto: al
      // usuario le sirve saber que hay que esperar, no que «falló algo».
      if (e instanceof ExchangeError && e.kind === 'THROTTLED') {
        throw new ServiceUnavailableException(
          `${venue} ha limitado nuestras peticiones. Vuelve a intentarlo en un minuto.`,
        );
      }
      // «No ha servido» y no «no ha respondido»: la mitad de las veces el venue
      // SI responde —con un rechazo del borde, un 403 o un 429— y decir que no
      // ha respondido manda a buscar el fallo en la red, que es donde no está.
      throw new ServiceUnavailableException(
        `${venue} no ha servido estos datos: ${shortMessage(detail)}`,
      );
    }
  }

  /** Una sola petición en vuelo por clave; el resto espera a esa misma. */
  private single<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;

    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

const tickerKey = (venue: Venue, testnet = false): string =>
  `md:tickers:${venueKey(venue, testnet)}`;

/** Tope por llamada al venue. Por debajo del cerrojo del cron (25 s). */
const VENUE_TIMEOUT_MS = 12_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  venue: Venue,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${venue} no ha respondido en ${ms / 1000} s.`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Escalones de `limit` admitidos. Un valor intermedio sube al siguiente. */
const LIMIT_STEPS = [2, 50, 150, 300, 600, 1000, 1500] as const;

function quantizeLimit(limit: number | undefined): number {
  const wanted = Math.min(Math.max(1, limit ?? 300), 1500);
  return LIMIT_STEPS.find((step) => step >= wanted) ?? 1500;
}

/**
 * Alinea `endMs` al cierre de vela del intervalo.
 *
 * Dos usuarios paginando hacia atrás con un milisegundo de diferencia piden la
 * misma ventana; alineado, también comparten la misma entrada de caché. Y un
 * `endMs` en el futuro no significa nada: se trata como «ahora».
 */
function quantizeEnd(
  interval: CandleInterval,
  endMs: number | undefined,
): number | undefined {
  if (endMs === undefined || endMs >= Date.now()) return undefined;
  const span = candleSpanMs(interval);
  return Math.floor(endMs / span) * span;
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
