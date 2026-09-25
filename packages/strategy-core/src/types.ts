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
   * true = el stop de la posición lo pone la ESTRATEGIA, no `stopLossPct`.
   *
   * Tendencia lo calcula con el ATR y lo mueve con el precio, y deja
   * `stopLossPct` vacío a propósito. Lo consume el motor: con la posición
   * abierta, un plan de esta estrategia que no trae `STOP_LOSS` es un fallo, no
   * una decisión del usuario, y el stop que hay en el libro no se cancela
   * (spec 057, F-02).
   */
  readonly stopPropio?: boolean;

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

  // ── El contrato del canal (spec 058) ──────────────────────────────────
  //
  // Todo es opcional y todo es opt-in: una estrategia que no declara nada de
  // esto no ve ningún cambio en el motor.

  /**
   * Varias series de velas cerradas, cada una con su intervalo y su número de
   * velas. Es `candles` en plural: el canal mira 5 min, 15 min y 1 h a la vez.
   * Llegan en `BotContext.series`; una que el motor no pudo servir entera no
   * viene.
   */
  readonly series?: (config: C) => { interval: CandleInterval; bars: number }[];

  /**
   * true = el apalancamiento lo pide cada entrada (`DesiredState.apalancamiento`).
   * El motor no lo sincroniza al arrancar ni al recargar, y solo lo fija con la
   * posición plana, antes de la entrada.
   */
  readonly apalancamientoPorOperacion?: boolean;

  /**
   * `POR_STOP` = la liquidación se mide contra el stop de cada operación y no
   * contra el 5 % fijo: el apalancamiento sale de la distancia del stop
   * (`apalancamientoPorStop`). Lo miran `validateCommon`, el `RiskService` de
   * la API y la guarda de liquidación del motor.
   */
  readonly reglaLiquidacion?: 'POR_STOP';

  /**
   * true = la estrategia cierra las entradas al llegar a `maxDailyLossPct` y las
   * reabre sola a las 00:00 UTC. La guarda diaria del motor solo pausa al 1,5×
   * del tope: pausar al 1× obligaría a reanudar a mano cada día.
   */
  readonly topeDiarioReanuda?: boolean;

  /**
   * true = el motor carga la intención vigente (`BotContext.decisionIa`),
   * anota las que el plan usa o descarta y escribe las solicitudes.
   */
  readonly consumeDecisionesIa?: boolean;

  /**
   * La misma configuración decidiendo SIN la IA, para el backtest: allí no hay
   * a quién consultar, y es la estrategia quien sabe cómo sustituirla (el canal,
   * con su juez de reglas y el mismo perfil). Solo con `consumeDecisionesIa`.
   */
  readonly sinIa?: (config: C) => C;

  /**
   * El nocional más grande que puede abrir el bot con esta configuración, para
   * los agregados de exposición (`bots.max_notional`). null = sin cota propia.
   */
  readonly nocionalMaximo?: (config: C) => string | null;

  /**
   * ¿Solo reduce el riesgo este cambio de configuración? (spec 074). Un cambio
   * así se aplica aunque el resto de la configuración ya no pase la validación
   * ni los topes de riesgo del usuario, como el que solo apaga (spec 062,
   * F-52): un tope bajado después no puede impedir ceñir un stop ni reducir una
   * posición. La operación de un agente lo declara con su regla del
   * seguimiento: solo el stop hacia el precio y el tope de posición a la baja.
   */
  readonly soloReduceRiesgo?: (anterior: C, nueva: C) => boolean;

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
