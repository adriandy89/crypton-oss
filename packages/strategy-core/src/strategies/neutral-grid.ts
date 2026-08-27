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
  commonFieldsWith,
  buildPreview,
  err,
  invalidPreview,
  px,
  qy,
  toResult,
  validateCommon,
  warn,
  type RawLevel,
} from '../common';
import { arithmeticPrices, geometricPrices, geometricWeights } from '../ladder';
import type { Strategy } from '../types';

export interface NeutralGridConfig extends CommonBotConfig {
  lowerPrice: string;
  upperPrice: string;
  /** Centro de la retícula. Por debajo se compra, por encima se vende. */
  anchorPrice: string;
  gridLevels: number;
  gridSpacing?: 'ARITHMETIC' | 'GEOMETRIC';
  /** >1 pondera más los niveles alejados del ancla. */
  sizeMultiplier?: string;
  maxExposure?: string | null;
  /** true = recentra la retícula si el precio se aleja demasiado del ancla. */
  reanchorOnDrift?: boolean;
  reanchorThresholdPct?: string;
}

const NEUTRAL_FIELDS: readonly FieldMeta[] = [
  {
    key: 'lowerPrice',
    kind: 'price',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.lowerPrice',
    required: true,
    risky: true,
  },
  {
    key: 'upperPrice',
    kind: 'price',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.upperPrice',
    required: true,
    risky: true,
  },
  {
    key: 'anchorPrice',
    kind: 'price',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.anchorPrice',
    helpKey: 'strategy.neutral.anchorPriceHelp',
    required: true,
  },
  {
    key: 'gridLevels',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.levels',
    min: 4,
    max: 200,
    step: 1,
    required: true,
    default: 20,
  },
  {
    key: 'gridSpacing',
    kind: 'enum',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.spacing',
    options: ['ARITHMETIC', 'GEOMETRIC'],
    required: false,
    default: 'GEOMETRIC',
  },
  {
    key: 'sizeMultiplier',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.sizeMultiplier',
    helpKey: 'strategy.neutral.sizeMultiplierHelp',
    min: 1,
    max: 3,
    step: 0.05,
    required: false,
    default: 1,
  },
  {
    key: 'maxExposure',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.neutral.maxExposure',
    helpKey: 'strategy.neutral.maxExposureHelp',
    min: 0,
    required: false,
    risky: true,
  },
  {
    key: 'reanchorOnDrift',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.neutral.reanchorOnDrift',
    helpKey: 'strategy.neutral.reanchorOnDriftHelp',
    required: false,
    default: false,
  },
  {
    key: 'reanchorThresholdPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.neutral.reanchorThresholdPct',
    min: 0.5,
    max: 50,
    step: 0.5,
    required: false,
    default: 10,
  },
] as const;

/**
 * La rejilla neutral es neutral de verdad: `plan()` no mira la dirección, cuelga
 * compras por debajo del ancla y ventas por encima pase lo que pase.
 *
 * Su `defaults()` ya decía `NEUTRAL`, pero el campo solo ofrecía largo y corto:
 * el asistente nacía con un valor que su propio desplegable no sabía pintar. Lo
 * cazó el test de invariantes de `meta.spec.ts`.
 */
const NEUTRAL_DIRECTION: FieldMeta = {
  key: 'direction',
  kind: 'enum',
  mutability: Mutability.COLD,
  labelKey: 'strategy.common.direction',
  options: ['NEUTRAL', 'LONG', 'SHORT'],
  required: true,
  default: 'NEUTRAL',
  group: 'core',
  control: 'segment',
};

const META: StrategyMeta = {
  kind: StrategyKind.NEUTRAL_GRID,
  labelKey: 'strategy.neutral.label',
  descriptionKey: 'strategy.neutral.description',
  fields: [...commonFieldsWith([NEUTRAL_DIRECTION]), ...NEUTRAL_FIELDS],
};

interface GridLine {
  index: number;
  price: Decimal;
  qty: Decimal;
  margin: Decimal;
  /** BUY para las líneas por debajo del ancla; SELL para las de arriba. */
  side: 'BUY' | 'SELL';
}

/**
 * Construye la retícula completa alrededor del ancla.
 *
 * El peso de cada línea crece con `sizeMultiplier` según se aleja del ancla:
 * abajo se compra más cuanto más barato y arriba se vende más cuanto más caro,
 * que es lo que hace que la posición neta revierta a cero cerca del centro.
 */
function buildLines(cfg: NeutralGridConfig): GridLine[] {
  const levels = Math.max(4, Math.floor(cfg.gridLevels ?? 4));
  const prices =
    cfg.gridSpacing === 'ARITHMETIC'
      ? arithmeticPrices(cfg.lowerPrice, cfg.upperPrice, levels)
      : geometricPrices(cfg.lowerPrice, cfg.upperPrice, levels);

  const anchor = D(cfg.anchorPrice);
  const mult = D(cfg.sizeMultiplier ?? 1);

  // Distancia en "escalones" desde el ancla, para ponderar sin depender de que
  // el ancla caiga justo sobre una línea.
  const ranks = prices.map((p, i) => {
    const below = p.lt(anchor);
    const anchorIndex = prices.findIndex((q) => q.gte(anchor));
    const ai = anchorIndex < 0 ? prices.length - 1 : anchorIndex;
    return { i, p, below, rank: Math.abs(i - ai) };
  });

  const maxRank = Math.max(1, ...ranks.map((r) => r.rank));
  const weightTable = geometricWeights(maxRank + 1, mult);
  const weightSum = ranks.reduce((acc, r) => acc.plus(weightTable[r.rank]), D(0));

  const totalMargin = D(cfg.totalInvestment);
  const lev = D(cfg.leverage);

  return ranks.map((r) => {
    const margin = weightSum.gt(0) ? totalMargin.mul(weightTable[r.rank]).div(weightSum) : D(0);
    const notional = margin.mul(lev);
    return {
      index: r.i,
      price: r.p,
      margin,
      qty: r.p.gt(0) ? notional.div(r.p) : D(0),
      side: r.below ? ('BUY' as const) : ('SELL' as const),
    };
  });
}

export const neutralGrid: Strategy<NeutralGridConfig> = {
  kind: StrategyKind.NEUTRAL_GRID,
  meta: META,
  // Las líneas se rearman solas por la banda muerta alrededor del precio: el
  // plan deja de desear una línea recién tocada y vuelve a desearla cuando el
  // precio se aleja. Reutilizan su id, así que el motor debe permitirlo.
  reusesOrderSlots: true,

  defaults() {
    return {
      gridLevels: 20,
      gridSpacing: 'GEOMETRIC',
      sizeMultiplier: '1',
      reanchorOnDrift: false,
      reanchorThresholdPct: '10',
      leverage: 2,
      marginMode: 'CROSS',
      direction: 'NEUTRAL',
    };
  },

  validate(cfg: NeutralGridConfig, market: MarketSpec): ValidationResult {
    const issues = validateCommon(cfg, market);
    const lower = D(cfg.lowerPrice ?? 0);
    const upper = D(cfg.upperPrice ?? 0);
    const anchor = D(cfg.anchorPrice ?? 0);

    if (lower.lte(0)) issues.push(err('lowerPrice', 'El precio inferior debe ser mayor que cero.'));
    if (upper.lte(lower)) {
      issues.push(err('upperPrice', 'El precio superior debe estar por encima del inferior.'));
    }
    if (anchor.lte(0)) issues.push(err('anchorPrice', 'Falta el precio de referencia.'));
    if (anchor.gt(0) && (anchor.lt(lower) || anchor.gt(upper))) {
      issues.push(err('anchorPrice', 'El precio de referencia debe caer dentro del rango.'));
    }

    const levels = Math.floor(cfg.gridLevels ?? 0);
    if (levels < 4) issues.push(err('gridLevels', 'Una retícula neutral necesita al menos 4 niveles.'));

    if (upper.gt(lower) && levels >= 4) {
      const step = upper.minus(lower).div(levels - 1);
      if (step.lt(D(market.tickSize).mul(2))) {
        issues.push(err('gridLevels', 'El paso de la retícula es menor que 2 ticks del venue.'));
      }
    }

    // Sin tope de exposición, una retícula neutral acumula posición sin freno
    // en cuanto el precio se va a un extremo del rango y se queda ahí.
    if (!cfg.maxExposure) {
      issues.push(
        warn(
          'maxExposure',
          'Sin tope de exposición: si el precio se pega a un extremo, la posición neta crece hasta agotar el margen.',
        ),
      );
    }
    return toResult(issues);
  },

  preview(cfg: NeutralGridConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const validation = this.validate(cfg, market);
    // Sin config valida no se puede calcular NADA: seguir adelante significaba
    // `D(undefined)` -> DecimalError -> 500 en `POST /bots/preview`. La escalera
    // no se pinta, pero los `issues` explican exactamente que falta.
    if (!validation.ok) return invalidPreview(validation.issues);
    const lines = buildLines(cfg);
    const levels: RawLevel[] = lines.map((l) => ({
      index: l.index,
      kind: l.side === 'BUY' ? LevelKind.GRID_BUY : LevelKind.GRID_SELL,
      side: l.side,
      price: l.price,
      qty: l.qty,
      margin: l.margin,
      // Ambos lados abren posición en una retícula neutral: las dos mitades
      // consumen margen y las dos cuentan para el peor caso.
      isEntry: true,
    }));

    return buildPreview({
      levels,
      market,
      refPrice,
      direction: cfg.direction === 'SHORT' ? 'SHORT' : 'LONG',
      leverage: cfg.leverage,
      issues: validation.issues,
    });
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as NeutralGridConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const pd = ctx.market.priceDecimals;
    const qd = ctx.market.qtyDecimals;
    const mark = D(ctx.ticker.mark);

    const lines = buildLines(cfg);

    // Banda muerta de medio escalón alrededor del precio: sin ella, la línea
    // más cercana al mercado cambiaría de lado en cada tick y el bot se pasaría
    // el día cancelando y recolocando la misma orden.
    const stepAvg =
      lines.length > 1
        ? D(cfg.upperPrice).minus(cfg.lowerPrice).div(lines.length - 1)
        : D(ctx.market.tickSize);
    const deadband = stepAvg.div(2);

    const posQty = ctx.position ? D(ctx.position.qty) : D(0);
    const exposure = posQty.abs().mul(mark);
    const cap = cfg.maxExposure ? D(cfg.maxExposure) : null;
    const capReached = cap != null && cap.gt(0) && exposure.gte(cap);

    const orders: DesiredOrder[] = [];

    for (const line of lines) {
      if (line.qty.lte(0)) continue;

      const isBuy = line.price.lt(mark.minus(deadband));
      const isSell = line.price.gt(mark.plus(deadband));
      if (!isBuy && !isSell) continue;

      // Con el tope alcanzado solo se dejan vivas las órdenes que REDUCEN la
      // posición neta; las que la aumentarían se retiran.
      if (capReached) {
        const wouldIncrease = (isBuy && posQty.gte(0)) || (isSell && posQty.lte(0));
        if (wouldIncrease) continue;
      }

      const kind = isBuy ? LevelKind.GRID_BUY : LevelKind.GRID_SELL;
      orders.push({
        clientOrderId: makeCoid(ctx.botId, seq, kind, line.index),
        levelKind: kind,
        levelIndex: line.index,
        side: isBuy ? 'BUY' : 'SELL',
        type: 'POST_ONLY',
        price: px(ctx.market, line.price, isBuy ? 'BUY' : 'SELL'),
        qty: qy(ctx.market, line.qty),
        // Nunca reduceOnly: en modo one-way cada línea solo mueve la posición
        // neta, y marcarlas reduceOnly haría que el venue rechazara la mitad
        // de la retícula cada vez que la posición cruza el cero.
        reduceOnly: false,
      });
    }

    let note = 'Retícula neutral: ' + orders.length + ' órdenes activas.';
    if (capReached) note = 'Tope de exposición alcanzado: solo órdenes que reducen posición.';

    if (cfg.reanchorOnDrift && cfg.reanchorThresholdPct) {
      const drift = mark.minus(cfg.anchorPrice).div(cfg.anchorPrice).mul(100).abs();
      if (drift.gte(cfg.reanchorThresholdPct)) {
        note += ' Desvío del ancla ' + drift.toFixed(1) + ' %: procede recentrar.';
      }
    }

    return { orders, immediate: [], targetLeverage: cfg.leverage, note };
  },
};
