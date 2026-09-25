import type { Direction, MarginMode, PositionSide } from './enums';
import type { NivelApalancamiento } from './ia-canal';
import { D, Decimal, type Numeric } from './money';

/**
 * Tasa de margen de mantenimiento cuando el mercado no la declara NI se conoce
 * su apalancamiento máximo. Es el último recurso de `maintenanceMarginRateOf`:
 * 0,5 % es lo habitual en los tramos bajos de los perps que soportamos, y los
 * tramos altos son peores, así que por sí sola es OPTIMISTA.
 */
export const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005;

/**
 * El lado cuya liquidación manda para una dirección configurada.
 *
 * NEUTRAL puede acabar en cualquiera de los dos, y el corto es siempre el más
 * estrecho —`(1/L − mmr)/(1 + mmr)` frente a `(1/L − mmr)/(1 − mmr)`—, así que
 * una regla que tenga que valer para los dos se mide contra él.
 */
export function ladoMasEstrecho(direction: Direction): PositionSide {
  return direction === 'LONG' ? 'LONG' : 'SHORT';
}

/** Cuánto le falta a una posición VIVA para liquidarse, desde el precio de ahora, en %. Siempre ≥ 0. */
export function liquidationDistancePct(currentPrice: Numeric, liquidationPrice: Numeric): Decimal {
  const cur = D(currentPrice);
  if (cur.lte(0)) return D(0);
  return D(liquidationPrice).minus(cur).div(cur).mul(100).abs();
}

/**
 * Cuánto puede moverse el precio desde el de referencia, EN CONTRA, antes de la
 * liquidación más cercana de una previsualización, en % (spec 080): un largo
 * mira hacia abajo y un corto hacia arriba, cada uno con su posición llena
 * hasta donde llega el recorrido del peor caso. Lleva signo: uno negativo sería
 * una liquidación del lado del beneficio, que la fórmula exacta no da. null si
 * ningún lado se liquida (un largo a 1×).
 *
 * Sustituye al «aguanta un movimiento de» que medía con valor absoluto y no
 * decía de qué lado quedaba la liquidación (079/F-07).
 */
export function distanciaDesdeHoyALiquidacion(
  sides: readonly { direction: PositionSide; liquidation: { fromRefPct: string } | null }[],
): string | null {
  let menor: Decimal | null = null;
  for (const s of sides) {
    if (!s.liquidation) continue;
    const d = D(s.liquidation.fromRefPct).mul(s.direction === 'LONG' ? -1 : 1);
    if (menor === null || d.lt(menor)) menor = d;
  }
  return menor ? menor.toFixed(2) : null;
}

/**
 * Distancia mínima a la liquidación estimada que la API exige al crear o editar
 * un bot, en %. La misma cifra manda en `validateCommon`, en `RiskService` y en
 * el asistente: antes el formulario avisaba a 12×, la API rechazaba a 19× con
 * otro mensaje y ninguna pantalla decía dónde estaba el límite (001/F-44).
 */
export const MIN_LIQUIDATION_DISTANCE_PCT = 5;

/**
 * Tope absoluto de apalancamiento con la regla por stop (spec 058).
 *
 * Con esa regla el 5 % de arriba no manda: la liquidación se mide contra el
 * stop de cada operación. Lo que queda es este techo, que es una decisión del
 * usuario («hasta 25x o el máximo del par»), y lo miran la herramienta del
 * canal, `validateCommon` y `RiskService`.
 */
export const MAX_APALANCAMIENTO_POR_STOP = 25;

/**
 * Tasa de mantenimiento de un mercado. La ficha la trae cuando el venue la
 * publica; si no, la regla de Hyperliquid («la mitad del margen inicial al
 * apalancamiento máximo»), que aproxima los tramos bajos de Aster y Lighter
 * mejor que un 0,5 % plano: BTC a 40× → 1,25 %, DOGE a 10× → 5 % (001/F-93).
 * Sin apalancamiento máximo conocido, la tasa plana.
 */
export function maintenanceMarginRateOf(market: {
  maintenanceMarginRate?: number | null;
  maxLeverage?: number | null;
}): number {
  const declarada = market.maintenanceMarginRate;
  if (declarada != null && Number.isFinite(declarada) && declarada > 0) return declarada;
  const maxLev = market.maxLeverage ?? 0;
  return maxLev > 0 ? 1 / (2 * maxLev) : DEFAULT_MAINTENANCE_MARGIN_RATE;
}

/**
 * Apalancamiento máximo (entero) con el que la liquidación queda a
 * `minDistancePct` o más de la entrada, con la fórmula EXACTA del lado:
 *
 *   `(1/L − m)/(1 ∓ m) ≥ d`  →  `L ≤ 1 / (m + d·(1 ∓ m))`
 *
 * (`−` en el largo, `+` en el corto). Antes era la lineal `1/(d + m)`, que en
 * el corto se pasaba de uno: BTC a 16× dejaba la liquidación a un 4,94 %, por
 * debajo del mínimo que la regla decía garantizar (spec 079, F-07).
 */
export function maxApalancamientoConDistancia(
  mmr: number,
  lado: PositionSide,
  minDistancePct: number = MIN_LIQUIDATION_DISTANCE_PCT,
): number {
  const d = minDistancePct / 100;
  const denominador = mmr + d * (lado === 'SHORT' ? 1 + mmr : 1 - mmr);
  return Math.max(1, Math.floor(1 / denominador + 1e-9));
}

/** Lo mínimo de una posición para saber qué caja la respalda. */
export interface CollateralPosition {
  symbol: string;
  /** Firmada: positiva en largo, negativa en corto. */
  qty: Numeric;
  entryPrice: Numeric;
  leverage: number;
  marginMode: MarginMode;
  /** Colateral aportado a mano POR ENCIMA del que exige el apalancamiento. */
  extraMargin: Numeric;
}

/**
 * Caja que respalda de verdad a una posición.
 *
 * La distinción no es un detalle contable, es la que decide a qué precio
 * revienta:
 *
 * · AISLADO: solo su propio margen. Se pierde eso y nada más, y por eso el
 *   precio de liquidación queda cerca.
 * · CRUZADO: la cuenta ENTERA menos lo que las posiciones aisladas tienen
 *   inmovilizado. Es lo que significa cruzado —el resto del saldo defiende la
 *   posición— y por eso la liquidación queda mucho más lejos, o directamente no
 *   existe mientras el saldo la cubra.
 *
 * Tratar una cruzada como si fuera aislada la revienta con un movimiento que un
 * venue real ni notaría. Importa especialmente porque CRUZADO es el modo por
 * defecto de varias estrategias.
 */
export function collateralBacking(
  target: CollateralPosition,
  all: readonly CollateralPosition[],
  equity: Numeric,
): Decimal {
  const notional = D(target.qty).abs().mul(target.entryPrice);
  const propio = notional.div(target.leverage || 1).plus(D(target.extraMargin));
  if (target.marginMode === 'ISOLATED') return propio;

  let inmovilizado = D(0);
  let notionalCruzado = D(0);
  for (const p of all) {
    if (D(p.qty).isZero()) continue;
    const n = D(p.qty).abs().mul(p.entryPrice);
    if (p.marginMode === 'ISOLATED') {
      inmovilizado = inmovilizado.plus(n.div(p.leverage || 1)).plus(D(p.extraMargin));
    } else {
      notionalCruzado = notionalCruzado.plus(n);
    }
  }

  const libre = D(equity).minus(inmovilizado);

  // La caja libre se REPARTE entre las cruzadas, en proporción a lo que arriesga
  // cada una. Antes se le acreditaba entera a cada posición, así que con dos
  // cruzadas abiertas las dos creían tener toda la cuenta detrás: ninguna se
  // liquidaba hasta perderla al completo, y entre las dos el simulador podía
  // realizar el doble del saldo que había.
  //
  // Proporcional al notional y no a partes iguales porque es lo que se parece a
  // cómo mide un venue el margen de mantenimiento: lo que consume cada posición
  // es su tamaño, no el hecho de existir.
  const parte = notionalCruzado.gt(0) ? libre.mul(notional).div(notionalCruzado) : libre;

  // Nunca menos que el margen que exige el apalancamiento: por debajo de eso la
  // posición no se habría podido abrir, y devolverlo haría que una cuenta en
  // números rojos calculara una liquidación ya pasada.
  return Decimal.max(parte, propio);
}

/**
 * Liquidación de una posición, con su modo de margen tenido en cuenta.
 *
 * Es lo que hay que llamar cuando se conoce la cuenta entera; `precioLiquidacion`
 * a secas sirve para el caso «aún no hay posición», donde no hay cuenta que
 * mirar.
 */
export function liquidationOfPosition(
  target: CollateralPosition,
  all: readonly CollateralPosition[],
  equity: Numeric,
  maintenanceMarginRate: number = DEFAULT_MAINTENANCE_MARGIN_RATE,
): Decimal | null {
  const qty = D(target.qty);
  if (qty.isZero()) return null;

  const notional = qty.abs().mul(target.entryPrice);
  const caja = collateralBacking(target, all, equity);
  if (caja.lte(0) || notional.lte(0)) return null;

  // El apalancamiento EFECTIVO: el notional entre la caja que lo sostiene. Con
  // caja de sobra un largo sale por debajo de 1 y la fórmula da un precio
  // negativo, que `precioLiquidacion` traduce a null — «esto no se liquida».
  return precioLiquidacion(
    target.entryPrice,
    notional.div(caja).toNumber(),
    maintenanceMarginRate,
    qty.gt(0) ? 'LONG' : 'SHORT',
  );
}

/**
 * Precio de liquidación EXACTO de una posición aislada, sin comisiones. Es la
 * única fórmula de liquidación del proyecto.
 *
 * La equidad a precio `P` es `margen + qty·(P − E)`, y el venue liquida cuando
 * baja del mantenimiento `mmr·qty·P`. Despejando:
 * - LARGO: `P = E·(1 − 1/L) / (1 − mmr)`
 * - CORTO: `P = E·(1 + 1/L) / (1 + mmr)`
 *
 * Es la de Hyperliquid despejada —«liq_price = price − side · margin_available /
 * position_size / (1 − l · side)», con `margin_available = margen − mmr·qty·E`—
 * y la de Lighter, que liquida cuando el valor de la cuenta baja de
 * `Σ S·mark·M` (spec 079, referencias oficiales). En Aster, con la tasa del
 * tramo y sin su «importe de mantenimiento», queda del lado prudente.
 *
 * Hasta el spec 080 convivía con una aproximación lineal
 * (`E·(1 ∓ 1/L ± mmr)`) que en el corto salía optimista: la previsualización
 * enseñaba una liquidación y las IA calculaban otra (079/F-07).
 */
export function precioLiquidacion(
  entrada: Numeric,
  apalancamiento: number,
  mantenimiento: number,
  lado: PositionSide,
): Decimal | null {
  if (!(apalancamiento > 0)) return null;
  const e = D(entrada);
  if (!e.isFinite() || e.lte(0)) return null;
  const inv = D(1).div(apalancamiento);
  const m = D(mantenimiento);
  const p =
    lado === 'SHORT'
      ? e.mul(D(1).plus(inv)).div(D(1).plus(m))
      : e.mul(D(1).minus(inv)).div(D(1).minus(m));
  return p.gt(0) ? p : null;
}

/**
 * Distancia relativa entrada-liquidación en aislado, en tanto por uno.
 *
 * - LARGO: `(1/L − mmr)/(1 − mmr)`
 * - CORTO: `(1/L − mmr)/(1 + mmr)`
 *
 * La del corto es siempre la más estrecha de las dos.
 */
export function distanciaLiquidacion(
  apalancamiento: number,
  mantenimiento: number,
  lado: PositionSide,
): Decimal {
  if (!(apalancamiento > 0)) return D(0);
  const m = D(mantenimiento);
  const num = D(1).div(apalancamiento).minus(m);
  return num.div(lado === 'SHORT' ? D(1).plus(m) : D(1).minus(m));
}

/**
 * Lo que se ha perdido del margen al llegar a la liquidación, en % (positivo):
 * la distancia exacta por el apalancamiento. A 15× en corto en BTC, un 80,2 %;
 * el resto es el mantenimiento, que el venue se queda al liquidar.
 */
export function perdidaEnLiquidacionPct(
  apalancamiento: number,
  mantenimiento: number,
  lado: PositionSide,
): Decimal {
  return distanciaLiquidacion(apalancamiento, mantenimiento, lado).mul(apalancamiento).mul(100);
}

// ── El stop frente a la liquidación (spec 080) ────────────────────────────

/**
 * La liquidación tiene que quedar al menos a MEDIO STOP detrás del stop.
 *
 * Es la regla de la casa desde el canal con IA (spec 058) y los agentes
 * (spec 074): un stop es una orden condicional que dispara a mercado, y con la
 * liquidación pegada detrás un deslizamiento o una mecha lo dejan sin tiempo de
 * salir. Desde el spec 080 la mide también el stop común de todas las
 * estrategias, que hasta entonces podía quedar detrás de la liquidación sin que
 * nada lo dijera (079/F-01).
 */
export const HOLGURA_LIQUIDACION = 0.5;

/** El paso con el que se proponen stops: el mismo que el del campo en el formulario. */
const PASO_STOP = D('0.1');

/**
 * El stop más ancho, en % sobre el margen, que deja la liquidación al menos a
 * medio stop detrás: con `s` el movimiento de precio del stop y `d` la
 * distancia exacta a la liquidación, `s·(1 + HOLGURA) ≤ d`. Redondeado hacia
 * abajo al paso del campo, para que el valor propuesto cumpla la regla.
 *
 * A 15× en corto en BTC (mantenimiento 1,25 %): `d = 5,35 %`, `s ≤ 3,57 %`,
 * es decir un 53,4 % del margen.
 */
export function stopMaximoRoi(
  apalancamiento: number,
  mantenimiento: number,
  lado: PositionSide,
): Decimal {
  const d = distanciaLiquidacion(apalancamiento, mantenimiento, lado);
  if (!d.gt(0)) return D(0);
  const roi = d
    .div(1 + HOLGURA_LIQUIDACION)
    .mul(apalancamiento)
    .mul(100);
  return roi.div(PASO_STOP).floor().mul(PASO_STOP);
}

// ── La regla por stop del canal con IA (spec 058) ──────────────────────────

/**
 * El tramo que rige para un nocional: el de mayor `desdeNocional` que no lo
 * supera. Sin tramos, el del mercado entero.
 */
export function tramoDeApalancamiento(
  tramos: readonly NivelApalancamiento[],
  nocional: Numeric,
  maxMercado: number,
  mantenimientoMercado: number,
): NivelApalancamiento {
  const n = D(nocional);
  let elegido: NivelApalancamiento | null = null;
  for (const t of tramos) {
    if (D(t.desdeNocional).lte(n) && (!elegido || D(t.desdeNocional).gt(elegido.desdeNocional))) {
      elegido = t;
    }
  }
  return (
    elegido ?? {
      desdeNocional: '0',
      maxApalancamiento: maxMercado,
      mantenimiento: mantenimientoMercado,
    }
  );
}

export interface EntradaApalancamientoPorStop {
  /** Distancia del stop a la entrada, en tanto por uno. */
  distanciaStop: Numeric;
  /** ATR de 1 h sobre el precio, en tanto por uno. */
  atr1hRelativo: Numeric;
  /** Cuántos stops, como mínimo, entre la entrada y la liquidación. Nunca menos de 3. */
  liqBufferStops: number;
  /** Mantenimiento del tramo que rige. */
  mantenimiento: number;
  /** El resto de topes: 25, el del usuario, el del tramo, el del mercado… */
  topes: readonly number[];
}

export interface ApalancamientoPorStop {
  /** La distancia mínima exigida hasta la liquidación, en tanto por uno. */
  necesaria: Decimal;
  /** El mayor apalancamiento que la respeta. 0 = ni a 1× cabe. */
  porStop: number;
  /** `porStop` con el resto de topes aplicados. */
  maximo: number;
}

/**
 * El apalancamiento máximo que admite un stop (spec 058, «La regla por stop»).
 *
 *   need  = max(liqBufferStops·s, 3·ATR(1h))
 *   Lstop = floor(1 / (mmr + need·(1 + mmr)))
 *
 * **Por qué el `(1 + mmr)`.** Con él, la distancia del corto
 * —`(1/L − mmr)/(1 + mmr)`— queda por encima de `need`, y la del largo, más
 * holgada, también.
 *
 * **Qué garantiza.** Un stop más ancho da MENOS apalancamiento, y la
 * liquidación queda siempre al menos a tres stops y a tres ATR de 1 h de la
 * entrada.
 */
export function apalancamientoPorStop(e: EntradaApalancamientoPorStop): ApalancamientoPorStop {
  const buffer = Math.max(3, e.liqBufferStops);
  const necesaria = Decimal.max(D(e.distanciaStop).mul(buffer), D(e.atr1hRelativo).mul(3));
  const m = D(e.mantenimiento);
  const denominador = m.plus(necesaria.mul(D(1).plus(m)));
  const porStop = denominador.gt(0)
    ? D(1).div(denominador).toDecimalPlaces(0, Decimal.ROUND_FLOOR).toNumber()
    : 0;
  const topes = e.topes.filter((t) => Number.isFinite(t) && t > 0);
  const maximo = Math.max(0, Math.floor(Math.min(porStop, ...topes)));
  return { necesaria, porStop, maximo };
}
