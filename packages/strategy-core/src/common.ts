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
  type PreviewResult,
  type ValidationIssue,
  type ValidationResult,
  estimateLiquidationPrice,
  liquidationDistancePct,
  maintenanceMarginRateOf,
  maxLeverageWithinDistance,
  MIN_LIQUIDATION_DISTANCE_PCT,
} from '@crypton/shared';
import { weightedAverage } from './ladder';

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
    min: 0.1,
    max: 90,
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

/** Validaciones que aplican a cualquier estrategia. */
export function validateCommon(config: CommonBotConfig, market: MarketSpec): ValidationIssue[] {
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
  } else if (lev > maxLeverageWithinDistance(maintenanceMarginRateOf(market))) {
    // La misma cuenta que la API (`RiskService`) y el asistente, con la tasa
    // de mantenimiento de ESTE mercado: antes el formulario avisaba a 12x, la
    // API rechazaba a 19x en todos los pares y nadie decia el tope (001/F-44).
    const mmr = maintenanceMarginRateOf(market);
    issues.push(
      err(
        'leverage',
        'A ' +
          lev +
          'x la liquidacion estimada llega con menos del ' +
          MIN_LIQUIDATION_DISTANCE_PCT +
          ' % de movimiento adverso (mantenimiento del ' +
          (mmr * 100).toFixed(2) +
          ' %): el maximo aqui es ' +
          maxLeverageWithinDistance(mmr) +
          'x.',
      ),
    );
  } else if (lev > 10) {
    const move = (100 / lev).toFixed(1);
    issues.push(warn('leverage', lev + 'x liquida con un movimiento adverso de ~' + move + ' %.'));
  }

  const total = D(config.totalInvestment ?? 0);
  if (!total.isFinite() || total.lte(0)) {
    issues.push(err('totalInvestment', 'La inversion total debe ser mayor que cero.'));
  }

  if (config.maxNotionalCap) {
    const cap = D(config.maxNotionalCap);
    const notional = total.mul(lev || 1);
    if (cap.gt(0) && cap.lt(notional)) {
      issues.push(
        warn(
          'maxNotionalCap',
          'El tope (' +
            cap.toFixed(2) +
            ') es menor que el notional del bot (' +
            notional.toFixed(2) +
            '): no llegara a tender la escalera completa.',
        ),
      );
    }
  }

  // `meta.fields` acota `stopLossPct` (0,1-90) y `maxDailyLossPct` (0,1-100),
  // pero solo el formulario lo aplicaba: la API aceptaba `stopLossPct: 150`, el
  // disparo salia a precio negativo y la posicion se quedaba sin stop con un
  // WARN; y una perdida diaria de cero pausaba el bot al arrancar (001/F-13).
  // Se rechaza lo que nunca pudo venir de la app. Vacio o nulo sigue siendo
  // «sin stop» / «sin limite», como siempre.
  const stopPct = config.stopLossPct;
  if (stopPct !== undefined && stopPct !== null && stopPct !== '') {
    const pct = D(stopPct);
    if (!pct.isFinite() || pct.lte(0) || pct.gte(100)) {
      issues.push(err('stopLossPct', 'El stop loss debe estar entre 0 y 100 %, sin incluirlos.'));
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
 */
export function camposEfectivos(
  fields: readonly FieldMeta[],
  config: Record<string, unknown>,
  market: MarketSpec,
): FieldMeta[] {
  if (config['sizingMode'] !== 'BASE') return [...fields];
  // Sin `minQty` declarada manda el paso de cantidad, que es la granularidad
  // más pequeña que el venue acepta de todas formas.
  const suelo = [market.minQty, market.stepSize]
    .map((v) => Number(v ?? 0))
    .find((n) => Number.isFinite(n) && n > 0);
  return fields.map((f) =>
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
    worstCaseAverageEntry: null,
    estimatedLiquidationPrice: null,
    liquidationDistancePct: null,
    takeProfitPrice: null,
    valid: false,
    issues,
  };
}

/** Un nivel tal y como lo describe una estrategia, antes de normalizar. */
export interface RawLevel {
  index: number;
  kind: LevelKind;
  side: OrderSide;
  price: Numeric;
  qty: Numeric;
  margin: Numeric;
  /** true = entrada; cuenta para el precio medio y para el peor caso. */
  isEntry: boolean;
}

export interface BuildPreviewOptions {
  levels: RawLevel[];
  market: MarketSpec;
  refPrice: Numeric;
  direction: Direction;
  leverage: number;
  takeProfitPct?: Numeric | null;
  issues?: ValidationIssue[];
  /**
   * Modo de margen de la config. En cruzado la fórmula aislada es una COTA: el
   * venue suma todo el saldo libre de la cuenta y las demás posiciones, así que
   * la liquidación real queda en otro sitio (001/F-14). Se avisa en vez de
   * callarlo bajo la etiqueta «fórmula del venue».
   */
  marginMode?: string | null;
  /**
   * true = retícula neutral: las dos mitades abren posición en sentidos
   * opuestos. La liquidación que se enseña es la del lado largo (todas las
   * compras ejecutadas) y la del lado corto (todas las ventas) va como aviso:
   * antes se calculaba una sola sobre la media de las dos mitades, que no es
   * el precio de ninguna posición posible (001/F-14).
   */
  neutral?: boolean;
}

/**
 * Convierte los niveles crudos de una estrategia en el preview que ve el
 * usuario: redondea contra la reticula del venue, acumula notional y margen y
 * calcula el peor caso (todos los niveles ejecutados) con su liquidacion
 * estimada. Toda estrategia pasa por aqui, asi el wizard es identico para todas.
 */
export function buildPreview(opts: BuildPreviewOptions): PreviewResult {
  const { levels, market, refPrice, direction, leverage } = opts;

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

  const out: LevelPreview[] = [];
  const entriesSoFar: { price: Decimal; qty: Decimal; side: OrderSide }[] = [];
  let cumulativeNotional = D(0);
  let cumulativeMargin = D(0);

  for (const lv of levels) {
    const norm = normalizeOrder(market, lv.price, lv.qty, lv.side);
    const notional = norm.price.mul(norm.qty);

    if (lv.isEntry) {
      cumulativeNotional = cumulativeNotional.plus(notional);
      cumulativeMargin = cumulativeMargin.plus(D(lv.margin));
      if (norm.qty.gt(0)) entriesSoFar.push({ price: norm.price, qty: norm.qty, side: lv.side });
    }

    const avg = entriesSoFar.length ? weightedAverage(entriesSoFar) : null;

    out.push({
      index: lv.index,
      kind: lv.kind,
      side: lv.side,
      price: norm.price.toFixed(market.priceDecimals),
      qty: norm.qty.toFixed(market.qtyDecimals),
      notional: notional.toFixed(2),
      marginUsed: D(lv.margin).toFixed(2),
      cumulativeNotional: cumulativeNotional.toFixed(2),
      cumulativeMargin: cumulativeMargin.toFixed(2),
      averageEntry: avg ? avg.toFixed(market.priceDecimals) : null,
      distancePct: ref.gt(0) ? norm.price.minus(ref).div(ref).mul(100).toFixed(2) : '0.00',
      violations: norm.violations,
    });
  }

  const worstAvg = entriesSoFar.length ? weightedAverage(entriesSoFar) : null;
  // Con la tasa de mantenimiento del MERCADO, no el 0,5 % plano (001/F-93).
  const mmr = maintenanceMarginRateOf(market);
  // Retícula neutral: la liquidación que manda es la del lado largo (todas las
  // compras ejecutadas); el lado corto va como aviso, más abajo.
  const largos = entriesSoFar.filter((e) => e.side === 'BUY');
  const cortos = entriesSoFar.filter((e) => e.side === 'SELL');
  const avgLiq = opts.neutral ? (largos.length ? weightedAverage(largos) : null) : worstAvg;
  const liq = avgLiq ? estimateLiquidationPrice(avgLiq, leverage, direction, mmr) : null;
  const avgCorto = opts.neutral && cortos.length > 0 ? weightedAverage(cortos) : null;
  if (avgCorto) {
    const liqCorto = estimateLiquidationPrice(avgCorto, leverage, 'SHORT', mmr);
    if (liqCorto) {
      issues.push(
        warn(
          null,
          'Lado corto: con todas las ventas ejecutadas, la liquidación estimada queda en ' +
            liqCorto.toFixed(market.priceDecimals) +
            ' (a ' +
            liquidationDistancePct(ref, liqCorto).toFixed(2) +
            ' % del precio de referencia).',
        ),
      );
    }
  }
  if (opts.marginMode === 'CROSS') {
    issues.push(
      warn(
        'marginMode',
        'En margen cruzado la liquidación estimada es una cota: el venue suma todo el saldo ' +
          'libre de la cuenta y las demás posiciones, así que la real queda en otro sitio.',
      ),
    );
  }

  const tpSign = direction === 'SHORT' ? D(-1) : D(1);
  const tp =
    worstAvg && opts.takeProfitPct != null
      ? worstAvg.mul(D(1).plus(tpSign.mul(D(opts.takeProfitPct)).div(100)))
      : null;

  for (const l of out) {
    if (l.violations.length > 0) {
      issues.push(err(null, 'Nivel ' + l.index + ': ' + l.violations.join(' ')));
    }
  }

  return {
    levels: out,
    worstCaseNotional: cumulativeNotional.toFixed(2),
    worstCaseMargin: cumulativeMargin.toFixed(2),
    worstCaseAverageEntry: worstAvg ? worstAvg.toFixed(market.priceDecimals) : null,
    estimatedLiquidationPrice: liq ? liq.toFixed(market.priceDecimals) : null,
    liquidationDistancePct: liq ? liquidationDistancePct(ref, liq).toFixed(2) : null,
    takeProfitPrice: tp ? tp.toFixed(market.priceDecimals) : null,
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
