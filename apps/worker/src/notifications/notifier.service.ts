import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ACCION_PAUSAR_CANAL,
  AccionSeguimiento,
  D,
  EventoAgente,
  EventoCanal,
  PREFIJO_BOTON_CANAL,
  VerboAgente,
  callbackAgente,
  datosEventoAgente,
  esEventoAgente,
  esValeCanal,
  type DatosEventoAgente,
} from '@crypton/shared';
import { LeaseService } from '../engine';
import { BUS_CHANNELS, BusService, DbService, type BusMessage } from '../libs';
import { lineasResumenAgentes } from './resumen-agentes';
import {
  TelegramClient,
  bienFormado,
  escapeHtml,
  recortar,
  trocear,
  type InlineKeyboard,
} from './telegram-client';

interface TelegramPrefs {
  fills: boolean;
  cycles: boolean;
  errors: boolean;
  risk: boolean;
  liquidation: boolean;
  daily: boolean;
  /** Lo que propone o aplica el supervisor de IA (spec 046). */
  ai: boolean;
  /** Lo que proponen y hacen los agentes de IA, con sus botones (spec 074). */
  agentes: boolean;
}

const DEFAULT_PREFS: TelegramPrefs = {
  fills: false,
  cycles: true,
  errors: true,
  risk: true,
  liquidation: true,
  daily: true,
  ai: true,
  agentes: true,
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
  // La misma preferencia que la pausa, y por el mismo motivo que la liquidación:
  // quien quiso enterarse de que su bot se paraba quiere enterarse, sobre todo,
  // de que ya puede volver a arrancarlo (spec 063).
  RISK_GUARD_CLEARED: 'risk',
  LIQUIDATION_NEAR: 'liquidation',
  // La misma preferencia que el aviso de cercania: quien quiere enterarse de
  // que se acerca la liquidacion quiere enterarse, sobre todo, de que ha
  // ocurrido.
  LIQUIDATED: 'liquidation',
  PANIC: 'risk',
  // Un resto por debajo del mínimo del venue pide una acción del usuario —el
  // motor no puede cerrarlo con una orden—, así que va con los errores.
  POSITION_BELOW_MINIMUM: 'errors',
  // Un tercero ha tocado este bot. Va con `risk` y no con `errors` porque no es
  // una averia: es alguien de soporte conteniendo el bot, y quien silencia los
  // errores no puede quedarse sin enterarse de ESTO. Tener entrada propia lo
  // saca ademas de la via generica, que exige WARN o mas y por tanto dependia de
  // que el publicador se acordara de mandar la severidad (spec 046, R-27).
  ADMIN_COMMAND: 'risk',
  // El supervisor de IA (spec 046). Preferencia propia porque no son averias:
  // dicen que una configuracion ha cambiado o podria cambiar. `AI_FAILED` va con
  // los errores a proposito — quien silencia al supervisor no quiere dejar de
  // saber que esta roto.
  AI_SUGGESTION: 'ai',
  AI_ADVICE: 'ai',
  AI_APPLIED: 'ai',
  AI_FAILED: 'errors',
  // La caída del venue y su vuelta (spec 050). Con entrada propia porque la
  // vuelta es INFO, y la vía genérica exige WARN: sin esto el aviso de caída
  // llegaba y el de vuelta no, y el usuario se quedaba creyendo que seguía caído.
  VENUE_UNAVAILABLE: 'errors',
  VENUE_RECOVERED: 'errors',
  // El canal con IA (spec 059). La entrada y la salida son operaciones, como un
  // ciclo cerrado: en estos bots `AI_EXIT` sustituye a `CYCLE_CLOSED`. Lo que
  // pone en juego la posición va con `risk` y no con `errors`: una posición sin
  // stop no puede depender de que el usuario quiera enterarse de las averías.
  AI_ENTRY: 'cycles',
  AI_EXIT: 'cycles',
  AI_DAY_STOP: 'risk',
  SIN_STOP: 'risk',
  AI_CIERRE_FALLIDO: 'risk',
  AI_POSICION_HUERFANA: 'risk',
  AI_OPERACION_PERDIDA: 'risk',
  AI_ENTRY_DISCARDED: 'errors',
  // Los agentes de IA (spec 074). Su trabajo —propuestas, en qué acabaron, el
  // seguimiento y la vida de cada operación— va con su preferencia propia: en
  // estos bots `AGENT_EXIT` sustituye a `CYCLE_CLOSED`, y quien silencia los
  // ciclos de un market maker no debe perder las operaciones de un agente. Lo
  // que pone en juego una posición o para al agente va con `risk`, como en el
  // canal; lo que dice que algo no funciona, con `errors`.
  AGENT_PROPOSAL: 'agentes',
  AGENT_PROPOSAL_RESULT: 'agentes',
  AGENT_ACTION: 'agentes',
  AGENT_ENTRY: 'agentes',
  AGENT_EXIT: 'agentes',
  AGENT_BREAKEVEN: 'agentes',
  AGENT_STOP_TIGHTENED: 'agentes',
  AGENT_REDUCED: 'agentes',
  AGENT_PAUSED: 'risk',
  AGENT_CIERRE_FALLIDO: 'risk',
  AGENT_FOREIGN_POSITION: 'risk',
  AGENT_OPERACION_PERDIDA: 'risk',
  AGENT_SLEEPING: 'errors',
  AGENT_STOP_IGNORED: 'errors',
  AGENT_ENTRY_DISCARDED: 'errors',
  // `AI_DECISION` NO está: va solo a la línea de tiempo, y nace en la API sin
  // entrega forzada. `AI_CIERRE` tampoco: es la orden de salir, y el aviso con
  // el resultado llega con `AI_EXIT`; lo mismo `AGENT_CIERRE` con `AGENT_EXIT`.
  // `EXIT_PENDING_MIN_SIZE` NO está aquí a propósito: es informativo y se cura
  // solo en cuanto entra otra ejecución. Notificarlo sería enseñar a silenciar
  // el canal justo antes del aviso que sí había que leer.
};

/**
 * Severidad mínima para entregar un tipo que TIENE preferencia propia.
 *
 * La vía con preferencia no mira la severidad, así que un evento informativo se
 * entregaba igual que uno grave. Un market maker rechazado por post-only —su
 * conducta normal— mandaba un aviso por tick hasta que el usuario silenciaba el
 * canal entero, y con él los avisos que sí importaban (spec 029).
 */
const MIN_SEVERITY: Record<string, string[]> = {
  ORDER_REJECTED: ['WARN', 'ERROR', 'CRITICAL'],
  // Una IOC que no se llenó es INFO y se queda en la línea de tiempo; la que el
  // motor descarta por el venue o los límites es WARN y se avisa (spec 059).
  AI_ENTRY_DISCARDED: ['WARN', 'ERROR', 'CRITICAL'],
  AGENT_ENTRY_DISCARDED: ['WARN', 'ERROR', 'CRITICAL'],
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
  RISK_GUARD_CLEARED: '🔓',
  LIQUIDATION_NEAR: '🔥',
  LIQUIDATED: '💥',
  AUTH_ERROR: '🔑',
  VENUE_UNAVAILABLE: '📡',
  VENUE_RECOVERED: '✅',
  PANIC: '🛑',
  ADMIN_COMMAND: '🛟',
  AI_SUGGESTION: '🤖',
  AI_ADVICE: '🤖',
  AI_APPLIED: '🤖',
  AI_FAILED: '🤖',
  AI_ENTRY: '📥',
  AI_EXIT: '📤',
  AI_DAY_STOP: '⛔',
  AI_ENTRY_DISCARDED: '↩️',
  AI_OPERACION_PERDIDA: '🧭',
  AGENT_PROPOSAL: '💡',
  AGENT_PROPOSAL_RESULT: '↩️',
  AGENT_ACTION: '🛡',
  AGENT_ENTRY: '📥',
  AGENT_EXIT: '📤',
  AGENT_BREAKEVEN: '🛡',
  AGENT_STOP_TIGHTENED: '🛡',
  AGENT_REDUCED: '✂️',
  AGENT_PAUSED: '⛔',
  AGENT_SLEEPING: '💤',
  AGENT_STOP_IGNORED: '⚠',
  AGENT_ENTRY_DISCARDED: '↩️',
  AGENT_FOREIGN_POSITION: '⚠',
  AGENT_OPERACION_PERDIDA: '🧭',
  BOT_STARTED: '▶',
  BOT_PAUSED: '⏸',
  BOT_STOPPED: '⏹',
};

/**
 * Ventana del cerrojo que reparte la entrega de un evento ajeno.
 *
 * Un minuto: lo bastante largo para cubrir el desfase entre réplicas que
 * reciben el mismo mensaje del bus, y lo bastante corto para que la clave no
 * se quede ocupando sitio. No se reintenta nada al caducar — para entonces el
 * aviso ya se mandó o ya no interesa.
 */
const FORCED_DELIVERY_LOCK_MS = 60_000;

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

/**
 * Pausa entre los trozos de un mismo lote (spec 056, R-5). Telegram admite
 * ráfagas cortas, pero pide no pasar de un mensaje por segundo por chat, y lo
 * que corta con un 429 no se reintenta.
 */
const PAUSA_ENTRE_TROZOS_MS = 1_100;

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
  /** El último envío en curso de cada chat: los lotes salen en fila (spec 056, R-5). */
  private readonly envios = new Map<string, Promise<void>>();
  /** Entre dos mensajes seguidos al mismo chat. Telegram pide no pasar de uno por segundo. */
  private readonly pausaEntreTrozosMs = PAUSA_ENTRE_TROZOS_MS;
  /** Cuándo salió el último mensaje de cada chat, para medir esa pausa (spec 074). */
  private readonly ultimoEnvio = new Map<string, number>();

  /** Cache de vinculación por usuario; evita una consulta por evento. */
  private readonly linkCache = new Map<
    string,
    { chatId: string; prefs: TelegramPrefs; at: number }
  >();
  /**
   * Un minuto, y es lo que gobierna también la propagación entre procesos: las
   * preferencias se cambian en la API, que corre aparte, así que aquí llegan
   * cuando caduca la entrada. Había un `invalidate()` para acortarlo que no
   * llamaba nadie y que no podía funcionar —está en otro proceso—; se quitó en
   * vez de dejarlo aparentando una inmediatez que no existía (spec 029).
   */
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
    // Con `catch`: `onEvent` consulta la base, y un fallo ahí era una promesa
    // sin manejar que en Node tumba el proceso entero con todos sus bots
    // (001/F-07).
    events$.subscribe(
      (message) =>
        void this.onEvent(message).catch((e: Error) =>
          this.logger.warn(`No se pudo procesar un evento para Telegram: ${e.message}`),
        ),
    );
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
    if (!message.userId) return;
    // Los eventos de un agente de IA no tienen bot: son del agente, y traen su
    // id en los datos (spec 074). Cualquier otro sin bot no es para aquí: las
    // pulsaciones de los botones, por ejemplo, van del poller a la API.
    const { botId } = message;
    const agente = botId || !esEventoAgente(message.type) ? null : datosEventoAgente(message.data);
    if (!botId && !agente) return;

    // Solo notifica el proceso que PUBLICÓ el evento.
    //
    // Pub/sub entrega a todos los suscritos, así que con N workers cada evento
    // llegaba a los N y los N mandaban el mismo mensaje: el usuario recibía el
    // aviso tantas veces como réplicas hubiera. El sondeo de Telegram sí tenía
    // su cerrojo; el envío no tenía nada.
    //
    // La excepción son los eventos que NO publica un worker. El origen de uno
    // que nace en la API no casa con ninguno, así que no lo entregaba NINGUNO:
    // `ADMIN_COMMAND` prometía en su comentario que el dueño se entera «en el
    // momento» de que un tercero le ha tocado el bot, y llevaba desde el spec
    // 033 sin llegar nunca (spec 046, R-27). Esos vienen marcados, y para ellos
    // el cerrojo de `reservarEntrega` hace el papel que aquí hace el origen.
    const ajeno = message.origin !== undefined && message.origin !== this.bus.originId;
    if (ajeno && message.entregaForzada !== true) return;

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
    const minima = MIN_SEVERITY[message.type];
    if (minima && !minima.includes(severity)) return;

    const etiqueta = agente
      ? await this.agentLabel(agente.agentId)
      : await this.botLabel(botId ?? '');
    const icon = ICON[message.type] ?? (severity === 'CRITICAL' ? '🔥' : '·');
    // Recortada aquí, antes de encolarla o de mandarla sola: una línea que no cabe
    // en un mensaje lo tumba entero (spec 054).
    const line = recortar(
      bienFormado(
        `${icon} <b>${escapeHtml(etiqueta)}</b> — ${escapeHtml(data.message ?? message.type)}`,
      ),
    );

    // Se reserva lo más tarde posible: un evento que el usuario no quiere no
    // debe costar una ida y vuelta a Redis, y el camino normal —el del origen
    // propio— no pasa por aquí en absoluto.
    if (ajeno && !(await this.reservarEntrega(message, agente))) return;

    // Una sugerencia con botones NO puede ir en el lote: el teclado pertenece a
    // UN mensaje, y fundirla con otras once lineas dejaria dos botones colgando
    // de un texto que habla de otras cosas. Se manda sola y al momento, pero en
    // la fila de su chat: dos propuestas seguidas, o una detrás de un lote, eran
    // la ráfaga que Telegram corta con un 429 (spec 074).
    const teclado = this.tecladoDe(message, agente);
    if (teclado) {
      await this.enFila(link.chatId, [line], teclado);
      return;
    }

    this.enqueue(link.chatId, line);
  }

  /**
   * Reserva la entrega de un evento ajeno, para que la haga UNA sola réplica.
   *
   * La clave se compone solo con datos del MENSAJE —bot, tipo y marca de
   * tiempo—, nunca con nada del proceso: el `ts` lo pone quien publica
   * (`BusService.publish`), así que las N réplicas que reciben el mismo mensaje
   * compiten por la misma clave y gana una. Con el identificador del worker
   * dentro, cada una se concedería el suyo y volveríamos a los N avisos.
   *
   * `tryLock` devuelve `false` con Redis caído, y aquí eso significa no
   * entregar. Es lo correcto para este camino: duplicar avisos es peor que
   * saltarse uno, y lo que se juega es un aviso, no una orden.
   *
   * Sin bot, la clave lleva la propuesta o la acción del agente (spec 074): una
   * ronda puede publicar dos propuestas del mismo agente en el mismo
   * milisegundo, y con solo el agente la segunda perdería contra la primera y
   * no la entregaría nadie.
   */
  private reservarEntrega(message: BusMessage, agente: DatosEventoAgente | null): Promise<boolean> {
    const destino = agente
      ? `ag:${agente.agentId}:${agente.accionId ?? agente.propuestaId ?? '-'}`
      : message.botId;
    return this.leases.tryLock(
      `notify:${destino}:${message.type}:${message.ts}`,
      FORCED_DELIVERY_LOCK_MS,
    );
  }

  /**
   * El teclado de aprobar y descartar, si el evento lo lleva.
   *
   * El vale (`token`) lo genera quien publica y vive en Redis con un solo uso:
   * aqui solo se copia al boton. En `callback_data` caben 64 bytes, asi que no
   * entra nada mas — ni el id del bot ni una descripcion del cambio.
   */
  private tecladoDe(message: BusMessage, agente: DatosEventoAgente | null): InlineKeyboard | null {
    // Una propuesta o una acción de un agente (spec 074). El vale lo guarda la
    // API al proponer; el lector ya dejó fuera uno mal formado, y sin vale el
    // aviso va al lote como cualquier otro: es el de lo que se aplicó solo.
    if (message.type === EventoAgente.PROPUESTA || message.type === EventoAgente.ACCION) {
      return agente?.vale ? tecladoAgente(message.type, agente.vale, agente.accion) : null;
    }

    // La entrada del canal con IA lleva su botón de pausa (spec 059). El vale
    // lo guardó el worker al emitir el aviso; aquí solo se copia, y uno mal
    // formado no pinta botón: pulsarlo no serviría de nada.
    if (message.type === EventoCanal.ENTRADA) {
      const vale = (message.data as { vale?: unknown })?.vale;
      if (!esValeCanal(vale)) return null;
      return {
        inline_keyboard: [
          [
            {
              text: '⏸ Pausar el bot',
              callback_data: `${PREFIJO_BOTON_CANAL}:${vale}:${ACCION_PAUSAR_CANAL}`,
            },
          ],
        ],
      };
    }

    if (message.type !== 'AI_SUGGESTION') return null;
    const token = (message.data as { token?: string })?.token;
    if (typeof token !== 'string' || token.length === 0) return null;

    return {
      inline_keyboard: [
        [
          { text: '✅ Aplicar', callback_data: `ia:${token}:si` },
          { text: '✖ Descartar', callback_data: `ia:${token}:no` },
        ],
      ],
    };
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

    // En varios mensajes si hace falta. Doce líneas cabían siempre en uno cuando
    // cada aviso era una frase; los del supervisor listan ahora sus cambios
    // (spec 054), y un error del venue ya podía ser largo antes. Uno de más de
    // 4096 caracteres Telegram lo rechaza entero.
    await this.enFila(chatId, trocear(parts));
  }

  /**
   * Manda unos mensajes a un chat, en fila con los demás de ese chat y con una
   * pausa entre dos seguidos (spec 056, R-5): sin la fila, un envío lento dejaba
   * que el lote siguiente se colara entre los trozos del anterior; sin la pausa,
   * una ráfaga al mismo chat es lo que Telegram corta con un 429, y el cliente
   * no reintenta.
   *
   * La pausa se mide desde el último mensaje que salió a ese chat, sea de un
   * lote o de uno con botones (spec 074): antes solo había pausa entre los
   * trozos de un mismo lote, y los mensajes con botones salían por su cuenta.
   * El teclado, si lo hay, va en el último.
   */
  private async enFila(
    chatId: string,
    textos: readonly string[],
    teclado?: InlineKeyboard,
  ): Promise<void> {
    const anterior = this.envios.get(chatId) ?? Promise.resolve();
    const este = anterior.then(async () => {
      for (const [i, texto] of textos.entries()) {
        const ultimo = this.ultimoEnvio.get(chatId);
        const falta = ultimo === undefined ? 0 : ultimo + this.pausaEntreTrozosMs - Date.now();
        if (falta > 0) await this.esperar(falta);
        const conTeclado = teclado && i === textos.length - 1 ? teclado : undefined;
        await this.client.sendMessage(chatId, texto, conTeclado);
        this.ultimoEnvio.set(chatId, Date.now());
      }
    });
    const cola = este.catch(() => undefined);
    this.envios.set(chatId, cola);
    try {
      await este;
    } finally {
      if (this.envios.get(chatId) === cola) this.envios.delete(chatId);
    }
  }

  /** Espera; aparte para que un test pueda contar las pausas sin dormir. */
  private esperar(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

    const prefs = { ...DEFAULT_PREFS, ...((link.prefs as object) ?? {}) };
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
      select: { name: true, symbol: true, dry_run: true },
    });
    // Marcado el simulado: un aviso de un bot de pruebas era indistinguible del
    // de uno con dinero dentro, y el usuario no puede decidir si le importa sin
    // saber cuál de los dos es (spec 029).
    const label = bot
      ? `${bot.name} (${bot.symbol})${bot.dry_run ? ' · simulado' : ''}`
      : botId.slice(0, 8);
    this.botNames.set(botId, { label, at: Date.now() });
    return label;
  }

  private readonly agentNames = new Map<string, { label: string; at: number }>();

  /**
   * La etiqueta de un aviso de agente (spec 074): su nombre, y marcado si opera
   * en la cuenta de simulación, por lo mismo que un bot simulado.
   */
  private async agentLabel(agentId: string): Promise<string> {
    const cached = this.agentNames.get(agentId);
    if (cached && Date.now() - cached.at < LABEL_TTL_MS) return cached.label;

    const agente = await this.db.aiDeskAgent.findUnique({
      where: { id: agentId },
      select: { name: true, exchange_account: { select: { paper: true } } },
    });
    const label = agente
      ? `Agente «${agente.name}»${agente.exchange_account.paper ? ' · simulado' : ''}`
      : `Agente ${agentId.slice(0, 8)}`;
    this.agentNames.set(agentId, { label, at: Date.now() });
    return label;
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

    // Quién tiene agentes, de una vez: son pocos, y así no se pregunta por los
    // de cada usuario que no ha creado ninguno. Un fallo aquí deja el resumen
    // sin su sección de agentes, no sin resumen.
    const conAgentes = await this.usuariosConAgentes().catch(() => new Set<string>());

    for (const link of links) {
      const prefs = { ...DEFAULT_PREFS, ...((link.prefs as object) ?? {}) };
      if (!prefs.daily || !link.chat_id) continue;

      try {
        const agentes =
          prefs.agentes && conAgentes.has(link.user_id)
            ? await this.lineasAgentes(link.user_id, midnight).catch(() => [])
            : [];
        // El `dry_run` de cada fila, para separar las dos cuentas. La regla de
        // la casa está escrita en `portfolio-aggregate.ts`: «el resultado de un
        // simulado es dinero que no existe y no se suma nunca al de verdad». La
        // cartera, los snapshots y el ranking la respetaban; este resumen no, y
        // le daba al usuario una cifra de ganancias que mezclaba las dos
        // (spec 029).
        const [todosCycles, todosBots] = await Promise.all([
          this.db.botCycle.findMany({
            where: { bot: { user_id: link.user_id }, closed_at: { gte: midnight } },
            select: { realized_pnl: true, fees: true, bot: { select: { dry_run: true } } },
          }),
          this.db.bot.findMany({
            where: { user_id: link.user_id, status: { in: ['RUNNING', 'PAUSED', 'ERROR'] } },
            select: { status: true, dry_run: true },
          }),
        ]);
        const cycles = todosCycles.filter((c) => !c.bot.dry_run);
        const bots = todosBots.filter((b) => !b.dry_run);
        const simCycles = todosCycles.filter((c) => c.bot.dry_run);
        const simBots = todosBots.filter((b) => b.dry_run);

        // Sin actividad y sin bots vivos no hay nada que contar: un mensaje
        // diario vacío solo entrena al usuario a ignorarlos.
        const conBots = todosCycles.length > 0 || todosBots.length > 0;
        if (!conBots && agentes.length === 0) continue;

        const lines = ['<b>Resumen del día</b>'];
        if (conBots) {
          const pnl = cycles.reduce((a, c) => a.plus(c.realized_pnl.toString()), D(0));
          const fees = cycles.reduce((a, c) => a.plus(c.fees.toString()), D(0));
          const running = bots.filter((b) => b.status === 'RUNNING').length;
          const paused = bots.filter((b) => b.status === 'PAUSED').length;
          const errored = bots.filter((b) => b.status === 'ERROR').length;

          const sign = pnl.gte(0) ? '+' : '';
          lines.push(
            `Resultado: <b>${sign}${pnl.toFixed(2)}</b> en ${cycles.length} ciclo(s)`,
            `Comisiones: ${fees.toFixed(2)}`,
            `Bots: ${running} operando · ${paused} pausados${errored ? ` · ${errored} en error` : ''}`,
          );
          if (errored > 0) lines.push('⚠ Revisa los bots en error.');

          // Los simulados no desaparecen del resumen, van aparte: uno que ha
          // estado trabajando todo el día y no sale por ningún lado se lee como
          // un bot parado.
          if (simCycles.length > 0 || simBots.length > 0) {
            const simPnl = simCycles.reduce((a, c) => a.plus(c.realized_pnl.toString()), D(0));
            const simSign = simPnl.gte(0) ? '+' : '';
            const simVivos = simBots.filter((b) => b.status === 'RUNNING').length;
            lines.push(
              `<i>Simulado (no cuenta): ${simSign}${simPnl.toFixed(2)} en ` +
                `${simCycles.length} ciclo(s) · ${simVivos} operando</i>`,
            );
          }
        }
        // Las operaciones de los agentes son bots y ya cuentan arriba; esto es
        // lo que dice de los agentes lo que no dice un ciclo (spec 074).
        lines.push(...agentes);

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

  /** Los usuarios con algún agente, archivado o no: pudo trabajar antes de archivarse. */
  private async usuariosConAgentes(): Promise<Set<string>> {
    const filas = await this.db.aiDeskAgent.findMany({
      distinct: ['user_id'],
      select: { user_id: true },
    });
    return new Set(filas.map((f) => f.user_id));
  }

  /** La sección de los agentes de un usuario: lo de hoy y lo abierto ahora. */
  private async lineasAgentes(userId: string, desde: Date): Promise<string[]> {
    const deUsuario = { agent: { user_id: userId } };
    const [propuestas, cerradas, abiertas] = await Promise.all([
      this.db.aiDeskProposal.findMany({
        where: { ...deUsuario, created_at: { gte: desde } },
        select: { state: true, dry_run: true },
      }),
      this.db.aiDeskProposal.findMany({
        where: { ...deUsuario, state: 'CERRADA', closed_at: { gte: desde } },
        select: { realized_pnl: true, r_real: true, dry_run: true },
      }),
      this.db.aiDeskProposal.findMany({
        where: { ...deUsuario, state: { in: ['EJECUTANDO', 'ABIERTA'] } },
        select: { dry_run: true },
      }),
    ]);
    return lineasResumenAgentes(
      propuestas,
      cerradas.map((c) => ({
        pnl: c.realized_pnl?.toString() ?? null,
        r: c.r_real?.toString() ?? null,
        dry_run: c.dry_run,
      })),
      abiertas,
    );
  }
}

/**
 * Los botones de un mensaje de agente (spec 074). Comparten el vale y cambian
 * el verbo, así que la primera pulsación lo gasta. Una propuesta se ejecuta o
 * se descarta; una acción de seguimiento se aplica o se descarta, y además se
 * puede cerrar la operación entera. Si lo propuesto ya es cerrar, se cierra o
 * se mantiene.
 */
export function tecladoAgente(
  tipo: string,
  vale: string,
  accion?: AccionSeguimiento,
): InlineKeyboard {
  const boton = (text: string, verbo: VerboAgente) => ({
    text,
    callback_data: callbackAgente(vale, verbo),
  });
  if (tipo === EventoAgente.PROPUESTA) {
    return {
      inline_keyboard: [
        [boton('✅ Ejecutar', VerboAgente.SI), boton('✖ Descartar', VerboAgente.NO)],
      ],
    };
  }
  if (accion === AccionSeguimiento.CERRAR) {
    return {
      inline_keyboard: [[boton('⏹ Cerrar', VerboAgente.SI), boton('✖ Mantener', VerboAgente.NO)]],
    };
  }
  return {
    inline_keyboard: [
      [boton('✅ Aplicar', VerboAgente.SI), boton('✖ Descartar', VerboAgente.NO)],
      [boton('⏹ Cerrar la operación', VerboAgente.CIERRA)],
    ],
  };
}
