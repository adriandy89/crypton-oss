import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject, concat, of, type Subscription } from 'rxjs';
import { venueKey } from '@crypton/shared';
import type { Candle, CandleInterval, Ticker, Venue } from '@crypton/shared';
import {
  createPublicAdapter,
  serviceCredentials,
  type ExchangeAdapter,
} from '@crypton/exchange-core';
import { BUS_CHANNELS, BusService, VenueBudgetProvider } from '../libs';

/** Cuánto vale un precio pedido por REST antes de volver a pedirlo. */
const REST_TTL_MS = 1000;

/** A partir de aquí un precio se considera viejo y no sirve para planificar. */
const STALE_MS = 20_000;

/** Cuánto vive el precio publicado en Redis para el resto de procesos. */
const SHARED_TTL_SECONDS = 30;

/**
 * Freno de compartición: cada cuánto, como mucho, sale un precio del proceso.
 *
 * El stream de un símbolo líquido late varias veces por segundo. Medio segundo
 * es indistinguible de tiempo real en una pantalla y divide por diez tanto las
 * escrituras en Redis como los mensajes del bus.
 */
const SHARE_EVERY_MS = 500;

interface SymbolFeed {
  subject: Subject<Ticker>;
  last: Ticker | null;
  refs: number;
  /**
   * La suscripción al venue, GUARDADA.
   *
   * Antes se descartaba el retorno de `.subscribe()`, así que al llegar el
   * contador a cero se borraba el feed y el WebSocket seguía vivo: el siguiente
   * `subscribe()` del mismo símbolo abría OTRA. Abrir y cerrar la pantalla de
   * un par veinte veces eran veinte suscripciones al mismo dato contra el
   * límite del venue — justo el problema que este servicio existe para
   * resolver.
   */
  venueSub: Subscription | null;
  /** Petición REST en vuelo, para no lanzar N idénticas a la vez. */
  inflight: Promise<Ticker> | null;
  fetchedAt: number;
  /** Última publicación en Redis, para no escribir en cada latido del stream. */
  sharedAt: number;
}

/**
 * Feed de velas de un par Y una resolucion.
 *
 * Aparte del de precios y no dentro de el porque la unidad de suscripcion del
 * venue es otra: un ticker es por simbolo y una vela es por simbolo Y
 * resolucion. Diez usuarios en BTC/1h comparten una; uno de ellos que cambie a
 * 1m abre otra y suelta la primera.
 */
interface CandleFeed {
  last: Candle | null;
  refs: number;
  /** La suscripcion al venue, guardada para poder soltarla. Ver `SymbolFeed`. */
  venueSub: Subscription | null;
  sharedAt: number;
}

/**
 * Feed de precios COMPARTIDO.
 *
 * Los precios son información pública, así que compartirlos entre todos los
 * bots y todos los usuarios no cuesta nada en seguridad: este servicio usa
 * `createPublicAdapter`, que se construye SIN credenciales y no puede firmar
 * nada. Ningún secreto pasa por aquí.
 *
 * Lo que arregla:
 *
 * · Cada bot abría su propia conexión al venue y su propia suscripción de
 *   precio. Mil bots sobre BTC eran mil suscripciones al mismo dato, contra un
 *   límite de DIEZ conexiones por IP en Hyperliquid («Maximum of 10 websocket
 *   connections» en su documentación; este comentario decía cien).
 *
 * · Cada tick pedía el precio por REST —una llamada de las cuatro por bot y
 *   tick— aunque el WebSocket ya lo estuviera entregando. Con quince segundos
 *   de latido eso son cuatro llamadas por minuto y bot solo para saber un
 *   número que ya se tenía.
 *
 * Ahora hay UNA suscripción por símbolo distinto y una petición REST por
 * símbolo y segundo como mucho, la pidan uno o mil bots. Y el último precio se
 * publica en Redis para que la API tampoco tenga que ir al venue —ni abrir un
 * adaptador con la credencial de un usuario— solo para pintar un preview.
 */
@Injectable()
export class MarketDataService implements OnModuleDestroy {
  private readonly logger = new Logger(MarketDataService.name);
  /** Uno por venue Y RED: son dos hosts distintos. Ver `adapterFor`. */
  private readonly adapters = new Map<string, ExchangeAdapter>();
  private readonly feeds = new Map<string, SymbolFeed>();
  /** Clave `venue:symbol:interval`. Ver `CandleFeed`. */
  private readonly candleFeeds = new Map<string, CandleFeed>();
  private closed = false;

  constructor(
    private readonly bus: BusService,
    private readonly budget: VenueBudgetProvider,
    private readonly config: ConfigService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    for (const feed of this.feeds.values()) {
      // La baja en el venue va ANTES de completar: sin esto, cerrar el proceso
      // dejaba las suscripciones abiertas hasta que el venue las expiraba.
      feed.venueSub?.unsubscribe();
      feed.subject.complete();
    }
    this.feeds.clear();
    for (const feed of this.candleFeeds.values()) feed.venueSub?.unsubscribe();
    this.candleFeeds.clear();
    await Promise.allSettled([...this.adapters.values()].map((a) => a.close()));
    this.adapters.clear();
  }

  // ═══════════════════════════════════════════════════════════════
  // Suscripción
  // ═══════════════════════════════════════════════════════════════

  /**
   * Declara interés en un símbolo y devuelve su flujo de precios.
   *
   * El contador de referencias es lo que permite cerrar la suscripción cuando
   * el último bot de ese símbolo se va: sin él, un worker que hubiera tocado
   * cien símbolos a lo largo del día mantendría las cien suscripciones abiertas
   * para siempre.
   */
  subscribe(venue: Venue, symbol: string, testnet = false): Observable<Ticker> {
    const feed = this.feedFor(venue, symbol, testnet);
    feed.refs++;

    if (!feed.venueSub) {
      feed.venueSub = this.adapterFor(venue, testnet)
        .streamTicker(symbol)
        .subscribe({
          next: (t) => this.publish(venue, symbol, t, testnet),
          error: (e) => {
            // No se cierra el flujo: el respaldo por REST sigue sirviendo y una
            // reconexión debe poder volver a entregar por el mismo canal.
            feed.venueSub = null;
            this.logger.warn(
              `Stream de ${venueKey(venue, testnet)}:${symbol} caído: ${(e as Error).message}`,
            );
          },
        });
    }

    // Se SIEMBRA con el último precio conocido.
    //
    // Un `Subject` solo entrega lo que llega después de suscribirse, así que
    // quien llega tarde a un símbolo ya vivo no veía nada hasta el siguiente
    // tick — en un par poco líquido, minutos. Con los bots no se notaba: el
    // motor pide el precio por REST en su primer tick. En cuanto lo mira un
    // usuario, es un gráfico en blanco sin explicación.
    //
    // La siembra sale de `peek()` y no de un `ReplaySubject`, que reemitiría el
    // último valor tenga la edad que tenga. `peek()` ya aplica la regla de la
    // casa —nada más viejo que `STALE_MS`, medido sobre el `ts` que puso el
    // venue— y así la regla vive en un solo sitio. Y solo afecta a la siembra:
    // los ticks vivos pasan siempre, porque descartarlos en silencio por un
    // reloj desajustado en el venue dejaría un feed mudo sin nada que lo
    // explicara.
    const live$ = feed.subject.asObservable();
    const seed = this.peek(venue, symbol, testnet);
    return seed ? concat(of(seed), live$) : live$;
  }

  /** Suelta el interés. Al llegar a cero, el feed deja de mantenerse. */
  release(venue: Venue, symbol: string, testnet = false): void {
    const feed = this.feeds.get(key(venue, symbol, testnet));
    if (!feed) return;
    feed.refs = Math.max(0, feed.refs - 1);
    if (feed.refs === 0) {
      feed.venueSub?.unsubscribe();
      feed.venueSub = null;
      feed.subject.complete();
      this.feeds.delete(key(venue, symbol, testnet));
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Velas en vivo
  // ═══════════════════════════════════════════════════════════════

  /**
   * Declara interés en las velas de un par y una resolución.
   *
   * Es lo que sustituye al sondeo del gráfico. Antes la pantalla pedía las dos
   * últimas velas cada cinco segundos y la API se las servía de una caché de
   * quince: dos de cada tres respuestas llegaban idénticas y el cierre de la
   * vela iba hasta veinte segundos por detrás del precio de la cabecera — que
   * sí venía en vivo. Aquí la vela la entrega el venue por WebSocket, con su
   * volumen de verdad, que es el dato que un tick de precio no puede traer.
   *
   * Devuelve `false` si el venue no tiene stream de velas —Lighter no lo
   * tiene— para que quien lo pida sepa que le toca componerla desde el precio,
   * en vez de quedarse esperando algo que no va a llegar.
   */
  subscribeCandles(
    venue: Venue,
    symbol: string,
    interval: CandleInterval,
    testnet = false,
  ): boolean {
    const adapter = this.adapterFor(venue, testnet);
    if (!adapter.streamCandles) return false;

    const k = candleKey(venue, symbol, interval, testnet);
    let feed = this.candleFeeds.get(k);
    if (!feed) {
      feed = { last: null, refs: 0, venueSub: null, sharedAt: 0 };
      this.candleFeeds.set(k, feed);
    }
    feed.refs++;

    if (!feed.venueSub) {
      feed.venueSub = adapter.streamCandles(symbol, interval).subscribe({
        next: (candle) => this.publishCandle(venue, symbol, interval, candle, testnet),
        error: (e) => {
          // Igual que con los precios: no se cierra el feed. El respaldo por
          // REST del cliente sigue sirviendo y una reconexión debe poder
          // volver a entregar por el mismo canal.
          feed!.venueSub = null;
          this.logger.warn(
            `Stream de velas ${venueKey(venue, testnet)}:${symbol}:${interval} caído: ` +
              (e as Error).message,
          );
        },
      });
    }
    return true;
  }

  /** Suelta el interés. Al llegar a cero se cierra la suscripción del venue. */
  releaseCandles(
    venue: Venue,
    symbol: string,
    interval: CandleInterval,
    testnet = false,
  ): void {
    const k = candleKey(venue, symbol, interval, testnet);
    const feed = this.candleFeeds.get(k);
    if (!feed) return;
    feed.refs = Math.max(0, feed.refs - 1);
    if (feed.refs === 0) {
      feed.venueSub?.unsubscribe();
      feed.venueSub = null;
      this.candleFeeds.delete(k);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Lectura
  // ═══════════════════════════════════════════════════════════════

  /** Último precio conocido, o null si no hay ninguno o ya está viejo. */
  peek(venue: Venue, symbol: string, testnet = false): Ticker | null {
    const feed = this.feeds.get(key(venue, symbol, testnet));
    if (!feed?.last) return null;
    return Date.now() - feed.last.ts > STALE_MS ? null : feed.last;
  }

  /**
   * Precio vigente. Sirve el del stream si está fresco; si no, va por REST.
   *
   * La petición REST se comparte: si veinte bots del mismo símbolo la piden a
   * la vez, sale UNA. Es el mismo patrón de `MarketSpecCache`, que ya resolvía
   * esto para las specs pero no para los precios.
   */
  async ticker(venue: Venue, symbol: string, testnet = false): Promise<Ticker> {
    const fresh = this.peek(venue, symbol, testnet);
    if (fresh && Date.now() - fresh.ts < REST_TTL_MS) return fresh;

    const feed = this.feedFor(venue, symbol, testnet);
    if (feed.inflight) return feed.inflight;

    feed.inflight = this.adapterFor(venue, testnet)
      .getTicker(symbol)
      .then((t) => {
        this.publish(venue, symbol, t, testnet);
        return t;
      })
      .finally(() => {
        feed.inflight = null;
      });

    try {
      return await feed.inflight;
    } catch (e) {
      // Caída del REST: el último precio del stream vale como respaldo SOLO si
      // es reciente. Devolver uno viejo aquí acababa dentro de `plan()` sin que
      // nadie mirase la marca de tiempo, y planificar —o cerrar a mercado— con
      // un precio pasado es peor que fallar el tick y reintentar.
      if (feed.last && Date.now() - feed.last.ts < STALE_MS) return feed.last;
      throw e;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Interno
  // ═══════════════════════════════════════════════════════════════

  private feedFor(venue: Venue, symbol: string, testnet = false): SymbolFeed {
    const k = key(venue, symbol, testnet);
    let feed = this.feeds.get(k);
    if (!feed) {
      feed = {
        subject: new Subject<Ticker>(),
        last: null,
        refs: 0,
        venueSub: null,
        inflight: null,
        fetchedAt: 0,
        sharedAt: 0,
      };
      this.feeds.set(k, feed);
    }
    return feed;
  }

  /**
   * Adaptador PÚBLICO por venue: sin credenciales, incapaz de firmar.
   *
   * Es lo que hace que compartir sea seguro. Antes, leer un precio obligaba a
   * construir un adaptador autenticado, y la sincronización de mercados llegó a
   * descifrar la clave privada de un usuario cualquiera para una consulta que
   * no necesita firma. Aquí no hay ninguna clave que descifrar.
   */
  private adapterFor(venue: Venue, testnet = false): ExchangeAdapter {
    const clave = venueKey(venue, testnet);
    let adapter = this.adapters.get(clave);
    if (!adapter) {
      const { credentials, notice } = serviceCredentials(venue, this.config);
      // El modo elegido se anuncia UNA vez por venue: firmando o sin firmar hay
      // un factor enorme de diferencia en el cupo, y decidirlo en silencio es
      // como se llega a un incidente que nadie sabe explicar.
      //
      // En testnet no hay nada que anunciar: la cuenta de servicio es de mainnet
      // y `createPublicAdapter` la descarta allí.
      if (notice && !testnet) this.logger.log(notice);
      adapter = createPublicAdapter(venue, {
        testnet,
        rateLimitPerSecond: Number(this.config.get('MARKETDATA_RATE_LIMIT_PER_SECOND', 6)),
        // El MISMO presupuesto que los adaptadores de cuenta: los precios
        // públicos y las órdenes salen por la misma IP y el venue los cuenta
        // juntos, así que un feed goloso no puede dejar sin caudal a una orden.
        budget: this.budget.budget,
        // La cuenta de SERVICIO, no la de ningún usuario: este camino no puede
        // descifrar la clave de nadie para leer un precio público.
        service: credentials,
      });
      this.adapters.set(clave, adapter);
    }
    return adapter;
  }

  private publish(venue: Venue, symbol: string, ticker: Ticker, testnet = false): void {
    if (this.closed) return;
    const feed = this.feedFor(venue, symbol, testnet);
    feed.last = ticker;
    feed.fetchedAt = Date.now();
    feed.subject.next(ticker);

    // Se comparte con el resto de procesos. La API lo usa para el preview en
    // lugar de rebuscar en los snapshots de bots ajenos o de abrir un adaptador
    // con la credencial del usuario para leer un dato público.
    //
    // Con freno: el stream de un símbolo líquido late varias veces por segundo
    // y escribir cada latido en Redis multiplicaba las escrituras por nada —
    // para un preview, un precio de hace medio segundo es exacto de sobra.
    if (Date.now() - feed.sharedAt < SHARE_EVERY_MS) return;
    feed.sharedAt = Date.now();
    void this.bus
      .cacheSet(sharedKey(venue, symbol, testnet), ticker, SHARED_TTL_SECONDS)
      .catch(() => undefined);

    // Y SE DICE EN VOZ ALTA. Este es el eslabón que faltaba para que los
    // precios lleguen empujados a la aplicación en vez de sondeados.
    //
    // Todo lo demás ya estaba: una suscripción por símbolo con contador de
    // referencias, un adaptador público sin credenciales y el reparto a N
    // conexiones en la API. Lo único que no había era esta línea, así que el
    // precio se quedaba en Redis esperando a que alguien preguntara — y quien
    // preguntaba era la aplicación, cada diez segundos, trayéndose los 935
    // pares para pintar los quince que caben en la pantalla.
    //
    // Va por el canal PÚBLICO: un precio no tiene destinatario. Y bajo el mismo
    // freno que la escritura en Redis, que ya está calibrado para que un par
    // líquido —que late varias veces por segundo— no inunde a nadie.
    void this.bus
      .publishPublic(BUS_CHANNELS.MARKET_TICKS, {
        type: 'TICK',
        data: { venue, symbol, last: ticker.last, ts: ticker.ts, testnet },
      })
      .catch(() => undefined);
  }

  /**
   * Saca una vela al bus para que la API la reparta a quien la mire.
   *
   * Mismo freno que los precios: el WebSocket de un par líquido reemite la vela
   * en formación varias veces por segundo, y medio segundo es indistinguible de
   * tiempo real en una pantalla.
   *
   * El RELEVO de barra es la excepción y no pasa por el freno. Ver dentro.
   */
  private publishCandle(
    venue: Venue,
    symbol: string,
    interval: CandleInterval,
    candle: Candle,
    testnet = false,
  ): void {
    if (this.closed) return;
    const feed = this.candleFeeds.get(candleKey(venue, symbol, interval, testnet));
    if (!feed) return;

    const anterior = feed.last;
    const relevo = anterior !== null && candle.t > anterior.t;
    feed.last = candle;

    if (relevo) {
      // La barra que se CIERRA sale con su último estado, sí o sí.
      //
      // Sin esto, el freno se comía sus últimas actualizaciones y la barra
      // quedaba archivada con un cierre viejo: el venue la cerró en 60 y el
      // gráfico enseñaba 10, para siempre, sin ningún error y sin nada que lo
      // delatara. Es el único mensaje de esta serie que no se puede perder,
      // porque fija el máximo, el mínimo, el cierre y el volumen definitivos de
      // esa barra — y llega una sola vez por intervalo, así que no hay nada que
      // frenar.
      this.emitCandle(venue, symbol, interval, anterior, testnet);
      feed.sharedAt = Date.now();
      this.emitCandle(venue, symbol, interval, candle, testnet);
      return;
    }

    if (Date.now() - feed.sharedAt < SHARE_EVERY_MS) return;
    feed.sharedAt = Date.now();
    this.emitCandle(venue, symbol, interval, candle, testnet);
  }

  private emitCandle(
    venue: Venue,
    symbol: string,
    interval: CandleInterval,
    candle: Candle,
    testnet = false,
  ): void {
    void this.bus
      .publishPublic(BUS_CHANNELS.MARKET_CANDLES, {
        type: 'CANDLE',
        data: { venue, symbol, interval, candle, testnet },
      })
      .catch(() => undefined);
  }
}

const key = (venue: Venue, symbol: string, testnet = false): string =>
  `${venueKey(venue, testnet)}:${symbol}`;
const candleKey = (
  venue: Venue,
  symbol: string,
  interval: CandleInterval,
  testnet = false,
): string => `${venueKey(venue, testnet)}:${symbol}:${interval}`;

/**
 * Clave del precio compartido. La lee también la API.
 *
 * `venueKey` deja la de mainnet EXACTAMENTE como era: sin sufijo. Lo que ya
 * estuviera cacheado sigue sirviendo al desplegar, en vez de quedar huérfano de
 * golpe y dejar la primera pantalla en blanco mientras se repuebla.
 */
export const sharedKey = (venue: Venue, symbol: string, testnet = false): string =>
  `crypton:px:${venueKey(venue, testnet)}:${symbol}`;
