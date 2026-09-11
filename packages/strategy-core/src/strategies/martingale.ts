import {
  D,
  Decimal,
  maintenanceMarginRateOf,
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
import { baseLimitPrice, scaledLadder, takeProfitPrice } from '../ladder';
import {
  TRAILING_DEFAULTS,
  camposTrailing,
  limpiarTrailing,
  trailingVigente,
  validarTrailing,
  type TrailingConfig,
} from '../trailing-take-profit';
import type { Strategy } from '../types';

export interface MartingaleConfig extends CommonBotConfig, TrailingConfig {
  numLimitBuys: number;
  initialSeparationPct: string;
  volumeScale: string;
  stepScale: string;
  /**
   * Beneficio al que sale, sobre el precio medio real del venue.
   *
   * Con `trailingTakeProfit` encendido este campo NO cambia de unidad ni de
   * sitio: cambia de papel. Deja de ser «el precio al que salgo» y pasa a ser
   * «el precio en el que empiezo a seguir al máximo» (spec 042).
   */
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
    reshapes: true,
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
    reshapes: true,
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
    reshapes: true,
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
    reshapes: true,
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
  ...camposTrailing('martingale'),
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
/**
 * Por debajo de este take profit, con una entrada taker y una salida maker, un
 * ciclo cerrado puede acabar en pérdida. El mínimo del campo (0,05 %) se
 * conserva para no pausar bots existentes al recargar; se avisa (spec 026, F-94).
 */
export const TP_MINIMO_RENTABLE_PCT = '0.3';

export function avisoDeTpCorto(que: string): string {
  return (
    que +
    ' está por debajo del ' +
    TP_MINIMO_RENTABLE_PCT +
    ' %: con una entrada taker y una salida maker, un ciclo cerrado puede acabar en pérdida.'
  );
}

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
  } else if (tp.lt(TP_MINIMO_RENTABLE_PCT)) {
    issues.push(warn('takeProfitPct', avisoDeTpCorto('El take profit')));
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
    // Con la tasa de mantenimiento del mercado: comparar con 100/apalancamiento
    // a secas dejaba los últimos escalones más allá de la liquidación real
    // (001/F-93).
    const liqDistance = D(100)
      .div(lev)
      .minus(D(maintenanceMarginRateOf(market)).mul(100));
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
      ...TRAILING_DEFAULTS,
      leverage: 2,
      marginMode: 'ISOLATED',
      direction: 'LONG',
      cooldownMinutes: 1,
    };
  },

  validate(cfg: MartingaleConfig, market: MarketSpec): ValidationResult {
    // `validateLadderConfig` la comparte GridMart, que NO ofrece seguimiento:
    // el aviso del retroceso va aquí para no colarle un campo que no tiene.
    return toResult([...validateLadderConfig(cfg, market), ...validarTrailing(cfg)]);
  },

  preview(cfg: MartingaleConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const issues = [...validateLadderConfig(cfg, market), ...validarTrailing(cfg)];
    // Ver `invalidPreview`: sin config valida, calcular es reventar.
    if (issues.some((i) => i.severity === 'ERROR')) return invalidPreview(issues);
    return buildPreview({
      levels: ladderLevels(cfg, refPrice),
      market,
      refPrice,
      direction: cfg.direction,
      leverage: cfg.leverage,
      marginMode: cfg.marginMode,
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

      // La base LIMIT se fija al precio del momento de emitirla y no persigue
      // al mercado (001/F-92, ver `baseLimitPrice`). La escalera se dimensiona
      // desde ese mismo precio para que la orden deseada no cambie de tamaño
      // con cada tick y el reconciliador no tenga nada que reemplazar.
      const fija =
        cfg.baseOrderType === 'LIMIT'
          ? baseLimitPrice(
              ctx.cycle.scratch,
              ctx.now,
              px(ctx.market, mark, entrySide(cfg.direction)),
            )
          : null;
      const base = scaledLadder({
        anchor: fija ? D(fija.price) : mark,
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
        type: fija ? 'POST_ONLY' : 'MARKET',
        price: fija ? fija.price : px(ctx.market, mark, entrySide(cfg.direction)),
        qty: qy(ctx.market, base.qty),
        reduceOnly: false,
      };
      // MARKET va por `immediate`: se manda una vez y no se reconcilia, porque
      // una orden a mercado o se ejecuta o no existe — no hay nada que converger.
      if (entry.type === 'MARKET') immediate.push(entry);
      else orders.push(entry);

      return {
        orders,
        immediate,
        note: 'Abriendo ciclo.',
        ...(fija?.patch ? { scratchPatch: fija.patch } : {}),
      };
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
    const scratchPatch: Record<string, unknown> = {};
    let notaSalida = '';

    if (cfg.trailingTakeProfit) {
      // Con el seguimiento encendido, `tp` deja de ser el precio de salida y
      // pasa a ser el de ACTIVACIÓN. Y se recalcula solo: al llenarse una
      // seguridad baja el precio medio, así que la activación baja con él —lo
      // que NO baja nunca es el máximo ya alcanzado (spec 042 R-4 y R-5).
      const t = trailingVigente({
        scratch: ctx.cycle.scratch,
        extremos: ctx.extremos,
        mark,
        activacion: tp,
        direction: cfg.direction,
        callbackPct: cfg.trailingCallbackPct ?? TRAILING_DEFAULTS.trailingCallbackPct,
        repriceBps: cfg.trailingRepriceBps ?? TRAILING_DEFAULTS.trailingRepriceBps,
        now: ctx.now,
      });
      Object.assign(scratchPatch, t.patch);
      notaSalida = ' ' + t.nota;

      if (t.disparo) {
        const precio = px(ctx.market, t.disparo, exitSide(cfg.direction));
        orders.push({
          clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
          levelKind: LevelKind.TAKE_PROFIT,
          levelIndex: 0,
          side: exitSide(cfg.direction),
          type: 'MARKET',
          price: precio,
          triggerPrice: precio,
          // Un take profit que SIGUE al precio dispara a la BAJA en un largo:
          // take profit en la contabilidad, stop en el disparo. Sin este
          // `intent` el motor lo armaría al revés y el venue cerraría la
          // posición al colocarlo — el fallo 001/F-80 otra vez (spec 042 R-1).
          intent: 'SL',
          qty: qy(ctx.market, pos),
          reduceOnly: true,
        });
      }
    } else {
      // Apagado: se borra su estado. Sin esto, volver a encenderlo recupera el
      // máximo de antes y coloca un disparador que puede estar ya por encima del
      // mercado, o sea un cierre a mercado inmediato (spec 044 R-1).
      const limpieza = limpiarTrailing(ctx.cycle.scratch);
      if (limpieza) Object.assign(scratchPatch, limpieza);

      // «A mercado» es una orden CONDICIONAL: espera al objetivo y entonces cruza
      // el libro. Sin `triggerPrice` salía como MARKET inmediata y el venue la
      // ejecutaba al colocarla: cerraba la posición al instante, cerraba el ciclo,
      // esperaba el cooldown y volvía a abrir — un bucle que quema comisiones
      // (001/F-80). El adaptador traduce disparador + intención TP a la
      // condicional nativa de cada venue, y el simulador la deja en reposo.
      const tpPrice = px(ctx.market, tp, exitSide(cfg.direction));
      const aMercado = cfg.tpMode === 'MARKET';
      orders.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: 0,
        side: exitSide(cfg.direction),
        type: aMercado ? 'MARKET' : 'LIMIT',
        price: tpPrice,
        ...(aMercado ? { triggerPrice: tpPrice } : {}),
        qty: qy(ctx.market, pos),
        reduceOnly: true,
      });
    }

    // El STOP_LOSS no se emite aquí: lo añade el motor para todas las
    // estrategias por igual. Ver `BotRunner.withStopLoss`.

    const remaining = ladder.length - 1 - filled.size;
    return {
      orders,
      immediate,
      note: 'Ciclo abierto: ' + Math.max(0, remaining) + ' seguridades pendientes.' + notaSalida,
      scratchPatch: Object.keys(scratchPatch).length ? scratchPatch : undefined,
    };
  },
};

/** Reexportado para GridMart, que construye su TP sobre el mismo cálculo. */
export const martingaleTakeProfit = (
  avgEntry: string,
  pct: string,
  direction: MartingaleConfig['direction'],
): Decimal => takeProfitPrice(avgEntry, pct, direction);
