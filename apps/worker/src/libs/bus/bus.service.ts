import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';
import { Subject, filter, map, type Observable } from 'rxjs';

/**
 * Bus de eventos entre procesos, sobre pub/sub de Redis.
 *
 * Existe porque el motor y la API viven en procesos separados: los fills, los
 * cambios de estado y los eventos de riesgo NACEN en el worker, pero quien los
 * tiene que entregar al móvil es la API. Sin este bus, la API tendría que
 * sondear la base de datos y el usuario vería los fills con segundos de
 * retraso.
 *
 * Se usa pub/sub y no una cola porque estos mensajes son efímeros: si nadie
 * está mirando, no hay nada que guardar — el estado auténtico ya está en
 * `bot_events` y `bot_orders`.
 */

export interface BusMessage<T = Record<string, unknown>> {
  channel: string;
  /**
   * Destinatario. Obligatorio: es lo único que decide a quién se entrega el
   * mensaje, y tanto el SSE de la API como el notificador de Telegram
   * descartan en silencio los que no lo traen. Siendo opcional, `adoptPending`
   * publicaba el fallo de arranque con la cadena vacía y el aviso no llegaba a
   * nadie. Ahora lo exige el compilador.
   */
  userId: string;
  botId?: string;
  type: string;
  data: T;
  ts: number;
  /**
   * Proceso que publicó el mensaje.
   *
   * Pub/sub entrega a TODOS los suscritos, así que con varios workers cada
   * evento llegaba a todos y todos mandaban su aviso de Telegram: N mensajes
   * idénticos por evento. Con el origen, el que notifica es el que publicó —que
   * es por definición uno solo—, sin necesidad de otro cerrojo.
   */
  origin?: string;
}

/**
 * Mensaje SIN destinatario, para lo que es publico.
 *
 * Es un tipo aparte y no un `BusMessage` con el `userId` relajado. El
 * comentario de `BusMessage.userId` cuenta por que se endurecio: siendo
 * opcional, un publicador mando la cadena vacia y el aviso se perdio sin que
 * nada fallara. Un precio de mercado no es de nadie —es el mismo dato para
 * todos los usuarios y para nadie en particular—, asi que en vez de aflojar la
 * garantia del canal privado se le da forma propia al publico. Los dos viajan
 * por conexiones de Redis distintas y por sujetos distintos: no pueden
 * mezclarse ni por descuido.
 */
export interface PublicBusMessage<T = Record<string, unknown>> {
  channel: string;
  type: string;
  data: T;
  ts: number;
  /** Proceso que lo publico. Mismo uso que en `BusMessage`. */
  origin?: string;
}

export const BUS_CHANNELS = {
  /** Novedades de un bot: estado, órdenes, fills, eventos. */
  BOT_EVENTS: 'crypton:bot-events',
  /** Cambios de configuración que el worker debe recargar. */
  BOT_CONFIG: 'crypton:bot-config',
  /** Órdenes de runtime de la API hacia el worker (pausar, parar, pánico). */
  BOT_COMMANDS: 'crypton:bot-commands',
  /**
   * PUBLICO: precios de mercado del worker hacia la API.
   *
   * Es el eslabon que faltaba para que los precios lleguen empujados en vez de
   * sondeados. El worker ya tenia UNA suscripcion por simbolo con contador de
   * referencias y ya dejaba el ultimo precio en Redis; lo unico que no hacia
   * era decirlo en voz alta.
   */
  MARKET_TICKS: 'crypton:market-ticks',
  /**
   * PUBLICO: velas en formacion del worker hacia la API.
   *
   * Aparte de los precios porque son otra cosa: un tick dice a cuanto se ha
   * negociado; una vela dice ademas maximo, minimo y VOLUMEN del periodo, que
   * es justo lo que un tick no puede traer y lo que obligaba al grafico a
   * seguir sondeando. Solo lo sirven los venues cuya capacidad declara
   * `candles.live`.
   */
  MARKET_CANDLES: 'crypton:market-candles',
  /**
   * PUBLICO: que simbolos mira alguien ahora mismo, de la API hacia el worker.
   *
   * Va el conjunto ENTERO cada vez, no altas y bajas. Pub/sub no garantiza
   * entrega: con incrementos, un mensaje perdido deja una suscripcion al venue
   * abierta para siempre o una pantalla sin precios sin forma de recuperarse.
   * Con el conjunto completo, el siguiente mensaje corrige cualquier deriva.
   */
  MARKET_WATCH: 'crypton:market-watch',
} as const;

@Injectable()
export class BusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BusService.name);
  private publisher!: RedisClientType;
  private subscriber!: RedisClientType;
  private readonly messages$ = new Subject<BusMessage>();
  private readonly subscribed = new Set<string>();
  /** Lo publico va por su propio sujeto: ver `listenPublic`. */
  private readonly publicMessages$ = new Subject<PublicBusMessage>();
  private readonly subscribedPublic = new Set<string>();

  /** Identidad de ESTE proceso como publicador. */
  readonly originId = `bus-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const password = this.config.get<string>('REDIS_PASSWORD');

    this.publisher = createClient({ url, password }) as RedisClientType;
    // Una conexión en modo suscripción no admite otros comandos, de ahí que
    // publicar y escuchar necesiten clientes distintos.
    this.subscriber = this.publisher.duplicate() as RedisClientType;

    this.publisher.on('error', (e) => this.logger.error('Publisher Redis: ' + e.message));
    this.subscriber.on('error', (e) => this.logger.error('Subscriber Redis: ' + e.message));

    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    this.logger.log('Bus de eventos conectado');
  }

  async onModuleDestroy(): Promise<void> {
    this.messages$.complete();
    this.publicMessages$.complete();
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
  }

  async publish<T>(channel: string, message: Omit<BusMessage<T>, 'channel' | 'ts'>): Promise<void> {
    const payload: BusMessage<T> = { ...message, channel, ts: Date.now(), origin: this.originId };
    await this.publisher.publish(channel, JSON.stringify(payload));
  }

  /**
   * Publica en un canal PUBLICO, sin destinatario.
   *
   * Deliberadamente separado de `publish`: el compilador impide mandar un
   * mensaje de bot por aqui —le falta `userId`— y mandar un precio por el canal
   * privado —le sobra—.
   */
  async publishPublic<T>(
    channel: string,
    message: Omit<PublicBusMessage<T>, 'channel' | 'ts'>,
  ): Promise<void> {
    const payload: PublicBusMessage<T> = {
      ...message,
      channel,
      ts: Date.now(),
      origin: this.originId,
    };
    await this.publisher.publish(channel, JSON.stringify(payload));
  }

  /**
   * Escribe una clave con caducidad sobre la conexión de publicación.
   *
   * Es la misma conexión y no una nueva a propósito: solo la del SUSCRIPTOR
   * queda inutilizada para otros comandos, la del publicador es un cliente
   * normal. Lo usa el feed de precios para dejar el último precio de cada
   * símbolo al alcance de la API y de los demás workers.
   */
  async cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.publisher.set(key, JSON.stringify(value), { EX: ttlSeconds });
  }

  /**
   * Ejecuta un script Lua sobre la conexión de publicación.
   *
   * Lo usa el presupuesto de caudal, que necesita leer, calcular y escribir el
   * depósito de fichas de forma ATÓMICA: con un GET, una cuenta y un SET desde
   * el cliente, dos workers que consultaran a la vez verían el mismo saldo y
   * ambos se lo gastarían.
   */
  evalScript(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    return this.publisher.eval(script, options);
  }

  /** Lee una clave escrita con `cacheSet`. null si no está o no es legible. */
  async cacheGet<T>(key: string): Promise<T | null> {
    const raw = await this.publisher.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Se suscribe a un canal (idempotente) y devuelve sus mensajes. */
  async listen<T = Record<string, unknown>>(channel: string): Promise<Observable<BusMessage<T>>> {
    if (!this.subscribed.has(channel)) {
      this.subscribed.add(channel);
      await this.subscriber.subscribe(channel, (raw) => {
        try {
          this.messages$.next(JSON.parse(raw) as BusMessage);
        } catch {
          // Un mensaje corrupto no debe romper el flujo del resto.
          this.logger.warn(`Mensaje ilegible en ${channel}`);
        }
      });
    }
    return this.messages$.pipe(
      filter((m) => m.channel === channel),
      map((m) => m as BusMessage<T>),
    );
  }

  /**
   * Escucha un canal PUBLICO. Sujeto propio, separado del privado.
   *
   * Compartir el sujeto obligaria a que los mensajes publicos —que no tienen
   * `userId`— viajaran tipados como si lo tuvieran. Eso es exactamente la
   * mentira silenciosa que el tipo obligatorio de `BusMessage.userId` existe
   * para impedir.
   */
  async listenPublic<T = Record<string, unknown>>(
    channel: string,
  ): Promise<Observable<PublicBusMessage<T>>> {
    if (!this.subscribedPublic.has(channel)) {
      this.subscribedPublic.add(channel);
      await this.subscriber.subscribe(channel, (raw) => {
        try {
          this.publicMessages$.next(JSON.parse(raw) as PublicBusMessage);
        } catch {
          this.logger.warn(`Mensaje publico ilegible en ${channel}`);
        }
      });
    }
    return this.publicMessages$.pipe(
      filter((m) => m.channel === channel),
      map((m) => m as PublicBusMessage<T>),
    );
  }
}
