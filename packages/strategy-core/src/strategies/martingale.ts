import {
  D,
  distanciaLiquidacion,
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
import { baseLimitPrice, recorridoPeorCaso, scaledLadder, takeProfitPrice } from '../ladder';
import {
  TRAILING_DEFAULTS,
  camposTrailing,
  limpiarTrailing,
  trailingVigente,
  validarTrailing,
  type TrailingConfig,
} from '../trailing-take-profit';
import type { Strategy } from '../types';

/**
 * La escalera de seguridad: lo que comparten la martingala y GridMart. GridMart
 * no hereda el take profit ni el seguimiento, porque sale por el satélite y por
 * la rejilla del núcleo (spec 080, P-7).
 */
export interface EscaleraConfig extends CommonBotConfig {
  numLimitBuys: number;
  initialSeparationPct: string;
  volumeScale: string;
  stepScale: string;
  /** Cómo se abre el ciclo: a mercado (entra ya) o limit al precio actual. */
  baseOrderType?: 'MARKET' | 'LIMIT';
}

export interface MartingaleConfig extends EscaleraConfig, TrailingConfig {
  /**
   * Beneficio al que sale, en % del MARGEN desde el precio medio real del venue
   * (spec 080): a 5×, un 10 % es un 2 % del precio.
   *
   * Con `trailingTakeProfit` encendido este campo NO cambia de unidad ni de
   * sitio: cambia de papel. Deja de ser «el precio al que salgo» y pasa a ser
   * «el precio en el que empiezo a seguir al máximo» (spec 042).
   */
  takeProfitPct: string;
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
    // % del MARGEN desde el spec 080. El tope de siempre, un 50 % del precio,
    // se conserva en precio: `camposEfectivos` lo multiplica por el
    // apalancamiento.
    maxPrecioPct: 50,
    roi: 'BENEFICIO',
    step: 0.05,
    required: true,
    // El 1 % del precio de antes al apalancamiento de fábrica (2×): a 2× el bot
    // sale exactamente donde salía.
    default: 2,
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
  // Un minuto entre ciclos, como `defaults()`: la ficha común dice 0 y la ayuda
  // y el relleno de un campo vacío (`sinVacios`) leían ese 0.
  fields: [
    ...commonFieldsWith([comunCon('cooldownMinutes', { default: 1 })]),
    ...MARTINGALE_FIELDS,
  ],
};

/**
 * Validaciones compartidas con GridMart, que hereda toda la parte de escalera.
 * Aquí es donde se convierte "peor caso" en un número que el usuario ve antes
 * de arrancar, en vez de descubrirlo cuando el bot ya lleva 5 niveles llenos.
 */
/**
 * Por debajo de este movimiento de PRECIO, con una entrada taker y una salida
 * maker, un ciclo cerrado puede acabar en pérdida (spec 026, F-94). Es una
 * distancia de precio y se sigue midiendo así: el objetivo es un % del margen
 * desde el spec 080, y se compara su equivalente en precio (`validarObjetivoRoi`).
 */
export const TP_MINIMO_RENTABLE_PCT = '0.3';

export function validateLadderConfig(
  cfg: EscaleraConfig,
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

  // El take profit NO se valida aquí: GridMart no lo tiene (sale por el TP
  // satélite y la rejilla del núcleo). Cada estrategia valida el suyo.

  // La escalera llenándose en contra, nivel a nivel, con la liquidación EXACTA
  // de la media de lo ya comprado y el stop (un % del margen). Se hace sobre un
  // ancla de 1: todo es relativo. Antes se comparaba la cobertura desde el
  // ancla con `100/L − mmr`, sin contar que la liquidación se mueve con la
  // media ni que el stop puede cortar la escalera antes (079/F-01, F-07).
  //
  // Con el tope de exposición, como el plan: la base sin mirarlo y cada
  // seguridad solo si cabe. El nocional de un nivel no depende del ancla
  // (margen × apalancamiento), así que el tope en USDC vale también aquí.
  const sinErrores = !issues.some((i) => i.severity === 'ERROR');
  if (sinErrores && n >= 1 && sep.gt(0) && step.gte(1)) {
    const lev = Number(cfg.leverage) || 1;
    const lado = cfg.direction === 'SHORT' ? 'SHORT' : 'LONG';
    const mmr = maintenanceMarginRateOf(market);
    const niveles = ladderLevels(cfg, '1');
    const r = recorridoPeorCaso(
      niveles,
      lado,
      lev,
      mmr,
      cfg.stopLossPct,
      cfg.maxNotionalCap ? { nocional: cfg.maxNotionalCap, desde: 1 } : null,
    );
    const aislado = cfg.marginMode !== 'CROSS';
    const hacia = lado === 'SHORT' ? 'subida' : 'caída';
    // En largo, una escalera más profunda que el 100 % pone seguridades a precio
    // cero o negativo. La comparación vieja con `100/L` lo impedía de paso; el
    // recorrido nivel a nivel no, porque a 1× no hay liquidación que lo corte,
    // y editar o arrancar solo pasan por aquí (encontrado al rehacer las guías
    // del 080). Se dice aunque la liquidación o el stop corten antes: esas
    // órdenes se colocarían igual, y el venue las rechazaría.
    const bajoCero = lado === 'LONG' ? niveles.findIndex((l) => !D(l.price).gt(0)) : -1;
    if (bajoCero >= 0) {
      issues.push(
        err(
          'numLimitBuys',
          `La seguridad ${bajoCero} quedaría a un ` +
            `${D(niveles[bajoCero].price).minus(1).abs().mul(100).toFixed(1)} % de caída desde la ` +
            'entrada: a precio cero o negativo. Reduce las seguridades, la separación o la escala ' +
            'de distancia.',
        ),
      );
    }
    if (r.corte && r.corte.por !== 'TOPE') {
      const k = r.corte.nivel;
      const precioCorte = D(niveles[k].price);
      const distancia = precioCorte.minus(1).abs().mul(100).toFixed(1);
      const restantes = `las seguridades ${k} a ${n} no se ejecutarían nunca`;
      if (r.corte.por === 'LIQUIDACION') {
        const mensaje =
          `A ${lev}× la liquidación llega antes que la seguridad ${k}, que está a un ` +
          `${distancia} % de ${hacia} desde la entrada: con la media de lo ya comprado, ` +
          `${restantes}.` +
          (aislado ? '' : ' En margen cruzado la liquidación real queda más lejos.');
        issues.push(aislado ? err('numLimitBuys', mensaje) : warn('numLimitBuys', mensaje));
      } else {
        issues.push(
          warn(
            'stopLossPct',
            `El stop del ${D(cfg.stopLossPct ?? 0).toFixed()} % del margen salta antes que la ` +
              `seguridad ${k}, que está a un ${distancia} % de ${hacia} desde la entrada: ` +
              `${restantes}.`,
          ),
        );
      }
    } else {
      // Entera —o hasta donde deja el tope—, pero corta: el último nivel queda
      // a menos de la mitad del camino hasta la liquidación, y por debajo el
      // bot deja de promediar.
      const ultimo = r.corte ? r.corte.nivel - 1 : niveles.length - 1;
      const cobertura = D(niveles[ultimo].price).minus(1).abs().mul(100);
      const hastaLiq = distanciaLiquidacion(lev, mmr, lado).mul(100);
      if (ultimo === 0) {
        issues.push(
          warn(
            'maxNotionalCap',
            'Con este tope de exposición no cabe ninguna seguridad: el bot abre la base y no ' +
              'promedia.',
          ),
        );
      } else if (cobertura.lt(hastaLiq.div(2))) {
        issues.push(
          warn(
            'numLimitBuys',
            (r.corte
              ? `Con el tope de exposición la escalera se queda en la seguridad ${ultimo}: ` +
                `solo cubre un ${cobertura.toFixed(1)} % de ${hacia}.`
              : `La escalera solo cubre un ${cobertura.toFixed(1)} % de ${hacia}.`) +
              ' Más allá el bot deja de promediar.',
          ),
        );
      }
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

/**
 * La escalera, su take profit y su seguimiento. `validateLadderConfig` la
 * comparte GridMart, que NO tiene take profit ni seguimiento: esos dos van aquí
 * para no colarle campos que no usa.
 */
function validarMartingala(cfg: MartingaleConfig, market: MarketSpec) {
  return [
    ...validateLadderConfig(cfg, market),
    ...validarObjetivoRoi(
      'takeProfitPct',
      'El take profit',
      cfg.takeProfitPct,
      Number(cfg.leverage) || 1,
      cfg.direction,
      TP_MINIMO_RENTABLE_PCT,
    ),
    ...validarTrailing(cfg),
  ];
}

/** Niveles crudos de la escalera; los comparte GridMart tal cual. */
export function ladderLevels(cfg: EscaleraConfig, anchor: string): RawLevel[] {
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
      // % del margen (spec 080): el 1 % del precio de antes, a 2×.
      takeProfitPct: '2',
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
    return toResult(validarMartingala(cfg, market));
  },

  preview(cfg: MartingaleConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const issues = validarMartingala(cfg, market);
    // Ver `invalidPreview`: sin config valida, calcular es reventar.
    if (issues.some((i) => i.severity === 'ERROR')) return invalidPreview(issues);
    return buildPreview({
      levels: ladderLevels(cfg, refPrice),
      market,
      refPrice,
      direction: cfg.direction,
      leverage: cfg.leverage,
      marginMode: cfg.marginMode,
      // Con el seguimiento encendido el objetivo es donde EMPIEZA a seguir, y la
      // Revisión lo dice (079/F-15).
      objetivo: { roiPct: cfg.takeProfitPct, activacion: cfg.trailingTakeProfit === true },
      stopLossRoiPct: cfg.stopLossPct,
      // El tope de exposición corta la escalera como en `plan()`: la base entra
      // sin mirarlo y cada seguridad solo si cabe.
      topeNocional: cfg.maxNotionalCap,
      topeDesde: 1,
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
    // Un % del MARGEN desde la media (spec 080).
    const tp = takeProfitPrice(avgEntry, cfg.takeProfitPct, cfg.leverage, cfg.direction);
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
