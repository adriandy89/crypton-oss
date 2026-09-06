import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BotConfig, CycleState, MarketSpec } from '@crypton/shared';
import { AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService, BUS_CHANNELS, BusService, DbService } from '../libs';
import { BotRunner, type RunnerCommand } from './bot-runner';
import { AccountHub } from './account-hub.service';
import { BotStore, type RiskGuards } from './bot-store';
import { CommandInbox } from './command-inbox.service';
import { LeaseService } from './lease.service';
import { evaluarSalud } from './health';
import { PriceSourceService } from '../marketdata';

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

/** Un comando reclamado y no ejecutado en este tiempo se devuelve a la cola. */
const COMMAND_STALE_MS = 120_000;

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
  ) {}

  async onModuleInit(): Promise<void> {
    this.maxBots = Number(this.config.get('WORKER_MAX_BOTS', 250));

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

  /** Reconstruye un bot completo desde la base de datos y lo pone en marcha. */
  private async spawn(botId: string): Promise<void> {
    const bot = await this.db.bot.findUniqueOrThrow({ where: { id: botId } });

    // La red antes que nada: decide qué ficha de mercado es la buena, y con la
    // que no es el bot redondearía a una retícula que su venue no reconoce. Va
    // en una consulta aparte porque la spec depende de su resultado; es una fila
    // diminuta y esto corre una vez por bot adoptado, no en cada tick.
    const { testnet } = await this.db.exchangeAccount.findUniqueOrThrow({
      where: { id: bot.exchange_account_id },
      select: { testnet: true },
    });

    const [revision, market, limits] = await Promise.all([
      this.db.botConfigRevision.findUniqueOrThrow({
        where: {
          bot_id_version: { bot_id: botId, version: bot.config_version },
        },
      }),
      this.store.marketSpec(bot.venue, bot.symbol, testnet),
      this.db.riskLimit.findUnique({ where: { user_id: bot.user_id } }),
    ]);

    const config = revision.config as unknown as BotConfig;
    const cycle: CycleState = await this.store.ensureCycle(
      botId,
      Number(config.cooldownMinutes ?? 0),
    );

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

    const guards: RiskGuards = {
      maxNotionalPerBot: limits?.max_notional_per_bot?.toString() ?? null,
      maxDailyLoss: limits?.max_daily_loss?.toString() ?? null,
      killSwitchDrawdownPct: limits?.kill_switch_drawdown_pct?.toString() ?? null,
      liquidationAlertPct: limits?.liquidation_alert_pct?.toString() ?? null,
      maxLeverage: limits?.max_leverage ?? null,
      maxTotalNotional: limits?.max_total_notional?.toString() ?? null,
    };

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
      // Se adopta tal y como estaba: un bot pausado sigue pausado tras un
      // relevo de worker —arrancarlo sin más lo pondría a operar sin que nadie
      // se lo pidiera— y uno en STOPPING no debe colocar NADA: su siguiente
      // paso es el cierre, que aplica quien lo adoptó.
      startPaused: bot.status === 'PAUSED' || bot.status === 'STOPPING',
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
  }

  private async reloadConfig(
    botId: string,
    runner: BotRunner,
    data: { level?: string },
  ): Promise<void> {
    try {
      const bot = await this.db.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { config_version: true },
      });
      const revision = await this.db.botConfigRevision.findUniqueOrThrow({
        where: {
          bot_id_version: { bot_id: botId, version: bot.config_version },
        },
      });
      await runner.reloadConfig(
        revision.config as unknown as BotConfig,
        (data.level as 'HOT' | 'WARM' | 'COLD') ?? 'HOT',
      );
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
    return [...this.runners.entries()]
      .filter(([, runner]) => runner.msSinceLastTick > limit)
      .map(([botId]) => botId);
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
