import {
  D,
  Decimal,
  LevelKind,
  Mutability,
  StrategyKind,
  type BotContext,
  type CommonBotConfig,
  type DesiredOrder,
  type DesiredState,
  type FieldMeta,
  type MarketSpec,
  type PreviewResult,
  type StrategyMeta,
  type ValidationResult,
} from '@crypton/shared';
import { makeCoid } from '../client-order-id';
import {
  COMMON_FIELDS,
  buildPreview,
  entrySide,
  err,
  exitSide,
  invalidPreview,
  px,
  qy,
  toResult,
  validateCommon,
  warn,
  type RawLevel,
} from '../common';
import { arithmeticPrices, geometricPrices } from '../ladder';
import type { Strategy } from '../types';

export interface GridClassicConfig extends CommonBotConfig {
  gridSpacing: 'ARITHMETIC' | 'GEOMETRIC';
  sizingMode: 'QUOTE' | 'BASE';
  lowerPrice: string;
  upperPrice: string;
  gridLevels: number;
  /**
   * true = al arrancar compra a mercado el inventario necesario para poder
   * vender en las lineas que quedan por encima del precio. Es como funcionan
   * los grid de los exchanges, pero abre exposicion inmediata; por eso viene
   * apagado y se avisa en el preview.
   */
  preloadInventory?: boolean;
  /** true = si el precio sale del rango, el bot deja de tender ordenes nuevas. */
  stopOnRangeExit?: boolean;
}

const FIELDS: readonly FieldMeta[] = [
  ...COMMON_FIELDS,
  {
    key: 'gridSpacing',
    kind: 'enum',
    mutability: Mutability.WARM,
    labelKey: 'strategy.grid.spacing',
    helpKey: 'strategy.grid.spacingHelp',
    options: ['ARITHMETIC', 'GEOMETRIC'],
    required: true,
    default: 'ARITHMETIC',
  },
  {
    key: 'sizingMode',
    kind: 'enum',
    mutability: Mutability.WARM,
    labelKey: 'strategy.grid.sizingMode',
    helpKey: 'strategy.grid.sizingModeHelp',
    options: ['QUOTE', 'BASE'],
    required: true,
    default: 'QUOTE',
  },
  {
    key: 'lowerPrice',
    kind: 'price',
    mutability: Mutability.WARM,
    labelKey: 'strategy.grid.lowerPrice',
    required: true,
    risky: true,
  },
  {
    key: 'upperPrice',
    kind: 'price',
    mutability: Mutability.WARM,
    labelKey: 'strategy.grid.upperPrice',
    required: true,
    risky: true,
  },
  {
    key: 'gridLevels',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.grid.levels',
    helpKey: 'strategy.grid.levelsHelp',
    min: 3,
    max: 200,
    step: 1,
    required: true,
    default: 20,
  },
  {
    key: 'preloadInventory',
    kind: 'boolean',
    mutability: Mutability.COLD,
    labelKey: 'strategy.grid.preloadInventory',
    helpKey: 'strategy.grid.preloadInventoryHelp',
    required: false,
    default: false,
    risky: true,
  },
  {
    key: 'stopOnRangeExit',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.grid.stopOnRangeExit',
    helpKey: 'strategy.grid.stopOnRangeExitHelp',
    required: false,
    default: true,
  },
] as const;

const META: StrategyMeta = {
  kind: StrategyKind.GRID_CLASSIC,
  labelKey: 'strategy.grid.label',
  descriptionKey: 'strategy.grid.description',
  fields: FIELDS,
};

/** Precios de la retícula, de menor a mayor. */
function gridPrices(cfg: GridClassicConfig): Decimal[] {
  const levels = Math.max(2, Math.floor(cfg.gridLevels));
  return cfg.gridSpacing === 'GEOMETRIC'
    ? geometricPrices(cfg.lowerPrice, cfg.upperPrice, levels)
    : arithmeticPrices(cfg.lowerPrice, cfg.upperPrice, levels);
}

/**
 * Cantidad por línea.
 *
 * QUOTE reparte el mismo importe en cada línea, así que abajo se compran más
 * unidades que arriba (el comportamiento que casi todo el mundo espera de un
 * grid). BASE compra las mismas unidades en todas, lo que concentra más capital
 * en la parte alta del rango.
 */
function levelQty(cfg: GridClassicConfig, price: Decimal, refPrice: Decimal): Decimal {
  const levels = Math.max(2, Math.floor(cfg.gridLevels));
  const perLevelNotional = D(cfg.totalInvestment).mul(cfg.leverage).div(levels);
  const denom = cfg.sizingMode === 'BASE' ? refPrice : price;
  return denom.gt(0) ? perLevelNotional.div(denom) : D(0);
}

/**
 * Precio de venta de la línea `i`: la línea inmediatamente superior. Para la
 * última se proyecta un salto igual al anterior, porque si no el inventario
 * comprado en el techo del rango no tendría contrapartida y quedaría colgado.
 */
function sellPriceFor(prices: Decimal[], i: number): Decimal {
  if (i + 1 < prices.length) return prices[i + 1];
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2] ?? last;
  return last.plus(last.minus(prev));
}

function buyPriceFor(prices: Decimal[], i: number): Decimal {
  if (i - 1 >= 0) return prices[i - 1];
  const first = prices[0];
  const next = prices[1] ?? first;
  return first.minus(next.minus(first));
}

export const gridClassic: Strategy<GridClassicConfig> = {
  kind: StrategyKind.GRID_CLASSIC,
  meta: META,
  // El juego del grid es comprar abajo, vender arriba y REPETIR: al ejecutarse
  // la venta de un nivel, el nivel se libera y su compra puede recolocarse.
  // Sin estas dos piezas cada nivel operaba UNA vez por ciclo.
  reusesOrderSlots: true,
  recycleLevelOnExit: true,

  defaults() {
    return {
      gridSpacing: 'ARITHMETIC',
      sizingMode: 'QUOTE',
      gridLevels: 20,
      preloadInventory: false,
      stopOnRangeExit: true,
      leverage: 2,
      marginMode: 'ISOLATED',
      direction: 'LONG',
    };
  },

  validate(cfg: GridClassicConfig, market: MarketSpec): ValidationResult {
    const issues = validateCommon(cfg, market);
    const lower = D(cfg.lowerPrice ?? 0);
    const upper = D(cfg.upperPrice ?? 0);

    if (!lower.isFinite() || lower.lte(0)) {
      issues.push(err('lowerPrice', 'El precio inferior debe ser mayor que cero.'));
    }
    if (!upper.isFinite() || upper.lte(0)) {
      issues.push(err('upperPrice', 'El precio superior debe ser mayor que cero.'));
    }
    if (lower.gt(0) && upper.gt(0) && upper.lte(lower)) {
      issues.push(err('upperPrice', 'El precio superior debe estar por encima del inferior.'));
    }
    const levels = Math.floor(cfg.gridLevels ?? 0);
    if (levels < 3) issues.push(err('gridLevels', 'Se necesitan al menos 3 niveles.'));
    if (levels > 200) issues.push(err('gridLevels', 'Máximo 200 niveles.'));

    if (lower.gt(0) && upper.gt(lower) && levels >= 3) {
      // Un paso más pequeño que el tick del venue produce líneas que se
      // solapan al redondear: varias órdenes al mismo precio y ninguna ganancia.
      const step = upper.minus(lower).div(levels - 1);
      if (step.lt(D(market.tickSize).mul(2))) {
        issues.push(
          err(
            'gridLevels',
            'El paso de la retícula (' +
              step.toFixed(market.priceDecimals) +
              ') es menor que 2 ticks: reduce los niveles o amplía el rango.',
          ),
        );
      }
      const stepPct = step.div(lower).mul(100);
      if (stepPct.lt(0.05)) {
        issues.push(
          warn(
            'gridLevels',
            'Cada escalón es de solo ' +
              stepPct.toFixed(3) +
              ' %: puede no cubrir ni las comisiones.',
          ),
        );
      }
    }

    if (cfg.preloadInventory) {
      issues.push(
        warn('preloadInventory', 'Con precarga, el bot abre posición a mercado nada más arrancar.'),
      );
    }
    return toResult(issues);
  },

  preview(cfg: GridClassicConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const validation = this.validate(cfg, market);
    // Sin config valida no se puede calcular NADA: seguir adelante significaba
    // `D(undefined)` -> DecimalError -> 500 en `POST /bots/preview`. La escalera
    // no se pinta, pero los `issues` explican exactamente que falta.
    if (!validation.ok) return invalidPreview(validation.issues);
    const prices = gridPrices(cfg);
    const ref = D(refPrice);
    const levels: RawLevel[] = [];
    const perLevelMargin = D(cfg.totalInvestment).div(prices.length);
    const isLong = cfg.direction !== 'SHORT';

    prices.forEach((p, i) => {
      const qty = levelQty(cfg, p, ref);
      // La línea que queda del lado de la entrada es la que se tenderá primero.
      const isEntryLine = isLong ? p.lt(ref) : p.gt(ref);
      levels.push({
        index: i,
        kind: isEntryLine ? LevelKind.GRID_BUY : LevelKind.GRID_SELL,
        side: isEntryLine ? entrySide(cfg.direction) : exitSide(cfg.direction),
        price: p,
        qty,
        margin: perLevelMargin,
        // Solo las líneas de entrada consumen margen y forman el precio medio.
        isEntry: isEntryLine,
      });
    });

    return buildPreview({
      levels,
      market,
      refPrice,
      direction: cfg.direction,
      leverage: cfg.leverage,
      issues: validation.issues,
    });
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as GridClassicConfig;
    const prices = gridPrices(cfg);
    const ref = D(ctx.ticker.mark);
    const isLong = cfg.direction !== 'SHORT';
    const holding = new Set(ctx.cycle.filledLevelIndexes);
    // El MISMO `cycleSeq` que el motor, tenga o no id el ciclo. Aquí iba
    // `ctx.cycle.cycleId ? … : 0`, y en el motor el id es nulo desde el primer
    // cierre de ciclo (`cycleAfterFill` lo devuelve así y nadie lo repone hasta
    // una readopción): el plan emitía `.0.GBi` mientras el motor reconciliaba,
    // firmaba el stop y grababa las filas con `.N.`. En Hyperliquid y Lighter,
    // con ids opacos, las órdenes de hace dos ciclos pasaban por ajenas —nunca
    // se cancelaban— y tras una readopción se tendía una segunda compra por
    // línea. Las otras seis estrategias siempre lo hicieron así (001/F-15).
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);

    const lower = D(cfg.lowerPrice);
    const upper = D(cfg.upperPrice);
    const outOfRange = ref.lt(lower) || ref.gt(upper);

    const orders: DesiredOrder[] = [];
    const immediate: DesiredOrder[] = [];

    // Fuera de rango con la guarda activada: se dejan de tender entradas nuevas,
    // pero las salidas del inventario que ya se compró SIGUEN vivas — cancelarlas
    // dejaría la posición sin contrapartida, que es justo lo que arruina un grid.
    const acceptEntries = !(outOfRange && cfg.stopOnRangeExit !== false);

    const cap = cfg.maxNotionalCap ? D(cfg.maxNotionalCap) : null;
    const currentNotional = ctx.position ? D(ctx.position.qty).abs().mul(ref) : D(0);
    const capReached = cap != null && cap.gt(0) && currentNotional.gte(cap);

    prices.forEach((p, i) => {
      const qty = levelQty(cfg, p, ref);
      if (qty.lte(0)) return;

      const isEntryLine = isLong ? p.lt(ref) : p.gt(ref);

      if (!holding.has(i) && isEntryLine && acceptEntries && !capReached) {
        orders.push({
          clientOrderId: makeCoid(ctx.botId, seq, LevelKind.GRID_BUY, i),
          levelKind: LevelKind.GRID_BUY,
          levelIndex: i,
          side: entrySide(cfg.direction),
          type: 'POST_ONLY',
          price: px(ctx.market, p, entrySide(cfg.direction)),
          qty: qy(ctx.market, qty),
          reduceOnly: false,
        });
      }

      if (holding.has(i)) {
        const exitPrice = isLong ? sellPriceFor(prices, i) : buyPriceFor(prices, i);
        orders.push({
          clientOrderId: makeCoid(ctx.botId, seq, LevelKind.GRID_SELL, i),
          levelKind: LevelKind.GRID_SELL,
          levelIndex: i,
          side: exitSide(cfg.direction),
          type: 'POST_ONLY',
          price: px(ctx.market, exitPrice, exitSide(cfg.direction)),
          qty: qy(ctx.market, qty),
          reduceOnly: true,
        });
      }
    });

    let note: string | undefined;
    if (outOfRange && !acceptEntries) {
      note = 'Precio fuera del rango: sin entradas nuevas, salidas activas.';
    } else if (capReached) {
      note = 'Tope de notional alcanzado: sin entradas nuevas.';
    }

    return { orders, immediate, targetLeverage: cfg.leverage, note };
  },
};
