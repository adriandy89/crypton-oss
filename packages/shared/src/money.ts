import Decimal from 'decimal.js';

/**
 * Precisión alta a propósito: los cálculos intermedios de una escalera
 * martingala encadenan hasta 30 multiplicaciones (volumeScale^n), y con la
 * precisión por defecto (20) el error se nota en los últimos niveles.
 * El redondeo REAL a tick/step se hace explícitamente en `precision.ts`, nunca
 * de forma implícita aquí.
 */
Decimal.set({ precision: 40, toExpNeg: -30, toExpPos: 30 });

export { Decimal };

/** Entrada admitida allí donde el dominio habla de dinero o cantidades. */
export type Numeric = Decimal | number | string;

export const D = (v: Numeric): Decimal => new Decimal(v);

/** Serialización canónica para la BD y para el cable: string, nunca float. */
export const toStr = (v: Numeric): string => D(v).toFixed();

export const isFiniteNum = (v: unknown): boolean => {
  if (v === null || v === undefined || v === '') return false;
  try {
    return new Decimal(v as Numeric).isFinite();
  } catch {
    return false;
  }
};

/**
 * Primer valor de la lista que sirva como número. Para datos que vienen del
 * VENUE, donde «no hay dato» se dice de varias formas distintas.
 *
 * Existe por un fallo que pausó un bot en producción. Todo el código de los
 * adaptadores escribía `D(campo ?? 0)`, y `??` solo tapa `null` y `undefined`:
 * la CADENA VACÍA se cuela y `new Decimal('')` LANZA. Lighter manda
 * exactamente eso —`"best_bid_price": ""`, `"best_ask_price": ""`,
 * `"mid_price": ""`— en `market_stats` cuando el libro de un mercado está
 * vacío, que en testnet es el estado normal de casi todos los pares. El
 * resultado era `[DecimalError] Invalid argument: ` en CADA tick, cinco
 * seguidos, y el cortacircuitos pausaba el bot.
 *
 * La regla de «esto sirve como número» ya estaba escrita en `isFiniteNum` —que
 * sí contempla la cadena vacía—; lo que faltaba era usarla al leer del venue.
 * Se reutiliza aquí para que no haya dos definiciones de lo mismo.
 *
 * El último argumento es el respaldo y debe ser siempre un valor válido. Si no
 * lo fuera, devuelve cero antes que lanzar: el llamante es un adaptador dentro
 * del tick de un bot, y ahí una excepción vale una pausa.
 */
export const firstNum = (...values: unknown[]): Decimal => {
  for (const v of values) if (isFiniteNum(v)) return D(v as Numeric);
  return D(0);
};

/** Aplica un porcentaje: pct(100, 2.5) === 102.5 */
export const applyPct = (base: Numeric, pct: Numeric): Decimal =>
  D(base).mul(D(1).plus(D(pct).div(100)));

/** Variación relativa en % de `to` respecto de `from`. */
export const pctChange = (from: Numeric, to: Numeric): Decimal =>
  D(to).minus(from).div(from).mul(100);
