import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { D } from '@crypton/shared';
import { LeaseService } from '../engine';
import { BUS_CHANNELS, BusService, DbService, type BusMessage } from '../libs';
import { TelegramClient, escapeHtml } from './telegram-client';

interface TelegramPrefs {
  fills: boolean;
  cycles: boolean;
  errors: boolean;
  risk: boolean;
  liquidation: boolean;
  daily: boolean;
}

const DEFAULT_PREFS: TelegramPrefs = {
  fills: false,
  cycles: true,
  errors: true,
  risk: true,
  liquidation: true,
  daily: true,
};

/** Qué preferencia gobierna cada tipo de evento. */
const EVENT_PREF: Record<string, keyof TelegramPrefs> = {
  FILL: 'fills',
  CYCLE_CLOSED: 'cycles',
  ORDER_REJECTED: 'errors',
  INSUFFICIENT_FUNDS: 'errors',
  TICK_ERROR: 'errors',
  STREAM_ERROR: 'errors',
  AUTH_ERROR: 'errors',
  START_FAILED: 'errors',
  ACTION_FAILED: 'errors',
  RISK_GUARD_TRIPPED: 'risk',
  LIQUIDATION_NEAR: 'liquidation',
  // La misma preferencia que el aviso de cercania: quien quiere enterarse de
  // que se acerca la liquidacion quiere enterarse, sobre todo, de que ha
  // ocurrido.
  LIQUIDATED: 'liquidation',
  PANIC: 'risk',
  // Un resto por debajo del mínimo del venue pide una acción del usuario —el
  // motor no puede cerrarlo con una orden—, así que va con los errores.
  POSITION_BELOW_MINIMUM: 'errors',
  // `EXIT_PENDING_MIN_SIZE` NO está aquí a propósito: es informativo y se cura
  // solo en cuanto entra otra ejecución. Notificarlo sería enseñar a silenciar
  // el canal justo antes del aviso que sí había que leer.
};

const ICON: Record<string, string> = {
  FILL: '•',
  CYCLE_CLOSED: '✓',
  ORDER_REJECTED: '⚠',
  ORDER_UNVIABLE: '⚠',
  ORDER_RETRY: '↻',
  POSITION_BELOW_MINIMUM: '🧹',
  EXIT_PENDING_MIN_SIZE: '⏳',
  INSUFFICIENT_FUNDS: '⚠',
  RISK_GUARD_TRIPPED: '🛑',
  LIQUIDATION_NEAR: '🔥',
  LIQUIDATED: '💥',
  AUTH_ERROR: '🔑',
  PANIC: '🛑',
  BOT_STARTED: '▶',
  BOT_PAUSED: '⏸',
  BOT_STOPPED: '⏹',
};

/** Cuánto se espera para agrupar eventos del mismo chat antes de enviar. */
const BATCH_WINDOW_MS = 4000;

/** Ventana del cerrojo del resumen diario. */
const DIGEST_LOCK_MS = 30 * 60_000;

/** Telegram admite ~30 mensajes por segundo; se deja margen. */
const DIGEST_GAP_MS = 60;

/** Cuánto vive una etiqueta de bot en memoria. */
const LABEL_TTL_MS = 10 * 60_000;
/** Líneas máximas por mensaje; el resto se resume en una sola. */
const MAX_LINES = 12;

interface PendingBatch {
  lines: string[];
  dropped: number;
  timer: NodeJS.Timeout;
}

/**
 * Envío de alertas por Telegram.
 *
 * Agrupa antes de enviar, y no es un detalle de eficiencia: un market maker
 * genera decenas de eventos por minuto, y mandar uno por mensaje haría que
 * Telegram limite el caudal y que el usuario silencie el canal — justo antes de
 * que llegue el aviso de liquidación que sí tenía que leer. Con la ventana de
 * agrupación, una ráfaga se convierte en un mensaje legible.
 */
@Injectable()
export class NotifierService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotifierService.name);
  private readonly client: TelegramClient;
  private readonly pending = new Map<string, PendingBatch>();

  /** Cache de vinculación por usuario; evita una consulta por evento. */
  private readonly linkCache = new Map<
    string,
    { chatId: string; prefs: TelegramPrefs; at: number }
  >();
  private static readonly LINK_TTL_MS = 60_000;

  constructor(
    private readonly db: DbService,
    private readonly bus: BusService,
    private readonly leases: LeaseService,
    config: ConfigService,
  ) {
    this.client = new TelegramClient(config.get<string>('TELEGRAM_BOT_TOKEN', ''));
  }

  async onModuleInit(): Promise<void> {
    if (!this.client.enabled) {
      this.logger.log('Sin TELEGRAM_BOT_TOKEN: las alertas quedan desactivadas.');
      return;
    }

    const events$ = await this.bus.listen(BUS_CHANNELS.BOT_EVENTS);
    events$.subscribe((message) => void this.onEvent(message));
    this.logger.log('Alertas de Telegram activas');
  }

  onModuleDestroy(): void {
    // Se vacía lo pendiente al apagar: si no, el último lote —que suele ser el
    // del apagado, con los bots parándose— se perdería.
    for (const [chatId, batch] of this.pending) {
      clearTimeout(batch.timer);
      void this.flush(chatId);
    }
  }

  private async onEvent(message: BusMessage): Promise<void> {
    if (!message.userId || !message.botId) return;

    // Solo notifica el proceso que PUBLICÓ el evento.
    //
    // Pub/sub entrega a todos los suscritos, así que con N workers cada evento
    // llegaba a los N y los N mandaban el mismo mensaje: el usuario recibía el
    // aviso tantas veces como réplicas hubiera. El sondeo de Telegram sí tenía
    // su cerrojo; el envío no tenía nada.
    if (message.origin && message.origin !== this.bus.originId) return;

    const data = message.data as { severity?: string; message?: string };
    const severity = data.severity ?? 'INFO';

    const link = await this.linkOf(message.userId);
    if (!link) return;

    // Tipo conocido → manda su preferencia. Tipo nuevo o desconocido → solo se
    // notifica si es grave, para que añadir un evento al motor no obligue a
    // tocar esta tabla para que el usuario se entere de algo importante.
    const prefKey = EVENT_PREF[message.type];
    const allowed = prefKey
      ? link.prefs[prefKey]
      : link.prefs.errors && ['WARN', 'ERROR', 'CRITICAL'].includes(severity);
    if (!allowed) return;

    const bot = await this.botLabel(message.botId);
    const icon = ICON[message.type] ?? (severity === 'CRITICAL' ? '🔥' : '·');
    const line = `${icon} <b>${escapeHtml(bot)}</b> — ${escapeHtml(data.message ?? message.type)}`;

    this.enqueue(link.chatId, line);
  }

  private enqueue(chatId: string, line: string): void {
    const existing = this.pending.get(chatId);

    if (existing) {
      if (existing.lines.length < MAX_LINES) existing.lines.push(line);
      else existing.dropped++;
      return;
    }

    this.pending.set(chatId, {
      lines: [line],
      dropped: 0,
      timer: setTimeout(() => void this.flush(chatId), BATCH_WINDOW_MS),
    });
  }

  private async flush(chatId: string): Promise<void> {
    const batch = this.pending.get(chatId);
    if (!batch) return;
    this.pending.delete(chatId);
    clearTimeout(batch.timer);

    const parts = [...batch.lines];
    if (batch.dropped > 0) parts.push(`<i>… y ${batch.dropped} evento(s) más</i>`);

    await this.client.sendMessage(chatId, parts.join('\n'));
  }

  private async linkOf(userId: string): Promise<{ chatId: string; prefs: TelegramPrefs } | null> {
    const cached = this.linkCache.get(userId);
    if (cached && Date.now() - cached.at < NotifierService.LINK_TTL_MS) {
      return { chatId: cached.chatId, prefs: cached.prefs };
    }

    const link = await this.db.telegramLink.findUnique({ where: { user_id: userId } });
    if (!link?.chat_id || !link.verified_at) {
      this.linkCache.delete(userId);
      return null;
    }

    const prefs = { ...DEFAULT_PREFS, ...((link.prefs as object) ?? {}) } as TelegramPrefs;
    this.linkCache.set(userId, { chatId: link.chat_id, prefs, at: Date.now() });
    return { chatId: link.chat_id, prefs };
  }

  /** Etiquetas con caducidad: sin ella el mapa crecía sin fin y un bot
   *  renombrado seguía apareciendo con su nombre viejo para siempre. */
  private readonly botNames = new Map<string, { label: string; at: number }>();

  private async botLabel(botId: string): Promise<string> {
    const cached = this.botNames.get(botId);
    if (cached && Date.now() - cached.at < LABEL_TTL_MS) return cached.label;

    const bot = await this.db.bot.findUnique({
      where: { id: botId },
      select: { name: true, symbol: true },
    });
    const label = bot ? `${bot.name} (${bot.symbol})` : botId.slice(0, 8);
    this.botNames.set(botId, { label, at: Date.now() });
    return label;
  }

  /** Invalida la cache cuando el usuario cambia sus preferencias. */
  invalidate(userId: string): void {
    this.linkCache.delete(userId);
  }

  // ═══════════════════════════════════════════════════════════════
  // Resumen diario
  // ═══════════════════════════════════════════════════════════════

  /**
   * Un mensaje al día con el resultado de la jornada.
   *
   * Es el contrapeso de tener los fills apagados por defecto: el usuario no
   * recibe ruido continuo, pero tampoco pierde de vista cómo va la cosa.
   */
  @Cron(CronExpression.EVERY_DAY_AT_9PM)
  async dailyDigest(): Promise<void> {
    if (!this.client.enabled) return;

    // Detrás de un cerrojo, como el sondeo de Telegram. `@Cron` dispara en TODOS
    // los workers: sin esto, cada usuario recibía tantos resúmenes idénticos
    // como réplicas hubiera levantadas.
    if (!(await this.leases.tryLock('telegram-digest', DIGEST_LOCK_MS))) return;

    const links = await this.db.telegramLink.findMany({
      where: { verified_at: { not: null }, chat_id: { not: null } },
    });

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    for (const link of links) {
      const prefs = { ...DEFAULT_PREFS, ...((link.prefs as object) ?? {}) } as TelegramPrefs;
      if (!prefs.daily || !link.chat_id) continue;

      try {
        const [cycles, bots] = await Promise.all([
          this.db.botCycle.findMany({
            where: { bot: { user_id: link.user_id }, closed_at: { gte: midnight } },
            select: { realized_pnl: true, fees: true },
          }),
          this.db.bot.findMany({
            where: { user_id: link.user_id, status: { in: ['RUNNING', 'PAUSED', 'ERROR'] } },
            select: { status: true },
          }),
        ]);

        // Sin actividad y sin bots vivos no hay nada que contar: un mensaje
        // diario vacío solo entrena al usuario a ignorarlos.
        if (cycles.length === 0 && bots.length === 0) continue;

        const pnl = cycles.reduce((a, c) => a.plus(c.realized_pnl.toString()), D(0));
        const fees = cycles.reduce((a, c) => a.plus(c.fees.toString()), D(0));
        const running = bots.filter((b) => b.status === 'RUNNING').length;
        const paused = bots.filter((b) => b.status === 'PAUSED').length;
        const errored = bots.filter((b) => b.status === 'ERROR').length;

        const sign = pnl.gte(0) ? '+' : '';
        const lines = [
          '<b>Resumen del día</b>',
          `Resultado: <b>${sign}${pnl.toFixed(2)}</b> en ${cycles.length} ciclo(s)`,
          `Comisiones: ${fees.toFixed(2)}`,
          `Bots: ${running} operando · ${paused} pausados${errored ? ` · ${errored} en error` : ''}`,
        ];
        if (errored > 0) lines.push('⚠ Revisa los bots en error.');

        await this.client.sendMessage(link.chat_id, lines.join('\n'));
        // Telegram corta a unos 30 mensajes por segundo por bot. Sin pausa, un
        // resumen para unos pocos miles de usuarios se estrella contra ese
        // límite y la mitad no se entrega.
        await new Promise((r) => setTimeout(r, DIGEST_GAP_MS));
      } catch (e) {
        this.logger.warn(`Resumen diario fallido para ${link.user_id}: ${(e as Error).message}`);
      }
    }
  }
}
