import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Observable, Subject, interval, map, merge, takeUntil } from 'rxjs';
import { BUS_CHANNELS, BusService } from 'src/libs';

/**
 * Tope de temas por conexion.
 *
 * Cada tema al que alguien se apunta puede acabar en una suscripcion al
 * WebSocket de un venue, y esos son un recurso contado —DIEZ conexiones por IP
 * en Hyperliquid— que se comparte con los bots que estan operando. Sin tope, un
 * cliente podria pedir los 935 simbolos del catalogo y agotarlo el solo. Sesenta
 * cubre de sobra una lista larga en la pantalla mas grande.
 */
const MAX_TOPICS = 60;

/**
 * Tope de conexiones SSE ABIERTAS por usuario.
 *
 * El limitador de caudal acota cuántas se abren por minuto, pero no cuántas
 * quedan abiertas a la vez: un cliente en bucle de reconexión —o uno hecho a
 * mano— podía acumularlas sin freno, y cada una es un `Subject`, un temporizador
 * de latido cada 15 s, dos entradas de mapa y un socket. Comprobado: cuarenta
 * conexiones del mismo usuario se aceptaban sin rechistar.
 *
 * Cinco es holgado para el uso real —móvil, portátil, y alguna pestaña de más
 * mientras la vieja termina de cerrarse— y convierte lo ilimitado en acotado.
 * Al pasarse se cierra la MÁS ANTIGUA y no se rechaza la nueva: quien acaba de
 * abrir la aplicación tiene que poder usarla, y la que sobra es la que lleva más
 * tiempo ahí, que casi siempre es una que el cliente ya dio por perdida.
 */
const MAX_CONNECTIONS_PER_USER = 5;

/**
 * Entrega en tiempo real hacia la app, sobre SSE.
 *
 * SSE y no WebSocket a propósito: es unidireccional (que es todo lo que hace
 * falta — los comandos van por REST), reconecta solo, atraviesa proxies sin
 * configuración especial y sobrevive mucho mejor a los cambios de red de un
 * móvil que un socket bidireccional.
 *
 * Los eventos NACEN en el worker; esta clase se limita a escuchar el bus de
 * Redis y repartir a las conexiones abiertas del usuario correspondiente.
 */
@Injectable()
export class BotsSseService implements OnModuleInit {
  private readonly logger = new Logger(BotsSseService.name);
  /** Un usuario puede tener varias pestañas o dispositivos abiertos. */
  private readonly subjects = new Map<string, Set<Subject<MessageEvent>>>();

  /**
   * Las conexiones por su identificador, para el reparto POR TEMA.
   *
   * El mapa de arriba reparte por USUARIO, que es lo que necesitan los eventos
   * de bots: son suyos y van a todos sus dispositivos. Los precios son otra
   * cosa —son públicos, y lo que decide a quién van no es de quién son sino
   * quién los está mirando ahora mismo—, así que se reparten por tema y el tema
   * lo declara cada conexión.
   *
   * Por CONEXIÓN y no por usuario: el mismo usuario con la lista abierta en el
   * móvil y un gráfico en el portátil mira cosas distintas, y con un solo
   * conjunto por usuario el último en declarar dejaría al otro sin precios.
   */
  private readonly connections = new Map<
    string,
    {
      userId: string;
      subject: Subject<MessageEvent>;
      topics: Set<string>;
      /**
       * El interruptor que TERMINA la respuesta.
       *
       * Completar el `Subject` de datos no basta y la diferencia importa: lo
       * que se devuelve es un `merge` de tres cosas —el saludo, los datos y el
       * latido— y un `merge` no termina hasta que terminan TODAS. El latido es
       * un `interval` que no termina nunca, así que la respuesta seguía abierta
       * mandando latidos a un cliente que ya no iba a recibir un solo evento:
       * una conexión con aspecto de viva y muerta por dentro.
       */
      close: Subject<void>;
    }
  >();

  /** Índice inverso tema → conexiones. Es lo que evita recorrerlas todas. */
  private readonly byTopic = new Map<string, Set<string>>();

  constructor(private readonly bus: BusService) {}

  async onModuleInit(): Promise<void> {
    const events$ = await this.bus.listen(BUS_CHANNELS.BOT_EVENTS);
    events$.subscribe((message) => {
      if (!message.userId) return;
      this.emit(message.userId, {
        type: message.type,
        botId: message.botId,
        data: message.data,
        ts: message.ts,
      });
    });
    this.logger.log('SSE enganchado al bus de eventos del worker');
  }

  /**
   * Abre un flujo para el usuario. Devuelve también el Subject para que el
   * manejador de cierre elimine EXACTAMENTE el suyo: si borrase por clave, una
   * reconexión rápida haría que la conexión vieja se llevara por delante la
   * nueva al cerrarse.
   */
  stream(userId: string): {
    obs: Observable<MessageEvent>;
    subject: Subject<MessageEvent>;
    streamId: string;
  } {
    this.evictOldest(userId);

    const subject = new Subject<MessageEvent>();
    const set = this.subjects.get(userId) ?? new Set();
    set.add(subject);
    this.subjects.set(userId, set);

    const streamId = randomUUID();
    const close = new Subject<void>();
    this.connections.set(streamId, {
      userId,
      subject,
      topics: new Set(),
      close,
    });

    // Latido cada 15 s: mantiene viva la conexión frente a proxies que cortan
    // por inactividad y permite a la app detectar que sigue conectada.
    const ping$ = interval(15_000).pipe(
      map(
        () =>
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'PING' }),
          }),
      ),
    );

    // Lo PRIMERO que sale por la conexión es su identificador.
    //
    // SSE es unidireccional: el cliente no puede decir por el mismo canal qué
    // está mirando. Eso sube por REST —el modelo que ya usa toda la casa— y
    // necesita nombrar SU conexión, para que declarar interés desde el móvil no
    // borre el del portátil.
    //
    // Lo genera el SERVIDOR y no el cliente a propósito: con un identificador
    // elegido por quien llama, cualquiera podría nombrar la conexión de otro y
    // vaciarle el interés. Los precios son públicos y no habría fuga de datos,
    // pero sí una forma barata de dejar a un tercero con la pantalla congelada.
    const hello$ = new Observable<MessageEvent>((observer) => {
      observer.next(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'HELLO', streamId }),
        }),
      );
      observer.complete();
    });

    return {
      obs: merge(hello$, subject.asObservable(), ping$).pipe(takeUntil(close)),
      subject,
      streamId,
    };
  }

  remove(userId: string, owned: Subject<MessageEvent>, streamId?: string): void {
    if (streamId) this.dropConnection(streamId);
    const set = this.subjects.get(userId);
    if (!set) return;
    if (set.delete(owned)) owned.complete();
    if (set.size === 0) this.subjects.delete(userId);
  }

  // ═══════════════════════════════════════════════════════════════
  // Reparto por tema
  // ═══════════════════════════════════════════════════════════════

  /**
   * Declara QUÉ mira una conexión. Sustituye la lista entera, no la amplía.
   *
   * Sustituir y no acumular es lo que hace que cerrar una pantalla suelte de
   * verdad lo que miraba: con altas y bajas incrementales, un mensaje perdido
   * —o una pantalla que se cierra mal— dejaría interés colgado para siempre, y
   * con él una suscripción al venue que ya no mira nadie.
   *
   * Devuelve los temas realmente aceptados, que pueden ser menos de los pedidos
   * si se pasa del tope: el cliente tiene que poder saber que se le recortó, en
   * vez de creer que mira algo que no mira.
   */
  setTopics(userId: string, streamId: string, topics: string[]): string[] {
    const conn = this.connections.get(streamId);
    // La conexión tiene que ser SUYA. Sin esta comprobación, conocer un
    // identificador ajeno bastaría para manipular lo que recibe otro.
    if (!conn || conn.userId !== userId) return [];

    const wanted = new Set(topics.slice(0, MAX_TOPICS));
    for (const topic of conn.topics) {
      if (!wanted.has(topic)) this.unindex(topic, streamId);
    }
    for (const topic of wanted) {
      if (!conn.topics.has(topic)) {
        const set = this.byTopic.get(topic) ?? new Set<string>();
        set.add(streamId);
        this.byTopic.set(topic, set);
      }
    }
    conn.topics = wanted;
    return [...wanted];
  }

  /** Manda un evento a las conexiones apuntadas a ese tema. Nadie más lo ve. */
  emitTopic(topic: string, payload: Record<string, unknown>): void {
    const ids = this.byTopic.get(topic);
    if (!ids?.size) return;
    const event = new MessageEvent('message', {
      data: JSON.stringify(payload),
    });
    for (const id of ids) this.connections.get(id)?.subject.next(event);
  }

  /** Todos los temas con al menos un interesado. Es lo que se pide al worker. */
  activeTopics(): string[] {
    return [...this.byTopic.keys()];
  }

  /**
   * Cierra las conexiones más antiguas del usuario hasta dejar sitio.
   *
   * `Map` conserva el orden de inserción, así que la primera que aparece es la
   * más vieja. Se COMPLETA el `Subject` además de olvidarla: eso termina el
   * flujo, Nest cierra la respuesta y el cliente ve un cierre limpio y
   * reconecta si todavía la quería.
   */
  private evictOldest(userId: string): void {
    const suyas = [...this.connections].filter(([, c]) => c.userId === userId);
    for (const [id, conn] of suyas.slice(0, suyas.length - MAX_CONNECTIONS_PER_USER + 1)) {
      this.logger.warn(`Demasiadas conexiones de ${userId}: se cierra la mas antigua`);
      this.dropConnection(id);
      const set = this.subjects.get(userId);
      set?.delete(conn.subject);
      if (set?.size === 0) this.subjects.delete(userId);
      // Y se TERMINA la respuesta, que es lo que hace que el cliente se entere y
      // reconecte si todavía la quería.
      conn.close.next();
      conn.close.complete();
      conn.subject.complete();
    }
  }

  private dropConnection(streamId: string): void {
    const conn = this.connections.get(streamId);
    if (!conn) return;
    for (const topic of conn.topics) this.unindex(topic, streamId);
    this.connections.delete(streamId);
  }

  private unindex(topic: string, streamId: string): void {
    const set = this.byTopic.get(topic);
    if (!set) return;
    set.delete(streamId);
    // El tema se BORRA al quedarse sin interesados. Es lo que hace que
    // `activeTopics()` sea la verdad y que el worker acabe soltando la
    // suscripción al venue; dejando el conjunto vacío, el símbolo seguiría
    // apareciendo como mirado para siempre.
    if (set.size === 0) this.byTopic.delete(topic);
  }

  emit(userId: string, payload: Record<string, unknown>): void {
    const set = this.subjects.get(userId);
    if (!set?.size) return;
    const event = new MessageEvent('message', {
      data: JSON.stringify(payload),
    });
    for (const subject of set) subject.next(event);
  }

  /** Número de conexiones abiertas; útil para métricas y depuración. */
  connectionCount(): number {
    let total = 0;
    for (const set of this.subjects.values()) total += set.size;
    return total;
  }
}
