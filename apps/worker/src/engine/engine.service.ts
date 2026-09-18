import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BotConfig, CycleState, MarketSpec, StrategyKind, Venue } from '@crypton/shared';
import {
  AuditOutcome,
  CLAVE_INTERRUPTOR_CANAL,
  EventSeverity,
  esEstrategiaSoloAdmin,
  interruptorCerrado,
} from '@crypton/shared';
import { getStrategy } from '@crypton/strategy-core';
import { AuditService, BUS_CHANNELS, BusService, DbService } from '../libs';
import { BotRunner, type EstadoInterruptor, type RunnerCommand } from './bot-runner';
import { AccountHub } from './account-hub.service';
import { AiIntentStore } from './ai-intents.store';
import { BotStore } from './bot-store';
import { CommandInbox } from './command-inbox.service';
import { LeaseService } from './lease.service';
import { evaluarSalud, runnersAtascados } from './health';
import { MarketDataService, PriceSourceService } from '../marketdata';

/**
 * Estados en los que un bot debe tener un runner vivo.
 *
 * `PAUSED` está aquí a propósito. Un bot pausado conserva su posición abierta, y
 * pausar es justo lo que hace el usuario cuando algo va mal: dejarlo sin runner
 * sería quedarse sin el aviso de liquidación precisamente cuando importa, y
 * además un RESUME no tendría a quién llegar. Lo que un bot pausado no hace es
 * planificar ni colocar nada.
 */
const ADOPTABLE = ['STARTING', 'RUNNING', 'PAUSED'] as const;

/** Estados en los que un bot vivo bloquea el par para su cuenta de exchange. */
const LIVE = ['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'] as const;

/** Cuántos bots se arrancan a la vez. Más no acelera: la red es el cuello. */
const SPAWN_CONCURRENCY = 8;

/**
 * Lo que dura en memoria el rol del dueño de un bot del canal. Se relee para
 * cerrar las entradas de un dueño degradado (spec 062, F-06) y no hace falta
 * pagar una consulta por tick: un minuto es lo que tarda en enterarse.
 */
const ROL_TTL_MS = 60_000;

/** Un comando reclamado y no ejecutado en este tiempo se devuelve a la cola. */
const COMMAND_STALE_MS = 120_000;

/**
 * Tope de bots REALES del canal con IA por venue en este worker, si no se
 * configura otro. Lighter cuenta el cupo por IP (60 peticiones por minuto sin
 * cuenta de servicio), y cada bot del canal lee tres series y su cuenta: con
 * más de dos, el cupo no llega (spec 058).
 */
const TOPE_CANAL_POR_VENUE_DEFECTO = 'LIGHTER=2';

/**
 * `AI_CHANNEL_MAX_BOTS_PER_VENUE`: pares `VENUE=n` separados por comas. Un
 * venue que no aparece no tiene tope. Un par mal escrito se ignora con aviso.
 */
export function topesCanalPorVenue(
  texto: string,
  avisar: (mensaje: string) => void = () => undefined,
): Map<string, number> {
  const topes = new Map<string, number>();
  for (const trozo of texto.split(',')) {
    const par = trozo.trim();
    if (!par) continue;
    const m = /^([A-Z_]+)\s*=\s*(\d+)$/.exec(par);
    if (!m) {
      avisar(`AI_CHANNEL_MAX_BOTS_PER_VENUE: «${par}» no tiene la forma VENUE=n; se ignora.`);
      continue;
    }
    topes.set(m[1], Number(m[2]));
  }
  return topes;
}

/**
 * El interruptor global del canal con IA, leído del texto de Redis. `off`
 * cierra; cualquier otra cosa —o la clave ausente— deja abierto. Acepta el
 * valor con o sin comillas: lo puede escribir la API como JSON o una persona a
 * mano. La regla es la de `shared`, la misma con la que decide la API si
 * llamar al modelo (spec 059).
 */
export function leerInterruptor(texto: string | null): EstadoInterruptor {
  return interruptorCerrado(texto)
    ? { permitidas: false, motivo: 'las entradas del canal con IA están cortadas en la consola' }
    : { permitidas: true, motivo: null };
}

/**
 * Supervisor del motor.
 *
 * Su trabajo es sencillo de enunciar y es todo lo que hace: mirar qué bots
 * deberían estar corriendo, quedarse con los que pueda (adquiriendo su lease) y
 * mantener vivos sus runners. Todo lo demás —qué órdenes poner, cuándo— vive en
 * el runner y en la estrategia.
 *
 * Escala en horizontal sin coordinación: levanta N workers y cada uno se queda
 * con los bots cuyo lease consiga, hasta su tope de capacidad. Si uno muere, sus
 * leases caducan y el resto los adopta en el siguiente barrido.
 */
@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineService.name);
  private readonly runners = new Map<string, BotRunner>();
  /** Bots que un runner ha pedido soltar; se atienden en el barrido. */
  private readonly pendingDetach = new Map<string, string>();
  private scanTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private scanning = false;
  private maxBots = 250;
  /** Ver `topesCanalPorVenue`. */
  private topesCanal = new Map<string, number>();

  constructor(
    private readonly db: DbService,
    private readonly store: BotStore,
    private readonly leases: LeaseService,
    private readonly accounts: AccountHub,
    private readonly inbox: CommandInbox,
    private readonly bus: BusService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly priceSource: PriceSourceService,
    /** Velas compartidas, para las estrategias que las declaran (spec 038). */
    private readonly marketData: MarketDataService,
    /** Intenciones del canal con IA (spec 058). */
    private readonly intents: AiIntentStore,
  ) {}

  async onModuleInit(): Promise<void> {
    this.maxBots = Number(this.config.get('WORKER_MAX_BOTS', 250));
    this.topesCanal = topesCanalPorVenue(
      String(this.config.get('AI_CHANNEL_MAX_BOTS_PER_VENUE', TOPE_CANAL_POR_VENUE_DEFECTO)),
      (m) => this.logger.warn(m),
    );

    // Perder un lease tiene que soltar el runner AL INSTANTE, no en el próximo
    // barrido: mientras tanto habría dos procesos operando el mismo bot.
    this.leases.onLeaseLost = (botIds, reason) => {
      for (const botId of botIds) {
        // Primero se renuncia a escribir su sandbox y luego se suelta el runner,
        // en ese orden: soltarlo dispara el guardado final, y hacerlo sin lease
        // sería pisarle el estado al worker que ya lo ha adoptado.
        this.accounts.abandonPaper(botId);
        this.pendingDetach.set(botId, reason);
      }
      // Con `catch`: soltar un bot escribe en la base y en Redis, y una promesa
      // suelta que rechace tumba el worker entero (001/F-07).
      void this.applyDetachments().catch((e: Error) =>
        this.logger.error(`Fallo soltando bots: ${e.message}`),
      );
    };

    await this.subscribeToBus();

    const scanMs = Number(this.config.get('ENGINE_SCAN_INTERVAL_MS', 5000));
    this.scanTimer = setInterval(() => void this.scan(), scanMs);
    await this.scan();

    this.logger.log(
      `Motor arrancado (${this.leases.workerId}), barrido cada ${scanMs} ms, tope ${this.maxBots} bots`,
    );
  }

  /**
   * Los runners se cierran en `onModuleDestroy`, que Nest ejecuta ANTES de
   * `onApplicationShutdown` — donde `LeaseService` libera los leases.
   *
   * El orden importa y estaba al revés: los leases se soltaban con los runners
   * todavía operando, así que otro worker podía adoptar el bot y ejecutarlo en
   * paralelo durante ese hueco. Runners fuera primero, leases después.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;

    // Se cierran los runners pero NO se cancelan sus órdenes: un despliegue no
    // debe deshacer la escalera de nadie. Las órdenes siguen vivas en el venue
    // y el worker que adopte el bot las reconocerá como suyas.
    this.logger.log(`Cerrando ${this.runners.size} runner(s)...`);
    await Promise.allSettled([...this.runners.values()].map((r) => r.dispose()));
    // Lo reclamado y no ejecutado vuelve a la cola: si no, un comando quedaría
    // marcado como cogido por un proceso que ya no existe y nadie lo ejecutaría.
    await Promise.allSettled(
      [...this.runners.keys()].map((id) => this.inbox.releaseUnexecuted(id, this.leases.workerId)),
    );
    this.runners.clear();
  }

  // ═══════════════════════════════════════════════════════════════
  // Barrido
  // ═══════════════════════════════════════════════════════════════

  private async scan(): Promise<void> {
    if (this.shuttingDown || this.scanning) return;
    this.scanning = true;
    try {
      await this.applyDetachments();
      await this.dropLostLeases();
      await this.reconcileRunners();
      // Adoptar ANTES de drenar: un PANIC dirigido a un bot huérfano —su worker
      // murió— debe ejecutarse en este mismo barrido, no en el siguiente.
      await this.adoptPending();
      await this.drainCommands();
      await this.inbox.recoverStale(COMMAND_STALE_MS, (botId) => this.leases.holder(botId));
    } catch (e) {
      this.logger.error(`Barrido fallido: ${(e as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Suelta los bots que un runner ha pedido soltar: credencial inválida, o un
   * comando que lo ha parado de forma definitiva.
   *
   * Sin esto, un bot parado o en error se quedaba en el mapa con su
   * temporizador vivo, su WebSocket abierto y su lease renovándose para
   * siempre. Un worker acababa lleno de bots que no hacían nada mientras otros
   * bots reales no encontraban sitio.
   */
  private async applyDetachments(): Promise<void> {
    if (this.pendingDetach.size === 0) return;
    const pending = [...this.pendingDetach];
    this.pendingDetach.clear();

    for (const [botId, reason] of pending) {
      const runner = this.runners.get(botId);
      if (!runner) continue;
      this.logger.log(`Soltando ${botId.slice(0, 8)}: ${reason}`);
      await runner.dispose().catch(() => undefined);
      this.runners.delete(botId);
      await this.inbox.releaseUnexecuted(botId, this.leases.workerId);
      await this.leases.release(botId);
    }
  }

  /**
   * Si este proceso ha perdido un lease —porque estuvo detenido más que el TTL
   * y otro worker lo adoptó— hay que soltar el runner INMEDIATAMENTE. Seguir
   * operando un bot cuyo lease es de otro es exactamente el escenario de
   * órdenes duplicadas que el lease existe para evitar.
   */
  private async dropLostLeases(): Promise<void> {
    for (const [botId, runner] of this.runners) {
      if (this.leases.holds(botId)) continue;
      this.logger.warn(`Lease de ${botId} perdido: se suelta el runner.`);
      // Antes de soltarlo: sin lease, este worker no escribe su sandbox. Ver
      // `AccountHub.abandonPaper`.
      this.accounts.abandonPaper(botId);
      await runner.dispose().catch(() => undefined);
      this.runners.delete(botId);
    }
  }

  /**
   * Alinea los runners con lo que dice la base.
   *
   * Se hace por ESTADO y no por comandos concretos, y esa es la diferencia:
   * antes solo se miraba `STOPPING`, así que un bot pausado o parado por
   * cualquier otro camino conservaba su runner indefinidamente. Aquí, cualquier
   * bot cuyo estado ya no sea de los que se ejecutan se desmonta, venga de
   * donde venga el cambio.
   */
  private async reconcileRunners(): Promise<void> {
    const ids = [...this.runners.keys()];
    if (ids.length === 0) return;

    const rows = await this.db.bot.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    const status = new Map(rows.map((r) => [r.id, r.status]));

    for (const botId of ids) {
      const s = status.get(botId);

      // El bot ya no existe: lo borraron de la base con el runner vivo. Sus
      // órdenes siguen en el venue y ESTA es la última oportunidad de
      // cancelarlas — el adaptador en memoria aún puede firmar, pero la
      // credencial en base ya no existe y tras soltar el runner no habrá forma
      // de tocarlas nunca más. La API impide llegar aquí por los caminos
      // normales; esto cubre el borrado directo en base.
      if (!s) {
        const runner = this.runners.get(botId);
        if (runner) await runner.emergencyCancelAll().catch(() => undefined);
        // ESTE es el caso que justifica que la bitácora no tenga clave foránea.
        //
        // `emergencyCancelAll` cancela TODAS las órdenes del símbolo en el
        // venue —incluidas las que el usuario pusiera a mano— y hasta ahora no
        // podía dejar rastro: la fila del bot ya no existe, así que un
        // `bot_events` habría violado su clave foránea. Aquí sí cabe.
        if (runner) {
          this.audit.record({
            action: 'worker.emergency_cancel_all',
            severity: EventSeverity.CRITICAL,
            outcome: AuditOutcome.ERROR,
            botId,
            message:
              'El bot se borró de la base con el runner vivo: se cancelan todas las ' +
              'órdenes del símbolo en el venue.',
          });
        }
        this.pendingDetach.set(botId, 'el bot ya no existe');
        continue;
      }

      if (s === 'STOPPING') {
        const runner = this.runners.get(botId);
        if (!runner) continue;
        await runner.handleCommand('STOP_AND_CLOSE').catch((e) => {
          this.logger.error(`Error parando ${botId}: ${(e as Error).message}`);
        });
        this.pendingDetach.set(botId, 'parada solicitada');
        continue;
      }

      if (!(ADOPTABLE as readonly string[]).includes(s)) {
        this.pendingDetach.set(botId, `estado ${s}`);
      }
    }

    await this.applyDetachments();
  }

  /**
   * Entrega los comandos pendientes de los bots que este worker tiene.
   *
   * La bandeja de `bot_commands` es la entrega DURADERA; el mensaje del bus
   * solo adelanta el momento. Antes solo estaba el mensaje, y pub/sub entrega a
   * quien escucha en ese instante: un PANIC publicado mientras el worker dueño
   * reiniciaba se perdía en silencio con la API respondiendo `accepted`.
   */
  private async drainCommands(): Promise<void> {
    // UNA consulta para todos los runners: en el caso normal la cola está
    // vacía, y preguntar bot a bot eran doscientas consultas cada cinco
    // segundos para no encontrar nada.
    const byBot = await this.inbox
      .claimForBots([...this.runners.keys()], this.leases.workerId)
      .catch((e: Error) => {
        // Con la base caída, un PANIC parecía «sin comandos». No se puede hacer
        // más que esperar al siguiente barrido, pero se dice (001/F-18).
        this.logger.error(`No se pudieron reclamar los comandos: ${e.message}. Esperan.`);
        return new Map<string, never[]>();
      });

    for (const [botId, commands] of byBot) {
      const runner = this.runners.get(botId);
      if (!runner) {
        // El bot se soltó entre el reclamo y aquí: se devuelve a la cola para
        // que lo ejecute quien lo adopte.
        await this.inbox.releaseUnexecuted(botId, this.leases.workerId);
        continue;
      }
      for (const cmd of commands) {
        try {
          // La bandeja decide cuándo se cierra el comando: los que mueven
          // dinero, antes de correr; el resto, al terminar. Y si falla, lo
          // cierra con el motivo en vez de dejarlo pendiente: un comando que
          // falla y sigue en la cola se reintentaría en cada barrido para
          // siempre sin que nadie lo hubiera vuelto a pedir.
          await this.inbox.execute(cmd, () =>
            runner.handleCommand(cmd.command as RunnerCommand, cmd.payload),
          );
        } catch (e) {
          const message = (e as Error).message;
          this.logger.error(`Comando ${cmd.command} fallido en ${botId}: ${message}`);
          // Con el user_id REAL: el aviso sin destinatario se escribía en la
          // tabla pero ni el SSE ni Telegram lo entregaban a nadie — la misma
          // lección que ya costó el aviso de arranque fallido.
          await this.store
            .event(
              { id: botId, user_id: cmd.userId },
              'COMMAND_FAILED',
              'ERROR',
              `No se pudo ejecutar ${cmd.command}: ${message}`,
            )
            .catch(() => undefined);
        }
      }
    }
    await this.applyDetachments();
  }

  /** Adopta los bots que deberían estar corriendo y no tienen dueño. */
  private async adoptPending(): Promise<void> {
    const libre = this.maxBots - this.runners.size;
    if (libre <= 0) return;

    // También los STOPPING sin dueño: sus órdenes pueden seguir vivas en el
    // venue y alguien tiene que adoptarlos para cerrarlas. Antes se quedaban
    // en STOPPING para siempre si ningún worker los tenía cuando se pidió.
    const candidates = await this.db.bot.findMany({
      where: {
        status: { in: [...ADOPTABLE, 'STOPPING'] },
        id: { notIn: [...this.runners.keys()] },
      },
      // `user_id` también: si el arranque falla hay que poder avisar al dueño,
      // y a esas alturas ya no se ha cargado el bot entero.
      select: {
        id: true,
        user_id: true,
        exchange_account_id: true,
        symbol: true,
        status: true,
        dry_run: true,
      },
      orderBy: { updated_at: 'asc' },
      take: Math.min(libre, 50),
    });

    // Se adquieren los leases primero y se arranca después con concurrencia
    // acotada. En serie, adoptar cincuenta bots costaba cincuenta arranques
    // encadenados y el barrido siguiente llegaba tarde.
    const mine: typeof candidates = [];
    for (const bot of candidates) {
      if (this.runners.size + mine.length >= this.maxBots) break;
      if (await this.leases.acquire(bot.id)) mine.push(bot);
    }

    for (let i = 0; i < mine.length; i += SPAWN_CONCURRENCY) {
      await Promise.all(mine.slice(i, i + SPAWN_CONCURRENCY).map((bot) => this.trySpawn(bot)));
    }
  }

  private async trySpawn(bot: {
    id: string;
    user_id: string;
    exchange_account_id: string;
    symbol: string;
    status: string;
    dry_run: boolean;
  }): Promise<void> {
    try {
      // Red de seguridad para filas antiguas: la regla de un bot por par la
      // impone un índice único parcial en la base y la valida la API, pero un
      // bot creado antes de que existieran podría violarla. Arrancarlo haría
      // que dos bots vieran la misma posición del venue como propia.
      //
      // Dos excepciones deliberadas:
      //
      // · Un bot que se está PARANDO se adopta siempre: viene a cancelar y
      //   cerrar, no a competir por la posición. Negarle la adopción lo dejaría
      //   en STOPPING para siempre con sus órdenes vivas en el libro.
      //
      // · Los SIMULADOS no cuentan, en ningún lado de la comparación: cada uno
      //   opera en su propio sandbox (`paper_states`) y no comparte posición con
      //   nadie. Lo estuvieron una temporada, mientras el simulador fue uno por
      //   CUENTA y sí se pisaban; ahora poder correr varias estrategias sobre el
      //   mismo par a la vez es justo para lo que sirve simular.
      const rival =
        bot.status === 'STOPPING' || bot.dry_run
          ? null
          : await this.db.bot.findFirst({
              where: {
                id: { not: bot.id },
                exchange_account_id: bot.exchange_account_id,
                symbol: bot.symbol,
                status: { in: [...LIVE] },
                dry_run: false,
              },
              select: { id: true },
            });
      if (rival) {
        throw new Error(
          `Ya hay otro bot vivo (${rival.id.slice(0, 8)}) sobre ${bot.symbol} en esta cuenta. ` +
            'En un DEX la posición es única por cuenta y símbolo: dos bots se pisarían.',
        );
      }

      await this.spawn(bot.id);

      // Un bot adoptado en STOPPING se para AQUÍ MISMO, no en el siguiente
      // barrido: arranca en pausa (no coloca nada) y se le aplica el cierre.
      // El comando terminal pide el desenganche solo, que libera el lease.
      if (bot.status === 'STOPPING') {
        const runner = this.runners.get(bot.id);
        if (runner) {
          await runner.handleCommand('STOP_AND_CLOSE').catch((e) => {
            this.logger.error(
              `Error cerrando ${bot.id} adoptado en STOPPING: ${(e as Error).message}`,
            );
          });
        }
      }
    } catch (e) {
      await this.leases.release(bot.id);
      const message = (e as Error).message;
      this.logger.error(`No se pudo arrancar ${bot.id}: ${message}`);
      await this.db.bot
        .update({
          where: { id: bot.id },
          data: { status: 'ERROR', last_error: message },
        })
        .catch(() => undefined);
      // Con `user_id: ''` este aviso se escribía en la tabla pero NO llegaba
      // a ninguna parte: tanto el SSE como Telegram descartan los mensajes
      // sin dueño. El usuario no se enteraba justo del evento que más
      // importa — que su bot, con dinero detrás, no ha arrancado.
      await this.store
        .event(
          { id: bot.id, user_id: bot.user_id },
          'START_FAILED',
          'ERROR',
          `El motor no pudo arrancar el bot: ${message}`,
        )
        .catch(() => undefined);
    }
  }

  /**
   * Arranques del canal con IA en curso, por venue: el tope se cuenta con ellos
   * para que dos adopciones simultáneas no lo pasen las dos.
   */
  private readonly arrancandoCanal = new Map<string, string>();

  /** Por qué el dueño no puede operar esta estrategia, o null si sí puede. */
  private async motivoNoAdmin(userId: string, strategy: string): Promise<string | null> {
    const dueno = await this.db.user.findUnique({
      where: { id: userId },
      select: { role: true, disabled: true },
    });
    if (dueno && dueno.role === 'ADMIN' && !dueno.disabled) return null;
    return (
      `La estrategia ${strategy} solo la puede operar un administrador habilitado, y el dueño de ` +
      'este bot no lo es.'
    );
  }

  /** El dueño de una estrategia solo para administradores lo es, y está habilitado. */
  private async comprobarDuenoAdmin(userId: string, strategy: string): Promise<void> {
    const motivo = await this.motivoNoAdmin(userId, strategy);
    if (motivo) throw new Error(motivo);
  }

  /** Lo último que se supo del rol del dueño de cada bot del canal. */
  private readonly rolDelDueno = new Map<string, { at: number; motivo: string | null }>();

  /**
   * El interruptor de entradas de UN bot del canal: el global, y además que su
   * dueño siga siendo un administrador habilitado (spec 062, F-06).
   *
   * En modo REGLAS el bot no pasa por la API, así que la barrera de allí no lo
   * frena: un dueño degradado —o deshabilitado— seguía abriendo operaciones
   * hasta el siguiente relevo de worker. Cerrar las ENTRADAS y no el bot es a
   * propósito: la posición abierta conserva su stop, sus objetivos y su
   * vigilante.
   */
  private async interruptorDelBot(userId: string, strategy: string): Promise<EstadoInterruptor> {
    const global = await this.leerInterruptorCanal();
    if (!global.permitidas) return global;
    const previo = this.rolDelDueno.get(userId);
    const ahora = Date.now();
    let motivo = previo && ahora - previo.at < ROL_TTL_MS ? previo.motivo : undefined;
    if (motivo === undefined) {
      motivo = await this.motivoNoAdmin(userId, strategy);
      this.rolDelDueno.set(userId, { at: ahora, motivo });
    }
    return motivo ? { permitidas: false, motivo } : global;
  }

  /** Reserva un hueco del tope de bots reales del canal con IA en ese venue. */
  private reservarCanal(botId: string, venue: Venue, strategy: StrategyKind): void {
    const tope = this.topesCanal.get(venue);
    if (tope === undefined) return;
    const vivos = [...this.runners.values()].filter((r) => {
      const p = r.perfil;
      return p.strategy === strategy && p.venue === venue && !p.dryRun && r.botId !== botId;
    }).length;
    // Sin los que ya tienen runner: esos ya se han contado arriba.
    const arrancando = [...this.arrancandoCanal].filter(
      ([id, v]) => id !== botId && v === venue && !this.runners.has(id),
    ).length;
    if (vivos + arrancando >= tope) {
      throw new Error(
        `Este worker ya opera ${vivos + arrancando} bot(s) reales del canal con IA en ${venue}, el ` +
          'tope configurado (AI_CHANNEL_MAX_BOTS_PER_VENUE): el cupo de peticiones del venue no ' +
          'da para más.',
      );
    }
    this.arrancandoCanal.set(botId, venue);
  }

  /**
   * El interruptor global del canal con IA. Con plazo: con Redis caído el
   * cliente encola la orden en vez de fallar, y el tick esperaría dentro del
   * cerrojo del bot.
   */
  private async leerInterruptorCanal(): Promise<EstadoInterruptor> {
    let timer: NodeJS.Timeout | undefined;
    const plazo = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis no contesta')), 1_000);
    });
    try {
      return leerInterruptor(
        await Promise.race([this.bus.leerTexto(CLAVE_INTERRUPTOR_CANAL), plazo]),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** El nocional que declara la estrategia, para los agregados de exposición. */
  private async anotarNocional(botId: string, strategy: StrategyKind, config: BotConfig) {
    const valor = getStrategy(strategy).nocionalMaximo?.(config) ?? null;
    await this.store
      .setMaxNotional(botId, valor)
      .catch((e: Error) =>
        this.logger.warn(`No se pudo guardar el nocional de ${botId}: ${e.message}`),
      );
  }

  /** Reconstruye un bot completo desde la base de datos y lo pone en marcha. */
  private async spawn(botId: string): Promise<void> {
    try {
      await this.spawnSinReserva(botId);
    } finally {
      this.arrancandoCanal.delete(botId);
    }
  }

  private async spawnSinReserva(botId: string): Promise<void> {
    const bot = await this.db.bot.findUniqueOrThrow({ where: { id: botId } });

    // El canal con IA: solo un administrador, con el rol leído de la base, y
    // como mucho los bots reales por venue que el cupo aguanta (spec 058). Un
    // bot que no cumple queda en ERROR con el motivo (`trySpawn`).
    //
    // Pero eso decide ARRANQUES (`STARTING`), no relevos: un bot que YA estaba
    // operando se readopta pase lo que pase. Dejarlo en ERROR lo dejaba además
    // sin comandos —la API en ERROR solo admite START, y START exige el rol—,
    // con la posición abierta, sin salidas, sin vigilante y sin que nadie
    // pudiera ni pausarlo ni cerrarlo (spec 062, F-06). Si el dueño ya no puede
    // operarlo, se adopta EN PAUSA y se dice.
    const arranque = bot.status === 'STARTING';
    let enPausaPorRol: string | null = null;
    if (esEstrategiaSoloAdmin(bot.strategy)) {
      const motivo = await this.motivoNoAdmin(bot.user_id, bot.strategy);
      if (motivo && arranque) throw new Error(motivo);
      enPausaPorRol = motivo;
    }
    // El tope por venue es igual: un relevo readopta lo que ya estaba dentro del
    // tope, y un bot en STOPPING solo viene a terminar de cerrar.
    if (bot.strategy === 'AI_CHANNEL' && !bot.dry_run && arranque) {
      this.reservarCanal(bot.id, bot.venue, bot.strategy);
    }

    // La red antes que nada: decide qué ficha de mercado es la buena, y con la
    // que no es el bot redondearía a una retícula que su venue no reconoce. Va
    // en una consulta aparte porque la spec depende de su resultado; es una fila
    // diminuta y esto corre una vez por bot adoptado, no en cada tick.
    const { testnet } = await this.db.exchangeAccount.findUniqueOrThrow({
      where: { id: bot.exchange_account_id },
      select: { testnet: true },
    });

    const [revision, market, guards] = await Promise.all([
      this.db.botConfigRevision.findUniqueOrThrow({
        where: {
          bot_id_version: { bot_id: botId, version: bot.config_version },
        },
      }),
      this.store.marketSpec(bot.venue, bot.symbol, testnet),
      // Fresco: arrancar un bot justo después de tocar los límites es el
      // momento en el que un dato de hace veinte segundos es el equivocado.
      this.store.riskGuards(bot.user_id, { fresco: true }),
    ]);

    const config = revision.config as unknown as BotConfig;
    const cycle: CycleState = await this.store.ensureCycle(
      botId,
      Number(config.cooldownMinutes ?? 0),
    );
    await this.anotarNocional(botId, bot.strategy, config);

    // Por CUENTA, no por bot: si ya hay otro bot de esta misma cuenta corriendo
    // en este worker, comparten conexión, firmante, limitador de caudal y
    // lecturas de estado. Ver `AccountHub`.
    const adapter = await this.accounts.open(
      bot.exchange_account_id,
      bot.id,
      bot.venue,
      bot.symbol,
      bot.dry_run,
      testnet,
    );

    const spec: MarketSpec = market;

    const runner = new BotRunner({
      bot: bot,
      adapter,
      testnet,
      market: spec,
      config,
      cycle,
      store: this.store,
      guards,
      reconcileIntervalMs: Number(this.config.get('RECONCILE_INTERVAL_MS', 15_000)),
      priceSource: this.priceSource,
      candleSource: this.marketData,
      intents: this.intents,
      interruptorCanal: () => this.interruptorDelBot(bot.user_id, bot.strategy),
      // Se adopta tal y como estaba: un bot pausado sigue pausado tras un
      // relevo de worker —arrancarlo sin más lo pondría a operar sin que nadie
      // se lo pidiera— y uno en STOPPING no debe colocar NADA: su siguiente
      // paso es el cierre, que aplica quien lo adoptó.
      startPaused: bot.status === 'PAUSED' || bot.status === 'STOPPING' || enPausaPorRol !== null,
      onDetach: (id, reason) => {
        this.pendingDetach.set(id, reason);
        void this.applyDetachments().catch((e: Error) =>
          this.logger.error(`Fallo soltando bots: ${e.message}`),
        );
      },
    });

    this.runners.set(botId, runner);
    try {
      await runner.start();
    } catch (e) {
      // Si el arranque falla a medias, el runner puede haber abierto sockets.
      this.runners.delete(botId);
      await runner.dispose().catch(() => undefined);
      throw e;
    }
    if (enPausaPorRol) {
      await this.store.setStatus(botId, 'PAUSED', { error: enPausaPorRol }).catch(() => undefined);
      await this.store
        .event(
          { id: botId, user_id: bot.user_id },
          'BOT_PAUSED',
          'WARN',
          `Bot adoptado EN PAUSA: ${enPausaPorRol} No abrirá nada; su posición conserva el stop ` +
            'y los objetivos en el exchange, y sigue admitiendo pausar, parar y cerrar.',
        )
        .catch(() => undefined);
    }
    this.logger.log(`Bot ${botId.slice(0, 8)} adoptado (${bot.strategy} / ${bot.symbol})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Bus
  // ═══════════════════════════════════════════════════════════════

  private async subscribeToBus(): Promise<void> {
    const commands$ = await this.bus.listen(BUS_CHANNELS.BOT_COMMANDS);
    commands$.subscribe((message) => {
      if (!message.botId) return;
      // Si el bot no es de este worker, se ignora en silencio: el mensaje llega
      // a todos los procesos suscritos y solo debe actuar el que tiene el lease.
      if (!this.runners.has(message.botId)) return;
      if (message.type === 'START') return; // Lo cubre el barrido de adopción.
      // El mensaje solo ADELANTA el drenaje; la orden real está en la bandeja.
      // Así el mismo comando no puede ejecutarse dos veces —lo impide el
      // reclamo condicional— ni perderse si el aviso no llega.
      void this.drainCommands().catch((e) => {
        this.logger.error(`Drenaje de comandos fallido: ${(e as Error).message}`);
      });
    });

    const config$ = await this.bus.listen(BUS_CHANNELS.BOT_CONFIG);
    config$.subscribe((message) => {
      if (!message.botId) return;
      const runner = this.runners.get(message.botId);
      if (!runner) return;
      void this.reloadConfig(message.botId, runner, message.data);
    });

    // Una intención del canal con IA ha cambiado: el bot la mira ya. Solo
    // adelanta; el latido la vería igual (spec 058).
    const intents$ = await this.bus.listen(BUS_CHANNELS.BOT_AI_INTENTS);
    intents$.subscribe((message) => {
      if (!message.botId) return;
      this.runners.get(message.botId)?.pedirTick();
    });
  }

  private async reloadConfig(
    botId: string,
    runner: BotRunner,
    data: { level?: string },
  ): Promise<void> {
    try {
      const bot = await this.db.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { config_version: true, strategy: true },
      });
      const revision = await this.db.botConfigRevision.findUniqueOrThrow({
        where: {
          bot_id_version: { bot_id: botId, version: bot.config_version },
        },
      });
      const config = revision.config as unknown as BotConfig;
      await runner.reloadConfig(config, (data.level as 'HOT' | 'WARM' | 'COLD') ?? 'HOT');
      await this.anotarNocional(botId, bot.strategy, config);
    } catch (e) {
      this.logger.error(
        `No se pudo recargar la configuración de ${botId}: ${(e as Error).message}`,
      );
    }
  }

  /** Estado del motor: lo consume el endpoint de salud. */
  /**
   * Runners con el temporizador vivo pero sin completar un tick.
   *
   * Es el fallo que el lease NO detecta: un proceso atascado renueva su lease
   * igual de bien que uno sano, así que hasta ahora un motor bloqueado se
   * reportaba perfecto. El umbral son cuatro latidos —un minuto con el ritmo
   * por defecto—: un tick suelto puede tardar, pero cuatro seguidos sin cerrar
   * ya no es lentitud.
   */
  private stalledRunners(): string[] {
    const limit = Number(this.config.get('RECONCILE_INTERVAL_MS', 15_000)) * 4;
    // Sin contar a los que esperan a un venue caído: ver `runnersAtascados` (spec 050).
    return runnersAtascados(this.runners.entries(), limit);
  }

  status() {
    const stalled = this.stalledRunners();
    return {
      workerId: this.leases.workerId,
      runners: this.runners.size,
      capacity: this.maxBots,
      leases: this.leases.count,
      bots: [...this.runners.keys()],
      stalled: stalled.length,
      stalledBots: stalled,
      redis: this.leases.redisReady(),
      // La regla vive en `evaluarSalud` (y su test): enfermo sin Redis, o con
      // TODOS los runners atascados. Antes «cero runners» era sano también
      // cuando la causa era haberlos soltado todos por Redis caído (001/F-18).
      healthy: evaluarSalud({
        runners: this.runners.size,
        stalled: stalled.length,
        leasesConfirmed: this.leases.redisReady(),
      }),
    };
  }
}
