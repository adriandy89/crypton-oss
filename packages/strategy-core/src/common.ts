import {
  D,
  Decimal,
  Mutability,
  floorToStep,
  normalizeOrder,
  roundPriceForSide,
  type BotConfig,
  type CommonBotConfig,
  type Direction,
  type FieldMeta,
  type LevelKind,
  type LevelPreview,
  type MarketSpec,
  type Numeric,
  type OrderSide,
  type PositionSide,
  type PreviewExit,
  type PreviewResult,
  type PreviewSide,
  type ValidationIssue,
  type ValidationResult,
  distanciaLiquidacion,
  ladoMasEstrecho,
  maintenanceMarginRateOf,
  maxApalancamientoConDistancia,
  pctPrecioDeRoi,
  perdidaEnLiquidacionPct,
  precioDeRoi,
  precioLiquidacion,
  stopMaximoRoi,
  HOLGURA_LIQUIDACION,
  MAX_APALANCAMIENTO_POR_STOP,
  MIN_LIQUIDATION_DISTANCE_PCT,
} from '@crypton/shared';
import { recorridoPeorCaso, weightedAverage } from './ladder';

/**
 * Campos presentes en todas las estrategias. La app pinta esta sección primero
 * en el wizard y reutiliza los mismos badges de mutabilidad.
 */
export const COMMON_FIELDS: readonly FieldMeta[] = [
  {
    key: 'exchangeAccountId',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'strategy.common.exchangeAccount',
    required: true,
    group: 'core',
  },
  {
    key: 'symbol',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'strategy.common.symbol',
    required: true,
    group: 'core',
  },
  {
    key: 'direction',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'strategy.common.direction',
    options: ['LONG', 'SHORT'],
    required: true,
    default: 'LONG',
    group: 'core',
    control: 'segment',
  },
  {
    key: 'marginMode',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'strategy.common.marginMode',
    options: ['CROSS', 'ISOLATED'],
    required: true,
    default: 'ISOLATED',
    group: 'venue',
    control: 'segment',
  },
  {
    key: 'leverage',
    kind: 'integer',
    // WARM y no HOT: el venue puede rechazar el cambio con posición abierta y,
    // aunque lo acepte, mueve el precio de liquidación. Se revalida y se retiende.
    mutability: Mutability.WARM,
    labelKey: 'strategy.common.leverage',
    helpKey: 'strategy.common.leverageHelp',
    min: 1,
    max: 50,
    step: 1,
    required: true,
    default: 2,
    risky: true,
    group: 'venue',
    unit: 'x',
  },
  {
    key: 'totalInvestment',
    kind: 'money',
    mutability: Mutability.WARM,
    labelKey: 'strategy.common.totalInvestment',
    helpKey: 'strategy.common.totalInvestmentHelp',
    min: 10,
    required: true,
    risky: true,
    group: 'core',
    unit: 'USDC',
  },
  {
    key: 'maxNotionalCap',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.common.maxNotionalCap',
    helpKey: 'strategy.common.maxNotionalCapHelp',
    min: 0,
    required: false,
    group: 'risk',
    unit: 'USDC',
  },
  {
    key: 'stopLossPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.common.stopLossPct',
    helpKey: 'strategy.common.stopLossPctHelp',
    min: 0.1,
    // % del MARGEN (spec 080). El tope de siempre era un 90 % del precio: se
    // conserva en precio y `camposEfectivos` lo pasa a margen con el
    // apalancamiento. Antes de ese tope manda la liquidación: ver
    // `validarStopFrenteALiquidacion`.
    maxPrecioPct: 90,
    roi: 'PERDIDA',
    step: 0.1,
    required: false,
    risky: true,
    group: 'risk',
    unit: '%',
  },
  {
    key: 'maxDailyLossPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.common.maxDailyLossPct',
    min: 0.1,
    max: 100,
    step: 0.1,
    required: false,
    group: 'risk',
    unit: '%',
    // Ya era un % del capital del bot (el margen asignado): no cambia con el
    // spec 080, pero hasta él no tenía ayuda que lo dijera (079/F-18).
    helpKey: 'strategy.common.maxDailyLossPctHelp',
  },
  {
    key: 'liquidationAction',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.common.liquidationAction',
    helpKey: 'strategy.common.liquidationActionHelp',
    options: ['ALERT', 'PAUSE', 'CLOSE_ALL'],
    required: false,
    default: 'ALERT',
    risky: true,
    group: 'risk',
    control: 'segment',
  },
  {
    key: 'cooldownMinutes',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.common.cooldownMinutes',
    min: 0,
    max: 10080,
    step: 1,
    required: false,
    default: 0,
    group: 'timing',
    unit: 'min',
  },
] as const;

/**
 * `COMMON_FIELDS` con algunos campos redefinidos por la estrategia.
 *
 * Existe por un caso concreto: el market maker admite `direction: NEUTRAL`, que
 * las rejillas no. Sin esto habría que abrir la opción a las seis estrategias y
 * dejar que `validate()` la rechazara luego, que es la peor forma de decir que
 * no —el usuario ya ha rellenado el formulario entero.
 *
 * El orden se conserva: se sustituye en el sitio, no se reordena.
 */
/**
 * Un campo común con algo cambiado, para pasárselo a `commonFieldsWith`.
 *
 * Existe para no escribir `COMMON_FIELDS.find(...)!` en cada estrategia: esa
 * aserción convierte una clave mal escrita en un descriptor sin `key`, que
 * `commonFieldsWith` añade como campo basura al final de la lista en vez de
 * sustituir nada. Aquí revienta al cargar el módulo, que es cuando se quiere
 * saber (spec 037 R-5).
 */
export function comunCon(key: string, cambios: Partial<FieldMeta>): FieldMeta {
  const base = COMMON_FIELDS.find((f) => f.key === key);
  if (!base) throw new Error(`No existe el campo común «${key}».`);
  return { ...base, ...cambios };
}

export function commonFieldsWith(overrides: readonly FieldMeta[]): FieldMeta[] {
  const byKey = new Map(overrides.map((f) => [f.key, f]));
  const replaced = COMMON_FIELDS.map((f) => byKey.get(f.key) ?? f);
  const seen = new Set(COMMON_FIELDS.map((f) => f.key));
  return [...replaced, ...overrides.filter((f) => !seen.has(f.key))];
}

export const err = (field: string | null, message: string): ValidationIssue => ({
  field,
  message,
  severity: 'ERROR',
});

export const warn = (field: string | null, message: string): ValidationIssue => ({
  field,
  message,
  severity: 'WARNING',
});

export interface OpcionesValidacionComun {
  /**
   * `POR_STOP`: la liquidación la gobierna el stop de cada operación (spec
   * 058). El 5 % fijo no aplica y el techo es `MAX_APALANCAMIENTO_POR_STOP`.
   */
  reglaLiquidacion?: 'POR_STOP';
  /**
   * true = el stop lo pone la estrategia y `stopLossPct` no se usa (la de
   * tendencia): la regla del stop frente a la liquidación no tiene qué medir.
   */
  stopPropio?: boolean;
  /**
   * false = la estrategia no lee `maxNotionalCap` (los market makers, cuyo tope
   * es `maxBotPositionValue`): avisar de él sería hablar de un tope que no
   * existe (079/F-27).
   */
  topeDeExposicion?: false;
}

/**
 * El stop común frente a la liquidación (spec 080, 079/F-01).
 *
 * Un stop más ancho que la distancia a la liquidación no salta nunca: el venue
 * liquida antes y se pierde el margen entero, con el usuario creyendo que tenía
 * una pérdida máxima. Nada lo miraba salvo las estrategias de IA. Con `s` el
 * movimiento de precio del stop y `d` la distancia EXACTA a la liquidación del
 * lado que manda (NEUTRAL, el corto):
 *
 * - `s ≥ d`: en AISLADO es un error —la liquidación está donde dice la
 *   fórmula—; en CRUZADO, un aviso, porque ahí la liquidación real queda más
 *   lejos con el resto de la cuenta detrás.
 * - `d < s·(1 + HOLGURA_LIQUIDACION)`: aviso. La liquidación queda a menos de
 *   medio stop detrás, la regla de la casa desde los specs 058 y 074.
 *
 * Todos llevan `suggestedValue`: el stop más ancho que cumple la holgura, que
 * el formulario ofrece aplicar con un toque (D-4).
 */
export function validarStopFrenteALiquidacion(
  stopRoiPct: Numeric,
  leverage: number,
  market: MarketSpec,
  direction: Direction,
  marginMode: string | null | undefined,
): ValidationIssue[] {
  const stop = D(stopRoiPct);
  const lado = ladoMasEstrecho(direction);
  const s = pctPrecioDeRoi(stop, leverage).div(100);
  const enCorto = direction === 'NEUTRAL' ? ' en corto' : '';
  const mmr = maintenanceMarginRateOf(market);
  const d = distanciaLiquidacion(leverage, mmr, lado);
  const sugerido = d.gt(0) ? stopMaximoRoi(leverage, mmr, lado).toFixed() : null;
  const conPropuesta = (issue: ValidationIssue): ValidationIssue =>
    sugerido ? { ...issue, suggestedValue: sugerido } : issue;

  // En largo, un stop que se come el 100 % del precio no existe: su disparo
  // quedaría a cero o por debajo y la posición se quedaría sin red.
  if (lado === 'LONG' && s.gte(1)) {
    return [
      conPropuesta(
        err(
          'stopLossPct',
          `Un stop del ${stop.toFixed()} % del margen a ${leverage}× es una caída del ` +
            `${s.mul(100).toFixed(2)} % del precio: llevaría el disparo a cero.` +
            (sugerido ? ` El más ancho que deja medio stop de holgura es ${sugerido} %.` : ''),
        ),
      ),
    ];
  }

  // Un largo a 1× no se liquida: el precio tendría que llegar a cero, que es
  // justo lo que ya mide el error de arriba. Sin esto se avisaba de «la
  // liquidación llega con un 100 %» por encima de un stop del 66,6 %.
  if (!sugerido || (lado === 'LONG' && d.gte(1))) return [];
  const aislado = marginMode !== 'CROSS';
  const liq =
    `A ${leverage}× la liquidación${enCorto} llega con un ${d.mul(100).toFixed(2)} % de ` +
    `movimiento en contra, al perder el ${perdidaEnLiquidacionPct(leverage, mmr, lado).toFixed(1)} % ` +
    'del margen';

  if (s.gte(d)) {
    const mensaje =
      `${liq}: un stop del ${stop.toFixed()} % no saltaría nunca, el venue liquida antes. ` +
      (aislado
        ? ''
        : 'En margen cruzado la liquidación real queda más lejos, pero no se puede contar con ello. ') +
      `El más ancho que deja medio stop de holgura es ${sugerido} %.`;
    return [conPropuesta(aislado ? err('stopLossPct', mensaje) : warn('stopLossPct', mensaje))];
  }
  if (d.lt(s.mul(1 + HOLGURA_LIQUIDACION))) {
    return [
      conPropuesta(
        warn(
          'stopLossPct',
          `${liq}, y el stop del ${stop.toFixed()} % la deja a menos de medio stop detrás: un ` +
            'deslizamiento o una mecha pueden liquidar la posición antes de que salga. El más ' +
            `ancho con holgura es ${sugerido} %.`,
        ),
      ),
    ];
  }
  return [];
}

/**
 * Un objetivo en % sobre el MARGEN (spec 080), el mismo para el take profit de
 * las escaleras, el objetivo del seguimiento y el TP satélite de GridMart.
 *
 * - Mayor que cero.
 * - En corto, sin llevar el precio a cero: un objetivo del 100 % del precio o
 *   más no se alcanza nunca, y la posición se quedaría esperándolo con solo el
 *   stop (079/F-06).
 * - Con `minimoPrecioPct`, un aviso si en PRECIO no llega a ese mínimo: el
 *   coste de entrar y salir se mide contra el precio, no contra el margen.
 */
export function validarObjetivoRoi(
  field: string,
  que: string,
  roiPct: Numeric | null | undefined,
  leverage: number,
  direction: Direction,
  minimoPrecioPct?: Numeric,
): ValidationIssue[] {
  const roi = D(roiPct ?? 0);
  if (!roi.isFinite() || roi.lte(0)) return [err(field, `${que} tiene que ser mayor que cero.`)];
  const precioPct = pctPrecioDeRoi(roi, leverage);
  if (direction === 'SHORT' && precioPct.gte(100)) {
    return [
      err(
        field,
        `${que} del ${roi.toFixed()} % del margen a ${leverage}× es una bajada del ` +
          `${precioPct.toFixed(2)} % del precio: tendría que llegar a cero, así que no se ` +
          'alcanza nunca.',
      ),
    ];
  }
  if (minimoPrecioPct != null && precioPct.lt(minimoPrecioPct)) {
    return [
      warn(
        field,
        `${que} del ${roi.toFixed()} % del margen a ${leverage}× es un ${precioPct.toFixed(2)} % ` +
          `del precio, por debajo del ${D(minimoPrecioPct).toFixed()} %: con una entrada taker y ` +
          'una salida maker, un ciclo cerrado puede acabar en pérdida.',
      ),
    ];
  }
  return [];
}

/** Validaciones que aplican a cualquier estrategia. */
export function validateCommon(
  config: CommonBotConfig,
  market: MarketSpec,
  opciones: OpcionesValidacionComun = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Aster en modo cobertura exige `positionSide` en cada orden y prohíbe
  // `reduceOnly`; el adaptador habla solo el dialecto unidireccional. Pedir
  // cobertura cambiaría el modo de TODA la cuenta (afecta a todos sus bots) y a
  // partir de ahí cada orden recibiría -4061 (001/F-71). En los otros venues el
  // ajuste no existe y el motor lo salta con un aviso: no hace daño.
  if (config.positionMode === 'HEDGE' && market.venue === 'ASTER') {
    issues.push(
      err(
        'positionMode',
        'En Aster el modo cobertura no se puede usar: cambiaría el modo de toda la cuenta y el bot no podría operar. Elige Automático o Unidireccional.',
      ),
    );
  }

  if (!config.symbol) issues.push(err('symbol', 'Falta el par.'));
  if (!config.exchangeAccountId) {
    issues.push(err('exchangeAccountId', 'Falta la conexion de exchange.'));
  }

  const lev = Number(config.leverage);
  if (!Number.isFinite(lev) || lev < 1) {
    issues.push(err('leverage', 'El apalancamiento debe ser 1 o mayor.'));
  } else if (lev > market.maxLeverage) {
    issues.push(
      err('leverage', market.symbol + ' admite como maximo ' + market.maxLeverage + 'x aqui.'),
    );
  } else if (opciones.reglaLiquidacion === 'POR_STOP') {
    // El apalancamiento de cada operación lo decide su stop, y la liquidación
    // queda siempre a tres stops o más: el 5 % fijo no tiene nada que medir.
    // Lo que sí manda es el techo (spec 058).
    if (lev > MAX_APALANCAMIENTO_POR_STOP) {
      issues.push(
        err(
          'leverage',
          'El tope de apalancamiento de esta estrategia es ' + MAX_APALANCAMIENTO_POR_STOP + 'x.',
        ),
      );
    }
  } else {
    // La misma cuenta que la API (`RiskService`) y el asistente, con la tasa
    // de mantenimiento de ESTE mercado (001/F-44) y la liquidación EXACTA del
    // lado que manda: NEUTRAL puede acabar en corto, que liquida antes. Antes
    // era la lineal, que en el corto se pasaba de uno (079/F-07).
    const mmr = maintenanceMarginRateOf(market);
    const lado = ladoMasEstrecho(config.direction);
    const tope = maxApalancamientoConDistancia(mmr, lado);
    const distancia = distanciaLiquidacion(lev, mmr, lado).mul(100);
    const enCorto = config.direction === 'NEUTRAL' ? ' en corto' : '';
    if (lev > tope) {
      issues.push(
        err(
          'leverage',
          `A ${lev}× la liquidación llega${enCorto} con un ${distancia.toFixed(2)} % de ` +
            `movimiento en contra (mantenimiento del ${(mmr * 100).toFixed(2)} %), por debajo ` +
            `del mínimo del ${MIN_LIQUIDATION_DISTANCE_PCT} %: el máximo aquí es ${tope}×.`,
        ),
      );
    } else if (lev > 10) {
      // Las mismas cifras que la Revisión: la distancia exacta desde la entrada
      // y lo que se ha perdido del margen al llegar (antes, un `100/L` que no
      // coincidía con ningún otro número de la pantalla, 079/F-07).
      issues.push(
        warn(
          'leverage',
          `A ${lev}× la liquidación llega${enCorto} con un ${distancia.toFixed(2)} % de ` +
            `movimiento en contra, cuando la pérdida alcanza el ` +
            `${distancia.mul(lev).toFixed(1)} % del margen.`,
        ),
      );
    }
  }

  const total = D(config.totalInvestment ?? 0);
  if (!total.isFinite() || total.lte(0)) {
    issues.push(err('totalInvestment', 'La inversion total debe ser mayor que cero.'));
  }

  // Dicho para todas las que lo leen: la escalera deja de tender, la rejilla
  // de colocar líneas, el DCA de comprar y el seguimiento y la tendencia
  // entran más pequeños. Antes hablaba de «la escalera completa» en todas,
  // también en las que no la tienen (079/F-27).
  if (config.maxNotionalCap && opciones.topeDeExposicion !== false) {
    const cap = D(config.maxNotionalCap);
    const notional = total.mul(lev || 1);
    if (cap.gt(0) && cap.lt(notional)) {
      issues.push(
        warn(
          'maxNotionalCap',
          `El tope de exposición (${cap.toFixed(2)}) es menor que el capital por el ` +
            `apalancamiento (${notional.toFixed(2)}): la posición no pasará de ${cap.toFixed(2)}.`,
        ),
      );
    }
  }

  // `meta.fields` acota `stopLossPct` y `maxDailyLossPct`, pero solo el
  // formulario lo aplicaba: la API aceptaba `stopLossPct: 150`, el disparo salía
  // a precio negativo y la posición se quedaba sin stop con un WARN; y una
  // pérdida diaria de cero pausaba el bot al arrancar (001/F-13). Se rechaza lo
  // que nunca pudo venir de la app. Vacío o nulo sigue siendo «sin stop» /
  // «sin límite», como siempre.
  //
  // Desde el spec 080 el stop es un % del MARGEN, así que su techo lo pone la
  // liquidación y no un 100 fijo: `validarStopFrenteALiquidacion`.
  const stopPct = config.stopLossPct;
  if (stopPct !== undefined && stopPct !== null && stopPct !== '') {
    const pct = D(stopPct);
    if (!pct.isFinite() || pct.lte(0)) {
      issues.push(err('stopLossPct', 'El stop loss tiene que ser mayor que cero.'));
    } else if (
      opciones.reglaLiquidacion !== 'POR_STOP' &&
      opciones.stopPropio !== true &&
      Number.isFinite(lev) &&
      lev >= 1
    ) {
      issues.push(
        ...validarStopFrenteALiquidacion(pct, lev, market, config.direction, config.marginMode),
      );
    }
  }
  const dailyPct = config.maxDailyLossPct;
  if (dailyPct !== undefined && dailyPct !== null && dailyPct !== '') {
    const pct = D(dailyPct);
    if (!pct.isFinite() || pct.lte(0)) {
      issues.push(err('maxDailyLossPct', 'La perdida diaria maxima debe ser mayor que cero.'));
    }
  }

  if (!market.active) {
    issues.push(
      err('symbol', 'El mercado ' + market.symbol + ' no esta activo en ' + market.venue),
    );
  }

  return issues;
}

/**
 * El descriptor, ajustado a lo que el usuario ya ha elegido y al mercado.
 *
 * `sizingMode` no es un parámetro más: cambia la NATURALEZA del número que se
 * teclea en `orderSizePerSide`. Con `QUOTE` es un nocional en la moneda de
 * cotización; con `BASE`, una cantidad de la moneda del par. El descriptor era
 * estático —`unit: 'USDC'`, `min: 1`— y eso dejaba dos daños:
 *
 * · El modo `BASE` era INUTILIZABLE fuera de las monedas baratas. La validación
 *   genérica aplica `min` a rajatabla, así que pedir 0,05 BTC por capa fallaba
 *   con «no puede ser menor que 1»: en BTC, cien mil dólares por capa y lado.
 * · Y mientras tanto el campo decía `USDC`, así que quien elegía «cantidad de
 *   moneda» tecleaba 50 creyendo dólares y colocaba 50 monedas.
 *
 * Vive aquí, y no en el formulario, porque la regla tiene que ser la MISMA en
 * los tres sitios que la miran: el formulario, `validate()` y la API. Un
 * mínimo que solo conociera la app volvería a ser un mínimo que el servidor
 * contradice (001/F-13, que es justo lo que arregló el spec 019).
 *
 * Los topes (`maxBotPositionValue`, `maxLongPosition`, `maxShortPosition`) NO
 * cambian: son nocional en los dos modos, porque el inventario se mide contra
 * el valor de la posición y no contra su cantidad.
 *
 * Y los % sobre el MARGEN (`roi`, spec 080) llevan su tope en % de precio
 * (`maxPrecioPct`): el máximo que ve el usuario es ese por el apalancamiento,
 * para que el tope económico de siempre no cambie al pasar a margen.
 */
export function camposEfectivos(
  fields: readonly FieldMeta[],
  config: Record<string, unknown>,
  market: MarketSpec,
): FieldMeta[] {
  const lev = Number(config['leverage']);
  const apalancamiento = Number.isFinite(lev) && lev >= 1 ? lev : 1;
  const porMargen = fields.map((f) =>
    f.roi && f.maxPrecioPct != null ? { ...f, max: f.maxPrecioPct * apalancamiento } : f,
  );
  if (config['sizingMode'] !== 'BASE') return porMargen;
  // Sin `minQty` declarada manda el paso de cantidad, que es la granularidad
  // más pequeña que el venue acepta de todas formas.
  const suelo = [market.minQty, market.stepSize]
    .map((v) => Number(v ?? 0))
    .find((n) => Number.isFinite(n) && n > 0);
  return porMargen.map((f) =>
    f.key === 'orderSizePerSide' ? { ...f, unit: market.base, min: suelo } : f,
  );
}

/**
 * Lo que `meta.fields` declara y solo el formulario aplicaba: minimos, maximos,
 * opciones de las enumeraciones y enteros. La API recibe `config` como objeto
 * libre, asi que un cliente que saltara el formulario (o el asistente) colaba
 * valores fuera de rango que reventaban en `plan()` o dejaban una guarda
 * apagada (001/F-13). Solo mira valores PRESENTES; los obligatorios sin valor
 * por defecto (precios, importes) deben venir.
 */
export function validateMeta(
  config: Record<string, unknown>,
  fields: readonly FieldMeta[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const numericos = new Set(['number', 'percent', 'money', 'integer', 'price']);
  for (const f of fields) {
    const v = config[f.key];
    if (v == null || v === '') {
      if (f.required && f.default === undefined) issues.push(err(f.key, 'Falta ' + f.key + '.'));
      continue;
    }
    if (f.kind === 'enum') {
      const texto = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
      if (f.options && !f.options.includes(texto)) {
        issues.push(err(f.key, f.key + ' debe ser uno de: ' + f.options.join(', ') + '.'));
      }
      continue;
    }
    // Un interruptor tiene que ser un interruptor. La API recibe `config` como
    // objeto libre y el lector de la configuración convertía lo que no era
    // `true`/`false` en el valor por defecto: `observeOnly: 1` dejaba operando
    // de verdad al bot que su dueño creía en «solo observar» (spec 062, F-23).
    if (f.kind === 'boolean') {
      if (typeof v !== 'boolean') {
        issues.push(err(f.key, f.key + ' tiene que ser verdadero o falso.'));
      }
      continue;
    }
    if (!numericos.has(f.kind)) continue;
    const n = typeof v === 'number' || typeof v === 'string' ? D(v) : null;
    if (!n || !n.isFinite()) {
      issues.push(err(f.key, f.key + ' no es un numero.'));
      continue;
    }
    if (f.kind === 'integer' && !n.isInteger()) {
      issues.push(err(f.key, f.key + ' debe ser un numero entero.'));
    }
    if (f.min != null && n.lt(f.min)) {
      issues.push(err(f.key, f.key + ' no puede ser menor que ' + f.min + '.'));
    }
    if (f.max != null && n.gt(f.max)) {
      issues.push(err(f.key, f.key + ' no puede ser mayor que ' + f.max + '.'));
    }
  }
  return issues;
}

export const toResult = (issues: ValidationIssue[]): ValidationResult => ({
  ok: !issues.some((i) => i.severity === 'ERROR'),
  issues,
});

/**
 * Preview vacio pero BIEN FORMADO, para una config que todavia no valida.
 *
 * No llama a `D()` ni una sola vez, y ese es exactamente el punto: es el unico
 * resultado que se puede construir con la certeza de que no lanza. `D()` es
 * `new Decimal(v)`, que revienta con `undefined`, y varios `preview()` calculaban
 * la validacion y seguian adelante igual — con `totalInvestment` sin rellenar,
 * `POST /bots/preview` respondia un 500 con un `DecimalError` crudo en vez de
 * decir que faltaba el capital.
 *
 * Importa ademas porque `preview()` pasa a llamarse desde la app en cada
 * pulsacion, con el formulario a medio escribir: ahi lanzar no es un 500, es la
 * pantalla entera caida mientras alguien teclea.
 */
export function invalidPreview(issues: ValidationIssue[]): PreviewResult {
  return {
    levels: [],
    worstCaseNotional: '0',
    worstCaseMargin: '0',
    leverage: 0,
    marginMode: null,
    sides: [],
    valid: false,
    issues,
  };
}

/**
 * Un nivel tal y como lo describe una estrategia, antes de normalizar.
 *
 * Sin margen: lo pone `buildPreview`, el nocional del nivel ya en la retícula
 * entre el apalancamiento, que es lo que el venue retiene por esa orden. Cada
 * estrategia lo daba a su manera —el capital asignado al nivel, el tamaño
 * configurado antes de redondear— y la Revisión enseñaba 35,00 de margen al
 * lado de 33,81 de nocional a 1× (encontrado al rehacer las guías del 080).
 */
export interface RawLevel {
  index: number;
  kind: LevelKind;
  side: OrderSide;
  price: Numeric;
  qty: Numeric;
  /** true = entrada; cuenta para el precio medio y para el peor caso. */
  isEntry: boolean;
}

/**
 * Qué parte de la posición sale por el objetivo, si no es entera.
 *
 * - `qty`: una cantidad fija (el primer objetivo de un agente).
 * - `reserva`: lo que se queda dentro (el núcleo de GridMart, cuyo TP satélite
 *   vende solo lo que añadieron las seguridades). Se resta de lo que se llegue
 *   a llenar, así que un recorrido cortado antes de la primera seguridad no
 *   tiene satélite que vender.
 */
interface ParteQueSale {
  qty?: Numeric;
  reserva?: Numeric;
  /** true = es donde EMPIEZA a seguir al máximo, no donde sale. */
  activacion?: boolean;
}

/**
 * El objetivo de un lado, tal y como lo declara una estrategia: un % del
 * MARGEN desde la media (spec 080) o un precio fijo (la operación de un
 * agente).
 */
export type ObjetivoPreview =
  ({ roiPct: Numeric } & ParteQueSale) | ({ precio: Numeric } & ParteQueSale);

export interface BuildPreviewOptions {
  levels: RawLevel[];
  market: MarketSpec;
  refPrice: Numeric;
  /**
   * LONG o SHORT: todas las entradas son de ese lado (una rejilla clásica larga
   * compra también las líneas que hoy quedan por encima, si el precio las barre
   * de arriba abajo). NEUTRAL: cada entrada va al lado de su orden, compras al
   * largo y ventas al corto. Un largo y un corto nunca conviven, así que cada
   * uno se describe aparte (079/F-10 y F-11).
   */
  direction: Direction;
  leverage: number;
  /**
   * Modo de margen de la config. En cruzado la liquidación aislada es una COTA:
   * el venue suma todo el saldo libre de la cuenta y las demás posiciones, así
   * que la real queda más lejos (001/F-14).
   */
  marginMode?: string | null;
  /** El objetivo de cada lado, si la estrategia tiene uno. */
  objetivo?: ObjetivoPreview | null;
  /** El stop común, en % del MARGEN desde la media (`stopLossPct`). */
  stopLossRoiPct?: Numeric | null;
  /**
   * El stop que pone la propia estrategia, en precio: tendencia (una
   * estimación con un ATR supuesto) o la operación de un agente. Sustituye al
   * común.
   */
  stopPropio?: { precio: Numeric; estimado?: boolean } | null;
  /**
   * El tope de exposición que aplica el plan, en nocional: cada lado se corta
   * en el primer nivel cuya posición, valorada a su precio, no cabe
   * (`recorridoPeorCaso`). `topeDesde` es el primer nivel, en el orden del
   * recorrido, al que se aplica: una escalera abre su base sin mirarlo.
   */
  topeNocional?: Numeric | null;
  topeDesde?: number;
  issues?: ValidationIssue[];
}

/**
 * Convierte los niveles crudos de una estrategia en el preview que ve el
 * usuario. Toda estrategia pasa por aqui, asi la Revisión es la misma para
 * todas.
 *
 * - Cada nivel se redondea contra la retícula del venue y se acumula DENTRO DE
 *   SU LADO.
 * - Cada lado recorre sus entradas en el orden en que el precio las tocaría
 *   yendo en contra (`recorridoPeorCaso`) y se corta donde el stop o la
 *   liquidación de la media llegan antes que el nivel siguiente, o donde el
 *   tope de exposición no deja tenderlo.
 * - Sobre esa posición se calculan el objetivo, el stop y la liquidación EXACTA,
 *   con su precio en la retícula —redondeado como lo manda el motor, por el
 *   lado de la salida—, su movimiento, el resultado en dinero y el % sobre el
 *   margen, como enseña un exchange al poner un TP/SL (spec 080). Sin comisiones.
 */
export function buildPreview(opts: BuildPreviewOptions): PreviewResult {
  const { levels, market, refPrice, direction } = opts;
  const leverage = Math.max(1, Number(opts.leverage) || 1);

  const ref = D(refPrice);
  const issues = [...(opts.issues ?? [])];
  // Tope de órdenes activas por mercado del venue (Lighter Standard: 30; Aster:
  // 200). Una retícula con más niveles se recortaba en silencio ya en marcha:
  // el venue rechaza el exceso orden a orden y el bot entra en cuarentena por
  // forma con un ERROR por nivel (001/F-50, F-23). Se avisa aquí, antes de
  // crear el bot; es un aviso y no un veto porque el tope depende del tier de
  // la cuenta, que desde aquí no se conoce.
  const tope = market.maxActiveOrders;
  const nombreVenue: Record<string, string> = {
    LIGHTER: 'Lighter',
    ASTER: 'Aster',
    HYPERLIQUID: 'Hyperliquid',
  };
  if (tope != null && levels.length > tope) {
    issues.push(
      warn(
        'gridLevels',
        `${nombreVenue[market.venue] ?? market.venue} admite ${tope} órdenes activas por mercado ` +
          `(con cuenta estándar); esta configuración tiende ${levels.length}: el exceso se ` +
          'rechazará orden a orden.',
      ),
    );
  }

  const ladoDe = (lv: RawLevel): PositionSide =>
    direction === 'NEUTRAL'
      ? lv.side === 'BUY'
        ? 'LONG'
        : 'SHORT'
      : direction === 'SHORT'
        ? 'SHORT'
        : 'LONG';
  const niveles = levels.map((lv) => ({
    lv,
    lado: ladoDe(lv),
    norm: normalizeOrder(market, lv.price, lv.qty, lv.side),
  }));

  const out: LevelPreview[] = [];
  const acumulado: Record<
    PositionSide,
    { notional: Decimal; margin: Decimal; entradas: { price: Decimal; qty: Decimal }[] }
  > = {
    LONG: { notional: D(0), margin: D(0), entradas: [] },
    SHORT: { notional: D(0), margin: D(0), entradas: [] },
  };
  let totalNotional = D(0);
  let totalMargin = D(0);

  // El margen de una entrada es lo que el venue retiene por ella: su nocional,
  // ya en la retícula, entre el apalancamiento. Una salida no retiene nada.
  const margenDe = (lv: RawLevel, notional: Decimal): Decimal =>
    lv.isEntry ? notional.div(leverage) : D(0);

  for (const { lv, lado, norm } of niveles) {
    const notional = norm.price.mul(norm.qty);
    const margen = margenDe(lv, notional);
    const a = acumulado[lado];
    if (lv.isEntry) {
      a.notional = a.notional.plus(notional);
      a.margin = a.margin.plus(margen);
      totalNotional = totalNotional.plus(notional);
      totalMargin = totalMargin.plus(margen);
      if (norm.qty.gt(0)) a.entradas.push({ price: norm.price, qty: norm.qty });
    }
    const avg = a.entradas.length ? weightedAverage(a.entradas) : null;

    out.push({
      index: lv.index,
      kind: lv.kind,
      side: lv.side,
      price: norm.price.toFixed(market.priceDecimals),
      qty: norm.qty.toFixed(market.qtyDecimals),
      notional: notional.toFixed(2),
      marginUsed: margen.toFixed(2),
      cumulativeNotional: a.notional.toFixed(2),
      cumulativeMargin: a.margin.toFixed(2),
      averageEntry: avg ? avg.toFixed(market.priceDecimals) : null,
      distancePct: ref.gt(0) ? norm.price.minus(ref).div(ref).mul(100).toFixed(2) : '0.00',
      violations: norm.violations,
    });
  }

  // Con la tasa de mantenimiento del MERCADO, no el 0,5 % plano (001/F-93).
  const mmr = maintenanceMarginRateOf(market);
  const stopRoi = opts.stopPropio
    ? null
    : opts.stopLossRoiPct != null && opts.stopLossRoiPct !== '' && D(opts.stopLossRoiPct).gt(0)
      ? D(opts.stopLossRoiPct)
      : null;
  const sides: PreviewSide[] = [];

  for (const lado of ['LONG', 'SHORT'] as const) {
    // En el orden en que el precio las tocaría yendo en contra: un largo, de
    // arriba abajo; un corto, de abajo arriba.
    const entradas = niveles
      .filter((n) => n.lv.isEntry && n.lado === lado && n.norm.qty.gt(0))
      .map((n) => ({
        price: n.norm.price,
        qty: n.norm.qty,
        margin: margenDe(n.lv, n.norm.price.mul(n.norm.qty)),
        index: n.lv.index,
      }))
      .sort((a, b) =>
        lado === 'LONG' ? b.price.comparedTo(a.price) : a.price.comparedTo(b.price),
      );
    if (entradas.length === 0) continue;

    const recorrido = recorridoPeorCaso(
      entradas,
      lado,
      leverage,
      mmr,
      stopRoi,
      opts.topeNocional ? { nocional: opts.topeNocional, desde: opts.topeDesde ?? 0 } : null,
    );
    // Lo que el tope no deja tender no se coloca nunca: fuera de los totales de
    // «todas las órdenes». Lo que cortan el stop o la liquidación sí se coloca,
    // aunque no llegue a llenarse, y sigue contando.
    if (recorrido.corte?.por === 'TOPE') {
      for (const e of entradas.slice(recorrido.corte.nivel)) {
        totalNotional = totalNotional.minus(e.price.mul(e.qty));
        totalMargin = totalMargin.minus(e.margin);
      }
    }
    const media = recorrido.media;
    if (!media || recorrido.llenos === 0) continue;
    const llenas = entradas.slice(0, recorrido.llenos);
    const qty = recorrido.qty;
    const salida = exitSide(lado);
    const signo = lado === 'SHORT' ? D(-1) : D(1);

    // Una salida, con todo lo que un exchange enseña al poner un TP/SL.
    const exit = (bruto: Decimal, qtySalida: Decimal): PreviewExit => {
      const precio = D(px(market, bruto, salida));
      const pnl = qtySalida.mul(precio.minus(media)).mul(signo);
      const margenSalida = qtySalida.mul(media).div(leverage);
      return {
        price: precio.toFixed(market.priceDecimals),
        movePct: precio.minus(media).div(media).mul(100).toFixed(2),
        fromRefPct: ref.gt(0) ? precio.minus(ref).div(ref).mul(100).toFixed(2) : '0.00',
        qty: qtySalida.toFixed(market.qtyDecimals),
        pnl: pnl.toFixed(2),
        roiPct: margenSalida.gt(0) ? pnl.div(margenSalida).mul(100).toFixed(2) : '0.00',
      };
    };

    const liquidacion = precioLiquidacion(media, leverage, mmr, lado);
    const stop = opts.stopPropio
      ? D(opts.stopPropio.precio)
      : stopRoi
        ? precioDeRoi(media, stopRoi.neg(), leverage, lado)
        : null;
    const obj = opts.objetivo ?? null;
    const precioObjetivo = obj
      ? 'roiPct' in obj
        ? precioDeRoi(media, obj.roiPct, leverage, lado)
        : D(obj.precio)
      : null;
    const qtyObjetivo =
      obj?.qty != null
        ? Decimal.min(D(obj.qty), qty)
        : obj?.reserva != null
          ? Decimal.max(qty.minus(D(obj.reserva)), D(0))
          : qty;
    const takeProfit =
      precioObjetivo && precioObjetivo.gt(0) && qtyObjetivo.gt(0)
        ? exit(precioObjetivo, qtyObjetivo)
        : null;
    const stopLoss = stop && stop.gt(0) ? exit(stop, qty) : null;
    // En precio y no en dinero: con un objetivo parcial (el satélite, el primer
    // objetivo de un agente) el dinero compararía cantidades distintas.
    const beneficio = takeProfit ? D(takeProfit.price).minus(media).mul(signo) : null;
    const riesgo = stopLoss ? media.minus(stopLoss.price).mul(signo) : null;

    sides.push({
      direction: lado,
      entries: recorrido.llenos,
      averageEntry: media.toFixed(market.priceDecimals),
      qty: qty.toFixed(market.qtyDecimals),
      notional: llenas.reduce((s, e) => s.plus(e.price.mul(e.qty)), D(0)).toFixed(2),
      margin: llenas.reduce((s, e) => s.plus(e.margin), D(0)).toFixed(2),
      takeProfit,
      takeProfitIsActivation: obj?.activacion === true,
      stopLoss,
      stopLossEstimated: opts.stopPropio?.estimado === true,
      rewardRisk:
        beneficio && riesgo && beneficio.gt(0) && riesgo.gt(0)
          ? beneficio.div(riesgo).toFixed(2)
          : null,
      liquidation: liquidacion ? exit(liquidacion, qty) : null,
      liquidationIsBound: opts.marginMode === 'CROSS',
      cutAt: recorrido.corte
        ? { level: entradas[recorrido.corte.nivel].index, by: recorrido.corte.por }
        : null,
    });
  }

  if (opts.marginMode === 'CROSS') {
    issues.push(
      warn(
        'marginMode',
        'En margen cruzado la liquidación es una cota: el venue suma todo el saldo libre de la ' +
          'cuenta y las demás posiciones, así que la real queda más lejos.',
      ),
    );
  }

  for (const l of out) {
    if (l.violations.length > 0) {
      issues.push(err(null, 'Nivel ' + l.index + ': ' + l.violations.join(' ')));
    }
  }

  return {
    levels: out,
    worstCaseNotional: totalNotional.toFixed(2),
    worstCaseMargin: totalMargin.toFixed(2),
    leverage,
    marginMode: opts.marginMode ?? null,
    sides,
    valid: !issues.some((i) => i.severity === 'ERROR'),
    issues,
  };
}

/**
 * Formatea un precio para una orden concreta.
 *
 * Usa el redondeo CONSERVADOR por lado (`roundPriceForSide`) y no un `toFixed`
 * a secas: con `toFixed` una compra puede redondear hacia ARRIBA y acabar
 * cruzando el libro — que en una orden post-only significa rechazo, y en una
 * limit normal significa pagar comisión de taker sin querer. Además garantiza
 * que el precio cae exactamente en la retícula de ticks del venue, así que lo
 * que se ve en el preview es literalmente lo que se manda.
 */
export const px = (market: MarketSpec, price: Numeric, side: OrderSide): string =>
  // Con el tope de cifras significativas del venue cuando lo declara: así lo
  // que planifica la estrategia es lo que envía el adaptador (001/F-04).
  roundPriceForSide(price, market.tickSize, side, market.maxSignificantDigits).toFixed(
    market.priceDecimals,
  );

/** Cantidad truncada al step del venue: nunca pide más margen del previsto. */
export const qy = (market: MarketSpec, qty: Numeric): string =>
  floorToStep(qty, market.stepSize).toFixed(market.qtyDecimals);

/** Lado de entrada y de salida segun la direccion del bot. */
export const entrySide = (d: Direction): OrderSide => (d === 'SHORT' ? 'SELL' : 'BUY');
export const exitSide = (d: Direction): OrderSide => (d === 'SHORT' ? 'BUY' : 'SELL');

/** Tamano absoluto de la posicion actual; 0 si esta plana. */
export const positionSize = (ctx: { position: { qty: string } | null }): Decimal =>
  ctx.position ? D(ctx.position.qty).abs() : D(0);

/**
 * Config con acceso indexado. Las estrategias declaran su propia interfaz y la
 * validan; este alias solo evita castings ruidosos en los puntos de entrada.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- valvula de escape documentada arriba
export type AnyConfig = BotConfig & Record<string, any>;
