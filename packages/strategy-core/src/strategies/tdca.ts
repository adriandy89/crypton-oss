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
  buildPreview,
  commonFieldsWith,
  comunCon,
  entrySide,
  err,
  exitSide,
  invalidPreview,
  positionSize,
  px,
  qy,
  toResult,
  validarObjetivoRoi,
  validateCommon,
  warn,
  type RawLevel,
} from '../common';
import { takeProfitPrice } from '../ladder';
import {
  TRAILING_DEFAULTS,
  camposTrailing,
  limpiarTrailing,
  trailingVigente,
  validarTrailing,
  type TrailingConfig,
} from '../trailing-take-profit';
import type { Strategy } from '../types';

export interface TdcaConfig extends CommonBotConfig, TrailingConfig {
  /** Margen de cada compra. El notional real es esto por el apalancamiento. */
  amountPerBuy: string;
  intervalMinutes: number;
  maxBuysPerCycle: number;
  /** true = solo compra si el precio mejora el medio actual. */
  buyOnlyIfImprovesAverage?: boolean;
  /** Cuánto por debajo del medio hace falta estar para comprar. */
  marginBelowAveragePct?: string;
  /**
   * Beneficio al que sale, en % del MARGEN desde el precio medio real del venue
   * (spec 080). A 1× es lo mismo que un % del precio.
   *
   * Con `trailingTakeProfit` encendido este campo NO cambia de unidad ni de
   * sitio: cambia de papel. Deja de ser «el precio al que salgo» y pasa a ser
   * «el precio en el que empiezo a seguir al máximo», que es el modelo de
   * 3Commas y lo que evita que el usuario aprenda un campo nuevo (spec 042).
   */
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
    // La ayuda existía y no se veía: el campo no la declaraba (079/F-18).
    helpKey: 'strategy.tdca.takeProfitPctHelp',
    min: 0.05,
    // % del MARGEN desde el spec 080; el tope de siempre, un 100 % del precio.
    maxPrecioPct: 100,
    roi: 'BENEFICIO',
    step: 0.05,
    required: true,
    // A 1×, el apalancamiento de fábrica de TDCA, margen y precio coinciden.
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
  ...camposTrailing('tdca'),
] as const;

const META: StrategyMeta = {
  kind: StrategyKind.TDCA,
  labelKey: 'strategy.tdca.label',
  descriptionKey: 'strategy.tdca.description',
  // El DCA nace a 1×: la ficha común dice 2× y la ayuda y el relleno de un
  // campo vacío (`sinVacios`) leían ese 2 (strategies.spec, desincronizados).
  fields: [...commonFieldsWith([comunCon('leverage', { default: 1 })]), ...TDCA_FIELDS],
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
      ...TRAILING_DEFAULTS,
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

    issues.push(
      ...validarObjetivoRoi(
        'takeProfitPct',
        'El take profit',
        cfg.takeProfitPct,
        Number(cfg.leverage) || 1,
        cfg.direction,
      ),
    );

    issues.push(...validarTrailing(cfg));

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
          '«Solo si mejora el precio medio» está desactivado: la mejora mínima sobre la media no se usa.',
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

    // El preview proyecta el peor caso razonable: cada compra ocurre en cuanto el
    // precio mejora la MEDIA de lo ya comprado en la mejora mínima, que es la
    // condición de `plan()`. Se proyectaba contra el precio de la compra
    // anterior, más lejos que la media, y la escalera enseñada salía más
    // profunda que la real (079/F-12). No es una predicción: es la cota que hace
    // visible hasta dónde puede llegar el bot.
    const levels: RawLevel[] = [];
    const sign = cfg.direction === 'SHORT' ? D(1) : D(-1);
    // Los mismos dos topes que `plan()`, y manda el menor: al llegar deja de
    // comprar, y la compra que no cabe entera se recorta a lo que queda. Sin
    // ellos la vista previa enseñaba todas las compras aunque el bot se fuera a
    // parar en el tope (encontrado al rehacer la guía del DCA con el 080).
    const topes = [cfg.maxPositionNotional, cfg.maxNotionalCap]
      .map((t) => (t ? D(t) : D(0)))
      .filter((t) => t.gt(0));
    const tope = topes.length > 0 ? Decimal.min(...topes) : null;
    const minimo = D(market.minNotional ?? 0);
    let projected = ref;
    let sumaNotional = D(0);
    let sumaQty = D(0);
    for (let i = 0; i < maxBuys; i++) {
      if (i > 0 && sumaQty.gt(0)) {
        const media = sumaNotional.div(sumaQty);
        projected = media.mul(D(1).plus(sign.mul(marginBelow).div(100)));
      }
      // Lo abierto se mide a la marca, como en `plan()`: aquí, al precio de la compra.
      const hueco = tope ? tope.minus(sumaQty.mul(projected)) : notional;
      const notionalCompra = Decimal.min(notional, hueco);
      if (!notionalCompra.gt(0)) break;
      // Un recorte que no llega al mínimo del venue lo quita el motor antes de
      // mandarlo (`order-gate`): no se enseña una compra que no va a salir.
      if (notionalCompra.lt(notional) && notionalCompra.lt(minimo)) break;
      const qtyCompra = projected.gt(0) ? notionalCompra.div(projected) : D(0);
      sumaNotional = sumaNotional.plus(projected.mul(qtyCompra));
      sumaQty = sumaQty.plus(qtyCompra);
      levels.push({
        index: i,
        kind: i === 0 ? LevelKind.BASE : LevelKind.SAFETY,
        side: entrySide(cfg.direction),
        price: projected,
        qty: qtyCompra,
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
      // Con el seguimiento encendido el objetivo es donde EMPIEZA a seguir (079/F-15).
      objetivo: { roiPct: cfg.takeProfitPct, activacion: cfg.trailingTakeProfit === true },
      stopLossRoiPct: cfg.stopLossPct,
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
    const scratchPatch: Record<string, unknown> = {};
    let notaSalida = '';

    // ── Salida: siempre viva mientras haya posición ──
    if (pos.gt(0) && ctx.position) {
      const salida = exitSide(cfg.direction);
      // Un % del MARGEN desde la media (spec 080).
      const tp = takeProfitPrice(
        ctx.position.entryPrice,
        cfg.takeProfitPct,
        cfg.leverage,
        cfg.direction,
      );

      if (cfg.trailingTakeProfit) {
        // Con el seguimiento encendido, `tp` deja de ser el precio de salida y
        // pasa a ser el de ACTIVACIÓN. Mientras no se cruce no hay orden de
        // beneficio —no hay nada que asegurar— y el `stopLossPct` que el motor
        // inyecta sigue cubriendo la bajada (spec 042 R-4).
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
          const precio = px(ctx.market, t.disparo, salida);
          orders.push({
            clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
            levelKind: LevelKind.TAKE_PROFIT,
            levelIndex: 0,
            side: salida,
            type: 'MARKET',
            price: precio,
            triggerPrice: precio,
            // Un take profit que SIGUE al precio dispara a la BAJA en un largo:
            // en la contabilidad es un take profit y en el disparo es un stop.
            // Sin este `intent` el motor lo armaría al revés y el venue cerraría
            // la posición al colocarlo, que es el fallo 001/F-80 (spec 042 R-1).
            intent: 'SL',
            qty: qy(ctx.market, pos),
            reduceOnly: true,
          });
        }
      } else {
        // Apagado: se borra su estado. Sin esto, volver a encenderlo recupera
        // el máximo de antes y coloca un disparador que puede estar ya por
        // encima del mercado, o sea un cierre a mercado inmediato (spec 044 R-1).
        const limpieza = limpiarTrailing(ctx.cycle.scratch);
        if (limpieza) Object.assign(scratchPatch, limpieza);

        orders.push({
          clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
          levelKind: LevelKind.TAKE_PROFIT,
          levelIndex: 0,
          side: salida,
          type: 'LIMIT',
          price: px(ctx.market, tp, salida),
          qty: qy(ctx.market, pos),
          reduceOnly: true,
        });
      }

      // El STOP_LOSS lo añade el motor, igual para todas las estrategias.
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
        blockers.push('el precio no mejora la media en la mejora mínima exigida');
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
    const tope = topes.length > 0 ? topes.reduce((a, b) => (a.lt(b) ? a : b)) : null;
    const abierto = pos.mul(mark);
    if (tope != null && abierto.gte(tope)) {
      blockers.push('tope de posición alcanzado');
    }

    if (blockers.length === 0) {
      // El tope acota lo que se COMPRA, no solo lo que ya hay abierto. Se
      // comprobaba antes de emitir y sin proyectar la compra, asi que se
      // rebasaba SIEMPRE por el importe de una entera: con el tope en 1000 y una
      // posicion de 990, una compra de 200 lo dejaba en 1190. Es el mismo
      // defecto que el spec 001 (F-87) corrigio en la rejilla clasica, y que
      // martingala y gridmart ya evitaban proyectando (spec 048, H-02).
      //
      // Si no cabe entera se compra lo que quepa: un DCA al que le faltan diez
      // unidades para el tope no tiene por que dejar de promediar, y recortar es
      // exactamente lo que el tope pide. Lo que no cabe ni recortado —porque no
      // llega al minimo del venue— lo corta `order-gate` despues.
      const deseado = D(cfg.amountPerBuy).mul(cfg.leverage);
      const hueco = tope != null ? tope.minus(abierto) : deseado;
      const notional = Decimal.min(deseado, hueco);
      const qty = mark.gt(0) && notional.gt(0) ? notional.div(mark) : D(0);
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
        (blockers.length > 0
          ? 'Sin comprar: ' + blockers.join('; ') + '.'
          : 'Comprando (' + (ctx.cycle.entriesFilled + 1) + '/' + maxBuys + ').') + notaSalida,
      scratchPatch: Object.keys(scratchPatch).length ? scratchPatch : undefined,
    };
  },
};
