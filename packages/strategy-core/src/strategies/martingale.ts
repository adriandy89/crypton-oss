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
  positionSize,
  px,
  qy,
  toResult,
  validateCommon,
  warn,
  type RawLevel,
} from '../common';
import { scaledLadder, takeProfitPrice } from '../ladder';
import type { Strategy } from '../types';

export interface MartingaleConfig extends CommonBotConfig {
  numLimitBuys: number;
  initialSeparationPct: string;
  volumeScale: string;
  stepScale: string;
  takeProfitPct: string;
  /** Cómo se abre el ciclo: a mercado (entra ya) o limit al precio actual. */
  baseOrderType?: 'MARKET' | 'LIMIT';
  /** LIMIT deja la salida como maker; MARKET garantiza el cierre. */
  tpMode?: 'LIMIT' | 'MARKET';
}

export const MARTINGALE_FIELDS: readonly FieldMeta[] = [
  {
    key: 'numLimitBuys',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.martingale.numLimitBuys',
    helpKey: 'strategy.martingale.numLimitBuysHelp',
    min: 1,
    max: 30,
    step: 1,
    required: true,
    default: 6,
    risky: true,
  },
  {
    key: 'initialSeparationPct',
    kind: 'percent',
    mutability: Mutability.WARM,
    labelKey: 'strategy.martingale.initialSeparationPct',
    helpKey: 'strategy.martingale.initialSeparationPctHelp',
    min: 0.05,
    max: 20,
    step: 0.05,
    required: true,
    default: 1,
  },
  {
    key: 'volumeScale',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.martingale.volumeScale',
    helpKey: 'strategy.martingale.volumeScaleHelp',
    min: 1,
    max: 5,
    step: 0.1,
    required: true,
    default: 1.6,
    risky: true,
  },
  {
    key: 'stepScale',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.martingale.stepScale',
    helpKey: 'strategy.martingale.stepScaleHelp',
    min: 1,
    max: 3,
    step: 0.05,
    required: true,
    default: 1.2,
  },
  {
    key: 'takeProfitPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.martingale.takeProfitPct',
    helpKey: 'strategy.martingale.takeProfitPctHelp',
    min: 0.05,
    max: 50,
    step: 0.05,
    required: true,
    default: 1,
  },
  {
    key: 'baseOrderType',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.martingale.baseOrderType',
    options: ['MARKET', 'LIMIT'],
    required: false,
    default: 'MARKET',
  },
  {
    key: 'tpMode',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.martingale.tpMode',
    options: ['LIMIT', 'MARKET'],
    required: false,
    default: 'LIMIT',
  },
] as const;

const META: StrategyMeta = {
  kind: StrategyKind.MARTINGALE,
  labelKey: 'strategy.martingale.label',
  descriptionKey: 'strategy.martingale.description',
  fields: [...COMMON_FIELDS, ...MARTINGALE_FIELDS],
};

/**
 * Validaciones compartidas con GridMart, que hereda toda la parte de escalera.
 * Aquí es donde se convierte "peor caso" en un número que el usuario ve antes
 * de arrancar, en vez de descubrirlo cuando el bot ya lleva 5 niveles llenos.
 */
export function validateLadderConfig(
  cfg: MartingaleConfig,
  market: MarketSpec,
): ReturnType<typeof validateCommon> {
  const issues = validateCommon(cfg, market);

  const n = Math.floor(cfg.numLimitBuys ?? 0);
  if (n < 1) issues.push(err('numLimitBuys', 'Se necesita al menos 1 orden de seguridad.'));
  if (n > 30) issues.push(err('numLimitBuys', 'Máximo 30 órdenes de seguridad.'));

  const sep = D(cfg.initialSeparationPct ?? 0);
  if (!sep.isFinite() || sep.lte(0)) {
    issues.push(err('initialSeparationPct', 'La separación inicial debe ser mayor que cero.'));
  }

  const vol = D(cfg.volumeScale ?? 1);
  if (!vol.isFinite() || vol.lt(1)) {
    issues.push(err('volumeScale', 'El multiplicador de volumen no puede ser menor que 1.'));
  }
  const step = D(cfg.stepScale ?? 1);
  if (!step.isFinite() || step.lt(1)) {
    issues.push(err('stepScale', 'El multiplicador de distancia no puede ser menor que 1.'));
  }

  const tp = D(cfg.takeProfitPct ?? 0);
  if (!tp.isFinite() || tp.lte(0)) {
    issues.push(err('takeProfitPct', 'El take profit debe ser mayor que cero.'));
  }

  // Cobertura total de la escalera: hasta dónde aguanta antes de quedarse sin
  // órdenes. Si es menor que la distancia a liquidación, el bot se queda sin
  // munición justo antes de que el venue cierre la posición.
  if (n >= 1 && sep.gt(0) && step.gte(1)) {
    let gap = sep;
    let coverage = D(0);
    for (let i = 0; i < n; i++) {
      coverage = coverage.plus(gap);
      gap = gap.mul(step);
    }
    const lev = Number(cfg.leverage) || 1;
    const liqDistance = D(100).div(lev);
    if (coverage.gte(liqDistance)) {
      issues.push(
        err(
          'numLimitBuys',
          'La escalera cubre un ' +
            coverage.toFixed(1) +
            ' % de recorrido, pero a ' +
            lev +
            'x la liquidación llega sobre el ' +
            liqDistance.toFixed(1) +
            ' %: los últimos niveles nunca se ejecutarían.',
        ),
      );
    } else if (coverage.lt(liqDistance.div(2))) {
      issues.push(
        warn(
          'numLimitBuys',
          'La escalera solo cubre un ' +
            coverage.toFixed(1) +
            ' % de caída. Por debajo de ahí el bot deja de promediar.',
        ),
      );
    }
  }

  if (vol.gt(2.5)) {
    issues.push(
      warn(
        'volumeScale',
        'Con ' + vol.toFixed(2) + 'x, el último nivel es varias veces mayor que el primero.',
      ),
    );
  }
  return issues;
}

/** Niveles crudos de la escalera; los comparte GridMart tal cual. */
export function ladderLevels(cfg: MartingaleConfig, anchor: string): RawLevel[] {
  const levels = scaledLadder({
    anchor,
    safetyCount: Math.max(0, Math.floor(cfg.numLimitBuys ?? 0)),
    initialSeparationPct: cfg.initialSeparationPct,
    stepScale: cfg.stepScale,
    volumeScale: cfg.volumeScale,
    totalMargin: cfg.totalInvestment,
    leverage: cfg.leverage,
    direction: cfg.direction,
  });

  return levels.map((lv) => ({
    index: lv.index,
    kind: lv.index === 0 ? LevelKind.BASE : LevelKind.SAFETY,
    side: entrySide(cfg.direction),
    price: lv.price,
    qty: lv.qty,
    margin: lv.margin,
    isEntry: true,
  }));
}

export const martingale: Strategy<MartingaleConfig> = {
  kind: StrategyKind.MARTINGALE,
  meta: META,

  defaults() {
    return {
      numLimitBuys: 6,
      initialSeparationPct: '1',
      volumeScale: '1.6',
      stepScale: '1.2',
      takeProfitPct: '1',
      baseOrderType: 'MARKET',
      tpMode: 'LIMIT',
      leverage: 2,
      marginMode: 'ISOLATED',
      direction: 'LONG',
      cooldownMinutes: 1,
    };
  },

  validate(cfg: MartingaleConfig, market: MarketSpec): ValidationResult {
    return toResult(validateLadderConfig(cfg, market));
  },

  preview(cfg: MartingaleConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const issues = validateLadderConfig(cfg, market);
    // Ver `invalidPreview`: sin config valida, calcular es reventar.
    if (issues.some((i) => i.severity === 'ERROR')) return invalidPreview(issues);
    return buildPreview({
      levels: ladderLevels(cfg, refPrice),
      market,
      refPrice,
      direction: cfg.direction,
      leverage: cfg.leverage,
      takeProfitPct: cfg.takeProfitPct,
      issues,
    });
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as MartingaleConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const mark = D(ctx.ticker.mark);
    const pos = positionSize(ctx);

    const orders: DesiredOrder[] = [];
    const immediate: DesiredOrder[] = [];

    // ── Sin posición: abrir ciclo (salvo que estemos en cooldown) ──
    if (pos.lte(0)) {
      if (ctx.cycle.cooldownUntil && ctx.now < ctx.cycle.cooldownUntil) {
        const secs = Math.ceil((ctx.cycle.cooldownUntil - ctx.now) / 1000);
        return {
          orders: [],
          immediate: [],
          note: 'En cooldown, ' + secs + ' s para el próximo ciclo.',
        };
      }

      const base = scaledLadder({
        anchor: mark,
        safetyCount: Math.max(0, Math.floor(cfg.numLimitBuys ?? 0)),
        initialSeparationPct: cfg.initialSeparationPct,
        stepScale: cfg.stepScale,
        volumeScale: cfg.volumeScale,
        totalMargin: cfg.totalInvestment,
        leverage: cfg.leverage,
        direction: cfg.direction,
      })[0];

      const entry: DesiredOrder = {
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.BASE, 0),
        levelKind: LevelKind.BASE,
        levelIndex: 0,
        side: entrySide(cfg.direction),
        type: cfg.baseOrderType === 'LIMIT' ? 'POST_ONLY' : 'MARKET',
        price: px(ctx.market, mark, entrySide(cfg.direction)),
        qty: qy(ctx.market, base.qty),
        reduceOnly: false,
      };
      // MARKET va por `immediate`: se manda una vez y no se reconcilia, porque
      // una orden a mercado o se ejecuta o no existe — no hay nada que converger.
      if (entry.type === 'MARKET') immediate.push(entry);
      else orders.push(entry);

      return { orders, immediate, targetLeverage: cfg.leverage, note: 'Abriendo ciclo.' };
    }

    // ── Con posición: escalera de seguridad + salida ──
    // El ancla es el precio de la entrada base, NO el precio actual: si se
    // recalculara con el mercado, las seguridades bajarían con él y jamás
    // llegarían a tocarse.
    const anchor = ctx.cycle.anchorPrice ?? ctx.position!.entryPrice;
    const ladder = scaledLadder({
      anchor,
      safetyCount: Math.max(0, Math.floor(cfg.numLimitBuys ?? 0)),
      initialSeparationPct: cfg.initialSeparationPct,
      stepScale: cfg.stepScale,
      volumeScale: cfg.volumeScale,
      totalMargin: cfg.totalInvestment,
      leverage: cfg.leverage,
      direction: cfg.direction,
    });

    const filled = new Set(ctx.cycle.filledLevelIndexes);
    const cap = cfg.maxNotionalCap ? D(cfg.maxNotionalCap) : null;
    let projectedNotional = pos.mul(mark);

    for (let i = 1; i < ladder.length; i++) {
      if (filled.has(i)) continue;
      const lv = ladder[i];
      if (lv.qty.lte(0)) continue;

      if (cap != null && cap.gt(0) && projectedNotional.plus(lv.notional).gt(cap)) {
        // El tope corta la escalera aquí; los niveles restantes no se tienden.
        break;
      }
      projectedNotional = projectedNotional.plus(lv.notional);

      orders.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.SAFETY, i),
        levelKind: LevelKind.SAFETY,
        levelIndex: i,
        side: entrySide(cfg.direction),
        type: 'POST_ONLY',
        price: px(ctx.market, lv.price, entrySide(cfg.direction)),
        qty: qy(ctx.market, lv.qty),
        reduceOnly: false,
      });
    }

    // Take profit sobre el precio medio REAL que reporta el venue: al llenarse
    // una seguridad el medio se mueve y esta orden se recoloca sola en el
    // siguiente tick, que es exactamente lo que debe pasar.
    const avgEntry = ctx.position!.entryPrice;
    const tp = takeProfitPrice(avgEntry, cfg.takeProfitPct, cfg.direction);
    orders.push({
      clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
      levelKind: LevelKind.TAKE_PROFIT,
      levelIndex: 0,
      side: exitSide(cfg.direction),
      type: cfg.tpMode === 'MARKET' ? 'MARKET' : 'LIMIT',
      price: px(ctx.market, tp, exitSide(cfg.direction)),
      qty: qy(ctx.market, pos),
      reduceOnly: true,
    });

    // El STOP_LOSS no se emite aquí: lo añade el motor para las siete
    // estrategias por igual. Ver `BotRunner.withStopLoss`.

    const remaining = ladder.length - 1 - filled.size;
    return {
      orders,
      immediate,
      targetLeverage: cfg.leverage,
      note: 'Ciclo abierto: ' + Math.max(0, remaining) + ' seguridades pendientes.',
    };
  },
};

/** Reexportado para GridMart, que construye su TP sobre el mismo cálculo. */
export const martingaleTakeProfit = (
  avgEntry: string,
  pct: string,
  direction: MartingaleConfig['direction'],
): Decimal => takeProfitPrice(avgEntry, pct, direction);
