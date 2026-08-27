import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PriceSource,
  SourceMarketType,
  binanceSymbol,
  fairPriceKey,
  fairPriceRedisKey,
} from '@crypton/shared';
import { BusService } from '../libs';

/** Qué feed externo quiere un bot. */
export interface FairPriceRequest {
  source: PriceSource;
  marketType: SourceMarketType;
  /** Moneda base del mercado del bot: `BTC` en `BTC/USDC`. */
  base: string;
  /** «Símbolo de origen alternativo»: manda sobre el mapeo automático. */
  override?: string | null;
}

export interface FairPrice {
  price: string;
  ts: number;
}

/**
 * Cada cuánto se pregunta a cada fuente.
 *
 * Binance admite mucho más ritmo, pero el tick del motor es de quince segundos:
 * pedir el precio más de una vez cada dos segundos no cambiaría una sola orden
 * y sí gastaría cuota compartida por todos los bots.
 */
const POLL_MS: Record<PriceSource, number> = {
  [PriceSource.EXCHANGE]: 0,
  [PriceSource.BINANCE]: 2_000,
};

/** Cuánto vive el precio publicado para el resto de procesos. */
const SHARED_TTL_SECONDS = 30;

/** Corta una petición colgada antes de que bloquee el siguiente sondeo. */
const HTTP_TIMEOUT_MS = 5_000;

/**
 * Tope del retroceso ante un bloqueo o un baneo por caudal.
 *
 * Cinco minutos: lo bastante espaciado como para no alargar un baneo, y lo
 * bastante corto como para que un bloqueo que se levanta se note en el mismo
 * rato en que el usuario está mirando.
 */
const MAX_BACKOFF_MS = 300_000;

/**
 * Por qué no llega el precio.
 *
 * No es decoración: decide DOS cosas distintas. Con qué ritmo se reintenta —a un
 * baneo por caudal se le contesta martilleando y se alarga solo— y qué se le
 * cuenta al usuario, porque «Binance no atiende a la IP de este servidor» y «la
 * red va mal» se arreglan de formas que no se parecen en nada.
 */
export type FeedFailureCause = 'GEO' | 'THROTTLED' | 'OTHER';

/** Estado de un feed que NO está sirviendo precio. null = va bien. */
export interface FeedStatus {
  cause: FeedFailureCause;
  failures: number;
  /** Intervalo de sondeo vigente. Sube con el retroceso. */
  pollMs: number;
}

/**
 * Un HTTP que no es 2xx, ya clasificado.
 *
 * Se clasifica AQUÍ y no donde se captura porque es el único punto que ve el
 * código de estado: más arriba solo queda el mensaje, y distinguir un bloqueo
 * geográfico de un fallo de red leyendo una cadena es exactamente el tipo de
 * cosa que deja de funcionar en silencio.
 */
class SourceHttpError extends Error {
  readonly kind: FeedFailureCause;

  constructor(readonly status: number) {
    super('HTTP ' + status);
    this.name = 'SourceHttpError';
    this.kind = kindOfStatus(status);
  }
}

function kindOfStatus(status: number): FeedFailureCause {
  // 451 es literalmente «no disponible por razones legales»: es el bloqueo por
  // territorio, y reintentarlo rápido no lo arregla nunca.
  if (status === 451) return 'GEO';
  // 429 es el aviso; 418 es el baneo automático de IP que llega tras ignorarlo;
  // 403 es el WAF. Los tres se arreglan esperando, y solo esperando.
  if (status === 429 || status === 418 || status === 403) return 'THROTTLED';
  return 'OTHER';
}

interface Feed {
  req: FairPriceRequest;
  refs: number;
  last: FairPrice | null;
  timer: NodeJS.Timeout | null;
  /** Fallos seguidos. Solo se registra el primero: si no, inunda el log. */
  failures: number;
  /** Por qué falla, o null si el último sondeo fue bien. */
  cause: FeedFailureCause | null;
  /** Intervalo con el que está programado el temporizador AHORA MISMO. */
  pollMs: number;
  /**
   * Hay un sondeo en vuelo.
   *
   * Sin esto, una fuente que tarda más que el intervalo acumula peticiones: con
   * el sondeo de dos segundos y el corte a los cinco, hasta tres a la vez y
   * subiendo — justo cuando la fuente ya está en apuros.
   */
  polling: boolean;
}

/**
 * Feed de precios de fuentes AJENAS al venue (Binance).
 *
 * Existe porque un market maker que cotiza contra el mid de su propio venue
 * está anclado a un libro que él mismo mueve: en un par poco líquido, sus
 * propias órdenes son el precio. Anclar a un mercado de referencia externo
 * rompe ese bucle.
 *
 * Sigue el mismo contrato que `MarketDataService`: contador de referencias y un
 * feed por (fuente, tipo de mercado, símbolo), lo pidan uno o mil bots.
 *
 * El último valor va también a Redis, pero conviene ser exacto sobre para qué
 * sirve: aquí decía «para que no haga falta repetir la llamada en cada réplica»
 * y eso NO es lo que hace —cada réplica sigue sondeando por su cuenta—. Lo que
 * hace es que un feed recién abierto arranque con precio en vez de con `null`,
 * que es lo que importa cuando un bot cambia de worker. Ver `seed`.
 *
 * Se sondea por REST en vez de abrir un WebSocket a propósito. El motor
 * reconcilia cada quince segundos, así que un sondeo de dos no añade latencia
 * observable, y a cambio no hay que mantener reconexión, backoff y detección de
 * conexión muerta contra dos servicios más —tres piezas que ya existen en el
 * adaptador de Aster y que son justo las que fallan en silencio. Si algún día
 * hace falta latencia de verdad, el WebSocket entra detrás de esta misma
 * interfaz sin tocar la estrategia.
 *
 * Ninguna de las dos fuentes necesita credenciales: este servicio no puede
 * firmar nada, igual que el feed público del venue.
 */
@Injectable()
export class PriceSourceService implements OnModuleDestroy {
  private readonly logger = new Logger(PriceSourceService.name);
  private readonly feeds = new Map<string, Feed>();

  private readonly binanceRest: string;
  private readonly binanceFapi: string;

  constructor(
    private readonly bus: BusService,
    private readonly config: ConfigService,
  ) {
    this.binanceRest = this.config.get<string>('BINANCE_REST_URL') ?? 'https://api.binance.com';
    this.binanceFapi = this.config.get<string>('BINANCE_FAPI_URL') ?? 'https://fapi.binance.com';
  }

  /** Clave del feed compartido. Dos bots con la misma petición comparten uno. */
  keyOf(req: FairPriceRequest): string {
    return fairPriceKey(req.source, req.marketType, this.venueSymbol(req) ?? req.base);
  }

  /**
   * Declara interés. Idempotente por bot: el llamante debe emparejarlo con un
   * `release()`, igual que en `MarketDataService`.
   */
  acquire(req: FairPriceRequest): string | null {
    if (req.source === PriceSource.EXCHANGE) return null;
    if (this.venueSymbol(req) == null) {
      this.logger.warn(
        'Sin símbolo para ' + req.source + '/' + req.base + ': el bot no tendrá precio externo.',
      );
      return null;
    }

    const key = this.keyOf(req);
    const existing = this.feeds.get(key);
    if (existing) {
      existing.refs += 1;
      return key;
    }

    const feed: Feed = {
      req,
      refs: 1,
      last: null,
      timer: null,
      failures: 0,
      cause: null,
      pollMs: POLL_MS[req.source],
      polling: false,
    };
    this.feeds.set(key, feed);
    // El temporizador se arma ANTES del primer sondeo, y el orden importa: si el
    // sondeo falla y `reschedule` cambia el ritmo, hacerlo al revés dejaría un
    // `setInterval` huérfano —el que creó `reschedule`— porque la línea de abajo
    // lo pisaría sin cancelarlo. Hoy no pasa porque `fetch` es asíncrono y el
    // fallo llega en un microtask posterior, pero es una garantía prestada.
    feed.timer = setInterval(() => void this.poll(key), feed.pollMs);
    feed.timer.unref?.();
    // Primer sondeo ya, sin esperar al intervalo: si no, el primer tick del bot
    // vería `null` y no cotizaría durante los primeros segundos de vida.
    void this.poll(key);
    void this.seed(key, feed);
    this.logger.log('Feed externo abierto: ' + key);
    return key;
  }

  release(key: string | null): void {
    if (!key) return;
    const feed = this.feeds.get(key);
    if (!feed) return;
    feed.refs -= 1;
    if (feed.refs > 0) return;

    if (feed.timer) clearInterval(feed.timer);
    this.feeds.delete(key);
    this.logger.log('Feed externo cerrado: ' + key);
  }

  /**
   * Último precio conocido, sin red.
   *
   * Devuelve el valor con su marca de tiempo y NO decide si está rancio: esa
   * decisión es del motor, que conoce su propio umbral. Devolver aquí un `null`
   * por antigüedad escondería la diferencia entre «nunca hubo precio» y «lo
   * hubo hace un minuto», que se tratan distinto.
   */
  peek(key: string | null): FairPrice | null {
    if (!key) return null;
    return this.feeds.get(key)?.last ?? null;
  }

  /**
   * Por qué este feed no sirve precio, o null si va bien.
   *
   * Existe para que el motor pueda decir la CAUSA en su evento. Antes solo podía
   * decir «sin precio de binance», que es verdad y no sirve de nada: el usuario
   * no puede distinguir un corte de red pasajero de un bloqueo por territorio
   * que no se va a arreglar solo, y son dos acciones distintas.
   */
  status(key: string | null): FeedStatus | null {
    if (!key) return null;
    const feed = this.feeds.get(key);
    if (!feed || feed.cause === null) return null;
    return { cause: feed.cause, failures: feed.failures, pollMs: feed.pollMs };
  }

  onModuleDestroy(): void {
    for (const feed of this.feeds.values()) {
      if (feed.timer) clearInterval(feed.timer);
    }
    this.feeds.clear();
  }

  // ── Interno ────────────────────────────────────────────────────────────

  /** Símbolo tal y como lo espera la fuente; null si no se puede resolver. */
  private venueSymbol(req: FairPriceRequest): string | null {
    if (req.source === PriceSource.BINANCE) return binanceSymbol(req.base, req.override);
    // Cualquier otra cosa —incluida una fuente retirada que siguiera guardada en
    // la configuración de un bot antiguo— no se puede resolver. Devolver null
    // hace que `acquire` avise y el bot se quede sin precio externo, que es la
    // única respuesta honesta: caer a otra fuente por nuestra cuenta sería
    // cambiarle el precio contra el que opera sin que lo haya pedido.
    return null;
  }

  private async poll(key: string): Promise<void> {
    const feed = this.feeds.get(key);
    if (!feed || feed.polling) return;
    feed.polling = true;

    try {
      // Llamada directa y no un ternario: solo queda una fuente externa, y
      // dejar una rama muerta esperando a la siguiente es como se acumulan los
      // caminos que nadie recorre.
      const price = await this.fetchBinance(feed.req);

      if (price == null) throw new Error('respuesta sin precio');

      feed.last = { price, ts: Date.now() };
      feed.failures = 0;
      feed.cause = null;
      // Vuelta al ritmo normal en cuanto la fuente responde. Va aquí y no solo
      // en el camino de fallo porque un retroceso que no se deshace convierte un
      // corte de treinta segundos en cinco minutos sin cotizar.
      this.reschedule(key, feed, POLL_MS[feed.req.source]);
      await this.bus.cacheSet(fairPriceRedisKey(key), feed.last, SHARED_TTL_SECONDS);
    } catch (e) {
      const cause = e instanceof SourceHttpError ? e.kind : 'OTHER';
      feed.failures += 1;
      feed.cause = cause;
      // Solo el primer fallo de una racha: una fuente caída sondeada cada dos
      // segundos llenaría el log con la misma línea mil ochocientas veces por
      // hora, y el bot ya deja de cotizar por su cuenta al quedarse sin precio.
      if (feed.failures === 1) {
        this.logger.warn(key + ' [' + cause + ']: ' + (e as Error).message);
      }

      // Retroceso SOLO para lo que se arregla esperando. Un timeout o un fallo
      // de red se reintentan al ritmo normal: espaciarlos alargaría el hueco sin
      // ganar nada, porque nadie al otro lado está contando nuestras peticiones.
      if (cause === 'GEO' || cause === 'THROTTLED') {
        const base = POLL_MS[feed.req.source];
        this.reschedule(key, feed, Math.min(base * 2 ** feed.failures, MAX_BACKOFF_MS));
      }
    } finally {
      feed.polling = false;
    }
  }

  /**
   * Arranca el feed con el último precio que dejó publicado otra réplica.
   *
   * La escritura en Redis existía desde el principio, pero **no la leía nadie**:
   * era un `SET` cada dos segundos sin un solo lector, y su comentario prometía
   * un ahorro que no ocurría. Esto es lo que la hace valer algo.
   *
   * Lo que resuelve —y conviene no exagerarlo— es el hueco de arranque: cuando
   * un bot cambia de worker, o una réplica se reinicia, su feed nace vacío y el
   * bot no cotiza hasta que llega la primera respuesta. Con la semilla cotiza
   * desde el primer tick. Lo que NO hace es evitar que cada réplica sondee por
   * su cuenta: para eso haría falta elegir un líder, y no compensa.
   *
   * Nunca pisa un precio propio: si el sondeo inmediato ganó la carrera, el suyo
   * es más nuevo por definición.
   */
  private async seed(key: string, feed: Feed): Promise<void> {
    try {
      const shared = await this.bus.cacheGet<FairPrice>(fairPriceRedisKey(key));
      if (!shared || feed.last) return;
      // Y solo si el feed sigue vivo: entre la lectura y aquí pudo soltarse.
      if (this.feeds.get(key) !== feed) return;
      feed.last = shared;
    } catch {
      // Redis caído no es motivo para no abrir el feed: el sondeo directo va a
      // traer el precio de todas formas.
    }
  }

  /**
   * Cambia el ritmo del sondeo, si de verdad cambia.
   *
   * Reprogramar el temporizador desde dentro de su propia devolución de llamada
   * es correcto en Node, pero hacerlo en cada sondeo tiraría y recrearía un
   * `setInterval` cada dos segundos para nada — de ahí la comparación.
   */
  private reschedule(key: string, feed: Feed, pollMs: number): void {
    // El feed pudo SOLTARSE mientras su sondeo estaba en vuelo: `release` limpia
    // el temporizador y borra la entrada, y este `reschedule` —que llega
    // después, desde el `catch` o el `finally` de aquel sondeo— crearía un
    // `setInterval` sobre un feed que ya no está en el mapa. Nadie volvería a
    // cancelarlo: quedaría llamando a `poll` para siempre, aunque `poll` no
    // encuentre nada que hacer. Es exactamente el temporizador huérfano contra
    // el que avisa el comentario de `acquire`.
    if (this.feeds.get(key) !== feed) return;
    if (feed.pollMs === pollMs) return;
    feed.pollMs = pollMs;
    if (feed.timer) clearInterval(feed.timer);
    feed.timer = setInterval(() => void this.poll(key), pollMs);
    feed.timer.unref?.();
  }

  private async fetchBinance(req: FairPriceRequest): Promise<string | null> {
    const symbol = binanceSymbol(req.base, req.override);

    if (req.marketType === SourceMarketType.INDEX) {
      const body = await this.getJson<{ indexPrice?: string; markPrice?: string }>(
        this.binanceFapi + '/fapi/v1/premiumIndex?symbol=' + symbol,
      );
      return body.indexPrice ?? body.markPrice ?? null;
    }

    // Mid del BBO y no el último negociado: el último precio es un trade que ya
    // pasó y puede estar en cualquiera de los dos lados del diferencial, así que
    // introduce un sesgo sistemático en la referencia contra la que cotizamos.
    const base =
      req.marketType === SourceMarketType.SPOT
        ? this.binanceRest + '/api/v3/ticker/bookTicker?symbol='
        : this.binanceFapi + '/fapi/v1/ticker/bookTicker?symbol=';

    const body = await this.getJson<{ bidPrice?: string; askPrice?: string }>(base + symbol);
    const bid = Number(body.bidPrice);
    const ask = Number(body.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
    return String((bid + ask) / 2);
  }

  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new SourceHttpError(res.status);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
