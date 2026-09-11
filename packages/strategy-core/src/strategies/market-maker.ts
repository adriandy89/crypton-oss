import {
  D,
  Decimal,
  LevelKind,
  Mutability,
  PositionModeSetting,
  SizingMode,
  StrategyKind,
  type BotContext,
  type CycleState,
  type Fill,
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
import { makeCoid, parseCoid } from '../client-order-id';
import {
  buildPreview,
  commonFieldsWith,
  comunCon,
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
  anotarFill,
  bookSpreadBps,
  centroDeMercado,
  centroSesgado,
  factorDeTamano,
  fundingAdverso,
  fundingBps,
  INTEL_DEFAULTS,
  INTEL_FIELDS,
  penalizacionMarkout,
  resolverMarkout,
  type IntelConfig,
  expiredQuotes,
  hayLibro,
  precioEstable,
  inventoryOf,
  limitBreach,
  orderAges,
  priceBand,
  profileOf,
  REGIME_DISTANCE,
  riskRegime,
  sideRoles,
  sinCruzarLibro,
  sizeToQty,
} from './mm-shared';

export interface MarketMakerConfig extends CommonBotConfig, IntelConfig {
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
 * Comunes que esta estrategia redefine en `defaults()`.
 *
 * `meta.default` no lo lee el formulario —la app siembra con `defaults()`—,
 * pero sí el panel de ayuda, que le enseña al usuario «por defecto: X», y
 * `coerceConfig` del asesor cuando no puede interpretar un valor. Con los dos
 * números en desacuerdo, la ayuda mentía (spec 037 R-5).
 */
const MM_COMUNES: FieldMeta[] = [
  comunCon('marginMode', { default: 'CROSS' }),
  comunCon('leverage', { default: 2 }),
];

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
  fields: [...commonFieldsWith([MM_DIRECTION, ...MM_COMUNES]), ...MM_FIELDS, ...INTEL_FIELDS],
};

export const marketMaker: Strategy<MarketMakerConfig> = {
  kind: StrategyKind.MARKET_MAKER,
  meta: META,
  // Cada capa reutiliza su id en cada recotización; el propio plan decide
  // cuándo cotizar. Sin esto, una capa moría tras su primera ejecución.
  reusesOrderSlots: true,
  // Quedar plano NO cierra el ciclo: para un market maker eso es el final de
  // cada par casado, y cerrarlo cambiaba los ids (cancelar y reponer todas las
  // capas), borraba la cotización vigente y anulaba la espera tras el fill que
  // cierra el par (001/F-58). El ciclo es la vida del bot hasta que se para.
  keepCycleOnFlat: true,

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
      ...INTEL_DEFAULTS,
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

    // En esta version `minAllowedDistanceBps` hace DOS trabajos: es el suelo de
    // la cotizacion y, ademas, el umbral de deriva que dispara una recotizacion
    // anticipada (ver la puerta de recotizado en `plan`). Es una rareza que la
    // V2 no tiene —alli hay un campo propio— y que conviene decir en voz alta
    // cuando el numero es tan bajo que el bot se pasa el dia recolocando.
    //
    // Solo en lo patologico: por debajo de la cuarta parte de la primera capa,
    // que es la tolerancia con la que se conservan las ordenes vivas. De fabrica
    // (8 frente a 20) no salta, y con lo que sugiere el asesor tampoco.
    if (minBps.gt(0) && minBps.mul(4).lt(Decimal.min(buyBps, sellBps))) {
      issues.push(
        warn(
          'minAllowedDistanceBps',
          'Este campo es a la vez el suelo de la cotización y el umbral que dispara una ' +
            'recotización. Con ' +
            minBps.toFixed(0) +
            ' bps y la primera capa a ' +
            Decimal.min(buyBps, sellBps).toFixed(0) +
            ' bps, el bot rehará su cotización en cuanto el precio se mueva una fracción de lo ' +
            'que la separa del mercado: gasta cuota del venue sin adelantar la ejecución.',
        ),
      );
    }

    const layers = Math.floor(cfg.layers ?? 0);
    if (layers < 1 || layers > 10)
      issues.push(err('layers', 'Las capas deben estar entre 1 y 10.'));
    // Varios niveles a la misma distancia son el mismo precio repetido: gastan
    // cuota y el venue puede rechazarlos como duplicados. Es el valor de
    // fábrica del multiplicador en la V2, así que basta con subir `layers`
    // para caer en ello (spec 037 R-2).
    if (layers > 1 && D(cfg.layerDistanceMultiplier ?? 1).lte(1)) {
      issues.push(
        err(
          'layerDistanceMultiplier',
          'Con más de un nivel, el multiplicador de distancia tiene que ser mayor que 1: con 1 todos los niveles caen al mismo precio.',
        ),
      );
    }

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

    // Que dos capas se solapen AL REDONDEAR al tick del venue no se puede
    // comprobar aquí: hace falta un precio de referencia. Lo resuelve `plan()`,
    // que no coloca dos veces el mismo precio. Aquí hasta el spec 037 había un
    // comentario que decía que lo detectaba `preview()` «donde normalizeOrder()
    // marca los niveles que caen al mismo precio»: era falso —`normalizeOrder`
    // mira precio, cantidad y mínimos, y no compara niveles entre sí— y desvió
    // una revisión entera (037/F-07).

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

    // Un tope por lado que no deja sitio ni a la cotización más pequeña mata
    // ese lado en silencio: así llegaban los '0.40' del copy-trading
    // (001/F-64). Cero o vacío significa «sin tope propio» y no se mira.
    if (size.gt(0) && layers >= 1 && cfg.sizingMode !== SizingMode.BASE) {
      const pesos = geometricWeights(layers, cfg.layerSizeMultiplier ?? 1);
      const menor = size.mul(profileOf(cfg.riskProfile).size).mul(Decimal.min(...pesos));
      for (const key of ['maxLongPosition', 'maxShortPosition'] as const) {
        const tope = cfg[key] ? D(cfg[key]) : D(0);
        if (tope.gt(0) && tope.lt(menor)) {
          issues.push(
            err(
              key,
              'El tope ' +
                (key === 'maxLongPosition' ? 'largo' : 'corto') +
                ' (' +
                tope.toFixed(2) +
                ') no deja sitio ni a la cotización más pequeña (' +
                menor.toFixed(2) +
                ').',
            ),
          );
        }
      }
    }
    // No se pone un stop POR DEFECTO a propósito: al dispararse cierra la
    // posición pero el bot sigue vivo y vuelve a cotizar, así que un stop
    // estrecho en un market maker es una máquina de vender en el mínimo y
    // recomprar. Su red natural es el tope de posición y la acción al
    // alcanzarlo. Pero que no lo lleve tiene que decirse, y decirse AL CREARLO
    // —`protectionNote` solo se pega a los avisos de pausa y parada, que en
    // este escenario no llegan a ocurrir— (spec 031).
    if (!cfg.stopLossPct || D(cfg.stopLossPct).lte(0)) {
      issues.push(
        warn(
          'stopLossPct',
          'Sin stop loss: la red de este bot es el tope de posición y la acción al alcanzarlo. ' +
            'Un stop cierra la posición pero NO para el bot, que volverá a cotizar; ponlo holgado ' +
            'si lo quieres como corte ante un movimiento brusco.',
        ),
      );
    }
    // Un parámetro que no hace nada porque otro lo apaga tiene que decirlo: es
    // el mismo problema de 001/F-12, pero por combinación (030/F-04).
    if (cfg.inventoryPriceAdjustment === false && D(cfg.inventorySkewFactor ?? 0).gt(0)) {
      issues.push(
        warn(
          'inventorySkewFactor',
          'El ajuste de precio por inventario está desactivado: el factor de sesgo no se usa.',
        ),
      );
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
    // El tamaño que se manda lleva el perfil (×0,7 en Conservador): sin él la
    // vista previa enseñaba 12 USDC por capa donde el bot mandaba 8,40, por
    // debajo del mínimo del par, y el bot no cotizaba nada (001/F-57).
    const size = D(cfg.orderSizePerSide ?? 0).mul(profile.size);
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
      marginMode: cfg.marginMode,
      // Con dirección NEUTRAL el bot cotiza los DOS lados, así que mezclar
      // compras y ventas en una sola media ponderada da una entrada media y una
      // liquidación que no existen. Es lo mismo que `neutral-grid` resolvió en
      // 001/F-14 y que aquí faltaba (spec 037 R-6).
      neutral: cfg.direction === 'NEUTRAL',
      issues: [...validation.issues, ...avisosDeTopeEnMoneda(cfg, mid)],
    });
  },

  /**
   * Anota la ejecución para medir el markout más tarde (spec 039 R-7).
   *
   * Apagado —que es de fábrica— devuelve el ciclo TAL CUAL: ni una escritura en
   * `scratch`, ni un byte más en la base por cada ejecución de cada bot.
   */
  onFill(ctx: BotContext, fill: Fill, cycle: CycleState): CycleState {
    const cfg = ctx.config as unknown as MarketMakerConfig;
    const pend = anotarFill(cycle.scratch, fill, ctx.now, cfg.markoutHorizonSeconds);
    if (!pend) return cycle;
    return { ...cycle, scratch: { ...cycle.scratch, mkPend: pend } };
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as MarketMakerConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const pd = ctx.market.priceDecimals;
    const scratch = ctx.cycle.scratch;

    // `baseBps` hace falta arriba del todo porque el sesgo por desequilibrio
    // se expresa en fracción de la distancia de cotización (spec 039).
    const baseBps = D(cfg.buyDistanceBps).plus(cfg.sellDistanceBps).div(2);
    // Microprecio y desequilibrio van AQUÍ, en el ancla, para que se congelen
    // con `quotedMid`: aplicarlos después movería los precios en cada tick sin
    // recotizar, que es el defecto que el 029 arregló en `autoAdjustDistance`.
    const liveMid = centroDeMercado(cfg, ctx.ticker, baseBps);
    const anchor = cfg.referencePrice ? D(cfg.referencePrice) : null;

    // ── Refresco: no se recotiza en cada tick ──
    // Recotizar constantemente cancela y repone órdenes sin parar, pierde la
    // prioridad en el libro y quema rate limit. Solo se mueve si toca por
    // tiempo o si el precio se ha ido más allá de la distancia mínima, que es
    // cuando la cotización vieja pasa a ser carne de arbitraje.
    // Mismo suelo que `validate` (15 s, el ritmo del motor); el 5 de antes era
    // una promesa que nadie ejecutaba (001/F-15).
    const refreshMs = Math.max(15, Math.floor(cfg.refreshSeconds ?? 30)) * 1000;
    const quotedMidRaw = scratch['quotedMid'] as string | undefined;
    const quotedAt = Number(scratch['quotedAt'] ?? 0);
    const quotedMid = quotedMidRaw ? D(quotedMidRaw) : null;

    const driftBps =
      quotedMid && quotedMid.gt(0) ? liveMid.minus(quotedMid).div(quotedMid).mul(BPS).abs() : null;
    const staleByTime = ctx.now - quotedAt >= refreshMs;
    const staleByDrift = driftBps != null && driftBps.gte(D(cfg.minAllowedDistanceBps));

    // Hacia qué lado se ha movido el mercado desde la última cotización. Es la
    // señal que conserva la orden que está a punto de ejecutarse (spec 035), y
    // se calcula del ANCLA y no de los precios: deducirla comparando la orden
    // viva con la deseada confundía «el mercado ha venido» con «el diferencial
    // se ha ensanchado», y anulaba el ensanchado por volatilidad y por régimen.
    const seAcerca = {
      bid: quotedMid != null && liveMid.lt(quotedMid),
      ask: quotedMid != null && liveMid.gt(quotedMid),
    };

    // Espera tras un fill: el mercado acaba de barrer nuestra cotización, así
    // que perseguirlo de inmediato es justo lo que convierte una ejecución
    // rentable en una racha de ejecuciones adversas. Se congela la cotización
    // vigente; si aún no hay ninguna, no hay nada que congelar.
    const cooldownMs = Math.max(0, Math.floor(cfg.fillCooldownSeconds ?? 0)) * 1000;
    const lastFillAt = ctx.cycle.lastEntryAt ?? 0;
    // Sin exigir `quotedMid`: con precio de referencia nunca se escribe y la
    // espera no regía jamás (001/F-15). Con el ancla no hay cotización que
    // congelar, pero sí caducidades que no renovar y una nota que lo diga.
    const cooling = cooldownMs > 0 && lastFillAt > 0 && ctx.now - lastFillAt < cooldownMs;

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
          // La V1 no caduca por edad —no tiene `orderMaxAgeSeconds`—, así que
          // esto solo exime al TTL de salida; pero la exime, que es el punto
          // (spec 037 R-3).
          alcanzando: seAcerca,
        });

    // Con ancla manual `quotedMid` no se escribe nunca —el centro no se mueve,
    // no hay nada que congelar—, así que `shouldRequote` se quedaba en `true`
    // PARA SIEMPRE. Da igual salvo con `autoAdjustDistance`: entonces la
    // distancia se recalculaba del libro vivo y `scratch` se reescribía en CADA
    // tick, que es exactamente el derroche que el 029 congeló. Con esa
    // combinación el reloj de la cotización pasa a ser `quotedAt` (spec 037 R-9).
    const relojPorTiempo = anchor != null && cfg.autoAdjustDistance === true;
    const yaCotizado = relojPorTiempo ? quotedAt > 0 : quotedMid != null;
    const shouldRequote =
      !yaCotizado || (!cooling && (staleByTime || staleByDrift || expired.size > 0));

    // El `|| quotedMid == null` no es defensivo: desde R-9 `shouldRequote` ya no
    // lleva esa comprobacion dentro, y sin ella TypeScript no puede estrechar.
    const mid = anchor ?? (shouldRequote || quotedMid == null ? liveMid : quotedMid);
    const scratchPatch: Record<string, unknown> = {};
    if (!anchor && shouldRequote) {
      scratchPatch['quotedMid'] = mid.toFixed(pd);
      scratchPatch['quotedAt'] = ctx.now;
    } else if (relojPorTiempo && shouldRequote) {
      // Solo el reloj: el centro es el ancla y no hay centro que recordar.
      scratchPatch['quotedAt'] = ctx.now;
    }

    // ── Inventario, régimen de riesgo y topes ──
    const maxPos = D(cfg.maxBotPositionValue ?? 0);
    const inv = inventoryOf(ctx, mid, maxPos);
    // Un tope por lado a cero (o vacío) es «sin tope propio»: manda el general.
    // Al copiar un bot a otro capital llegaba '0.00' y el lado moría (001/F-64).
    const topeLado = (raw: string | null | undefined): Decimal => {
      const v = raw ? D(raw) : D(0);
      return v.gt(0) ? v : maxPos;
    };
    const longCap = topeLado(cfg.maxLongPosition);
    const shortCap = topeLado(cfg.maxShortPosition);

    const regime = riskRegime(inv.loadPct, cfg.defensiveThresholdPct, cfg.highRiskThresholdPct);
    const regimeMul = REGIME_DISTANCE[regime];
    const band = priceBand(cfg, mid);

    // Los topes por lado cuentan como tope: antes solo dejaban de caber las
    // capas, sin acción al límite, ni régimen, ni nota (001/F-59).
    const atCapLong = inv.exposure.gt(0) && longCap.gt(0) && inv.exposure.gte(longCap);
    const atCapShort = inv.exposure.lt(0) && shortCap.gt(0) && inv.exposure.abs().gte(shortCap);
    const atCap = (maxPos.gt(0) && inv.exposure.abs().gte(maxPos)) || atCapLong || atCapShort;
    const breach = limitBreach(cfg, atCap, scratch);
    const ladoTope = atCapLong
      ? 'Tope largo alcanzado. '
      : atCapShort
        ? 'Tope corto alcanzado. '
        : '';

    const profile = profileOf(cfg.riskProfile);
    const skewFactor =
      cfg.inventoryPriceAdjustment === false ? D(0) : D(cfg.inventorySkewFactor ?? 1);
    // Con inventario largo el centro baja: se compra más lejos y se vende más
    // cerca, de modo que el bot se deshaga del inventario antes de acumular más.
    const porInventario = centroSesgado(mid, inv.ratio, skewFactor, baseBps);

    // Y por FUNDING, que en un perpetuo es el segundo canal económico del
    // inventario. El signo sale del funding y no de la posición: `f > 0` son
    // los largos pagando, así que bajar el centro inclina el libro del bot
    // hacia el lado al que el venue paga (spec 039 R-5).
    const fSkew = D(cfg.fundingSkewFactor ?? 0);
    const fBps = fSkew.gt(0) ? fundingBps(ctx.ticker) : null;
    const skewedMid = fBps
      ? porInventario.mul(D(1).minus(fSkew.mul(fBps).div(BPS)))
      : porInventario;

    // Diferencial dinámico: cuanto más cargado el inventario, más ancho, porque
    // el riesgo de quedarse atrapado del lado equivocado ha crecido.
    //
    // Ensancha SOLO el lado que añade. Se aplicaba a los dos, multiplicando al
    // régimen —que sí es asimétrico—, y el resultado era que el modo defensivo
    // no acercaba nada: a 75 % de carga la venta salía a 20 × 1,75 × 0,6 = 21
    // bps, MÁS lejos que los 20 de inventario cero, y en alto riesgo a 19 donde
    // la guía prometía 10. El mando que existe para deshacer inventario
    // cancelaba al mando que existe para deshacer inventario (spec 037 R-1).
    // El lado que reduce no tiene por qué pagar el riesgo de una posición de la
    // que está intentando salir.
    const widen = cfg.dynamicSpread === false ? D(1) : D(1).plus(inv.ratio.abs());
    const spreadWiden = (role: 'adding' | 'reducing') => (role === 'adding' ? widen : D(1));

    // Markout: lo que el bot ha aprendido de sus PROPIAS ejecuciones. Apagado
    // de fábrica, y apagado no toca `scratch` (spec 039 R-7).
    const mk = resolverMarkout(scratch, mid, ctx.now, cfg.markoutHorizonSeconds);
    if (mk.patch) Object.assign(scratchPatch, mk.patch);
    const sens = D(cfg.markoutSensitivity ?? 0);
    const castigoBid = penalizacionMarkout(mk.bidBps, sens);
    const castigoAsk = penalizacionMarkout(mk.askBps, sens);

    const sizeWeights = geometricWeights(layers, cfg.layerSizeMultiplier ?? 1);
    const distWeights = geometricWeights(layers, cfg.layerDistanceMultiplier ?? 1);
    const size = D(cfg.orderSizePerSide ?? 0).mul(profile.size);
    const minBps = D(cfg.minAllowedDistanceBps ?? 1);

    // «Ajustar distancia automáticamente»: la distancia base deja de ser un
    // número fijo y pasa a seguir la anchura real del libro. En un par que se
    // ensancha, una distancia fija se queda dentro del diferencial y ejecuta
    // contra flujo informado.
    //
    // Se congela con el centro. Se leía en vivo, fuera de la puerta de
    // recotizado, así que con esta opción los precios cambiaban en CADA tick
    // aunque `shouldRequote` fuese falso: el bot cancelaba y reponía sus 2·N
    // capas cada quince segundos para siempre, y la espera tras un fill dejaba
    // de significar nada (spec 029).
    const autoVivo = cfg.autoAdjustDistance ? bookSpreadBps(ctx.ticker).mul(1.2) : D(0);
    const autoGuardado = scratch['quotedAutoBps'] as string | undefined;
    const autoBps = !cfg.autoAdjustDistance
      ? D(0)
      : shouldRequote || autoGuardado === undefined
        ? autoVivo
        : D(autoGuardado);
    if (cfg.autoAdjustDistance && shouldRequote) {
      scratchPatch['quotedAutoBps'] = autoBps.toFixed(4);
    }
    const buyBase = Decimal.max(D(cfg.buyDistanceBps), autoBps);
    const sellBase = Decimal.max(D(cfg.sellDistanceBps), autoBps);

    const dir = cfg.direction ?? 'NEUTRAL';
    // Sin los dos lados del libro no hay toque contra el que medir, y `bookMid`
    // cae al precio de marca —un oráculo—: cotizar contra él es justo lo que
    // producía cruces sistemáticos. Mejor no cotizar y decirlo (spec 029).
    const libro = hayLibro(ctx.ticker);
    const quoteBids = libro && (dir === 'NEUTRAL' || dir === 'LONG');
    const quoteAsks = libro && (dir === 'NEUTRAL' || dir === 'SHORT');
    const orderType = cfg.postOnly === false ? 'LIMIT' : 'POST_ONLY';

    const buyRole = roles.buy;
    const sellRole = roles.sell;

    // Las órdenes propias que ya están en el libro, por id: hacen falta para
    // decidir capa a capa si merece la pena recolocarla (spec 031).
    const vivas = new Map(
      ctx.openOrders.filter((o) => o.clientOrderId).map((o) => [o.clientOrderId as string, o]),
    );

    const orders: DesiredOrder[] = [];
    // Un precio ya colocado no se repite: dos capas al mismo precio no dan más
    // profundidad que una, gastan cuota y el venue puede rechazarlas como
    // duplicadas. Pasa con el multiplicador de distancia en 1 —el valor de
    // fábrica de la V2— y también cuando el tick del venue redondea dos capas
    // vecinas al mismo sitio, que es el caso que `validate()` no puede ver
    // porque no conoce el precio (spec 037 R-2).
    const colocados = { BUY: new Set<string>(), SELL: new Set<string>() };
    let projectedLong = inv.exposure.gt(0) ? inv.exposure : D(0);
    let projectedShort = inv.exposure.lt(0) ? inv.exposure.abs() : D(0);

    for (let l = 0; l < layers; l++) {
      const unit = size.mul(sizeWeights[l]);
      if (unit.lte(0)) continue;
      // Sesgo de TAMAÑO por inventario: más suave que mover precios, porque no
      // sacrifica probabilidad de ejecución en el lado que quieres que ejecute.
      const kTam = cfg.sizeSkewFactor ?? 0;
      const unitBuy = unit.mul(factorDeTamano(buyRole, inv.ratio, kTam));
      const unitSell = unit.mul(factorDeTamano(sellRole, inv.ratio, kTam));

      // ── Compras ──
      const buyMul = regimeMul[buyRole];
      const buyBlocked =
        !quoteBids ||
        buyMul.lte(0) ||
        (buyRole === 'adding' &&
          (band.blockBuy ||
            breach.pauseEntries ||
            fundingAdverso(ctx.ticker, 'BUY', cfg.maxAdverseFundingBps)));

      if (!buyBlocked) {
        // El castigo por markout se SUMA después del suelo: si al bot le están
        // comprando barato, sus compras se alejan. La V1 no tiene techo, así
        // que aquí siempre tiene efecto.
        const bps = Decimal.max(
          minBps,
          buyBase.mul(distWeights[l]).mul(profile.distance).mul(spreadWiden(buyRole)).mul(buyMul),
        ).plus(castigoBid);
        // Acotado ANTES de dimensionar: la cantidad se calcula dividiendo por
        // el precio, así que hacerlo después dejaría el nocional descuadrado.
        const coid = makeCoid(ctx.botId, seq, LevelKind.QUOTE_BID, l);
        const price = sinCruzarLibro(
          precioEstable(
            skewedMid.mul(D(1).minus(bps.div(BPS))),
            bps,
            seAcerca.bid,
            vivas.get(coid),
          ),
          'BUY',
          ctx.ticker,
          ctx.market.tickSize,
        );
        const { qty, notional } = sizeToQty(cfg.sizingMode, unitBuy, price);
        const reduceOnly = buyRole === 'reducing' && regime === 'HIGH_RISK';

        // Caducada: se deja de desear para que el diff la cancele, y el tick
        // siguiente la repone al precio de entonces.
        const fits = reduceOnly || projectedLong.plus(notional).lte(longCap);

        const precio = px(ctx.market, price, 'BUY');
        if (price.gt(0) && qty.gt(0) && fits && !expired.has(coid) && !colocados.BUY.has(precio)) {
          colocados.BUY.add(precio);
          orders.push({
            clientOrderId: coid,
            levelKind: LevelKind.QUOTE_BID,
            levelIndex: l,
            side: 'BUY',
            // POST_ONLY por defecto: un market maker que cruza el libro paga
            // taker y se queda sin el diferencial que justifica la estrategia.
            type: orderType,
            price: precio,
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
        (sellRole === 'adding' &&
          (band.blockSell ||
            breach.pauseEntries ||
            fundingAdverso(ctx.ticker, 'SELL', cfg.maxAdverseFundingBps)));

      if (!sellBlocked) {
        const bps = Decimal.max(
          minBps,
          sellBase
            .mul(distWeights[l])
            .mul(profile.distance)
            .mul(spreadWiden(sellRole))
            .mul(sellMul),
        ).plus(castigoAsk);
        const coid = makeCoid(ctx.botId, seq, LevelKind.QUOTE_ASK, l);
        const price = sinCruzarLibro(
          precioEstable(skewedMid.mul(D(1).plus(bps.div(BPS))), bps, seAcerca.ask, vivas.get(coid)),
          'SELL',
          ctx.ticker,
          ctx.market.tickSize,
        );
        const { qty, notional } = sizeToQty(cfg.sizingMode, unitSell, price);
        const reduceOnly = sellRole === 'reducing' && regime === 'HIGH_RISK';
        const fits = reduceOnly || projectedShort.plus(notional).lte(shortCap);

        const precio = px(ctx.market, price, 'SELL');
        if (price.gt(0) && qty.gt(0) && fits && !expired.has(coid) && !colocados.SELL.has(precio)) {
          colocados.SELL.add(precio);
          orders.push({
            clientOrderId: coid,
            levelKind: LevelKind.QUOTE_ASK,
            levelIndex: l,
            side: 'SELL',
            type: orderType,
            price: precio,
            qty: qy(ctx.market, qty),
            reduceOnly,
          });
          if (!reduceOnly) projectedShort = projectedShort.plus(notional);
        }
      }
    }

    // ── Cierre forzado por «acción al alcanzar el límite» ──
    //
    // Con el id del cierre MANUAL (`TAKE_PROFIT#999`, el índice reservado fuera
    // de la escalera), no con `STOP_LOSS#0`. Ese era el id del stop que inyecta
    // el motor: con `stopLossPct` configurado, la fila viva del stop vetaba esta
    // inmediata y «cerrar todo» no salía nunca — justo cuando más falta hacía
    // (001/F-02). Compartir id con el cierre manual es correcto: los dos son
    // «cerrar toda la posición ahora», y si uno ya salió el otro sobra.
    const immediate: DesiredOrder[] = [];
    if (breach.flatten && inv.qty.abs().gt(0)) {
      immediate.push({
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 999),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: 999,
        side: inv.qty.gt(0) ? 'SELL' : 'BUY',
        type: 'MARKET',
        price: px(ctx.market, mid, inv.qty.gt(0) ? 'SELL' : 'BUY'),
        qty: qy(ctx.market, inv.qty.abs()),
        reduceOnly: true,
      });
      scratchPatch['limitActionFiredAt'] = ctx.now;
      if (breach.shutdown) scratchPatch['requestStop'] = 'STOP_KEEP_POSITION';
    }

    // Cuántas de las cotizaciones deseadas están de verdad en el libro. La nota
    // contaba las DESEADAS, así que un bot al que el venue le rechazaba todas
    // decía «6 cotizaciones» con el libro vacío: exactamente lo contrario de lo
    // que el usuario necesitaba saber (spec 029).
    const enLibro = ctx.openOrders.filter((o) => {
      const parsed = o.clientOrderId ? parseCoid(o.clientOrderId) : null;
      return parsed !== null && (parsed.kind === 'QUOTE_BID' || parsed.kind === 'QUOTE_ASK');
    }).length;

    // Un bot que no cotiza tiene que decir por qué: «0 cotizaciones» a secas
    // se lee como una avería del motor.
    let note =
      !libro && !breach.note
        ? 'Sin libro del venue (no publica los dos lados): no se cotiza.'
        : ladoTope +
          buildNote(inv.exposure, inv.ratio, orders.length, regime, breach.note, cooling, enLibro);
    // «La app avisa» si el mercado se aleja del ancla: no había tal aviso
    // (001/F-67). Se avisa en la nota cuando la deriva supera el doble de la
    // capa más lejana, que es cuando las cotizaciones quedan lejos del libro.
    if (anchor) {
      const lejana = Decimal.max(buyBase, sellBase)
        .mul(distWeights[layers - 1])
        .mul(profile.distance);
      const deriva = liveMid.minus(anchor).div(anchor).mul(BPS).abs();
      if (deriva.gt(lejana.mul(2))) {
        note =
          'Mercado a ' +
          deriva.toFixed(0) +
          ' bps del ancla: las cotizaciones quedan lejos del libro. ' +
          note;
      }
    }

    return {
      orders,
      immediate,
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

/**
 * Los dos avisos de tope que `validate()` no puede dar en modo BASE.
 *
 * Con «cantidad de moneda» el tamaño por orden es una cantidad y los topes son
 * nocional: compararlos exige un precio, y `validate()` no lo tiene. Se saltaba
 * las dos comprobaciones y nadie las suplía, así que en ese modo el usuario
 * perdía el aviso de que las capas no caben y —peor— el de 001/F-64: un tope
 * por lado que no da ni para la cotización más pequeña mata esa cara del bot en
 * silencio. `preview()` sí recibe precio de referencia (030/F-03).
 */
export function avisosDeTopeEnMoneda(cfg: MarketMakerConfig, mid: Decimal): ValidationIssue[] {
  if (cfg.sizingMode !== SizingMode.BASE || !mid.gt(0)) return [];
  const issues: ValidationIssue[] = [];
  const size = D(cfg.orderSizePerSide ?? 0);
  const layers = Math.floor(cfg.layers ?? 0);
  if (!size.gt(0) || layers < 1) return [];

  const pesos = geometricWeights(layers, cfg.layerSizeMultiplier ?? 1);
  const maxPos = D(cfg.maxBotPositionValue ?? 0);
  const perSide = pesos
    .reduce((a, b) => a.plus(b), D(0))
    .mul(size)
    .mul(mid);
  if (maxPos.gt(0) && perSide.gt(maxPos)) {
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

  const menor = size
    .mul(profileOf(cfg.riskProfile).size)
    .mul(Decimal.min(...pesos))
    .mul(mid);
  for (const key of ['maxLongPosition', 'maxShortPosition'] as const) {
    const tope = cfg[key] ? D(cfg[key]) : D(0);
    if (tope.gt(0) && tope.lt(menor)) {
      issues.push(
        err(
          key,
          'El tope ' +
            (key === 'maxLongPosition' ? 'largo' : 'corto') +
            ' (' +
            tope.toFixed(2) +
            ') no deja sitio ni a la cotización más pequeña (' +
            menor.toFixed(2) +
            ').',
        ),
      );
    }
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
  /** Cotizaciones propias vivas en el libro, si se conocen. */
  enLibro?: number,
): string {
  if (breachNote) return breachNote;
  const head =
    'Inventario ' + exposure.toFixed(2) + ' (' + ratio.mul(100).toFixed(0) + ' % del tope), ';
  if (cooling) return head + 'espera tras ejecución.';
  // Solo se dice cuando NO coinciden: en marcha coinciden casi siempre, y
  // repetir el mismo número dos veces no informa de nada.
  const tail =
    enLibro !== undefined && enLibro < quotes
      ? quotes + ' cotizaciones (' + enLibro + ' en el libro).'
      : quotes + ' cotizaciones.';
  return regime === 'NORMAL' ? head + tail : head + tail + ' Modo ' + regime.toLowerCase() + '.';
}
