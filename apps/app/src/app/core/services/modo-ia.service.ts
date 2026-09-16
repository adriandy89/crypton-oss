import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { filter, throttleTime } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { conCanalEfectivo, insigniaIa, type BotParaIa, type InsigniaIa } from '../utils/modo-ia';
import { AdminBotsService, type AiSetting, type AiSwitches } from './admin-bots.service';
import { StreamService } from './stream.service';
import { TelegramService } from './telegram.service';

/** Ventana de agrupación de los eventos `AI_*`: rafagas de revisiones, una lectura. */
const AGRUPAR_EVENTOS_IA_MS = 2_000;

/**
 * El Modo IA de los bots del administrador, compartido por todas las pantallas
 * (spec 053).
 *
 * Es lo que pinta la pastilla en la lista de bots, en el detalle y en la
 * consola. Vive aqui, y no en cada pantalla, por lo mismo que `BotsService.bots`:
 * un cambio hecho en el detalle tiene que verse en la lista al volver, sin
 * recargar y sin que cada pantalla tenga que acordarse de avisar a las demas.
 *
 * Solo trabaja para un `ADMIN`. Para cualquier otra cuenta no pide nada y no
 * pinta nada: el Modo IA no existe para ella.
 *
 * Tres cosas lo mantienen al dia, y ninguna es un sondeo:
 *   - la sesion: al entrar un administrador se carga, y al salir o cambiar de
 *     cuenta se vacia;
 *   - los eventos `AI_*` del flujo, que publica el supervisor al actuar y la API
 *     al cambiar el modo;
 *   - la vuelta del flujo tras una caida, por lo que se perdiera sin linea.
 *
 * Y un NUMERO DE SECUENCIA: una lectura que sale antes de un cambio y llega
 * despues traeria el modo viejo y lo volveria a pintar. Cada cambio de sesion y
 * cada `anotar()` invalidan las lecturas que estuvieran en vuelo.
 */
@Injectable({ providedIn: 'root' })
export class ModoIaService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AdminBotsService);
  private readonly stream = inject(StreamService);
  private readonly telegram = inject(TelegramService);

  /** Inmutable a proposito: las señales comparan por identidad. */
  private readonly porBot = signal<ReadonlyMap<string, AiSetting>>(new Map());
  private readonly _interruptores = signal<AiSwitches | null>(null);
  private readonly estrategias = signal<readonly string[] | null>(null);
  private secuencia = 0;

  /** `null` mientras no se sabe: no se afirma nada sobre el servidor. */
  readonly interruptores = this._interruptores.asReadonly();

  readonly esAdmin = computed(() => this.auth.user()?.role === 'ADMIN');

  /** Si algún bot propio tiene el Modo IA encendido. */
  readonly hayEncendidos = computed(() => this.porBot().size > 0);

  /**
   * La sesion que importa: el id de un administrador, o nada.
   *
   * Una cadena y no el objeto: `patchUser` y la renovacion de la sesion
   * sustituyen el usuario por otro igual, y con el objeto como clave cada una
   * volveria a pedir el resumen.
   */
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
        this.estrategias.set(null);
        if (clave) void this.refrescar();
      });
    });

    // Vuelta del flujo: lo que paso mientras no habia linea. Solo tras una
    // CAIDA, igual que `BotsService`: al arrancar ya pide la sesion.
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

    // Suscripcion de por vida, como el propio servicio: los dos viven lo que la
    // sesion de la app.
    this.stream.stream
      .pipe(
        filter((ev) => ev.type.startsWith('AI_')),
        throttleTime(AGRUPAR_EVENTOS_IA_MS, undefined, { leading: true, trailing: true }),
      )
      .subscribe(() => void this.refrescar());
  }

  /**
   * Vuelve a pedir el resumen. Nunca falla hacia fuera.
   *
   * En silencio a proposito: contra una API anterior al spec 053 la ruta no
   * existe (404), y a un administrador al que le acaban de quitar el rol se le
   * responde 403. En los dos casos lo correcto es no pintar pastillas, no
   * enseñar un error sobre algo secundario en la pantalla de aterrizaje.
   */
  async refrescar(): Promise<void> {
    if (!this.clave()) return;
    const turno = ++this.secuencia;
    // El Telegram de quien mira, a la vez: es el primer dato del canal
    // (`canalEfectivo`), y leido una sola vez por sesion se quedaba mas viejo
    // que el del servidor (spec 056, A-4).
    void this.telegram.refresh().catch(() => undefined);
    try {
      const resumen = await this.api.aiOverview();
      if (turno !== this.secuencia) return;
      this.porBot.set(new Map(resumen.bots.map((b) => [b.bot_id, b])));
      this._interruptores.set(resumen.interruptores);
      this.estrategias.set(resumen.estrategias);
    } catch {
      // Ver arriba: sin resumen no hay pastillas, y no hay nada mas que hacer.
    }
  }

  /**
   * Un cambio que ya confirmó el servidor, para que todas las pantallas lo vean
   * sin volver a preguntar.
   */
  anotar(ajuste: AiSetting): void {
    // Una lectura que estuviera en vuelo salio ANTES de este cambio.
    this.secuencia++;
    const mapa = new Map(this.porBot());
    if (ajuste.mode === 'OFF') mapa.delete(ajuste.bot_id);
    else mapa.set(ajuste.bot_id, ajuste);
    this.porBot.set(mapa);
    if (ajuste.interruptores) this._interruptores.set(ajuste.interruptores);
  }

  /** El Modo IA de un bot, si esta encendido y se conoce. */
  de(botId: string): AiSetting | null {
    return this.porBot().get(botId) ?? null;
  }

  /**
   * Si el Modo IA cubre una estrategia. `null` = no se sabe todavía: la pantalla
   * ofrece el control y decide el servidor.
   */
  cubre(kind: string | null | undefined): boolean | null {
    const lista = this.estrategias();
    if (!lista || !kind) return null;
    return lista.includes(kind);
  }

  /**
   * Unos interruptores con el canal de quien mira ya resuelto: el de su Telegram
   * si se conoce, que cambia en el acto al vincular o al apagar los avisos, y si
   * no, el que dijo el servidor (spec 056, A-4).
   */
  conCanal(interruptores: AiSwitches | null | undefined): AiSwitches | null {
    return conCanalEfectivo(interruptores, this.telegram.status());
  }

  /** La pastilla de un bot, solo para un administrador. */
  insignia(botId: string, bot: BotParaIa): InsigniaIa | null {
    if (!this.esAdmin()) return null;
    return insigniaIa(this.de(botId), this.conCanal(this._interruptores()), bot);
  }
}
