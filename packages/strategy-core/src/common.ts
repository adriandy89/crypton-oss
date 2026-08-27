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
  } else if (lev > 10) {
    const move = (100 / lev).toFixed(1);
    issues.push(
      warn('leverage', lev + 'x liquida con un movimiento adverso de ~' + move + ' %.'),
    );
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

  if (!market.active) {
    issues.push(err('symbol', 'El mercado ' + market.symbol + ' no esta activo en ' + market.venue));
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

  const out: LevelPreview[] = [];
  const entriesSoFar: { price: Decimal; qty: Decimal }[] = [];
  let cumulativeNotional = D(0);
  let cumulativeMargin = D(0);

  for (const lv of levels) {
    const norm = normalizeOrder(market, lv.price, lv.qty, lv.side);
    const notional = norm.price.mul(norm.qty);

    if (lv.isEntry) {
      cumulativeNotional = cumulativeNotional.plus(notional);
      cumulativeMargin = cumulativeMargin.plus(D(lv.margin));
      if (norm.qty.gt(0)) entriesSoFar.push({ price: norm.price, qty: norm.qty });
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
  const liq = worstAvg ? estimateLiquidationPrice(worstAvg, leverage, direction) : null;

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
  roundPriceForSide(price, market.tickSize, side).toFixed(market.priceDecimals);

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
export type AnyConfig = BotConfig & Record<string, any>;
