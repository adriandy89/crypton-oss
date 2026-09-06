import { Observable, share, takeUntil } from 'rxjs';
import WebSocket from 'ws';
import { messageOf } from './errors';
import type { StreamHealth } from './types';

/**
 * Socket que se REENGANCHA solo.
 *
 * Vivía dentro de `AsterAdapter` y sale aquí porque Lighter necesita lo mismo:
 * un cierre limpio del servidor —lo normal tras un despliegue suyo— no produce
 * ningún evento, y sin reconexión el bot se queda sin fills en silencio hasta
 * que alguien lo reinicia. Duplicar noventa líneas de reconexión en dos
 * adaptadores es duplicar también el sitio donde se olvida un `clearTimeout`.
 *
 * Dos cosas que Aster no necesitaba y Lighter sí, y que son la razón de que
 * esto sea una clase y no una función:
 *
 * · `onOpen` — Lighter multiplexa TODOS sus canales en una sola conexión con
 *   mensajes `subscribe`. Al reconectar hay que volver a pedirlos: sin este
 *   gancho, el socket vuelve pero no llega un solo dato, que es la peor de las
 *   averías porque parece que funciona.
 * · `keepalive` — su documentación exige una trama cada 2 minutos. Sin ella el
 *   servidor corta, y el corte se vive como una reconexión perpetua.
 *
 * El canal de datos NUNCA recibe un error: los fallos salen por `onHealth`. Un
 * `error()` sobre el Observable lo cerraría para siempre y dejaría al bot sin
 * ticker el resto de la vida del adaptador.
 */
export interface SocketOptions {
  /**
   * La URL, resuelta en CADA (re)conexión y no una sola vez. Aster pide un
   * `listenKey` firmado que caduca: volver con uno muerto deja el socket
   * abierto sin recibir jamás un evento.
   */
  url: () => string | Promise<string>;
  onMessage: (raw: string) => void;
  /** Se ejecuta con el socket ya abierto. Aquí van las (re)suscripciones. */
  onOpen?: (socket: WebSocket) => void;
  onHealth?: (health: Pick<StreamHealth, 'status' | 'detail'>) => void;
  /** Trama periódica que exige el venue para no cortar. */
  keepalive?: { everyMs: number; payload: () => string };
}

export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly opts: SocketOptions) {
    this.open();
  }

  /** El socket vivo, o null mientras se reconecta. */
  get socket(): WebSocket | null {
    return this.ws;
  }

  /**
   * Cierra y corta la reconexión. Las dos cosas y en este orden: cancelar el
   * temporizador pendiente es tan necesario como cerrar el socket, porque un
   * reintento en vuelo volvería a abrir justo después de haber cerrado.
   */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.closeSocket();
  }

  /**
   * Cierra el socket actual para que la reconexión lo reabra evaluando de
   * nuevo la URL. Lo usa Aster cuando el venue avisa de que el `listenKey`
   * caducó: el socket sigue abierto pero ya no entrega nada (001/F-73). El
   * cierre dispara el manejador de `close`, que es quien programa la vuelta.
   */
  reconnect(motivo: string): void {
    if (this.stopped) return;
    this.health('DOWN', motivo);
    this.closeSocket();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private closeSocket(): void {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      /* ya cerrado */
    }
    this.ws = null;
  }

  private health(status: StreamHealth['status'], detail?: string): void {
    this.opts.onHealth?.({ status, detail });
  }

  private open(): void {
    if (this.stopped) return;

    void (async () => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(await this.opts.url());
      } catch (e) {
        this.scheduleReconnect(messageOf(e));
        return;
      }
      // La URL puede tardar —Aster pide un `listenKey` firmado— y el
      // interesado puede haberse ido mientras tanto. Sin esta guarda, el socket
      // recién abierto se queda vivo sin nadie que lo cierre.
      if (this.stopped) {
        try {
          socket.close();
        } catch {
          /* ya cerrado */
        }
        return;
      }
      this.ws = socket;
      let openedAt = 0;

      socket.on('open', () => {
        openedAt = Date.now();
        this.health('UP');
        // Los ganchos van BLINDADOS, y no es paranoia: una excepción lanzada
        // dentro de un manejador de eventos de `ws` no la recoge nadie y en
        // Node eso tumba el PROCESO entero — con él, todos los bots de este
        // worker. `onOpen` reenvía las suscripciones y puede toparse con un
        // socket que se cerró entre el evento y esta línea.
        this.guard(() => this.opts.onOpen?.(socket), 'onOpen');
        this.startKeepalive(socket);
      });

      socket.on('message', (raw: Buffer | string) =>
        this.guard(() => this.opts.onMessage(raw.toString()), 'onMessage'),
      );

      socket.on('error', (e) => {
        // Solo se anuncia: el canal de datos NO se cierra, para que la
        // reconexión pueda seguir entregando por él.
        this.health('DOWN', messageOf(e));
      });

      socket.on('close', () => {
        if (this.ws === socket) this.ws = null;
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
        if (this.stopped) return;
        // Una conexión que aguantó un rato reinicia el backoff: sin esto, cada
        // corte de una conexión estable de días pagaba el backoff acumulado de
        // toda la historia anterior.
        if (openedAt > 0 && Date.now() - openedAt > STABLE_MS) this.attempt = 0;
        this.scheduleReconnect('socket cerrado');
      });
    })();
  }

  /** Ejecuta un gancho sin dejar que su fallo salga del manejador de eventos. */
  private guard(fn: () => void, what: string): void {
    try {
      fn();
    } catch (e) {
      this.health('DOWN', `${what}: ${messageOf(e)}`);
    }
  }

  private startKeepalive(socket: WebSocket): void {
    const keepalive = this.opts.keepalive;
    if (!keepalive) return;
    // Se limpia el anterior antes de poner el nuevo: dos temporizadores vivos
    // sobre la misma conexión mandarían el doble de tramas y solo uno se
    // podría cancelar.
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (this.stopped || socket.readyState !== socket.OPEN) return;
      try {
        socket.send(keepalive.payload());
      } catch {
        // Un envío fallido no se propaga: el `close` que venga detrás ya
        // dispara la reconexión, y lanzar desde un temporizador tumbaría el
        // proceso entero.
      }
    }, keepalive.everyMs);
  }

  /**
   * Backoff exponencial con jitter. El jitter no es adorno: sin él, todos los
   * procesos que pierden la conexión a la vez vuelven a la vez y la tumban
   * otra vez.
   */
  private scheduleReconnect(detail: string): void {
    if (this.stopped) return;
    this.health('DOWN', detail);
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempt);
    this.attempt++;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.open();
      },
      backoff / 2 + Math.random() * (backoff / 2),
    );
  }
}

/** A partir de aquí una conexión se considera estable y el backoff se reinicia. */
const STABLE_MS = 60_000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * Un flujo compartido con CONTADOR de referencias.
 *
 * El primero que se suscribe abre el recurso del venue; el último que se va lo
 * cierra de verdad. Sin esto, un worker que hubiera servido cien pares a lo
 * largo del día mantendría cien suscripciones vivas contra el límite que los
 * venues cuentan por IP — y ese límite es más estrecho de lo que parece:
 * Hyperliquid corta a las DIEZ conexiones por IP.
 *
 * De los tres interruptores de `share`, el que hace el trabajo es
 * `resetOnRefCountZero`. Los otros dos van explícitos y en `false` para que el
 * final sea DEFINITIVO: lo único que termina estos flujos es cerrar el
 * adaptador, y después de eso no tiene sentido que un suscriptor nuevo vuelva a
 * abrir nada.
 */
export function sharedStream<T>(
  open: (emit: (value: T) => void) => { stop: () => void },
  closed$: Observable<unknown>,
): Observable<T> {
  return new Observable<T>((observer) => {
    const handle = open((value) => observer.next(value));
    return () => handle.stop();
  }).pipe(
    takeUntil(closed$),
    share({ resetOnRefCountZero: true, resetOnComplete: false, resetOnError: false }),
  );
}
