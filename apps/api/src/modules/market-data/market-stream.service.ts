import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CANDLE_INTERVALS, type Candle, type CandleInterval } from '@crypton/shared';
import { Venue } from '@crypton/db';
import { BUS_CHANNELS, BusService } from 'src/libs';
import { BotsSseService } from '../bots';

/**
 * Precios y velas en vivo, empujados.
 *
 * Es la pieza que sustituye al sondeo. Antes la aplicación pedía
 * `GET /market-data/tickers` cada diez segundos y se traía los 935 pares —212
 * KB— para pintar los quince que caben en la pantalla; y como el cron que
 * refrescaba esa caché corría cada treinta segundos, dos de cada tres
 * respuestas llegaban idénticas byte a byte. Coste O(usuarios), frescura peor
 * caso de cuarenta segundos.
 *
 * Ahora el coste es O(símbolos DISTINTOS que alguien mira) y la frescura es la
 * del WebSocket del venue. La cadena entera ya existía salvo dos eslabones:
 *
 *   1. worker  · una suscripción por símbolo, con contador de referencias
 *   2. worker  · adaptador público, sin credenciales      ← ya estaba
 *   3. ————— · el worker DICE el precio en el bus         ← faltaba
 *   4. API    · reparto a N conexiones                    ← ya estaba
 *   5. API    · saber quién mira qué                      ← faltaba (esto)
 *   6. app    · canal abierto toda la sesión              ← ya estaba
 *
 * El sentido de cada flecha no es simétrico y no puede serlo: SSE es
 * unidireccional, así que los datos BAJAN por el flujo y el interés SUBE por
 * REST. Es el mismo modelo que ya usan los comandos de los bots.
 *
 * Se reparten DOS cosas y no una, porque son dos datos distintos: un tick dice
 * a cuánto se ha negociado; una vela dice además máximo, mínimo y VOLUMEN del
 * periodo. Lo segundo es lo que un tick no puede traer, y por eso el gráfico
 * seguía sondeando `GET /market-data/candles` cada cinco segundos aunque el
 * precio de su cabecera ya llegara en vivo — con la línea del gráfico hasta
 * veinte segundos por detrás de la cifra de arriba, en la misma pantalla.
 */
@Injectable()
export class MarketStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketStreamService.name);
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Lo último que se le pidió al worker, para no repetir el mismo mensaje. */
  private announced = '';

  constructor(
    private readonly bus: BusService,
    private readonly sse: BotsSseService,
  ) {}

  async onModuleInit(): Promise<void> {
    const ticks$ = await this.bus.listenPublic<TickPayload>(BUS_CHANNELS.MARKET_TICKS);
    ticks$.subscribe((message) => {
      // Dentro de un `try`, como el de las velas: lo que se lanza en el `next`
      // de un Observable no lo recoge nadie y acaba tumbando el proceso.
      try {
        const { venue, symbol, last, ts, testnet } = message.data;
        if (!venue || !symbol) return;
        // Solo a quien lo mira. Sin interés declarado no se manda nada: es lo
        // que impide que un usuario con la pantalla de bots abierta reciba los
        // 935 símbolos del catálogo por un canal que no ha pedido.
        this.sse.emitTopic(topicOf(venue, symbol, testnet === true), {
          type: 'TICK',
          data: { venue, symbol, last, ts, testnet: testnet === true },
        });
      } catch (e) {
        this.logger.warn(`Tick ilegible: ${(e as Error).message}`);
      }
    });

    const candles$ = await this.bus.listenPublic<CandlePayload>(BUS_CHANNELS.MARKET_CANDLES);
    candles$.subscribe((message) => {
      try {
        const { venue, symbol, interval, candle, testnet } = message.data;
        if (!venue || !symbol || !interval || !candle) return;
        this.sse.emitTopic(candleTopicOf(venue, symbol, interval, testnet === true), {
          type: 'CANDLE',
          data: {
            venue,
            symbol,
            interval,
            candle,
            testnet: testnet === true,
          },
        });
      } catch (e) {
        this.logger.warn(`Vela ilegible: ${(e as Error).message}`);
      }
    });

    // Se anuncia el interés cada pocos segundos, aunque no haya cambiado.
    //
    // Es un LATIDO, no una notificación de cambio, y la diferencia importa:
    // pub/sub no guarda nada, así que un worker que arranca después de la API
    // —o que se reinicia— no tiene forma de enterarse de lo que ya se estaba
    // mirando. Con el conjunto completo repetido, cualquier desajuste se
    // corrige solo en el siguiente latido en vez de dejar pantallas mudas.
    this.heartbeat = setInterval(() => void this.announce(), ANNOUNCE_EVERY_MS);
    this.logger.log('Precios y velas en vivo enganchados al bus publico');
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Registra qué mira una conexión y se lo cuenta al worker EN EL ACTO.
   *
   * Lo inmediato es lo que hace que abrir un gráfico enseñe precio en el mismo
   * segundo en vez de esperar al siguiente latido.
   *
   * Devuelve lo ACEPTADO de cada clase por separado. Que el cliente sepa si su
   * serie de velas entró importa más que en los precios: si no entró tiene que
   * componer la vela desde el precio, y creer que va a llegar sola dejaría el
   * gráfico congelado sin nada que lo explicara.
   */
  async watch(
    userId: string,
    streamId: string,
    symbols: string[],
    candles: string[] = [],
    testnet = false,
  ): Promise<{ symbols: string[]; candles: string[] }> {
    // Se filtra ANTES de guardar nada. Lo que entre aquí acaba publicado en el
    // bus y el worker lo convierte en una suscripción al WebSocket del venue:
    // es una entrada de usuario que llega hasta el DEX, así que se comprueba
    // en el borde y no se confía en que el DTO sea lo único que la mire.
    //
    // Las velas llevan su propio tope y MUY por debajo del de precios: un
    // gráfico mira una resolución de un par, y cada serie es una conexión al
    // venue —en Aster, un WebSocket entero—, mientras que sesenta precios
    // comparten los tickers que de todos modos ya están abiertos.
    const velas = candles
      .slice(0, MAX_CANDLE_TOPICS)
      .map((serie) => candleTopicFor(serie, testnet))
      .filter(isTopic);

    // Y van DELANTE, con los precios ocupando lo que quede del cupo.
    //
    // No es cosmético. El transporte recorta al total de temas por conexión, y
    // con las velas al final se caían justo en el caso NORMAL: la lista de
    // mercados vive dentro de las pestañas y sigue abierta debajo del gráfico,
    // así que sus sesenta pares llenan el cupo y el único tema de velas —el del
    // par que el usuario está mirando— quedaba fuera. El gráfico se abría
    // congelado y nada lo delataba.
    //
    // El orden dice qué se sacrifica: un precio que se cae fuera se sigue
    // viendo con la instantánea de la lista; una serie de velas que se cae
    // fuera deja el gráfico sin actualizar.
    const hueco = Math.max(0, MAX_TOPICS - velas.length);
    const precios = symbols
      .map((pair) => topicFor(pair, testnet))
      .filter(isTopic)
      .slice(0, hueco);

    const accepted = this.sse.setTopics(userId, streamId, [...velas, ...precios]);
    await this.announce();
    // Se devuelve el par pelado, sin prefijo: el cliente ya sabe en que red
    // pidio —la mando el— y anadirsela solo le daria algo que volver a quitar.
    return {
      symbols: accepted.filter((t) => t.startsWith(testnet ? PT : PX)).map(fromTopic),
      candles: accepted.filter((t) => t.startsWith(testnet ? KT : KL)).map(fromTopic),
    };
  }

  /**
   * Le dice al worker el conjunto ENTERO de lo que alguien mira.
   *
   * Entero y no las altas y las bajas: pub/sub puede perder un mensaje, y con
   * incrementos un mensaje perdido deja para siempre una suscripción al venue
   * que nadie mira —o una pantalla sin precios sin forma de recuperarse—. Con
   * el conjunto completo, el siguiente mensaje corrige cualquier deriva.
   */
  private async announce(): Promise<void> {
    const topics = this.sse.activeTopics().sort();
    const fingerprint = topics.join(',');
    // Se manda igual si no ha cambiado —es un latido— pero se registra solo
    // cuando cambia, para que el log sirva de algo.
    if (fingerprint !== this.announced) {
      this.announced = fingerprint;
      this.logger.debug(`${topics.length} temas mirados`);
    }
    // Cuatro listas y no una con la red dentro de cada entrada. Es lo que hace
    // que el cambio sea ADITIVO: `symbols` y `candles` siguen siendo byte a byte
    // lo que eran, asi que un worker todavia sin actualizar sigue sirviendo
    // mainnet sin enterarse de que existe testnet — el mismo criterio con el que
    // se anadio `candles` en su dia.
    await this.bus
      .publishPublic(BUS_CHANNELS.MARKET_WATCH, {
        type: 'WATCH',
        data: {
          symbols: topics.filter((t) => t.startsWith(PX)).map(fromTopic),
          candles: topics.filter((t) => t.startsWith(KL)).map(fromTopic),
          symbolsTest: topics.filter((t) => t.startsWith(PT)).map(fromTopic),
          candlesTest: topics.filter((t) => t.startsWith(KT)).map(fromTopic),
        },
      })
      .catch(() => undefined);
  }
}

interface TickPayload {
  venue?: Venue;
  symbol?: string;
  last?: string;
  ts?: number;
  /** Ausente = mainnet. Un worker sin actualizar no lo manda. */
  testnet?: boolean;
}

interface CandlePayload {
  venue?: Venue;
  symbol?: string;
  interval?: CandleInterval;
  candle?: Candle;
  /** Ausente = mainnet. Ver `TickPayload`. */
  testnet?: boolean;
}

/**
 * Cada cuánto se repite el conjunto de interés.
 *
 * Cinco segundos: el worker considera muerto el interés a los quince (tres
 * latidos), así que se pueden perder dos mensajes seguidos sin que nadie se
 * quede sin precios.
 */
const ANNOUNCE_EVERY_MS = 5_000;

/**
 * Tope de series de velas por conexión.
 *
 * Cuatro, frente a los sesenta de precios, y la diferencia no es cosmética: un
 * gráfico mira UNA resolución de UN par, y cada serie declarada acaba en una
 * conexión al venue. Cuatro cubre abrir el gráfico, cambiar de intervalo y que
 * el anterior tarde un instante en soltarse.
 */
const MAX_CANDLE_TOPICS = 4;

/**
 * Tope total de temas por conexión.
 *
 * Es el mismo que aplica el transporte. Se repite aquí porque el reparto entre
 * las dos clases se decide ANTES de llegar allí: el transporte solo sabe
 * recortar por el final, y aquí sí se sabe cuál de las dos hay que conservar.
 */
const MAX_TOPICS = 60;

/**
 * El prefijo del tema. Es lo que separa las dos clases de interés.
 *
 * Los dos miden tres caracteres a propósito: `fromTopic` corta por posición, y
 * un prefijo de otro largo devolvería el par con el prefijo pegado — un símbolo
 * que el venue no reconoce y una suscripción que no entrega nunca.
 */
const PX = 'px:';
const KL = 'kl:';
/**
 * Los mismos dos, en testnet. La red va en el PREFIJO y no como un segmento mas
 * del tema por dos motivos, y el segundo es el que decide:
 *
 * · `fromTopic` corta por posicion, asi que un prefijo de otro largo devolveria
 *   el par con el prefijo pegado. Estos miden tres, como los otros dos.
 * · Lo que queda despues del prefijo sigue siendo `VENUE:SIMBOLO` exacto, de
 *   modo que el formato que declara el cliente y el que entiende el worker no
 *   cambian ni un byte. La red viaja por fuera, en la bandera de la peticion y
 *   en las listas del bus.
 */
const PT = 'pt:';
const KT = 'kt:';

const topicOf = (venue: string, symbol: string, testnet = false): string =>
  `${testnet ? PT : PX}${venue}:${symbol}`;
const candleTopicOf = (venue: string, symbol: string, interval: string, testnet = false): string =>
  `${testnet ? KT : KL}${venue}:${symbol}:${interval}`;
const fromTopic = (topic: string): string => topic.slice(3);
const isTopic = (t: string | null): t is string => t !== null;

/**
 * Lo que NO puede llevar un símbolo.
 *
 * Al revés que antes, y por un motivo medido: la lista blanca era
 * `[A-Za-z0-9._-]` y Aster lista pares con nombre en chino —`龙虾USDT`,
 * `币安人生USDT`, `我踏马来了USDT`, `牛来USDT`—. Estaban en el catálogo, se veían
 * en la lista y se podían tocar, pero su gráfico respondía 400; y peor: como
 * `each` invalida el array ENTERO, uno solo de esos cuatro colándose entre los
 * sesenta pares que declara la lista dejaba la conexión sin declarar nada, o
 * sea sin un solo precio en vivo en toda la pantalla.
 *
 * Quien decide qué símbolos existen es el CATÁLOGO, no un patrón escrito aquí.
 * Lo único que este patrón tiene que impedir son los caracteres que romperían
 * la estructura por la que viaja el símbolo:
 *
 *   `:`  separa venue, símbolo e intervalo en los temas y en el bus
 *   `,`  separa los símbolos en la huella de interés del cliente
 *   `|`  separa precios de velas en esa misma huella
 *   espacios y caracteres de control
 *
 * El tope de 32 es el ancho de la columna `markets.symbol`.
 */
// eslint-disable-next-line no-control-regex -- el rango de control esta a proposito: es el saneado que rechaza caracteres de control en un simbolo
const SYMBOL_RE = /^[^\s,:|\u0000-\u001f]{1,32}$/;

/**
 * `HYPERLIQUID:BTC` → `px:HYPERLIQUID:BTC`, o null si no encaja.
 *
 * No se valida contra el catálogo de Postgres a propósito: serían 935 filas
 * por declaración de interés, varias veces por minuto y por usuario, para
 * proteger algo que el adaptador del venue ya rechaza. Lo que sí hace falta es
 * que de aquí no salga nada raro: el venue lo decide el enum, y el símbolo, una
 * forma acotada. Un par inventado que pase este filtro cuesta una suscripción
 * fallida en el worker y nada más.
 */
function topicFor(pair: string, testnet = false): string | null {
  const cut = pair.indexOf(':');
  if (cut <= 0) return null;
  const venue = pair.slice(0, cut);
  const symbol = pair.slice(cut + 1);
  if (!(venue in Venue) || !SYMBOL_RE.test(symbol)) return null;
  return topicOf(venue, symbol, testnet);
}

/**
 * `HYPERLIQUID:BTC:1h` → `kl:HYPERLIQUID:BTC:1h`, o null si no encaja.
 *
 * Se parte por el ÚLTIMO `:`: ningún símbolo de los tres venues lleva dos
 * puntos hoy, pero apoyarse en eso haría que el día que uno lo lleve esto
 * empiece a suscribir a un par que no existe, en silencio.
 *
 * El intervalo se valida contra la lista del sistema y no contra una forma
 * acotada: acaba dentro de la URL de una suscripción del venue.
 */
function candleTopicFor(serie: string, testnet = false): string | null {
  const cut = serie.lastIndexOf(':');
  if (cut <= 0) return null;
  const interval = serie.slice(cut + 1);
  if (!(CANDLE_INTERVALS as readonly string[]).includes(interval)) return null;

  const pair = serie.slice(0, cut);
  const at = pair.indexOf(':');
  if (at <= 0) return null;
  const venue = pair.slice(0, at);
  const symbol = pair.slice(at + 1);
  if (!(venue in Venue) || !SYMBOL_RE.test(symbol)) return null;
  return candleTopicOf(venue, symbol, interval, testnet);
}
