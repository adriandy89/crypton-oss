/**
 * Seguimiento de beneficio: entra una vez, deja correr y sale al retroceder.
 *
 * Es la tarjeta que el usuario pidió con sus palabras: «pongo 15 % y 1 %, y me
 * olvido». Una operación, un objetivo a partir del cual el bot deja de mirar un
 * precio fijo y empieza a seguir al máximo, y un retroceso que decide cuándo
 * cierra.
 *
 * El mecanismo es el del spec 042 y no se reimplementa nada: `trailingVigente()`
 * decide dónde va el disparador, el `intent` explícito hace que el venue lo arme
 * hacia abajo —un take profit que sigue al precio es, mecánicamente, un stop— y
 * la marca de agua del runner hace que un pico entre dos revisiones cuente.
 *
 * Tres decisiones que la definen:
 *
 * 1. **No hay campo de tamaño.** El nocional sale del capital asignado por el
 *    apalancamiento, acotado por el saldo y por el tope de exposición. Un tercer
 *    sitio donde decir cuánto dinero se pone es un sitio donde equivocarse.
 * 2. **El seguimiento no se puede apagar**: es lo único que hace. Un interruptor
 *    para desactivarlo la dejaría sin identidad, y para salir en un precio fijo
 *    ya están casi todas las demás.
 * 3. **Vuelve a entrar.** Al cerrarse la posición se cierra el ciclo y, pasada
 *    la espera, abre otra. Es un bot, no una operación suelta, y eso se dice en
 *    la guía y en la nota del plan (spec 043).
 */
import {
  ActivationMode,
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
  type ValidationIssue,
  type ValidationResult,
} from '@crypton/shared';
import { makeCoid } from '../client-order-id';
import {
  buildPreview,
  comunCon,
  commonFieldsWith,
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
import {
  TRAILING_DEFAULTS,
  TRAILING_KNOBS_DEFAULTS,
  camposTrailing,
  trailingVigente,
  validarTrailing,
  type TrailingConfig,
} from '../trailing-take-profit';
import type { Strategy } from '../types';
import { activationGate } from './mm-shared';

export interface TrailingProfitConfig extends CommonBotConfig, TrailingConfig {
  /**
   * Beneficio al que EMPIEZA a seguir al máximo, sobre el precio de entrada.
   *
   * No es el precio al que sale: es el precio a partir del cual la salida deja
   * de ser fija. Lo que cobra es, como mínimo,
   * `entrada × (1 + objetivo) × (1 − retroceso)`.
   */
  takeProfitPct: string;
  /** Cuándo entra: ya, o al cruzar un precio. Las mismas claves que el MM V2. */
  activationMode?: ActivationMode;
  activationPrice?: string | null;
}

const TRAILING_PROFIT_FIELDS: readonly FieldMeta[] = [
  {
    key: 'activationMode',
    kind: 'enum',
    mutability: Mutability.HOT,
    labelKey: 'strategy.trailing.activationMode',
    helpKey: 'strategy.trailing.activationModeHelp',
    options: [ActivationMode.NONE, ActivationMode.PRICE_ABOVE, ActivationMode.PRICE_BELOW],
    required: false,
    default: ActivationMode.NONE,
    group: 'core',
    control: 'segment',
  },
  {
    key: 'activationPrice',
    kind: 'price',
    mutability: Mutability.HOT,
    labelKey: 'strategy.trailing.activationPrice',
    helpKey: 'strategy.trailing.activationPriceHelp',
    min: 0,
    required: false,
    group: 'core',
  },
  {
    key: 'takeProfitPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'strategy.trailing.takeProfitPct',
    helpKey: 'strategy.trailing.takeProfitPctHelp',
    min: 0.1,
    max: 500,
    step: 0.1,
    required: true,
    default: 15,
    group: 'levels',
  },
  // Los dos del mecanismo, SIN el interruptor: aquí el seguimiento no se apaga.
  ...camposTrailing('trailing', { conInterruptor: false }),
] as const;

/**
 * Dos comunes con otro valor de partida, y el formulario lo enseña así.
 *
 * `stopLossPct` porque por debajo del objetivo el seguimiento no protege nada y
 * esa ventana es TODA la operación hasta que llega: es la única estrategia que
 * nace con stop puesto. `cooldownMinutes` porque al cerrarse la posición el bot
 * VUELVE A ENTRAR, y con cero encadenaría operaciones en el mismo minuto.
 *
 * Se cambian aquí y no solo en `defaults()` para que el número que el usuario
 * ve en la casilla sea el que el bot va a usar (spec 043 R-5 y R-7).
 */
const COMUNES = commonFieldsWith([
  comunCon('stopLossPct', { default: 5 }),
  comunCon('cooldownMinutes', { default: 60 }),
]);

const META: StrategyMeta = {
  kind: StrategyKind.TRAILING_PROFIT,
  labelKey: 'strategy.trailing.label',
  descriptionKey: 'strategy.trailing.description',
  fields: [...COMUNES, ...TRAILING_PROFIT_FIELDS],
};

/**
 * Nocional máximo de la operación.
 *
 * El menor de tres: lo que el usuario asignó, lo que el margen aguanta ahora
 * mismo y el tope de exposición si lo puso. El mismo cálculo que la estrategia
 * de tendencia hace desde el spec 041, por la misma razón: pedir más margen del
 * que hay es una orden rechazada, o un apalancamiento que nadie pidió.
 */
function techoNocional(cfg: TrailingProfitConfig, availableBalance: string): Decimal {
  const lev = Decimal.max(D(1), D(cfg.leverage ?? 1));
  const topes = [D(cfg.totalInvestment ?? 0).mul(lev), D(availableBalance ?? 0).mul(lev)];
  const cap = D(cfg.maxNotionalCap ?? 0);
  if (cap.gt(0)) topes.push(cap);
  return topes.reduce((a, b) => (b.lt(a) ? b : a));
}

/** La config tal y como la ve el mecanismo del 042: aquí siempre encendido. */
const conSeguimiento = (cfg: TrailingProfitConfig): TrailingConfig => ({
  ...cfg,
  trailingTakeProfit: true,
});

export const trailingProfit: Strategy<TrailingProfitConfig> = {
  kind: StrategyKind.TRAILING_PROFIT,
  meta: META,

  // NO se declara `reusesOrderSlots`, y es deliberado.
  //
  // Esa bandera autoriza al motor a recolocar un `clientOrderId` que YA se
  // ejecutó. Un market maker la necesita —«ejecutada» significa que el hueco de
  // la cotización quedó libre—; aquí sería una SEGUNDA entrada a mercado,
  // porque la condición de entrada sigue siendo cierta mientras la posición
  // tarda en aparecer en `getPositions()`. Es la Crítica del spec 041, y no se
  // pierde nada: al cerrarse la posición sube `cycleSeq` y los ids son otros.

  defaults() {
    return {
      direction: 'LONG',
      leverage: 2,
      marginMode: 'ISOLATED',
      activationMode: ActivationMode.NONE,
      takeProfitPct: '15',
      // Los dos mandos, SIN el interruptor: aquí el seguimiento no se puede
      // apagar, así que el campo no está en `meta.fields` — y `diffConfig` trata
      // como COLD todo campo que la estrategia no declare. Dejarlo en la
      // configuración era una trampa cargada: un cliente que la reconstruyera
      // desde la meta haría que se rechazara la edición de un bot en marcha por
      // un campo que el usuario no puede ni ver (spec 044 R-4). Nadie lo lee:
      // `plan()` llama al mecanismo siempre y `validate()` lo fuerza con
      // `conSeguimiento()`.
      ...TRAILING_KNOBS_DEFAULTS,
      // Con stop DE FÁBRICA, y es la única estrategia en la que se hace.
      //
      // Por debajo del objetivo el seguimiento no protege nada —no hay nada que
      // asegurar todavía— y esa ventana es TODA la operación hasta que llega.
      // Dejarla sin red sería vender la parte bonita y callar la otra.
      stopLossPct: '5',
      // Una hora, para que no encadene operaciones en el mismo minuto: al
      // cerrarse la posición se cierra el ciclo y el bot vuelve a entrar.
      cooldownMinutes: 60,
    };
  },

  validate(cfg: TrailingProfitConfig, market: MarketSpec): ValidationResult {
    const issues: ValidationIssue[] = validateCommon(cfg, market);

    const tp = D(cfg.takeProfitPct ?? 0);
    if (!tp.isFinite() || tp.lte(0)) {
      issues.push(err('takeProfitPct', 'El objetivo tiene que ser mayor que cero.'));
    }

    issues.push(...validarTrailing(conSeguimiento(cfg)));

    if (cfg.activationMode && cfg.activationMode !== ActivationMode.NONE) {
      const trigger = cfg.activationPrice ? D(cfg.activationPrice) : null;
      if (trigger == null || !trigger.isFinite() || trigger.lte(0)) {
        issues.push(
          err('activationPrice', 'Con una condición de entrada hace falta un precio de disparo.'),
        );
      }
    }

    // Sin stop, esta estrategia no tiene NADA hasta que llega al objetivo. En
    // las demás el aviso sería ruido; aquí es el riesgo principal.
    if (cfg.stopLossPct == null || D(cfg.stopLossPct).lte(0)) {
      issues.push(
        warn(
          'stopLossPct',
          'Sin stop loss, esta estrategia no tiene ninguna protección hasta que el precio llegue ' +
            'al objetivo: el seguimiento solo existe a partir de ahí.',
        ),
      );
    }

    // El suelo de lo que se cobra, en el propio formulario: es el número que
    // más gente se lleva de sorpresa.
    const cb = D(cfg.trailingCallbackPct ?? TRAILING_DEFAULTS.trailingCallbackPct);
    if (tp.gt(0) && cb.gt(0) && cb.gte(tp)) {
      issues.push(
        warn(
          'trailingCallbackPct',
          'Con un retroceso igual o mayor que el objetivo, el disparador nace por debajo del ' +
            'precio de entrada: la operación puede cerrarse en pérdida nada más activarse.',
        ),
      );
    }

    return toResult(issues);
  },

  preview(cfg: TrailingProfitConfig, market: MarketSpec, refPrice: string): PreviewResult {
    const validacion = this.validate(cfg, market);
    if (!validacion.ok) return invalidPreview(validacion.issues);

    // El precio al que va a ENTRAR, que no tiene por qué ser el de hoy: con una
    // condición de entrada, el bot espera a que la marca cruce `activationPrice`
    // y abre allí. Dimensionar y calcular el objetivo sobre el precio de hoy
    // daba cuatro números mal —entrada, cantidad, objetivo y liquidación— en la
    // pantalla donde el usuario decide comprometer dinero (spec 044 R-3).
    //
    // `refPrice` se sigue pasando a `buildPreview` como referencia de MERCADO,
    // así que «distancia al precio actual» y «distancia a liquidación» se siguen
    // midiendo contra hoy, que es lo correcto.
    const disparo = cfg.activationPrice ? D(cfg.activationPrice) : null;
    const condicionada =
      cfg.activationMode != null &&
      cfg.activationMode !== ActivationMode.NONE &&
      disparo != null &&
      disparo.isFinite() &&
      disparo.gt(0);
    const precio = condicionada && disparo ? disparo : D(refPrice);

    // Sin `availableBalance` —no existe antes de crear el bot— se usa solo la
    // parte del techo que sale de la configuración, igual que en tendencia.
    const techo = techoNocional(cfg, String(cfg.totalInvestment ?? 0));
    const qty = precio.gt(0) ? techo.div(precio) : D(0);
    const activacion = takeProfitPrice(precio, cfg.takeProfitPct, cfg.direction);
    const cb = D(cfg.trailingCallbackPct ?? TRAILING_DEFAULTS.trailingCallbackPct).div(100);
    const largo = cfg.direction !== 'SHORT';
    const suelo = activacion.mul(largo ? D(1).minus(cb) : D(1).plus(cb));

    const levels: RawLevel[] = [
      {
        index: 0,
        kind: LevelKind.BASE,
        side: entrySide(cfg.direction),
        price: precio,
        qty,
        margin: D(cfg.leverage ?? 1).gt(0) ? techo.div(D(cfg.leverage ?? 1)) : techo,
        isEntry: true,
      },
    ];

    return buildPreview({
      levels,
      market,
      refPrice,
      direction: cfg.direction,
      leverage: cfg.leverage,
      marginMode: cfg.marginMode,
      // El objetivo se pinta como take profit porque es donde EMPIEZA a seguir,
      // y el aviso de abajo explica que lo que se cobra no es exactamente eso.
      takeProfitPct: cfg.takeProfitPct,
      issues: [
        ...validacion.issues,
        warn(
          null,
          (condicionada
            ? `Calculado sobre el precio de entrada (${precio.toFixed(market.priceDecimals)}), ` +
              'no sobre el de ahora: el bot espera a que la marca lo cruce. '
            : '') +
            `El objetivo de ${activacion.toFixed(market.priceDecimals)} no es el precio al que ` +
            'sale: es donde empieza a seguir al máximo. Lo mínimo que cobra es ' +
            `${suelo.toFixed(market.priceDecimals)}, y puede ser mucho más si el precio sigue.`,
        ),
      ],
    });
  },

  plan(ctx: BotContext): DesiredState {
    const cfg = ctx.config as unknown as TrailingProfitConfig;
    const seq = Number(ctx.cycle.scratch['cycleSeq'] ?? 0);
    const mark = D(ctx.ticker.mark);
    const pos = positionSize(ctx);

    // ── Con posición: solo la salida, que sigue al máximo ─────────────
    if (pos.gt(0) && ctx.position) {
      const activacion = takeProfitPrice(ctx.position.entryPrice, cfg.takeProfitPct, cfg.direction);
      const t = trailingVigente({
        scratch: ctx.cycle.scratch,
        extremos: ctx.extremos,
        mark,
        activacion,
        direction: cfg.direction,
        callbackPct: cfg.trailingCallbackPct ?? TRAILING_DEFAULTS.trailingCallbackPct,
        repriceBps: cfg.trailingRepriceBps ?? TRAILING_DEFAULTS.trailingRepriceBps,
        now: ctx.now,
      });

      const orders: DesiredOrder[] = [];
      if (t.disparo) {
        const salida = exitSide(cfg.direction);
        const precio = px(ctx.market, t.disparo, salida);
        orders.push({
          clientOrderId: makeCoid(ctx.botId, seq, LevelKind.TAKE_PROFIT, 0),
          levelKind: LevelKind.TAKE_PROFIT,
          levelIndex: 0,
          side: salida,
          type: 'MARKET',
          price: precio,
          triggerPrice: precio,
          // Take profit en la contabilidad, stop en el disparo (spec 042 R-1).
          intent: 'SL',
          qty: qy(ctx.market, pos),
          reduceOnly: true,
        });
      }

      // El STOP_LOSS lo añade el motor, igual para todas. Ver `withStopLoss`.
      return {
        orders,
        immediate: [],
        note: 'Operación abierta. ' + t.nota,
        scratchPatch: Object.keys(t.patch).length ? t.patch : undefined,
      };
    }

    // ── Plana: ¿toca abrir? ───────────────────────────────────────────
    const espera = ctx.cycle.cooldownUntil ?? 0;
    if (espera > ctx.now) {
      const s = Math.ceil((espera - ctx.now) / 1000);
      return {
        orders: [],
        immediate: [],
        note: `Operación cerrada; faltan ${s} s de espera para volver a entrar.`,
      };
    }

    // La misma puerta que el market maker V2, con la misma clave de scratch: se
    // arma una vez por ciclo y no se desarma. Aquí eso significa que un precio
    // que cruza y vuelve no deja al bot fuera para siempre.
    const puerta = activationGate(cfg, ctx.cycle.scratch, mark, ctx.now);
    if (!puerta.armed) {
      return {
        orders: [],
        immediate: [],
        note: puerta.note ?? 'Esperando la condición de entrada.',
        ...(puerta.patch ? { scratchPatch: puerta.patch } : {}),
      };
    }

    const lado = entrySide(cfg.direction);
    const precio = px(ctx.market, mark, lado);
    const techo = techoNocional(cfg, ctx.availableBalance);
    const qty = D(precio).gt(0) ? techo.div(D(precio)) : D(0);
    if (!qty.gt(0)) {
      return {
        orders: [],
        immediate: [],
        note: 'Sin margen disponible para abrir la operación.',
        ...(puerta.patch ? { scratchPatch: puerta.patch } : {}),
      };
    }

    return {
      orders: [
        {
          clientOrderId: makeCoid(ctx.botId, seq, LevelKind.BASE, 0),
          levelKind: LevelKind.BASE,
          levelIndex: 0,
          side: lado,
          type: 'MARKET',
          price: precio,
          qty: qy(ctx.market, qty),
          reduceOnly: false,
        },
      ],
      immediate: [],
      note:
        `Abriendo ${cfg.direction === 'SHORT' ? 'corto' : 'largo'} a mercado. ` +
        `Empezará a seguir al máximo con un ${D(cfg.takeProfitPct).toFixed()} % de beneficio.`,
      ...(puerta.patch ? { scratchPatch: puerta.patch } : {}),
    };
  },
};
