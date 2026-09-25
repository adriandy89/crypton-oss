export * from './types';
export * from './registry';
export * from './mutability';
export * from './client-order-id';
export * from './ladder';
export * from './trailing-take-profit';
// La liquidacion estimada vivia aqui, pero la necesita tambien el simulador de
// `exchange-core` —que no depende de este paquete— para poder reventar una
// posicion como lo haria el venue. Se mudo a `shared`, que es lo unico que los
// dos comparten, y se reexporta desde aqui para no mover a quien ya la importa.
export {
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  estimateLiquidationPrice,
  liquidationDistancePct,
} from '@crypton/shared';
export {
  camposEfectivos,
  COMMON_FIELDS,
  commonFieldsWith,
  buildPreview,
  invalidPreview,
  entrySide,
  exitSide,
  positionSize,
  px,
  qy,
  validateCommon,
  type RawLevel,
} from './common';
export type { GridClassicConfig } from './strategies/grid-classic';
export type { NeutralGridConfig } from './strategies/neutral-grid';
export type { TdcaConfig } from './strategies/tdca';
export type { MartingaleConfig } from './strategies/martingale';
export type { GridMartConfig } from './strategies/gridmart';
export type { MarketMakerConfig } from './strategies/market-maker';
export type { MarketMakerV2Config } from './strategies/market-maker-v2';
export type { TrendFollowConfig } from './strategies/trend-follow';
export type { TrailingProfitConfig } from './strategies/trailing-profit';
export type { AiChannelConfig } from './strategies/ai-channel';
export type { AgentTradeConfig } from './strategies/agent-trade';
// El primer índice de los cierres a mercado de la operación: el motor lo lee
// para contar por qué terminó (spec 059).
export { INDICE_CIERRE } from './strategies/ai-channel';
export * from './indicadores';
export { composeSpreadBps, resolveAnchor } from './strategies/market-maker-v2';
export { MAX_VOL_SAMPLES, sampleVolatility } from './strategies/mm-shared';

// Specs REALES de los tres venues, tomadas de sus APIs publicas. Se exportan
// porque las usan tambien los tests del worker y de la API: sin un origen unico,
// cada uno se inventaria sus mercados y los tests dejarian de decir nada.
export * from './venue-markets';

// Piezas que vivian en `apps/worker/src/engine`. Se mudaron aqui porque ya solo
// dependian de `shared` y de este paquete, y porque el backtest las necesita:
// duplicarlas alli habria dejado dos verdades sobre la misma decision.
export * from './reconcile';
export * from './order-gate';
export * from './stop-loss';
export * from './cycle-accounting';

// El motor determinista del canal (spec 058). Nombres explícitos: su
// estadística (`rsi`, `sma`…) comparte nombre con la de `indicadores`, y el
// worker y el backtest solo necesitan la entrada y la salida.
export {
  DEFAULTS_CANAL,
  enVentanaSinEntradas,
  leerConfig as leerConfigCanal,
  leerVentanas,
  type ConfigCanal,
  type VentanaUtc,
} from './canal/config';
export { COSTES_VENUE, costesDe, type Costes } from './canal/costes';
export {
  analizarMercado,
  seriesNecesarias,
  vaciarCacheAnalisis,
  type EntradaAnalisis,
  type ResultadoAnalisis,
} from './canal/analisis';
export {
  construirOperacion,
  esElegible,
  herramientaCanal,
  huellaDe,
  type ResultadoOperacion,
} from './canal/herramienta';
export { juezDeReglas } from './canal/juez';
export { wilsonInferior } from './canal/estadistica';
export { etiquetarTripleBarrera, resumirTasas, type Etiqueta } from './canal/tasas-base';
export { serieNumerica, type SerieNumerica } from './canal/numeros';
export { serieFresca, ultimaCerradaEsperada } from './canal/velas';

// El motor de los agentes de IA (spec 074). Nombres explícitos, como el del
// canal: la API solo necesita la entrada, la salida y la medición.
export {
  DEFAULTS_AGENTE,
  MAX_PENDIENTES_AGENTE,
  NOMBRES_LIMITES as NOMBRES_LIMITES_AGENTE,
  RANGOS_AGENTE,
  dimensionadoDeAgente,
  leerLimites as leerLimitesAgente,
  peorDia as peorDiaAgente,
  validarLimites as validarLimitesAgente,
  type ErrorLimite as ErrorLimiteAgente,
} from './agentes/limites';
export { MIN_VELAS_AGENTE, VELAS_AGENTE, atrLiquidacionDe } from './agentes/mercado';
export {
  barreraDelDia,
  esElegibleAgente,
  herramientaAgente,
  huellaAgente,
  ofertaAgente,
  usoDelDia,
  type EntradaAgente,
  type HistorialAgente,
  type ParAgente,
  type PuestoOferta,
} from './agentes/herramienta';
export { juezAgente } from './agentes/juez';
export { juezSeguimiento } from './agentes/juez-seguimiento';
export {
  INDICE_REDUCCION,
  configDeOperacion,
  leerOperacionAgente,
  soloReduceRiesgo,
  type OperacionAgente,
} from './strategies/agent-trade';
export {
  MOVIMIENTO_MAXIMO_STOPS,
  construirPropuesta,
  recalcularPropuesta,
  type ContextoPropuesta,
  type DatosFrescos,
  type ResultadoPropuesta,
  type ResultadoRecalculo,
} from './agentes/propuesta';
export {
  estadoOperacion,
  eventoSeguimiento,
  huellaSeguimiento,
  ofreciblesSegun,
  opcionesSeguimiento,
  type EntradaSeguimiento,
  type OperacionViva,
} from './agentes/seguimiento';
export {
  MUESTRA_MINIMA,
  estadisticaR,
  planMedibleDe,
  planMedibleDePlan,
  resultadoHipotetico,
  tarjetaAgente,
  type FilaCandidato,
  type FilaPropuesta,
  type PlanMedible,
} from './agentes/medicion';

// Los indicadores que puede pintar el grafico de la app (spec 061): envuelven la
// estadistica del canal, que no se exporta cruda por la colision de nombres de
// arriba.
export {
  CLAVES_INDICADOR,
  INDICADORES,
  esClaveIndicador,
  lineasDeIndicador,
  type ClaveIndicador,
  type FichaIndicador,
  type LineaIndicador,
  type PanelIndicador,
  type PuntoIndicador,
} from './indicadores-vista';
