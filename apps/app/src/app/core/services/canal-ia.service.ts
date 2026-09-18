import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { filter, firstValueFrom, throttleTime } from 'rxjs';
import type {
  BotCanalResumen,
  DecisionCanalDetalle,
  DecisionCanalVista,
  EstadoCanalBot,
  InterruptoresCanal,
  ResumenCanalAdmin,
} from '@crypton/shared';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { esEventoCanal, pastillaCanal, type PastillaCanal } from '../utils/canal-ia';
import { StreamService } from './stream.service';

/** Ventana de agrupación de los eventos del canal: una ráfaga, una lectura. */
const AGRUPAR_EVENTOS_MS = 2_000;

/**
 * El canal con IA de los bots del administrador (spec 059), compartido por
 * todas las pantallas: la pastilla de las dos listas, el panel del detalle, la
 * ficha de la consola y el interruptor global del índice de administración.
 *
 * Es el mismo patrón que `ModoIaService`, y por lo mismo: un cambio visto en una
 * pantalla tiene que verse en las demás sin que cada una avise a las otras.
 *
 * Solo trabaja para un `ADMIN`: a cualquier otra cuenta no le pide nada y no le
 * pinta nada. Las rutas son de administración y el servidor responde 403 igual;
 * esto solo evita pedir lo que se sabe que va a fallar.
 *
 * Lo mantienen al día la sesión, los eventos del canal en el flujo y la vuelta
 * del flujo tras una caída. Con un número de secuencia: una lectura que sale
 * antes de un cambio y llega después no lo deshace.
 */
@Injectable({ providedIn: 'root' })
export class CanalIaService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly stream = inject(StreamService);
  private readonly base = `${environment.apiUrl}/admin`;

  /** Inmutable a propósito: las señales comparan por identidad. */
  private readonly porBot = signal<ReadonlyMap<string, BotCanalResumen>>(new Map());
  private readonly _interruptores = signal<InterruptoresCanal | null>(null);
  private secuencia = 0;

  /** `null` mientras no se sabe: no se afirma nada sobre el servidor. */
  readonly interruptores = this._interruptores.asReadonly();

  readonly esAdmin = computed(() => this.auth.user()?.role === 'ADMIN');

  /** Si el administrador tiene algún bot del canal. */
  readonly hayBots = computed(() => this.porBot().size > 0);

  /** Los eventos del canal de cualquier bot. El panel se queda con los del suyo. */
  readonly eventos = this.stream.stream.pipe(filter((ev) => esEventoCanal(ev.type)));

  /** La sesión que importa: el id de un administrador, o nada. Ver `ModoIaService`. */
  private readonly clave = computed(() => {
    const user = this.auth.user();
    return user?.role === 'ADMIN' ? user.id : null;
  });

  constructor() {
    effect(() => {
      const clave = this.clave();
      untracked(() => {
        this.secuencia++;
        this.porBot.set(new Map());
        this._interruptores.set(null);
        if (clave) void this.refrescar();
      });
    });

    // Solo tras una CAÍDA del flujo: al arrancar, la sesión ya lo pide.
    let hubieraCaida = false;
    effect(() => {
      const conectado = this.stream.connected();
      untracked(() => {
        if (!conectado) {
          hubieraCaida = true;
          return;
        }
        if (!hubieraCaida) return;
        hubieraCaida = false;
        void this.refrescar();
      });
    });

    // De por vida, como el servicio.
    this.eventos
      .pipe(throttleTime(AGRUPAR_EVENTOS_MS, undefined, { leading: true, trailing: true }))
      .subscribe(() => void this.refrescar());
  }

  /**
   * Vuelve a pedir el resumen. Nunca falla hacia fuera: sin resumen no hay
   * pastillas, y una API anterior al spec 059 responde 404.
   */
  async refrescar(): Promise<void> {
    if (!this.clave()) return;
    const turno = ++this.secuencia;
    try {
      const resumen = await firstValueFrom(
        this.http.get<ResumenCanalAdmin>(`${this.base}/ai-channel`),
      );
      if (turno !== this.secuencia) return;
      this.porBot.set(new Map(resumen.bots.map((b) => [b.id, b])));
      this._interruptores.set(resumen.interruptores);
    } catch {
      // Ver arriba.
    }
  }

  /** La pastilla de un bot del canal, solo para un administrador y si se conoce. */
  pastilla(botId: string, bot: { status: string; strategy: string }): PastillaCanal | null {
    if (!this.esAdmin() || bot.strategy !== 'AI_CHANNEL') return null;
    const fila = this.porBot().get(botId);
    const interruptores = this._interruptores();
    if (!fila || !interruptores) return null;
    return pastillaCanal(interruptores, fila.lazo, bot, Date.now(), fila.propio);
  }

  /** Lo que enseña el panel de un bot PROPIO: lazo, día y últimas decisiones. */
  estado(botId: string): Promise<EstadoCanalBot> {
    return firstValueFrom(this.http.get<EstadoCanalBot>(`${this.base}/bots/${botId}/ai-channel`));
  }

  /** Decisiones anteriores a `antes` (ISO), de la más reciente hacia atrás. */
  decisiones(botId: string, antes?: string, limite = 20): Promise<DecisionCanalVista[]> {
    const params: Record<string, string> = { limite: String(limite) };
    if (antes) params['antes'] = antes;
    return firstValueFrom(
      this.http.get<DecisionCanalVista[]>(`${this.base}/bots/${botId}/ai-channel/decisiones`, {
        params,
      }),
    );
  }

  /** Una decisión con la herramienta que vio el modelo. */
  detalle(botId: string, intentId: string): Promise<DecisionCanalDetalle> {
    return firstValueFrom(
      this.http.get<DecisionCanalDetalle>(
        `${this.base}/bots/${botId}/ai-channel/decisiones/${encodeURIComponent(intentId)}`,
      ),
    );
  }

  /**
   * Abre o corta las entradas de TODOS los bots del canal. El motivo es
   * obligatorio y va a la bitácora; el servidor responde con los interruptores
   * ya leídos de vuelta, que es lo que se pinta.
   */
  async fijarEntradas(abiertas: boolean, reason: string): Promise<InterruptoresCanal> {
    const interruptores = await firstValueFrom(
      this.http.put<InterruptoresCanal>(`${this.base}/ai-channel/entries`, { abiertas, reason }),
    );
    // Una lectura que estuviera en vuelo salió ANTES de este cambio.
    this.secuencia++;
    this._interruptores.set(interruptores);
    return interruptores;
  }
}
