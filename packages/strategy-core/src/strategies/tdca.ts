import {
  D,
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
import { takeProfitPrice } from '../ladder';
import type { Strategy } from '../types';

export interface TdcaConfig extends CommonBotConfig {
  /** Margen de cada compra. El notional real es esto por el apalancamiento. */
  amountPerBuy: string;
  intervalMinutes: number;
  maxBuysPerCycle: number;
  /** true = solo compra si el precio mejora el medio actual. */
  buyOnlyIfImprovesAverage?: boolean;
  /** Cuánto por debajo del medio hace falta estar para comprar. */
  marginBelowAveragePct?: string;
  takeProfitPct: string;
  maxPositionNotional?: string | null;
}

const TDCA_FIELDS: readonly FieldMeta[] = [
  {
    key: 'amountPerBuy',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.tdca.amountPerBuy',
    helpKey: 'strategy.tdca.amountPerBuyHelp',
    min: 1,
    required: true,
    unit: 'USDC',
  },
  {
    key: 'intervalMinutes',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.tdca.intervalMinutes',
    min: 1,
    max: 10080,
    step: 1,
    required: true,
    default: 60,
  },
  {
    key: 'maxBuysPerCycle',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.tdca.maxBuysPerCycle',
    helpKey: 'strategy.tdca.maxBuysPerCycleHelp',
    min: 1,
    max: 500,
    step: 1,
    required: true,
    default: 20,
    risky: true,
  },
  {
    key: 'buyOnlyIfImprovesAverage',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.tdca.buyOnlyIfImprovesAverage',
    helpKey: 'strategy.tdca.buyOnlyIfImprovesAverageHelp',
    required: false,
    default: true,
  },
  {
    key: 'marginBelowAveragePct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.tdca.marginBelowAveragePct',
    helpKey: 'strategy.tdca.marginBelowAveragePctHelp',
    min: 0,
    max: 100,
    step: 0.1,
    required: false,
    default: 0.5,
  },
  {
    key: 'takeProfitPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.tdca.takeProfitPct',
    min: 0.05,
    max: 100,
    step: 0.05,
    required: true,
    default: 1.5,
  },
  {
    key: 'maxPositionNotional',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.tdca.maxPositionNotional',
    helpKey: 'strategy.tdca.maxPositionNotionalHelp',
    min: 0,
    required: false,
    risky: true,
    unit: 'USDC',
  },
] as const;

const META: StrategyMeta = {
  kind: StrategyKind.TDCA,
  labelKey: 'strategy.tdca.label',
  descriptionKey: 'strategy.tdca.description',
  fields: [...COMMON_FIELDS, ...TDCA_FIELDS],
};

export const tdca: Strategy<TdcaConfig> = {
  kind: StrategyKind.TDCA,
  meta: META,

  defaults() {
    return {
      intervalMinutes: 60,
      maxBuysPerCycle: 20,
      buyOnlyIfImprovesAverage: true,
      marginBelowAveragePct: '0.5',
      takeProfitPct: '1.5',
      leverage: 1,
      marginMode: 'ISOLATED',
      direction: 'LONG',
      cooldownMinutes: 0,
    };
  },

  validate(cfg: TdcaConfig, market: MarketSpec): ValidationResult {
    const issues = validateCommon(cfg, market);

    const amount = D(cfg.amountPerBuy ?? 0);
    if (!amount.isFinite() || amount.lte(0)) {
      issues.push(err('amountPerBuy', 'El importe por compra debe ser mayor que cero.'));
    }

    const interval = Math.floor(cfg.intervalMinutes ?? 0);
    if (interval < 1) issues.push(err('intervalMinutes', 'El intervalo mínimo es 1 minuto.'));

    const maxBuys = Math.floor(cfg.maxBuysPerCycle ?? 0);
    if (maxBuys < 1) issues.push(err('maxBuysPerCycle', 'Debe permitir al menos 1 compra.'));

    const tp = D(cfg.takeProfitPct ?? 0);
    if (!tp.isFinite() || tp.lte(0)) {
      issues.push(err('takeProfitPct', 'El take profit debe ser mayor que cero.'));
    }

    // El techo real del bot es amountPerBuy × maxBuysPerCycle. Si supera la
    // inversión total declarada, el usuario está mirando un número que no es
    // el que va a arriesgar.
    if (amount.gt(0) && maxBuys > 0) {
      const worstMargin = amount.mul(maxBuys);
      const total = D(cfg.totalInvestment ?? 0);
      if (total.gt(0) && worstMargin.gt(total)) {
        issues.push(
          err(
            'maxBuysPerCycle',
            worstMargin.toFixed(2) +
              ' de margen en el peor caso (' +
              maxBuys +
              ' compras) supera la inversión total declarada (' +
              total.toFixed(2) +
              ').',
          ),
        );
      }
    }

    if (Number(cfg.leverage) > 3) {
      issues.push(
        warn(
          'leverage',
          'TDCA promedia sin límite de recorrido: por encima de 3x el margen se agota rápido.',
        ),
      );
    }
    // 030/F-04: el margen solo se mira dentro de «solo si mejora el precio
    // medio»; sin esa casilla es un número que no hace nada.
    if (cfg.buyOnlyIfImprovesAverage === false && D(cfg.marginBelowAveragePct ?? 0).gt(0)) {
      issues.push(
        warn(
          'marginBelowAveragePct',
          '«Solo si mejora el precio medio» está desactivado: el margen exigido no se usa.',
        ),
      );
    }

    return toResult(issues);
  },

  preview(cfg: TdcaConfig, market: MarketSpec, refPrice: string): PreviewResult {
    // `validate()` ya incluye los avisos comunes: concatenarlos otra vez los
    // enseñaba dos veces en la vista previa (001/F-14).
    const issues = [...this.validate(cfg, market).issues];
    // Ver `invalidPreview`: sin config valida, calcular es reventar.
    if (issues.some((i) => i.severity === 'ERROR')) return invalidPreview(issues);
    const ref = D(refPrice);
    const amount = D(cfg.amountPerBuy ?? 0);
    const notional = amount.mul(cfg.leverage);
    const maxBuys = Math.max(1, Math.floor(cfg.maxBuysPerCycle ?? 1));
    const marginBelow = D(cfg.marginBelowAveragePct ?? 0);

    // El preview proyecta el peor caso razonable: cada compra ocurre cuando el
    // precio ha caído el margen exigido respecto de la media anterior. No es una
    // predicción, es la cota que hace visible hasta dónde puede llegar el bot.
    const levels: RawLevel[] = [];
    let projected = ref;
    for (let i = 0; i < maxBuys; i++) {
      if (i > 0) {
        const sign = cfg.direction === 'SHORT' ? D(1) : D(-1);
        projected = projected.mul(D(1).plus(sign.mul(marginBelow).div(100)));
      }
      levels.push({
        index: i,
        kind: i === 0 ? LevelKind.BASE : LevelKind.SAFETY,
        side: entrySide(cfg.direction),
        price: projected,
        qty: projected.gt(0) ? notional.div(projected) : D(0),
        margin: amount,
        isEntry: true,
      });
    }

    return buildPreview({
      levels,
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
    const cfg = ctx.config as unknown as TdcaConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const mark = D(ctx.ticker.mark);
    const pos = positionSize(ctx);

    const orders: DesiredOrder[] = [];
    const immediate: DesiredOrder[] = [];
    const blockers: string[] = [];

    // ── Salida: siempre viva mientras haya posición ──
    if (pos.gt(0) && ctx.position) {
      const tp = takeProfitPrice(ctx.position.entryPrice, cfg.takeProfitPct, cfg.direction);
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

      // El STOP_LOSS lo añade el motor, igual para las siete estrategias.
      // Ver `BotRunner.withStopLoss`.
    }

    // ── Entrada: solo si pasan TODAS las condiciones ──
    const maxBuys = Math.max(1, Math.floor(cfg.maxBuysPerCycle ?? 1));
    if (ctx.cycle.entriesFilled >= maxBuys) {
      blockers.push('límite de ' + maxBuys + ' compras alcanzado');
    }

    const intervalMs = Math.max(1, Math.floor(cfg.intervalMinutes ?? 1)) * 60_000;
    if (ctx.cycle.lastEntryAt != null && ctx.now - ctx.cycle.lastEntryAt < intervalMs) {
      const wait = Math.ceil((intervalMs - (ctx.now - ctx.cycle.lastEntryAt)) / 1000);
      blockers.push('faltan ' + wait + ' s para la siguiente compra');
    }

    if (cfg.buyOnlyIfImprovesAverage !== false && ctx.position && pos.gt(0)) {
      const sign = cfg.direction === 'SHORT' ? D(1) : D(-1);
      const required = D(ctx.position.entryPrice).mul(
        D(1).plus(sign.mul(D(cfg.marginBelowAveragePct ?? 0)).div(100)),
      );
      const improves = cfg.direction === 'SHORT' ? mark.gte(required) : mark.lte(required);
      if (!improves) {
        blockers.push('el precio no mejora el medio en el margen exigido');
      }
    }

    // Espera entre ciclos (001/F-12): el campo común no se leía aquí.
    const espera = ctx.cycle.cooldownUntil ?? 0;
    if (espera > ctx.now) {
      blockers.push('espera entre ciclos: faltan ' + Math.ceil((espera - ctx.now) / 1000) + ' s');
    }

    // Dos topes con la misma semántica: el propio (`maxPositionNotional`) y el
    // común (`maxNotionalCap`), que aquí no se leía (001/F-12). Manda el menor.
    const topes = [cfg.maxPositionNotional, cfg.maxNotionalCap]
      .map((t) => (t ? D(t) : D(0)))
      .filter((t) => t.gt(0));
    if (topes.length > 0 && pos.mul(mark).gte(topes.reduce((a, b) => (a.lt(b) ? a : b)))) {
      blockers.push('tope de posición alcanzado');
    }

    if (blockers.length === 0) {
      const notional = D(cfg.amountPerBuy).mul(cfg.leverage);
      const qty = mark.gt(0) ? notional.div(mark) : D(0);
      if (qty.gt(0)) {
        // El índice es el número de compra: dos ticks seguidos generan el mismo
        // id y el motor descarta el duplicado antes de mandarlo al venue.
        // El TIPO del id coincide con el del nivel. Antes el id decía BASE para
        // toda compra mientras el nivel decía SAFETY a partir de la segunda: el
        // ledger registraba una cosa y el id contaba otra, y cualquier lógica
        // que derive del id —el ancla del ciclo se fija mirando el tipo B—
        // trataba cada compra como si fuera la primera.
        immediate.push({
          clientOrderId: makeCoid(
            ctx.botId,
            seq,
            ctx.cycle.entriesFilled === 0 ? LevelKind.BASE : LevelKind.SAFETY,
            ctx.cycle.entriesFilled,
          ),
          levelKind: ctx.cycle.entriesFilled === 0 ? LevelKind.BASE : LevelKind.SAFETY,
          levelIndex: ctx.cycle.entriesFilled,
          side: entrySide(cfg.direction),
          type: 'MARKET',
          price: px(ctx.market, mark, entrySide(cfg.direction)),
          qty: qy(ctx.market, qty),
          reduceOnly: false,
        });
      }
    }

    return {
      orders,
      immediate,
      note:
        blockers.length > 0
          ? 'Sin comprar: ' + blockers.join('; ') + '.'
          : 'Comprando (' + (ctx.cycle.entriesFilled + 1) + '/' + maxBuys + ').',
    };
  },
};
