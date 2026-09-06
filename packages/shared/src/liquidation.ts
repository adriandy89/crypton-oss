import type { Direction, MarginMode } from './enums';
import { D, Decimal, type Numeric } from './money';

/**
 * Tasa de margen de mantenimiento por defecto cuando el venue no la expone.
 * 0,5 % es lo habitual en los tramos bajos de los perps que soportamos; los
 * tramos altos son peores, así que esta estimación es OPTIMISTA. Se etiqueta
 * como estimación en la UI justamente por eso: nunca se presenta como el precio
 * de liquidación real del venue.
 */
export const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005;

/**
 * Liquidación aproximada de una posición aislada.
 *
 *   LONG : liq ≈ entry × (1 − 1/apalancamiento + mmr)
 *   SHORT: liq ≈ entry × (1 + 1/apalancamiento − mmr)
 *
 * Sirve para dimensionar el riesgo antes de crear el bot y para la alerta de
 * cercanía. El precio que manda siempre es el que devuelve el venue en la
 * posición abierta; este solo cubre el caso "aún no hay posición".
 */
export function estimateLiquidationPrice(
  averageEntry: Numeric,
  leverage: number,
  direction: Direction,
  maintenanceMarginRate: number = DEFAULT_MAINTENANCE_MARGIN_RATE,
): Decimal | null {
  if (leverage <= 0) return null;
  const entry = D(averageEntry);
  if (!entry.isFinite() || entry.lte(0)) return null;
  const inv = D(1).div(leverage);
  const mmr = D(maintenanceMarginRate);
  const factor = direction === 'SHORT' ? D(1).plus(inv).minus(mmr) : D(1).minus(inv).plus(mmr);
  const liq = entry.mul(factor);
  return liq.gt(0) ? liq : null;
}

/** Cuánto puede caer (o subir) el precio antes de liquidar, en %. Siempre ≥ 0. */
export function liquidationDistancePct(currentPrice: Numeric, liquidationPrice: Numeric): Decimal {
  const cur = D(currentPrice);
  if (cur.lte(0)) return D(0);
  return D(liquidationPrice).minus(cur).div(cur).mul(100).abs();
}

/**
 * Distancia mínima a la liquidación estimada que la API exige al crear o editar
 * un bot, en %. La misma cifra manda en `validateCommon`, en `RiskService` y en
 * el asistente: antes el formulario avisaba a 12×, la API rechazaba a 19× con
 * otro mensaje y ninguna pantalla decía dónde estaba el límite (001/F-44).
 */
export const MIN_LIQUIDATION_DISTANCE_PCT = 5;

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
 * Apalancamiento máximo (entero) con el que la liquidación estimada queda a
 * `minDistancePct` o más del precio: `1/lev − mmr ≥ d` → `lev ≤ 1/(d + mmr)`.
 */
export function maxLeverageWithinDistance(
  mmr: number,
  minDistancePct: number = MIN_LIQUIDATION_DISTANCE_PCT,
): number {
  return Math.max(1, Math.floor(1 / (minDistancePct / 100 + mmr) + 1e-9));
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
 * Es lo que hay que llamar cuando se conoce la cuenta entera;
 * `estimateLiquidationPrice` a secas sirve para el caso «aún no hay posición»,
 * donde no hay cuenta que mirar.
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
  // caja de sobra sale por debajo de 1 y la fórmula devuelve un precio negativo,
  // que `estimateLiquidationPrice` ya traduce a null — «esto no se liquida».
  return estimateLiquidationPrice(
    target.entryPrice,
    notional.div(caja).toNumber(),
    qty.gt(0) ? 'LONG' : 'SHORT',
    maintenanceMarginRate,
  );
}
