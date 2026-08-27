import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CANDLE_INTERVALS, Venue, type CandleInterval } from '@crypton/shared';
import { BUS_CHANNELS, BusService } from '../libs';
import { MarketDataService } from './market-data.service';

/**
 * Mantiene vivas las suscripciones de los símbolos que alguien está MIRANDO.
 *
 * Hasta ahora este feed solo lo usaban los bots: un símbolo tenía suscripción
 * porque había un bot operándolo. Los usuarios miran pares en los que no tienen
 * ningún bot, así que la API dice por el bus qué está mirando la gente y aquí
 * se abre y se cierra la suscripción al venue en consecuencia.
 *
 * El contador de referencias de `MarketDataService` hace el trabajo pesado: dos
 * mil usuarios mirando BTC son UNA suscripción, y si además hay un bot en BTC
 * es la misma. Este servicio solo aporta un interés más al mismo contador.
 *
 * Reconciliación contra el conjunto COMPLETO, nunca altas y bajas. Pub/sub no
 * garantiza entrega, y con incrementos un mensaje perdido deja una suscripción
 * abierta para siempre —o una pantalla muda sin forma de recuperarse—. Con el
 * conjunto entero, el siguiente mensaje corrige cualquier deriva.
 */
@Injectable()
export class MarketWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketWatchService.name);

  /**
   * Lo reservado POR CADA RÉPLICA de la API que habla, no en un conjunto único.
   *
   * Con varias réplicas —que es el escenario para el que está pensado todo lo
   * demás de este proyecto: los `setnx` de los crons están ahí por eso— cada
   * una publica lo que miran SUS conexiones. Con un solo conjunto, el mensaje
   * de la réplica A soltaría lo de la B, el siguiente de B soltaría lo de A, y
   * los WebSockets del venue se abrirían y cerrarían varias veces por segundo
   * para siempre.
   *
   * Guardado por origen, lo que se mantiene es la UNIÓN, que es lo correcto: si
   * dos réplicas miran BTC son dos referencias sobre la misma suscripción, y
   * hace falta que las dos lo suelten para cerrarla.
   */
  private readonly byOrigin = new Map<
    string,
    { pairs: Set<string>; candles: Set<string>; testnet: boolean; at: number }
  >();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus: BusService,
    private readonly marketData: MarketDataService,
  ) {}

  async onModuleInit(): Promise<void> {
    const watch$ = await this.bus.listenPublic<{
      symbols?: unknown;
      candles?: unknown;
      symbolsTest?: unknown;
      candlesTest?: unknown;
    }>(BUS_CHANNELS.MARKET_WATCH);
    watch$.subscribe((message) => {
      // Todo el manejador va dentro de un `try`.
      //
      // No es celo: lo que se lanza dentro del `next` de un Observable no lo
      // recoge nadie —RxJS lo relanza fuera del ciclo— y en un proceso de Node
      // eso es una excepción no capturada, o sea el MOTOR DE LOS BOTS abajo.
      // Un mensaje raro en un canal de Redis no puede tener ese poder.
      try {
        // Llega de otro proceso: se comprueba la forma en vez de confiar en el
        // tipo, que aquí no es más que una promesa del emisor.
        const raw = message.data?.symbols;
        if (!Array.isArray(raw)) return;
        // `candles` puede faltar —una API sin actualizar todavía no lo manda— y
        // eso se trata como conjunto vacío: es la única lectura segura. Lo mismo
        // vale para las dos listas de testnet, que llegaron después.
        const velas = message.data?.candles;
        const origen = message.origin ?? 'anonimo';
        this.apply(origen, strings(raw), setOf(velas), false);

        // Las dos redes se llevan como si fueran dos réplicas distintas: mismo
        // origen, sufijo distinto. Es lo que hace que la unión y el barrido
        // sigan siendo correctos sin tocar `apply`, y sobre todo que declarar
        // interés en una red no suelte lo que se mira en la otra.
        const testnet = message.data?.symbolsTest;
        this.apply(
          `${origen}|t`,
          Array.isArray(testnet) ? strings(testnet) : new Set<string>(),
          setOf(message.data?.candlesTest),
          true,
        );
      } catch (e) {
        this.logger.warn(`Mensaje de interes ilegible: ${(e as Error).message}`);
      }
    });

    // Una réplica que deja de hablar se olvida.
    //
    // Sin esto, una API que se reinicia —o que se cae— dejaría abiertas las
    // suscripciones al venue de lo que miraba su gente, y nadie las volvería a
    // soltar nunca: el worker no tiene forma de enterarse de que ya no hay
    // nadie al otro lado. Cada réplica repite su conjunto cada 5 s, así que
    // 15 s son tres latidos: se pueden perder dos seguidos sin soltar nada.
    this.sweeper = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.logger.log('Escuchando que simbolos mira la aplicacion');
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const [origin, entry] of [...this.byOrigin])
      this.apply(origin, new Set(), new Set(), entry.testnet);
  }

  /**
   * Ajusta lo que tiene reservado UNA réplica. Las demás no se tocan.
   *
   * Dos dimensiones y el mismo trato para las dos: precios por par, y velas por
   * par Y resolución. Se separan porque la unidad de suscripción del venue es
   * distinta —diez usuarios en BTC comparten un ticker, pero uno en 1h y otro
   * en 1m son dos series de velas— y mezclarlas soltaría una al declarar la
   * otra.
   */
  private apply(
    origin: string,
    wanted: Set<string>,
    wantedCandles: Set<string>,
    testnet: boolean,
  ): void {
    const previo = this.byOrigin.get(origin);
    const held = previo?.pairs ?? new Set<string>();
    const heldCandles = previo?.candles ?? new Set<string>();

    for (const pair of held) {
      if (wanted.has(pair)) continue;
      const parsed = split(pair);
      if (parsed) this.marketData.release(parsed.venue, parsed.symbol, testnet);
    }

    const kept = new Set<string>();
    for (const pair of wanted) {
      if (held.has(pair)) {
        kept.add(pair);
        continue;
      }
      const parsed = split(pair);
      if (!parsed) continue;
      // El Observable que devuelve no se usa: los precios salen al bus desde
      // `publish()`, dentro del propio servicio. Lo que hace falta de esta
      // llamada es el CONTADOR —que es lo que mantiene viva la suscripción al
      // venue— y por eso hay un `release` exacto para cada una.
      this.marketData.subscribe(parsed.venue, parsed.symbol, testnet);
      kept.add(pair);
    }

    for (const serie of heldCandles) {
      if (wantedCandles.has(serie)) continue;
      const parsed = splitCandle(serie);
      if (parsed)
        this.marketData.releaseCandles(parsed.venue, parsed.symbol, parsed.interval, testnet);
    }

    const keptCandles = new Set<string>();
    for (const serie of wantedCandles) {
      if (heldCandles.has(serie)) {
        keptCandles.add(serie);
        continue;
      }
      const parsed = splitCandle(serie);
      if (!parsed) continue;
      // Solo se anota si el venue LO SIRVE. Hoy lo sirven los tres, pero eso lo
      // decide el adaptador y no esta lista: si alguno dejara de servirlo,
      // apuntar su interés dejaría una reserva que nunca entrega nada y que
      // luego habría que soltar; la pantalla ya compone la vela desde el
      // precio en ese caso.
      if (this.marketData.subscribeCandles(parsed.venue, parsed.symbol, parsed.interval, testnet)) {
        keptCandles.add(serie);
      }
    }

    if (kept.size === 0 && keptCandles.size === 0) this.byOrigin.delete(origin);
    else this.byOrigin.set(origin, { pairs: kept, candles: keptCandles, testnet, at: Date.now() });
  }

  private sweep(): void {
    const cutoff = Date.now() - INTEREST_TTL_MS;
    for (const [origin, entry] of [...this.byOrigin]) {
      if (entry.at >= cutoff) continue;
      this.logger.warn(
        `Sin noticias de ${origin}: se sueltan ${entry.pairs.size} simbolos y ` +
          `${entry.candles.size} series de velas`,
      );
      this.apply(origin, new Set(), new Set(), entry.testnet);
    }
  }
}

/** Cada cuánto se comprueba qué réplicas siguen vivas. */
const SWEEP_EVERY_MS = 5_000;

/** Sin noticias durante esto, se suelta lo suyo. Tres latidos de la API. */
const INTEREST_TTL_MS = 15_000;

const strings = (raw: unknown[]): Set<string> =>
  new Set(raw.filter((s): s is string => typeof s === 'string'));

/** Lo mismo, tolerando que el campo no venga: una API sin actualizar no lo manda. */
const setOf = (raw: unknown): Set<string> =>
  Array.isArray(raw) ? strings(raw) : new Set<string>();

/**
 * `VENUE:SIMBOLO`, con el venue comprobado contra el enum de verdad.
 *
 * La comprobación no es defensiva por gusto: sin ella, un venue desconocido
 * llegaba hasta `createPublicAdapter`, que busca sus credenciales vacías en un
 * mapa por clave y revienta con un `TypeError` al no encontrarlas. Esto corre
 * dentro del manejador de un mensaje de Redis, en el proceso que opera los
 * bots: una cadena rara en un canal público no puede tirar eso.
 */
function split(pair: string): { venue: Venue; symbol: string } | null {
  const cut = pair.indexOf(':');
  if (cut <= 0) return null;
  const venue = pair.slice(0, cut);
  const symbol = pair.slice(cut + 1);
  if (!symbol || !(venue in Venue)) return null;
  return { venue: venue as Venue, symbol };
}

/**
 * `VENUE:SIMBOLO:INTERVALO`.
 *
 * Se parte por el ÚLTIMO `:` y no por el segundo: ningún símbolo de los tres
 * venues lleva dos puntos hoy, pero apoyarse en eso haría que el día que uno lo
 * lleve esto empiece a suscribir a un par que no existe en silencio.
 */
function splitCandle(
  serie: string,
): { venue: Venue; symbol: string; interval: CandleInterval } | null {
  const cut = serie.lastIndexOf(':');
  if (cut <= 0) return null;
  const interval = serie.slice(cut + 1);
  if (!(CANDLE_INTERVALS as readonly string[]).includes(interval)) return null;
  const parsed = split(serie.slice(0, cut));
  return parsed ? { ...parsed, interval: interval as CandleInterval } : null;
}
