import type { OrderSide, OrderStatus, OrderType, TimeInForce, Venue } from './enums';

/**
 * Orden tal y como el motor pide colocarla. `clientOrderId` es OBLIGATORIO: es
 * la clave de idempotencia y lo que permite que la reconciliación empareje lo
 * deseado con lo real sin depender del id que devuelva el venue.
 */
export interface PlaceOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  /** Requerido salvo en MARKET. */
  price?: string;
  qty: string;
  clientOrderId: string;
  timeInForce?: TimeInForce;
  /** Solo puede reducir la posición; nunca abre en sentido contrario. */
  reduceOnly?: boolean;
  /** Precio de disparo para stops. */
  triggerPrice?: string;
  /**
   * Sentido del disparo: 'SL' corta pérdidas, 'TP' realiza ganancias.
   *
   * OBLIGATORIO en la práctica cuando hay `triggerPrice`. Los tres venues
   * distinguen stop de take-profit y la dirección del disparo depende de ello;
   * el adaptador NO puede deducirla del lado y el reduce-only. De hecho lo
   * intentaba: en Hyperliquid, el stop-loss de un LONG (venta reduce-only con
   * disparo por debajo) se etiquetaba como 'tp', cuya condición —precio por
   * encima del disparo— ya era cierta al colocarlo, y el venue CERRABA LA
   * POSICIÓN AL INSTANTE en cuanto la orden entraba.
   */
  intent?: 'TP' | 'SL';
}

export interface OrderAck {
  clientOrderId: string;
  venueOrderId: string;
  status: OrderStatus;
  ts: number;
}

export interface CancelRequest {
  symbol: string;
  clientOrderId?: string;
  venueOrderId?: string;
}

export interface ModifyRequest {
  symbol: string;
  clientOrderId: string;
  venueOrderId?: string;
  price?: string;
  qty?: string;
}

/** Orden viva en el venue, normalizada. */
export interface VenueOrder {
  venue: Venue;
  symbol: string;
  clientOrderId: string | null;
  venueOrderId: string;
  side: OrderSide;
  type: OrderType;
  price: string;
  qty: string;
  filledQty: string;
  avgPrice: string | null;
  status: OrderStatus;
  reduceOnly: boolean;
  createdAt: number;
  /**
   * Precio de disparo si la orden es condicional (un stop-loss nativo), null o
   * ausente si es una orden en reposo. Sin él, un stop y una límite al mismo
   * precio eran indistinguibles en la frontera con el venue (001/F-29). Es
   * información, no una decisión: el reconciliador sigue emparejando por
   * `clientOrderId`.
   */
  triggerPrice?: string | null;
}

export type OrderUpdate = VenueOrder;

/**
 * Ejecución individual. `venueFillId` va con índice UNIQUE en BD: es lo que
 * hace que reprocesar el mismo mensaje de WebSocket no contabilice dos veces.
 */
export interface Fill {
  venue: Venue;
  symbol: string;
  venueFillId: string;
  venueOrderId: string;
  clientOrderId: string | null;
  side: OrderSide;
  price: string;
  qty: string;
  fee: string;
  feeAsset: string;
  /** true = pagó comisión de taker (cruzó el libro). */
  isTaker: boolean;
  ts: number;

  /**
   * La cerró el VENUE por liquidación, no nosotros.
   *
   * Una ejecución así no lleva el id de ninguna orden nuestra —esa orden no la
   * pusimos— así que el ledger no puede atribuirla por id y la descartaba: la
   * posición desaparecía del venue mientras la contabilidad del bot seguía
   * enseñando la de antes. Esta bandera es lo único que autoriza a atribuirla
   * por SÍMBOLO, y lo que la distingue de una ejecución que simplemente no
   * reconocemos —un movimiento a mano del usuario en el exchange, sin ir más
   * lejos— que no debe tocar la contabilidad de nadie.
   *
   * Opcional a propósito: sin ella, todo se comporta exactamente como siempre.
   */
  liquidation?: boolean;
}

/**
 * Clasificación de errores del venue. El motor reacciona distinto a cada una:
 * RETRYABLE reintenta con backoff, RULES corrige la orden y reintenta una vez,
 * FATAL pausa el bot y avisa. Sin esta distinción, un error de red y una clave
 * revocada se tratarían igual.
 */
/**
 * `THROTTLED` es aparte de `RETRYABLE` a propósito.
 *
 * Los dos se pueden reintentar, pero no igual: un timeout se reintenta en
 * milisegundos y un bloqueo del cortafuegos del venue NO se reintenta hasta que
 * pase su enfriamiento —60 s en Lighter, de 2 minutos a 3 días en Aster, y
 * escalando con la reincidencia—. Tratarlos igual es lo que convierte un corte
 * de un minuto en un veto de tres días: reintentar es exactamente lo que el
 * venue castiga.
 */
export type ExchangeErrorKind =
  'RETRYABLE' | 'THROTTLED' | 'RULES' | 'INSUFFICIENT_FUNDS' | 'AUTH' | 'FATAL';

export class ExchangeError extends Error {
  constructor(
    readonly kind: ExchangeErrorKind,
    message: string,
    readonly venue?: Venue,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}
