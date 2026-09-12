import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';
import { BUS_CHANNELS, BusService, DbService } from '../libs';
import { LeaseService } from '../engine';
import { TelegramClient, escapeHtml, type TelegramUpdate } from './telegram-client';

const POLL_LOCK = 'crypton:lease:telegram-poller';
const OFFSET_KEY = 'crypton:telegram:offset';

/**
 * Recepción de mensajes de Telegram (long polling).
 *
 * Solo existe para completar la vinculación: el usuario envía `/start <codigo>`
 * y aquí se empareja ese chat con su cuenta.
 *
 * `getUpdates` NO se puede llamar desde dos procesos a la vez: Telegram entrega
 * cada actualización una sola vez y el segundo lector se quedaría sin ver
 * mensajes, de forma intermitente y muy difícil de diagnosticar. Por eso el
 * bucle va detrás de un cerrojo en Redis con TTL: solo un worker sondea, y si
 * ese muere, otro toma el relevo cuando el cerrojo caduca.
 *
 * El desplazamiento (`offset`) también vive en Redis, no en memoria: si no, un
 * relevo reprocesaría mensajes ya atendidos.
 */
@Injectable()
export class TelegramPollerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramPollerService.name);
  private readonly client: TelegramClient;
  private redis!: RedisClientType;
  private running = false;
  private stopped = false;
  private lockTimer: NodeJS.Timeout | null = null;

  /** Intentos de canje por chat, para frenar la adivinanza de códigos. */
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  private static readonly LOCK_TTL_MS = 60_000;
  private static readonly MAX_ATTEMPTS = 5;
  private static readonly ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

  constructor(
    private readonly db: DbService,
    private readonly leases: LeaseService,
    private readonly config: ConfigService,
    private readonly bus: BusService,
  ) {
    this.client = new TelegramClient(config.get<string>('TELEGRAM_BOT_TOKEN', ''));
  }

  async onModuleInit(): Promise<void> {
    if (!this.client.enabled) return;

    this.redis = createClient({
      url: this.config.get<string>('REDIS_URL', 'redis://localhost:6379'),
      password: this.config.get<string>('REDIS_PASSWORD'),
    });
    this.redis.on('error', (e: Error) => this.logger.error('Redis (telegram): ' + e.message));
    await this.redis.connect();

    const me = await this.client.getMe();
    if (me?.username) this.logger.log(`Bot de Telegram conectado como @${me.username}`);

    // Se reintenta adquirir el cerrojo periódicamente: así, si el worker que
    // sondeaba se cae, otro lo recoge sin intervención.
    this.lockTimer = setInterval(() => void this.tryStart(), 20_000);
    await this.tryStart();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.lockTimer = null;
    void this.redis?.quit().catch(() => undefined);
  }

  private async tryStart(): Promise<void> {
    if (this.running || this.stopped) return;

    const acquired = await this.redis.set(POLL_LOCK, this.leases.workerId, {
      NX: true,
      PX: TelegramPollerService.LOCK_TTL_MS,
    });
    if (!acquired) return;

    this.running = true;
    this.logger.log('Este worker se encarga del sondeo de Telegram');
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running && !this.stopped) {
      try {
        // El cerrojo se renueva en cada vuelta. Si se ha perdido —porque el
        // proceso estuvo bloqueado más que el TTL— se cede el sondeo en vez de
        // competir con quien ya lo haya tomado.
        const renewed = await this.redis.set(POLL_LOCK, this.leases.workerId, {
          XX: true,
          PX: TelegramPollerService.LOCK_TTL_MS,
        });
        if (!renewed) {
          this.logger.warn('Cerrojo de sondeo perdido: lo toma otro worker.');
          this.running = false;
          return;
        }

        const offset = Number((await this.redis.get(OFFSET_KEY)) ?? 0);
        const updates = await this.client.getUpdates(offset, 30);

        for (const update of updates) {
          await this.handle(update);
          // El desplazamiento se guarda tras CADA mensaje, no al final del
          // lote: si el proceso muere a mitad, no se reprocesa lo ya atendido.
          await this.redis.set(OFFSET_KEY, String(update.update_id + 1));
        }
      } catch (e) {
        if (this.stopped) return;
        this.logger.warn(`Sondeo de Telegram fallido: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /**
   * Alguien ha pulsado un boton de una sugerencia del supervisor (spec 046).
   *
   * Este proceso hace de MENSAJERO y nada mas: no aplica, no consulta la
   * decision y ni siquiera sabe de que bot es. Solo resuelve a quien pertenece
   * el chat y publica el vale. Quien decide es la API, que es donde vive el
   * unico camino de escritura de configuracion, y donde el vale se canjea con
   * un GETDEL —atomico— que garantiza que dos pulsaciones apliquen una vez.
   *
   * Que el vale no diga nada tampoco es casual: en `callback_data` caben 64
   * bytes, asi que es un identificador opaco. Quien lo intercepte no sabe de que
   * bot es ni que cambio propone, y sin ser el chat del dueño no le sirve.
   */
  private async onBoton(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chatId = cb.message ? String(cb.message.chat.id) : null;
    const partes = (cb.data ?? '').split(':');

    // Cualquier pulsacion que no reconozcamos se contesta y se ignora: ampliar
    // `allowed_updates` cambia lo que llega para todo el mundo, y un update raro
    // no puede dejar el sondeo dando vueltas.
    if (!chatId || partes.length !== 3 || partes[0] !== 'ia') {
      await this.client.answerCallbackQuery(cb.id);
      return;
    }
    const [, token, verbo] = partes;

    const link = await this.db.telegramLink.findFirst({
      where: { chat_id: chatId, verified_at: { not: null } },
      select: { user_id: true },
    });
    if (!link) {
      // Neutro a proposito, como el canje de codigos: confirmar que el vale
      // existe le diria a quien prueba que ha acertado uno.
      await this.client.answerCallbackQuery(cb.id, 'No se ha podido procesar.');
      return;
    }

    await this.bus
      .publish(BUS_CHANNELS.BOT_EVENTS, {
        userId: link.user_id,
        type: 'AI_DECISION_TAKEN',
        data: { token, aplicar: verbo === 'si', chatId },
      })
      .catch(() => undefined);

    await this.client.answerCallbackQuery(
      cb.id,
      verbo === 'si' ? 'Aplicando…' : 'Sugerencia descartada.',
    );
  }

  /**
   * ¿Puede este chat probar otro código?
   *
   * En memoria y no en Redis a propósito: solo un worker sondea Telegram a la
   * vez (lo garantiza el cerrojo), así que el contador no necesita compartirse.
   * Si el worker se reinicia, el contador se pierde — pero también se pierde el
   * ritmo de ataque, y los códigos ya caducan por su cuenta.
   */
  private allowAttempt(chatId: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(chatId);

    if (!entry || entry.resetAt < now) {
      this.attempts.set(chatId, {
        count: 1,
        resetAt: now + TelegramPollerService.ATTEMPT_WINDOW_MS,
      });
      return true;
    }
    entry.count += 1;
    return entry.count <= TelegramPollerService.MAX_ATTEMPTS;
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.onBoton(update.callback_query);

    const message = update.message;
    const text = message?.text?.trim();
    if (!message || !text) return;

    const chatId = String(message.chat.id);

    if (text === '/start' || text === '/ayuda' || text === '/help') {
      await this.client.sendMessage(
        chatId,
        [
          '<b>CRYPTON</b>',
          '',
          'Para recibir las alertas de tus bots, genera un código en la app',
          '(Cuenta → Telegram) y envíamelo así:',
          '',
          '<code>/start TUCODIGO</code>',
        ].join('\n'),
      );
      return;
    }

    const match = /^\/start\s+([A-Za-z0-9]{4,16})$/.exec(text);
    if (!match) return;

    // Este canje NO pasa por HTTP, así que ningún límite de peticiones de la API
    // lo cubre: el contador va aquí. Sin él se podían probar códigos en bucle
    // contra TODOS los pendientes a la vez.
    if (!this.allowAttempt(chatId)) {
      await this.client.sendMessage(
        chatId,
        'Demasiados intentos. Espera unos minutos y genera un código nuevo desde la app.',
      );
      return;
    }

    const code = match[1].toUpperCase();
    const link = await this.db.telegramLink.findUnique({ where: { link_code: code } });

    // Caducado cuenta como inválido, y con el MISMO mensaje: distinguirlos le
    // diría a quien prueba códigos que ha acertado uno, solo que tarde.
    const expired = !link?.link_code_expires_at || link.link_code_expires_at.getTime() < Date.now();

    if (!link || expired) {
      if (link && expired) {
        // Se limpia el código caducado para que deje de ocupar espacio de
        // búsqueda: cada código vivo de más sube la probabilidad de acierto.
        await this.db.telegramLink
          .update({
            where: { user_id: link.user_id },
            data: { link_code: null, link_code_expires_at: null },
          })
          .catch(() => undefined);
      }
      await this.client.sendMessage(
        chatId,
        'Ese código no es válido, ha caducado o ya se ha usado. Genera uno nuevo desde la app.',
      );
      return;
    }

    // El código se consume al usarlo: deja de servir aunque alguien lo tuviera
    // apuntado o lo hubiera compartido sin darse cuenta.
    await this.db.telegramLink.update({
      where: { user_id: link.user_id },
      data: {
        chat_id: chatId,
        verified_at: new Date(),
        link_code: null,
        link_code_expires_at: null,
      },
    });
    this.attempts.delete(chatId);

    const user = await this.db.user.findUnique({
      where: { id: link.user_id },
      select: { name: true },
    });

    await this.client.sendMessage(
      chatId,
      [
        `Listo, ${escapeHtml(user?.name ?? '')}. Este chat ya recibe las alertas de tus bots.`,
        '',
        'Puedes elegir qué avisos quieres desde la app, en Cuenta → Telegram.',
      ].join('\n'),
    );

    this.logger.log(`Telegram vinculado al usuario ${link.user_id}`);
  }
}
