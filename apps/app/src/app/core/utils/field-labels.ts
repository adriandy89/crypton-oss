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
    'Tope del valor de la posición. Martingala, GridMart y la rejilla clásica lo aplican al tender, ' +
    'cortando en el escalón o la línea que lo superaría; la rejilla neutral y el DCA lo aplican como ' +
    'segundo tope junto al suyo; los market makers no lo leen.',
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
  'strategy.tdca.takeProfitPctHelp':
    'Beneficio sobre el precio medio al que se cierra la posición entera. Con «Seguir al máximo» ' +
    'encendido deja de ser la salida y pasa a ser el punto en el que empieza el seguimiento.',
  'strategy.tdca.trailingTakeProfit': 'Seguir al máximo (trailing)',
  'strategy.tdca.trailingTakeProfitHelp':
    'El take profit deja de ser un precio fijo: al llegar a él, el bot empieza a seguir al máximo y ' +
    'solo cierra cuando el precio retrocede lo que digas. Con 15 % y 1 %, lo mínimo que cobras es +13,85 %.',
  'strategy.tdca.trailingCallbackPct': 'Retroceso para salir (%)',
  'strategy.tdca.trailingCallbackPctHelp':
    'Cuánto tiene que caer desde el máximo para que cierre. Por debajo del 0,5 % te saca en el primer ' +
    'respiro del par: muchas criptos se mueven un 1-3 % al día sin cambiar de tendencia.',
  'strategy.tdca.trailingRepriceBps': 'Umbral para mover el disparador (bps)',
  'strategy.tdca.trailingRepriceBpsHelp':
    'Cuánto tiene que avanzar el disparador para recolocarlo en el exchange. Bajarlo lo hace más fino ' +
    'y gasta más peticiones; en Lighter el cupo son 60 por minuto de toda la IP.',

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
  'strategy.martingale.trailingTakeProfit': 'Seguir al máximo (trailing)',
  'strategy.martingale.trailingTakeProfitHelp':
    'El take profit deja de ser un precio fijo: al llegar a él, el bot empieza a seguir al máximo y ' +
    'solo cierra cuando el precio retrocede lo que digas. Con 15 % y 1 %, lo mínimo que cobras es +13,85 %.',
  'strategy.martingale.trailingCallbackPct': 'Retroceso para salir (%)',
  'strategy.martingale.trailingCallbackPctHelp':
    'Cuánto tiene que caer desde el máximo para que cierre. Por debajo del 0,5 % te saca en el primer ' +
    'respiro del par: muchas criptos se mueven un 1-3 % al día sin cambiar de tendencia.',
  'strategy.martingale.trailingRepriceBps': 'Umbral para mover el disparador (bps)',
  'strategy.martingale.trailingRepriceBpsHelp':
    'Cuánto tiene que avanzar el disparador para recolocarlo en el exchange. Bajarlo lo hace más fino ' +
    'y gasta más peticiones; en Lighter el cupo son 60 por minuto de toda la IP.',

  // Seguimiento de beneficio
  'strategy.trailing.label': 'Seguimiento de beneficio',
  'strategy.trailing.activationMode': 'Cuándo entra',
  'strategy.trailing.activationModeHelp':
    'A mercado abre en la primera revisión. Las otras dos esperan sin coste a que la marca cruce tu precio.',
  'strategy.trailing.activationPrice': 'Precio de entrada',
  'strategy.trailing.activationPriceHelp':
    'El nivel que tiene que cruzar la marca para abrir. Es un disparador, no una orden colgada en el libro.',
  'strategy.trailing.takeProfitPct': 'Beneficio al que empieza a seguir (%)',
  'strategy.trailing.takeProfitPctHelp':
    'No es el precio al que sale: es donde deja de mirar un precio fijo y empieza a seguir al máximo. ' +
    'Ponlo por encima de lo que el par se mueve en un día normal.',
  'strategy.trailing.trailingCallbackPct': 'Retroceso para salir (%)',
  'strategy.trailing.trailingCallbackPctHelp':
    'Cuánto tiene que caer desde el máximo para que cierre. Por debajo del 0,5 % te saca en el primer ' +
    'respiro del par.',
  'strategy.trailing.trailingRepriceBps': 'Umbral para mover el disparador (bps)',
  'strategy.trailing.trailingRepriceBpsHelp':
    'Cuánto tiene que avanzar el disparador para recolocarlo en el exchange. Súbelo en Lighter, donde ' +
    'el cupo son 60 peticiones por minuto de toda la IP.',

  // GridMart
  'strategy.gridmart.label': 'GridMart',
  'strategy.gridmart.classicMode': 'Modo clásico',
  'strategy.gridmart.classicModeHelp':
    'Apaga la rejilla de ventas y las recompras: queda una martingala normal con una sola orden de cierre.',
  'strategy.gridmart.corePctSoldAtLevel1': '% del núcleo vendido en el nivel 1',
  'strategy.gridmart.corePctSoldAtLevel1Help':
    'Qué parte del núcleo se vende en la primera línea de la rejilla. Por el número de ventas, cuánto núcleo cubre.',
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

  // Microestructura (spec 039). Comunes a las dos versiones: los descriptores
  // viven una sola vez en `mm-shared`, así que la etiqueta también.
  // Tendencia (spec 040).
  'strategy.trend.candleInterval': 'Resolución de las velas',
  'strategy.trend.breakoutPeriod': 'Velas del canal de ruptura',
  'strategy.trend.atrPeriod': 'Velas del ATR',
  'strategy.trend.atrStopMultiplier': 'Stop, en ATR',
  'strategy.trend.riskPerTradePct': 'Riesgo por operación',
  'strategy.trend.entryEfficiency': 'Eficiencia mínima para entrar',
  'strategy.trend.stopRepriceBps': 'Movimiento mínimo del stop',
  'strategy.trend.direction': 'Lados que opera',

  'strategy.mm.fairPriceMode': 'Precio justo',
  'strategy.mm.obiSkewFactor': 'Sesgo por desequilibrio del libro',
  'strategy.mm.sizeSkewFactor': 'Sesgo de tamaño por inventario',
  'strategy.mm.fundingSkewFactor': 'Sesgo por funding',
  'strategy.mm.maxAdverseFundingBps': 'Funding máximo en contra',
  'strategy.mm.markoutHorizonSeconds': 'Horizonte de markout',
  'strategy.mm.markoutSensitivity': 'Sensibilidad al markout',
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
    'Ancla manual. Con esto puesto el bot cotiza alrededor de este precio y no del mercado; si el ' +
    'mercado se aleja del ancla, la nota del bot lo dice. La espera tras un fill sigue actuando.',
  'strategy.mm.positionMode': 'Modo de posición',
  'strategy.mm.positionModeHelp':
    'Automático deja el de la cuenta. En cobertura una venta abre un corto en paralelo al largo en vez ' +
    'de reducirlo. Se aplica al arrancar el bot solo en Aster (Unidireccional; Cobertura no se admite ' +
    'allí). En Hyperliquid y Lighter no existe: manda el modo de la cuenta.',
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
  'strategy.mmv2.maxDynamicSpreadBpsHelp':
    'Techo del diferencial compuesto, aplicado después de los multiplicadores de nivel, comportamiento ' +
    'y modo de riesgo: ninguna capa cotiza más ancha. Con 0 no hay techo (la app avisa).',
  'strategy.mmv2.useFullSizeUntilMax': 'Usar tamaño normal hasta el máximo',
  'strategy.mmv2.useFullSizeUntilMaxHelp':
    'Activado, la última capa se coloca entera o no se coloca; desactivado, se recorta al hueco.',
  'strategy.mmv2.layers': 'Niveles de cotización',
  'strategy.mmv2.layersHelp': 'Cuántas órdenes escalonadas por lado.',
  'strategy.mmv2.layerDistanceMultiplier': 'Multiplicador de distancia por nivel',
  'strategy.mmv2.layerSizeMultiplier': 'Multiplicador de tamaño por nivel',
  'strategy.mmv2.positionMode': 'Modo de posición',
  'strategy.mmv2.positionModeHelp':
    'Automático deja el de la cuenta. En cobertura una venta abre un corto en paralelo al largo en vez ' +
    'de reducirlo. Se aplica al arrancar el bot solo en Aster (Unidireccional; Cobertura no se admite ' +
    'allí). En Hyperliquid y Lighter no existe: manda el modo de la cuenta.',
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
    'El bot no cotiza hasta que el precio cruce el disparador. Una vez armado sigue cotizando mientras ' +
    'dure el ciclo; hoy el armado se pierde al cerrarse un ciclo y puede volver a esperar.',
  'strategy.mmv2.activationPrice': 'Precio de disparo',
  'strategy.mmv2.activationPriceHelp': 'Precio que tiene que cruzarse para que el bot empiece.',

  // Canal con IA (specs 058-059). Las ayudas dicen lo que hace el motor
  // (`canal/config.ts` y `ai-channel.ts`), no lo que sugiere el nombre.
  'strategy.aiChannel.label': 'Canal con IA',
  'strategy.aiChannel.description':
    'Rebotes en el borde de un rango o canal, con el apalancamiento que permite el stop.',
  'strategy.aiChannel.direction': 'Lados que opera',
  'strategy.aiChannel.directionHelp':
    'Los dos, solo largos o solo cortos. Solo cambia las entradas nuevas, nunca la posición abierta.',
  'strategy.aiChannel.leverage': 'Tope de apalancamiento',
  'strategy.aiChannel.leverageHelp':
    'Cada operación calcula el suyo con su stop, y nunca pasa de este tope ni del máximo del par. ' +
    'Un stop más ancho da menos apalancamiento. 25x como mucho.',
  'strategy.aiChannel.maxDailyLossPct': 'Pérdida diaria máxima',
  'strategy.aiChannel.maxDailyLossPctHelp':
    'Sobre el capital, por día UTC. Al llegar no abre nada hasta las 00:00 UTC y vuelve sola; al ' +
    '1,5 veces del tope se pausa y la reanudas tú. 6 % como mucho.',
  'strategy.aiChannel.cooldownMinutes': 'Espera entre operaciones',
  'strategy.aiChannel.cooldownMinutesHelp': 'Minutos sin entrar después de cerrar una operación.',
  'strategy.aiChannel.structureInterval': 'Velas del canal',
  'strategy.aiChannel.structureIntervalHelp':
    'Dónde se dibuja el canal. 15 min es lo recomendado; con 5 min salen canales más cortos y con ' +
    'más ruido. No se puede cambiar después.',
  'strategy.aiChannel.decisionMode': 'Quién elige',
  'strategy.aiChannel.decisionModeHelp':
    'IA: el modelo elige entre las operaciones que calculó el motor. Reglas: elige un juez fijo con ' +
    'el perfil, sin consultar a nadie.',
  'strategy.aiChannel.aiProfile': 'Perfil',
  'strategy.aiChannel.aiProfileHelp':
    'Ordena las preferencias al elegir stop, objetivo y apalancamiento. Nunca afloja un límite.',
  'strategy.aiChannel.entriesEnabled': 'Entradas permitidas',
  'strategy.aiChannel.entriesEnabledHelp':
    'Apagado no abre operaciones nuevas. La abierta sigue con su stop y sus objetivos.',
  'strategy.aiChannel.observeOnly': 'Solo observar',
  'strategy.aiChannel.observeOnlyHelp':
    'Analiza y decide como siempre, también consultando a la IA, pero no abre nada.',
  'strategy.aiChannel.riskPerTradePct': 'Riesgo por operación',
  'strategy.aiChannel.riskPerTradePctHelp':
    'Lo que se pierde si salta el stop, con comisiones, sobre el capital. 2 % como mucho.',
  'strategy.aiChannel.maxMarginPct': 'Margen máximo por operación',
  'strategy.aiChannel.maxMarginPctHelp':
    'Lo más que inmoviliza una operación, y por tanto lo más que se pierde si un hueco salta el stop.',
  'strategy.aiChannel.maxNotionalMultiple': 'Nocional máximo',
  'strategy.aiChannel.maxNotionalMultipleHelp':
    'En veces el capital. Una operación no pasa de aquí, sea cual sea su stop.',
  'strategy.aiChannel.liqBufferStops': 'Distancia a la liquidación',
  'strategy.aiChannel.liqBufferStopsHelp':
    'En distancias de stop: la liquidación queda al menos así de lejos. Subirlo baja el ' +
    'apalancamiento; nunca menos de 3.',
  'strategy.aiChannel.maxStopPct': 'Stop más ancho',
  'strategy.aiChannel.maxStopPctHelp': 'Una operación que pida un stop más lejano no se ofrece.',
  'strategy.aiChannel.minRewardRisk': 'Beneficio mínimo',
  'strategy.aiChannel.minRewardRiskHelp':
    'Lo que tiene que pagar el objetivo, neto de costes, en veces lo arriesgado. Por debajo, la ' +
    'operación no se ofrece.',
  'strategy.aiChannel.maxEntrySlippageR': 'Deslizamiento máximo de la entrada',
  'strategy.aiChannel.maxEntrySlippageRHelp':
    'Cuánto peor que la referencia puede llenarse la entrada, en veces lo arriesgado. Si el libro ' +
    'se ha ido, la orden no se llena y no pasa nada.',
  'strategy.aiChannel.maxSpreadFraction': 'Spread máximo',
  'strategy.aiChannel.maxSpreadFractionHelp':
    'En fracción del ATR de 15 min. Con un spread más ancho no entra.',
  'strategy.aiChannel.makerFeeBps': 'Comisión maker',
  'strategy.aiChannel.takerFeeBps': 'Comisión taker',
  'strategy.aiChannel.feeBpsHelp':
    'Vacío, la tabla del exchange. Ponla si tu nivel de comisiones es otro: entra en cada cuenta.',
  'strategy.aiChannel.slippageBps': 'Deslizamiento estimado',
  'strategy.aiChannel.slippageBpsHelp':
    'Lo que se estima perder al salir a mercado. Vacío, el del exchange.',
  'strategy.aiChannel.maxTradesPerDay': 'Operaciones al día',
  'strategy.aiChannel.maxTradesPerDayHelp':
    'Por día UTC. Alcanzadas, no abre más hasta las 00:00 UTC.',
  'strategy.aiChannel.maxConsecutiveLosses': 'Pérdidas seguidas',
  'strategy.aiChannel.maxConsecutiveLossesHelp':
    'Tras estas pérdidas seguidas espera lo que diga «Espera tras la racha».',
  'strategy.aiChannel.lossStreakCooldownMinutes': 'Espera tras la racha',
  'strategy.aiChannel.lossStreakCooldownMinutesHelp':
    'Minutos sin entrar tras la racha de pérdidas.',
  'strategy.aiChannel.stopCooldownMinutes': 'Espera tras un stop',
  'strategy.aiChannel.stopCooldownMinutesHelp': 'Minutos sin entrar después de que salte un stop.',
  'strategy.aiChannel.dailyProfitTargetPct': 'Objetivo de ganancia del día',
  'strategy.aiChannel.dailyProfitTargetPctHelp':
    'Sobre el capital. Alcanzado, no abre más hasta las 00:00 UTC. Con 0 no hay objetivo.',
  'strategy.aiChannel.maxDrawdownPct': 'Caída máxima',
  'strategy.aiChannel.maxDrawdownPctHelp':
    'Lo que ha caído el resultado realizado desde su máximo, sobre el capital. Al llegar, el bot se ' +
    'pausa y lo reanudas tú; la cuenta empieza de nuevo en cada reanudación.',
  'strategy.aiChannel.aiDailyCallBudget': 'Consultas a la IA al día',
  'strategy.aiChannel.aiDailyCallBudgetHelp':
    'Solo se consulta con una operación lista. El servidor tiene su propio techo y manda el menor.',
  'strategy.aiChannel.takeProfitSchemes': 'Objetivos permitidos',
  'strategy.aiChannel.takeProfitSchemesHelp':
    'Dónde puede salir con beneficio: en la línea media, cerca del borde opuesto o repartido entre ' +
    'los dos.',
  'strategy.aiChannel.tp1Fraction': 'Parte en la media',
  'strategy.aiChannel.tp1FractionHelp':
    'En el esquema escalonado, qué parte de la posición se cierra en la línea media.',
  'strategy.aiChannel.breakevenAfterTp1': 'Stop a la entrada tras la media',
  'strategy.aiChannel.breakevenAfterTp1Help':
    'Cobrado el primer objetivo, el stop pasa a la entrada más los costes.',
  'strategy.aiChannel.maxHoldBars': 'Tiempo máximo',
  'strategy.aiChannel.maxHoldBarsHelp': 'En velas de 15 min. Pasado, cierra a mercado.',
  'strategy.aiChannel.invalidationAtr': 'Cierre fuera del canal',
  'strategy.aiChannel.invalidationAtrHelp':
    'Si una vela de 15 min cierra fuera del borde por más de esto, en ATR, cierra a mercado.',
  'strategy.aiChannel.allowedSetups': 'Operaciones',
  'strategy.aiChannel.allowedSetupsHelp':
    'El rebote en el borde es lo de por defecto. La ruptura fallida entra contra un movimiento que ' +
    'acaba de romper el canal: tiene más riesgo.',
  'strategy.aiChannel.allowedChannels': 'Canales',
  'strategy.aiChannel.allowedChannelsHelp': 'Horizontales (un rango), inclinados o los dos.',
  'strategy.aiChannel.slopedWithTrendOnly': 'Inclinados solo a favor',
  'strategy.aiChannel.slopedWithTrendOnlyHelp':
    'En un canal inclinado solo entra en el sentido de su pendiente.',
  'strategy.aiChannel.channelWindowBars': 'Velas para buscar el canal',
  'strategy.aiChannel.channelWindowBarsHelp': 'Cuántas velas hacia atrás se miran para dibujarlo.',
  'strategy.aiChannel.minChannelQuality': 'Nota mínima del canal',
  'strategy.aiChannel.minChannelQualityHelp': 'A es el más limpio; con C entran canales dudosos.',
  'strategy.aiChannel.minConfirmations': 'Confirmaciones mínimas',
  'strategy.aiChannel.minConfirmationsHelp':
    'Mecha de rechazo, RSI extremo, divergencia o volumen tranquilo: cuántas hacen falta para dar ' +
    'el rebote por listo.',
  'strategy.aiChannel.requireEvidence': 'Histórico exigido',
  'strategy.aiChannel.requireEvidenceHelp':
    'Cuántos casos parecidos tiene que haber en el histórico del par para ofrecer la operación: ' +
    'débil, 20 o más; moderada, más de 60.',
  'strategy.aiChannel.minAiConfidence': 'Confianza mínima de la IA',
  'strategy.aiChannel.minAiConfidenceHelp':
    'Por debajo no entra. Con confianza media entra con la mitad del tamaño.',
  'strategy.aiChannel.maxAdverseFundingBps': 'Funding máximo en contra',
  'strategy.aiChannel.maxAdverseFundingBpsHelp': 'Con un funding en contra mayor, no entra.',
  'strategy.aiChannel.fundingBlackoutMinutes': 'Sin entradas antes del funding',
  'strategy.aiChannel.fundingBlackoutMinutesHelp':
    'Minutos antes de cada cobro de funding en los que no abre.',
  'strategy.aiChannel.noEntryWindowsUtc': 'Horas sin entradas (UTC)',
  'strategy.aiChannel.noEntryWindowsUtcHelp':
    'HH:MM-HH:MM separadas por comas, hasta seis. Por ejemplo 12:25-12:45 alrededor de un dato ' +
    'macro.',
};

/**
 * Nombre visible de cada valor de un `enum`.
 *
 * Sin esto la app pintaba la constante cruda —«PAUSE_ENTRIES», «SOURCE_GLOBAL»—
 * en un desplegable de cara al usuario. Es un mapa plano para los valores que
 * significan lo mismo en todas partes; los que cambian de sentido según el
 * campo van en `OPTION_LABELS_BY_FIELD`, abajo.
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
  // El canal con IA (spec 059) va entero aquí y no en el mapa general: sus
  // valores SÍ se repiten con significados distintos. `MEDIA` es la línea media
  // en los objetivos y la confianza media en la IA; `TODOS` son tres esquemas en
  // un campo y dos setups en otro; y `NEUTRAL` no es «neutral», son los dos lados.
  'strategy.aiChannel.direction': {
    NEUTRAL: 'Ambas',
    LONG: 'Solo largos',
    SHORT: 'Solo cortos',
  },
  'strategy.aiChannel.structureInterval': { '15m': '15 min', '5m': '5 min' },
  'strategy.aiChannel.decisionMode': { IA: 'IA', REGLAS: 'Reglas' },
  'strategy.aiChannel.aiProfile': {
    PRUDENTE: 'Prudente',
    EQUILIBRADA: 'Equilibrada',
    AGRESIVA: 'Agresiva',
  },
  'strategy.aiChannel.takeProfitSchemes': {
    TODOS: 'Los tres',
    MEDIA: 'Línea media',
    ESCALONADO: 'Escalonado',
    OPUESTO: 'Borde opuesto',
  },
  'strategy.aiChannel.allowedSetups': {
    REBOTE: 'Rebote',
    FALSO_QUIEBRE: 'Ruptura fallida',
    TODOS: 'Los dos',
  },
  'strategy.aiChannel.allowedChannels': {
    TODOS: 'Los dos',
    HORIZONTAL: 'Horizontales',
    INCLINADO: 'Inclinados',
  },
  'strategy.aiChannel.requireEvidence': { NO: 'No exigir', DEBIL: 'Débil', MODERADA: 'Moderada' },
  'strategy.aiChannel.minAiConfidence': { MEDIA: 'Media', ALTA: 'Alta' },
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
  intelligence: 'Microestructura',
  priceSource: 'Precio',
  activation: 'Condición de activación',
  venue: 'Exchange',
};

/**
 * Títulos propios de una estrategia, cuando el genérico no dice lo que hay
 * dentro. En el canal con IA, «Tiempos» guarda los límites del día y
 * «Microestructura» los filtros del mercado (spec 059).
 */
const GROUP_LABELS_BY_STRATEGY: Record<string, Record<string, string>> = {
  AI_CHANNEL: {
    core: 'Base',
    risk: 'Riesgo',
    timing: 'Límites del día y horario (UTC)',
    levels: 'Salidas',
    intelligence: 'Mercado',
    venue: 'Margen y costes',
  },
};

export const groupLabel = (group: string, strategy?: string): string =>
  GROUP_LABELS_BY_STRATEGY[strategy ?? '']?.[group] ?? GROUP_LABELS[group] ?? group;

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
