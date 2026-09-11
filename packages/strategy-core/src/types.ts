import type {
  BotConfig,
  CandleInterval,
  CommonBotConfig,
  BotContext,
  CycleState,
  DesiredState,
  Fill,
  MarketSpec,
  PreviewResult,
  StrategyKind,
  StrategyMeta,
  ValidationResult,
} from '@crypton/shared';

/**
 * Contrato de una estrategia. Todo aquí es PURO: mismas entradas, mismas
 * salidas, sin efectos. Esa es la propiedad que hace que el motor pueda
 * limitarse a converger el resultado de `plan()` contra el estado real, y que
 * la suite de tests pueda cubrir la lógica de dinero sin levantar nada.
 */
export interface Strategy<C extends CommonBotConfig = BotConfig> {
  readonly kind: StrategyKind;
  /** Descriptores de campo: la app genera el formulario a partir de esto. */
  readonly meta: StrategyMeta;

  /**
   * true = esta estrategia REUTILIZA el mismo id de orden para colocaciones
   * sucesivas dentro de un ciclo (recotizaciones del market maker, líneas de
   * una retícula que se rearman, escalones que vuelven tras su recompra).
   *
   * Lo consume el motor: por defecto, una fila ya EJECUTADA con ese id veta
   * volver a colocarlo —es la red que impide duplicar una entrada a mercado
   * cuyo fill aún no se ha asimilado—. Las estrategias que declaran esto se
   * comprometen a que su `plan()` solo vuelva a desear un id cuando toca
   * (deadband, lista de recompras, hueco liberado), y a cambio el motor les
   * permite recolocarlo. Sin esta pieza, cada cotización del market maker
   * moría tras su primera ejecución completa y no revivía hasta que la
   * posición pasara por cero.
   */
  readonly reusesOrderSlots?: boolean;

  /**
   * true = cuando se ejecuta la SALIDA de un nivel (GRID_SELL), el nivel debe
   * liberarse en `filledLevelIndexes` para poder comprarse otra vez.
   *
   * Solo Grid Classic: su juego es exactamente comprar abajo, vender arriba y
   * REPETIR, y sin esto cada nivel operaba una única vez por ciclo. GridMart
   * NO puede activarlo: sus seguridades comparten espacio de índices con su
   * rejilla de ventas, y liberar el índice de una venta borraría la marca de
   * una seguridad ya comprada — se recompraría sola.
   */
  readonly recycleLevelOnExit?: boolean;

  /**
   * true = las recompras (GRID_BUY) de la estrategia NO marcan su índice en
   * `filledLevelIndexes`.
   *
   * GridMart: la rejilla de ventas y sus recompras reutilizan índice con las
   * seguridades (SAFETY#j ↔ GRID_SELL#j/GRID_BUY#j). Contabilizar la recompra
   * como escalón tomado hacía desaparecer del plan la seguridad j para el resto
   * del ciclo (001/F-82). La recompra sigue sumando a la posición y al medio;
   * solo deja de ocupar un escalón que no es suyo.
   */
  readonly rebuysOffLevelIndexes?: boolean;

  /**
   * true = quedar plana la posición NO cierra el ciclo.
   *
   * Para un market maker «quedar plano» es el final de cada par casado, no de
   * una operación: cerrar el ciclo ahí cambiaba los ids de todas las capas (el
   * reconciliador las cancelaba y reponía, perdiendo el sitio en el libro),
   * borraba la cotización vigente, la espera tras el fill, las muestras de
   * volatilidad y el armado de la condición de activación (001/F-58, F-62).
   * Con esto el ciclo es la vida del bot hasta que se para o se cierra a mano.
   */
  readonly keepCycleOnFlat?: boolean;

  /**
   * Velas que esta estrategia necesita en `plan()`, si necesita alguna.
   *
   * Va en el CÓDIGO y no en la configuración del usuario a propósito: así el
   * principio del motor —reconciliar contra el libro y no contra un gráfico—
   * sigue valiendo para todas las que no la declaran, y es imposible encender
   * por descuido un sondeo de velas en un bot que no las usa.
   *
   * El motor las sirve de una caché compartida por `(venue, símbolo,
   * intervalo)`: N bots del mismo par son una petición (spec 038).
   *
   * Es una FUNCIÓN de la configuración y no una constante porque el intervalo
   * es del bot, no de la estrategia: dos bots de tendencia sobre el mismo par
   * pueden querer uno velas de 1 h y otro de 1 d (spec 040).
   */
  readonly candles?: (config: C) => { interval: CandleInterval; bars: number };

  /** Valores por defecto sensatos para un usuario que empieza. */
  defaults(): Record<string, unknown>;

  /** Coherencia de la config contra la spec del mercado. No toca red. */
  validate(config: C, market: MarketSpec): ValidationResult;

  /**
   * La escalera completa que se tendería, nivel a nivel, con el peor caso.
   * Es lo que se pinta antes de crear el bot y lo que bloquea la creación si
   * algún nivel es inválido.
   */
  preview(config: C, market: MarketSpec, refPrice: string): PreviewResult;

  /** El conjunto de órdenes que DEBERÍA existir ahora mismo en el venue. */
  plan(ctx: BotContext): DesiredState;

  /**
   * Solo para estrategias con estado propio que no se deduce de la posición
   * (p.ej. las recompras pendientes de GridMart). El motor ya actualiza por su
   * cuenta lo genérico: entradas ejecutadas, niveles llenos y precio medio.
   */
  onFill?(ctx: BotContext, fill: Fill, cycle: CycleState): CycleState;
}
