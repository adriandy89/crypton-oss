/**
 * Seguimiento de tendencia: la única que gana cuando el precio se va recto.
 *
 * Las otras siete son de rango, de reversión a la media o de acumulación, y
 * todas pierden en el mismo sitio. La guía del market maker lo dice sin
 * rodeos: «el problema aparece cuando el precio no va y viene, sino que se va
 * en línea recta». Todo el arsenal de riesgo de esas siete —sesgos, modos
 * defensivos, topes, y el filtro de tendencia del spec 039— existe para LIMITAR
 * el daño en ese régimen. Esta lo aprovecha (spec 040).
 *
 * Tres decisiones que la definen:
 *
 * 1. **Entra por ruptura y solo si el mercado va a algún sitio.** Una ruptura
 *    en un mercado que va y viene es una ruptura falsa, y de esas hay muchas
 *    más que de las otras. El filtro es la eficiencia de Kaufman, la misma
 *    función que usan el asesor y el market maker.
 * 2. **El tamaño sale del riesgo, no del capital.** `riesgo / (k × ATR)`: la
 *    posición es pequeña cuando el mercado está nervioso y grande cuando está
 *    quieto, de modo que el dinero arriesgado por operación sea constante. Es
 *    lo que hace comparables dos operaciones separadas por meses.
 * 3. **La salida es un stop que sigue al precio y NUNCA retrocede.** No hay
 *    objetivo de beneficio: una ruptura acierta en torno al 40 % de las veces
 *    y vive de que los ganadores sean mucho mayores que los perdedores. Un
 *    objetivo fijo corta justo lo que da de comer.
 */
import {
  D,
  Decimal,
  LevelKind,
  StrategyKind,
  eficienciaKaufman,
  type BotContext,
  type CommonBotConfig,
  type DesiredOrder,
  type DesiredState,
  type FieldMeta,
  type MarketSpec,
  type PreviewResult,
  type ValidationIssue,
  type ValidationResult,
} from '@crypton/shared';
import { Mutability, type CandleInterval } from '@crypton/shared';
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
import { atr, donchian } from '../indicadores';
import type { Strategy } from '../types';
import { fundingAdverso } from './mm-shared';

export interface TrendFollowConfig extends CommonBotConfig {
  /** Resolución de las velas con las que se decide. */
  candleInterval: CandleInterval;
  /** Velas del canal de ruptura. */
  breakoutPeriod: number;
  /** Velas del ATR. */
  atrPeriod: number;
  /** A cuántos ATR se pone el stop, inicial y de seguimiento. */
  atrStopMultiplier: string;
  /** Porcentaje del capital que se arriesga en CADA operación. */
  riskPerTradePct: string;
  /** Eficiencia mínima del mercado para abrir. 0 = sin filtro. */
  entryEfficiency: string;
  /** Funding en contra a partir del cual no se abre ese lado. 0 = sin filtro. */
  maxAdverseFundingBps?: string;
  /** Cuánto tiene que moverse el stop para recolocarlo. */
  stopRepriceBps: string;
}

/** Intervalos que tienen sentido para decidir una tendencia. */
const INTERVALOS: CandleInterval[] = ['15m', '1h', '4h', '1d'];

const TREND_FIELDS: readonly FieldMeta[] = [
  {
    key: 'candleInterval',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'strategy.trend.candleInterval',
    helpKey: 'strategy.trend.candleIntervalHelp',
    options: INTERVALOS,
    required: true,
    default: '4h',
    group: 'core',
  },
  {
    key: 'breakoutPeriod',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.trend.breakoutPeriod',
    helpKey: 'strategy.trend.breakoutPeriodHelp',
    min: 5,
    max: 100,
    step: 1,
    required: true,
    default: 20,
    group: 'core',
  },
  {
    key: 'riskPerTradePct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.trend.riskPerTradePct',
    helpKey: 'strategy.trend.riskPerTradePctHelp',
    min: 0.1,
    max: 5,
    step: 0.1,
    required: true,
    default: 1,
    group: 'core',
    risky: true,
  },
  {
    key: 'atrPeriod',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'strategy.trend.atrPeriod',
    helpKey: 'strategy.trend.atrPeriodHelp',
    min: 5,
    max: 50,
    step: 1,
    required: true,
    default: 14,
    group: 'risk',
  },
  {
    key: 'atrStopMultiplier',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.trend.atrStopMultiplier',
    helpKey: 'strategy.trend.atrStopMultiplierHelp',
    min: 1,
    max: 6,
    step: 0.1,
    required: true,
    default: 2.5,
    group: 'risk',
    risky: true,
  },
  {
    key: 'stopRepriceBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.trend.stopRepriceBps',
    helpKey: 'strategy.trend.stopRepriceBpsHelp',
    min: 1,
    max: 200,
    step: 1,
    required: false,
    default: 20,
    group: 'risk',
    unit: 'bps',
    advanced: true,
  },
  {
    key: 'entryEfficiency',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.trend.entryEfficiency',
    helpKey: 'strategy.trend.entryEfficiencyHelp',
    min: 0,
    max: 1,
    step: 0.05,
    required: false,
    default: 0.35,
    group: 'risk',
  },
  {
    key: 'maxAdverseFundingBps',
    kind: 'number',
    mutability: Mutability.HOT,
    labelKey: 'strategy.mm.maxAdverseFundingBps',
    helpKey: 'strategy.mm.maxAdverseFundingBpsHelp',
    min: 0,
    max: 100,
    step: 0.5,
    required: false,
    default: 0,
    group: 'risk',
    unit: 'bps',
    advanced: true,
  },
] as const;

/** Cuántas velas hacen falta: la mayor de las dos ventanas, con holgura. */
const barsNecesarias = (cfg: TrendFollowConfig): number =>
  Math.max(Math.floor(cfg.breakoutPeriod ?? 20), Math.floor(cfg.atrPeriod ?? 14)) + 5;

/** Señal del canal, o null si no hay velas suficientes. */
function senal(
  ctx: BotContext,
  cfg: TrendFollowConfig,
): { lado: 'BUY' | 'SELL' | null; atrValor: Decimal; eficiencia: Decimal } | null {
  const velas = ctx.candles ?? [];
  const canal = donchian(velas, Math.floor(cfg.breakoutPeriod ?? 20));
  const a = atr(velas, Math.floor(cfg.atrPeriod ?? 14));
  if (!canal || !a || !a.gt(0)) return null;

  const eficiencia = eficienciaKaufman(velas.map((v) => v.c));
  const lado = canal.cierre.gt(canal.alto) ? 'BUY' : canal.cierre.lt(canal.bajo) ? 'SELL' : null;
  return { lado, atrValor: a, eficiencia };
}

/** Distancia del stop en precio: `k × ATR`. */
const distanciaStop = (cfg: TrendFollowConfig, atrValor: Decimal): Decimal =>
  atrValor.mul(D(cfg.atrStopMultiplier ?? 2.5));

/**
 * Cantidad por objetivo de volatilidad.
 *
 * El riesgo en dinero es constante y lo que varía es el tamaño, no al revés.
 * Con el ATR al doble, la posición es la mitad: la operación arriesga lo mismo.
 */
function cantidad(cfg: TrendFollowConfig, riesgoPrecio: Decimal): Decimal {
  if (!riesgoPrecio.gt(0)) return D(0);
  const capital = D(cfg.totalInvestment ?? 0);
  const pct = D(cfg.riskPerTradePct ?? 0);
  return capital.mul(pct).div(100).div(riesgoPrecio);
}

/**
 * Nocional máximo que este bot puede sostener.
 *
 * Hace falta porque el tamaño sale de DIVIDIR por la distancia al stop: en un
 * mercado muy tranquilo esa división se dispara y pide más margen del que hay.
 * Recortar baja el riesgo por debajo del declarado, así que es seguro; pero el
 * usuario pidió arriesgar un 1 % y va a arriesgar menos, y eso se dice
 * (spec 041 R-3).
 */
function techoNocional(cfg: TrendFollowConfig, availableBalance: string): Decimal {
  const lev = Decimal.max(D(1), D(cfg.leverage ?? 1));
  const topes = [D(cfg.totalInvestment ?? 0).mul(lev), D(availableBalance ?? 0).mul(lev)];
  const cap = D(cfg.maxNotionalCap ?? 0);
  if (cap.gt(0)) topes.push(cap);
  return topes.reduce((a, b) => (b.lt(a) ? b : a));
}

/**
 * `direction` con NEUTRAL, como los market makers.
 *
 * Una tendencia bajista es una tendencia igual, asi que el valor util por
 * defecto es «los dos lados». `LONG` y `SHORT` pasan a significar «solo
 * rupturas en ese sentido», que es una decision de conviccion, no de prudencia.
 *
 * Se hace asi y no con un `allowShort` aparte porque dos mandos para la misma
 * pregunta es una manera de que acaben contradiciendose.
 */
const TREND_DIRECTION: FieldMeta = {
  key: 'direction',
  kind: 'enum',
  mutability: Mutability.COLD,
  labelKey: 'strategy.trend.direction',
  helpKey: 'strategy.trend.directionHelp',
  options: ['NEUTRAL', 'LONG', 'SHORT'],
  required: true,
  default: 'NEUTRAL',
  group: 'core',
  control: 'segment',
};

const META = {
  kind: StrategyKind.TREND_FOLLOW,
  labelKey: 'strategy.trend.label',
  descriptionKey: 'strategy.trend.description',
  fields: [...commonFieldsWith([TREND_DIRECTION]), ...TREND_FIELDS],
};

export const trendFollow: Strategy<TrendFollowConfig> = {
  kind: StrategyKind.TREND_FOLLOW,
  meta: META,

  // NO se declara `reusesOrderSlots`, y es deliberado.
  //
  // Esa bandera permite al motor recolocar un id que YA se ejecutó. Para un
  // market maker es necesario —«ejecutada» significa que el hueco quedó libre—;
  // aquí sería una SEGUNDA entrada a mercado: la señal de ruptura sale de la
  // vela cerrada, así que sigue siendo cierta durante todo el intervalo, y
  // mientras la posición no aparezca en `getPositions()` cada tick vuelve a ver
  // ruptura y posición cero. Sin la bandera, la fila `FILLED` veta la
  // recolocación para el resto del ciclo (spec 041 R-1).
  //
  // No se pierde nada: al cerrarse la posición se cierra el ciclo —no se
  // declara `keepCycleOnFlat`—, sube `cycleSeq` y los ids siguientes son otros.

  candles: (cfg) => ({
    interval: cfg.candleInterval ?? '4h',
    bars: barsNecesarias(cfg),
  }),

  defaults() {
    return {
      direction: 'NEUTRAL',
      leverage: 2,
      marginMode: 'ISOLATED',
      candleInterval: '4h',
      breakoutPeriod: 20,
      atrPeriod: 14,
      atrStopMultiplier: '2.5',
      riskPerTradePct: '1',
      entryEfficiency: '0.35',
      maxAdverseFundingBps: '0',
      stopRepriceBps: '20',
      cooldownMinutes: 0,
    };
  },

  validate(config: TrendFollowConfig, market: MarketSpec): ValidationResult {
    const issues: ValidationIssue[] = validateCommon(config, market);

    if (!INTERVALOS.includes(config.candleInterval)) {
      issues.push(err('candleInterval', 'Resolución de vela no admitida.'));
    }
    if (D(config.riskPerTradePct ?? 0).lte(0)) {
      issues.push(err('riskPerTradePct', 'El riesgo por operación tiene que ser mayor que 0.'));
    }
    if (D(config.atrStopMultiplier ?? 0).lte(0)) {
      issues.push(err('atrStopMultiplier', 'El multiplicador del stop tiene que ser mayor que 0.'));
    }

    // Un stop muy pegado en una estrategia de tendencia no es prudencia: es
    // salirse en el primer respiro del mercado, una y otra vez, pagando la
    // comisión cada vez.
    if (D(config.atrStopMultiplier ?? 0).lt(1.5)) {
      issues.push(
        warn(
          'atrStopMultiplier',
          'Un stop a menos de 1,5 ATR salta con el ruido normal del mercado: la operación se ' +
            'cierra en el primer respiro, no en el cambio de tendencia.',
        ),
      );
    }

    // El stop lo pone la estrategia, así que el `stopLossPct` común no manda
    // aquí. Decirlo es mejor que dejar al usuario creer que tiene dos.
    if (config.stopLossPct != null && D(config.stopLossPct).gt(0)) {
      issues.push(
        warn(
          'stopLossPct',
          'Esta estrategia pone su propio stop, calculado con el ATR y en movimiento. El stop ' +
            'loss por porcentaje no se usa.',
        ),
      );
    }

    if (D(config.riskPerTradePct ?? 0).gt(2)) {
      issues.push(
        warn(
          'riskPerTradePct',
          'Arriesgar más del 2 % por operación en una estrategia que acierta unas cuatro de cada ' +
            'diez veces encadena rachas de pérdidas muy profundas.',
        ),
      );
    }

    return toResult(issues);
  },

  preview(config: TrendFollowConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const validation = this.validate(config, market);
    if (!validation.ok) return invalidPreview(validation.issues);

    const precio = D(refPrice);
    // Sin velas no hay ATR, así que el preview usa una estimación honesta: un
    // ATR del 2 % del precio, que es el orden de magnitud de un par líquido en
    // 4 h. Se dice en un aviso, porque el tamaño REAL saldrá del ATR de verdad.
    const atrEstimado = precio.mul(D(0.02));
    const riesgo = distanciaStop(config, atrEstimado);
    // Con el MISMO techo que `plan()`, o la vista previa prometería un tamaño
    // que el bot no va a colocar. Sin `availableBalance` —que no existe antes
    // de crear el bot— se usa solo la parte que sale de la configuración.
    const deseada = cantidad(config, riesgo);
    const maxQty = precio.gt(0)
      ? techoNocional(config, String(config.totalInvestment ?? 0)).div(precio)
      : D(0);
    const qty = deseada.gt(maxQty) ? maxQty : deseada;
    const notional = qty.mul(precio);
    // Con NEUTRAL el preview enseña el lado largo: es una sola operación, no
    // dos a la vez, y el corto es su espejo exacto.
    const largo = config.direction !== 'SHORT';

    const levels: RawLevel[] = [
      {
        index: 0,
        kind: LevelKind.BASE,
        side: largo ? 'BUY' : 'SELL',
        price: precio,
        qty,
        margin: D(config.leverage ?? 1).gt(0) ? notional.div(D(config.leverage ?? 1)) : notional,
        isEntry: true,
      },
    ];

    return buildPreview({
      levels,
      market,
      refPrice,
      direction: largo ? 'LONG' : 'SHORT',
      leverage: config.leverage,
      marginMode: config.marginMode,
      issues: [
        ...validation.issues,
        warn(
          null,
          'El tamaño de arriba es una estimación con un ATR del 2 % del precio. El real lo ' +
            'calculará el bot con el ATR de verdad del par: con un mercado más nervioso, la ' +
            'posición será menor, y el riesgo en dinero el mismo.',
        ),
      ],
    });
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as TrendFollowConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const scratchPatch: Record<string, unknown> = {};

    const necesarias = barsNecesarias(cfg);
    const velas = ctx.candles ?? [];
    if (velas.length < necesarias) {
      return {
        orders: [],
        immediate: [],
        note:
          `Esperando velas de ${cfg.candleInterval}: hay ${velas.length} de ${necesarias}. ` +
          'Sin histórico no hay ni canal ni ATR.',
      };
    }

    const s = senal(ctx, cfg);
    if (!s) {
      return { orders: [], immediate: [], note: 'Sin ATR ni canal: velas insuficientes o planas.' };
    }

    const qtyPos = ctx.position ? D(ctx.position.qty) : D(0);
    const riesgo = distanciaStop(cfg, s.atrValor);

    // ── Con posición: solo el stop, que sigue al precio ────────────────
    if (!qtyPos.isZero()) {
      const largo = qtyPos.gt(0);
      const referencia = D(ctx.ticker.mark);
      const candidato = largo ? referencia.minus(riesgo) : referencia.plus(riesgo);
      const guardado = ctx.cycle.scratch['stopPrice'];
      const previo = typeof guardado === 'string' ? D(guardado) : null;

      // El PRIMER stop se ancla en el precio de ENTRADA, no en la marca.
      //
      // Si el precio se mueve en contra entre la ejecución y este tick, anclar
      // en la marca pondría el stop más lejos y la operación arriesgaría más
      // que el porcentaje declarado — que es justo la promesa que sostiene esta
      // estrategia. Con entrada en 100 y 3 de distancia, el stop va a 97 aunque
      // el precio ya esté en 94 (spec 041 R-2).
      //
      // Y el seguimiento no se pierde: si el precio se ha ido a FAVOR, manda el
      // candidato, que ya está más arriba.
      const entrada = D(ctx.position?.entryPrice ?? 0);
      const inicial = entrada.gt(0)
        ? largo
          ? entrada.minus(riesgo)
          : entrada.plus(riesgo)
        : candidato;

      // NUNCA en contra. Es la única regla que hace que un stop de seguimiento
      // sea un stop de seguimiento y no un stop que persigue al precio.
      const base = previo ?? inicial;
      const stop = largo ? Decimal.max(base, candidato) : Decimal.min(base, candidato);

      // Recolocar solo si se ha movido de verdad: un trailing que se reescribe
      // en cada tick son 2 peticiones cada quince segundos contra el cupo.
      const movidoBps = previo?.gt(0)
        ? stop.minus(previo).abs().div(previo).mul(D(10_000))
        : D(Number.MAX_SAFE_INTEGER);
      const recoloca = !previo || movidoBps.gte(D(cfg.stopRepriceBps ?? 20));
      if (recoloca) scratchPatch['stopPrice'] = stop.toFixed(ctx.market.priceDecimals);

      const vigente = recoloca ? stop : previo;
      const side = largo ? 'SELL' : 'BUY';
      const precio = px(ctx.market, vigente, side);
      const orden: DesiredOrder = {
        clientOrderId: makeCoid(ctx.botId, seq, LevelKind.STOP_LOSS, 0),
        levelKind: LevelKind.STOP_LOSS,
        levelIndex: 0,
        side,
        type: 'MARKET',
        price: precio,
        triggerPrice: precio,
        qty: qy(ctx.market, qtyPos.abs()),
        reduceOnly: true,
      };

      return {
        orders: [orden],
        immediate: [],
        note:
          `${largo ? 'Largo' : 'Corto'} en marcha. Stop en ${precio} ` +
          `(${D(cfg.atrStopMultiplier ?? 2.5).toFixed(1)} ATR), eficiencia ` +
          `${s.eficiencia.toFixed(2)}.`,
        scratchPatch: Object.keys(scratchPatch).length ? scratchPatch : undefined,
      };
    }

    // ── Plana: ¿hay ruptura que valga la pena? ─────────────────────────
    if (!s.lado) {
      return {
        orders: [],
        immediate: [],
        note: `Sin ruptura. Eficiencia ${s.eficiencia.toFixed(2)}.`,
      };
    }

    const umbral = D(cfg.entryEfficiency ?? 0);
    if (umbral.gt(0) && s.eficiencia.lt(umbral)) {
      return {
        orders: [],
        immediate: [],
        note:
          `Ruptura descartada: eficiencia ${s.eficiencia.toFixed(2)} por debajo de ` +
          `${umbral.toFixed(2)}. En un mercado que va y viene, casi todas son falsas.`,
      };
    }

    if (cfg.direction === 'LONG' && s.lado === 'SELL') {
      return { orders: [], immediate: [], note: 'Ruptura a la baja, pero el bot es solo largo.' };
    }
    if (cfg.direction === 'SHORT' && s.lado === 'BUY') {
      return { orders: [], immediate: [], note: 'Ruptura al alza, pero el bot es solo corto.' };
    }
    if (fundingAdverso(ctx.ticker, s.lado, cfg.maxAdverseFundingBps)) {
      return {
        orders: [],
        immediate: [],
        note:
          'Ruptura descartada por funding: abrir ahora sería ponerse del lado que paga, que ' +
          'suele ser el lado en el que ya está todo el mundo.',
      };
    }

    const precio = px(ctx.market, D(ctx.ticker.mark), s.lado);
    const deseada = cantidad(cfg, riesgo);
    const techo = techoNocional(cfg, ctx.availableBalance);
    const maxQty = D(precio).gt(0) ? techo.div(D(precio)) : D(0);
    const recortada = deseada.gt(maxQty);
    const qty = recortada ? maxQty : deseada;
    if (!qty.gt(0)) {
      return {
        orders: [],
        immediate: [],
        note: 'Ruptura detectada, pero el tamaño calculado es cero.',
      };
    }

    return {
      orders: [
        {
          clientOrderId: makeCoid(ctx.botId, seq, LevelKind.BASE, 0),
          levelKind: LevelKind.BASE,
          levelIndex: 0,
          side: s.lado,
          type: 'MARKET',
          price: precio,
          qty: qy(ctx.market, qty),
          reduceOnly: false,
        },
      ],
      immediate: [],
      note:
        `Ruptura ${s.lado === 'BUY' ? 'al alza' : 'a la baja'} con eficiencia ` +
        `${s.eficiencia.toFixed(2)}. ATR ${s.atrValor.toFixed(ctx.market.priceDecimals)}.` +
        (recortada
          ? ' Tamaño recortado al capital disponible: se arriesga menos del porcentaje pedido.'
          : ''),
    };
  },
};
