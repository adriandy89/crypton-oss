import {
  D,
  Decimal,
  LevelKind,
  Mutability,
  StrategyKind,
  type BotContext,
  type CommonBotConfig,
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
    reshapes: true,
    required: true,
    risky: true,
  },
  {
    key: 'upperPrice',
    kind: 'price',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.upperPrice',
    reshapes: true,
    required: true,
    risky: true,
  },
  {
    key: 'anchorPrice',
    kind: 'price',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.anchorPrice',
    reshapes: true,
    helpKey: 'strategy.neutral.anchorPriceHelp',
    required: true,
  },
  {
    key: 'gridLevels',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.levels',
    reshapes: true,
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
    reshapes: true,
    options: ['ARITHMETIC', 'GEOMETRIC'],
    required: false,
    default: 'GEOMETRIC',
  },
  {
    key: 'sizeMultiplier',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'strategy.neutral.sizeMultiplier',
    reshapes: true,
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
/**
 * Lado memorizado de una línea: el que tiene tendido, o CRUZADA si el precio
 * la atravesó (normalmente porque su orden se ejecutó) y espera a alejarse.
 */
type LadoLinea = 'BUY' | 'SELL' | 'CRUZADA';

const leerLados = (cycle: CycleState): Record<string, LadoLinea> => {
  const raw = cycle.scratch['lineSides'];
  return raw && typeof raw === 'object' ? (raw as Record<string, LadoLinea>) : {};
};

/**
 * Histéresis de cada línea (001/F-81).
 *
 * Una línea del lado correcto sigue viva hasta que el precio la CRUZA; la
 * banda muerta solo gobierna el CAMBIO de lado: la línea cruzada se queda sin
 * orden hasta que el mark se aleja medio escalón, y entonces vuelve con el
 * lado contrario (o el mismo, si el precio volvió por donde vino). Antes la
 * banda cancelaba la línea en cuanto el precio se le acercaba a menos de medio
 * escalón: una compra en 95 (paso 5) solo vivía con el mark por encima de 97,5
 * y en una bajada gradual no se ejecutaba nunca; solo cobraba saltos de más de
 * medio escalón dentro de un latido.
 */
function ladoDeLinea(
  previo: LadoLinea | undefined,
  price: Decimal,
  mark: Decimal,
  deadband: Decimal,
): LadoLinea {
  if (previo === 'BUY') return price.lt(mark) ? 'BUY' : 'CRUZADA';
  if (previo === 'SELL') return price.gt(mark) ? 'SELL' : 'CRUZADA';
  if (previo === 'CRUZADA') {
    if (price.lt(mark.minus(deadband))) return 'BUY';
    if (price.gt(mark.plus(deadband))) return 'SELL';
    return 'CRUZADA';
  }
  // Sin memoria (primer plan del ciclo): el lado lo dicta el precio, y la
  // línea que cae justo en el mark espera a que se decida.
  if (price.lt(mark)) return 'BUY';
  if (price.gt(mark)) return 'SELL';
  return 'CRUZADA';
}

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
    if (levels < 4)
      issues.push(err('gridLevels', 'Una retícula neutral necesita al menos 4 niveles.'));

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
    // `plan()` no lee la dirección: la retícula es la misma en los tres casos y
    // la guía in-app prometía un sesgo que no existe (001/F-12).
    if (cfg.direction === 'LONG' || cfg.direction === 'SHORT') {
      issues.push(
        warn(
          'direction',
          'La dirección no sesga la retícula neutral: compras bajo el ancla y ventas encima, sea cual sea el valor.',
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
      marginMode: cfg.marginMode,
      // `plan()` no lee `direction`: la retícula es neutral siempre, y la
      // vista previa enseña las dos liquidaciones (001/F-14).
      neutral: true,
      issues: validation.issues,
    });
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as NeutralGridConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const mark = D(ctx.ticker.mark);

    const lines = buildLines(cfg);

    // Banda muerta de medio escalón LOCAL alrededor de cada línea: sin banda,
    // la línea más cercana al mercado cambiaría de lado en cada tick y el bot
    // se pasaría el día cancelando y recolocando la misma orden. Con espaciado
    // geométrico el paso no es uniforme —abajo las líneas están juntas, arriba
    // separadas— y una banda única de medio paso MEDIO dejaba dos vecinas de
    // abajo dentro de la banda y rearmaba tarde las de arriba (001/F-94): cada
    // línea usa la mitad de la distancia a su vecina más próxima.
    const medioPasoLocal = (i: number): Decimal => {
      const abajo = i > 0 ? lines[i].price.minus(lines[i - 1].price) : null;
      const arriba = i < lines.length - 1 ? lines[i + 1].price.minus(lines[i].price) : null;
      const paso =
        abajo && arriba ? Decimal.min(abajo, arriba) : (abajo ?? arriba ?? D(ctx.market.tickSize));
      return paso.div(2);
    };

    // Memoria por PRECIO y no por índice: sobrevive a un cambio de forma (una
    // línea que ya no existe simplemente no se lee) y no confunde dos líneas
    // distintas que hereden el mismo índice.
    const previos = leerLados(ctx.cycle);
    const lados: Record<string, LadoLinea> = {};
    let cambiado = Object.keys(previos).length !== lines.length;
    for (const [i, line] of lines.entries()) {
      const clave = line.price.toFixed();
      const lado = ladoDeLinea(previos[clave], line.price, mark, medioPasoLocal(i));
      lados[clave] = lado;
      if (previos[clave] !== lado) cambiado = true;
    }

    const posQty = ctx.position ? D(ctx.position.qty) : D(0);
    const exposure = posQty.abs().mul(mark);
    // Dos topes con la misma semántica: el propio (`maxExposure`) y el común
    // (`maxNotionalCap`), que aquí no se leía (001/F-12). Manda el menor.
    const topes = [cfg.maxExposure, cfg.maxNotionalCap]
      .map((t) => (t ? D(t) : D(0)))
      .filter((t) => t.gt(0));
    const cap = topes.length ? topes.reduce((a, b) => (a.lt(b) ? a : b)) : null;
    const capReached = cap != null && cap.gt(0) && exposure.gte(cap);

    const orders: DesiredOrder[] = [];

    for (const line of lines) {
      if (line.qty.lte(0)) continue;

      const lado = lados[line.price.toFixed()];
      if (lado === 'CRUZADA') continue;
      const isBuy = lado === 'BUY';

      // Con el tope alcanzado solo se dejan vivas las órdenes que REDUCEN la
      // posición neta; las que la aumentarían se retiran.
      if (capReached) {
        const wouldIncrease = (isBuy && posQty.gte(0)) || (!isBuy && posQty.lte(0));
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

    // Espera entre ciclos (001/F-12): al volver a plano se cierra el ciclo y, si
    // hay espera configurada, la retícula no vuelve a tenderse hasta que pase.
    const espera = ctx.cycle.cooldownUntil ?? 0;
    if (espera > ctx.now) {
      orders.length = 0;
      note = 'Espera entre ciclos: ' + Math.ceil((espera - ctx.now) / 1000) + ' s sin órdenes.';
    }

    if (cfg.reanchorOnDrift && cfg.reanchorThresholdPct) {
      const drift = mark.minus(cfg.anchorPrice).div(cfg.anchorPrice).mul(100).abs();
      if (drift.gte(cfg.reanchorThresholdPct)) {
        note += ' Desvío del ancla ' + drift.toFixed(1) + ' %: procede recentrar.';
      }
    }

    return {
      orders,
      immediate: [],
      targetLeverage: cfg.leverage,
      note,
      ...(cambiado ? { scratchPatch: { lineSides: lados } } : {}),
    };
  },

  /**
   * La ejecución de una línea la deja CRUZADA en la memoria: así el plan
   * siguiente no la vuelve a tender aunque el mark siga un pelo del lado bueno
   * (el mark va con retraso respecto al último cruce) y, con la reutilización
   * de ids, el motor no recoloca la misma compra encima de la que acaba de
   * ejecutarse. El plan tiene además su propio detector por precio, por si
   * esta ejecución no llegara.
   */
  onFill(ctx: BotContext, fill: Fill, cycle: CycleState): CycleState {
    const parsed = fill.clientOrderId ? parseCoid(fill.clientOrderId) : null;
    if (!parsed || (parsed.kind !== LevelKind.GRID_BUY && parsed.kind !== LevelKind.GRID_SELL)) {
      return cycle;
    }
    const cfg = ctx.config as unknown as NeutralGridConfig;
    const line = buildLines(cfg).find((l) => l.index === parsed.levelIndex);
    if (!line) return cycle;
    const lados = { ...leerLados(cycle), [line.price.toFixed()]: 'CRUZADA' as LadoLinea };
    return { ...cycle, scratch: { ...cycle.scratch, lineSides: lados } };
  },
};
