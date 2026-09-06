import {
  D,
  Decimal,
  LevelKind,
  Mutability,
  StrategyKind,
  type BotContext,
  type CycleState,
  type DesiredOrder,
  type DesiredState,
  type FieldMeta,
  type Fill,
  type MarketSpec,
  type PreviewResult,
  type StrategyMeta,
  type ValidationResult,
} from '@crypton/shared';
import { makeCoid, parseCoid } from '../client-order-id';
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
  warn,
  type RawLevel,
} from '../common';
import { baseLimitPrice, scaledLadder, takeProfitPrice } from '../ladder';
import {
  MARTINGALE_FIELDS,
  ladderLevels,
  validateLadderConfig,
  type MartingaleConfig,
} from './martingale';
import type { Strategy } from '../types';

export interface GridMartConfig extends MartingaleConfig {
  /** Salida rápida del inventario de seguridad, por encima del breakeven. */
  satelliteTpPct: string;
  gridSellCount: number;
  gridSellInitialSeparationPct: string;
  gridSellDistanceMultiplier: string;
  /** Qué porcentaje del núcleo se vende en el primer escalón de la rejilla. */
  corePctSoldAtLevel1: string;
  gridSellQtyMultiplier: string;
  /** Descuento bajo el precio de la venta ejecutada al que se recompra. */
  gridRebuyDiscountPct: string;
  fullCycleCooldownMinutes?: number;
  /**
   * true = variante Classic: escalera de seguridad + un único TP satélite, sin
   * rejilla de ventas ni recompras. Es un flag y no una estrategia aparte
   * porque el resto de la mecánica es idéntica.
   */
  classicMode?: boolean;
}

/** Recompra pendiente, anotada al ejecutarse una venta de la rejilla. */
interface PendingRebuy {
  index: number;
  price: string;
  qty: string;
}

const GRIDMART_FIELDS: readonly FieldMeta[] = [
  {
    key: 'classicMode',
    kind: 'boolean',
    mutability: Mutability.COLD,
    labelKey: 'strategy.gridmart.classicMode',
    helpKey: 'strategy.gridmart.classicModeHelp',
    required: false,
    default: false,
  },
  {
    key: 'satelliteTpPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.gridmart.satelliteTpPct',
    helpKey: 'strategy.gridmart.satelliteTpPctHelp',
    min: 0.05,
    max: 20,
    step: 0.05,
    required: true,
    default: 0.6,
  },
  {
    key: 'gridSellCount',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.gridmart.gridSellCount',
    reshapes: true,
    min: 1,
    max: 20,
    step: 1,
    required: true,
    default: 4,
  },
  {
    key: 'gridSellInitialSeparationPct',
    kind: 'percent',
    mutability: Mutability.WARM,
    labelKey: 'strategy.gridmart.gridSellInitialSeparationPct',
    reshapes: true,
    min: 0.05,
    max: 20,
    step: 0.05,
    required: true,
    default: 1,
  },
  {
    key: 'gridSellDistanceMultiplier',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.gridmart.gridSellDistanceMultiplier',
    reshapes: true,
    min: 1,
    max: 3,
    step: 0.05,
    required: true,
    default: 1.2,
  },
  {
    key: 'corePctSoldAtLevel1',
    kind: 'percent',
    mutability: Mutability.WARM,
    labelKey: 'strategy.gridmart.corePctSoldAtLevel1',
    reshapes: true,
    helpKey: 'strategy.gridmart.corePctSoldAtLevel1Help',
    min: 1,
    max: 100,
    step: 1,
    required: true,
    default: 25,
  },
  {
    key: 'gridSellQtyMultiplier',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.gridmart.gridSellQtyMultiplier',
    reshapes: true,
    min: 0.1,
    max: 3,
    step: 0.05,
    required: true,
    default: 1,
  },
  {
    key: 'gridRebuyDiscountPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.gridmart.gridRebuyDiscountPct',
    helpKey: 'strategy.gridmart.gridRebuyDiscountPctHelp',
    min: 0.05,
    max: 20,
    step: 0.05,
    required: true,
    default: 0.5,
  },
  {
    key: 'fullCycleCooldownMinutes',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.gridmart.fullCycleCooldownMinutes',
    min: 0,
    max: 10080,
    step: 1,
    required: false,
    default: 1,
  },
] as const;

const META: StrategyMeta = {
  kind: StrategyKind.GRIDMART,
  labelKey: 'strategy.gridmart.label',
  descriptionKey: 'strategy.gridmart.description',
  fields: [...COMMON_FIELDS, ...MARTINGALE_FIELDS, ...GRIDMART_FIELDS],
};

/**
 * Escalones de venta por encima del breakeven, con su cantidad.
 *
 * Las cantidades se recortan para que la suma jamás supere el núcleo: sin ese
 * recorte, las últimas ventas serían reduce-only sobre una posición que ya no
 * existe y el venue las rechazaría una por una en cada tick. Y el último
 * escalón se lleva lo que quede: con porcentajes que no suman 100 el resto del
 * núcleo se quedaba sin venta programada, polvo en la posición hasta el TP
 * (001/F-89). Lo que el step del venue no deje vender sigue siendo polvo.
 */
export function gridSellLevels(
  cfg: GridMartConfig,
  breakeven: Decimal,
  coreQty: Decimal,
): { index: number; price: Decimal; qty: Decimal }[] {
  const count = Math.max(0, Math.floor(cfg.gridSellCount ?? 0));
  if (count === 0 || coreQty.lte(0)) return [];

  const sign = cfg.direction === 'SHORT' ? D(-1) : D(1);
  const out: { index: number; price: Decimal; qty: Decimal }[] = [];

  let separation = D(cfg.gridSellInitialSeparationPct);
  let cumulative = D(0);
  let qty = coreQty.mul(D(cfg.corePctSoldAtLevel1)).div(100);
  let remaining = coreQty;

  for (let j = 0; j < count; j++) {
    cumulative = cumulative.plus(separation);
    separation = separation.mul(cfg.gridSellDistanceMultiplier);

    const price = breakeven.mul(D(1).plus(sign.mul(cumulative).div(100)));
    const take = j === count - 1 ? remaining : Decimal.min(qty, remaining);
    if (take.lte(0)) break;

    out.push({ index: j, price, qty: take });
    remaining = remaining.minus(take);
    qty = qty.mul(cfg.gridSellQtyMultiplier);
  }
  return out;
}

const readRebuys = (cycle: CycleState): PendingRebuy[] =>
  Array.isArray(cycle.scratch['rebuys']) ? (cycle.scratch['rebuys'] as PendingRebuy[]) : [];

export const gridmart: Strategy<GridMartConfig> = {
  // Los escalones de venta y sus recompras reutilizan índice: venta → recompra
  // → la venta vuelve. El plan filtra los escalones con recompra pendiente, y
  // ese filtro es lo que hace segura la reutilización.
  reusesOrderSlots: true,
  // Y ese mismo índice lo comparten con las seguridades: la recompra j no debe
  // marcar el escalón j como tomado o SAFETY#j desaparece del plan (001/F-82).
  rebuysOffLevelIndexes: true,
  kind: StrategyKind.GRIDMART,
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
      classicMode: false,
      satelliteTpPct: '0.6',
      gridSellCount: 4,
      gridSellInitialSeparationPct: '1',
      gridSellDistanceMultiplier: '1.2',
      corePctSoldAtLevel1: '25',
      gridSellQtyMultiplier: '1',
      gridRebuyDiscountPct: '0.5',
      fullCycleCooldownMinutes: 1,
      leverage: 2,
      marginMode: 'ISOLATED',
      direction: 'LONG',
    };
  },

  validate(cfg: GridMartConfig, market: MarketSpec): ValidationResult {
    const issues = validateLadderConfig(cfg, market);

    const sat = D(cfg.satelliteTpPct ?? 0);
    if (!sat.isFinite() || sat.lte(0)) {
      issues.push(err('satelliteTpPct', 'El TP satélite debe ser mayor que cero.'));
    }

    if (!cfg.classicMode) {
      const count = Math.floor(cfg.gridSellCount ?? 0);
      if (count < 1) issues.push(err('gridSellCount', 'Se necesita al menos 1 venta de rejilla.'));

      const corePct = D(cfg.corePctSoldAtLevel1 ?? 0);
      if (!corePct.isFinite() || corePct.lte(0) || corePct.gt(100)) {
        issues.push(
          err('corePctSoldAtLevel1', 'El porcentaje del núcleo debe estar entre 0 y 100.'),
        );
      }

      const discount = D(cfg.gridRebuyDiscountPct ?? 0);
      if (!discount.isFinite() || discount.lte(0)) {
        issues.push(
          err('gridRebuyDiscountPct', 'El descuento de recompra debe ser mayor que cero.'),
        );
      }

      // Si la recompra queda más lejos que el escalón que la generó, cada venta
      // ejecutada deja una recompra que no vuelve a tocarse y el núcleo se
      // vacía sin reponerse: el bot deja de tener con qué operar.
      const firstSep = D(cfg.gridSellInitialSeparationPct ?? 0);
      // `required: true` en el descriptor tiene que significar algo aqui: sin
      // esta comprobacion un valor ausente pasaba la validacion —arriba se lee
      // con `?? 0`— y reventaba despues en `gridSellLevels`, que hace
      // `D(cfg.gridSellInitialSeparationPct)` a pelo. Mismo fallo que el 500 de
      // `/bots/preview`, escondido un nivel mas abajo.
      if (!firstSep.isFinite() || firstSep.lte(0)) {
        issues.push(
          err(
            'gridSellInitialSeparationPct',
            'La separación del primer escalón debe ser mayor que cero.',
          ),
        );
      }
      if (firstSep.gt(0) && discount.gt(firstSep)) {
        issues.push(
          warn(
            'gridRebuyDiscountPct',
            'El descuento de recompra (' +
              discount.toFixed(2) +
              ' %) supera la separación del primer escalón (' +
              firstSep.toFixed(2) +
              ' %): el núcleo se irá vaciando.',
          ),
        );
      }
    }
    // Sin estos dos, `gridSellLevels` hacía `separation.mul(undefined)` y la
    // vista previa y el plan reventaban con un DecimalError (001/F-13).
    for (const key of ['gridSellDistanceMultiplier', 'gridSellQtyMultiplier'] as const) {
      const v = D(cfg[key] ?? NaN);
      if (!v.isFinite() || v.lte(0)) {
        issues.push(err(key, 'Hace falta un multiplicador mayor que cero.'));
      }
    }
    return toResult(issues);
  },

  preview(cfg: GridMartConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const issues = this.validate(cfg, market).issues;
    // Ver `invalidPreview`: sin config valida, calcular es reventar.
    if (issues.some((i) => i.severity === 'ERROR')) return invalidPreview(issues);
    const entryLevels: RawLevel[] = ladderLevels(cfg, refPrice);

    // El preview muestra la escalera de entrada Y los escalones de venta que se
    // tenderían sobre el peor caso: es la única forma de ver de un vistazo por
    // dónde saldría el bot si se llenara entera.
    const worstQty = entryLevels.reduce((acc, l) => acc.plus(D(l.qty)), D(0));
    const worstAvgNum = entryLevels.reduce((acc, l) => acc.plus(D(l.price).mul(l.qty)), D(0));
    const breakeven = worstQty.gt(0) ? worstAvgNum.div(worstQty) : D(refPrice);

    const exitLevels: RawLevel[] = [];
    if (!cfg.classicMode) {
      for (const gs of gridSellLevels(cfg, breakeven, worstQty)) {
        exitLevels.push({
          index: entryLevels.length + gs.index,
          kind: LevelKind.GRID_SELL,
          side: exitSide(cfg.direction),
          price: gs.price,
          qty: gs.qty,
          margin: 0,
          isEntry: false,
        });
      }
    } else {
      const sign = cfg.direction === 'SHORT' ? D(-1) : D(1);
      exitLevels.push({
        index: entryLevels.length,
        kind: LevelKind.TAKE_PROFIT,
        side: exitSide(cfg.direction),
        price: breakeven.mul(D(1).plus(sign.mul(D(cfg.satelliteTpPct)).div(100))),
        qty: worstQty,
        margin: 0,
        isEntry: false,
      });
    }

    return buildPreview({
      levels: [...entryLevels, ...exitLevels],
      market,
      refPrice,
      direction: cfg.direction,
      leverage: cfg.leverage,
      marginMode: cfg.marginMode,
      // El TP que existe es el del satélite en los dos modos: `takeProfitPct` no
      // gobierna ninguna orden en GridMart (001/F-12).
      takeProfitPct: cfg.satelliteTpPct,
      issues,
    });
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as GridMartConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const pd = ctx.market.priceDecimals;
    const qd = ctx.market.qtyDecimals;
    const mark = D(ctx.ticker.mark);
    const pos = positionSize(ctx);

    const orders: DesiredOrder[] = [];
    const immediate: DesiredOrder[] = [];

    // ── Ciclo cerrado: abrir uno nuevo si el cooldown lo permite ──
    if (pos.lte(0)) {
      const cooldownUntil = ctx.cycle.cooldownUntil;
      if (cooldownUntil && ctx.now < cooldownUntil) {
        const secs = Math.ceil((cooldownUntil - ctx.now) / 1000);
        return { orders: [], immediate: [], note: 'En cooldown, ' + secs + ' s.' };
      }

      // Misma conducta que la martingala para la base LIMIT (001/F-92): precio
      // fijado al emitirla, sin persecución y con caducidad. Antes iba por
      // `immediate` como la MARKET —se mandaba una vez y nadie volvía a
      // mirarla—, así que si el precio se alejaba el ciclo no abría jamás.
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
      // La MARKET se manda una vez (o se ejecuta o no existe); la LIMIT se
      // reconcilia como cualquier otra orden del libro.
      if (entry.type === 'MARKET') immediate.push(entry);
      else orders.push(entry);
      return {
        orders,
        immediate,
        targetLeverage: cfg.leverage,
        note: 'Abriendo ciclo.',
        ...(fija?.patch ? { scratchPatch: fija.patch } : {}),
      };
    }

    // ── Escalera de seguridad (idéntica a Martingale) ──
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
    let projected = pos.mul(mark);

    for (let i = 1; i < ladder.length; i++) {
      if (filled.has(i)) continue;
      const lv = ladder[i];
      if (lv.qty.lte(0)) continue;
      if (cap != null && cap.gt(0) && projected.plus(lv.notional).gt(cap)) break;
      projected = projected.plus(lv.notional);

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

    const breakeven = D(ctx.position!.entryPrice);
    // El núcleo es la entrada base; todo lo que las seguridades han añadido por
    // encima de eso es inventario satélite, que sale antes y más cerca.
    const coreQty = Decimal.min(ladder[0].qty, pos);
    const satelliteQty = pos.minus(coreQty);

    if (cfg.classicMode) {
      // Classic: una única salida sobre el total, sin rejilla de ventas.
      const tp = takeProfitPrice(breakeven, cfg.satelliteTpPct, cfg.direction);
      orders.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: 0,
        side: exitSide(cfg.direction),
        type: 'LIMIT',
        price: px(ctx.market, tp, exitSide(cfg.direction)),
        qty: qy(ctx.market, pos),
        reduceOnly: true,
      });
      return {
        orders,
        immediate,
        targetLeverage: cfg.leverage,
        note: 'GridMart Classic: TP satélite en ' + tp.toFixed(pd) + '.',
      };
    }

    // ── TP satélite: solo el inventario de las seguridades ──
    if (satelliteQty.gt(0)) {
      const satPrice = takeProfitPrice(breakeven, cfg.satelliteTpPct, cfg.direction);
      orders.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: 0,
        side: exitSide(cfg.direction),
        type: 'LIMIT',
        price: px(ctx.market, satPrice, exitSide(cfg.direction)),
        qty: qy(ctx.market, satelliteQty),
        reduceOnly: true,
      });
    }

    // ── Rejilla de ventas sobre el núcleo ──
    //
    // Un escalón con recompra pendiente NO se cotiza: su inventario ya se
    // vendió y hasta que la recompra se ejecute no hay nada que vender en él.
    // Antes este filtro no existía y lo tapaba un accidente: el motor vetaba
    // recolocar ids ya ejecutados, así que el escalón «moría» en vez de
    // duplicar la venta. Al permitir la reutilización de ids, el filtro pasa a
    // ser la pieza que sostiene la corrección.
    const pendingRebuy = new Set(readRebuys(ctx.cycle).map((r) => r.index));
    for (const gs of gridSellLevels(cfg, breakeven, coreQty)) {
      if (pendingRebuy.has(gs.index)) continue;
      orders.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.GRID_SELL, gs.index),
        levelKind: LevelKind.GRID_SELL,
        levelIndex: gs.index,
        side: exitSide(cfg.direction),
        type: 'POST_ONLY',
        price: px(ctx.market, gs.price, exitSide(cfg.direction)),
        qty: qy(ctx.market, gs.qty),
        reduceOnly: true,
      });
    }

    // ── Recompras anotadas por onFill al ejecutarse cada venta ──
    for (const rb of readRebuys(ctx.cycle)) {
      orders.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.GRID_BUY, rb.index),
        levelKind: LevelKind.GRID_BUY,
        levelIndex: rb.index,
        side: entrySide(cfg.direction),
        type: 'POST_ONLY',
        price: rb.price,
        qty: rb.qty,
        reduceOnly: false,
      });
    }

    return {
      orders,
      immediate,
      targetLeverage: cfg.leverage,
      note: 'Núcleo ' + coreQty.toFixed(qd) + ', satélite ' + satelliteQty.toFixed(qd) + '.',
    };
  },

  /**
   * Al ejecutarse una venta de la rejilla se anota la recompra correspondiente.
   * Vive aquí y no en el motor porque es la única memoria propia de GridMart:
   * el resto del estado (posición, medio, niveles llenos) se deduce solo.
   */
  onFill(ctx: BotContext, fill: Fill, cycle: CycleState): CycleState {
    const cfg = ctx.config as unknown as GridMartConfig;
    if (cfg.classicMode) return cycle;

    const parsed = fill.clientOrderId ? parseCoid(fill.clientOrderId) : null;
    const rebuys = readRebuys(cycle);

    if (parsed?.kind === LevelKind.GRID_SELL) {
      const sign = cfg.direction === 'SHORT' ? D(1) : D(-1);
      const price = D(fill.price).mul(D(1).plus(sign.mul(D(cfg.gridRebuyDiscountPct)).div(100)));
      // Una venta ejecutada a trozos anota UNA recompra con la suma: cada trozo
      // sobrescribía la anterior y solo se recompraba el último (001/F-89).
      const previa = rebuys.find((r) => r.index === parsed.levelIndex);
      const qty = previa ? D(previa.qty).plus(fill.qty) : D(fill.qty);
      return {
        ...cycle,
        scratch: {
          ...cycle.scratch,
          rebuys: [
            ...rebuys.filter((r) => r.index !== parsed.levelIndex),
            {
              index: parsed.levelIndex,
              // Se guarda ya formateada al lado de la recompra: así el precio
              // que se anota es exactamente el que se mandará al venue.
              price: px(ctx.market, price, entrySide(cfg.direction)),
              qty: qy(ctx.market, qty),
            },
          ],
        },
      };
    }

    // Recompra ejecutada: se retira de la lista para que el escalón de venta
    // correspondiente vuelva a estar disponible en el siguiente tick.
    if (parsed?.kind === LevelKind.GRID_BUY) {
      return {
        ...cycle,
        scratch: {
          ...cycle.scratch,
          rebuys: rebuys.filter((r) => r.index !== parsed.levelIndex),
        },
      };
    }

    return cycle;
  },
};
