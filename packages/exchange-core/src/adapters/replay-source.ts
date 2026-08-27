import { EMPTY, Observable, Subject } from 'rxjs';
import {
  ExchangeError,
  type Balance,
  type Candle,
  type CandleInterval,
  type Fill,
  type MarginMode,
  type MarketSpec,
  type MarketTicker,
  type OrderAck,
  type OrderUpdate,
  type Position,
  type Ticker,
  type Venue,
  type VenueCapabilities,
  type VenueOrder,
} from '@crypton/shared';
import { VENUE_CAPABILITIES } from '../capabilities';
import type { ExchangeAdapter, StreamHealth } from '../types';

/**
 * Fuente de precios de MEMORIA, para envolverla en `DryRunAdapter`.
 *
 * Resuelve un bloqueo muy concreto: el simulador casa órdenes en reposo dentro
 * de `matchRestingOrders`, que es privado y solo se alcanza a través de
 * `getTicker`/`streamTicker` — y esos delegan en su fuente, o sea, en la red.
 * Para reproducir un rango histórico hace falta empujarle precios sin que haya
 * red por debajo, y eso es exactamente lo que hace esta clase.
 *
 * El `venue` NO es decorativo: `DryRunAdapter` toma de ahí el códec de
 * `clientOrderId` (`codecFor(source.venue)`), y es contra esa codificación
 * contra la que `reconcile` compara. Un replay con el venue equivocado
 * reconciliaría en un espacio de ids que no es el del bot.
 *
 * Todo lo que no sea leer precios RECHAZA en vez de devolver vacío. Es
 * deliberado: si algún día el motor de replay llama por error a `placeOrder` de
 * la fuente en lugar de al simulador, hay que enterarse en un test, no obtener
 * un cero en silencio y un resultado que parece bueno.
 */
export class ReplaySourceAdapter implements ExchangeAdapter {
  readonly capabilities: VenueCapabilities;

  private readonly ticker$ = new Subject<Ticker>();
  private current: Ticker | null = null;

  constructor(
    readonly venue: Venue,
    private readonly market: MarketSpec,
  ) {
    this.capabilities = VENUE_CAPABILITIES[venue];
  }

  /** Empuja el siguiente precio. Es todo lo que mueve la simulación. */
  setTicker(ticker: Ticker): void {
    this.current = ticker;
    this.ticker$.next(ticker);
  }

  getTicker(): Promise<Ticker> {
    if (!this.current) {
      return Promise.reject(new ExchangeError('RULES', 'El replay aún no ha fijado ningún precio.'));
    }
    return Promise.resolve(this.current);
  }

  /**
   * El replay NO usa flujos: empuja los precios uno a uno y de forma síncrona.
   *
   * Devolver el sujeto sería peor que devolver vacío. `DryRunAdapter.streamTicker`
   * se suscribe a su fuente para casar órdenes en cada tick, así que cada precio
   * se casaría DOS veces: una por la suscripción y otra por el `getTicker`
   * explícito del bucle.
   */
  streamTicker(): Observable<Ticker> {
    return EMPTY;
  }

  getMarkets(): Promise<MarketSpec[]> {
    return Promise.resolve([this.market]);
  }

  streamOrders(): Observable<OrderUpdate> {
    return EMPTY;
  }
  streamFills(): Observable<Fill> {
    return EMPTY;
  }
  streamHealth(): Observable<StreamHealth> {
    return EMPTY;
  }

  close(): Promise<void> {
    this.ticker$.complete();
    return Promise.resolve();
  }

  // ── Todo lo demás no existe aquí ───────────────────────────────────────
  //
  // `DryRunAdapter` solo delega LECTURA en su fuente —capacidades, mercados,
  // ticker, velas, salud y cierre—, así que ninguno de estos se llama nunca. Si
  // alguno se llamara, es un fallo del motor de replay y tiene que doler.

  verify(): Promise<{ ok: boolean; publicRef: string }> {
    return this.no('verify');
  }
  getBalances(): Promise<Balance[]> {
    return this.no('getBalances');
  }
  getPositions(): Promise<Position[]> {
    return this.no('getPositions');
  }
  getOpenOrders(): Promise<VenueOrder[]> {
    return this.no('getOpenOrders');
  }
  getTickers(): Promise<MarketTicker[]> {
    return this.no('getTickers');
  }
  getCandles(_s: string, _i: CandleInterval): Promise<Candle[]> {
    return this.no('getCandles');
  }
  getRecentFills(): Promise<Fill[]> {
    return this.no('getRecentFills');
  }
  placeOrder(): Promise<OrderAck> {
    return this.no('placeOrder');
  }
  cancelOrder(): Promise<void> {
    return this.no('cancelOrder');
  }
  cancelOwn(): Promise<void> {
    return this.no('cancelOwn');
  }
  cancelAll(): Promise<void> {
    return this.no('cancelAll');
  }
  setLeverage(_s: string, _l: number, _m: MarginMode): Promise<void> {
    return this.no('setLeverage');
  }

  private no<T>(metodo: string): Promise<T> {
    return Promise.reject(
      new ExchangeError(
        'RULES',
        `La fuente de replay no implementa «${metodo}»: si el motor llega aquí, ` +
          'está pidiéndole al origen algo que le tocaba al simulador.',
        this.venue,
      ),
    );
  }
}
