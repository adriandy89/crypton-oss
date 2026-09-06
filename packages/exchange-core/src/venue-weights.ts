import { Venue } from '@crypton/shared';

/**
 * Pesos REALES de cada venue, en las unidades que publica cada uno.
 *
 * Sustituyen a una tabla llamada `OPERATION_WEIGHT` que estaba EXPORTADA y que
 * no leía nadie: los pesos de verdad eran los números sueltos de cada llamada
 * —un `2` por defecto para todo—, y por eso ninguno se parecía al del venue.
 *
 * Las tres escalas no tienen nada que ver entre sí, y ese era el fondo del
 * problema: una sola tabla no puede ser correcta para los tres a la vez.
 *
 *   · Lighter cuenta en unidades de 300
 *   · Aster,  de 1 a 40
 *   · Hyperliquid, de 2 a 60
 */

/**
 * Cupo por minuto y por IP de cada venue, en su propia unidad.
 *
 *   · Lighter — «Standard accounts: 60 requests per rolling minute». Es un
 *     cupo de PETICIONES, no ponderado; las cuentas por encima de Standard
 *     tienen uno ponderado y mayor, pero aquí se toma el de Standard, el más
 *     estrecho, y ninguna variable de entorno lo cambia (001/F-20).
 *     https://apidocs.lighter.xyz/docs/rate-limits
 *   · Hyperliquid — «REST requests share an aggregated weight limit of 1200 per
 *     minute».
 *   · Aster — `REQUEST_WEIGHT` 2400/min por IP, y lo confirma el propio venue
 *     en `rateLimits[]` de `/fapi/v3/exchangeInfo`.
 */
export const VENUE_QUOTA_PER_MINUTE: Record<Venue, number> = {
  [Venue.HYPERLIQUID]: 1200,
  [Venue.LIGHTER]: 60,
  [Venue.ASTER]: 2400,
};

/**
 * En qué UNIDAD cuenta cada venue su cupo. No es un detalle: mezclarlas rompe
 * el presupuesto de una forma que no se ve hasta que el sistema se para.
 *
 * Hyperliquid y Aster publican cupos PONDERADOS —1200 y 2400 de peso por
 * minuto— y sus pesos por endpoint van en la misma escala, así que se restan
 * directamente del depósito.
 *
 * Lighter NO. Su cupo Standard son «60 requests per rolling minute»:
 * PETICIONES, no peso. Los pesos de 300 solo entran en juego en los tiers
 * ponderados. Descontar 300 de un depósito que se rellena a 0,85 por segundo
 * deja una deuda de casi SEIS MINUTOS por una sola lectura — el venue estaría
 * abierto y seríamos nosotros los que dejaríamos de llamar.
 */
export const VENUE_QUOTA_UNIT: Record<Venue, 'requests' | 'weight'> = {
  [Venue.HYPERLIQUID]: 'weight',
  [Venue.LIGHTER]: 'requests',
  [Venue.ASTER]: 'weight',
};

/**
 * Cupo de ÓRDENES de Aster, aparte del peso: `rateLimits[]` de
 * `/fapi/v3/exchangeInfo` declara `ORDERS` 1200 por minuto y 300 cada 10
 * segundos («counted against each account»). El presupuesto solo modelaba el
 * peso, así que un market maker de varias capas podía pasarse de 300 órdenes
 * en diez segundos sin que nadie lo notara: 429 y, si se insiste, 418 con veto
 * de IP «from 2 minutes to 3 days» (001/F-24). Se cuenta por IP, que es más
 * conservador que por cuenta y basta.
 */
export const ASTER_ORDER_QUOTA = { perMinute: 1200, per10Seconds: 300 } as const;

/**
 * Margen de seguridad sobre el cupo publicado.
 *
 * El contador del venue y el nuestro nunca están perfectamente alineados, y
 * quedarse corto cuesta un enfriamiento de 60 s en Lighter y un veto de IP de
 * hasta tres días en Aster. Gastar un 15 % menos es barato comparado con eso.
 */
export const QUOTA_HEADROOM = 0.85;

/**
 * Peso de cada endpoint de Lighter.
 * https://apidocs.lighter.xyz/docs/rate-limits
 */
export const LIGHTER_WEIGHT: Record<string, number> = {
  sendTx: 6,
  sendTxBatch: 6,
  nextNonce: 6,
  publicPools: 50,
  txFromL1TxHash: 50,
  accountInactiveOrders: 100,
  'deposit/latest': 100,
  apikeys: 150,
  transferFeeInfo: 500,
  trades: 600,
  recentTrades: 600,
  changeAccountTier: 3000,
  tokens: 3000,
  'tokens/revoke': 3000,
  setAccountMetadata: 3000,
  'notification/ack': 3000,
  createIntentAddress: 3000,
  fastwithdraw: 3000,
  'tokens/create': 23000,
};

/** «Other endpoints: 300». Es el caso de `candles` y de `orderBookDetails`. */
export const LIGHTER_DEFAULT_WEIGHT = 300;

/**
 * Peso de un endpoint de Lighter a partir de su ruta.
 *
 * `trades` pesa **600**, el doble que cualquier lectura normal, y se
 * contabilizaba como 2 desde un sondeo que corría cada tres segundos y por
 * símbolo.
 */
export function lighterWeight(path: string): number {
  const name = path.replace(/^\/api\/v\d+\//, '').split('?')[0];
  return LIGHTER_WEIGHT[name] ?? LIGHTER_DEFAULT_WEIGHT;
}

/**
 * Coste de un endpoint de Lighter en PETICIONES-equivalentes, que es la unidad
 * en la que cuenta su cupo Standard (60 por minuto).
 *
 * Se normaliza contra el peso corriente (300): una lectura normal cuesta 1, y
 * `trades` —que pesa 600— cuesta 2, que es exactamente la proporción que
 * publica el venue. Así el presupuesto respeta el cupo real y sigue cobrando
 * más por lo que de verdad cuesta más.
 *
 * El suelo es 1: ninguna petición es gratis para un contador de peticiones.
 */
export function lighterCost(path: string): number {
  return Math.max(1, Math.round(lighterWeight(path) / LIGHTER_DEFAULT_WEIGHT));
}

/**
 * Peso de un endpoint de Aster.
 * @see V3(Recommended)/EN/aster-finance-futures-api-v3.md en asterdex/api-docs
 *
 * Los dos que importan son los que se piden SIN símbolo: `ticker/24hr` y
 * `openOrders` pasan de 1 a **40** en cuanto se omite, y las dos cosas las hace
 * este adaptador —`getTickers()` desde un cron cada 30 s—. Se contabilizaban
 * como 2.
 */
export function asterWeight(path: string, params: Record<string, unknown> = {}): number {
  const route = path.split('?')[0].replace(/^\/fapi\/v\d+\//, '');
  const conSimbolo = params.symbol !== undefined;

  switch (route) {
    case 'ticker/24hr':
      return conSimbolo ? 1 : 40;
    case 'openOrders':
      return conSimbolo ? 1 : 40;
    case 'ticker/bookTicker':
      return conSimbolo ? 1 : 2;
    case 'balance':
    case 'positionRisk':
    case 'userTrades':
    case 'account':
      return 5;
    // Tabla del venue: [1,100) -> 1 · [100,500) -> 2 · [500,1000] -> 5 · >1000 -> 10
    //
    // Los dos primeros intervalos son SEMIABIERTOS y el tercero cerrado. Con un
    // único `<=` para todos, `limit=100` salía 1 en vez de 2 y `limit=500` salía
    // 2 en vez de 5 — justo los valores redondos que se piden en la práctica.
    case 'klines': {
      const n = Number(params.limit ?? 0);
      if (n < 100) return 1;
      if (n < 500) return 2;
      if (n <= 1000) return 5;
      return 10;
    }
    // Tabla del venue: 5,10,20,50 -> 2 · 100 -> 5 · 500 -> 10 · 1000 -> 20.
    // Aquí los valores son DISCRETOS —el venue solo acepta esos—, así que el
    // `<=` sí describe la tabla.
    case 'depth': {
      const n = Number(params.limit ?? 0);
      if (n <= 50) return 2;
      if (n <= 100) return 5;
      if (n <= 500) return 10;
      return 20;
    }
    default:
      return 1;
  }
}

/**
 * Peso de una petición `info` de Hyperliquid.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 *
 * `candleSnapshot` es el que más se desviaba: no estaba en ninguna tabla, se
 * contabilizaba como 1, y son 20 más uno por cada 60 barras — unas 28 para las
 * 500 de un gráfico.
 */
export function hyperliquidWeight(type: string, items = 0): number {
  if (HL_LIGHT.has(type)) return 2;
  if (type === 'userRole') return 60;
  if (type === 'candleSnapshot') return 20 + Math.ceil(items / 60);
  if (HL_PER_20.has(type)) return 20 + Math.ceil(items / 20);
  return 20;
}

/** Las de peso 2: son las que el venue lista como baratas. */
const HL_LIGHT = new Set([
  'l2Book',
  'allMids',
  'clearinghouseState',
  'orderStatus',
  'spotClearinghouseState',
  'exchangeStatus',
]);

/** Las que suman uno por cada 20 elementos devueltos. */
const HL_PER_20 = new Set([
  'recentTrades',
  'historicalOrders',
  'userFills',
  'userFillsByTime',
  'fundingHistory',
  'userFunding',
  'nonUserFundingUpdates',
  'twapHistory',
  'userTwapSliceFills',
  'userTwapSliceFillsByTime',
  'delegatorHistory',
  'delegatorRewards',
  'validatorStats',
]);
