/**
 * Enums del dominio. Los valores string coinciden EXACTAMENTE con los enums de
 * Prisma (apps/api/prisma/schema.prisma): así una fila de la BD se puede pasar
 * a estas funciones sin traducir nada por el camino.
 */

export const Venue = {
  HYPERLIQUID: 'HYPERLIQUID',
  LIGHTER: 'LIGHTER',
  ASTER: 'ASTER',
} as const;
export type Venue = (typeof Venue)[keyof typeof Venue];

/**
 * Venue y red en una sola cadena, para claves de cache y de memoria.
 *
 * MAINNET NO LLEVA SUFIJO, y eso es deliberado: la clave de mainnet sigue
 * siendo byte a byte la que era antes de que existiera testnet. Anadir la red
 * tambien alli habria dejado huerfano de golpe todo lo cacheado en el momento
 * del despliegue —precios, tickers, velas—, y la primera pantalla despues de
 * reiniciar se habria abierto vacia mientras se repoblaba.
 *
 * El separador es `:` y el sufijo `t`. Ningun simbolo de los tres venues puede
 * llevar `:` (lo prohibe el filtro de simbolos del stream), asi que
 * `LIGHTER:t` nunca colisiona con un venue ni con un par.
 */
export const venueKey = (venue: Venue, testnet = false): string => (testnet ? `${venue}:t` : venue);

export const StrategyKind = {
  GRID_CLASSIC: 'GRID_CLASSIC',
  NEUTRAL_GRID: 'NEUTRAL_GRID',
  TDCA: 'TDCA',
  MARTINGALE: 'MARTINGALE',
  GRIDMART: 'GRIDMART',
  MARKET_MAKER: 'MARKET_MAKER',
  MARKET_MAKER_V2: 'MARKET_MAKER_V2',
  /** Seguimiento de tendencia: la unica que gana en linea recta (spec 040). */
  TREND_FOLLOW: 'TREND_FOLLOW',
  /** Entra una vez y sale siguiendo al maximo desde su objetivo (spec 043). */
  TRAILING_PROFIT: 'TRAILING_PROFIT',
} as const;
export type StrategyKind = (typeof StrategyKind)[keyof typeof StrategyKind];

/**
 * STARTING/STOPPING son estados de transición: existen para que la UI no mienta
 * mientras el worker adquiere el lease o cancela órdenes, que no es instantáneo.
 * LIQUIDATED es terminal y lo marca el propio worker al detectar que el venue
 * cerró la posición por margen.
 */
export const BotStatus = {
  DRAFT: 'DRAFT',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
  LIQUIDATED: 'LIQUIDATED',
} as const;
export type BotStatus = (typeof BotStatus)[keyof typeof BotStatus];

export const OrderSide = { BUY: 'BUY', SELL: 'SELL' } as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = {
  LIMIT: 'LIMIT',
  MARKET: 'MARKET',
  /** Limit que el venue rechaza si cruzaría el libro (maker garantizado). */
  POST_ONLY: 'POST_ONLY',
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const TimeInForce = { GTC: 'GTC', IOC: 'IOC', FOK: 'FOK', ALO: 'ALO' } as const;
export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];

export const MarginMode = { CROSS: 'CROSS', ISOLATED: 'ISOLATED' } as const;
export type MarginMode = (typeof MarginMode)[keyof typeof MarginMode];

/**
 * Sentido de un ajuste de colateral sobre una posición aislada.
 *
 * Va aparte del importe a propósito: el importe es siempre positivo y esto
 * dice qué hacer con él. Codificar el sentido en el signo dejaba que un
 * importe ya negado por el llamante retirase margen creyendo que lo aportaba,
 * y en aislado eso ACERCA la liquidación en vez de alejarla.
 */
export const MarginAction = { ADD: 'ADD', REMOVE: 'REMOVE' } as const;
export type MarginAction = (typeof MarginAction)[keyof typeof MarginAction];

/**
 * Lado de una posición abierta. NO es `Direction`: aquella es lo que el
 * usuario configuró —y admite `NEUTRAL` en los market makers—, y esto es el
 * signo de lo que hay abierto ahora mismo en el venue, que es lo que
 * Hyperliquid y Aster necesitan para saber qué caja tocar.
 */
export const PositionSide = { LONG: 'LONG', SHORT: 'SHORT' } as const;
export type PositionSide = (typeof PositionSide)[keyof typeof PositionSide];

export const PositionMode = { ONE_WAY: 'ONE_WAY', HEDGE: 'HEDGE' } as const;
export type PositionMode = (typeof PositionMode)[keyof typeof PositionMode];

/**
 * Lo que el usuario elige, que NO es lo mismo que lo que se le manda al venue.
 *
 * `AUTO` significa «no lo toques»: se respeta el modo que ya tenga la cuenta.
 * Es un valor de configuración, no de adaptador, y por eso vive en un tipo
 * aparte: `setPositionMode()` solo puede recibir un modo de verdad, y quitar
 * `AUTO` por descarte deja exactamente `PositionMode` sin ninguna conversión.
 */
export const PositionModeSetting = {
  AUTO: 'AUTO',
  ONE_WAY: 'ONE_WAY',
  HEDGE: 'HEDGE',
} as const;
export type PositionModeSetting = (typeof PositionModeSetting)[keyof typeof PositionModeSetting];

export const Direction = { LONG: 'LONG', SHORT: 'SHORT', NEUTRAL: 'NEUTRAL' } as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** Qué papel juega un nivel dentro de la escalera de una estrategia. */
export const LevelKind = {
  BASE: 'BASE',
  SAFETY: 'SAFETY',
  GRID_BUY: 'GRID_BUY',
  GRID_SELL: 'GRID_SELL',
  TAKE_PROFIT: 'TAKE_PROFIT',
  STOP_LOSS: 'STOP_LOSS',
  QUOTE_BID: 'QUOTE_BID',
  QUOTE_ASK: 'QUOTE_ASK',
} as const;
export type LevelKind = (typeof LevelKind)[keyof typeof LevelKind];

export const OrderStatus = {
  PENDING: 'PENDING',
  OPEN: 'OPEN',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const AccountStatus = {
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  ACTIVE: 'ACTIVE',
  ERROR: 'ERROR',
  REVOKED: 'REVOKED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const EventSeverity = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
} as const;
export type EventSeverity = (typeof EventSeverity)[keyof typeof EventSeverity];

/**
 * Quién ejecuta una acción registrada en la bitácora de actividad.
 *
 * `ANON` no es un hueco: una petición rechazada por el guard de sesión —un
 * token caducado, un intento de fuerza bruta— no tiene usuario, y es
 * precisamente la que interesa poder contar.
 */
export const ActorKind = {
  USER: 'USER',
  ADMIN: 'ADMIN',
  WORKER: 'WORKER',
  SYSTEM: 'SYSTEM',
  ANON: 'ANON',
} as const;
export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

/** Cómo acabó la acción. Es lo que separa «qué se hizo» de «qué falló». */
export const AuditOutcome = {
  OK: 'OK',
  DENIED: 'DENIED',
  ERROR: 'ERROR',
} as const;
export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

export const RiskProfile = {
  CONSERVATIVE: 'CONSERVATIVE',
  BALANCED: 'BALANCED',
  AGGRESSIVE: 'AGGRESSIVE',
} as const;
export type RiskProfile = (typeof RiskProfile)[keyof typeof RiskProfile];

export const GridSpacing = { ARITHMETIC: 'ARITHMETIC', GEOMETRIC: 'GEOMETRIC' } as const;
export type GridSpacing = (typeof GridSpacing)[keyof typeof GridSpacing];

export const SizingMode = { QUOTE: 'QUOTE', BASE: 'BASE' } as const;
export type SizingMode = (typeof SizingMode)[keyof typeof SizingMode];

/**
 * Qué hace el bot cuando la posición alcanza su tope.
 *
 * `PAUSE_ENTRIES` es el comportamiento histórico y el único que no realiza
 * pérdidas por su cuenta: deja de añadir y sigue cotizando la salida. Los otros
 * dos SÍ tocan la posición, así que la UI los marca como sensibles al riesgo.
 */
export const LimitAction = {
  PAUSE_ENTRIES: 'PAUSE_ENTRIES',
  CLOSE_ALL: 'CLOSE_ALL',
  SHUTDOWN: 'SHUTDOWN',
} as const;
export type LimitAction = (typeof LimitAction)[keyof typeof LimitAction];

/**
 * Qué hacer cuando la posición se acerca a la liquidación.
 *
 * `ALERT` es el comportamiento histórico —y el que se mantiene por defecto—:
 * avisa y no toca nada. Es deliberado; cambiarle la conducta a un bot que ya
 * está corriendo sin que su dueño lo pida sería peor que el hueco que tapa.
 *
 * No se reutiliza `LimitAction` aunque se le parezca: aquella la interpreta la
 * estrategia sobre un tope de inventario y distingue «dejar de entrar» de
 * «cerrar»; esta la evalúa el motor sobre la distancia a liquidación, donde
 * dejar de entrar no defiende de nada —lo que mata es lo que ya está abierto.
 */
export const LiquidationAction = {
  ALERT: 'ALERT',
  PAUSE: 'PAUSE',
  CLOSE_ALL: 'CLOSE_ALL',
} as const;
export type LiquidationAction = (typeof LiquidationAction)[keyof typeof LiquidationAction];

/**
 * De dónde sale el «precio justo» contra el que se cotiza.
 *
 * `EXCHANGE` es el propio venue y no necesita nada más. `BINANCE` abre un feed
 * público externo en el worker: si ese feed se queda rancio, la estrategia DEJA
 * DE COTIZAR — cotizar contra un precio viejo es regalar el diferencial.
 *
 * Hubo una tercera, CoinGecko, y se retiró porque no daba el ancho: su plan
 * gratuito reparte unas treinta llamadas por minuto PARA TODA LA INSTALACIÓN,
 * su sondeo mínimo viable coincidía con el umbral de precio rancio —así que un
 * bot anclado a ella parpadeaba y dejaba de cotizar en funcionamiento normal— y
 * su plan de pago exige otra cabecera y otro host. Binance no tiene ninguno de
 * esos problemas y es el libro más líquido, que es lo que se busca al anclarse
 * fuera.
 */
export const PriceSource = {
  EXCHANGE: 'EXCHANGE',
  BINANCE: 'BINANCE',
} as const;
export type PriceSource = (typeof PriceSource)[keyof typeof PriceSource];

/** Qué mercado de la fuente externa se consulta. */
export const SourceMarketType = { PERP: 'PERP', SPOT: 'SPOT', INDEX: 'INDEX' } as const;
export type SourceMarketType = (typeof SourceMarketType)[keyof typeof SourceMarketType];

/**
 * De dónde salen las velas históricas de un backtest.
 *
 * Es un enum aparte de `PriceSource` aunque compartan a Binance, y no es
 * duplicar por gusto: aquél dice contra qué precio COTIZA un bot vivo —una
 * decisión de dinero, con su umbral de precio rancio— y este dice de dónde se
 * leen unas velas cerradas para reproducir el pasado. Mezclarlos obligaría a que
 * cada fuente nueva de una cosa tuviera sentido en la otra, y no lo tiene:
 * `EXCHANGE` no significa nada aquí, y `VENUE` no significa nada allí.
 */
export const BacktestSource = {
  BINANCE: 'BINANCE',
  BYBIT: 'BYBIT',
} as const;
export type BacktestSource = (typeof BacktestSource)[keyof typeof BacktestSource];

/**
 * Cómo se combina el precio de la fuente con el del venue.
 *
 * `SOURCE_GLOBAL` toma el precio de la fuente tal cual. `VENUE_MID`/`VENUE_MARK`
 * ignoran la fuente y usan el venue —son el escape para volver atrás sin
 * reconfigurar el bloque entero.
 */
export const FairPriceOrigin = {
  SOURCE_GLOBAL: 'SOURCE_GLOBAL',
  VENUE_MID: 'VENUE_MID',
  VENUE_MARK: 'VENUE_MARK',
} as const;
export type FairPriceOrigin = (typeof FairPriceOrigin)[keyof typeof FairPriceOrigin];

/** Condición que debe cumplirse antes de que el bot empiece a cotizar. */
export const ActivationMode = {
  NONE: 'NONE',
  PRICE_ABOVE: 'PRICE_ABOVE',
  PRICE_BELOW: 'PRICE_BELOW',
} as const;
export type ActivationMode = (typeof ActivationMode)[keyof typeof ActivationMode];

/**
 * Que hace el supervisor de IA con un bot (spec 046).
 *
 * Calca `AiMode` de Prisma valor a valor, como el resto de este fichero.
 *
 * `OFF` es el estado de todo bot que no lo haya encendido, y no hay fila en
 * `bot_ai_settings` para la inmensa mayoria: ausencia y `OFF` significan lo
 * mismo, y quien lee tiene que tratarlos igual.
 */
export const AiMode = {
  OFF: 'OFF',
  /** Propone y espera: no toca nada hasta que una persona aprueba. */
  MANUAL: 'MANUAL',
  /** Decide y aplica, dentro de los topes de la traduccion determinista. */
  AUTO: 'AUTO',
} as const;
export type AiMode = (typeof AiMode)[keyof typeof AiMode];

/** En que acabo una decision del supervisor (spec 046). */
export const AiDecisionState = {
  PROPUESTA: 'PROPUESTA',
  APLICADA: 'APLICADA',
  /** El modelo pidio que lo mirase una persona, sin proponer cambio. */
  AVISADA: 'AVISADA',
  RECHAZADA: 'RECHAZADA',
  CADUCADA: 'CADUCADA',
  DESCARTADA: 'DESCARTADA',
  FALLIDA: 'FALLIDA',
} as const;
export type AiDecisionState = (typeof AiDecisionState)[keyof typeof AiDecisionState];
