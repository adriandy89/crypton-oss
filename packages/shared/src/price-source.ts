/**
 * Traducción del par canónico al símbolo de la fuente externa.
 *
 * Vive en `shared` y no en el worker porque lo necesitan los dos lados: la
 * estrategia para componer la clave del feed y el worker para pedir el precio.
 */

/**
 * Símbolo de Binance para un par.
 *
 * Se fuerza a USDT y no se respeta la quote del venue a propósito: en Binance
 * la liquidez de referencia está en los pares USDT, y un `BTCUSDC` con la
 * décima parte del volumen daría un precio peor que el del propio venue —que es
 * justo lo contrario de para lo que se pide una fuente externa.
 *
 * Cuando la base del venue no case con `<base>USDT` —`1000PEPE`, un token que
 * allí se llame distinto— el usuario escribe el símbolo exacto en «símbolo de
 * origen alternativo» y manda ese.
 */
export function binanceSymbol(base: string, override?: string | null): string {
  return externalSymbol(base, override);
}

/**
 * El mismo mapeo, con el nombre que corresponde ahora que hay dos consumidores.
 *
 * Lo estrenó el feed de precio en vivo de Binance, pero la regla no es suya: los
 * proveedores de histórico —Binance y Bybit— usan exactamente la misma
 * convención `<BASE>USDT` y el mismo campo de «símbolo de origen alternativo».
 * `binanceSymbol` se conserva delegando aquí para no tocar a sus llamantes ni
 * perder el razonamiento de por qué se fuerza USDT, que sigue arriba.
 */
export function externalSymbol(base: string, override?: string | null): string {
  if (override && override.trim()) return override.trim().toUpperCase();
  return base.toUpperCase() + 'USDT';
}

/**
 * Clave del feed compartido. Un solo feed por (fuente, tipo de mercado,
 * símbolo), lo pidan uno o mil bots — el mismo principio que el feed de precios
 * del venue.
 */
export function fairPriceKey(source: string, marketType: string, symbol: string): string {
  return source + ':' + marketType + ':' + symbol.toUpperCase();
}

/** Clave de Redis donde el worker deja el último precio de una fuente externa. */
export const fairPriceRedisKey = (feedKey: string): string => 'crypton:fx:' + feedKey.toLowerCase();
