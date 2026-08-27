/**
 * Piezas comunes a las dos estrategias de market making.
 *
 * Todo lo de aquí es PURO, como el resto de `strategy-core`: las funciones que
 * necesitan memoria entre ticks no la guardan, la reciben en `scratch` y
 * devuelven el parche que el motor debe fusionar. Es lo que permite que
 * `plan()` siga siendo testeable sin levantar nada.
 */
import {
  ActivationMode,
  D,
  Decimal,
  LimitAction,
  SizingMode,
  type BotContext,
  type CommonBotConfig,
  type Numeric,
  type Ticker,
  type VenueOrder,
} from '@crypton/shared';

export const BPS = D(10_000);

/**
 * El perfil de riesgo no es un parámetro más: coordina diferencial y tamaño de
 * golpe, que es justo lo que un usuario nuevo no sabe equilibrar por su cuenta.
 */
export const PROFILE = {
  CONSERVATIVE: { distance: D(1.5), size: D(0.7) },
  BALANCED: { distance: D(1), size: D(1) },
  AGGRESSIVE: { distance: D(0.7), size: D(1.3) },
} as const;

export type RiskProfileKey = keyof typeof PROFILE;

export const profileOf = (key: string | undefined | null) =>
  PROFILE[(key as RiskProfileKey) ?? 'BALANCED'] ?? PROFILE.BALANCED;

// ── Precio de referencia ──────────────────────────────────────────────────

/** Mid del libro; cae al precio de marca si el venue no publica BBO. */
export function bookMid(ticker: Ticker): Decimal {
  const bid = D(ticker.bid);
  const ask = D(ticker.ask);
  return bid.gt(0) && ask.gt(0) ? bid.plus(ask).div(2) : D(ticker.mark);
}

/** Anchura del libro en bps. 0 si el venue no publica los dos lados. */
export function bookSpreadBps(ticker: Ticker): Decimal {
  const bid = D(ticker.bid);
  const ask = D(ticker.ask);
  if (!bid.gt(0) || !ask.gt(0)) return D(0);
  const mid = bid.plus(ask).div(2);
  return mid.gt(0) ? ask.minus(bid).div(mid).mul(BPS) : D(0);
}

// ── Inventario ────────────────────────────────────────────────────────────

export interface Inventory {
  /** Cantidad firmada: + long, − short. */
  qty: Decimal;
  /** Exposición firmada en la quote. */
  exposure: Decimal;
  /** Exposición relativa al tope, acotada a [−1, 1]. */
  ratio: Decimal;
  /** `|ratio|` en %, que es como se configuran los umbrales. */
  loadPct: Decimal;
}

export function inventoryOf(ctx: BotContext, mid: Decimal, maxPositionValue: Numeric): Inventory {
  const qty = ctx.position ? D(ctx.position.qty) : D(0);
  const exposure = qty.mul(mid);
  const maxPos = D(maxPositionValue ?? 0);
  const ratio = maxPos.gt(0)
    ? Decimal.max(D(-1), Decimal.min(D(1), exposure.div(maxPos)))
    : D(0);
  return { qty, exposure, ratio, loadPct: ratio.abs().mul(100) };
}

/**
 * Régimen de riesgo según cuán lleno está el inventario.
 *
 * No es cosmético: en `HIGH_RISK` el bot deja de cotizar el lado que añade y
 * solo mantiene la salida, que es la diferencia entre recoger diferencial y
 * quedarse atrapado del lado equivocado de una tendencia.
 */
export type RiskRegime = 'NORMAL' | 'DEFENSIVE' | 'HIGH_RISK';

export function riskRegime(
  loadPct: Decimal,
  defensivePct: Numeric | undefined | null,
  highRiskPct: Numeric | undefined | null,
): RiskRegime {
  const high = D(highRiskPct ?? 0);
  if (high.gt(0) && loadPct.gte(high)) return 'HIGH_RISK';
  const defensive = D(defensivePct ?? 0);
  if (defensive.gt(0) && loadPct.gte(defensive)) return 'DEFENSIVE';
  return 'NORMAL';
}

/**
 * Multiplicadores de distancia por régimen. En defensivo el lado que añade se
 * aleja y el que reduce se acerca: las dos mitades empujan hacia deshacer
 * inventario, en vez de solo una.
 */
export const REGIME_DISTANCE = {
  NORMAL: { adding: D(1), reducing: D(1) },
  DEFENSIVE: { adding: D(1.5), reducing: D(0.6) },
  HIGH_RISK: { adding: D(0), reducing: D(0.5) },
} as const;

// ── Bandas de precio ──────────────────────────────────────────────────────

export interface PriceBand {
  /** true = no abrir posición larga nueva (precio por encima del techo). */
  blockBuy: boolean;
  /** true = no abrir posición corta nueva (precio por debajo del piso). */
  blockSell: boolean;
}

/**
 * «No operar por debajo de / por encima de».
 *
 * Bloquea SOLO el lado que abre posición: fuera de la banda el bot sigue
 * pudiendo reducir. Cortar los dos lados dejaría al usuario atrapado con
 * inventario y sin nadie que lo deshaga, que es lo contrario de una guarda.
 */
export function priceBand(cfg: CommonBotConfig, mid: Decimal): PriceBand {
  const floor = cfg.priceFloor ? D(cfg.priceFloor) : null;
  const ceiling = cfg.priceCeiling ? D(cfg.priceCeiling) : null;
  return {
    blockBuy: ceiling != null && ceiling.gt(0) && mid.gt(ceiling),
    blockSell: floor != null && floor.gt(0) && mid.lt(floor),
  };
}

// ── Tamaños ───────────────────────────────────────────────────────────────

/**
 * Cantidad a colocar a partir del tamaño configurado.
 *
 * Con `sizingMode: BASE` el usuario teclea moneda y el número ya ES la
 * cantidad; con `QUOTE` teclea USDC y hay que dividir por el precio. El
 * nocional se devuelve aparte porque es lo que consumen los topes.
 */
export function sizeToQty(
  sizingMode: SizingMode | undefined,
  size: Decimal,
  price: Decimal,
): { qty: Decimal; notional: Decimal } {
  if (!price.gt(0)) return { qty: D(0), notional: D(0) };
  if (sizingMode === SizingMode.BASE) return { qty: size, notional: size.mul(price) };
  return { qty: size.div(price), notional: size };
}

// ── Edad de las órdenes vivas ─────────────────────────────────────────────

/**
 * `clientOrderId → epoch ms de colocación`, leído de las órdenes reales.
 *
 * Es lo que permite implementar «actualizar órdenes después de N segundos» y el
 * TTL de las órdenes de salida sin que el motor tenga que llevar la cuenta:
 * `VenueOrder.createdAt` ya viene normalizado en los tres adaptadores.
 */
export function orderAges(openOrders: readonly VenueOrder[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of openOrders) {
    if (o.clientOrderId) out.set(o.clientOrderId, o.createdAt);
  }
  return out;
}

export function isOlderThan(
  ages: Map<string, number>,
  coid: string,
  now: number,
  seconds: number | undefined | null,
): boolean {
  const ttl = Math.floor(seconds ?? 0);
  if (ttl <= 0) return false;
  const placedAt = ages.get(coid);
  if (placedAt == null) return false;
  return now - placedAt >= ttl * 1000;
}

/** Qué lado añade inventario y cuál lo reduce. */
export interface SideRoles {
  buy: 'adding' | 'reducing';
  sell: 'adding' | 'reducing';
}

/**
 * Roles de cada lado, a partir del SIGNO de la posición.
 *
 * Se calcula del signo y no de la exposición valorada porque hace falta antes
 * de saber a qué precio se va a cotizar: la caducidad de las órdenes depende de
 * qué lado es la salida, y esa decisión no puede esperar al precio.
 *
 * Con la posición plana ningún lado reduce nada, así que los dos se tratan como
 * normales.
 */
export function sideRoles(qty: Decimal): SideRoles {
  if (qty.gt(0)) return { buy: 'adding', sell: 'reducing' };
  if (qty.lt(0)) return { buy: 'reducing', sell: 'adding' };
  return { buy: 'adding', sell: 'adding' };
}

/**
 * Cotizaciones vivas que han caducado y hay que rehacer.
 *
 * Devuelve el conjunto de ids que este tick NO debe desear: el reconciliador
 * los cancela y el tick siguiente los repone al precio de entonces.
 *
 * **Por qué el mismo conjunto tiene que decidir también si se recotiza.** Si la
 * caducidad solo forzara una recotización, con el precio quieto el plan volvería
 * a pedir EXACTAMENTE los mismos precios, el diff los contaría como
 * `unchanged`, las órdenes no se tocarían, su antigüedad no se renovaría y el
 * bot se quedaría recotizando en cada tick para siempre —escribiendo el scratch
 * en la base cada quince segundos sin cambiar una sola orden—. Cancelar es lo
 * único que renueva el reloj, así que caducar y recotizar van juntos.
 */
export function expiredQuotes(opts: {
  ages: Map<string, number>;
  now: number;
  layers: number;
  coidFor: (kind: 'QUOTE_BID' | 'QUOTE_ASK', layer: number) => string;
  roles: SideRoles;
  /** Edad máxima de CUALQUIER cotización. */
  maxAgeSeconds?: number | null;
  /** Edad máxima de las órdenes del lado que reduce. */
  exitTtlSeconds?: number | null;
}): Set<string> {
  const out = new Set<string>();
  const { ages, now, layers, coidFor, roles } = opts;

  for (let l = 0; l < layers; l++) {
    const bid = coidFor('QUOTE_BID', l);
    const ask = coidFor('QUOTE_ASK', l);

    if (isOlderThan(ages, bid, now, opts.maxAgeSeconds)) out.add(bid);
    if (isOlderThan(ages, ask, now, opts.maxAgeSeconds)) out.add(ask);

    // El TTL de salida solo aplica al lado que deshace inventario: una orden de
    // salida vieja está a un precio que el mercado ya dejó atrás.
    if (roles.buy === 'reducing' && isOlderThan(ages, bid, now, opts.exitTtlSeconds)) {
      out.add(bid);
    }
    if (roles.sell === 'reducing' && isOlderThan(ages, ask, now, opts.exitTtlSeconds)) {
      out.add(ask);
    }
  }
  return out;
}

// ── Muestra de volatilidad ────────────────────────────────────────────────

/** Una muestra `[epoch ms, mid]`. Tupla y no objeto: va a JSON en cada tick. */
export type VolSample = readonly [number, string];

/** Tope duro de muestras: con ventanas largas y ticks rápidos el JSON crece. */
export const MAX_VOL_SAMPLES = 240;

export interface VolatilityRead {
  /** Recorrido del precio en la ventana, en bps. */
  volBps: Decimal;
  /**
   * El anillo resultante, o `null` si no hay nada que guardar.
   *
   * Null cuando no se ha añadido muestra: devolver el anillo igual obligaría a
   * la estrategia a escribirlo en `scratchPatch`, y eso es un UPDATE en la base
   * por cada tick de cada bot. Con mil market makers latiendo cada quince
   * segundos son sesenta y siete escrituras por segundo para no cambiar nada.
   */
  samples: VolSample[] | null;
}

/**
 * Volatilidad realizada como **recorrido** del mid en la ventana, en bps.
 *
 * Se eligió el recorrido `(max − min) / media` y no la desviación de retornos
 * por dos motivos: sale directamente en bps —la unidad en la que se configura
 * todo lo demás— y no depende de que las muestras estén equiespaciadas, cosa
 * que aquí no se cumple (un fill dispara un tick inmediato).
 *
 * Las muestras se guardan en `cycle.scratch` en vez de en velas porque Lighter
 * no tiene stream de velas: así el bloque funciona igual en los tres venues.
 */
export function sampleVolatility(
  scratch: Record<string, unknown>,
  now: number,
  mid: Decimal,
  windowSeconds: number | undefined | null,
  record: boolean,
): VolatilityRead {
  const window = Math.max(1, Math.floor(windowSeconds ?? 300)) * 1000;
  const raw = Array.isArray(scratch['volSamples']) ? (scratch['volSamples'] as VolSample[]) : [];

  const kept = raw.filter(
    (s) => Array.isArray(s) && s.length === 2 && now - Number(s[0]) <= window,
  );
  // La muestra solo se AÑADE cuando se va a recotizar. El diferencial únicamente
  // se aplica en ese momento —entre recotizaciones las órdenes no se mueven—,
  // así que muestrear en cada tick daría una estimación más fina de un número
  // que nadie va a usar, a cambio de una escritura en la base por tick.
  if (record) kept.push([now, mid.toString()]);
  const trimmed =
    kept.length > MAX_VOL_SAMPLES ? kept.slice(kept.length - MAX_VOL_SAMPLES) : kept;
  const samples = record ? trimmed : null;

  if (trimmed.length < 2) return { volBps: D(0), samples };

  let min = D(trimmed[0][1]);
  let max = min;
  let sum = D(0);
  for (const [, px] of trimmed) {
    const v = D(px);
    if (v.lt(min)) min = v;
    if (v.gt(max)) max = v;
    sum = sum.plus(v);
  }
  const mean = sum.div(trimmed.length);
  const volBps = mean.gt(0) ? max.minus(min).div(mean).mul(BPS) : D(0);
  return { volBps, samples };
}

// ── Condición de activación ───────────────────────────────────────────────

export interface ActivationConfig {
  activationMode?: ActivationMode;
  activationPrice?: string | null;
}

export interface ActivationGate {
  armed: boolean;
  /** Solo cuando el bot acaba de armarse; se fusiona en el scratch. */
  patch?: Record<string, unknown>;
  /** Qué mostrar en la app mientras espera. */
  note?: string;
}

/**
 * «Condición de activación»: el bot no cotiza hasta que el precio cruza el
 * disparador.
 *
 * Una vez armado se queda armado —`armedAt` en el scratch—, para que un
 * retroceso del precio no vuelva a apagar un bot que ya tiene inventario.
 */
export function activationGate(
  cfg: ActivationConfig,
  scratch: Record<string, unknown>,
  mid: Decimal,
  now: number,
): ActivationGate {
  const mode = cfg.activationMode ?? ActivationMode.NONE;
  if (mode === ActivationMode.NONE) return { armed: true };
  if (scratch['armedAt'] != null) return { armed: true };

  const trigger = cfg.activationPrice ? D(cfg.activationPrice) : null;
  if (trigger == null || !trigger.isFinite() || trigger.lte(0)) return { armed: true };

  const crossed =
    mode === ActivationMode.PRICE_ABOVE ? mid.gte(trigger) : mid.lte(trigger);

  if (!crossed) {
    const dir = mode === ActivationMode.PRICE_ABOVE ? 'suba a' : 'baje a';
    return {
      armed: false,
      note: 'Esperando a que el precio ' + dir + ' ' + trigger.toString() + '.',
    };
  }
  return { armed: true, patch: { armedAt: now } };
}

// ── Acción al alcanzar el límite ──────────────────────────────────────────

export interface LimitBreach {
  /** true = no colocar entradas nuevas. Siempre cierto si se ha tocado el tope. */
  pauseEntries: boolean;
  /** true = además hay que cerrar la posición a mercado, una sola vez. */
  flatten: boolean;
  /** true = tras cerrar, el motor debe parar el bot. */
  shutdown: boolean;
  note: string | null;
}

/**
 * Traduce `limitAction` a decisiones concretas cuando el inventario toca el tope.
 *
 * `flatten` se dispara UNA vez por ciclo: el motor veta reenviar una inmediata
 * cuyo `clientOrderId` ya se ejecutó, pero marcar el instante en el scratch
 * evita incluso intentarlo en cada tick.
 */
export function limitBreach(
  cfg: CommonBotConfig,
  atCap: boolean,
  scratch: Record<string, unknown>,
): LimitBreach {
  if (!atCap) return { pauseEntries: false, flatten: false, shutdown: false, note: null };

  const action = cfg.limitAction ?? LimitAction.PAUSE_ENTRIES;
  const alreadyFired = scratch['limitActionFiredAt'] != null;

  if (action === LimitAction.PAUSE_ENTRIES) {
    return {
      pauseEntries: true,
      flatten: false,
      shutdown: false,
      note: 'Tope de posición alcanzado: entradas en pausa.',
    };
  }

  return {
    pauseEntries: true,
    flatten: !alreadyFired,
    shutdown: action === LimitAction.SHUTDOWN,
    note:
      action === LimitAction.SHUTDOWN
        ? 'Tope de posición alcanzado: cerrando y apagando.'
        : 'Tope de posición alcanzado: cerrando la posición.',
  };
}
