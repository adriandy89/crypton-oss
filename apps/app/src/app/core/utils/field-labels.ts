import type { FieldMeta } from '../models';

/**
 * Nombres en castellano de los parametros de estrategia.
 *
 * Los formularios de la app se generan enteros a partir de `FieldMeta`, y el
 * nombre visible salia de `labelKey` des-camelizando la ultima parte de la
 * clave: `strategy.mm.buyDistanceBps` se mostraba como "Buy Distance Bps".
 * Los catalogos de Transloco (`assets/i18n/*.json`) estan vacios y ninguna
 * plantilla usa el pipe, asi que la traduccion no llegaba a ninguna parte.
 */
export const FIELD_LABELS: Record<string, string> = {
  // Comunes a todas las estrategias
  'strategy.common.exchangeAccount': 'Conexión de exchange',
  'strategy.common.symbol': 'Par',
  'strategy.common.direction': 'Dirección',
  'strategy.common.leverage': 'Apalancamiento',
  'strategy.common.leverageHelp':
    'Multiplica tanto el beneficio como la pérdida. Se fija en el exchange antes del primer ciclo.',
  'strategy.common.marginMode': 'Modo de margen',
  'strategy.common.totalInvestment': 'Capital asignado',
  'strategy.common.totalInvestmentHelp': 'Margen que este bot puede usar. No sale de tu cuenta.',
  'strategy.common.maxNotionalCap': 'Tope de exposición',
  'strategy.common.maxNotionalCapHelp':
    'Tope duro: el motor no coloca nada que lo supere, pase lo que pase con el resto de ajustes.',
  'strategy.common.stopLossPct': 'Stop loss (%)',
  'strategy.common.maxDailyLossPct': 'Pérdida diaria máxima (%)',
  'strategy.common.cooldownMinutes': 'Espera entre ciclos (min)',
  'strategy.common.liquidationAction': 'Al acercarse la liquidación',
  'strategy.common.liquidationActionHelp':
    'Qué hace el bot cuando el precio se acerca a tu liquidación. «Avisar» solo notifica.',

  // Rejilla clasica
  'strategy.grid.label': 'Rejilla clásica',
  'strategy.grid.levels': 'Niveles',
  'strategy.grid.levelsHelp':
    'En cuántas líneas se parte el rango. Más niveles, órdenes más juntas y más pequeñas.',
  'strategy.grid.lowerPrice': 'Precio inferior',
  'strategy.grid.upperPrice': 'Precio superior',
  'strategy.grid.spacing': 'Espaciado',
  'strategy.grid.spacingHelp':
    'Aritmético deja la misma distancia en USDC entre líneas; geométrico, el mismo porcentaje.',
  'strategy.grid.sizingMode': 'Reparto del tamaño',
  'strategy.grid.sizingModeHelp': 'Valor nocional en USDC, o cantidad fija de la moneda.',
  'strategy.grid.preloadInventory': 'Precargar inventario',
  'strategy.grid.preloadInventoryHelp':
    'Hoy no cambia nada: el motor no precarga inventario. El bot arranca siempre en líquido.',
  'strategy.grid.stopOnRangeExit': 'Parar al salir del rango',
  'strategy.grid.stopOnRangeExitHelp':
    'Fuera del rango deja de abrir, pero mantiene vivas las ventas de lo que ya compró.',

  // Rejilla neutral
  'strategy.neutral.label': 'Rejilla neutral',
  'strategy.neutral.anchorPrice': 'Precio ancla',
  'strategy.neutral.anchorPriceHelp':
    'El centro de la retícula: el precio en el que el bot considera que tu posición debería ser cero.',
  'strategy.neutral.levels': 'Niveles',
  'strategy.neutral.lowerPrice': 'Precio inferior',
  'strategy.neutral.upperPrice': 'Precio superior',
  'strategy.neutral.spacing': 'Espaciado',
  'strategy.neutral.sizeMultiplier': 'Multiplicador de tamaño',
  'strategy.neutral.sizeMultiplierHelp':
    'Cuánto más dinero mueven los niveles lejanos al ancla frente a los cercanos. Con 1 pesan todos igual.',
  'strategy.neutral.maxExposure': 'Exposición máxima',
  'strategy.neutral.maxExposureHelp':
    'Tope de la posición neta. Alcanzado, solo quedan vivas las órdenes que la reducen. Sin él, crece hasta agotar el margen.',
  'strategy.neutral.reanchorOnDrift': 'Recentrar si se aleja',
  'strategy.neutral.reanchorOnDriftHelp':
    'Solo avisa cuando el precio se aleja del ancla. El recentrado se lanza a mano, con «Recentrar la retícula».',
  'strategy.neutral.reanchorThresholdPct': 'Umbral para recentrar (%)',

  // DCA temporizado
  'strategy.tdca.label': 'DCA temporizado',
  'strategy.tdca.amountPerBuy': 'Importe por compra',
  'strategy.tdca.amountPerBuyHelp':
    'Margen que se compromete en cada compra. Con apalancamiento, la posición que añade es este importe multiplicado por él.',
  'strategy.tdca.intervalMinutes': 'Intervalo (min)',
  'strategy.tdca.buyOnlyIfImprovesAverage': 'Comprar solo si mejora la media',
  'strategy.tdca.buyOnlyIfImprovesAverageHelp':
    'Activado, solo compra por debajo de tu precio medio, así que tu media solo puede mejorar.',
  'strategy.tdca.marginBelowAveragePct': 'Margen bajo la media (%)',
  'strategy.tdca.marginBelowAveragePctHelp':
    'Cuánto tiene que estar el precio por debajo de tu media para que la compra cuente como mejora.',
  'strategy.tdca.maxBuysPerCycle': 'Compras máximas por ciclo',
  'strategy.tdca.maxBuysPerCycleHelp':
    'Importe por compra multiplicado por este número es todo el dinero que el bot puede llegar a comprometer.',
  'strategy.tdca.maxPositionNotional': 'Notional máximo de la posición',
  'strategy.tdca.maxPositionNotionalHelp':
    'Tope del valor de la posición. Alcanzado, deja de comprar aunque le quede cupo e intervalo cumplido.',
  'strategy.tdca.takeProfitPct': 'Take profit (%)',

  // Martingala
  'strategy.martingale.label': 'Martingala',
  'strategy.martingale.baseOrderType': 'Tipo de orden base',
  'strategy.martingale.numLimitBuys': 'Nº de órdenes de seguridad',
  'strategy.martingale.numLimitBuysHelp':
    'Cuántas órdenes se cuelgan por debajo de la entrada base. Cada una que entra baja tu media y aumenta la posición.',
  'strategy.martingale.initialSeparationPct': 'Separación inicial (%)',
  'strategy.martingale.initialSeparationPctHelp':
    'A qué distancia de la entrada base se cuelga la primera orden de seguridad.',
  'strategy.martingale.stepScale': 'Escala de distancia',
  'strategy.martingale.stepScaleHelp':
    'Cuánto se aleja cada seguridad respecto de la anterior. Decide la profundidad total que cubre la escalera.',
  'strategy.martingale.volumeScale': 'Escala de volumen',
  'strategy.martingale.volumeScaleHelp':
    'Cuánto crece cada seguridad respecto de la anterior. Baja tu media más rápido, concentrando el capital en los últimos escalones.',
  'strategy.martingale.takeProfitPct': 'Take profit (%)',
  'strategy.martingale.takeProfitPctHelp':
    'Beneficio sobre el precio medio al que se cierra la posición entera. Se recalcula con cada seguridad ejecutada.',
  'strategy.martingale.tpMode': 'Modo de take profit',

  // GridMart
  'strategy.gridmart.label': 'GridMart',
  'strategy.gridmart.classicMode': 'Modo clásico',
  'strategy.gridmart.classicModeHelp':
    'Apaga la rejilla de ventas y las recompras: queda una martingala normal con una sola orden de cierre.',
  'strategy.gridmart.corePctSoldAtLevel1': '% del núcleo vendido en el nivel 1',
  'strategy.gridmart.corePctSoldAtLevel1Help':
    'Qué parte del núcleo se vende en la primera línea de la rejilla. Por el número de ventas, cuánto núcleo cubre.',
  'strategy.gridmart.fullCycleCooldownMinutes': 'Espera tras ciclo completo (min)',
  'strategy.gridmart.gridRebuyDiscountPct': 'Descuento de recompra (%)',
  'strategy.gridmart.gridRebuyDiscountPctHelp':
    'Cuánto por debajo de una venta ejecutada se anota su recompra. Mantenlo por debajo de la separación de venta.',
  'strategy.gridmart.gridSellCount': 'Ventas de rejilla',
  'strategy.gridmart.gridSellDistanceMultiplier': 'Multiplicador de distancia de venta',
  'strategy.gridmart.gridSellInitialSeparationPct': 'Separación inicial de venta (%)',
  'strategy.gridmart.gridSellQtyMultiplier': 'Multiplicador de cantidad de venta',
  'strategy.gridmart.satelliteTpPct': 'Take profit satélite (%)',
  'strategy.gridmart.satelliteTpPctHelp':
    'Beneficio al que se cierra todo lo que añadieron las seguridades. Es la salida rápida del bot.',

  // Market maker
  //
  // Las unidades ya NO van en el nombre: `FieldMeta.unit` las pinta dentro del
  // propio campo. Repetirlas daba «Distancia de compra (bps)» seguido de «bps».
  'strategy.mm.label': 'Market maker',
  'strategy.mm.description': 'Cotiza a los dos lados y cobra el diferencial.',
  'strategy.mm.buyDistanceBps': 'Distancia de compra',
  'strategy.mm.buyDistanceBpsHelp': 'A cuánto del precio medio se pone la compra.',
  'strategy.mm.sellDistanceBps': 'Distancia de venta',
  'strategy.mm.minAllowedDistanceBps': 'Distancia mínima permitida',
  'strategy.mm.minAllowedDistanceBpsHelp':
    'Suelo duro: el bot no cotiza nunca más cerca del precio que esto.',
  'strategy.mm.dynamicSpread': 'Diferencial dinámico',
  'strategy.mm.dynamicSpreadHelp': 'Ensancha la cotización a medida que crece el inventario.',
  'strategy.mm.layers': 'Capas',
  'strategy.mm.layerDistanceMultiplier': 'Multiplicador de distancia por capa',
  'strategy.mm.layerSizeMultiplier': 'Multiplicador de tamaño por capa',
  'strategy.mm.layerSizeMultiplierHelp': 'Cuánto crece cada capa respecto de la anterior.',
  'strategy.mm.orderSizePerSide': 'Tamaño por compra/venta',
  'strategy.mm.orderSizePerSideHelp': 'Lo que se pone en cada orden, en cada lado.',
  'strategy.mm.maxLongPosition': 'Límite de inventario largo',
  'strategy.mm.maxShortPosition': 'Límite de inventario corto',
  'strategy.mm.maxBotPositionValue': 'Valor máximo de la posición',
  'strategy.mm.maxBotPositionValueHelp': 'Tope de exposición del bot en cualquier dirección.',
  'strategy.mm.inventorySkewFactor': 'Sesgo por inventario',
  'strategy.mm.inventoryPriceAdjustment': 'Ajuste de precio por inventario',
  'strategy.mm.inventoryPriceAdjustmentHelp':
    'Desplaza el centro en contra del inventario para deshacerlo antes.',
  'strategy.mm.exitOrderTtlSeconds': 'Mantener órdenes de salida durante',
  'strategy.mm.exitOrderTtlSecondsHelp':
    'Pasado ese tiempo, la orden de salida se rehace al precio nuevo. 0 = nunca.',
  'strategy.mm.refreshSeconds': 'Intervalo de actualización de órdenes',
  'strategy.mm.refreshSecondsHelp':
    'Cada cuánto se rehace la cotización aunque el precio no se mueva. Una ejecución la rehace al instante, sin esperar a esto.',
  'strategy.mm.riskProfile': 'Perfil de riesgo',
  'strategy.mm.riskProfileHelp': 'Coordina diferencial y tamaño de golpe de una vez.',
  'strategy.mm.sizingMode': 'Introducir tamaños en',
  'strategy.mm.sizingModeHelp': 'Valor nocional en USDC, o cantidad de la moneda.',
  'strategy.mm.limitAction': 'Acción al alcanzar el límite',
  'strategy.mm.limitActionHelp': 'Qué hace el bot cuando la posición toca su tope.',
  'strategy.mm.fillCooldownSeconds': 'Espera tras un fill',
  'strategy.mm.fillCooldownSecondsHelp':
    'Congela la cotización tras una ejecución, para no perseguir al mercado que acaba de barrerla.',
  'strategy.mm.postOnly': 'Solo post-only',
  'strategy.mm.postOnlyHelp':
    'Intenta colocar órdenes limit que no tomen liquidez de inmediato. Desactivarlo hace pagar comisión de taker.',
  'strategy.mm.defensiveThresholdPct': 'Modo defensivo a partir de',
  'strategy.mm.defensiveThresholdPctHelp':
    'Ocupación del tope a la que el bot empieza a alejar el lado que añade y acercar el que reduce.',
  'strategy.mm.highRiskThresholdPct': 'Modo de alto riesgo a partir de',
  'strategy.mm.highRiskThresholdPctHelp':
    'Ocupación a la que el bot deja de añadir y solo mantiene la salida.',
  'strategy.mm.autoAdjustDistance': 'Ajustar distancia automáticamente',
  'strategy.mm.autoAdjustDistanceHelp':
    'La distancia sigue la anchura real del libro en vez de ser un número fijo.',
  'strategy.mm.referencePrice': 'Precio de referencia',
  'strategy.mm.referencePriceHelp':
    'Ancla manual. Con esto puesto el bot cotiza alrededor de este precio y no del mercado.',
  'strategy.mm.positionMode': 'Modo de posición',
  'strategy.mm.positionModeHelp':
    'Automático deja el de la cuenta. En cobertura una venta abre un corto en paralelo al largo en vez de reducirlo.',
  'strategy.mm.direction': 'Dirección',
  'strategy.mm.priceFloor': 'No operar por debajo de',
  'strategy.mm.priceFloorHelp': 'Por debajo de este precio el bot solo reduce, no abre.',
  'strategy.mm.priceCeiling': 'No operar por encima de',
  'strategy.mm.priceCeilingHelp': 'Por encima de este precio el bot solo reduce, no abre.',

  // Market maker V2
  'strategy.mmv2.label': 'Market maker V2',
  'strategy.mmv2.description':
    'Compone el diferencial con la volatilidad, el libro y el coste de operar.',
  'strategy.mmv2.behaviorPreset': 'Comportamiento',
  'strategy.mmv2.behaviorPresetHelp': 'Coordina diferencial y tamaño de golpe de una vez.',
  'strategy.mmv2.sizingMode': 'Introducir tamaños en',
  'strategy.mmv2.sizingModeHelp': 'Valor nocional en USDC, o cantidad de la moneda.',
  'strategy.mmv2.orderSizePerSide': 'Tamaño por compra/venta',
  'strategy.mmv2.orderSizePerSideHelp': 'Lo que se pone en cada orden, en cada lado.',
  'strategy.mmv2.maxBotPositionValue': 'Inversión / posición máxima',
  'strategy.mmv2.maxBotPositionValueHelp': 'Tope de exposición del bot en cualquier dirección.',
  'strategy.mmv2.limitAction': 'Acción al alcanzar el límite',
  'strategy.mmv2.limitActionHelp': 'Qué hace el bot cuando la posición toca su tope.',
  'strategy.mmv2.buyDistanceBps': 'Distancia de compra',
  'strategy.mmv2.buyDistanceBpsHelp':
    'Punto de partida del diferencial. El resto de la fórmula suma sobre esto.',
  'strategy.mmv2.sellDistanceBps': 'Distancia de venta',
  'strategy.mmv2.minAllowedDistanceBps': 'Distancia mínima permitida',
  'strategy.mmv2.minAllowedDistanceBpsHelp':
    'Suelo duro: el bot no cotiza nunca más cerca del precio que esto.',
  'strategy.mmv2.feeEstimateBps': 'Estimación de comisión',
  'strategy.mmv2.feeEstimateBpsHelp':
    'Comisión por lado. Se cobra dos veces en un par casado, y el diferencial mínimo la cubre.',
  'strategy.mmv2.safetyBufferBps': 'Buffer de seguridad',
  'strategy.mmv2.safetyBufferBpsHelp': 'Colchón extra sobre el coste, para no cotizar al filo.',
  'strategy.mmv2.minProfitMarginBps': 'Margen mínimo de beneficio',
  'strategy.mmv2.minProfitMarginBpsHelp':
    'Lo que debe quedar limpio tras comisiones. Por debajo de esto el bot no cotiza.',
  'strategy.mmv2.postOnly': 'Solo post-only',
  'strategy.mmv2.postOnlyHelp': 'Intenta colocar órdenes limit que no tomen liquidez de inmediato.',
  'strategy.mmv2.defensiveThresholdPct': 'Umbral defensivo',
  'strategy.mmv2.defensiveThresholdPctHelp':
    'Ocupación del tope a la que el bot empieza a alejar el lado que añade.',
  'strategy.mmv2.highRiskThresholdPct': 'Umbral de alto riesgo',
  'strategy.mmv2.highRiskThresholdPctHelp':
    'Ocupación a la que el bot deja de añadir y solo mantiene la salida.',
  'strategy.mmv2.refreshSeconds': 'Intervalo de actualización de órdenes',
  'strategy.mmv2.refreshSecondsHelp':
    'Cada cuánto se rehace la cotización aunque el precio no se mueva. Una ejecución la rehace al instante, sin esperar a esto.',
  'strategy.mmv2.repriceThresholdBps': 'Distancia para reajustar precio',
  'strategy.mmv2.repriceThresholdBpsHelp':
    'Cuánto tiene que moverse el precio para recotizar antes de tiempo.',
  'strategy.mmv2.orderMaxAgeSeconds': 'Actualizar órdenes después de',
  'strategy.mmv2.orderMaxAgeSecondsHelp':
    'Edad máxima de una cotización viva: el libro que la rodeaba ya no es el mismo.',
  'strategy.mmv2.fillCooldownSeconds': 'Espera tras un fill',
  'strategy.mmv2.fillCooldownSecondsHelp':
    'Congela la cotización tras una ejecución, para no perseguir al mercado.',
  'strategy.mmv2.exitOrderTtlSeconds': 'Mantener órdenes de salida durante',
  'strategy.mmv2.exitOrderTtlSecondsHelp':
    'Pasado ese tiempo, la orden de salida se rehace al precio nuevo. 0 = nunca.',
  'strategy.mmv2.dynamicSpread': 'Spread dinámico',
  'strategy.mmv2.dynamicSpreadHelp':
    'Ensancha la cotización con la volatilidad realizada y la anchura del libro.',
  'strategy.mmv2.volatilitySampleSeconds': 'Muestra de volatilidad',
  'strategy.mmv2.volatilitySampleSecondsHelp':
    'Ventana sobre la que se mide el recorrido del precio.',
  'strategy.mmv2.orderBookMarginBps': 'Margen del libro de órdenes',
  'strategy.mmv2.orderBookMarginBpsHelp': 'Se suma siempre, haya volatilidad o no.',
  'strategy.mmv2.volatilityMultiplier': 'Multiplicador de volatilidad',
  'strategy.mmv2.volatilityMultiplierHelp': 'Cuánto de la volatilidad medida pasa al diferencial.',
  'strategy.mmv2.maxDynamicSpreadBps': 'Spread dinámico máximo',
  'strategy.mmv2.maxDynamicSpreadBpsHelp': 'Techo duro: el bot no cotiza nunca más ancho que esto.',
  'strategy.mmv2.useFullSizeUntilMax': 'Usar tamaño normal hasta el máximo',
  'strategy.mmv2.useFullSizeUntilMaxHelp':
    'Activado, la última capa se coloca entera o no se coloca; desactivado, se recorta al hueco.',
  'strategy.mmv2.layers': 'Niveles de cotización',
  'strategy.mmv2.layersHelp': 'Cuántas órdenes escalonadas por lado.',
  'strategy.mmv2.layerDistanceMultiplier': 'Multiplicador de distancia por nivel',
  'strategy.mmv2.layerSizeMultiplier': 'Multiplicador de tamaño por nivel',
  'strategy.mmv2.positionMode': 'Modo de posición',
  'strategy.mmv2.positionModeHelp':
    'Automático deja el de la cuenta. En cobertura una venta abre un corto en paralelo al largo en vez de reducirlo.',
  'strategy.mmv2.direction': 'Dirección',
  'strategy.mmv2.priceSource': 'Fuente de precio',
  'strategy.mmv2.priceSourceHelp':
    'Contra qué precio se cotiza. Si la fuente externa se cae, el bot deja de cotizar.',
  'strategy.mmv2.fairPriceOrigin': 'Origen del precio justo',
  'strategy.mmv2.fairPriceOriginHelp': 'Si se usa el de la fuente o el del propio exchange.',
  'strategy.mmv2.sourceMarketType': 'Tipo de mercado de origen',
  'strategy.mmv2.sourceMarketTypeHelp':
    'Qué mercado de Binance se consulta: contado, perpetuo o su precio de índice.',
  'strategy.mmv2.sourceSymbolOverride': 'Símbolo de origen alternativo',
  'strategy.mmv2.sourceSymbolOverrideHelp':
    'Solo si el par no se llama igual en Binance. Por defecto se pide «<base>USDT» (BTCUSDT); ' +
    'escribe aquí el símbolo exacto si allí es otro, como «1000PEPEUSDT».',
  'strategy.mmv2.priceFloor': 'Piso de precio',
  'strategy.mmv2.priceFloorHelp': 'Por debajo de este precio el bot solo reduce, no abre.',
  'strategy.mmv2.priceCeiling': 'Techo de precio',
  'strategy.mmv2.priceCeilingHelp': 'Por encima de este precio el bot solo reduce, no abre.',
  'strategy.mmv2.activationMode': 'Condición de activación',
  'strategy.mmv2.activationModeHelp':
    'El bot no cotiza hasta que el precio cruce el disparador. Una vez armado, se queda armado.',
  'strategy.mmv2.activationPrice': 'Precio de disparo',
  'strategy.mmv2.activationPriceHelp': 'Precio que tiene que cruzarse para que el bot empiece.',
};

/**
 * Nombre visible de cada valor de un `enum`.
 *
 * Sin esto la app pintaba la constante cruda —«PAUSE_ENTRIES», «SOURCE_GLOBAL»—
 * en un desplegable de cara al usuario. Es un mapa plano y no uno por campo
 * porque los valores no se repiten con significados distintos.
 */
export const OPTION_LABELS: Record<string, string> = {
  // Dirección
  NEUTRAL: 'Neutral',
  LONG: 'Largo',
  SHORT: 'Corto',

  // Perfil / comportamiento
  CONSERVATIVE: 'Conservador',
  BALANCED: 'Equilibrado',
  AGGRESSIVE: 'Agresivo',

  // Acción al alcanzar el límite
  PAUSE_ENTRIES: 'Pausar entradas',
  CLOSE_ALL: 'Cerrar todo',
  SHUTDOWN: 'Apagar',

  // Acción al acercarse la liquidación
  ALERT: 'Solo avisar',
  PAUSE: 'Pausar el bot',

  // Tamaños
  QUOTE: 'Valor nocional',
  BASE: 'Cantidad de moneda',

  // Margen y modo de posición
  CROSS: 'Cruzado',
  ISOLATED: 'Aislado',
  ADD: 'Aportar',
  REMOVE: 'Retirar',
  AUTO: 'Automático',
  ONE_WAY: 'Unidireccional',
  HEDGE: 'Cobertura',

  // Fuente de precio
  EXCHANGE: 'Datos del exchange',
  BINANCE: 'Binance',
  SOURCE_GLOBAL: 'Global desde la fuente',
  VENUE_MID: 'Medio del exchange',
  VENUE_MARK: 'Precio de marca del exchange',
  PERP: 'Perpetuo',
  SPOT: 'Spot',
  INDEX: 'Índice',

  // Activación
  NONE: 'Sin condición',
  PRICE_ABOVE: 'Cuando suba a',
  PRICE_BELOW: 'Cuando baje a',

  // Tipo de orden
  LIMIT: 'Límite',
  MARKET: 'A mercado',

  // Espaciado de rejilla
  ARITHMETIC: 'Aritmético',
  GEOMETRIC: 'Geométrico',
};

/**
 * Excepciones por campo, cuando la misma constante se lee distinto según dónde.
 *
 * `LONG` en una rejilla es «largo»; en un market maker es «intención long»,
 * porque ahí no describe una posición sino hacia qué lado se inclina la
 * cotización. Traducirlo igual en los dos sitios haría que uno de los dos
 * mintiera, y el mapa general no puede saber en cuál está.
 */
const OPTION_LABELS_BY_FIELD: Record<string, Record<string, string>> = {
  'strategy.mm.direction': {
    NEUTRAL: 'Neutral',
    LONG: 'Intención Long',
    SHORT: 'Intención Short',
  },
};

/** Nombre visible de un valor de enum; el valor crudo si no está catalogado. */
export const optionLabel = (value: string, labelKey?: string): string =>
  OPTION_LABELS_BY_FIELD[labelKey ?? '']?.[value] ?? OPTION_LABELS[value] ?? value;

/** Títulos de las secciones en las que se agrupa un formulario. */
export const GROUP_LABELS: Record<string, string> = {
  core: 'Configuración',
  risk: 'Riesgo',
  quoting: 'Cotización',
  timing: 'Tiempos',
  levels: 'Niveles',
  dynamicSpread: 'Spread dinámico',
  priceSource: 'Precio',
  activation: 'Condición de activación',
  venue: 'Exchange',
};

export const groupLabel = (group: string): string => GROUP_LABELS[group] ?? group;

/**
 * Nombre visible de un campo. Si la clave no esta en el catalogo se cae al
 * comportamiento antiguo (des-camelizar) en vez de mostrar la clave cruda:
 * una estrategia nueva sale legible aunque nadie haya traducido sus campos.
 */
export function fieldLabel(field: Pick<FieldMeta, 'key' | 'labelKey'>): string {
  const known = FIELD_LABELS[field.labelKey];
  if (known) return known;
  const leaf = field.labelKey.split('.').pop() ?? field.key;
  return leaf.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Nombre legible de un campo del que solo se tiene la clave del diccionario y
 * la del campo: el historial de revisiones trae `labelKey` y `key`, no el
 * `FieldMeta` entero. Sin `labelKey` se des-camaliza la clave, como siempre.
 */
export function labelDeClave(labelKey: string | undefined, key: string): string {
  return fieldLabel({ key, labelKey: labelKey ?? key });
}

/**
 * Texto de ayuda de un campo, o cadena vacia si no lo tiene.
 *
 * A diferencia del nombre, aqui NO hay respaldo automatico: des-camelizar una
 * clave de ayuda produce una frase sin sentido, y es mejor no ensenar ninguna
 * ayuda que ensenar «Buy Distance Bps Help».
 */
export function fieldHelp(field: FieldMeta): string {
  return field.helpKey ? (FIELD_LABELS[field.helpKey] ?? '') : '';
}
