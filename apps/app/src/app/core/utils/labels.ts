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
