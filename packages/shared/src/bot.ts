import type {
  BotStatus,
  Direction,
  EventSeverity,
  LevelKind,
  LimitAction,
  LiquidationAction,
  MarginAction,
  MarginMode,
  OrderSide,
  OrderType,
  PositionModeSetting,
  SizingMode,
  StrategyKind,
  TimeInForce,
  Venue,
} from './enums';
import type { Candle } from './candle';
import type { MarketSpec, Position, Ticker } from './market';
import type { VenueOrder } from './orders';

/** Parámetros que comparten TODAS las estrategias. */
export interface CommonBotConfig {
  exchangeAccountId: string;
  symbol: string;
  direction: Direction;
  leverage: number;
  marginMode: MarginMode;
  /**
   * Modo de posición deseado. `AUTO` (o ausente) deja el de la cuenta.
   *
   * Importa más de lo que parece: en modo cobertura una venta abre un corto en
   * paralelo al largo en vez de reducirlo, así que un market maker neutral
   * configurado en cobertura acumula las dos patas a la vez.
   */
  positionMode?: PositionModeSetting;
  /** Margen total asignado al bot, en la quote del mercado. */
  totalInvestment: string;
  /** Tope duro de notional. El motor no coloca nada que lo supere. */
  maxNotionalCap?: string | null;
  stopLossPct?: string | null;
  maxDailyLossPct?: string | null;
  cooldownMinutes?: number;
  /**
   * En qué unidad teclea el usuario los tamaños: `QUOTE` = valor nocional
   * (USDC), `BASE` = cantidad de moneda. Por defecto `QUOTE`, que es lo que
   * hacían todas las estrategias antes de que este campo existiera.
   */
  sizingMode?: SizingMode;
  /** Qué hacer al alcanzar el tope de posición. Por defecto `PAUSE_ENTRIES`. */
  limitAction?: LimitAction;
  /** Qué hacer al acercarse a la liquidación. Por defecto `ALERT`. */
  liquidationAction?: LiquidationAction;
  /** Por debajo de este precio el bot no abre posición nueva; solo la reduce. */
  priceFloor?: string | null;
  /** Por encima de este precio el bot no abre posición nueva; solo la reduce. */
  priceCeiling?: string | null;
}

export type BotConfig = CommonBotConfig & Record<string, unknown>;

// ── Lo que la estrategia DESEA que exista en el venue ────────────────────

/**
 * Una orden que la estrategia quiere ver viva. El motor compara este conjunto
 * con las órdenes reales por `clientOrderId` y ejecuta solo la diferencia:
 * de ahí que un cambio de configuración no tenga código propio: cambia lo que
 * `plan()` devuelve y el diff hace el resto.
 */
export interface DesiredOrder {
  clientOrderId: string;
  levelKind: LevelKind;
  levelIndex: number;
  side: OrderSide;
  type: OrderType;
  price: string;
  qty: string;
  reduceOnly: boolean;
  timeInForce?: TimeInForce;
  triggerPrice?: string;
  /**
   * Sentido del disparo, cuando no es el que se deduciría del `levelKind`.
   *
   * El motor deduce 'TP' de `TAKE_PROFIT` y 'SL' del resto, y eso vale para
   * todo lo que había: un objetivo de beneficio dispara al SUBIR y un stop al
   * bajar. Pero un take profit que SIGUE al precio es, mecánicamente, un stop:
   * para un largo es una venta que dispara al BAJAR, aunque esté muy por
   * encima de la entrada.
   *
   * Sin esta puerta solo quedaban dos salidas, las dos malas: emitirlo como
   * `TAKE_PROFIT` lo armaría al revés —la condición ya sería cierta al
   * colocarlo y el venue cerraría la posición al instante, que es el fallo
   * 001/F-80—, y emitirlo como `STOP_LOSS` dejaría al bot sin el stop-loss del
   * usuario, porque `withStopLoss` se calla si la estrategia ya emitió uno
   * (spec 042 R-1).
   */
  intent?: 'TP' | 'SL';
}

export interface DesiredState {
  /** Órdenes limit que deben estar en el libro ahora mismo. */
  orders: DesiredOrder[];
  /**
   * Acciones a mercado de ejecución inmediata (cierre por stop, take-profit
   * manual). Van aparte porque NO se reconcilian: se mandan una vez y punto.
   */
  immediate: DesiredOrder[];
  /** Explica en una línea qué está haciendo el bot; se muestra en la app. */
  note?: string;
  /**
   * Cambios que el motor debe fusionar en cycle.scratch tras aplicar el plan.
   * Es lo que permite que plan() siga siendo pura y aun así una estrategia
   * con memoria propia (el refresco del market maker, las recompras de
   * GridMart) pueda pedir que se recuerde algo para el siguiente tick.
   */
  scratchPatch?: Record<string, unknown>;
}

/** Estado del ciclo en curso (abierto → take profit → cooldown → siguiente). */
export interface CycleState {
  cycleId: string | null;
  startedAt: number | null;
  /** Nº de entradas ejecutadas en este ciclo (TDCA, Martingale, GridMart). */
  entriesFilled: number;
  lastEntryAt: number | null;
  /** Índices de nivel ya ejecutados: evita retenderlos dentro del mismo ciclo. */
  filledLevelIndexes: number[];
  /** Epoch ms hasta el que el bot no debe abrir ciclo nuevo. */
  cooldownUntil: number | null;
  /**
   * Resultado realizado DE ESTE CICLO. Es lo que la estrategia puede necesitar
   * mirar; se reinicia con cada ciclo nuevo.
   */
  realizedPnl: string;
  /**
   * Resultado realizado ACUMULADO del bot, sumando todos los ciclos cerrados
   * más lo realizado en el actual.
   *
   * Son dos cifras distintas y hubo que separarlas: antes solo existía
   * `realizedPnl` y se usaba para las dos cosas, de modo que al cerrar un ciclo
   * se le sumaba su propio total y quedaba contado dos veces. De ahí sale el
   * equity del snapshot, y del equity sale el drawdown que dispara el
   * kill-switch: el freno de emergencia se estaba calculando sobre una cifra
   * que no era ni una cosa ni la otra.
   */
  realizedPnlAcc: string;
  averageEntry: string | null;
  /**
   * Precio en el que se ancló la escalera de este ciclo. Martingale y GridMart
   * cuelgan TODOS sus niveles de aquí, no del precio de mercado actual: si se
   * recalculara con el precio vivo, las órdenes de seguridad se irían moviendo
   * hacia abajo con el mercado y nunca llegarían a ejecutarse.
   */
  anchorPrice: string | null;
  /**
   * Estado libre de cada estrategia (última cotización del market maker,
   * recompras pendientes de GridMart...). Se persiste como JSON junto al ciclo;
   * evita añadir un campo por estrategia al tipo compartido.
   */
  scratch: Record<string, unknown>;
}

/** Todo lo que `plan()` necesita. Es la ÚNICA entrada: la función es pura. */
export interface BotContext {
  botId: string;
  venue: Venue;
  strategy: StrategyKind;
  config: BotConfig;
  market: MarketSpec;
  ticker: Ticker;
  /** null cuando la posición está plana. */
  position: Position | null;
  openOrders: VenueOrder[];
  cycle: CycleState;
  /** Margen libre en la cuenta, por si el usuario retiró fondos por fuera. */
  availableBalance: string;
  now: number;
  /**
   * Precio de referencia de una fuente AJENA al venue (Binance),
   * cuando la configuración lo pide. El motor lo resuelve antes de llamar a
   * `plan()`.
   *
   * `null` significa las dos cosas a la vez: «no se ha pedido» y «se pidió pero
   * llegó rancio». La estrategia debe tratarlo igual en ambos casos —si dependía
   * de él, deja de cotizar—, porque cotizar contra un precio viejo es
   * exactamente el escenario que se lleva el diferencial por delante.
   *
   * Aquí hubo también un `fairPriceTs` con la marca de tiempo de la muestra, y
   * se ha quitado: no lo leía ninguna estrategia y no podía leerlo ninguna con
   * provecho, porque la decisión de antigüedad ya está tomada aguas arriba —el
   * motor entrega `null` cuando la muestra pasa de `FAIR_PRICE_STALE_MS`—. Un
   * campo que invita a rehacer una comprobación que ya está hecha, y con otro
   * umbral, es peor que no tenerlo.
   */
  fairPrice?: string | null;
  /**
   * Velas CERRADAS, de la más antigua a la más reciente.
   *
   * Solo llega a las estrategias que la declaran (`Strategy.candles`). El motor
   * reconcilia contra el libro y no contra un gráfico, y ese principio sigue
   * valiendo para las que reconcilian: ninguna la declara, así que ninguna
   * la recibe y por ninguna se pide una sola vela. La de tendencia decide
   * mirando un gráfico, y por eso es la única que la pide (spec 040).
   *
   * Cerradas a propósito: la vela en curso cambia dentro del mismo minuto, así
   * que entregarla rompería la pureza de `plan()` —dos llamadas con el mismo
   * estado darían planes distintos— (spec 038).
   */
  candles?: Candle[];
  /**
   * Extremos del precio de MARCA vistos DESDE LA ÚLTIMA planificación.
   *
   * El motor planifica cada quince segundos pero recibe precios varias veces
   * por segundo. Sin esto, un máximo que sube y baja entre dos revisiones no
   * existe para la estrategia, y un trailing lo perdería entero.
   *
   * De la MARCA y no del último negociado porque es el que los venues suavizan:
   * un mal print no puede inventar un máximo y, con él, un disparador ya por
   * debajo del mercado que cerraría la posición al instante.
   *
   * Vive en memoria del runner y no se persiste a propósito: lo que se guarda
   * es el máximo del ciclo, en `scratch`. El peor caso de un reinicio del
   * worker es perder el pico de los últimos quince segundos, y eso hace que el
   * bot salga un poco más abajo, nunca más arriba (spec 042 R-6).
   */
  extremos?: { alto: string; bajo: string };
}

// ── Preview previo a crear el bot ─────────────────────────────────────────

export interface LevelPreview {
  index: number;
  kind: LevelKind;
  side: OrderSide;
  price: string;
  qty: string;
  notional: string;
  marginUsed: string;
  /** Acumulados hasta este nivel incluido: es el número que importa de verdad. */
  cumulativeNotional: string;
  cumulativeMargin: string;
  /** Precio medio de entrada si se llenaran todos los niveles hasta aquí. */
  averageEntry: string | null;
  /** Distancia en % desde el precio actual. */
  distancePct: string;
  /** No vacío = el venue rechazaría este nivel. Bloquea la creación del bot. */
  violations: string[];
}

export interface PreviewResult {
  levels: LevelPreview[];
  /** El peor caso: todos los niveles ejecutados. */
  worstCaseNotional: string;
  worstCaseMargin: string;
  worstCaseAverageEntry: string | null;
  /** Estimación con la fórmula del venue; null si falta información. */
  estimatedLiquidationPrice: string | null;
  /** Caída en % desde el precio actual hasta la liquidación estimada. */
  liquidationDistancePct: string | null;
  takeProfitPrice: string | null;
  valid: boolean;
  issues: { field: string | null; message: string; severity: 'ERROR' | 'WARNING' }[];
}

// ── Vistas para la app ────────────────────────────────────────────────────

/**
 * Lo que devuelve `GET /bots` por cada bot, y lo que la app pinta en la lista,
 * la cartera y el gráfico. Es UN solo tipo a propósito: la API lo declara como
 * tipo de retorno y la app lo importa tal cual, así que un campo que se añada o
 * se quite en un lado deja de compilar en el otro. Antes había tres copias —esta,
 * la forma que devolvía la API y una tercera mantenida a mano en la app— y la
 * métrica de riesgo nº 1 llevaba meses declarada aquí sin que nadie la
 * rellenara (spec 002, F-01 y F-04).
 */
export interface BotSummary {
  id: string;
  name: string;
  venue: Venue;
  /** Red del venue en la que opera. Sale de su cuenta, no de una columna suya. */
  testnet: boolean;
  /**
   * Corre sobre una conexión de SIMULACIÓN, sin claves.
   *
   * No es lo mismo que `dryRun`: un bot simulado puede correr sobre una conexión
   * REAL, y ese sí gasta cuota y convive con los demás bots de esa cuenta. Esto
   * es lo que separa el resultado de mentira del de verdad en la cartera.
   */
  paper: boolean;
  symbol: string;
  strategy: StrategyKind;
  status: BotStatus;
  direction: Direction;
  leverage: number;
  dryRun: boolean;
  /** Lo que el usuario puso. Es el denominador del ROI y el «capital asignado» de la cartera. */
  totalInvestment: string;
  realizedPnl: string;
  unrealizedPnl: string;
  roiPct: string;
  /**
   * Capital actual: lo asignado más lo realizado más lo abierto. Es patrimonio,
   * no resultado —la curva del detalle sigue siendo «resultado acumulado»—, y es
   * la cifra que contesta «¿cuánto dinero tiene ahora este bot?» (spec 025).
   */
  currentCapital: string;
  /** Valor de la posición a precio de marca (|cantidad| × marca). null sin precio. */
  positionValue: string | null;
  /** Margen inmovilizado por la posición, del último snapshot. */
  marginUsed: string;
  positionQty: string;
  averageEntry: string | null;
  liquidationPrice: string | null;
  /** % de caída que aguanta antes de liquidar. La métrica de riesgo nº 1. */
  liquidationDistancePct: string | null;
  /**
   * Miniserie del resultado acumulado de las últimas 24 h, un punto por hora y
   * en orden temporal, para la tarjeta de la lista. Opcional: solo la sirve el
   * listado, y solo se permite en una lista si viaja en la MISMA respuesta que
   * ella —una petición por fila serían veinte, y ~3,4 MB para veinte rectángulos.
   */
  spark?: string[];
  openOrders: number;
  uptimeSeconds: number;
  note: string | null;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface BotEventView {
  id: string;
  type: string;
  severity: EventSeverity;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/** Acciones de runtime, independientes de editar la configuración. */
export const BotCommand = {
  START: 'START',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  STOP_KEEP_POSITION: 'STOP_KEEP_POSITION',
  STOP_AND_CLOSE: 'STOP_AND_CLOSE',
  CLOSE_NOW: 'CLOSE_NOW',
  TAKE_PROFIT_NOW: 'TAKE_PROFIT_NOW',
  ADD_SAFETY_NOW: 'ADD_SAFETY_NOW',
  REANCHOR_GRID: 'REANCHOR_GRID',
  CANCEL_ALL_ORDERS: 'CANCEL_ALL_ORDERS',
  PANIC: 'PANIC',
  /**
   * Aporta o retira colateral de la posición aislada. El ÚNICO comando con
   * argumentos (`MarginAdjustment`), y el único que aleja la liquidación sin
   * tocar la posición.
   */
  ADJUST_MARGIN: 'ADJUST_MARGIN',
  /**
   * Resincroniza el bot contra el venue: tira las cachés, relee posición,
   * órdenes y ejecuciones por REST, recalcula el ciclo y fuerza un tick.
   *
   * NO cancela ni cierra nada, así que no exige confirmación. Existe porque la
   * reconciliación converge sola pero puede tardar hasta un tick completo, y
   * cuando algo se ha descuadrado el usuario quiere verlo arreglado YA.
   */
  REPAIR: 'REPAIR',
} as const;
export type BotCommand = (typeof BotCommand)[keyof typeof BotCommand];

/**
 * Argumentos de `ADJUST_MARGIN`.
 *
 * `countAsBotCapital` NO afecta al venue y por eso viaja aparte del ajuste: la
 * transferencia de colateral es lo que mueve la liquidación, y esto solo decide
 * si además se sube el capital asignado del bot para que el ROI, la APR y el
 * margen punta reflejen el dinero que hay realmente inmovilizado. Son dos
 * efectos independientes y la interfaz tiene que poder decirlo así.
 */
export interface MarginAdjustment {
  /** Importe en la quote del mercado. SIEMPRE positivo; el sentido va en `action`. */
  amount: string;
  action: MarginAction;
  /**
   * Sube también `totalInvestment` (revisión WARM, retiende la escalera).
   * Solo tiene sentido con `action: 'ADD'`.
   */
  countAsBotCapital?: boolean;
}

/**
 * Métricas propias de market making. Se calculan sobre `bot_mm_stats` (los
 * contadores que el motor agrega en cada ejecución) más el snapshot vigente.
 *
 * Las definiciones no son universales, así que se fijan aquí y la app las
 * muestra al pie: `grossMatchedProfit` es el diferencial capturado ANTES de
 * comisiones, y `realizedPnl` es ese mismo número ya con las comisiones
 * restadas. La diferencia entre ambos es exactamente lo que cuesta operar.
 */
export interface MarketMakerStats {
  botId: string;
  fills: number;
  buyFills: number;
  sellFills: number;
  makerFills: number;
  takerFills: number;
  /** Pares casados: cada ejecución que reduce posición cierra uno. */
  closedCycles: number;
  /** «Grid profit»: diferencial capturado antes de comisiones. */
  grossMatchedProfit: string;
  feesPaid: string;
  /** `grossMatchedProfit - feesPaid`. */
  realizedPnl: string;
  /** PnL no realizado del inventario abierto, a precio de marca. */
  inventoryPnl: string;
  /** `realizedPnl + inventoryPnl`. */
  totalProfit: string;
  peakInventory: string;
  peakMargin: string;
  /** `grossMatchedProfit / peakMargin * 100`; null sin margen de referencia. */
  efficiencyPct: string | null;
  /** Anualización de `totalProfit` sobre `peakMargin`; null si falta base. */
  aprPct: string | null;
  uptimeSeconds: number;
  lastFillAt: string | null;
}
