import type { ClaveIndicador } from '@crypton/strategy-core';
import type { BotStatus, StrategyKind, Venue } from '../models';

/**
 * Vocabulario visible de la app.
 *
 * Estos mapas estaban copiados: el de estrategias vivia igual en
 * bots-list y en leaderboard, y el de estados en bots-list y bot-detail.
 * Copiado significa que tarde o temprano un bot se llama "Rejilla" en una
 * pantalla y "Grid" en otra.
 */

export const BOT_STATUS_LABELS: Record<BotStatus, string> = {
  DRAFT: 'borrador',
  STARTING: 'arrancando',
  RUNNING: 'operando',
  PAUSED: 'pausado',
  STOPPING: 'parando',
  STOPPED: 'parado',
  ERROR: 'error',
  LIQUIDATED: 'liquidado',
};

export type StatusTone = 'up' | 'down' | 'warn' | 'flat' | 'brand' | 'critical';

/**
 * Color de cada estado.
 *
 * `PAUSED` va en ambar y no en gris a proposito: un bot pausado NO esta
 * trabajando, y eso es justo lo que hay que ver de un vistazo en una lista
 * larga. `STOPPING` sin embargo es un transito de segundos y no merece
 * llamar la atencion.
 */
export const BOT_STATUS_TONES: Record<BotStatus, StatusTone> = {
  DRAFT: 'flat',
  STARTING: 'brand',
  RUNNING: 'up',
  PAUSED: 'warn',
  STOPPING: 'flat',
  STOPPED: 'flat',
  ERROR: 'down',
  LIQUIDATED: 'critical',
};

export const STRATEGY_LABELS: Record<StrategyKind, string> = {
  GRID_CLASSIC: 'Rejilla',
  NEUTRAL_GRID: 'Rejilla neutral',
  TDCA: 'DCA temporizado',
  MARTINGALE: 'Martingala',
  GRIDMART: 'GridMart',
  MARKET_MAKER: 'Market maker',
  MARKET_MAKER_V2: 'Market maker V2',
  TREND_FOLLOW: 'Tendencia',
  TRAILING_PROFIT: 'Seguimiento de beneficio',
  AI_CHANNEL: 'Canal con IA',
  AGENT_TRADE: 'Operación IA',
};

/**
 * Una linea que explica cada estrategia en el selector.
 *
 * Estaba duplicada dentro de `bot-create.page.ts` junto a otra copia de
 * `STRATEGY_LABELS`. Dos mapas con las mismas claves en dos ficheros distintos
 * es exactamente como una estrategia nueva acaba saliendo con su nombre en un
 * sitio y con la constante cruda en el otro.
 */
export const STRATEGY_BLURBS: Record<StrategyKind, string> = {
  GRID_CLASSIC: 'Compra abajo y vende arriba dentro de un rango.',
  NEUTRAL_GRID: 'Dos lados alrededor de un ancla, con tope de exposicion.',
  TDCA: 'Compra cada X minutos solo si mejora el precio medio.',
  MARTINGALE: 'Ordenes de seguridad que se alejan y crecen.',
  GRIDMART: 'Martingala con rejilla de ventas y recompras.',
  MARKET_MAKER: 'Cotiza a los dos lados y cobra el diferencial.',
  MARKET_MAKER_V2: 'Diferencial compuesto con volatilidad, libro y coste de operar.',
  TREND_FOLLOW:
    'Entra cuando el precio rompe su rango y sale con un stop que le sigue. La unica que gana en linea recta.',
  TRAILING_PROFIT:
    'Una operacion que deja correr el beneficio: al llegar a tu objetivo sigue al maximo y cierra al retroceder.',
  AI_CHANNEL:
    'Rebotes en el borde de un rango o canal, con el apalancamiento que permite el stop. Una IA elige entre operaciones ya calculadas.',
  AGENT_TRADE:
    'La operación de un agente de IA: entra una vez, con stop y objetivos nativos, y se detiene al cerrarse.',
};

/** Las dos estrategias que llevan ficha de market making. */
export const MARKET_MAKER_KINDS: readonly StrategyKind[] = ['MARKET_MAKER', 'MARKET_MAKER_V2'];

export const isMarketMaker = (kind: StrategyKind): boolean => MARKET_MAKER_KINDS.includes(kind);

/** Los exchanges se escriben como su marca, no como la constante del enum. */
export const VENUE_LABELS: Record<Venue, string> = {
  HYPERLIQUID: 'Hyperliquid',
  LIGHTER: 'Lighter',
  ASTER: 'Aster',
};

export function botStatusLabel(status: BotStatus): string {
  return BOT_STATUS_LABELS[status] ?? status;
}

export function botStatusTone(status: BotStatus): StatusTone {
  return BOT_STATUS_TONES[status] ?? 'flat';
}

/** Acepta `string` y no `StrategyKind` a proposito: la estrategia puede llegar
 * de la API con un valor que esta version de la app aun no conoce, y el caso
 * se resuelve con el `??` de abajo en vez de romper la pantalla. */
export function strategyLabel(kind: string): string {
  return STRATEGY_LABELS[kind as StrategyKind] ?? kind;
}

/**
 * La linea que explica la estrategia.
 *
 * Se usa en el selector del asistente y tambien en la cabecera del detalle: el
 * nombre que el usuario le pone al bot no dice que hace, y «GridMart» tampoco
 * si se creo hace tres semanas. Devuelve cadena vacia para una estrategia
 * desconocida en vez de la constante cruda, porque ahi se lee como un parrafo.
 */
export function strategyBlurb(kind: string): string {
  return STRATEGY_BLURBS[kind as StrategyKind] ?? '';
}

export function venueLabel(venue: string): string {
  return VENUE_LABELS[venue as Venue] ?? venue;
}

/**
 * Etiqueta de un intervalo de vela.
 *
 * Los minutos van en minúscula y las horas en mayúscula —`15m`, `1H`— porque es
 * la convención de todos los terminales de trading, y una `m` de minuto junto a
 * una `M` de mes que se leyeran igual sería un error caro.
 */
export function intervalLabel(interval: string): string {
  if (interval === '1M') return '1M';
  if (interval === '1w') return '1S';
  return interval.replace(/([hd])$/, (m) => m.toUpperCase());
}

/**
 * Lo que dice cada suceso del motor, en castellano.
 *
 * La pestaña de eventos es la unica pantalla que existe para mirar cuando algo
 * no cuadra, y pintaba las constantes crudas —`RISK_GUARD_TRIPPED`,
 * `FAIR_PRICE_STALE`— en mayusculas y en ingles (spec 002, F-08). La lista es
 * la que emite el worker (`bot-runner.ts`, `notifier.service.ts`) mas el alta
 * de la API; un tipo nuevo que no este aqui sale con su constante, como hacen
 * las demas funciones de este fichero, para que añadir un evento en el motor no
 * rompa la pantalla.
 */
export const EVENT_LABELS: Record<string, string> = {
  BOT_CREATED: 'Bot creado',
  BOT_STARTED: 'Bot arrancado',
  BOT_PAUSED: 'Bot pausado',
  BOT_RESUMED: 'Bot reanudado',
  BOT_STOPPED: 'Bot parado',
  BOT_ADOPTED: 'Adoptado por otro worker',
  BOT_REPAIRED: 'Resincronizado con el exchange',
  START_FAILED: 'No se pudo arrancar',
  CONFIG_RELOADED: 'Configuracion recargada',
  FILL: 'Ejecucion',
  CYCLE_CLOSED: 'Ciclo cerrado',
  SAFETY_ADDED: 'Orden de seguridad añadida',
  ADD_SAFETY_SKIPPED: 'Orden de seguridad omitida',
  GRID_REANCHORED: 'Reticula recentrada',
  ORDERS_CANCELED: 'Ordenes canceladas',
  ORDER_REJECTED: 'Orden rechazada por el exchange',
  ORDER_UNVIABLE: 'Orden inviable en este mercado',
  ORDER_RETRY: 'Orden reintentada',
  INSUFFICIENT_FUNDS: 'Fondos insuficientes',
  POSITION_BELOW_MINIMUM: 'Resto por debajo del minimo del venue',
  EXIT_PENDING_MIN_SIZE: 'Salida pendiente: tamaño minimo',
  CLOSE_SKIPPED: 'Cierre omitido',
  LEVERAGE_SKIPPED: 'Apalancamiento no aplicado',
  POSITION_MODE_SKIPPED: 'Modo de posicion no aplicado',
  MARGIN_ADJUSTED: 'Margen ajustado',
  MARKET_SPEC_CHANGED: 'El mercado cambio sus reglas',
  FAIR_PRICE_STALE: 'Precio de referencia desfasado',
  FAIR_PRICE_UNAVAILABLE: 'Precio de referencia no disponible',
  RISK_GUARD_TRIPPED: 'Guarda de riesgo disparada',
  RISK_GUARD_CLEARED: 'La guarda ya no se cumple',
  LIQUIDATION_NEAR: 'Liquidacion cerca',
  LIQUIDATED: 'Posicion liquidada',
  PANIC: 'Panico: todo cancelado y cerrado',
  TICK_ERROR: 'Error en un ciclo del motor',
  TICK_SLOW: 'El bot no mantiene su ritmo',
  STREAM_ERROR: 'Error en la conexion en vivo',
  STREAM_RECOVERED: 'Conexion en vivo restablecida',
  VENUE_UNAVAILABLE: 'El exchange no responde',
  VENUE_RECOVERED: 'El exchange vuelve a responder',
  AUTH_ERROR: 'Credencial rechazada por el exchange',
  ACTION_FAILED: 'Accion fallida',
  COMMAND_FAILED: 'Comando no ejecutado',
  // El Modo IA (spec 046). Salían con la constante tal cual hasta el spec 053.
  AI_MODE: 'Modo IA cambiado',
  AI_SUGGESTION: 'Sugerencia de la IA',
  AI_APPLIED: 'Ajuste aplicado por la IA',
  AI_ADVICE: 'La IA pide revisar el bot',
  // Lo emiten el Modo IA (un cambio que no se aplicó) y el canal con IA (fallos
  // seguidos del modelo): el texto vale para los dos.
  AI_FAILED: 'La IA no pudo actuar',
  // El canal con IA (specs 058-059). `AI_EXIT` sustituye a `CYCLE_CLOSED`.
  AI_DECISION: 'Decisión de la IA',
  AI_ENTRY: 'Operación abierta',
  AI_EXIT: 'Operación cerrada',
  AI_CIERRE: 'Cierre a mercado ordenado',
  AI_ENTRY_DISCARDED: 'Entrada descartada',
  AI_DAY_STOP: 'Tope diario alcanzado',
  AI_BREAKEVEN: 'Stop llevado a la entrada',
  AI_CIERRE_FALLIDO: 'El cierre a mercado falló',
  AI_POSICION_HUERFANA: 'Posición sin plan',
  AI_OPERACION_PERDIDA: 'Operación cerrada fuera del bot',
  SIN_STOP: 'Posición sin stop confirmado',
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

/**
 * Estado de una orden, en castellano. El detalle pintaba `PARTIALLY_FILLED` al
 * lado de un nivel que el grafico ya llamaba `GRID#3` (spec 002, F-09).
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'enviando',
  OPEN: 'en el libro',
  PARTIALLY_FILLED: 'parcial',
  FILLED: 'ejecutada',
  CANCELED: 'cancelada',
  REJECTED: 'rechazada',
  EXPIRED: 'caducada',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

/**
 * Los indicadores del gráfico (spec 061).
 *
 * `Record` completo sobre las claves del catálogo de `strategy-core`: un
 * indicador nuevo sin nombre ni explicación no compila. La explicación es de
 * una frase y dice lo que se ve, no lo que hay que hacer con ello: es contexto,
 * no un consejo.
 */
export const INDICADOR_LABELS: Record<ClaveIndicador, { etiqueta: string; explicacion: string }> = {
  BOLLINGER: {
    etiqueta: 'Bandas de Bollinger',
    explicacion: 'Media de 20 velas y dos desviaciones a cada lado.',
  },
  SMA50: {
    etiqueta: 'Media 50',
    explicacion: 'El precio medio de las últimas 50 velas.',
  },
  EMA20: {
    etiqueta: 'Media exponencial 20',
    explicacion: 'Como la media, pero pesa más lo reciente.',
  },
  RSI: {
    etiqueta: 'RSI 14',
    explicacion: 'Fuerza del movimiento, de 0 a 100. Ocupa el panel de abajo.',
  },
  ATR: {
    etiqueta: 'ATR 14',
    explicacion: 'Cuánto se mueve una vela, en precio. Ocupa el panel de abajo.',
  },
};
