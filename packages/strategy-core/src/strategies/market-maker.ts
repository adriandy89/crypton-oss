import {
  D,
  Decimal,
  LevelKind,
  Mutability,
  PositionModeSetting,
  SizingMode,
  StrategyKind,
  type BotContext,
  type CommonBotConfig,
  type DesiredOrder,
  type DesiredState,
  type FieldMeta,
  type MarketSpec,
  type PreviewResult,
  type StrategyMeta,
  type ValidationIssue,
  type ValidationResult,
} from '@crypton/shared';
import { makeCoid } from '../client-order-id';
import {
  buildPreview,
  commonFieldsWith,
  err,
  invalidPreview,
  px,
  qy,
  toResult,
  validateCommon,
  warn,
  type RawLevel,
} from '../common';
import { geometricWeights } from '../ladder';
import type { Strategy } from '../types';
import {
  BPS,
  bookMid,
  bookSpreadBps,
  expiredQuotes,
  inventoryOf,
  limitBreach,
  orderAges,
  priceBand,
  profileOf,
  REGIME_DISTANCE,
  riskRegime,
  sideRoles,
  sizeToQty,
} from './mm-shared';

export interface MarketMakerConfig extends CommonBotConfig {
  orderSizePerSide: string;
  maxBotPositionValue: string;
  maxLongPosition?: string | null;
  maxShortPosition?: string | null;
  buyDistanceBps: string;
  sellDistanceBps: string;
  minAllowedDistanceBps: string;
  refreshSeconds: number;
  layers: number;
  layerDistanceMultiplier: string;
  layerSizeMultiplier: string;
  riskProfile?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  /** Ensancha el diferencial a medida que crece el inventario. */
  dynamicSpread?: boolean;
  /** Desplaza las cotizaciones en contra del inventario acumulado. */
  inventoryPriceAdjustment?: boolean;
  inventorySkewFactor?: string;
  exitOrderTtlSeconds?: number;
  /** Segundos sin recotizar después de una ejecución. */
  fillCooldownSeconds?: number;
  /** false = órdenes limit normales, que pueden cruzar y pagar taker. */
  postOnly?: boolean;
  /** % de ocupación del tope a partir del cual se entra en modo defensivo. */
  defensiveThresholdPct?: string | null;
  /** % de ocupación a partir del cual se deja de añadir por completo. */
  highRiskThresholdPct?: string | null;
  /** Deriva la distancia base de la anchura real del libro. */
  autoAdjustDistance?: boolean;
  /** Ancla manual: si está puesta, se cotiza alrededor de este precio. */
  referencePrice?: string | null;
}

const MM_FIELDS: readonly FieldMeta[] = [
  {
    key: 'orderSizePerSide',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.orderSizePerSide',
    helpKey: 'strategy.mm.orderSizePerSideHelp',
    min: 1,
    required: true,
    group: 'core',
    unit: 'USDC',
  },
  {
    key: 'maxBotPositionValue',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.maxBotPositionValue',
    helpKey: 'strategy.mm.maxBotPositionValueHelp',
    min: 1,
    required: true,
    risky: true,
    group: 'core',
    unit: 'USDC',
  },
  {
    key: 'sizingMode',
    kind: 'enum',
    mutability: Mutability.WARM,
    labelKey: 'strategy.mm.sizingMode',
    helpKey: 'strategy.mm.sizingModeHelp',
    options: [SizingMode.QUOTE, SizingMode.BASE],
    required: false,
    default: SizingMode.QUOTE,
    group: 'core',
    control: 'segment',
  },
  {
    key: 'riskProfile',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.riskProfile',
    helpKey: 'strategy.mm.riskProfileHelp',
    options: ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'],
    required: false,
    default: 'BALANCED',
    group: 'core',
    control: 'segment',
  },
  {
    key: 'limitAction',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.limitAction',
    helpKey: 'strategy.mm.limitActionHelp',
    options: ['PAUSE_ENTRIES', 'CLOSE_ALL', 'SHUTDOWN'],
    required: false,
    default: 'PAUSE_ENTRIES',
    risky: true,
    group: 'core',
    control: 'segment',
  },
  {
    key: 'maxLongPosition',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.maxLongPosition',
    min: 0,
    required: false,
    group: 'risk',
    unit: 'USDC',
    advanced: true,
  },
  {
    key: 'maxShortPosition',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.maxShortPosition',
    min: 0,
    required: false,
    group: 'risk',
    unit: 'USDC',
    advanced: true,
  },
  {
    key: 'defensiveThresholdPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.defensiveThresholdPct',
    helpKey: 'strategy.mm.defensiveThresholdPctHelp',
    min: 1,
    max: 100,
    step: 1,
    required: false,
    default: 70,
    group: 'risk',
    unit: '%',
    advanced: true,
  },
  {
    key: 'highRiskThresholdPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.highRiskThresholdPct',
    helpKey: 'strategy.mm.highRiskThresholdPctHelp',
    min: 1,
    max: 100,
    step: 1,
    required: false,
    default: 90,
    risky: true,
    group: 'risk',
    unit: '%',
    advanced: true,
  },
  {
    key: 'buyDistanceBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.buyDistanceBps',
    helpKey: 'strategy.mm.buyDistanceBpsHelp',
    min: 1,
    max: 1000,
    step: 1,
    required: true,
    default: 20,
    group: 'quoting',
    unit: 'bps',
  },
  {
    key: 'sellDistanceBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.sellDistanceBps',
    min: 1,
    max: 1000,
    step: 1,
    required: true,
    default: 20,
    group: 'quoting',
    unit: 'bps',
  },
  {
    key: 'minAllowedDistanceBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.minAllowedDistanceBps',
    helpKey: 'strategy.mm.minAllowedDistanceBpsHelp',
    min: 1,
    max: 500,
    step: 1,
    required: true,
    default: 8,
    group: 'quoting',
    unit: 'bps',
  },
  {
    key: 'autoAdjustDistance',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.autoAdjustDistance',
    helpKey: 'strategy.mm.autoAdjustDistanceHelp',
    required: false,
    default: false,
    group: 'quoting',
    advanced: true,
  },
  {
    key: 'postOnly',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.postOnly',
    helpKey: 'strategy.mm.postOnlyHelp',
    required: false,
    default: true,
    group: 'quoting',
    advanced: true,
  },
  {
    key: 'dynamicSpread',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.dynamicSpread',
    helpKey: 'strategy.mm.dynamicSpreadHelp',
    required: false,
    default: true,
    group: 'quoting',
    advanced: true,
  },
  {
    key: 'inventoryPriceAdjustment',
    kind: 'boolean',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.inventoryPriceAdjustment',
    helpKey: 'strategy.mm.inventoryPriceAdjustmentHelp',
    required: false,
    default: true,
    group: 'quoting',
    advanced: true,
  },
  {
    key: 'inventorySkewFactor',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.inventorySkewFactor',
    min: 0,
    max: 3,
    step: 0.05,
    required: false,
    default: 1,
    group: 'quoting',
    advanced: true,
  },
  {
    key: 'refreshSeconds',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.refreshSeconds',
    helpKey: 'strategy.mm.refreshSecondsHelp',
    // El suelo son 15 s y no 5 porque el motor reconcilia cada
    // RECONCILE_INTERVAL_MS (15 s por defecto): por debajo de eso el campo
    // prometia un refresco que nadie iba a ejecutar. Una ejecucion SI dispara
    // un tick inmediato, asi que esto es el techo de latencia cuando no pasa
    // nada, no el tiempo de reaccion.
    min: 15,
    max: 3600,
    step: 5,
    required: true,
    default: 30,
    group: 'timing',
    unit: 'sec',
  },
  {
    key: 'fillCooldownSeconds',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.fillCooldownSeconds',
    helpKey: 'strategy.mm.fillCooldownSecondsHelp',
    min: 0,
    max: 3600,
    step: 5,
    required: false,
    default: 0,
    group: 'timing',
    unit: 'sec',
    advanced: true,
  },
  {
    key: 'exitOrderTtlSeconds',
    kind: 'integer',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.exitOrderTtlSeconds',
    helpKey: 'strategy.mm.exitOrderTtlSecondsHelp',
    min: 0,
    max: 86400,
    step: 5,
    required: false,
    default: 0,
    group: 'timing',
    unit: 'sec',
    advanced: true,
  },
  {
    key: 'layers',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.mm.layers',
    min: 1,
    max: 10,
    step: 1,
    required: true,
    default: 3,
    group: 'levels',
    advanced: true,
  },
  {
    key: 'layerDistanceMultiplier',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.mm.layerDistanceMultiplier',
    min: 1,
    max: 3,
    step: 0.05,
    required: true,
    default: 1.5,
    group: 'levels',
    advanced: true,
  },
  {
    key: 'layerSizeMultiplier',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.mm.layerSizeMultiplier',
    helpKey: 'strategy.mm.layerSizeMultiplierHelp',
    min: 0.1,
    max: 3,
    step: 0.05,
    required: true,
    default: 1,
    group: 'levels',
    advanced: true,
  },
  {
    key: 'positionMode',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'strategy.mm.positionMode',
    helpKey: 'strategy.mm.positionModeHelp',
    options: [PositionModeSetting.AUTO, PositionModeSetting.HEDGE, PositionModeSetting.ONE_WAY],
    required: false,
    default: PositionModeSetting.AUTO,
    group: 'venue',
    control: 'segment',
    advanced: true,
  },
  {
    key: 'referencePrice',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.referencePrice',
    helpKey: 'strategy.mm.referencePriceHelp',
    min: 0,
    required: false,
    group: 'priceSource',
    advanced: true,
  },
  {
    key: 'priceFloor',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.priceFloor',
    helpKey: 'strategy.mm.priceFloorHelp',
    min: 0,
    required: false,
    group: 'priceSource',
    advanced: true,
  },
  {
    key: 'priceCeiling',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.priceCeiling',
    helpKey: 'strategy.mm.priceCeilingHelp',
    min: 0,
    required: false,
    group: 'priceSource',
    advanced: true,
  },
] as const;

/**
 * El market maker es la única estrategia que admite `NEUTRAL`: cotiza los dos
 * lados a la vez y su resultado sale del diferencial, no de la dirección.
 */
const MM_DIRECTION: FieldMeta = {
  key: 'direction',
  kind: 'enum',
  mutability: Mutability.COLD,
  labelKey: 'strategy.mm.direction',
  options: ['NEUTRAL', 'LONG', 'SHORT'],
  required: true,
  default: 'NEUTRAL',
  group: 'core',
  control: 'segment',
};

const META: StrategyMeta = {
  kind: StrategyKind.MARKET_MAKER,
  labelKey: 'strategy.mm.label',
  descriptionKey: 'strategy.mm.description',
  fields: [...commonFieldsWith([MM_DIRECTION]), ...MM_FIELDS],
};

export const marketMaker: Strategy<MarketMakerConfig> = {
  kind: StrategyKind.MARKET_MAKER,
  meta: META,
  // Cada capa reutiliza su id en cada recotización; el propio plan decide
  // cuándo cotizar. Sin esto, una capa moría tras su primera ejecución.
  reusesOrderSlots: true,

  defaults() {
    return {
      buyDistanceBps: '20',
      sellDistanceBps: '20',
      minAllowedDistanceBps: '8',
      refreshSeconds: 30,
      layers: 3,
      layerDistanceMultiplier: '1.5',
      layerSizeMultiplier: '1',
      riskProfile: 'BALANCED',
      dynamicSpread: true,
      inventoryPriceAdjustment: true,
      inventorySkewFactor: '1',
      exitOrderTtlSeconds: 0,
      fillCooldownSeconds: 0,
      postOnly: true,
      autoAdjustDistance: false,
      defensiveThresholdPct: '70',
      highRiskThresholdPct: '90',
      sizingMode: SizingMode.QUOTE,
      limitAction: 'PAUSE_ENTRIES',
      positionMode: PositionModeSetting.AUTO,
      leverage: 2,
      marginMode: 'CROSS',
      direction: 'NEUTRAL',
    };
  },

  validate(cfg: MarketMakerConfig, market: MarketSpec): ValidationResult {
    const issues = validateCommon(cfg, market);

    const size = D(cfg.orderSizePerSide ?? 0);
    if (!size.isFinite() || size.lte(0)) {
      issues.push(err('orderSizePerSide', 'El tamaño por orden debe ser mayor que cero.'));
    }

    const maxPos = D(cfg.maxBotPositionValue ?? 0);
    if (!maxPos.isFinite() || maxPos.lte(0)) {
      issues.push(
        err('maxBotPositionValue', 'El valor máximo de posición debe ser mayor que cero.'),
      );
    }

    const buyBps = D(cfg.buyDistanceBps ?? 0);
    const sellBps = D(cfg.sellDistanceBps ?? 0);
    const minBps = D(cfg.minAllowedDistanceBps ?? 0);
    // Igual que arriba: se lee con `?? 0` para validar, pero `plan()` hace
    // `D(cfg.minAllowedDistanceBps)` sin red. Un valor ausente pasaba por aqui
    // y tumbaba el tick del bot, no el preview.
    if (!minBps.isFinite() || minBps.lte(0)) {
      issues.push(err('minAllowedDistanceBps', 'La distancia mínima debe ser mayor que cero.'));
    }

    if (buyBps.lte(0) || sellBps.lte(0)) {
      issues.push(err('buyDistanceBps', 'Las distancias deben ser mayores que cero.'));
    }
    if (minBps.gt(buyBps) || minBps.gt(sellBps)) {
      issues.push(
        err('minAllowedDistanceBps', 'La distancia mínima no puede superar a las distancias base.'),
      );
    }

    const layers = Math.floor(cfg.layers ?? 0);
    if (layers < 1 || layers > 10)
      issues.push(err('layers', 'Las capas deben estar entre 1 y 10.'));

    if (Math.floor(cfg.refreshSeconds ?? 0) < 15) {
      issues.push(
        err(
          'refreshSeconds',
          'El refresco mínimo es de 15 segundos: es el ritmo al que el motor reconcilia.',
        ),
      );
    }

    issues.push(...validateRiskThresholds(cfg));
    issues.push(...validatePriceBand(cfg));

    // Un ancla manual muy lejos del mercado deja al bot cotizando al aire: no es
    // un error (puede ser deliberado, esperando a que el precio vuelva), pero
    // conviene decirlo antes de que el usuario crea que el bot está roto.
    if (cfg.referencePrice) {
      const ref = D(cfg.referencePrice);
      if (!ref.isFinite() || ref.lte(0)) {
        issues.push(err('referencePrice', 'El precio de referencia debe ser mayor que cero.'));
      }
    }

    // Que las capas no se solapen al redondear al tick del venue no se puede
    // comprobar aquí (hace falta un precio de referencia): lo detecta preview(),
    // donde normalizeOrder() marca los niveles que caen al mismo precio.

    // Con todas las capas llenas de un lado, el notional supera el tope: no es
    // un error, pero conviene que el usuario lo sepa antes de arrancar.
    if (size.gt(0) && maxPos.gt(0) && layers >= 1 && cfg.sizingMode !== SizingMode.BASE) {
      const weights = geometricWeights(layers, cfg.layerSizeMultiplier ?? 1);
      const perSide = weights.reduce((a, b) => a.plus(b), D(0)).mul(size);
      if (perSide.gt(maxPos)) {
        issues.push(
          warn(
            'layers',
            'Las capas de un lado suman ' +
              perSide.toFixed(2) +
              ', por encima del tope de posición (' +
              maxPos.toFixed(2) +
              '): las capas más profundas no llegarán a colocarse.',
          ),
        );
      }
    }
    return toResult(issues);
  },

  preview(cfg: MarketMakerConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const validation = this.validate(cfg, market);
    // Sin config valida no se puede calcular NADA: seguir adelante significaba
    // `D(undefined)` -> DecimalError -> 500 en `POST /bots/preview`. La escalera
    // no se pinta, pero los `issues` explican exactamente que falta.
    if (!validation.ok) return invalidPreview(validation.issues);
    const mid = cfg.referencePrice ? D(cfg.referencePrice) : D(refPrice);
    const profile = profileOf(cfg.riskProfile);
    const layers = Math.max(1, Math.floor(cfg.layers ?? 1));
    const sizeWeights = geometricWeights(layers, cfg.layerSizeMultiplier ?? 1);
    const distWeights = geometricWeights(layers, cfg.layerDistanceMultiplier ?? 1);
    const size = D(cfg.orderSizePerSide ?? 0);
    const lev = D(cfg.leverage);

    const levels: RawLevel[] = [];
    const quoteBoth = (cfg.direction ?? 'NEUTRAL') === 'NEUTRAL';

    for (let l = 0; l < layers; l++) {
      const unit = size.mul(sizeWeights[l]);

      if (quoteBoth || cfg.direction === 'LONG') {
        const bps = D(cfg.buyDistanceBps).mul(distWeights[l]).mul(profile.distance);
        const price = mid.mul(D(1).minus(bps.div(BPS)));
        const { qty, notional } = sizeToQty(cfg.sizingMode, unit, price);
        levels.push({
          index: l,
          kind: LevelKind.QUOTE_BID,
          side: 'BUY',
          price,
          qty,
          margin: lev.gt(0) ? notional.div(lev) : notional,
          isEntry: true,
        });
      }

      if (quoteBoth || cfg.direction === 'SHORT') {
        const bps = D(cfg.sellDistanceBps).mul(distWeights[l]).mul(profile.distance);
        const price = mid.mul(D(1).plus(bps.div(BPS)));
        const { qty, notional } = sizeToQty(cfg.sizingMode, unit, price);
        levels.push({
          index: layers + l,
          kind: LevelKind.QUOTE_ASK,
          side: 'SELL',
          price,
          qty,
          margin: lev.gt(0) ? notional.div(lev) : notional,
          isEntry: true,
        });
      }
    }

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
    const cfg = ctx.config as unknown as MarketMakerConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const pd = ctx.market.priceDecimals;
    const scratch = ctx.cycle.scratch;

    const liveMid = bookMid(ctx.ticker);
    const anchor = cfg.referencePrice ? D(cfg.referencePrice) : null;

    // ── Refresco: no se recotiza en cada tick ──
    // Recotizar constantemente cancela y repone órdenes sin parar, pierde la
    // prioridad en el libro y quema rate limit. Solo se mueve si toca por
    // tiempo o si el precio se ha ido más allá de la distancia mínima, que es
    // cuando la cotización vieja pasa a ser carne de arbitraje.
    const refreshMs = Math.max(5, Math.floor(cfg.refreshSeconds ?? 30)) * 1000;
    const quotedMidRaw = scratch['quotedMid'] as string | undefined;
    const quotedAt = Number(scratch['quotedAt'] ?? 0);
    const quotedMid = quotedMidRaw ? D(quotedMidRaw) : null;

    const driftBps =
      quotedMid && quotedMid.gt(0) ? liveMid.minus(quotedMid).div(quotedMid).mul(BPS).abs() : null;
    const staleByTime = ctx.now - quotedAt >= refreshMs;
    const staleByDrift = driftBps != null && driftBps.gte(D(cfg.minAllowedDistanceBps));

    // Espera tras un fill: el mercado acaba de barrer nuestra cotización, así
    // que perseguirlo de inmediato es justo lo que convierte una ejecución
    // rentable en una racha de ejecuciones adversas. Se congela la cotización
    // vigente; si aún no hay ninguna, no hay nada que congelar.
    const cooldownMs = Math.max(0, Math.floor(cfg.fillCooldownSeconds ?? 0)) * 1000;
    const lastFillAt = ctx.cycle.lastEntryAt ?? 0;
    const cooling = cooldownMs > 0 && quotedMid != null && ctx.now - lastFillAt < cooldownMs;

    // Caducidad de las órdenes de salida. Va ANTES de decidir el refresco y con
    // el mismo conjunto que luego se deja de desear: si solo forzara recotizar,
    // con el precio quieto se pedirían los mismos precios, el diff los daría por
    // buenos y la antigüedad no se renovaría nunca. Ver `expiredQuotes`.
    //
    // Durante la espera tras un fill no caduca nada: congelar la cotización es
    // justo lo que esa espera significa.
    const layers = Math.max(1, Math.floor(cfg.layers ?? 1));
    const ages = orderAges(ctx.openOrders);
    const roles = sideRoles(ctx.position ? D(ctx.position.qty) : D(0));
    const expired = cooling
      ? new Set<string>()
      : expiredQuotes({
          ages,
          now: ctx.now,
          layers,
          coidFor: (kind, layer) => makeCoid(ctx.botId, seq, LevelKind[kind], layer),
          roles,
          exitTtlSeconds: cfg.exitOrderTtlSeconds,
        });

    const shouldRequote =
      quotedMid == null || (!cooling && (staleByTime || staleByDrift || expired.size > 0));

    const mid = anchor ?? (shouldRequote ? liveMid : quotedMid);
    const scratchPatch: Record<string, unknown> = {};
    if (!anchor && shouldRequote) {
      scratchPatch['quotedMid'] = mid.toFixed(pd);
      scratchPatch['quotedAt'] = ctx.now;
    }

    // ── Inventario, régimen de riesgo y topes ──
    const maxPos = D(cfg.maxBotPositionValue ?? 0);
    const inv = inventoryOf(ctx, mid, maxPos);
    const longCap = cfg.maxLongPosition ? D(cfg.maxLongPosition) : maxPos;
    const shortCap = cfg.maxShortPosition ? D(cfg.maxShortPosition) : maxPos;

    const regime = riskRegime(inv.loadPct, cfg.defensiveThresholdPct, cfg.highRiskThresholdPct);
    const regimeMul = REGIME_DISTANCE[regime];
    const band = priceBand(cfg, mid);

    const atCap = maxPos.gt(0) && inv.exposure.abs().gte(maxPos);
    const breach = limitBreach(cfg, atCap, scratch);

    const profile = profileOf(cfg.riskProfile);
    const skewFactor =
      cfg.inventoryPriceAdjustment === false ? D(0) : D(cfg.inventorySkewFactor ?? 1);
    const baseBps = D(cfg.buyDistanceBps).plus(cfg.sellDistanceBps).div(2);

    // Con inventario largo el centro baja: se compra más lejos y se vende más
    // cerca, de modo que el bot se deshaga del inventario antes de acumular más.
    const skewedMid = mid.mul(D(1).minus(skewFactor.mul(inv.ratio).mul(baseBps).div(BPS)));

    // Diferencial dinámico: cuanto más cargado el inventario, más ancho, porque
    // el riesgo de quedarse atrapado del lado equivocado ha crecido.
    const spreadWiden = cfg.dynamicSpread === false ? D(1) : D(1).plus(inv.ratio.abs());

    const sizeWeights = geometricWeights(layers, cfg.layerSizeMultiplier ?? 1);
    const distWeights = geometricWeights(layers, cfg.layerDistanceMultiplier ?? 1);
    const size = D(cfg.orderSizePerSide ?? 0).mul(profile.size);
    const minBps = D(cfg.minAllowedDistanceBps ?? 1);

    // «Ajustar distancia automáticamente»: la distancia base deja de ser un
    // número fijo y pasa a seguir la anchura real del libro. En un par que se
    // ensancha, una distancia fija se queda dentro del diferencial y ejecuta
    // contra flujo informado.
    const autoBps = cfg.autoAdjustDistance ? bookSpreadBps(ctx.ticker).mul(1.2) : D(0);
    const buyBase = Decimal.max(D(cfg.buyDistanceBps), autoBps);
    const sellBase = Decimal.max(D(cfg.sellDistanceBps), autoBps);

    const dir = cfg.direction ?? 'NEUTRAL';
    const quoteBids = dir === 'NEUTRAL' || dir === 'LONG';
    const quoteAsks = dir === 'NEUTRAL' || dir === 'SHORT';
    const orderType = cfg.postOnly === false ? 'LIMIT' : 'POST_ONLY';

    const buyRole = roles.buy;
    const sellRole = roles.sell;

    const orders: DesiredOrder[] = [];
    let projectedLong = inv.exposure.gt(0) ? inv.exposure : D(0);
    let projectedShort = inv.exposure.lt(0) ? inv.exposure.abs() : D(0);

    for (let l = 0; l < layers; l++) {
      const unit = size.mul(sizeWeights[l]);
      if (unit.lte(0)) continue;

      // ── Compras ──
      const buyMul = regimeMul[buyRole];
      const buyBlocked =
        !quoteBids ||
        buyMul.lte(0) ||
        (buyRole === 'adding' && (band.blockBuy || breach.pauseEntries));

      if (!buyBlocked) {
        const bps = Decimal.max(
          minBps,
          buyBase.mul(distWeights[l]).mul(profile.distance).mul(spreadWiden).mul(buyMul),
        );
        const price = skewedMid.mul(D(1).minus(bps.div(BPS)));
        const { qty, notional } = sizeToQty(cfg.sizingMode, unit, price);
        const coid = makeCoid(ctx.botId, seq, LevelKind.QUOTE_BID, l);
        const reduceOnly = buyRole === 'reducing' && regime === 'HIGH_RISK';

        // Caducada: se deja de desear para que el diff la cancele, y el tick
        // siguiente la repone al precio de entonces.
        const fits = reduceOnly || projectedLong.plus(notional).lte(longCap);

        if (price.gt(0) && qty.gt(0) && fits && !expired.has(coid)) {
          orders.push({
            clientOrderId: coid,
            levelKind: LevelKind.QUOTE_BID,
            levelIndex: l,
            side: 'BUY',
            // POST_ONLY por defecto: un market maker que cruza el libro paga
            // taker y se queda sin el diferencial que justifica la estrategia.
            type: orderType,
            price: px(ctx.market, price, 'BUY'),
            qty: qy(ctx.market, qty),
            reduceOnly,
          });
          if (!reduceOnly) projectedLong = projectedLong.plus(notional);
        }
      }

      // ── Ventas ──
      const sellMul = regimeMul[sellRole];
      const sellBlocked =
        !quoteAsks ||
        sellMul.lte(0) ||
        (sellRole === 'adding' && (band.blockSell || breach.pauseEntries));

      if (!sellBlocked) {
        const bps = Decimal.max(
          minBps,
          sellBase.mul(distWeights[l]).mul(profile.distance).mul(spreadWiden).mul(sellMul),
        );
        const price = skewedMid.mul(D(1).plus(bps.div(BPS)));
        const { qty, notional } = sizeToQty(cfg.sizingMode, unit, price);
        const coid = makeCoid(ctx.botId, seq, LevelKind.QUOTE_ASK, l);
        const reduceOnly = sellRole === 'reducing' && regime === 'HIGH_RISK';
        const fits = reduceOnly || projectedShort.plus(notional).lte(shortCap);

        if (price.gt(0) && qty.gt(0) && fits && !expired.has(coid)) {
          orders.push({
            clientOrderId: coid,
            levelKind: LevelKind.QUOTE_ASK,
            levelIndex: l,
            side: 'SELL',
            type: orderType,
            price: px(ctx.market, price, 'SELL'),
            qty: qy(ctx.market, qty),
            reduceOnly,
          });
          if (!reduceOnly) projectedShort = projectedShort.plus(notional);
        }
      }
    }

    // ── Cierre forzado por «acción al alcanzar el límite» ──
    const immediate: DesiredOrder[] = [];
    if (breach.flatten && inv.qty.abs().gt(0)) {
      immediate.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.STOP_LOSS, 0),
        levelKind: LevelKind.STOP_LOSS,
        levelIndex: 0,
        side: inv.qty.gt(0) ? 'SELL' : 'BUY',
        type: 'MARKET',
        price: px(ctx.market, mid, inv.qty.gt(0) ? 'SELL' : 'BUY'),
        qty: qy(ctx.market, inv.qty.abs()),
        reduceOnly: true,
      });
      scratchPatch['limitActionFiredAt'] = ctx.now;
      if (breach.shutdown) scratchPatch['requestStop'] = 'STOP_KEEP_POSITION';
    }

    const note = buildNote(inv.exposure, inv.ratio, orders.length, regime, breach.note, cooling);

    return {
      orders,
      immediate,
      targetLeverage: cfg.leverage,
      note,
      scratchPatch: Object.keys(scratchPatch).length ? scratchPatch : undefined,
    };
  },
};

// ── Auxiliares compartidos con la V2 ──────────────────────────────────────

export function validateRiskThresholds(cfg: {
  defensiveThresholdPct?: string | null;
  highRiskThresholdPct?: string | null;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const defensive = cfg.defensiveThresholdPct ? D(cfg.defensiveThresholdPct) : null;
  const high = cfg.highRiskThresholdPct ? D(cfg.highRiskThresholdPct) : null;

  if (defensive && (defensive.lte(0) || defensive.gt(100))) {
    issues.push(err('defensiveThresholdPct', 'El umbral defensivo va entre 1 y 100 %.'));
  }
  if (high && (high.lte(0) || high.gt(100))) {
    issues.push(err('highRiskThresholdPct', 'El umbral de alto riesgo va entre 1 y 100 %.'));
  }
  if (defensive && high && defensive.gte(high)) {
    issues.push(
      err(
        'defensiveThresholdPct',
        'El umbral defensivo debe ser menor que el de alto riesgo: si no, el modo defensivo nunca llega a activarse.',
      ),
    );
  }
  return issues;
}

export function validatePriceBand(cfg: {
  priceFloor?: string | null;
  priceCeiling?: string | null;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const floor = cfg.priceFloor ? D(cfg.priceFloor) : null;
  const ceiling = cfg.priceCeiling ? D(cfg.priceCeiling) : null;
  if (floor && ceiling && floor.gte(ceiling)) {
    issues.push(err('priceFloor', 'El piso de precio debe ser menor que el techo.'));
  }
  return issues;
}

export function buildNote(
  exposure: Decimal,
  ratio: Decimal,
  quotes: number,
  regime: string,
  breachNote: string | null,
  cooling: boolean,
): string {
  if (breachNote) return breachNote;
  const head =
    'Inventario ' + exposure.toFixed(2) + ' (' + ratio.mul(100).toFixed(0) + ' % del tope), ';
  if (cooling) return head + 'espera tras ejecución.';
  const tail = quotes + ' cotizaciones.';
  return regime === 'NORMAL' ? head + tail : head + tail + ' Modo ' + regime.toLowerCase() + '.';
}
