import type {
  BotConfig,
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
