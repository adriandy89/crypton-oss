import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import type { BotStreamEvent } from '../models';

/** Un 401 del flujo: la sesion ha caducado y hay que renovarla, no reintentar. */
class StreamUnauthorized extends Error {}

/**
 * Flujo en tiempo real de los eventos de los bots.
 *
 * Se usa `fetch` con lectura incremental en lugar de `EventSource` por un
 * motivo práctico: EventSource no admite cabeceras, y la API va con Bearer
 * token. Meter el token en la URL lo dejaría escrito en los logs de cualquier
 * proxy intermedio.
 *
 * La reconexión es con retroceso exponencial y tope: en un móvil la conexión se
 * pierde constantemente (cambio de red, pantalla apagada) y reintentar sin
 * pausa vaciaría la batería sin conseguir nada.
 */
@Injectable({ providedIn: 'root' })
export class StreamService {
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly events$ = new Subject<BotStreamEvent>();
  private readonly ticks$ = new Subject<BotStreamEvent>();
  private readonly candles$ = new Subject<BotStreamEvent>();
  readonly connected = signal(false);

  /**
   * El identificador de ESTA conexion, que manda el servidor nada mas abrirla.
   *
   * Existe porque SSE es unidireccional: por este canal no se puede decir que
   * se esta mirando. Eso sube por REST —`POST /market-data/watch`— y necesita
   * nombrar la conexion, para que declarar interes desde el movil no borre el
   * del portatil.
   *
   * CAMBIA EN CADA RECONEXION, y es a proposito: el servidor no tiene forma de
   * saber que una conexion nueva continua a una vieja, y la vieja ya se ha
   * llevado su interes al cerrarse. Que sea una señal es lo que permite que
   * quien declare interes lo vuelva a declarar solo, sin acordarse de hacerlo.
   */
  readonly streamId = signal<string | null>(null);

  private controller: AbortController | null = null;
  private retryMs = 1000;
  private stopped = false;
  /**
   * ¿Ya se ha intentado renovar la sesion en esta racha de fallos?
   *
   * Sin esta marca, un 401 que se repite despues de renovar —el usuario ya no
   * existe, o el token nuevo tampoco vale— daria vueltas entre renovar y
   * reconectar sin pausa ninguna. Se levanta al renovar y se baja en cuanto una
   * conexion funciona.
   */
  private renovado = false;

  /**
   * Eventos DE BOTS. Fills, cambios de estado, avisos de riesgo.
   *
   * Los precios NO salen por aqui, y eso no es una separacion estetica: hay
   * pantallas suscritas a esto que llaman a `refresh()` con cualquier evento
   * que llegue —barato cuando el motor manda uno cada pocos segundos, y una
   * peticion cinco veces por segundo si les cayeran encima los ticks—. Con dos
   * canales, abrir la lista de mercados no puede afectar a lo que hace la
   * pantalla de bots.
   */
  readonly stream = this.events$.asObservable();

  /** Precios en vivo. Ver `MarketDataService`, que es quien los consume. */
  readonly ticks = this.ticks$.asObservable();

  /**
   * Velas en formacion, del par y la resolucion que se este mirando.
   *
   * Canal propio y no mezclado con los precios: llegan a otro ritmo, los
   * consume otra pantalla y la lista de mercados no tiene nada que hacer con
   * ellas. Un canal por clase de dato es lo que impide que abrir una pantalla
   * afecte al trabajo de otra.
   */
  readonly candles = this.candles$.asObservable();

  constructor() {
    this.destroyRef.onDestroy(() => this.disconnect());
  }

  connect(): void {
    if (this.controller) return;
    this.stopped = false;
    void this.loop();
  }

  disconnect(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    this.connected.set(false);
    this.streamId.set(null);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.readOnce();
        // Un cierre limpio del servidor: se reconecta enseguida.
        this.retryMs = 1000;
      } catch (e) {
        if (this.stopped) return;

        // Un 401 se RENUEVA, no se reintenta.
        //
        // Este canal va por `fetch` crudo —`EventSource` no admite cabeceras y
        // el token no puede ir en la URL— asi que no pasa por el interceptor
        // que renueva la sesion en el resto de peticiones. Sin esto, una
        // reconexion con el token ya caducado reintentaba con EL MISMO token
        // cada treinta segundos para siempre: el tiempo real se quedaba muerto
        // hasta que otra pantalla hiciera una peticion que disparara la
        // renovacion, y en una pantalla sin sondeo eso no pasaba nunca.
        if (e instanceof StreamUnauthorized && !this.renovado) {
          this.renovado = true;
          if (await this.auth.refresh()) {
            this.retryMs = 1000;
            continue;
          }
          // Si la renovacion falla, `AuthService` cierra la sesion y el efecto
          // de `app.component` llama a `disconnect()`: la vuelta del bucle se
          // encuentra `stopped` y sale.
        }

        await new Promise((r) => setTimeout(r, this.retryMs));
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
      } finally {
        this.connected.set(false);
        this.streamId.set(null);
      }
    }
  }

  private async readOnce(): Promise<void> {
    const token = this.auth.accessToken;
    if (!token) throw new Error('sin sesión');

    this.controller = new AbortController();
    const response = await fetch(`${environment.apiUrl}/bots/stream`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: this.controller.signal,
    });

    if (response.status === 401) throw new StreamUnauthorized();
    if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
    this.connected.set(true);
    this.retryMs = 1000;
    // Conexion buena: la racha de fallos se acaba aqui y la proxima vez se
    // vuelve a permitir renovar.
    this.renovado = false;
    // El identificador viejo se borra ANTES de leer nada. Si no, entre la
    // reconexion y el HELLO nuevo habria una ventana en la que alguien podria
    // declarar interes contra una conexion que ya no existe — y creerse
    // suscrito sin recibir un solo precio.
    this.streamId.set(null);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true });

      // Los eventos SSE se separan por línea en blanco. Se procesa lo completo
      // y el resto se queda en el buffer: un chunk puede cortar un evento por
      // la mitad y parsearlo entonces lo perdería.
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          const payload = JSON.parse(line.slice(5).trim()) as BotStreamEvent & {
            streamId?: string;
          };
          if (payload.type === 'PING') continue;
          if (payload.type === 'HELLO') {
            this.streamId.set(payload.streamId ?? null);
            continue;
          }
          if (payload.type === 'TICK') {
            this.ticks$.next(payload);
            continue;
          }
          if (payload.type === 'CANDLE') {
            this.candles$.next(payload);
            continue;
          }
          this.events$.next(payload);
        } catch {
          // Evento ilegible: se descarta sin cortar el flujo.
        }
      }
    }
  }
}
