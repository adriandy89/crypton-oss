import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { NetworkService } from './network.service';
import { StreamService } from './stream.service';
import type {
  BotCommand,
  BotConfigRevision,
  BotCycle,
  BotDetail,
  BotEvent,
  BotFill,
  BotLevel,
  BotOrder,
  BotSnapshot,
  BotSummary,
  MarginAdjustment,
  MarketMakerStats,
  PreviewResult,
  StrategyDescriptor,
  StrategyKind,
  Venue,
} from '../models';

/** Respuesta de `PATCH /bots/:id/config`. */
export interface ConfigUpdateResult {
  applied: boolean;
  level: 'NONE' | 'HOT' | 'WARM' | 'COLD';
  version?: number;
  changed: { key: string; from: unknown; to: unknown; mutability: string; labelKey: string }[];
  message?: string;
}

@Injectable({ providedIn: 'root' })
export class BotsService {
  private readonly http = inject(HttpClient);
  private readonly network = inject(NetworkService);
  private readonly stream = inject(StreamService);
  private readonly base = `${environment.apiUrl}/bots`;

  readonly bots = signal<BotSummary[]>([]);
  readonly loading = signal(false);

  /**
   * Descriptores de estrategia, cacheados en memoria.
   *
   * De aquí salen TODOS los formularios de la app: etiquetas, rangos, valores
   * por defecto y la mutabilidad de cada campo. Anadir un parámetro a una
   * estrategia en el servidor lo hace aparecer aquí sin tocar la app.
   */
  private strategiesCache: StrategyDescriptor[] | null = null;

  constructor() {
    // Cambio de lente: la lista que hay en pantalla es de la OTRA red.
    //
    // Se vacia antes de pedir la nueva. Dejarla puesta mientras llega enseñaria
    // bots de mainnet debajo de la franja de testnet, que es justo la confusion
    // que la franja existe para evitar — y en una pantalla donde cada fila
    // lleva un PnL en dolares de verdad.
    let redAnterior: boolean | null = null;
    effect(() => {
      const testnet = this.network.testnet();
      // La primera pasada solo toma nota: las pantallas ya piden la lista al
      // abrirse, y sin esta guarda se pediria dos veces al arrancar.
      if (redAnterior === null) {
        redAnterior = testnet;
        return;
      }
      if (redAnterior === testnet) return;
      redAnterior = testnet;
      untracked(() => {
        this.bots.set([]);
        void this.refresh().catch(() => undefined);
      });
    });

    // Vuelta del flujo de eventos: lo que se perdio mientras no habia linea.
    //
    // Cartera y la lista de bots se refrescan con CADA evento del motor, asi
    // que mientras el flujo va bien no hace falta nada mas. El problema es el
    // corte: los eventos no se reemiten, y `StreamService` reconecta con espera
    // creciente hasta 30 s. En esa ventana un bot puede ejecutar, cerrar ciclo y
    // saltarle una guarda, y las dos pantallas se quedaban con las cifras de
    // antes sin mas aviso que el puntito de la pestaña.
    //
    // Va aqui y no en cada pagina a proposito: la señal `bots` es compartida, y
    // copiar este efecto en las dos pantallas costaria dos peticiones por
    // reconexion en lugar de una.
    //
    // Sin sondeo periodico: mientras el flujo esta en pie no hay nada que pedir,
    // y esto es un movil.
    // Solo tras una CAIDA, no en la primera conexion.
    //
    // Al arrancar, `connected()` va de false a true en cuanto el flujo engancha,
    // y las pantallas ya piden la lista en su `ngOnInit`: sin esta marca, cada
    // arranque de la app hacia dos `GET /bots` seguidos. Lo que hay que reponer
    // es lo que se perdio MIENTRAS no habia linea, asi que el disparador es
    // haber estado desconectado antes, no estar conectado ahora.
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
        void this.refresh().catch(() => undefined);
      });
    });
  }

  async loadStrategies(force = false): Promise<StrategyDescriptor[]> {
    if (this.strategiesCache && !force) return this.strategiesCache;
    this.strategiesCache = await firstValueFrom(
      this.http.get<StrategyDescriptor[]>(`${this.base}/strategies`),
    );
    return this.strategiesCache;
  }

  async strategy(kind: StrategyKind): Promise<StrategyDescriptor | undefined> {
    return (await this.loadStrategies()).find((s) => s.kind === kind);
  }

  /**
   * Los bots de la red que se esta mirando.
   *
   * El filtro va aqui y no en cada pantalla porque Bots y Cartera derivan las
   * dos de esta MISMA señal: Cartera suma PnL, posiciones y ordenes abiertas
   * sobre `bots()`. Filtrando en el origen, sus totales pasan a ser correctos
   * por red sin tocar esa pantalla — y sobre todo sin que puedan discrepar.
   */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      this.bots.set(
        await firstValueFrom(
          this.http.get<BotSummary[]>(this.base, {
            params: { testnet: String(this.network.testnet()) },
          }),
        ),
      );
    } finally {
      this.loading.set(false);
    }
  }

  detail(id: string): Promise<BotDetail> {
    return firstValueFrom(this.http.get<BotDetail>(`${this.base}/${id}`));
  }

  preview(input: {
    venue: Venue;
    symbol: string;
    strategy: StrategyKind;
    config: Record<string, unknown>;
    refPrice?: string;
    /**
     * Red de la CUENTA sobre la que se va a crear el bot.
     *
     * Se pasa desde fuera —antes la ponia este servicio desde la lente— porque
     * la conexion de SIMULACION es de mainnet y se ofrece igualmente con la
     * lente en testnet: dejarla a merced de la lente calculaba la escalera
     * contra la reticula del libro equivocado. La lente sigue siendo el valor
     * por defecto, que es lo correcto para el resto de cuentas.
     */
    testnet?: boolean;
  }): Promise<PreviewResult> {
    return firstValueFrom(
      this.http.post<PreviewResult>(`${this.base}/preview`, {
        ...input,
        testnet: input.testnet ?? this.network.testnet(),
      }),
    );
  }

  create(input: {
    name: string;
    exchangeAccountId: string;
    symbol: string;
    strategy: StrategyKind;
    config: Record<string, unknown>;
    startActive?: boolean;
    dryRun?: boolean;
  }): Promise<BotDetail> {
    return firstValueFrom(this.http.post<BotDetail>(this.base, input));
  }

  /**
   * Cambia la configuración en caliente.
   *
   * `acceptRelayout` es la confirmación explícita para los cambios WARM. Sin
   * ella la API responde 409 con el detalle de lo que cambiaría, que es
   * exactamente lo que la pantalla usa para preguntar antes de aplicar.
   */
  updateConfig(
    id: string,
    config: Record<string, unknown>,
    acceptRelayout = false,
  ): Promise<ConfigUpdateResult> {
    return firstValueFrom(
      this.http.patch<ConfigUpdateResult>(`${this.base}/${id}/config`, {
        config,
        acceptRelayout,
      }),
    );
  }

  command(id: string, command: BotCommand, confirm = false) {
    return firstValueFrom(
      this.http.post<{ accepted: boolean; command: BotCommand }>(`${this.base}/${id}/commands`, {
        command,
        confirm,
      }),
    );
  }

  /**
   * Aporta o retira colateral de la posición aislada.
   *
   * Método aparte de `command` y no un parámetro más: es el único comando con
   * argumentos, y colarlos en la firma genérica dejaría que cualquier otro
   * comando los mandara por descuido.
   *
   * `confirm` va siempre en las retiradas: la API las trata como destructivas
   * porque ACERCAN la liquidación.
   */
  adjustMargin(id: string, adjustment: MarginAdjustment) {
    return firstValueFrom(
      this.http.post<{ accepted: boolean; command: BotCommand }>(`${this.base}/${id}/commands`, {
        command: 'ADJUST_MARGIN',
        marginAmount: adjustment.amount,
        marginAction: adjustment.action,
        countAsBotCapital: adjustment.countAsBotCapital ?? false,
        confirm: adjustment.action === 'REMOVE',
      }),
    );
  }

  rename(id: string, name: string) {
    return firstValueFrom(this.http.patch(`${this.base}/${id}`, { name }));
  }

  remove(id: string) {
    return firstValueFrom(this.http.delete(`${this.base}/${id}`));
  }

  /**
   * La escalera DESEADA del bot, todos sus ciclos.
   *
   * El endpoint no filtra por ciclo ni por estado —el indice existe en la base
   * pero ninguna ruta lo explota—, asi que quien la consuma tiene que quedarse
   * con el ciclo vivo. Ver `buildBotOverlay`.
   */
  levels(id: string) {
    return firstValueFrom(this.http.get<BotLevel[]>(`${this.base}/${id}/levels`));
  }

  orders(id: string, limit = 100) {
    return firstValueFrom(
      this.http.get<BotOrder[]>(`${this.base}/${id}/orders`, { params: { limit } }),
    );
  }

  fills(id: string, limit = 100) {
    return firstValueFrom(
      this.http.get<BotFill[]>(`${this.base}/${id}/fills`, { params: { limit } }),
    );
  }

  /**
   * Ciclos cerrados, del mas reciente al mas antiguo. Es la «lista de
   * operaciones» del bot: acierto, duracion y resultado por ciclo salen de aqui.
   * Estuvo meses escrito y sin tipo (`unknown[]`) porque ninguna pantalla lo
   * llamaba (spec 002, F-10).
   */
  cycles(id: string, limit = 50) {
    return firstValueFrom(
      this.http.get<BotCycle[]>(`${this.base}/${id}/cycles`, { params: { limit } }),
    );
  }

  /** El historial de configuración, de la más nueva a la más vieja (spec 006). */
  revisions(id: string, limit = 50) {
    return firstValueFrom(
      this.http.get<BotConfigRevision[]>(`${this.base}/${id}/revisions`, { params: { limit } }),
    );
  }

  events(id: string, limit = 100) {
    return firstValueFrom(
      this.http.get<BotEvent[]>(`${this.base}/${id}/events`, { params: { limit } }),
    );
  }

  /**
   * La serie temporal del bot, de mas nueva a mas vieja.
   *
   * 500 es el tope del servidor y tambien todo lo que hay: la ruta no acepta
   * rango ni pagina hacia atras, y a una fila por minuto son 8 h 20 min. Pedir
   * menos no ahorra nada y recorta la ventana; quien la pinta la rotula por lo
   * que cubre de verdad (`ventanaDe` en `bot-series.ts`).
   */
  snapshots(id: string, limit = 500) {
    return firstValueFrom(
      this.http.get<BotSnapshot[]>(`${this.base}/${id}/snapshots`, { params: { limit } }),
    );
  }

  /**
   * La misma serie, pero un RANGO agregado en el servidor: hasta cuatro filas
   * por cubo —primera, minima, maxima y ultima— para que el peor momento
   * sobreviva al dibujo. Es lo que hace posibles las ventanas de 24 h, 7 d y
   * 30 d; sin rango, el endpoint solo llega a 8 h 20 min (spec 002).
   */
  snapshotsEnRango(id: string, fromMs: number, toMs: number, points = 480) {
    return firstValueFrom(
      this.http.get<BotSnapshot[]>(`${this.base}/${id}/snapshots`, {
        params: { fromMs, toMs, points },
      }),
    );
  }

  /**
   * Ficha de market making. Solo existe para las dos estrategias que cotizan a
   * los dos lados; para el resto la API devuelve ceros, asi que la pantalla
   * decide si la pide en vez de comprobar el resultado.
   */
  mmStats(id: string) {
    return firstValueFrom(this.http.get<MarketMakerStats>(`${this.base}/${id}/mm-stats`));
  }
}
