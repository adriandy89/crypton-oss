import type { Venue } from './enums';

/**
 * Metadatos de un mercado, normalizados entre venues. Se cachean en la tabla
 * `markets` y se refrescan por cron: sin ellos no se puede construir ni una
 * sola orden válida (ver `precision.ts`).
 *
 * Todos los numéricos van como string para no perder precisión al viajar por
 * JSON; se convierten con `D()` en cuanto entran a un cálculo.
 */
export interface MarketSpec {
  venue: Venue;
  /** Símbolo tal y como lo espera el venue (p.ej. 'BTC' en HL, 'BTCUSDT' en Aster). */
  symbol: string;
  /** Símbolo canónico para la UI y para agrupar entre venues: 'BTC/USDC'. */
  canonical: string;
  base: string;
  quote: string;
  tickSize: string;
  stepSize: string;
  minNotional: string | null;
  minQty: string | null;
  /** Tope de cantidad de una orden LÍMITE (Aster: `LOT_SIZE.maxQty`). */
  maxQty: string | null;
  /**
   * Tope de cantidad de una orden A MERCADO, cuando el venue lo acota aparte
   * (Aster: `MARKET_LOT_SIZE.maxQty`, menor que el de las límite en todos sus
   * símbolos: 120 BTC frente a 1000). Null o ausente = manda `maxQty`. El motor
   * trocea el cierre a mercado de una posición mayor que este tope; antes el
   * venue rechazaba la orden entera (001/F-22).
   */
  maxMarketQty?: string | null;
  maxLeverage: number;
  priceDecimals: number;
  qtyDecimals: number;
  /** false = el venue lo ha deslistado o pausado; los bots sobre él se pausan. */
  active: boolean;
  /**
   * Tope de órdenes activas por mercado que impone el venue (Lighter Standard:
   * 30; Aster: 200). Null o ausente = sin tope conocido. Sirve para AVISAR al
   * crear el bot de que una retícula con más niveles se recortará: el venue
   * rechaza el exceso orden a orden y el bot no lo ve venir (001/F-50, F-23).
   */
  maxActiveOrders?: number | null;
  /**
   * Tope de cifras significativas que admite el venue en un precio (Hyperliquid:
   * 5, con los enteros siempre válidos). Null o ausente = solo manda el tick. Lo
   * aplica la única puerta de redondeo (`roundPriceForSide`) para que el precio
   * que planifica la estrategia y el que envía el adaptador sean el mismo; si
   * no, el reconciliador ve dos precios distintos y cancela y recoloca la orden
   * en cada tick (001/F-04).
   */
  maxSignificantDigits?: number | null;
  /**
   * Tasa de margen de mantenimiento del mercado (fracción: 0,0125 = 1,25 %).
   * Hyperliquid: la mitad del margen inicial al apalancamiento máximo; Lighter:
   * `maintenance_margin_fraction`. Null o ausente = se deriva del apalancamiento
   * máximo con la regla de Hyperliquid (`maintenanceMarginRateOf`). Antes la
   * estimación usaba un 0,5 % plano, optimista en altcoins (001/F-93).
   */
  maintenanceMarginRate?: number | null;
}

export interface Ticker {
  venue: Venue;
  symbol: string;
  /** Último precio negociado. */
  last: string;
  bid: string;
  ask: string;
  /** Precio de marca: el que usa el venue para liquidar. Es el que manda en riesgo. */
  mark: string;
  ts: number;

  // ── Lo que no todos los venues publican ────────────────────────────────
  //
  // Los cuatro son OPCIONALES y `undefined` significa «este venue no lo
  // publica», nunca cero. La diferencia importa: `bidSize: '0'` es un libro sin
  // compradores —un estado real— y `undefined` es no saberlo. Colapsarlos
  // obligaría a cada consumidor a adivinar cuál de los dos está viendo.
  //
  // Ninguno cuesta una petición nueva: salen de respuestas que el adaptador ya
  // pide (spec 038).

  /**
   * Cantidad en el mejor bid, en moneda base.
   *
   * Con `askSize`, es lo que permite calcular el MICROPRECIO
   * —`(ask·Q_bid + bid·Q_ask)/(Q_bid+Q_ask)`— y el desequilibrio del toque. El
   * punto medio pelado ignora los tamaños, así que cotiza igual con el libro
   * cargado de compradores que de vendedores.
   *
   * Hyperliquid y Aster sí; Lighter no lo publica en `market_stats`, y sacarlo
   * costaría una petición por símbolo y tick contra un cupo de 60/min por IP.
   */
  bidSize?: string;
  /** Cantidad en el mejor ask, en moneda base. Ver `bidSize`. */
  askSize?: string;

  /**
   * Tasa de funding vigente, en FRACCIÓN por periodo y CON SIGNO.
   *
   * Positivo = los largos pagan a los cortos. En un perpetuo el inventario no
   * solo tiene riesgo de precio: cobra o paga cada periodo, y ese es el segundo
   * canal económico que una estrategia puede querer mirar.
   */
  fundingRate?: string;
  /**
   * Instante del próximo pago de funding, en epoch ms.
   *
   * Absoluto y no «cuánto falta» a propósito: el ticker se cachea, se republica
   * por Redis con 30 s de vida y lo lee un tick posterior, así que un delta
   * llegaría caducado por construcción.
   *
   * Hyperliquid no lo publica en su contexto de activo, así que allí queda
   * `undefined`: el funding es horario, pero deducir la hora en punto sería
   * inventarse un dato que el venue no da.
   */
  nextFundingAt?: number;
}

export interface Balance {
  asset: string;
  total: string;
  available: string;
  /** Margen inmovilizado por posiciones y órdenes abiertas. */
  used: string;
  /**
   * Del MISMO activo, lo que está en la cuenta de SPOT y por tanto no respalda
   * ninguna posición de perpetuos. Ausente si no se sabe o si es cero.
   *
   * No se suma nunca a `total` ni a `available`: es una PISTA para explicar un
   * saldo operable de cero, no capital. Un usuario deposita, ve «0,00 USDC
   * disponibles» y no tiene forma de saber que su dinero está en el otro
   * bolsillo del mismo exchange (spec 028).
   */
  spot?: string;
}

export interface Position {
  venue: Venue;
  symbol: string;
  /** Firmada: positiva = long, negativa = short, 0 = plana. */
  qty: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  leverage: number;
  marginMode: string;
  /** null cuando el venue no lo expone o la posición es plana. */
  liquidationPrice: string | null;
  marginUsed: string;
}
