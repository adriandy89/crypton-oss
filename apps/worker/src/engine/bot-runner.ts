import { Logger } from '@nestjs/common';
import { Subscription } from 'rxjs';
import {
  D,
  ExchangeError,
  FairPriceOrigin,
  PriceSource,
  SourceMarketType,
  type BotConfig,
  type BotContext,
  type CycleState,
  type DesiredOrder,
  type DesiredState,
  type Fill,
  type MarginAdjustment,
  type MarketSpec,
  type OrderAck,
  type Position,
  type StrategyKind,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';
import { codecFor, shortMessage, type ExchangeAdapter } from '@crypton/exchange-core';
import {
  getStrategy,
  liquidationDistancePct,
  makeCoid,
  reconcile,
  revisarOrden,
  withStopLoss,
  type ReconcilePlan,
  type Strategy,
} from '@crypton/strategy-core';
import type { BotStore, BotRecord, RiskGuards } from './bot-store';

export type RunnerCommand =
  | 'PAUSE'
  | 'RESUME'
  | 'STOP_KEEP_POSITION'
  | 'STOP_AND_CLOSE'
  | 'CLOSE_NOW'
  | 'TAKE_PROFIT_NOW'
  | 'ADD_SAFETY_NOW'
  | 'REANCHOR_GRID'
  | 'CANCEL_ALL_ORDERS'
  | 'PANIC'
  | 'REPAIR'
  | 'ADJUST_MARGIN';

/**
 * Veredicto de las guardas de riesgo.
 *
 * Antes era un `string | null` y bastaba, porque todas las guardas acababan en
 * lo mismo: pausar. Al poder actuar la de liquidación hay dos desenlaces, y el
 * motivo por sí solo ya no dice cuál.
 */
interface GuardBreach {
  reason: string;
  action: 'PAUSE' | 'CLOSE';
}

const pauseBreach = (reason: string): GuardBreach => ({ reason, action: 'PAUSE' });

/** Comandos tras los cuales el bot deja de operar y el motor debe soltarlo. */
const TERMINAL_COMMANDS = new Set<RunnerCommand>(['STOP_KEEP_POSITION', 'STOP_AND_CLOSE', 'PANIC']);

/**
 * Por qué «Recentrar la retícula» no aplica fuera de las escaleras, estrategia a
 * estrategia. Martingala y GridMart cuelgan sus seguridades del ancla del ciclo
 * y recentrar es volver a colgarlas del precio actual; en las demás el comando
 * corría igual y hacía daño o nada (001/F-84): en la rejilla clásica las
 * líneas salen del rango, así que lo único que borraba era la memoria de los
 * niveles comprados —segunda compra por nivel y sin su venta—; en la neutral el
 * centro real es «Precio ancla», que aquí no se tocaba, y aun así se anunciaba
 * «recentrada»; TDCA y los market makers no tienen ancla que mover.
 */
const REANCHOR_NO_APLICA: Partial<Record<StrategyKind, string>> = {
  GRID_CLASSIC:
    'las líneas de la rejilla clásica salen del rango fijo y recentrar solo borraría qué niveles están comprados (compras duplicadas y sin venta). Para moverla, edita Precio inferior y Precio superior.',
  NEUTRAL_GRID:
    'el centro de la rejilla neutral es «Precio ancla»: edítalo y las líneas se recolocan solas.',
  TDCA: 'la TDCA entra por tiempo y precio medio, no cuelga de un ancla.',
  MARKET_MAKER: 'el market maker cotiza alrededor de la referencia en cada tick, no tiene ancla.',
  MARKET_MAKER_V2:
    'el market maker cotiza alrededor de la referencia en cada tick, no tiene ancla.',
};

/**
 * Cada cuántos ticks se barren las ejecuciones por REST aunque el stream diga
 * estar sano. Es el cinturón sobre los tirantes: un stream puede estar
 * conectado y aun así haberse saltado un mensaje.
 */
const FILL_SWEEP_EVERY_TICKS = 4;

/** Cuánto se retrocede en el primer barrido de ejecuciones tras adoptar. */
const FILL_BACKFILL_MS = 10 * 60_000;

/** Cada cuántos ticks se relee la spec del mercado. */
const SPEC_REFRESH_EVERY_TICKS = 40;

/** A partir de aquí un precio deja de servir para mandar una orden a mercado. */
const TICKER_MAX_AGE_MS = 10_000;

/** Cada cuánto se puede repetir el aviso de liquidación cercana. */
const LIQUIDATION_ALERT_COOLDOWN_MS = 10 * 60_000;

/**
 * Ticks seguidos fallando tras los cuales el bot se pausa solo.
 *
 * Antes no había cuenta ninguna: solo `AUTH` detenía a un bot, así que uno cuyo
 * tick fallara SIEMPRE —símbolo retirado, veto de IP, caída del venue— seguía
 * con su temporizador, renovando su lease y escribiendo un WARN cada quince
 * segundos, para siempre, mientras la app lo pintaba en verde.
 *
 * Cinco, con el latido por defecto, son algo más de un minuto: de sobra para
 * que un corte pasajero se recupere solo y sin llegar a molestar.
 */
const MAX_CONSECUTIVE_TICK_ERRORS = 5;

/**
 * Colocaciones seguidas sin salir antes de rendirse.
 *
 * Más alto que el de ticks porque se cuenta POR ORDEN: una escalera de siete
 * niveles gasta siete en un solo tick, así que veinte son unos tres ticks de
 * fallo total. Menos convertiría un hipo del venue en una pausa.
 */
const MAX_PLACE_FAILURES = 20;

/**
 * A partir de aquí, el precio de una fuente externa deja de valer para cotizar.
 *
 * Es deliberadamente más corto que el `STALE_MS` del feed del venue: si el bot
 * cotiza contra Binance y Binance deja de responder, seguir colocando órdenes
 * con el último precio conocido es exactamente el escenario en el que alguien
 * se lleva el diferencial entero. Mejor no cotizar.
 */
const FAIR_PRICE_STALE_MS = 15_000;

/** Cada cuánto se puede repetir el aviso de precio externo caducado. */
const FAIR_PRICE_ALERT_COOLDOWN_MS = 5 * 60_000;

/**
 * Cuánto se respeta una fila PENDING sin id de venue antes de darla por no
 * enviada. Veinte reconciliaciones: si la orden existiera en el libro, la
 * sincronización con el venue ya le habría puesto su id y su estado. Pasado
 * esto, seguir vetando el nivel es dejarlo muerto en silencio (001/F-37).
 */
const PENDING_ORPHAN_MS = 5 * 60_000;

/** Forma de una nota sin sus números: para comparar si cambió de verdad. */
const gist = (s: string | null): string | null => (s == null ? null : s.replace(/[\d.,]+/g, '#'));

/**
 * Cada cuántos ticks se escribe en la base el latido y el snapshot.
 *
 * Con el latido por defecto de quince segundos esto da una fila por minuto, que
 * es justo lo que el esquema dice que es `bot_snapshots` («serie temporal por
 * minuto»). Escribiendo en cada tick eran cuatro veces más: con mil bots, cinco
 * millones y medio de filas al día y sesenta y siete UPDATE por segundo sobre
 * la tabla `bots` solo para mover una marca de tiempo.
 */
const PERSIST_EVERY_TICKS = 4;

/**
 * Lo que el runner necesita de `PriceSourceService`, y nada más.
 *
 * Se declara aquí en vez de importar el servicio para no atar el motor al
 * módulo de datos de mercado: el runner solo pide un precio, no le importa
 * quién lo trae.
 */
/**
 * Qué feed externo pide la configuración de un bot.
 *
 * Es un tipo con nombre y no un objeto anónimo porque hacen falta DOS usos, y
 * el segundo es el que faltaba: pedir el feed, y COMPARAR el que se pediría
 * ahora con el que ya se está sondeando. Sin poder comparar, una recarga de
 * configuración no puede saber si tiene que cambiar de fuente. Ver
 * `syncFairPrice`.
 */
export interface FairFeedRequest {
  source: PriceSource;
  marketType: SourceMarketType;
  base: string;
  override: string | null;
}

/**
 * ¿Piden las dos el mismo feed? `null` significa «ninguna fuente externa».
 *
 * El override se compara normalizado a cadena vacía: `null`, `undefined` y `''`
 * significan todos lo mismo —usa el mapeo automático— y tratarlos como
 * distintos habría cerrado y reabierto el sondeo cada vez que el usuario toca y
 * vacía ese campo.
 */
function sameFairFeed(a: FairFeedRequest | null, b: FairFeedRequest | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.source === b.source &&
    a.marketType === b.marketType &&
    a.base === b.base &&
    (a.override ?? '') === (b.override ?? '')
  );
}

export interface PriceSourceLike {
  acquire(req: FairFeedRequest): string | null;
  release(key: string | null): void;
  peek(key: string | null): { price: string; ts: number } | null;
  /**
   * Por qué no hay precio, si es que se sabe. Opcional a propósito: el motor
   * funciona igual sin ella, solo que su aviso es más pobre.
   */
  status?(key: string | null): { cause: string; failures: number } | null;
}

/**
 * Explicación de cara al usuario para cada causa de fallo de la fuente.
 *
 * Vive aquí y no en el servicio de precios porque es texto de producto, y lo que
 * lo pinta es el historial de eventos del bot. Sin esto, el usuario leía
 * «sin precio de binance» tanto si Binance estaba bloqueando la IP del servidor
 * —que no se arregla solo— como si había un hipo de red de diez segundos.
 */
const FAIR_PRICE_CAUSE_TEXT: Record<string, string> = {
  GEO:
    'Binance no atiende peticiones desde la IP de este servidor (bloqueo por ' +
    'territorio): el bot no cotizará hasta que se cambie la salida a internet o ' +
    'la fuente de precio.',
  THROTTLED:
    'Binance está limitando nuestras peticiones: se está reintentando cada vez ' +
    'más despacio y el bot volverá a cotizar solo cuando levante el límite.',
};

export interface BotRunnerDeps {
  bot: BotRecord;
  adapter: ExchangeAdapter;
  /**
   * Red del venue en la que opera este bot. Viene de su cuenta.
   *
   * Va aquí y no en `BotRecord` porque `BotRecord` refleja la tabla `bots`, y
   * `testnet` no es columna suya a propósito: vive en `exchange_accounts`, que
   * es lo que impide que un bot y su credencial acaben en redes distintas.
   */
  testnet: boolean;
  market: MarketSpec;
  config: BotConfig;
  cycle: CycleState;
  store: BotStore;
  guards: RiskGuards;
  reconcileIntervalMs: number;
  /**
   * Feed de precios de fuentes ajenas al venue.
   *
   * Opcional a propósito: solo lo necesitan las estrategias que declaran una
   * `priceSource` distinta de EXCHANGE, y dejarlo fuera permite construir un
   * runner en un test sin levantar la mitad del worker.
   */
  priceSource?: PriceSourceLike;
  /**
   * Arranca en pausa. Se usa al adoptar un bot que ya estaba pausado.
   *
   * Un bot pausado SIGUE teniendo runner, y no es un descuido: su posición
   * sigue abierta, y pausar suele ser lo que hace el usuario justo cuando algo
   * va mal. Dejarlo sin vigilancia es quedarse sin el aviso de liquidación
   * precisamente cuando hace falta. Lo que no hace un bot pausado es
   * planificar ni colocar nada.
   */
  startPaused?: boolean;
  /**
   * El runner pide que lo suelten. Lo llama cuando ha dejado de poder operar
   * —credencial inválida— o cuando un comando lo ha parado de forma definitiva.
   *
   * Antes no existía: un bot parado o con la credencial revocada se quedaba en
   * el mapa del motor con su temporizador vivo, su WebSocket abierto y su lease
   * renovándose para siempre.
   */
  onDetach: (botId: string, reason: string) => void;
}

/**
 * Un bot vivo.
 *
 * Mantiene en memoria lo que hace falta para operar —adaptador conectado,
 * configuración vigente, estado del ciclo— y en cada tick converge el venue
 * hacia lo que pide la estrategia. Todo el estado ES persistente: si el proceso
 * muere, otro worker reconstruye este objeto desde la base de datos y sigue
 * exactamente donde estaba.
 */
export class BotRunner {
  private readonly logger: Logger;
  private readonly strategy: Strategy<BotConfig>;
  private readonly encode: (canonical: string) => string;

  private config: BotConfig;
  private cycle: CycleState;
  private market: MarketSpec;

  private timer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private subs: Subscription[] = [];
  /** Hay un tick encolado esperando al cerrojo. */
  private tickScheduled = false;
  private stopped = false;
  private paused = false;
  private lastTicker: Ticker | null = null;
  /**
   * ¿Ya se avisó de que a este bot lo liquidaron?
   *
   * Una liquidación puede llegar troceada en varias ejecuciones y todas pasan
   * por `afterLiquidation`. Esto es lo que hace que el aviso crítico y la pausa
   * ocurran una sola vez sin depender de `paused`, que puede venir puesto de
   * antes por motivos que no tienen nada que ver.
   */
  private liquidationAnnounced = false;
  private ticks = 0;
  /** Última nota escrita, para no reescribirla en cada latido. */
  private lastNote: string | null = null;
  /** Hasta cuándo NO se repite el aviso de liquidación cercana. */
  private liquidationAlertUntil = 0;
  /** Ticks seguidos fallando. Alimenta el cortacircuitos. */
  private tickErrors = 0;
  /** ¿Se ha contrastado ya el ciclo con el venue tras adoptar? */
  private startupChecked = false;
  /**
   * Último tick que llegó a completarse.
   *
   * `bots.last_tick_at` ya existía en la base, pero no lo leía NADIE: se
   * escribía una vez por minuto y ahí se quedaba. Esta copia en memoria es la
   * que consulta el chequeo de salud, sin pagar una consulta por bot.
   */
  private lastTickOkAt = Date.now();
  /**
   * ¿Lleva este bot contadores de market making?
   *
   * Se resuelve una vez y no en cada ejecución: un market maker activo produce
   * decenas de miles de fills, y la comparación importa menos que el hecho de
   * que la decisión esté en UN sitio.
   */
  private readonly isMarketMaker: boolean;
  /** Feed externo reservado por este bot, para poder soltarlo al parar. */
  private fairFeedKey: string | null = null;
  /** Hasta cuándo NO se repite el aviso de precio externo caducado. */
  private fairPriceAlertUntil = 0;

  /**
   * Cerrojo del runner. TODO lo que toca el venue o el estado del bot pasa por
   * aquí: ticks, comandos, recargas de configuración y ejecuciones.
   *
   * Sin él, un PANIC que entraba a mitad de tick cancelaba las órdenes y acto
   * seguido el bucle de `execute()` —que seguía corriendo— colocaba las
   * siguientes. Es decir: se podían colocar órdenes DESPUÉS de un pánico.
   */
  private gate: Promise<unknown> = Promise.resolve();

  /** Última ejecución incorporada al ledger, para pedir por REST solo lo nuevo. */
  private lastFillTs = 0;
  /** ¿Está entregando el stream de ejecuciones? Hasta saberlo, se asume que no. */
  private fillsHealthy = false;

  /**
   * Niveles que el venue ha rechazado por reglas en este ciclo.
   *
   * Sin esto, un nivel por debajo del mínimo del venue se reintentaba en CADA
   * tick durante toda la vida del bot: un rechazo cada 15 segundos, una fila en
   * `bot_events` cada 15 segundos, un aviso de Telegram, y caudal quemado. Se
   * guarda la forma exacta (lado, tipo, precio y cantidad) para que un cambio
   * de la escalera sí vuelva a intentarlo.
   */
  private readonly quarantine = new Map<string, string>();

  /**
   * Forma del stop loss cuyo rechazo ya se anunció en CRITICAL.
   *
   * El stop NO entra en la cuarentena de arriba: un nivel de escalera puede
   * esperar a que cambie la escalera, la red de seguridad no. Se reintenta en
   * cada tick mientras haya posición. Pero avisar en cada tick sería un
   * CRITICAL en el Telegram del usuario cada quince segundos, así que el aviso
   * sale UNA vez por forma —precio y cantidad— y vuelve a salir si cambia.
   */
  private stopRechazoAvisado: string | null = null;

  /**
   * ¿Sigue la posición pudiendo crecer en este tick?
   *
   * Se calcula una vez por tick y lo consulta `revisarOrden`. Es lo que
   * distingue «el take profit todavía no llega al mínimo, espera» de «hay un
   * resto que ya no se puede cerrar». Sin esta distinción, una ejecución
   * PARCIAL de la entrada dejaba al bot pidiendo cada tick una salida que el
   * venue nunca iba a aceptar.
   */
  private entradasVivas = false;

  /**
   * Colocaciones seguidas que no han salido por un fallo PASAJERO.
   *
   * Existe por un agujero que abrió la propia contención: al dejar de relanzar,
   * un venue devolviendo 503 para siempre ya no tumbaba el tick, así que el
   * cortacircuitos de `onTickError` no llegaba a contar nada. El bot se quedaba
   * EN MARCHA, reintentando en silencio, sin colocar una sola orden — el mismo
   * estado engañoso que todo esto venía a arreglar, solo que por el otro lado.
   *
   * Se reinicia en cuanto UNA colocación sale bien.
   */
  private placeFailures = 0;

  /**
   * ¿Confirmó el venue la ÚLTIMA colocación del stop loss?
   *
   * `protectionNote` solo miraba si el usuario había CONFIGURADO uno, y decía
   * «el stop loss sigue vivo en el exchange» aunque el venue lo hubiera
   * rechazado. Es exactamente lo que su propio comentario advierte que no debe
   * pasar: hacer creer a alguien que está protegido cuando no lo está.
   *
   * Empieza en `false` y solo lo pone a `true` un `confirmOrder`. Al revés
   * —suponer que está puesto hasta que se demuestre lo contrario— sería mentir
   * en la dirección peligrosa.
   */
  private stopLossVivo = false;

  constructor(private readonly deps: BotRunnerDeps) {
    this.paused = deps.startPaused === true;
    this.logger = new Logger(`Bot:${deps.bot.id.slice(0, 8)}`);
    this.strategy = getStrategy(deps.bot.strategy);
    this.isMarketMaker =
      deps.bot.strategy === 'MARKET_MAKER' || deps.bot.strategy === 'MARKET_MAKER_V2';
    this.encode = codecFor(deps.bot.venue).encode;
    this.config = deps.config;
    this.cycle = deps.cycle;
    this.market = deps.market;
  }

  get botId(): string {
    return this.deps.bot.id;
  }

  // ═══════════════════════════════════════════════════════════════
  // Cerrojo
  // ═══════════════════════════════════════════════════════════════

  /**
   * Serializa una operación contra las demás del mismo bot.
   *
   * La cola avanza aunque una operación falle: si un fallo la rompiera, el bot
   * dejaría de hacer nada para siempre sin ningún error visible. Es el mismo
   * cuidado que ya tenía el limitador de caudal, y por la misma razón.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.gate.then(fn);
    this.gate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // Ciclo de vida
  // ═══════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    const { adapter, bot } = this.deps;

    // El apalancamiento y el modo de margen se fijan ANTES del primer tick: en
    // Lighter y Aster son configuración on-chain o de cuenta, y una orden
    // enviada con el apalancamiento anterior abre una posición del tamaño
    // equivocado sin ningún aviso.
    await this.syncLeverage();

    // El modo de posición va junto al apalancamiento y por el mismo motivo: es
    // configuración de cuenta, no de orden. En modo cobertura una venta abre un
    // corto en paralelo al largo en vez de reducirlo, así que fijarlo DESPUÉS
    // de la primera orden significaría que esa orden hizo otra cosa.
    //
    // Solo Aster lo implementa; en Hyperliquid y Lighter `setPositionMode` no
    // existe y el bot arranca igual, con un aviso. Antes de esto el campo
    // estaba en el tipo y en el adaptador pero NADIE lo llamaba.
    // `AUTO` (o ausente) es «no lo toques»: se respeta el de la cuenta. Al
    // descartarlo, TypeScript deja exactamente `PositionMode`, que es lo único
    // que el adaptador sabe recibir.
    const positionMode = this.config.positionMode;
    if (positionMode && positionMode !== 'AUTO') {
      if (adapter.setPositionMode) {
        try {
          await adapter.setPositionMode(positionMode);
        } catch (e) {
          await this.event(
            'POSITION_MODE_SKIPPED',
            'WARN',
            `No se pudo fijar el modo de posición: ${(e as Error).message}`,
          );
        }
      } else {
        await this.event(
          'POSITION_MODE_SKIPPED',
          'WARN',
          `${bot.venue} no permite cambiar el modo de posición desde la API; se usa el de la cuenta.`,
        );
      }
    }

    this.fairFeedKey = this.acquireFairPrice();

    // Se retrocede una ventana al adoptar: si el bot venía de otro worker, las
    // ejecuciones de ese hueco no las vio nadie y hay que recogerlas.
    this.lastFillTs = Date.now() - FILL_BACKFILL_MS;

    this.subs.push(
      adapter.streamFills().subscribe({
        next: (fill) => void this.exclusive(() => this.onFill(fill)),
      }),
    );
    this.subs.push(
      adapter.streamOrders().subscribe({
        next: (order) => void this.onOrderUpdate(order),
      }),
    );
    this.subs.push(
      adapter.streamTicker(bot.symbol).subscribe({
        next: (t) => {
          this.lastTicker = t;
        },
      }),
    );
    this.subs.push(adapter.streamHealth().subscribe({ next: (h) => void this.onStreamHealth(h) }));

    if (this.paused) {
      // El estado NO se toca: sirve tanto para readoptar un bot pausado como
      // para adoptar uno en STOPPING, cuyo cierre aplica el supervisor justo
      // después. Escribir RUNNING aquí —que es lo que hace la rama de abajo—
      // habría BORRADO la petición de parada: el bot resucitaba en vez de
      // cerrarse.
      await this.event(
        'BOT_ADOPTED',
        'INFO',
        'Motor enganchado al venue; el bot conserva su estado.',
      );
    } else {
      await this.deps.store.setStatus(this.botId, 'RUNNING', {
        clearError: true,
      });
      await this.event('BOT_STARTED', 'INFO', 'Motor enganchado al venue.');
    }

    // Latido: el bucle NO depende de que lleguen eventos. Si el WebSocket se
    // cae en silencio —lo más común en un móvil o tras un proxy— el bot sigue
    // convergiendo por REST en cada latido.
    //
    // Con desfase inicial y jitter, y no es cosmético: todos los runners
    // adoptados en la misma ráfaga arrancaban su temporizador en el mismo
    // instante, así que mil bots golpeaban el venue a la vez cada quince
    // segundos y luego no lo tocaba nadie durante catorce.
    const period = this.deps.reconcileIntervalMs;
    this.startTimer = setTimeout(
      () => {
        this.startTimer = null;
        if (this.stopped) return;
        this.timer = setInterval(
          () => void this.exclusive(() => this.tick()),
          period + Math.floor((Math.random() - 0.5) * period * 0.2),
        );
      },
      Math.floor(Math.random() * period),
    );

    await this.exclusive(() => this.tick());
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    // El feed externo se suelta lo primero: es un contador de referencias
    // compartido y dejarlo colgado mantendría un sondeo vivo para siempre, el
    // mismo fallo que ya se corrigió en el feed de precios del venue.
    this.deps.priceSource?.release(this.fairFeedKey);
    this.fairFeedKey = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
    // Se espera al cerrojo antes de cerrar el adaptador: si hay un tick a
    // medias, cerrarle el transporte por debajo lo dejaría con una orden
    // mandada y sin acuse que registrar.
    await this.gate.catch(() => undefined);
    await this.deps.adapter.close().catch(() => undefined);
  }

  // ═══════════════════════════════════════════════════════════════
  // El tick
  // ═══════════════════════════════════════════════════════════════

  /**
   * Un tick: leer estado real → planificar → converger.
   *
   * Entra siempre por `exclusive()`, así que nunca se solapa con otro tick ni
   * con un comando. Solaparlos haría que dos planes vieran el mismo "falta esta
   * orden" y la colocaran dos veces.
   */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.ticks++;

    try {
      const { adapter, bot, store } = this.deps;

      // Las ejecuciones se incorporan ANTES de planificar: la estrategia decide
      // sobre la posición y el precio medio que resultan de ellas.
      await this.sweepFills();

      const cycleSeq = Number(this.cycle.scratch.cycleSeq ?? 0);
      const [ticker, positions, openOrders, balances, ownVenueIds] = await Promise.all([
        adapter.getTicker(bot.symbol),
        adapter.getPositions(bot.symbol),
        adapter.getOpenOrders(bot.symbol),
        adapter.getBalances(),
        // Los ids propios en espacio de venue, leídos de la base. Es la fuente
        // EXACTA: toda orden del motor se registró antes de salir hacia el
        // venue, así que un id que no esté aquí no es nuestro. Sin esto, en los
        // venues de id opaco había que reconstruir por fuerza bruta miles de
        // candidatos para reconocer una huérfana.
        store.ownVenueClientIds(this.botId, [cycleSeq, cycleSeq - 1]),
      ]);
      this.lastTicker = ticker;

      // Un venue que no da precio NO es un venue sobre el que planificar. La
      // escalera entera se ancla en el `mark`, asi que con un cero la
      // estrategia calcularia niveles a cero: el filtro de ordenes los
      // rechazaria uno a uno —comprueba `price.lte(0)`— pero el bot se pasaria
      // el rato tendiendo una escalera imposible sin decir por que.
      //
      // Se dice aqui y con el mismo mensaje que ya usa `currentTicker`, que
      // llevaba esta comprobacion desde siempre para los cierres a mercado. El
      // tick no la tenia.
      if (!D(ticker.mark).gt(0)) {
        throw new ExchangeError(
          'RETRYABLE',
          'El venue no devuelve precio para ' + bot.symbol,
          bot.venue,
        );
      }

      const position = positions[0] ?? null;

      // Solo en el primer tick tras adoptar, y con el barrido de ejecuciones ya
      // hecho: es el único momento en que el ciclo puede venir de un hueco que
      // nadie presenció.
      if (!this.startupChecked) {
        this.startupChecked = true;
        await this.checkCycleAgainstVenue(position);
      }

      await this.refreshMarketSpec();

      // Guardas de riesgo ANTES de planificar: si el bot debe pararse, no tiene
      // sentido calcular una escalera que no se va a tender.
      const breach = await this.checkRiskGuards(position, ticker);

      // Un bot pausado llega hasta aquí —vigila su posición y avisa si se acerca
      // la liquidación— pero no planifica ni toca el libro. Lo que ya está
      // pausado no se vuelve a pausar: solo se anota el snapshot y se sale.
      if (this.paused) {
        // Un bot pausado que llega hasta aquí está sano: ha hablado con el
        // venue. Sin marcarlo, el chequeo de salud lo daría por atascado.
        this.markTickOk();
        if (this.persistDue()) await this.snapshot(ticker, position, openOrders.length);
        return;
      }

      if (breach) {
        if (breach.action === 'CLOSE') {
          // Cerrar Y parar: dejarlo pausado con la posición abierta sería no
          // haber hecho nada, que es de lo que venimos.
          await this.event('RISK_GUARD_TRIPPED', 'CRITICAL', breach.reason, {
            action: 'CLOSE_ALL',
          });
          await this.runCommand('STOP_AND_CLOSE');
        } else {
          await this.pauseForRisk(breach.reason);
        }
        return;
      }

      const ctx = this.buildContext(ticker, position, openOrders, balances[0]?.available ?? '0');
      await this.warnIfFairPriceStale(ctx);
      const desired = this.withStopLoss(this.strategy.plan(ctx), position, cycleSeq);

      if (desired.scratchPatch) {
        this.cycle = {
          ...this.cycle,
          scratch: { ...this.cycle.scratch, ...desired.scratchPatch },
        };
        await store.saveCycleScratch(this.botId, this.cycle.scratch);
      }

      const plan = reconcile({
        botId: this.botId,
        cycleSeq,
        desired: desired.orders,
        actual: openOrders,
        market: this.market,
        encode: this.encode,
        // La fuente EXACTA de pertenencia: lo que este bot mandó de verdad,
        // leído de la base junto al resto del estado del tick.
        ownIds: new Set(ownVenueIds),
      });

      await this.execute(plan, desired);

      // «Acción al alcanzar el límite: apagar». La estrategia no puede parar el
      // bot —es una función pura—, así que lo pide por el scratch y el runner lo
      // traduce. Va DESPUÉS de ejecutar para que el cierre a mercado que la
      // propia estrategia encoló en `immediate` llegue a salir: pararse antes
      // dejaría la posición abierta, que es justo lo contrario de lo pedido.
      const requestedStop = desired.scratchPatch?.requestStop;
      if (requestedStop === 'STOP_KEEP_POSITION') {
        await this.runCommand('STOP_KEEP_POSITION');
        return;
      }

      // La nota es visible en la app, así que un cambio se escribe al momento —
      // pero comparando su FORMA, sin números. Varias notas llevan contadores
      // («faltan N s») que cambian en cada tick, y tomarlas al pie de la letra
      // convertía el ritmo de persistencia en papel mojado justo para los bots
      // en cooldown, que son los que menos tienen que contar.
      const note = desired.note ?? null;
      const noteChanged = gist(note) !== gist(this.lastNote);
      this.lastNote = note;
      await store.touchTick(this.botId, note, noteChanged || this.persistDue());
      if (noteChanged || this.persistDue()) {
        await this.snapshot(ticker, position, openOrders.length);
      }
      this.markTickOk();
    } catch (e) {
      await this.onTickError(e);
    }
  }

  /**
   * Pide un tick cuanto antes.
   *
   * No lo ejecuta aquí mismo, y no es un detalle: quien llama a esto suele
   * tener ya cogido el cerrojo del runner —un fill, un comando—, así que
   * ejecutar el tick en línea sería reentrar en el cerrojo propio y bloquearse
   * contra uno mismo para siempre. Se encola, y el cerrojo lo suelta cuando lo
   * que esté en curso termine.
   *
   * `tickScheduled` agrupa: veinte fills seguidos —un market maker en un
   * minuto movido— encolan UN tick, no veinte.
   */
  private requestTick(): void {
    if (this.stopped || this.tickScheduled) return;
    this.tickScheduled = true;
    setImmediate(() => {
      void this.exclusive(async () => {
        this.tickScheduled = false;
        await this.tick();
      });
    });
  }

  /**
   * Ejecuta la diferencia. El ORDEN importa:
   *
   *   1. Cancelar huérfanas — libera el margen que retienen.
   *   2. Reemplazar las que cambiaron — cancelar y volver a colocar.
   *   3. Colocar las que faltan — ya con margen disponible.
   *
   * Al revés, las órdenes nuevas competirían por margen que todavía está
   * inmovilizado en órdenes que van a desaparecer un instante después, y el
   * venue las rechazaría por saldo insuficiente.
   */
  private async execute(plan: ReconcilePlan, desired: DesiredState): Promise<void> {
    // Las entradas del plan de ESTE tick. Si la estrategia todavía quiere abrir
    // o aumentar, la posición puede crecer, y una salida por debajo del mínimo
    // es cuestión de esperar, no una avería.
    this.entradasVivas =
      desired.orders.some((o) => !o.reduceOnly) || desired.immediate.some((o) => !o.reduceOnly);

    const { adapter, bot, store } = this.deps;

    for (const order of plan.toCancel) {
      if (this.halted()) return;
      await this.safely('cancelar', order.clientOrderId ?? order.venueOrderId, async () => {
        await adapter.cancelOrder({
          symbol: bot.symbol,
          venueOrderId: order.venueOrderId,
          clientOrderId: order.clientOrderId ?? undefined,
        });
        await store.markOrderCanceled(bot.id, order.venueOrderId);
      });
    }

    for (const { existing, desired: want, reason } of plan.toReplace) {
      if (this.halted()) return;
      await this.safely('reemplazar', want.clientOrderId, async () => {
        await adapter.cancelOrder({
          symbol: bot.symbol,
          venueOrderId: existing.venueOrderId,
          clientOrderId: existing.clientOrderId ?? undefined,
        });
        await store.markOrderCanceled(bot.id, existing.venueOrderId);
        await this.place(want, `reemplazo (${reason})`, this.strategy.reusesOrderSlots === true);
      });
    }

    // Las órdenes RECONCILIADAS de una estrategia que reutiliza ids pueden
    // recolocar un id ya ejecutado: la estrategia se compromete a desearlo
    // solo cuando toca. Las inmediatas, NUNCA — ver el envío de inmediatas.
    const allowRefill = this.strategy.reusesOrderSlots === true;

    for (const order of plan.toPlace) {
      if (this.halted()) return;
      await this.place(order, 'nueva', allowRefill);
    }

    // Las inmediatas (entrada base a mercado, cierre por stop) no se
    // reconcilian: se mandan una vez. La idempotencia la da el clientOrderId,
    // que `place()` comprueba contra la base antes de enviar nada — y para
    // ellas una fila YA EJECUTADA veta siempre: es la red que impide duplicar
    // una compra a mercado cuyo fill aún no se ha asimilado al ciclo.
    for (const order of desired.immediate) {
      if (this.halted()) return;
      await this.place(order, 'inmediata');
    }
  }

  /**
   * ¿Ha dejado de tener sentido seguir colocando?
   *
   * Se comprueba ENTRE órdenes. Un PANIC no puede interrumpir la que ya está en
   * vuelo, pero sí tiene que impedir la siguiente: sin esto, el bucle terminaba
   * de tender la escalera entera después de que el usuario hubiera pedido
   * cerrarlo todo.
   */
  private halted(): boolean {
    return this.stopped || this.paused;
  }

  /**
   * Coloca una orden con garantía de no duplicar.
   *
   * La fila en `bot_orders` se escribe ANTES de llamar al venue. Si el proceso
   * muere justo entre ambas cosas, al reiniciar veremos una orden PENDING sin
   * id de venue y la reconciliación decidirá qué hacer con ella; lo que NO
   * puede pasar es mandar la orden y no tener constancia de haberlo hecho.
   */
  private async place(
    order: DesiredOrder,
    motivo: string,
    allowRefill = false,
    /**
     * Fuerza el veredicto de «la posición ya no va a crecer».
     *
     * Lo usa el cierre manual y el PANIC. Sin esto se leería `entradasVivas` del
     * ÚLTIMO TICK, y un usuario que pulsa «cerrar posición» sobre un resto por
     * debajo del mínimo recibiría «espera a que entren más ejecuciones» — que es
     * lo contrario de lo que ha pedido, y encima el cierre no ocurriría. Quien
     * pulsa ese botón quiere salir ahora y merece saber por qué no puede.
     */
    salidaDefinitiva = false,
    /**
     * Segundo intento inmediato de un STOP_LOSS tras un fallo pasajero
     * (001/F-35). Solo lo pone la propia función: acota la recursión a uno.
     */
    reintentoDeStop = false,
  ): Promise<OrderAck | null> {
    const { adapter, bot, store } = this.deps;
    const seq = Number(this.cycle.scratch.cycleSeq ?? 0);
    const shape = this.shapeOf(order);

    // Ya rechazado con esta forma exacta: no se vuelve a mandar. Si la escalera
    // cambia de precio o cantidad, la forma cambia y sí se reintenta. Un cierre
    // pedido a mano se salta la cuarentena: quien repite «parar y cerrar» tras
    // un rechazo quiere que se vuelva a intentar, no un silencio.
    if (!salidaDefinitiva && this.quarantine.get(order.clientOrderId) === shape) return null;

    // Las reglas del venue se comprueban AQUÍ, no solo en el preview.
    // `normalizeOrder` ya existía y ya devolvía los motivos, pero solo la usaba
    // el asistente de creación: en ejecución se mandaban niveles por debajo del
    // mínimo del venue y el rechazo llegaba de allí, tick tras tick.
    //
    // Las reduce-only —cierres, take profit, stops— TAMBIÉN pasan por aquí, y
    // eso es nuevo. Antes se mandaban a ciegas, razonando que varios venues las
    // aceptan por debajo del mínimo para poder cerrar restos. Lighter no: su
    // rechazo («invalid order base or quote amount») es lo que pausaba bots
    // enteros. Pero el razonamiento original no era malo, así que la salida no
    // se veta sin más: se distingue POR QUÉ no cumple. Ver `revisarOrden`.
    // El stop se mide al precio de MARCA, no al de disparo (001/F-91): ver la
    // firma de `revisarOrden`.
    const veredicto = revisarOrden(
      this.market,
      order,
      this.entradasVivas && !salidaDefinitiva,
      this.lastTicker?.mark,
    );
    if (veredicto.motivo !== 'OK') {
      if (order.levelKind === 'STOP_LOSS') this.stopLossVivo = false;
      // Cuarentena por FORMA, no por id: en cuanto entre otra ejecución la
      // cantidad cambia, la forma cambia y se vuelve a intentar sola. Es lo que
      // hace que esto se cure sin intervención. El stop loss no entra: ver
      // `cuarentena`.
      this.cuarentena(order, shape);
      const severidad = this.severidadDeRechazo(order, shape, veredicto.severidad);
      if (severidad) {
        await this.event(
          veredicto.tipo,
          severidad,
          veredicto.mensaje + (order.levelKind === 'STOP_LOSS' ? this.protectionNote : ''),
          { clientOrderId: order.clientOrderId, qty: order.qty, price: order.price },
        );
      }
      return null;
    }

    // ¿Existe ya una fila con este id? Viva (pendiente, abierta, parcial) veta
    // SIEMPRE: recolocarla duplicaría lo que ya está en el libro. EJECUTADA
    // veta salvo que la estrategia reutilice ids: para un market maker o una
    // retícula, «ejecutada» significa que el hueco quedó libre y la siguiente
    // colocación del mismo id es una orden nueva a todos los efectos. Sin esta
    // distinción, cada cotización moría tras su primera ejecución y no volvía
    // hasta que la posición pasara por cero.
    const already = await store.findOrderByCoid(order.clientOrderId);
    if (already && already.status !== 'CANCELED' && already.status !== 'REJECTED') {
      if (!(allowRefill && already.status === 'FILLED')) {
        if (!this.pendienteVencida(already)) {
          return null; // Ya existe: un reintento no debe duplicarla.
        }
        // Una PENDING sin id de venue y con más de `PENDING_ORPHAN_MS` es una
        // orden que quizá nunca llegó: el proceso murió entre la fila y el
        // acuse, o el acuse no se pudo anotar. Vetarla para siempre dejaba el
        // nivel —una entrada base, incluso— muerto en silencio (001/F-37). Se
        // da por no enviada y el nivel vuelve a intentarse; si la orden sí
        // existiera, su id de venue sigue registrado como propio y la
        // reconciliación la reconoce igual.
        await store.rejectOrder(order.clientOrderId, 'PENDING sin acuse vencida');
        await this.event(
          'ORDER_RETRY',
          'INFO',
          `${order.levelKind}#${order.levelIndex} llevaba más de ${PENDING_ORPHAN_MS / 60_000} min ` +
            `pendiente sin acuse del exchange: se vuelve a intentar.`,
          { clientOrderId: order.clientOrderId },
        );
      }
    }

    await store.upsertPendingOrder({
      botId: this.botId,
      cycleSeq: seq,
      order,
      venueClientId: this.encode(order.clientOrderId),
    });

    // El acuse se devuelve para que quien coloca un cierre sepa si SALIÓ: un
    // `STOP_AND_CLOSE` que no puede saberlo afirmaba «cerrada» sin mirar.
    let ack: OrderAck | null = null;
    try {
      ack = await adapter.placeOrder({
        symbol: bot.symbol,
        side: order.side,
        type: order.type,
        price: order.price,
        qty: order.qty,
        clientOrderId: order.clientOrderId,
        reduceOnly: order.reduceOnly,
        timeInForce: order.timeInForce,
        triggerPrice: order.triggerPrice,
        // El sentido del disparo viaja EXPLÍCITO: el adaptador no puede
        // deducirlo del lado y el reduce-only, y deducirlo mal invierte la
        // condición de disparo (un stop-loss etiquetado como take-profit se
        // ejecuta al instante).
        intent: order.levelKind === 'TAKE_PROFIT' ? 'TP' : 'SL',
      });
    } catch (e) {
      const err = e as ExchangeError;
      if (order.levelKind === 'STOP_LOSS') this.stopLossVivo = false;
      await store.rejectOrder(order.clientOrderId, err.message);

      // Un rechazo por reglas es información, no una avería: suele significar
      // que el nivel cae por debajo del mínimo del venue. Se registra UNA vez y
      // el bot sigue con el resto de la escalera.
      if (err.kind === 'RULES') {
        this.cuarentena(order, shape);
        const severidad = this.severidadDeRechazo(order, shape, 'WARN');
        if (severidad) {
          await this.event(
            'ORDER_REJECTED',
            severidad,
            `${order.levelKind}#${order.levelIndex} ${order.side} ${order.qty} @ ${order.price} ` +
              `rechazada (${motivo}): ${err.message}` +
              (order.levelKind === 'STOP_LOSS' ? this.protectionNote : ''),
            { clientOrderId: order.clientOrderId },
          );
        }
        return null;
      }
      if (err.kind === 'INSUFFICIENT_FUNDS') {
        this.cuarentena(order, shape);
        const severidad = this.severidadDeRechazo(order, shape, 'ERROR');
        if (severidad) {
          await this.event(
            'INSUFFICIENT_FUNDS',
            severidad,
            `Sin margen para ${order.levelKind}#${order.levelIndex}. La escalera queda incompleta.` +
              (order.levelKind === 'STOP_LOSS' ? this.protectionNote : ''),
          );
        }
        return null;
      }

      // Solo estas dos relanzan, y por motivos distintos: con la credencial
      // muerta no hay nada que hacer salvo parar y avisar, y si el venue nos ha
      // cortado el grifo hay que dejar de insistir — es justo lo que alarga el
      // castigo.
      if (err.kind === 'AUTH' || err.kind === 'THROTTLED') throw e;

      // Un fallo pasajero NO va a cuarentena: se avisa y se reintenta en el
      // siguiente tick. Meterlo con los demás dejaría un nivel de la escalera
      // caído para siempre por un corte de red de dos segundos, porque la
      // cuarentena solo se levanta si cambia la forma de la orden.
      if (err.kind === 'RETRYABLE') {
        // La red de la posición no espera al siguiente tick (001/F-35): un corte
        // pasajero al reponer el stop dejaba la posición sin red hasta que el
        // motor volviera a pasar —quince segundos, o lo que durase el corte— y
        // lo contaba en INFO. Se reintenta ya, una vez; si tampoco sale, se dice
        // en CRITICAL, que es lo que es: una posición apalancada sin stop.
        if (order.levelKind === 'STOP_LOSS' && !reintentoDeStop) {
          const otra = await this.place(
            order,
            `${motivo}, reintento`,
            allowRefill,
            salidaDefinitiva,
            true,
          );
          if (!otra) {
            await this.event(
              'ORDER_REJECTED',
              'CRITICAL',
              `STOP_LOSS#${order.levelIndex} no se pudo colocar ni al reintentar ` +
                `(${err.message}). La posición queda SIN stop hasta la siguiente revisión.`,
              { clientOrderId: order.clientOrderId, kind: err.kind },
            );
          }
          return otra;
        }
        // INFO y no WARN: un corte de red que se cura solo no tiene por qué
        // sonar en el Telegram de nadie. Queda en la bitácora del bot.
        await this.event(
          'ORDER_RETRY',
          'INFO',
          `${order.levelKind}#${order.levelIndex} no salió (${err.message}). Se reintenta.`,
          { clientOrderId: order.clientOrderId },
        );
        // Pero un fallo pasajero que no se cura NUNCA deja de ser pasajero solo
        // porque lo llamemos así. Sin este tope, el bot reintentaría en silencio
        // para siempre.
        if (++this.placeFailures >= MAX_PLACE_FAILURES && !this.paused) {
          await this.pauseForRisk(
            `${this.placeFailures} colocaciones seguidas sin salir (última: ${err.message})`,
          ).catch(() => undefined);
        }
        return null;
      }

      // TODO LO DEMÁS SE CONTIENE. Antes se relanzaba, y por eso un rechazo de
      // UNA orden mataba el tick entero: el resto de la escalera no llegaba a
      // colocarse, y cinco ticks así disparaban el cortacircuitos y pausaban el
      // bot con la posición abierta. El caso real fue un mensaje de Lighter que
      // el clasificador no conocía y cayó en FATAL.
      //
      // La lista de mensajes conocidos nunca va a estar completa —cada venue
      // nombra lo mismo distinto—, así que la red no puede ser esa lista: es
      // esto. Se registra en ERROR, con el detalle, y el bot sigue vivo.
      this.cuarentena(order, shape);
      const severidad = this.severidadDeRechazo(order, shape, 'ERROR');
      if (severidad) {
        await this.event(
          'ORDER_REJECTED',
          severidad,
          `${order.levelKind}#${order.levelIndex} ${order.side} ${order.qty} @ ${order.price} ` +
            `rechazada por el exchange (${motivo}): ${err.message}` +
            (order.levelKind === 'STOP_LOSS' ? this.protectionNote : ''),
          { clientOrderId: order.clientOrderId, kind: err.kind },
        );
      }
      return null;
    }
    if (!ack) return null;

    // Acuse positivo: la orden EXISTE en el venue, pase lo que pase con la base.
    await this.anotarAcuse(order, ack);
    this.quarantine.delete(order.clientOrderId);
    this.placeFailures = 0;
    if (order.levelKind === 'STOP_LOSS') {
      this.stopLossVivo = true;
      // Colocado: el siguiente rechazo, si lo hay, vuelve a merecer su aviso.
      this.stopRechazoAvisado = null;
    }
    return ack;
  }

  /**
   * Anota el acuse del venue en la fila de la orden.
   *
   * Fuera del `try` de la llamada al venue a propósito (001/F-36): antes un
   * fallo de la base al anotar el acuse caía en el mismo `catch` que un rechazo
   * del venue y la fila acababa REJECTED con la orden VIVA en el libro —
   * invisible para PAUSE, para PANIC y para la cancelación acotada al bot, que
   * leen las filas vivas. Se reintenta una vez y, si tampoco, la fila queda
   * PENDING (la reconciliación la reconoce por su id de venue) y se avisa.
   */
  private async anotarAcuse(order: DesiredOrder, ack: OrderAck): Promise<void> {
    const { store } = this.deps;
    try {
      await store.confirmOrder(order.clientOrderId, ack);
    } catch {
      try {
        await store.confirmOrder(order.clientOrderId, ack);
      } catch (e) {
        await this.event(
          'ACTION_FAILED',
          'WARN',
          `${order.levelKind}#${order.levelIndex} fue aceptada por el exchange ` +
            `(${ack.venueOrderId}) pero no se pudo anotar en la base: ${(e as Error).message}. ` +
            `La fila queda pendiente hasta la siguiente reconciliación.`,
          { clientOrderId: order.clientOrderId, venueOrderId: ack.venueOrderId },
        );
      }
    }
  }

  /** Una fila PENDING sin id de venue que lleva demasiado sin acuse (001/F-37). */
  private pendienteVencida(row: {
    status: string;
    venue_order_id: string | null;
    updated_at: Date;
  }): boolean {
    return (
      row.status === 'PENDING' &&
      !row.venue_order_id &&
      Date.now() - row.updated_at.getTime() > PENDING_ORPHAN_MS
    );
  }

  /** Identidad de una orden a efectos de cuarentena: si cambia, se reintenta. */
  private shapeOf(order: DesiredOrder): string {
    return `${order.side}:${order.type}:${order.price}:${order.qty}`;
  }

  /**
   * Un rechazo que NO se va a reintentar hasta que cambie la forma… salvo que
   * sea el stop loss. Antes el stop pasaba por las mismas puertas que un nivel
   * cualquiera: rechazado por reglas o vetado por el mínimo del venue, su id
   * entraba aquí con su forma, y como precio y cantidad salen de la posición,
   * la forma no cambiaba mientras la posición no cambiara: posición apalancada
   * sin red, indefinidamente, con un INFO o un WARN en la bitácora (001/F-32).
   */
  private cuarentena(order: DesiredOrder, shape: string): void {
    if (order.levelKind === 'STOP_LOSS') return;
    this.quarantine.set(order.clientOrderId, shape);
  }

  /**
   * Severidad de un rechazo: la del veredicto o del error, salvo para el stop
   * loss, que es SIEMPRE crítica —es la red de la posición— y va con la
   * coletilla que dice en voz alta que no consta colocado. Devuelve `null` si
   * ese mismo rechazo del stop ya se anunció con esta forma: se sigue
   * reintentando, pero en silencio.
   */
  private severidadDeRechazo(
    order: DesiredOrder,
    shape: string,
    severidad: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL',
  ): 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL' | null {
    if (order.levelKind !== 'STOP_LOSS') return severidad;
    if (this.stopRechazoAvisado === shape) return null;
    this.stopRechazoAvisado = shape;
    return 'CRITICAL';
  }

  // ═══════════════════════════════════════════════════════════════
  // Eventos del venue
  // ═══════════════════════════════════════════════════════════════

  /**
   * Una ejecución. El ledger deduplica por `venue_fill_id`, así que reprocesar
   * el mismo mensaje —cosa que pasa en cada reconexión del WebSocket y en cada
   * barrido por REST— no contabiliza la operación dos veces.
   *
   * Llega SIEMPRE bajo el cerrojo del runner. Antes no: dos ejecuciones
   * seguidas —lo normal en un market maker— entraban a la vez en
   * `applyFillToCycle`, leían el mismo ciclo, calculaban desde la misma
   * cantidad previa y escribían las dos. Se perdía una actualización, y con
   * ella la cantidad, el precio medio y el PnL quedaban mal.
   */
  private async onFill(fill: Fill): Promise<void> {
    if (this.stopped) return;
    try {
      const coid = await this.deps.store.recordFill(this.botId, fill);
      // La ventana del barrido por REST solo avanza con fills de NUESTRO
      // símbolo. El stream es de la cuenta entera: dejar que la ejecución de un
      // bot hermano (otro símbolo) la adelantara haría que el barrido se
      // saltara ejecuciones nuestras aún no vistas.
      if (fill.symbol === this.deps.bot.symbol && fill.ts > this.lastFillTs) {
        this.lastFillTs = fill.ts;
      }
      // Una LIQUIDACIÓN no lleva id de orden nuestra —la puso el venue, no
      // nosotros— así que `recordFill` no la reconoce. Es el único caso en el
      // que se atribuye por SÍMBOLO, y hacen falta las tres condiciones:
      //
      // · La MARCA. Sin ella no se entra aquí, así que una ejecución que
      //   simplemente no reconocemos sigue sin tocar la contabilidad de nadie.
      // · El SÍMBOLO. El stream es de la cuenta entera; sin esto un bot se
      //   colgaría la liquidación de su hermano.
      // · Y que este bot CREA tener posición (`averageEntry`). Es lo que
      //   distingue nuestra liquidación de la de una posición que el usuario
      //   abrió a mano en el mismo par: sin esta condición, a un bot plano se le
      //   metía en el ciclo una posición que nunca tuvo y encima se le pausaba.
      const liquidacion =
        !coid &&
        fill.liquidation === true &&
        fill.symbol === this.deps.bot.symbol &&
        this.cycle.averageEntry != null;
      const id = liquidacion
        ? await this.deps.store.recordLiquidation(
            this.botId,
            fill,
            Number(this.cycle.scratch.cycleSeq ?? 0),
          )
        : coid;

      if (!id) return; // duplicado, o la ejecución no es de este bot

      // A partir de aquí el fill lleva el id CANÓNICO. El venue lo entrega en su
      // propio espacio —hash o entero— y ni la contabilidad del ciclo ni la
      // memoria de la estrategia saben leer eso; el ledger ya resolvió la fila.
      const ours: Fill = { ...fill, clientOrderId: id };

      const before = this.cycle.scratch.cycleSeq;
      this.cycle = await this.deps.store.applyFillToCycle(this.botId, this.cycle, ours, {
        recycleLevelOnExit: this.strategy.recycleLevelOnExit === true,
        trackMmStats: this.isMarketMaker,
        // De la configuración VIGENTE, no del scratch de la primera fila del
        // ciclo: es un campo HOT, y una recarga que no llega aquí se anuncia
        // como aplicada sin serlo (001/F-86). El backtest ya lo lee así.
        cooldownMinutes: Number(this.config.cooldownMinutes ?? 0),
      });
      // Ciclo nuevo: los rechazos del anterior ya no significan nada.
      if (this.cycle.scratch.cycleSeq !== before) this.quarantine.clear();

      // La estrategia solo interviene si tiene memoria propia (las recompras de
      // GridMart). Lo genérico —entradas, niveles llenos, precio medio— ya lo
      // ha actualizado el store. Si aún no hay ticker —ejecuciones repuestas
      // nada más adoptar—, se intenta conseguir uno: saltarse este paso pierde
      // la memoria de la estrategia para ese fill.
      if (this.strategy.onFill) {
        const ticker = this.lastTicker ?? (await this.currentTicker().catch(() => null));
        if (ticker) {
          const ctx = this.buildContext(ticker, null, [], '0');
          this.cycle = this.strategy.onFill(ctx, ours, this.cycle);
          await this.deps.store.saveCycleScratch(this.botId, this.cycle.scratch);
        }
      }

      if (liquidacion) {
        await this.afterLiquidation(fill);
        return;
      }

      await this.event('FILL', 'INFO', `${fill.side} ${fill.qty} @ ${fill.price}`, {
        clientOrderId: id,
        fee: fill.fee,
      });

      // Reconciliar tras el fill: el estado deseado casi siempre cambia (sube
      // el take profit, se libera un nivel), y esperar al latido dejaría al bot
      // con una escalera desactualizada durante segundos.
      this.requestTick();
    } catch (e) {
      this.logger.error(`Error procesando fill: ${(e as Error).message}`);
    }
  }

  /**
   * Recoger los pedazos después de una liquidación.
   *
   * El venue se ha llevado la posición Y las órdenes en reposo: dejarlas `OPEN`
   * en la base haría que el reconciliador persiguiera fantasmas en cada latido.
   *
   * Y el bot se PAUSA. Es una decisión, no una consecuencia técnica: la
   * liquidación significa que las guardas de riesgo no llegaron a tiempo, y
   * volver a entrar solo puede decidirlo el usuario. Sin esto una martingala
   * abre un ciclo nuevo en el tick siguiente y se liquida otra vez, y otra,
   * hasta fundir el saldo mientras nadie mira.
   */
  private async afterLiquidation(fill: Fill): Promise<void> {
    const yaAvisado = this.liquidationAnnounced;
    this.liquidationAnnounced = true;
    this.paused = true;

    // ¿Se ha llevado la posición ENTERA? Hyperliquid y Aster liquidan por
    // partes: cierran lo justo para restablecer el margen y dejan el resto
    // abierto, y de eso depende si el stop loss se retira o se conserva.
    //
    // Lo decide el VENUE, no el ciclo. El ciclo puede haber derivado —un hueco
    // de ejecuciones que nadie ingirió— y entonces una liquidación mayor que lo
    // que él cree tener le da la vuelta a la posición en sus libros: creería que
    // sigue abierta, informaría de una liquidación «parcial» que no lo fue y
    // dejaría vivo un stop sobre una posición fantasma. Es una petición de más
    // en un evento que ocurre casi nunca.
    //
    // Si el venue no contesta se tira del ciclo, que es lo único que queda.
    const plana = await this.deps.adapter
      .getPositions(this.deps.bot.symbol)
      .then((ps) => {
        const abierta = ps.find((p) => !D(p.qty).isZero());
        return !abierta;
      })
      .catch(() => this.cycle.averageEntry == null);

    // Se cancela contra el VENUE, no solo en la base. Marcar la base ANTES
    // dejaba `liveOrderCoids` vacío y la cancelación no salía nunca: la base
    // decía «canceladas» y el libro seguía teniéndolas.
    //
    // El stop loss se conserva mientras quede posición, que es la misma regla
    // que aplica `pauseForRisk`: con el bot pausado deja de planificar, así que
    // el stop es la única defensa que le queda a lo que no se liquidó. Solo se
    // retira cuando ya no hay nada que defender, porque entonces es una orden
    // suelta esperando a dispararse sola.
    await this.cancelOwnOrders(!plana);

    // Una liquidación puede llegar troceada en varias ejecuciones. Cada una se
    // contabiliza —son cambios de posición reales— pero el aviso y la pausa se
    // dan UNA vez: si no, el usuario recibe cuatro mensajes críticos seguidos
    // por un solo episodio.
    //
    // El testigo es propio y no `this.paused`, que es lo que había: un bot que
    // ya estaba pausado —por una guarda de riesgo, por el usuario, o adoptado en
    // pausa— se quedaba sin el aviso de que lo habían liquidado. Y una guarda de
    // riesgo saltando es precisamente lo que suele preceder a una liquidación,
    // así que era el caso en el que más falta hace.
    if (yaAvisado) return;

    const motivo = plana
      ? 'Posición liquidada por el venue.'
      : 'El venue ha liquidado parte de la posición.';

    await this.deps.store.setStatus(this.botId, 'PAUSED', { error: motivo });

    await this.event(
      'LIQUIDATED',
      'CRITICAL',
      `${motivo} ${fill.qty} @ ${fill.price}. El bot queda en pausa` +
        (plana ? '.' : ', con el resto de la posición abierta y su stop en pie.'),
      { price: fill.price, qty: fill.qty, partial: !plana, realizedPnl: this.cycle.realizedPnlAcc },
    );
  }

  /**
   * Recoge por REST las ejecuciones que el stream no haya traído.
   *
   * Es lo que hace CIERTA la promesa de «si el stream se cae, se sigue por
   * REST». Antes esa frase estaba en un comentario pero no en el código: el
   * camino REST leía posiciones y órdenes, nunca ejecuciones, así que un stream
   * caído congelaba la contabilidad del ciclo entera sin ningún síntoma
   * visible: ni precio medio, ni PnL, ni cierre de ciclo.
   */
  private async sweepFills(force = false): Promise<void> {
    const toca = force || !this.fillsHealthy || this.ticks % FILL_SWEEP_EVERY_TICKS === 1;
    if (!toca) return;

    try {
      // Un segundo de solape para no perder una ejecución por el redondeo del
      // reloj del venue. Reprocesar es gratis: el ledger deduplica.
      const fills = await this.deps.adapter.getRecentFills(
        this.deps.bot.symbol,
        Math.max(0, this.lastFillTs - 1000),
      );
      for (const fill of fills) await this.onFill(fill);
    } catch (e) {
      this.logger.warn(`Barrido de ejecuciones fallido: ${(e as Error).message}`);
    }
  }

  private async onOrderUpdate(order: VenueOrder): Promise<void> {
    if (this.stopped) return;
    await this.deps.store.syncOrderState(this.deps.bot.id, order).catch(() => undefined);
  }

  /**
   * Salud de los streams.
   *
   * Un stream caído NO para el bot: el latido sigue reconciliando y —ahora sí—
   * recogiendo ejecuciones por REST. Llega por un canal aparte porque antes el
   * fallo se propagaba con `error()` sobre los propios flujos de datos, y un
   * flujo con error queda cerrado para siempre: el bot no volvía a ver un fill
   * aunque el socket se recuperase.
   */
  private async onStreamHealth(h: {
    stream: string;
    status: string;
    detail?: string;
  }): Promise<void> {
    if (this.stopped) return;
    if (h.stream === 'fills') this.fillsHealthy = h.status === 'UP';
    if (h.status === 'UP') return;

    await this.event(
      'STREAM_ERROR',
      'WARN',
      `Stream de ${h.stream} caído: ${h.detail ?? 'sin detalle'}. Se sigue reconciliando y recogiendo ejecuciones por REST.`,
    ).catch(() => undefined);
  }

  // ═══════════════════════════════════════════════════════════════
  // Comandos
  // ═══════════════════════════════════════════════════════════════

  /** Punto de entrada público: serializa el comando contra los ticks. */
  handleCommand(command: RunnerCommand, payload?: unknown): Promise<void> {
    return this.exclusive(() => this.runCommand(command, payload));
  }

  private async runCommand(command: RunnerCommand, payload?: unknown): Promise<void> {
    const { store } = this.deps;
    this.logger.log(`Comando ${command}`);
    // Un comando terminal suelta el bot al acabar… salvo que no haya podido
    // hacer lo que prometía: un cierre que no sale deja el bot PAUSADO y
    // vigilando, no suelto (001/F-33).
    let soltar = TERMINAL_COMMANDS.has(command);

    switch (command) {
      case 'PAUSE':
        // Cancela órdenes pero MANTIENE la posición: pausar no es cerrar. El
        // stop loss se queda por eso mismo — es lo único que protege a lo que
        // sigue abierto mientras el bot no planifica.
        this.paused = true;
        await this.cancelOwnOrders(true);
        await store.setStatus(this.botId, 'PAUSED');
        await this.event(
          'BOT_PAUSED',
          'INFO',
          'Bot pausado: órdenes canceladas, posición intacta.' + this.protectionNote,
        );
        break;

      case 'RESUME':
        this.paused = false;
        // Se rearma el aviso de liquidación: reanudar cierra el episodio
        // anterior. Sin esto, un bot al que liquidan por segunda vez se pausaba
        // en memoria pero ni actualizaba su estado ni avisaba — la pantalla
        // seguía diciendo RUNNING sobre un bot que ya no operaba.
        this.liquidationAnnounced = false;
        await store.setStatus(this.botId, 'RUNNING', { clearError: true });
        await this.event('BOT_RESUMED', 'INFO', 'Bot reanudado: se vuelve a tender la escalera.');
        this.requestTick();
        break;

      case 'CANCEL_ALL_ORDERS':
        await this.cancelOwnOrders();
        await this.event('ORDERS_CANCELED', 'INFO', 'Órdenes canceladas a petición del usuario.');
        break;

      case 'STOP_KEEP_POSITION':
        this.paused = true;
        await this.cancelOwnOrders(true);
        await store.setStatus(this.botId, 'STOPPED');
        await this.event(
          'BOT_STOPPED',
          'INFO',
          'Bot parado. La posición sigue abierta.' + this.protectionNote,
        );
        break;

      case 'STOP_AND_CLOSE':
      case 'PANIC': {
        this.paused = true;
        const motivo = command === 'PANIC' ? 'pánico' : 'parada con cierre';
        // Primero se retira la escalera CONSERVANDO el stop —libera el margen
        // que retenía sin dejar la posición desnuda—, después se manda el
        // cierre, y solo con el cierre fuera se cancela también el stop. Antes
        // el orden era el contrario y el evento afirmaba «cerrada a mercado» sin
        // mirar el acuse: si el venue rechazaba el cierre, el usuario pulsaba el
        // botón rojo y se quedaba con la posición abierta, sin red y con el bot
        // en STOPPED diciendo lo contrario (001/F-33).
        await this.cancelOwnOrders(true);
        const cerrada = await this.closePositionAtMarket(motivo);
        if (cerrada) {
          await this.cancelOwnOrders();
          await store.setStatus(this.botId, 'STOPPED');
          await this.event(
            command === 'PANIC' ? 'PANIC' : 'BOT_STOPPED',
            'WARN',
            'Bot parado y posición cerrada a mercado.',
          );
        } else {
          // Sin cierre no hay parada: el bot se queda PAUSADO, vigilando la
          // liquidación, con el stop donde estaba, y se dice en CRITICAL.
          soltar = false;
          await store.setStatus(this.botId, 'PAUSED', {
            error: `No se pudo cerrar la posición (${motivo})`,
          });
          await this.event(
            'ACTION_FAILED',
            'CRITICAL',
            `No se pudo cerrar la posición a mercado (${motivo}): el exchange no aceptó el ` +
              `cierre. El bot queda PAUSADO con la posición abierta; repite la orden o ` +
              `ciérrala desde el exchange.` +
              this.protectionNote,
          );
        }
        break;
      }

      case 'CLOSE_NOW':
        await this.closePositionAtMarket('cierre manual');
        this.requestTick();
        break;

      case 'TAKE_PROFIT_NOW':
        await this.closePositionAtMarket('take profit manual');
        this.requestTick();
        break;

      case 'ADJUST_MARGIN':
        await this.adjustMargin(payload);
        this.requestTick();
        break;

      case 'REANCHOR_GRID': {
        // Solo en las escaleras; en el resto se dice por qué no y qué hacer en
        // su lugar, en vez de fingir un recentrado (ver REANCHOR_NO_APLICA).
        const noAplica = REANCHOR_NO_APLICA[this.strategy.kind];
        if (noAplica) {
          await this.event(
            'ACTION_FAILED',
            'WARN',
            `«Recentrar la retícula» no aplica a esta estrategia: ${noAplica}`,
          );
          break;
        }
        // Recentrar = olvidar el ancla y los niveles ya ejecutados. La escalera
        // se vuelve a colgar del precio actual en el siguiente tick.
        const mark = await this.markPrice();
        this.cycle = {
          ...this.cycle,
          anchorPrice: mark,
          filledLevelIndexes: [],
        };
        await store.saveCycleAnchor(this.botId, mark, []);
        // El stop loss no depende del ancla sino del precio medio, así que
        // recentrar no es motivo para retirarlo ni un tick.
        await this.cancelOwnOrders(true);
        this.quarantine.clear();
        // Lo que se compromete va en el aviso: la escalera ENTERA se vuelve a
        // tender bajo el precio nuevo con la posición anterior aún abierta, y
        // ese margen no lo enseñó ninguna vista previa. La API ya exige
        // confirmar antes de encolarlo; esto es la constancia en la bitácora.
        const pos = await this.currentPosition();
        const abierta = pos
          ? ` además de la posición abierta (${pos.qty} ${this.market.base})`
          : '';
        await this.event(
          'GRID_REANCHORED',
          'INFO',
          `Retícula recentrada en ${mark}: la escalera entera se vuelve a tender bajo este precio ` +
            `y compromete hasta ${this.config.totalInvestment} ${this.market.quote} de margen${abierta}.`,
        );
        this.requestTick();
        break;
      }

      case 'REPAIR': {
        // Resincronizar, no arreglar a mano. La reconciliación ya converge sola
        // en el siguiente tick; lo que aporta este comando es no tener que
        // esperarlo y, sobre todo, tirar las cachés de un segundo del
        // `AccountHandle` y rebarrer las ejecuciones por REST, que es lo que
        // hace falta cuando lo que se ha descuadrado es el estado LEÍDO y no el
        // libro. No cancela ni cierra nada: por eso no pide confirmación.
        this.quarantine.clear();
        // Se retrocede la ventana y se barre AQUÍ mismo, en vez de marcar el
        // stream como caído para que lo haga el tick. Marcarlo dejaba
        // `fillsHealthy` en false para siempre: la salud solo se actualiza
        // cuando LLEGA un evento del stream, y si el stream ya estaba sano no
        // llega ninguno — el bot se quedaba barriendo por REST en cada tick.
        this.lastFillTs = Math.max(0, Date.now() - FILL_BACKFILL_MS);
        await this.sweepFills(true);
        this.cycle = await store.ensureCycle(this.botId, Number(this.config.cooldownMinutes ?? 0));
        await this.event(
          'BOT_REPAIRED',
          'INFO',
          'Estado resincronizado con el exchange: posición, órdenes y ejecuciones releídas.',
        );
        this.requestTick();
        break;
      }

      case 'ADD_SAFETY_NOW': {
        // Adelanta la siguiente seguridad ejecutándola a mercado. Útil cuando
        // el usuario quiere promediar sin esperar a que el precio llegue.
        const ticker = await this.currentTicker();
        const ctx = this.buildContext(ticker, await this.currentPosition(), [], '0');
        const desired = this.strategy.plan(ctx);
        const next = desired.orders.find((o) => o.levelKind === 'SAFETY');
        if (!next) {
          await this.event(
            'ADD_SAFETY_SKIPPED',
            'WARN',
            'No queda ninguna orden de seguridad pendiente.',
          );
          break;
        }
        // Al precio de MARCA, no al del escalón (001/F-85): en una orden a
        // mercado el precio solo sirve para la holgura que el adaptador pone al
        // venue —Hyperliquid rechaza una MARKET a más de ~5 % del mark— y para
        // la fila de la base; con el del escalón, una seguridad lejana no
        // salía nunca. Y se anuncia lo que dijo el acuse, no lo que se
        // pretendía: sin acuse la seguridad no está, y el usuario tiene que
        // saberlo en vez de leer «ejecutada».
        const ack = await this.place(
          { ...next, type: 'MARKET', price: ticker.mark },
          'seguridad manual',
        );
        if (!ack) {
          await this.event(
            'ADD_SAFETY_SKIPPED',
            'WARN',
            `La seguridad #${next.levelIndex} no se ha ejecutado: el exchange no la aceptó. ` +
              'El motivo está en el evento anterior; repite la orden si procede.',
          );
          break;
        }
        await this.event(
          'SAFETY_ADDED',
          'INFO',
          ack.status === 'FILLED'
            ? `Seguridad #${next.levelIndex} ejecutada a mercado.`
            : `Seguridad #${next.levelIndex} enviada a mercado (acuse ${ack.status}); ` +
                'la ejecución se anotará al llegar.',
        );
        this.requestTick();
        break;
      }
    }

    if (soltar) {
      // El bot ha dejado de operar: que el motor lo suelte. Sin esto el runner
      // se quedaba con su temporizador, su WebSocket y su lease para siempre.
      this.deps.onDetach(this.botId, `comando ${command}`);
    }
  }

  /**
   * Cancelación de emergencia: el bot fue BORRADO de la base con el runner
   * vivo. Sin filas no hay ids propios que consultar, así que se usa el
   * alcance de símbolo del venue — la cuenta se está eliminando y dejar
   * órdenes vivas sin credencial para cancelarlas es estrictamente peor que
   * llevarse por delante una orden manual de ese símbolo. Sin eventos: la fila
   * del bot ya no existe y escribirlos violaría la clave foránea.
   */
  emergencyCancelAll(): Promise<void> {
    return this.exclusive(async () => {
      this.paused = true;
      await this.deps.adapter.cancelAll(this.deps.bot.symbol).catch(() => undefined);
    });
  }

  /** Recarga la configuración desde la base y decide si hay que retender. */
  reloadConfig(config: BotConfig, level: 'HOT' | 'WARM' | 'COLD'): Promise<void> {
    return this.exclusive(async () => {
      // ANTES de pisar `this.config`: es la única copia del valor viejo, y sin
      // él no hay forma de saber si el apalancamiento cambió.
      const previousLeverage = Number(this.config.leverage);
      // Y por el mismo motivo, la fuente de precio externa que se estaba
      // sondeando: los cuatro campos que la definen son HOT.
      const previousFeed = this.fairFeedRequest();
      this.config = config;
      // La escalera cambia: lo que se rechazó con la forma anterior merece otra
      // oportunidad con la nueva.
      this.quarantine.clear();
      await this.event('CONFIG_RELOADED', 'INFO', `Configuración recargada (${level}).`);

      // El apalancamiento es WARM, pero cambiarlo aquí no bastaba: hasta ahora
      // solo `start()` hablaba con el venue, así que un bot en marcha reajustaba
      // su escalera y sus guardas con el valor nuevo mientras el exchange seguía
      // con el viejo — y la posición que abría el siguiente nivel salía del
      // tamaño equivocado. En aislado el desfase es peor todavía: bajar el
      // apalancamiento es la vía indirecta de aportar margen, y no llegaba.
      await this.syncLeverage(previousLeverage);
      // Mismo caso que el apalancamiento, y por la misma razón: un campo mutable
      // cuyo efecto vive FUERA de `this.config`. Ver `syncFairPrice`.
      this.syncFairPrice(previousFeed);

      if (level === 'WARM') {
        // Se cancela lo NUESTRO y se retiende: ni la posición ni las órdenes de
        // otros bots de la misma cuenta se tocan. El stop loss sobrevive; si la
        // nueva configuración lo mueve, el reconciliador lo reemplaza al tender.
        await this.cancelOwnOrders(true);
      }
      this.requestTick();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Cancelación acotada al bot
  // ═══════════════════════════════════════════════════════════════

  /**
   * Cancela SOLO las órdenes de este bot.
   *
   * Antes esto era `adapter.cancelAll(symbol)`, cuyo alcance real es de símbolo
   * o de cuenta según el venue —en Lighter, de la cuenta ENTERA—. Pausar un bot
   * borraba las órdenes de los demás bots del usuario y las que hubiera puesto
   * a mano en la web del DEX: exactamente lo que el reconciliador se cuida de
   * respetar cuando las clasifica como ajenas.
   *
   * Los ids salen de la base, que es donde está la constancia de todo lo que
   * este bot ha mandado, incluidas las que ya no aparezcan en el libro.
   *
   * `keepProtective` respeta el STOP_LOSS. Lo usan las rutas que cancelan pero
   * NO cierran —pausar, parar conservando posición, recentrar, recarga WARM—,
   * porque en todas ellas la posición sigue viva: llevarse también el stop la
   * dejaba desnuda, y en el caso de `pauseForRisk` encima sin nadie mirándola.
   * Las que sí cierran (STOP_AND_CLOSE, PANIC) y la cancelación que pide el
   * usuario a mano cancelan todo, que es lo que corresponde.
   */
  private async cancelOwnOrders(keepProtective = false): Promise<void> {
    const coids = await this.deps.store.liveOrderCoids(this.botId, { keepProtective });
    if (coids.length === 0) return;
    try {
      await this.deps.adapter.cancelOwn(this.deps.bot.symbol, coids);
      await this.deps.store.markCoidsCanceled(this.botId, coids);
    } catch (e) {
      await this.event(
        'ACTION_FAILED',
        'WARN',
        `No se pudieron cancelar todas las órdenes: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Contrasta el ciclo con la posición real del venue al adoptar el bot.
   *
   * El barrido de ejecuciones solo retrocede `FILL_BACKFILL_MS`; si el worker
   * estuvo caído más tiempo, lo de en medio no lo ingirió nadie y el ciclo
   * quedó contando una cantidad que ya no existe. Se corrige lo que se puede
   * —cantidad y niveles— y se AVISA, porque el resultado realizado del hueco no
   * se puede reconstruir y de él depende el kill-switch de caída.
   */
  private async checkCycleAgainstVenue(position: Position | null): Promise<void> {
    const repair = await this.deps.store.repairCycleFromVenue(
      this.botId,
      D(position?.qty ?? 0)
        .abs()
        .toFixed(),
      this.strategy.recycleLevelOnExit === true,
    );
    if (!repair) return;

    this.cycle = {
      ...this.cycle,
      filledLevelIndexes: repair.indexes,
      entriesFilled: repair.entriesFilled,
    };

    await this.event(
      'BOT_REPAIRED',
      'WARN',
      `El ciclo decía ${repair.before} y el exchange dice ${repair.after}: ` +
        'corregidos cantidad y niveles ejecutados. El resultado realizado del ' +
        'hueco no se puede recuperar, así que el PnL del ciclo puede quedar corto.',
      { before: repair.before, after: repair.after, entriesFilled: repair.entriesFilled },
    );
  }

  /**
   * Envoltorio sobre la funcion pura de `strategy-core`.
   *
   * El calculo se mudo alli porque tiene un SEGUNDO consumidor —el backtest— y
   * dos copias del mismo stop divergen a la primera vez que alguien toque una.
   */
  private withStopLoss(
    desired: DesiredState,
    position: Position | null,
    cycleSeq: number,
  ): DesiredState {
    return withStopLoss(desired, position, {
      botId: this.botId,
      cycleSeq,
      market: this.market,
      stopLossPct: this.config.stopLossPct,
    });
  }

  /**
   * Coletilla para los eventos que dejan la posición abierta.
   *
   * Decir en voz alta si queda red o no: callarlo es justo lo que hace que
   * alguien crea que sigue protegido cuando no lo está.
   */
  private get protectionNote(): string {
    if (!this.config.stopLossPct) return ' Atención: la posición queda SIN stop loss.';
    return this.stopLossVivo
      ? ' El stop loss sigue vivo en el exchange.'
      : ' Atención: hay un stop loss configurado pero NO consta colocado en el ' +
          'exchange. Revísalo: la posición puede estar sin red.';
  }

  // ═══════════════════════════════════════════════════════════════
  // Riesgo
  // ═══════════════════════════════════════════════════════════════

  /**
   * Guardas evaluadas en cada tick. Devuelve el motivo si alguna salta.
   *
   * Se comprueban aquí y no solo al crear el bot porque el mercado se mueve: un
   * bot perfectamente dentro de límites al arrancar puede estar a un 3 % de la
   * liquidación media hora después.
   */
  private persistDue(): boolean {
    return this.ticks % PERSIST_EVERY_TICKS === 0;
  }

  private async checkRiskGuards(
    position: Position | null,
    ticker: Ticker,
  ): Promise<GuardBreach | null> {
    const g = this.deps.guards;

    // El apalancamiento se mira SIEMPRE, haya posición o no: es una propiedad de
    // la configuración, y un bot creado antes de que su dueño bajara el tope
    // seguía corriendo con el viejo para siempre.
    const lev = Number(this.config.leverage ?? 1);
    if (g.maxLeverage != null && Number.isFinite(lev) && lev > g.maxLeverage) {
      return pauseBreach(`apalancamiento ${lev}× por encima de tu límite (${g.maxLeverage}×)`);
    }

    if (position) {
      const notional = D(position.qty).abs().mul(ticker.mark);
      // `!= null` y no veracidad: son CADENAS, y `'0'` es veraz en JavaScript.
      if (g.maxNotionalPerBot != null && notional.gt(g.maxNotionalPerBot)) {
        return pauseBreach(
          `notional ${notional.toFixed(2)} por encima del límite por bot (${g.maxNotionalPerBot})`,
        );
      }

      // El notional TOTAL del usuario necesita una consulta agregada, así que se
      // mira al ritmo de la persistencia y no en cada tick: no cambia entre uno
      // y otro, y cobrarle una consulta por usuario a cada tick de cada bot sería
      // pagar mucho por saber lo mismo.
      if (g.maxTotalNotional != null && this.persistDue()) {
        const total = await this.deps.store.totalNotionalOfUser(this.deps.bot.user_id);
        if (total != null && total.gt(g.maxTotalNotional)) {
          return pauseBreach(
            `el notional de todos tus bots (${total.toFixed(2)}) supera tu límite total (${g.maxTotalNotional})`,
          );
        }
      }

      if (position.liquidationPrice && g.liquidationAlertPct) {
        const distance = liquidationDistancePct(ticker.mark, position.liquidationPrice);
        // Con enfriamiento: el aviso salta en CADA tick mientras dure la
        // cercanía, y una posición puede quedarse ahí horas. Repetirlo cada
        // quince segundos no informa de nada nuevo y entrena al usuario a
        // silenciar el canal justo antes del aviso que sí había que leer.
        if (distance.lt(g.liquidationAlertPct)) {
          // El aviso lleva enfriamiento; la ACCIÓN no. Callar el aviso es de
          // recibo —la posición puede quedarse horas ahí—, pero no actuar
          // durante diez minutos porque ya se avisó sería absurdo.
          if (Date.now() > this.liquidationAlertUntil) {
            this.liquidationAlertUntil = Date.now() + LIQUIDATION_ALERT_COOLDOWN_MS;
            await this.event(
              'LIQUIDATION_NEAR',
              'CRITICAL',
              `Liquidación a solo ${distance.toFixed(2)} % del precio actual.`,
              { liquidationPrice: position.liquidationPrice, mark: ticker.mark },
            );
          }

          // Hasta aquí llegaba: avisaba y seguía como si nada. Con `ALERT`
          // —el valor por defecto— se mantiene igual a propósito, para no
          // cambiarle la conducta a un bot en marcha sin que su dueño lo pida.
          const action = this.config.liquidationAction ?? 'ALERT';
          if (action !== 'ALERT') {
            const reason = `liquidación a ${distance.toFixed(2)} % del precio actual`;
            return action === 'CLOSE_ALL'
              ? { reason: `Cerrando por proximidad a liquidación: ${reason}.`, action: 'CLOSE' }
              : pauseBreach(reason);
          }
        }
      }
    }

    if (g.killSwitchDrawdownPct) {
      // El equity se calcula AQUÍ, con los números de este instante. Antes se
      // leía del último snapshot —el del tick anterior— y encima costaba una
      // consulta por bot y tick: el freno de emergencia decidía con datos
      // viejos y pagaba por ellos.
      const equity = D(this.cycle.realizedPnlAcc).plus(position?.unrealizedPnl ?? '0');
      const drawdown = this.deps.store.drawdownPct(
        this.deps.bot.total_investment.toString(),
        equity.toFixed(),
      );
      if (drawdown != null && drawdown.gte(g.killSwitchDrawdownPct)) {
        return pauseBreach(`caída del ${drawdown.toFixed(2)} % sobre el capital asignado`);
      }
    }

    if (g.maxDailyLoss) {
      const todayLoss = await this.deps.store.todayRealizedPnl(this.deps.bot.user_id);
      if (todayLoss.lt(D(g.maxDailyLoss).neg())) {
        return pauseBreach(
          `pérdida diaria de ${todayLoss.toFixed(2)}, por encima del límite (${g.maxDailyLoss})`,
        );
      }
    }

    // Límite diario POR BOT, en % del capital que se le asignó. No sobra frente
    // al anterior: aquel es global del usuario y en valor absoluto, así que un
    // bot puede quemarse su asignación entera sin rozar el tope de la cuenta.
    // El campo llevaba declarado desde el principio en `COMMON_FIELDS` y no lo
    // leía nadie: salía en el formulario y no cortaba nada.
    const dailyPct = this.config.maxDailyLossPct;
    if (dailyPct) {
      const today = await this.deps.store.todayRealizedPnlForBot(this.botId, this.deps.bot.user_id);
      const loss = this.deps.store.drawdownPct(
        this.deps.bot.total_investment.toString(),
        today.toFixed(),
      );
      if (loss != null && loss.gte(dailyPct)) {
        return pauseBreach(
          `pérdida de hoy del ${loss.toFixed(2)} % del capital del bot, por encima del límite diario (${dailyPct} %)`,
        );
      }
    }

    return null;
  }

  /**
   * Al saltar una guarda se PAUSA, no se cierra. Cerrar realizaría la pérdida
   * al instante y en el peor momento posible; pausar detiene el sangrado (deja
   * de añadir exposición) y deja la decisión final en manos del usuario, que es
   * quien debe tomarla.
   */
  private async pauseForRisk(reason: string): Promise<void> {
    this.paused = true;
    // Con `true`: el stop loss NO se cancela. Es la ruta en la que más importa
    // —el bot deja de planificar y de tender, así que a partir de aquí el stop
    // es la única defensa que le queda a la posición.
    await this.cancelOwnOrders(true);
    await this.deps.store.setStatus(this.botId, 'PAUSED', { error: reason });
    await this.event(
      'RISK_GUARD_TRIPPED',
      'CRITICAL',
      `Guarda de riesgo disparada: ${reason}. Bot pausado; la posición sigue abierta.` +
        this.protectionNote,
      { reason },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Auxiliares
  // ═══════════════════════════════════════════════════════════════

  private buildContext(
    ticker: Ticker,
    position: Position | null,
    openOrders: VenueOrder[],
    availableBalance: string,
  ): BotContext {
    const now = Date.now();
    const fair = this.deps.priceSource?.peek(this.fairFeedKey) ?? null;
    // Rancio se entrega como AUSENTE, no como el último valor conocido: la
    // estrategia no tiene forma de distinguirlos si le damos el precio viejo, y
    // la decisión correcta —dejar de cotizar— depende justo de esa diferencia.
    const fresh = fair && now - fair.ts < FAIR_PRICE_STALE_MS ? fair : null;

    return {
      botId: this.botId,
      venue: this.deps.bot.venue,
      strategy: this.deps.bot.strategy,
      config: this.config,
      market: this.market,
      ticker,
      position,
      openOrders,
      cycle: this.cycle,
      availableBalance,
      now,
      fairPrice: fresh?.price ?? null,
    };
  }

  /**
   * Abre el feed externo que pide la configuración, si pide alguno.
   *
   * Devuelve la clave del feed para poder soltarlo: sin eso, un bot parado
   * dejaría su sondeo vivo para siempre — el mismo fallo que ya se corrigió en
   * el feed de precios del venue.
   */
  private acquireFairPrice(): string | null {
    const source = this.config.priceSource as PriceSource | undefined;
    if (!source || source === PriceSource.EXCHANGE) return null;

    // Una fuente que ya no existe se trata como EXCHANGE, y se dice.
    //
    // Nada valida que un `priceSource` guardado siga estando —ni al crear el bot
    // ni al arrancarlo—, así que una fuente retirada (CoinGecko lo fue) dejaba al
    // bot en el peor estado posible: EN MARCHA, sin cotizar una sola orden y sin
    // un evento en su historial que lo explicara. Caer al precio del venue en
    // silencio sería igual de malo —quien eligió una fuente externa lo hizo
    // porque no se fía del mid local—, de ahí el aviso.
    if (!Object.values(PriceSource).includes(source)) {
      void this.event(
        'FAIR_PRICE_UNAVAILABLE',
        'WARN',
        `La fuente de precio «${String(source)}» ya no existe: reconfigura el bot ` +
          'para elegir una de las disponibles.',
      );
      return null;
    }

    if (!this.deps.priceSource) {
      void this.event(
        'FAIR_PRICE_UNAVAILABLE',
        'WARN',
        'Este worker no tiene feeds de precio externos activos: el bot no cotizará.',
      );
      return null;
    }
    const req = this.fairFeedRequest();
    return req ? this.deps.priceSource.acquire(req) : null;
  }

  /**
   * El feed que PIDE la configuración vigente, o null si no pide ninguno.
   *
   * Solo lee: no adquiere, no avisa y no toca el contador de referencias. Esa
   * es la diferencia con `acquireFairPrice`, y es lo que permite llamarla ANTES
   * de pisar `this.config` para quedarse con la petición anterior.
   */
  private fairFeedRequest(): FairFeedRequest | null {
    const source = this.config.priceSource as PriceSource | undefined;
    if (!source || source === PriceSource.EXCHANGE) return null;
    if (!Object.values(PriceSource).includes(source)) return null;

    // Anclar al libro del propio venue no consume la fuente externa: con
    // `VENUE_MID` o `VENUE_MARK`, `resolveAnchor` corta antes de mirar
    // `ctx.fairPrice`. Sin esta línea, esa combinación abría un feed y sondeaba
    // Binance cada dos segundos durante toda la vida del bot para TIRAR el dato.
    const origin =
      (this.config.fairPriceOrigin as FairPriceOrigin | undefined) ?? FairPriceOrigin.SOURCE_GLOBAL;
    if (origin !== FairPriceOrigin.SOURCE_GLOBAL) return null;

    return {
      source,
      marketType: (this.config.sourceMarketType as SourceMarketType) ?? SourceMarketType.PERP,
      base: this.market.base,
      override: (this.config.sourceSymbolOverride as string | null) ?? null,
    };
  }

  /**
   * Vuelve a pedir el feed externo cuando la configuración recargada apunta a
   * otro sitio.
   *
   * Los cuatro campos de la fuente son HOT, pero el feed se pedía UNA sola vez,
   * en `start()`. Cambiar de EXCHANGE a BINANCE en caliente dejaba
   * `fairFeedKey` en null para siempre: `ctx.fairPrice` no llegaba nunca,
   * `resolveAnchor` devolvía null, `plan()` no pedía una sola orden y el
   * reconciliador CANCELABA las cotizaciones vivas. El bot se quedaba EN MARCHA
   * sin cotizar y, lo peor, callado: `warnIfFairPriceStale` sale antes si no hay
   * clave, así que no había ni un evento que lo explicara —solo la nota del
   * tick—. Cambiar el símbolo de origen era todavía peor: el bot SEGUÍA
   * cotizando, pero contra la referencia equivocada y sin ninguna señal.
   *
   * Solo actúa si la petición CAMBIA: un HOT de cualquier otro campo —y son casi
   * todos— no debe cerrar y reabrir un sondeo que estaba bien.
   */
  private syncFairPrice(previous: FairFeedRequest | null): void {
    const next = this.fairFeedRequest();
    if (sameFairFeed(previous, next)) return;

    this.deps.priceSource?.release(this.fairFeedKey);
    this.fairFeedKey = this.acquireFairPrice();
    // El enfriamiento se reinicia: el corte de la fuente ANTERIOR no tiene por
    // qué callar el primer aviso de la nueva.
    this.fairPriceAlertUntil = 0;
  }

  /**
   * Avisa una vez cada tanto de que el precio externo no llega.
   *
   * Se limita por tiempo igual que el aviso de liquidación: la estrategia deja
   * de cotizar sola en cada tick, así que sin freno serían cuatro eventos por
   * minuto durante todo el corte.
   */
  private async warnIfFairPriceStale(ctx: BotContext): Promise<void> {
    if (!this.fairFeedKey) return;
    if (ctx.fairPrice) return;
    const now = Date.now();
    if (now < this.fairPriceAlertUntil) return;
    this.fairPriceAlertUntil = now + FAIR_PRICE_ALERT_COOLDOWN_MS;

    // La causa, cuando la fuente sabe decirla. Un bloqueo por territorio y un
    // corte de red producen el mismo silencio aquí, pero uno se arregla solo en
    // treinta segundos y el otro no se arregla nunca sin tocar algo.
    const estado = this.deps.priceSource?.status?.(this.fairFeedKey) ?? null;
    const detalle = estado ? FAIR_PRICE_CAUSE_TEXT[estado.cause] : undefined;

    await this.event(
      'FAIR_PRICE_STALE',
      // Un bloqueo por territorio no es un aviso pasajero: no se va a arreglar
      // esperando y el bot no volverá a cotizar por su cuenta.
      estado?.cause === 'GEO' ? 'CRITICAL' : 'WARN',
      detalle ??
        `Sin precio de ${String(this.config.priceSource).toLowerCase()}: el bot no cotiza hasta que vuelva.`,
      estado ? { cause: estado.cause, failures: estado.failures } : undefined,
    );
  }

  /**
   * Fija en el venue el apalancamiento y el modo de margen de la configuración.
   *
   * `previous` ausente = arranque: se manda siempre, porque no se sabe con qué
   * quedó la cuenta la última vez. Con `previous` es una recarga y solo se
   * manda si el valor cambió: es una escritura firmada y repetirla en cada
   * cambio HOT —un stop loss, un tope de exposición— gastaría caudal para
   * decirle al venue lo que ya sabe.
   *
   * Un rechazo NO detiene nada: con posición abierta muchos venues lo niegan, y
   * eso es lo normal, no una avería. Se registra y se sigue con el que ya tenga
   * el venue, que es exactamente lo que hacía el arranque desde el principio.
   */
  private async syncLeverage(previous?: number): Promise<void> {
    const { adapter, bot } = this.deps;
    const leverage = Number(this.config.leverage);
    if (!Number.isFinite(leverage) || leverage <= 0) return;
    if (previous !== undefined && previous === leverage) return;

    try {
      await adapter.setLeverage(bot.symbol, leverage, bot.margin_mode);
    } catch (e) {
      const err = e as ExchangeError;
      await this.event(
        'LEVERAGE_SKIPPED',
        'WARN',
        previous === undefined
          ? `No se pudo fijar el apalancamiento: ${err.message}`
          : `No se pudo cambiar el apalancamiento a ${leverage}×: ${err.message}. ` +
              'El exchange sigue con el anterior; párate y arranca de nuevo para aplicarlo.',
      );
    }
  }

  private async currentPosition(): Promise<Position | null> {
    const positions = await this.deps.adapter.getPositions(this.deps.bot.symbol);
    return positions[0] ?? null;
  }

  /**
   * Aporta o retira colateral de la posición aislada.
   *
   * Es el único camino que mueve el precio de liquidación sin comprar ni vender
   * nada. La API ya ha validado lo que se puede validar sin el venue; aquí se
   * vuelve a comprobar lo esencial porque entre que se encoló y ahora el bot
   * pudo cambiar de manos, de configuración o quedarse plano.
   *
   * El evento registra la liquidación ANTES y DESPUÉS a propósito: es la única
   * prueba de que el aporte sirvió para lo que se pidió, y es lo que la pantalla
   * enseña. Si el venue no publica liquidación, se cae al margen usado, que al
   * menos demuestra que el dinero llegó.
   */
  private async adjustMargin(payload: unknown): Promise<void> {
    const { adapter, bot } = this.deps;
    const arg = payload as MarginAdjustment | undefined;

    if (!arg?.amount || !arg.action) {
      throw new Error('El ajuste de margen llegó sin importe o sin sentido.');
    }
    if (!adapter.adjustIsolatedMargin) {
      throw new Error(`${bot.venue} no permite ajustar el margen de una posición desde la API.`);
    }
    // Segunda barrera. La primera está en la API, pero el modo de margen es
    // COLD y aun así un bot puede haberse recreado entre una cosa y la otra.
    if (bot.margin_mode !== 'ISOLATED') {
      throw new Error(
        'El bot opera en margen cruzado: su colateral es el de toda la cuenta y no hay margen por posición que ajustar.',
      );
    }

    const before = await this.currentPosition();
    if (!before || D(before.qty).isZero()) {
      throw new Error(
        `No hay posición abierta en ${bot.symbol}: no existe una caja aislada que financiar.`,
      );
    }

    // Del SIGNO de la posición, no de `config.direction`: un market maker se
    // configura NEUTRAL y su posición está igualmente en un lado concreto.
    const side = D(before.qty).gt(0) ? 'LONG' : 'SHORT';
    await adapter.adjustIsolatedMargin(bot.symbol, arg.amount, arg.action, side);

    // Se relee para contar lo que de verdad pasó y no lo que se pidió. Que
    // falle esta lectura no invalida la transferencia, que ya está hecha: se
    // registra sin el después en vez de convertir el comando en fallido.
    const after = await this.currentPosition().catch(() => null);
    const verbo = arg.action === 'ADD' ? 'Aportados' : 'Retirados';
    await this.event(
      'MARGIN_ADJUSTED',
      'INFO',
      `${verbo} ${arg.amount} de margen. ` +
        `Liquidación: ${before.liquidationPrice ?? '—'} → ${after?.liquidationPrice ?? '—'}.`,
      {
        amount: arg.amount,
        action: arg.action,
        liquidationBefore: before.liquidationPrice,
        liquidationAfter: after?.liquidationPrice ?? null,
        marginBefore: before.marginUsed,
        marginAfter: after?.marginUsed ?? null,
      },
    );
  }

  /**
   * Precio vigente, sin aceptar un cero por respuesta.
   *
   * `lastTicker` puede ser null —el stream aún no ha entregado nada, o se cayó—
   * y el código anterior caía a la cadena '0'. En Hyperliquid una orden a
   * mercado es una limit IOC a `precio × 1,05`, así que un cierre de pánico
   * salía a cero, el venue lo rechazaba, y el usuario se quedaba creyendo que
   * su posición estaba cerrada cuando seguía abierta.
   */
  private async currentTicker(): Promise<Ticker> {
    // Y tiene que ser RECIENTE. Cerrar a mercado con un precio de hace un rato
    // en una limit IOC con un 5 % de holgura puede no cruzar: la orden se queda
    // sin ejecutar y el usuario cree que ha cerrado.
    const fresco =
      this.lastTicker &&
      D(this.lastTicker.mark).gt(0) &&
      Date.now() - this.lastTicker.ts < TICKER_MAX_AGE_MS;
    if (fresco && this.lastTicker) return this.lastTicker;
    const ticker = await this.deps.adapter.getTicker(this.deps.bot.symbol);
    this.lastTicker = ticker;
    if (!D(ticker.mark).gt(0)) {
      throw new ExchangeError(
        'RETRYABLE',
        'El venue no devuelve precio para ' + this.deps.bot.symbol,
        this.deps.bot.venue,
      );
    }
    return ticker;
  }

  private async markPrice(): Promise<string> {
    return (await this.currentTicker()).mark;
  }

  /**
   * Relee la spec del mercado cada cierto tiempo.
   *
   * En Hyperliquid el tick depende de la MAGNITUD del precio, así que un activo
   * que cruza una potencia de diez cambia de retícula. La spec se cargaba una
   * sola vez al adoptar el bot y no se refrescaba jamás: un bot de semanas
   * seguía redondeando a la retícula del día que arrancó, y desde el cambio el
   * venue rechazaba todas sus órdenes con un escueto «invalid price».
   */
  private async refreshMarketSpec(): Promise<void> {
    if (this.ticks % SPEC_REFRESH_EVERY_TICKS !== 0) return;
    const fresh = await this.deps.store
      .marketSpec(this.deps.bot.venue, this.deps.bot.symbol, this.deps.testnet)
      .catch(() => null);
    if (!fresh) return;
    if (fresh.tickSize !== this.market.tickSize || fresh.stepSize !== this.market.stepSize) {
      await this.event(
        'MARKET_SPEC_CHANGED',
        'INFO',
        `La retícula del mercado ha cambiado (tick ${this.market.tickSize} → ${fresh.tickSize}).`,
      );
      // Sobre la retícula nueva, lo que se rechazó con la anterior puede ser
      // perfectamente válido.
      this.quarantine.clear();
    }
    this.market = fresh;
  }

  /**
   * Devuelve si el cierre SALIÓ (acuse del venue) o no había nada que cerrar.
   * `false` significa que la posición sigue abierta: quien lo llama decide qué
   * hacer con esa verdad en vez de afirmar lo contrario (001/F-33).
   */
  private async closePositionAtMarket(motivo: string): Promise<boolean> {
    const position = await this.currentPosition();
    if (!position || D(position.qty).isZero()) {
      await this.event('CLOSE_SKIPPED', 'INFO', `Nada que cerrar (${motivo}): posición plana.`);
      return true;
    }

    // El precio se obtiene ANTES de construir la orden y falla ruidosamente si
    // no lo hay: mandar un cierre a cero es peor que no mandarlo.
    const mark = await this.markPrice();
    const qty = D(position.qty);
    const seq = Number(this.cycle.scratch.cycleSeq ?? 0);
    const ack = await this.place(
      {
        // Índice 999: no compite con ningún nivel de la escalera, así que un
        // cierre manual nunca choca con el id de una orden de la estrategia.
        //
        // Con `makeCoid` y no a mano: aquí había una cuarta copia del prefijo
        // del bot con su `slice(0, 8)`, que al ampliarse el prefijo habría
        // generado ids de un formato distinto al del resto de órdenes.
        clientOrderId: makeCoid(this.botId, seq, 'TAKE_PROFIT', 999),
        levelKind: 'TAKE_PROFIT',
        levelIndex: 999,
        side: qty.gt(0) ? 'SELL' : 'BUY',
        type: 'MARKET',
        price: mark,
        qty: qty.abs().toFixed(this.market.qtyDecimals),
        reduceOnly: true,
      },
      motivo,
      false,
      // Cierre pedido a mano: no hay «espera al siguiente tick» que valga.
      true,
    );
    return ack !== null;
  }

  private async snapshot(
    ticker: Ticker,
    position: Position | null,
    openOrders: number,
  ): Promise<void> {
    // Las marcas de agua se actualizan ANTES pero sin poder tumbar el snapshot:
    // de este ultimo salen el equity y el drawdown que disparan el kill-switch,
    // y perder el maximo historico de margen no justifica quedarse sin freno de
    // emergencia.
    if (this.isMarketMaker) {
      try {
        await this.deps.store.trackMmPeaks(
          this.botId,
          D(position?.qty ?? 0).mul(ticker.mark),
          D(position?.marginUsed ?? 0),
        );
      } catch (e) {
        this.logger.warn(
          `No se pudieron actualizar las marcas de market making: ${(e as Error).message}`,
        );
      }
    }

    await this.deps.store.saveSnapshot(this.botId, {
      markPrice: ticker.mark,
      positionQty: position?.qty ?? '0',
      averageEntry: position?.entryPrice ?? null,
      unrealizedPnl: position?.unrealizedPnl ?? '0',
      // El ACUMULADO del bot, no el del ciclo en curso: de aquí sale el equity
      // y del equity sale el drawdown que dispara el kill-switch.
      realizedPnlAcc: this.cycle.realizedPnlAcc,
      marginUsed: position?.marginUsed ?? '0',
      liquidationPrice: position?.liquidationPrice ?? null,
      openOrders,
    });
  }

  /** Envuelve una acción para que un fallo aislado no aborte el tick entero. */
  private async safely(accion: string, ref: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const err = e as ExchangeError;
      // Cancelar algo que ya no existe es un no-op, no un error: pasa cada vez
      // que una orden se ejecuta justo entre la lectura y la cancelación.
      if (/not found|unknown order|does not exist/i.test(err.message)) return;
      await this.event('ACTION_FAILED', 'WARN', `No se pudo ${accion} ${ref}: ${err.message}`);
    }
  }

  private async onTickError(e: unknown): Promise<void> {
    const err = e as ExchangeError;
    if (err.kind === 'AUTH') {
      // Credencial revocada o caducada: seguir intentándolo solo genera ruido.
      // Se PIDE que lo suelten, en lugar de quedarse marcado como parado dentro
      // del motor: así se cierra el WebSocket y se libera el lease, y cuando el
      // usuario arregle la credencial el bot se vuelve a adoptar como cualquier
      // otro. Antes se quedaba aquí colgado hasta reiniciar el worker.
      this.stopped = true;
      await this.deps.store
        .setStatus(this.botId, 'ERROR', { error: err.message })
        .catch(() => undefined);
      await this.event('AUTH_ERROR', 'CRITICAL', `Credencial no válida: ${err.message}`).catch(
        () => undefined,
      );
      this.deps.onDetach(this.botId, 'credencial no válida');
      return;
    }
    this.tickErrors++;
    // RECORTADO antes de salir de aqui. `err.message` puede ser la pagina de
    // error del proxy del venue —cuatro kilobytes de HTML—, y de aqui va a la
    // bitacora, a `last_error` y a la ficha del bot en la app. `messageOf` ya
    // resume el HTML en una linea; esto acota lo demas.
    const motivo = shortMessage(err.message);
    this.logger.warn(`Tick fallido (${this.tickErrors}): ${motivo}`);
    // Registrar el evento también puede fallar (base caída). Si se propagara,
    // sería un rechazo sin manejar dentro de un setInterval: en Node eso tumba
    // el proceso entero y con él TODOS los bots de este worker.
    await this.event('TICK_ERROR', 'WARN', `Tick fallido: ${motivo}`).catch(() => undefined);

    // Cortacircuitos. Un bot que no consigue completar un tick no está
    // operando: no tiende la escalera, no recoloca el take profit y no ve los
    // fills. Seguir fingiendo que corre es lo peor de las dos opciones, porque
    // nadie va a mirar un WARN cada quince segundos.
    if (!this.paused && this.tickErrors >= MAX_CONSECUTIVE_TICK_ERRORS) {
      await this.pauseForRisk(
        `${this.tickErrors} ticks seguidos fallidos (último: ${motivo})`,
      ).catch(() => undefined);
    }
  }

  /** Un tick llegó al final: el bot está vivo y la racha de fallos se rompe. */
  private markTickOk(): void {
    this.tickErrors = 0;
    this.lastTickOkAt = Date.now();
  }

  /**
   * Hace cuánto que este bot no completa un tick.
   *
   * Lo consulta el chequeo de salud del worker: un runner con el temporizador
   * vivo pero sin ticks completos es exactamente el fallo que el lease no
   * detecta —el lease se renueva igual de bien en un proceso atascado—.
   */
  get msSinceLastTick(): number {
    return Date.now() - this.lastTickOkAt;
  }

  private async event(
    type: string,
    severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL',
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store.event(this.deps.bot, type, severity, message, payload);
  }
}
