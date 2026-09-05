import type {
  BotSummary,
  Candle,
  CandleInterval,
  CapitalSnapshot,
  FieldMeta,
  LevelPreview,
  MarketFeatures,
  MarketTicker,
  Mutability,
  PortfolioEquityPoint,
  PortfolioEquitySeries,
  PortfolioRange,
  PreviewResult,
  StrategyMeta,
  VenueCapabilities,
} from '@crypton/shared';

/**
 * Contratos con la API.
 *
 * Los tipos del dominio —campos de estrategia, mutabilidad, preview— se
 * importan de `@crypton/shared` en lugar de redeclararse: son exactamente los
 * mismos que usa el motor, y duplicarlos aquí garantizaría que tarde o temprano
 * dejaran de coincidir.
 */
export type {
  BotSummary,
  Candle,
  CandleInterval,
  CapitalSnapshot,
  FieldMeta,
  LevelPreview,
  MarketFeatures,
  MarketTicker,
  Mutability,
  PortfolioEquityPoint,
  PortfolioEquitySeries,
  PortfolioRange,
  PreviewResult,
  StrategyMeta,
  VenueCapabilities,
};

export type Venue = 'HYPERLIQUID' | 'LIGHTER' | 'ASTER';

export type BotStatus =
  'DRAFT' | 'STARTING' | 'RUNNING' | 'PAUSED' | 'STOPPING' | 'STOPPED' | 'ERROR' | 'LIQUIDATED';

export type StrategyKind =
  | 'GRID_CLASSIC'
  | 'NEUTRAL_GRID'
  | 'TDCA'
  | 'MARTINGALE'
  | 'GRIDMART'
  | 'MARKET_MAKER'
  | 'MARKET_MAKER_V2';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  language: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface ExchangeAccount {
  id: string;
  venue: Venue;
  label: string;
  status: 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'ERROR' | 'REVOKED';
  publicRef: string;
  builderApproved: boolean;
  testnet: boolean;
  /**
   * Conexion de SIMULACION: no tiene claves y no puede firmar nada.
   *
   * Sus bots operan contra el simulador con precios reales de mainnet. Es lo
   * que permite probar sin abrir cuenta en ningun exchange.
   */
  paper: boolean;
  /** Capital de partida del simulador. Solo en las de simulacion. */
  paperBalance: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface Market {
  venue: Venue;
  /** Red del venue. Los mercados de testnet no son los de mainnet. */
  testnet: boolean;
  symbol: string;
  canonical: string;
  base: string;
  quote: string;
  tick_size: string;
  step_size: string;
  min_notional: string | null;
  /** Los pide `MarketSpec` para calcular el preview en local. */
  min_qty: string | null;
  max_qty: string | null;
  max_leverage: number;
  price_decimals: number;
  qty_decimals: number;
  active: boolean;
}

// `BotSummary` viene de `@crypton/shared` y se reexporta arriba: era la tercera
// copia del mismo objeto —la compartida, la que devolvía la API y esta— y las
// tres divergían (spec 002, F-04). Ahora la API lo declara como tipo de retorno
// y aquí solo se lee.
export interface BotDetail extends BotSummary {
  /**
   * Conexión sobre la que opera. Llega desde siempre —el detalle devuelve la
   * fila entera— pero no estaba declarada; la necesita el ajuste de margen para
   * poder leer el margen libre de ESA cuenta.
   */
  exchange_account_id: string;
  /** Modo de margen del bot. COLD: se fija al crear y no se puede cambiar. */
  margin_mode: 'CROSS' | 'ISOLATED';
  config: Record<string, unknown>;
  fields: FieldMeta[];
  config_version: number;
  cycle: BotCycle | null;
  snapshot: BotSnapshot | null;
  openOrdersList: BotOrder[];
  /** null = nunca se publicó. `public: false` = se publicó y se retiró. */
  share: BotShare | null;
}

export interface BotShare {
  shareCode: string;
  public: boolean;
  copies: number;
}

export interface BotCycle {
  seq: number;
  opened_at: string;
  closed_at: string | null;
  entries_filled: number;
  filled_level_indexes: number[];
  cooldown_until: string | null;
  anchor_price: string | null;
  average_entry: string | null;
  /** Precio medio de SALIDA del ciclo. La base lo guarda desde siempre; faltaba declararlo. */
  exit_avg: string | null;
  qty: string;
  realized_pnl: string;
  fees: string;
}

/** Un cambio de una revisión, tal y como lo escribió `PATCH /bots/:id/config`. */
export interface ConfigChange {
  key: string;
  from?: unknown;
  to?: unknown;
  mutability?: Mutability;
  labelKey?: string;
}

/** Una entrada de `GET /bots/:id/revisions` (spec 006). La v1 no tiene `diff`. */
export interface BotConfigRevision {
  id: string;
  version: number;
  createdAt: string;
  applyLevel: Mutability | null;
  appliedBy: string | null;
  diff: ConfigChange[] | null;
}

export interface BotSnapshot {
  equity: string;
  position_qty: string;
  average_entry: string | null;
  mark_price: string;
  unrealized_pnl: string;
  realized_pnl_acc: string;
  margin_used: string;
  liquidation_price: string | null;
  open_orders: number;
  taken_at: string;
}

export interface BotOrder {
  client_order_id: string;
  venue_order_id: string | null;
  level_kind: string;
  level_index: number;
  cycle_seq: number;
  side: 'BUY' | 'SELL';
  kind: 'LIMIT' | 'MARKET' | 'POST_ONLY';
  price: string;
  qty: string;
  filled_qty: string;
  status: string;
  reduce_only: boolean;
  raw_error: string | null;
  avg_price: string | null;
  placed_at: string;
  /** Cuando dejo de estar viva. Es lo que situa una ejecucion en el grafico. */
  closed_at: string | null;
}

/**
 * Un nivel de la escalera DESEADA, tal y como lo sirve `GET /bots/:id/levels`.
 *
 * No confundir con `BotOrder`, que es lo que hay puesto en el exchange. Este es
 * el plan: los niveles en `PLANNED` todavia no existen para el venue, y son
 * justo los que dicen hasta donde aguanta el bot si el precio sigue yendo en
 * contra. Sin ellos, el grafico solo enseña el tramo ya tendido.
 */
export type LevelKind =
  | 'BASE'
  | 'SAFETY'
  | 'GRID_BUY'
  | 'GRID_SELL'
  | 'TAKE_PROFIT'
  | 'STOP_LOSS'
  | 'QUOTE_BID'
  | 'QUOTE_ASK';

export type LevelState = 'PLANNED' | 'PLACED' | 'FILLED' | 'CANCELED';

export interface BotLevel {
  /** `BigInt` en la base; llega como cadena porque la API lo serializa asi. */
  id: string;
  bot_id: string;
  cycle_seq: number;
  kind: LevelKind;
  level_index: number;
  state: LevelState;
  target_price: string;
  target_qty: string;
  /** Cierra posicion en vez de abrirla. Es lo que da el lado del nivel. */
  reduce_only: boolean;
  /** La misma clave que `BotOrder.client_order_id` cuando llega a colocarse. */
  client_order_id: string;
  updated_at: string;
}

/** Una ejecucion del ledger, tal y como la sirve `GET /bots/:id/fills`. */
export interface BotFill {
  id: string;
  venue_fill_id: string;
  side: 'BUY' | 'SELL';
  price: string;
  qty: string;
  fee: string;
  fee_asset: string;
  is_taker: boolean;
  executed_at: string;
  order: { level_kind: string; level_index: number; cycle_seq: number };
}

/**
 * Recomendaciones de configuracion, tal y como las sirve `POST /advisor/bot-config`.
 *
 * Las calcula el SERVIDOR y ya vienen validadas contra la spec del mercado y los
 * topes del usuario: la app no genera ninguna configuracion por su cuenta.
 */
export type RecommendationProfile = 'PRUDENTE' | 'EQUILIBRADA' | 'AGRESIVA';

export interface RecommendedProfile {
  profile: RecommendationProfile;
  /** De donde salieron las perillas: del modelo o de las reglas deterministas. */
  source: 'IA' | 'REGLAS';
  config: Record<string, unknown>;
  /** El riesgo, ya calculado, para poder verlo ANTES de aplicar nada. */
  headline: {
    leverage: number;
    worstCaseMargin: string;
    worstCaseNotional: string;
    liquidationDistancePct: string | null;
    levels: number;
  };
  rationale: string;
  warnings: string[];
}

export interface RecommendationSet {
  strategy: StrategyKind;
  venue: Venue;
  symbol: string;
  /** El precio con el que se calculo todo. */
  refPrice: string;
  source: 'IA' | 'REGLAS' | 'MIXTO';
  /** Por que faltan perfiles, si faltan. Se pinta tal cual. */
  notice: string | null;
  market: { atrPct1d: number; rangePct30: number; trend: string } | null;
  profiles: RecommendedProfile[];
}

/** Capacidades de las tres plataformas, tal y como llegan de la API. */
export type VenueCapabilitiesMap = Record<Venue, VenueCapabilities>;

export interface BotEvent {
  id: string;
  type: string;
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  message: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface RiskLimits {
  max_notional_per_bot: string | null;
  max_total_notional: string | null;
  max_leverage: number | null;
  max_open_bots: number | null;
  max_daily_loss: string | null;
  kill_switch_drawdown_pct: string | null;
  liquidation_alert_pct: string | null;
}

/** Descriptor de estrategia tal y como lo devuelve `GET /bots/strategies`. */
export interface StrategyDescriptor {
  kind: StrategyKind;
  labelKey: string;
  descriptionKey: string;
  fields: FieldMeta[];
  defaults: Record<string, unknown>;
}

/**
 * Ficha de market making. Espejo de `MarketMakerStats` en @crypton/shared.
 *
 * `efficiencyPct` y `aprPct` llegan null —y no cero— cuando aun no hay margen
 * de referencia o el bot lleva menos de una hora: un bot recien arrancado no
 * tiene un 0 % de eficiencia, no tiene eficiencia todavia.
 */
export interface MarketMakerStats {
  botId: string;
  fills: number;
  buyFills: number;
  sellFills: number;
  makerFills: number;
  takerFills: number;
  closedCycles: number;
  grossMatchedProfit: string;
  feesPaid: string;
  realizedPnl: string;
  inventoryPnl: string;
  totalProfit: string;
  peakInventory: string;
  peakMargin: string;
  efficiencyPct: string | null;
  aprPct: string | null;
  uptimeSeconds: number;
  lastFillAt: string | null;
}

export const BOT_COMMANDS = [
  'START',
  'PAUSE',
  'RESUME',
  'STOP_KEEP_POSITION',
  'STOP_AND_CLOSE',
  'CLOSE_NOW',
  'TAKE_PROFIT_NOW',
  'ADD_SAFETY_NOW',
  'REANCHOR_GRID',
  'CANCEL_ALL_ORDERS',
  'PANIC',
  'REPAIR',
  'ADJUST_MARGIN',
] as const;

export type BotCommand = (typeof BOT_COMMANDS)[number];

/** Sentido de un ajuste de colateral sobre una posición aislada. */
export type MarginAction = 'ADD' | 'REMOVE';

/**
 * Argumentos de `ADJUST_MARGIN`.
 *
 * `countAsBotCapital` NO mueve la liquidación: eso lo hace la transferencia al
 * venue, que ocurre de todas formas. Esto solo decide si además sube el capital
 * asignado del bot para que el ROI y la APR reflejen el dinero real.
 */
export interface MarginAdjustment {
  /** Importe en la quote. SIEMPRE positivo; el sentido va en `action`. */
  amount: string;
  action: MarginAction;
  countAsBotCapital?: boolean;
}

/** Comandos que cierran posición a mercado: la UI pide confirmar siempre. */
export const DESTRUCTIVE_COMMANDS: readonly BotCommand[] = ['STOP_AND_CLOSE', 'CLOSE_NOW', 'PANIC'];

/** Mensaje que llega por el flujo SSE de la API. */
export interface BotStreamEvent {
  type: string;
  botId?: string;
  data: Record<string, unknown>;
  ts: number;
}
