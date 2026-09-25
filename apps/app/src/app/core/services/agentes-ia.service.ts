import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subject, filter, firstValueFrom, throttleTime, type Observable } from 'rxjs';
import {
  esEventoAgente,
  type AgenteVista,
  type CrearAgenteEntrada,
  type DetalleAgente,
  type DetallePropuesta,
  type EditarAgenteEntrada,
  type InterruptoresAgentes,
  type ListaOperaciones,
  type ListaPropuestas,
  type ResultadoAccionAgente,
  type ResultadoDecisionAgente,
  type ResultadosAgentes,
  type ResumenAgentes,
  type RondaVista,
} from '@crypton/shared';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { StreamService } from './stream.service';

/** Ventana de agrupación de los eventos de los agentes: una ráfaga, una lectura. */
const AGRUPAR_EVENTOS_MS = 2_000;

/**
 * Los agentes de IA del administrador (spec 074), compartidos por la pestaña
 * IA, sus pantallas, la insignia de la barra y el panel del detalle de un bot.
 *
 * Es el patrón de `CanalIaService`: el resumen —interruptores, agentes y
 * cuántas propuestas esperan— vive aquí para que un cambio visto en una
 * pantalla se vea en las demás, y se refresca con la sesión, con los eventos
 * `AGENT_*` del flujo y a la vuelta de una caída. Lo demás se pide cuando una
 * pantalla lo necesita; `cambios` le avisa de que vuelva a pedirlo.
 *
 * Solo trabaja para un `ADMIN`: a cualquier otra cuenta no le pide nada. Las
 * rutas son de la consola y el servidor responde 403 igual; esto solo evita
 * pedir lo que se sabe que va a fallar.
 */
@Injectable({ providedIn: 'root' })
export class AgentesIaService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly stream = inject(StreamService);
  private readonly base = `${environment.apiUrl}/admin/ai-desk`;

  private readonly _resumen = signal<ResumenAgentes | null>(null);
  private readonly _prohibido = signal(false);
  private readonly _cambios = new Subject<void>();
  private secuencia = 0;

  /** `null` mientras no se sabe. */
  readonly resumen = this._resumen.asReadonly();
  /** El servidor no reconoce la sesión como administrador. */
  readonly prohibido = this._prohibido.asReadonly();
  readonly interruptores = computed<InterruptoresAgentes | null>(
    () => this._resumen()?.interruptores ?? null,
  );
  /** Propuestas esperando a una persona: la insignia de la pestaña. */
  readonly pendientes = computed(() => this._resumen()?.pendientes ?? 0);

  /** Algo de los agentes ha cambiado: las pantallas abiertas vuelven a pedir lo suyo. */
  readonly cambios = this._cambios.asObservable();

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
        this._resumen.set(null);
        this._prohibido.set(false);
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
        void this.avisar();
      });
    });

    // De por vida, como el servicio.
    this.stream.stream
      .pipe(
        filter((ev) => esEventoAgente(ev.type)),
        throttleTime(AGRUPAR_EVENTOS_MS, undefined, { leading: true, trailing: true }),
      )
      .subscribe(() => void this.avisar());
  }

  /** Avisa a las pantallas abiertas y refresca el resumen; resuelve cuando llega. */
  avisar(): Promise<void> {
    this._cambios.next();
    return this.refrescar();
  }

  /**
   * Vuelve a pedir el resumen. Nunca falla hacia fuera: sin resumen no hay
   * insignia, y una API anterior al spec 074 responde 404.
   */
  async refrescar(): Promise<void> {
    if (!this.clave()) return;
    const turno = ++this.secuencia;
    try {
      const resumen = await firstValueFrom(this.http.get<ResumenAgentes>(this.base));
      if (turno !== this.secuencia) return;
      this._resumen.set(resumen);
      this._prohibido.set(false);
    } catch (e) {
      if (turno !== this.secuencia) return;
      if ((e as { status?: number }).status === 403) this._prohibido.set(true);
    }
  }

  // ── El interruptor ───────────────────────────────────────────────────────

  /** Abre o corta las entradas de todos los agentes. El motivo va a la bitácora. */
  async fijarEntradas(abiertas: boolean, reason: string): Promise<InterruptoresAgentes> {
    const interruptores = await firstValueFrom(
      this.http.put<InterruptoresAgentes>(`${this.base}/entries`, { abiertas, reason }),
    );
    // Una lectura que estuviera en vuelo salió ANTES de este cambio.
    this.secuencia++;
    const r = this._resumen();
    if (r) this._resumen.set({ ...r, interruptores });
    void this.avisar();
    return interruptores;
  }

  // ── Los agentes ──────────────────────────────────────────────────────────

  detalle(id: string): Promise<DetalleAgente> {
    return firstValueFrom(this.http.get<DetalleAgente>(`${this.base}/agentes/${id}`));
  }

  crear(entrada: CrearAgenteEntrada): Promise<AgenteVista> {
    return this.tras(this.http.post<AgenteVista>(`${this.base}/agentes`, entrada));
  }

  editar(id: string, entrada: EditarAgenteEntrada): Promise<AgenteVista> {
    return this.tras(this.http.put<AgenteVista>(`${this.base}/agentes/${id}`, entrada));
  }

  pausar(id: string, reason: string): Promise<AgenteVista> {
    return this.tras(this.http.post<AgenteVista>(`${this.base}/agentes/${id}/pausar`, { reason }));
  }

  reanudar(id: string, reason: string, consentimiento?: boolean): Promise<AgenteVista> {
    return this.tras(
      this.http.post<AgenteVista>(`${this.base}/agentes/${id}/reanudar`, {
        reason,
        ...(consentimiento === undefined ? {} : { consentimiento }),
      }),
    );
  }

  archivar(id: string, reason: string): Promise<AgenteVista> {
    return this.tras(
      this.http.post<AgenteVista>(`${this.base}/agentes/${id}/archivar`, { reason }),
    );
  }

  /** Una ronda de entrada ahora; responde la ronda, también si una barrera la paró. */
  analizar(id: string): Promise<RondaVista> {
    return this.tras(this.http.post<RondaVista>(`${this.base}/agentes/${id}/analizar`, {}));
  }

  // ── Propuestas y operaciones ─────────────────────────────────────────────

  propuestas(agentId?: string): Promise<ListaPropuestas> {
    return firstValueFrom(
      this.http.get<ListaPropuestas>(`${this.base}/propuestas`, {
        params: agentId ? { agentId } : {},
      }),
    );
  }

  propuesta(id: string): Promise<DetallePropuesta> {
    return firstValueFrom(this.http.get<DetallePropuesta>(`${this.base}/propuestas/${id}`));
  }

  operaciones(agentId?: string): Promise<ListaOperaciones> {
    return firstValueFrom(
      this.http.get<ListaOperaciones>(`${this.base}/operaciones`, {
        params: agentId ? { agentId } : {},
      }),
    );
  }

  /** La operación de un bot `AGENT_TRADE` propio: el panel de su detalle. */
  operacionDeBot(botId: string): Promise<DetallePropuesta> {
    return firstValueFrom(this.http.get<DetallePropuesta>(`${this.base}/bots/${botId}/operacion`));
  }

  resultados(): Promise<ResultadosAgentes> {
    return firstValueFrom(this.http.get<ResultadosAgentes>(`${this.base}/resultados`));
  }

  aprobar(id: string): Promise<ResultadoDecisionAgente> {
    return this.tras(
      this.http.post<ResultadoDecisionAgente>(`${this.base}/propuestas/${id}/aprobar`, {}),
    );
  }

  rechazar(id: string): Promise<ResultadoDecisionAgente> {
    return this.tras(
      this.http.post<ResultadoDecisionAgente>(`${this.base}/propuestas/${id}/rechazar`, {}),
    );
  }

  /** Una ronda de seguimiento ahora sobre una operación. */
  revisar(id: string): Promise<RondaVista> {
    return this.tras(this.http.post<RondaVista>(`${this.base}/propuestas/${id}/revisar`, {}));
  }

  /** Cierra a mercado una operación, con el comando de siempre. */
  cerrar(id: string): Promise<ResultadoAccionAgente> {
    return this.tras(
      this.http.post<ResultadoAccionAgente>(`${this.base}/propuestas/${id}/cerrar`, {}),
    );
  }

  aplicarAccion(id: string): Promise<ResultadoAccionAgente> {
    return this.tras(
      this.http.post<ResultadoAccionAgente>(`${this.base}/acciones/${id}/aplicar`, {}),
    );
  }

  rechazarAccion(id: string): Promise<ResultadoAccionAgente> {
    return this.tras(
      this.http.post<ResultadoAccionAgente>(`${this.base}/acciones/${id}/rechazar`, {}),
    );
  }

  /** Lo que cambia algo: al volver, el resumen y las pantallas abiertas se ponen al día. */
  private async tras<T>(peticion: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(peticion);
    } finally {
      void this.avisar();
    }
  }
}
