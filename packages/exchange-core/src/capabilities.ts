import { Venue, type CandleInterval, type VenueCapabilities } from '@crypton/shared';
import { capabilitiesOf } from './candles';

/**
 * Lo que sabe hacer cada venue, como CONSTANTE.
 *
 * Vive fuera de los adaptadores por dos razones que se notan:
 *
 * 1. Es estático. Preguntar «¿qué intervalos sirve Lighter?» no debería obligar
 *    a construir un adaptador —con su limitador, su caché de specs y, en
 *    Hyperliquid, sus transportes HTTP y WebSocket— para leer una lista que no
 *    cambia nunca. La API lo pregunta en cada petición de `/capabilities`.
 *
 * 2. Construir un adaptador de Hyperliquid carga su SDK, que es solo ESM y se
 *    trae con `require()`. El runtime de Jest no implementa `require(esm)`, así
 *    que cualquier test que quisiera comprobar la matriz de capacidades moría
 *    con `SyntaxError: Unexpected token 'export'`.
 *
 * Las listas siguen siendo la fuente de verdad para los propios adaptadores:
 * cada uno importa la suya y la usa con `checkInterval`, que además estrecha el
 * tipo al conjunto del venue.
 */

/**
 * Hyperliquid: los catorce de `candleSnapshot`, verificados contra el esquema
 * del SDK. Falta 6h, y no es un olvido: no está en la lista del venue.
 */
export const HL_INTERVALS = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M',
] as const satisfies readonly CandleInterval[];

/**
 * Lighter: las OCHO que documenta `/api/v1/candles`. Es el más corto de los
 * tres — sin 3m, 2h, 6h, 8h, 3d, 1w ni 1M — y por eso la interfaz los pinta
 * apagados en vez de esconderlos: el usuario tiene que poder distinguir «la app
 * no sabe» de «el venue no da».
 *
 * `1w` estaba aquí y NO existe: venía del enum del SDK (`zklighter-sdk`), que
 * se quedó atrás. La documentación vigente lista ocho resoluciones y pedir la
 * semanal devuelve `{"code":20001,"message":"invalid param"}`.
 * https://apidocs.lighter.xyz/reference/candles.md
 */
export const LIGHTER_INTERVALS = [
  '1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d',
] as const satisfies readonly CandleInterval[];

/**
 * Aster: los quince del API de futuros de Binance, que es el que reimplementa.
 * Es el más generoso: el único con 6h.
 */
export const ASTER_INTERVALS = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M',
] as const satisfies readonly CandleInterval[];

/**
 * La matriz completa.
 *
 * `maxBars` es el tope por petición que documenta cada venue; `live` dice si
 * hay stream nativo de velas.
 *
 * Lighter figuraba aquí como `false` y SÍ lo tiene: el canal
 * `candle/{market_id}/{resolution}` de su WebSocket oficial. Mientras estuvo en
 * `false`, el worker devolvía «no hay velas en vivo» y el gráfico se quedaba
 * sondeando la API por REST — que es por donde se agotaba el cupo del venue.
 *
 * El de Lighter son 500, no 1000: «Returns at most 500 candles per call» en
 * https://apidocs.lighter.xyz/reference/candles.md, y comprobado —pedir 1000
 * devuelve 500—. Prometer el doble hacía que un gráfico ancho se pintara con
 * la mitad del histórico sin que nada avisara.
 */
export const VENUE_CAPABILITIES: Record<Venue, VenueCapabilities> = {
  // Peso 1200/min con margen del 15 % ⇒ ~17/s sostenido, y una página de 300
  // velas pesa `20 + ceil(300/60)` = 25. Nueve páginas cubren las 3000 barras
  // que el gráfico admite en memoria, y 400 ms entre ellas deja el arrastre
  // fluido sin vaciar el caudal que los bots usan para cancelar.
  [Venue.HYPERLIQUID]: capabilitiesOf(Venue.HYPERLIQUID, HL_INTERVALS, 5000, true, {
    maxHistoryPages: 9,
    minPageGapMs: 400,
  }),
  // Lighter cuenta PETICIONES, no peso: 60 por minuto ⇒ 0,85 por segundo. Una
  // sola página se lleva más de un segundo del presupuesto ENTERO de la IP, así
  // que aquí se pagina despacio y poco. Es el venue que obligó a que estos dos
  // números viajaran por venue en vez de ser una constante del cliente.
  [Venue.LIGHTER]: capabilitiesOf(Venue.LIGHTER, LIGHTER_INTERVALS, 500, true, {
    maxHistoryPages: 3,
    minPageGapMs: 1500,
  }),
  [Venue.ASTER]: capabilitiesOf(Venue.ASTER, ASTER_INTERVALS, 1500, true, {
    maxHistoryPages: 9,
    minPageGapMs: 400,
  }),
};
