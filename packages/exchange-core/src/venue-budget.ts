import { Venue, venueKey } from '@crypton/shared';
import { sleep } from './rate-limit';
import { QUOTA_HEADROOM, VENUE_QUOTA_PER_MINUTE } from './venue-weights';

/**
 * Presupuesto de caudal por VENUE e IP.
 *
 * El limitador de la clase `RateLimiter` acota lo que manda un adaptador. Este
 * acota lo que manda el PROCESO entero —y, con el respaldo en Redis, lo que
 * mandan todos los procesos que salen por la misma IP—, que es el ámbito en el
 * que los DEX cuentan de verdad.
 *
 * La diferencia importa porque los límites no son por bot ni por adaptador:
 * Hyperliquid reparte 1200 de peso por minuto y por IP entre todo lo que salga
 * de ella. Con un limitador por bot, cien bots creían tener cada uno el
 * presupuesto entero y el venue empezaba a devolver 429 a todos a la vez.
 *
 * Dos detalles deliberados:
 *
 * · Se cuenta por PESO, no por llamada. Pedir el libro entero no cuesta lo
 *   mismo que preguntar el estado de la cuenta, y tratarlos igual significa o
 *   bien desperdiciar presupuesto o bien pasarse.
 *
 * · Hay una reserva para ESCRITURAS. Sin ella, una avalancha de lecturas
 *   —cientos de bots latiendo a la vez— podía dejar sin presupuesto justo a la
 *   cancelación de un pánico. Las lecturas se pueden posponer; cerrar una
 *   posición, no.
 */

export type BudgetPriority = 'read' | 'write';

export interface VenueBudget {
  /**
   * Espera hasta tener presupuesto para `weight` y lo consume.
   *
   * La RED forma parte del depósito, no solo el venue. Mainnet y testnet son
   * hosts distintos y cada uno lleva su propio contador en el venue, así que
   * compartir depósito no protegía de nada: solo hacía que leer un precio de
   * testnet le quitara caudal a un bot que está operando con dinero real. En
   * Lighter, donde el cupo son 60 peticiones por minuto, eso se nota enseguida.
   *
   * El CAUDAL sí se sigue buscando por venue: el cupo publicado es del venue y
   * es el mismo en sus dos redes.
   */
  take(venue: Venue, weight: number, priority: BudgetPriority, testnet: boolean): Promise<void>;
}

export interface VenueBudgetOptions {
  /** Peso por segundo que se puede gastar en cada venue. */
  ratePerSecond?: Partial<Record<Venue, number>>;
  /** Ráfaga máxima acumulable, en múltiplos del caudal por segundo. */
  burstSeconds?: number;
  /** Fracción del presupuesto reservada a escrituras (0 a 1). */
  writeReserve?: number;
}

/**
 * Caudal por defecto, DERIVADO del cupo que publica cada venue.
 *
 * Antes eran tres números escritos a mano —15, 10 y 20 por segundo— que no
 * salían de ninguna documentación. El de Lighter era el peor: 10 de peso por
 * segundo con lecturas contabilizadas como 2 dan 300 peticiones por minuto,
 * CINCO VECES el cupo documentado de 60, y por ahí se llegaba a la página del
 * cortafuegos.
 *
 * Ahora sale de `VENUE_QUOTA_PER_MINUTE`, con el margen de `QUOTA_HEADROOM`.
 * Cambiar el cupo de un venue se hace en un sitio y con la cita al lado.
 *
 * Ojo con la UNIDAD, que es donde esto se rompe sin avisar: cada venue cuenta
 * en la suya (`VENUE_QUOTA_UNIT`). Hyperliquid y Aster en PESO; Lighter en
 * PETICIONES. Quien llame a `take` tiene que pasar el coste en la unidad del
 * venue — para Lighter, `lighterCost()`, no `lighterWeight()`.
 *
 * La tabla `OPERATION_WEIGHT` que vivía aquí se ha ido entera. Estaba exportada
 * y no la leía NADIE: los pesos de verdad eran los números sueltos de cada
 * llamada. Los reales, por venue y por endpoint, están en `venue-weights.ts`.
 */
const DEFAULT_RATE: Record<Venue, number> = {
  [Venue.HYPERLIQUID]: perSecond(Venue.HYPERLIQUID),
  [Venue.LIGHTER]: perSecond(Venue.LIGHTER),
  [Venue.ASTER]: perSecond(Venue.ASTER),
};

function perSecond(venue: Venue): number {
  return (VENUE_QUOTA_PER_MINUTE[venue] * QUOTA_HEADROOM) / 60;
}

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Presupuesto en memoria: correcto cuando cada worker tiene su propia IP.
 *
 * Sirve además como respaldo si Redis no responde — es preferible limitar de
 * más en un solo proceso que dejar de limitar del todo.
 */
export class MemoryVenueBudget implements VenueBudget {
  /** Clave `venueKey(venue, testnet)`: un depósito por venue Y red. */
  private readonly buckets = new Map<string, Bucket>();
  private readonly rate: Record<Venue, number>;
  private readonly burstSeconds: number;
  private readonly writeReserve: number;

  constructor(opts: VenueBudgetOptions = {}) {
    this.rate = { ...DEFAULT_RATE, ...(opts.ratePerSecond ?? {}) };
    this.burstSeconds = opts.burstSeconds ?? 2;
    this.writeReserve = opts.writeReserve ?? 0.2;
  }

  async take(
    venue: Venue,
    weight: number,
    priority: BudgetPriority,
    testnet: boolean,
  ): Promise<void> {
    const rate = this.rate[venue] ?? 10;
    const capacity = rate * this.burstSeconds;
    // Una lectura no puede vaciar el depósito: se le corta antes, en el borde
    // de la reserva. Una escritura sí puede llegar hasta el fondo.
    const floor = priority === 'write' ? 0 : capacity * this.writeReserve;
    const bucketKey = venueKey(venue, testnet);

    // El umbral de concesión se recorta a la capacidad del depósito: una
    // petición cuyo peso supere lo que el depósito puede llegar a contener
    // esperaría PARA SIEMPRE con la regla ingenua. Se concede con el depósito
    // lleno y el saldo queda en negativo — la deuda se amortiza con el tiempo,
    // que es exactamente cobrar su coste real sin sacrificar la vivacidad.
    const need = Math.min(weight + floor, capacity);

    // Sin tope de intentos: si el presupuesto está agotado hay que esperar, y
    // rendirse aquí solo convertiría una espera en un error que el motor
    // trataría como fallo del venue.
    for (;;) {
      const bucket = this.refill(bucketKey, rate, capacity);
      if (bucket.tokens >= need) {
        bucket.tokens -= weight;
        return;
      }
      const falta = need - bucket.tokens;
      await sleep(Math.max(20, Math.ceil((falta / rate) * 1000)));
    }
  }

  private refill(bucketKey: string, rate: number, capacity: number): Bucket {
    const now = Date.now();
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = { tokens: capacity, at: now };
      this.buckets.set(bucketKey, bucket);
      return bucket;
    }
    const elapsed = (now - bucket.at) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * rate);
    bucket.at = now;
    return bucket;
  }
}

/** Lo mínimo que necesita el presupuesto de un cliente de Redis. */
export interface BudgetRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/**
 * Depósito de fichas en Redis: el presupuesto se comparte entre TODOS los
 * procesos que salgan por la misma IP.
 *
 * El script es atómico a propósito. Con un GET, una cuenta y un SET desde el
 * cliente, dos workers que consultaran a la vez verían el mismo saldo y ambos
 * se lo gastarían: el presupuesto compartido dejaría de serlo justo cuando más
 * hace falta, que es cuando hay concurrencia.
 *
 * Devuelve los milisegundos que hay que esperar (0 = concedido), en vez de
 * bloquear dentro de Redis: un script que duerme bloquea el servidor entero.
 */
const TAKE_SCRIPT = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local floor = tonumber(ARGV[4])
local now = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(data[1])
local at = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  at = now
end

local elapsed = (now - at) / 1000
if elapsed > 0 then
  tokens = math.min(capacity, tokens + elapsed * rate)
end

-- El umbral se recorta a la capacidad: un peso mayor que el depósito entero
-- esperaría para siempre con la regla ingenua. Se concede a depósito lleno y
-- el saldo queda en deuda, que el tiempo amortiza.
local need = math.min(weight + floor, capacity)

if tokens >= need then
  tokens = tokens - weight
  redis.call('HSET', key, 'tokens', tokens, 'at', now)
  redis.call('PEXPIRE', key, 60000)
  return 0
end

redis.call('HSET', key, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', key, 60000)
local falta = need - tokens
return math.ceil((falta / rate) * 1000)`;

export class RedisVenueBudget implements VenueBudget {
  private readonly rate: Record<Venue, number>;
  private readonly burstSeconds: number;
  private readonly writeReserve: number;
  private readonly fallback: MemoryVenueBudget;

  constructor(
    private readonly redis: BudgetRedis,
    /**
     * Identifica la salida a internet. Los procesos que compartan IP deben
     * compartir este valor: es lo que hace que compartan presupuesto.
     */
    private readonly egressId: string,
    opts: VenueBudgetOptions = {},
  ) {
    this.rate = { ...DEFAULT_RATE, ...(opts.ratePerSecond ?? {}) };
    this.burstSeconds = opts.burstSeconds ?? 2;
    this.writeReserve = opts.writeReserve ?? 0.2;
    this.fallback = new MemoryVenueBudget(opts);
  }

  async take(
    venue: Venue,
    weight: number,
    priority: BudgetPriority,
    testnet: boolean,
  ): Promise<void> {
    const rate = this.rate[venue] ?? 10;
    const capacity = rate * this.burstSeconds;
    const floor = priority === 'write' ? 0 : capacity * this.writeReserve;
    // `venueKey` no pone sufijo en mainnet, así que la clave de mainnet sigue
    // siendo la de siempre: al desplegar no se pierde el saldo acumulado ni se
    // abre una ventana en la que nadie está limitando.
    const key = `crypton:budget:${this.egressId}:${venueKey(venue, testnet)}`;

    for (;;) {
      let waitMs: number;
      try {
        waitMs = Number(
          await this.redis.eval(TAKE_SCRIPT, {
            keys: [key],
            arguments: [
              String(rate),
              String(capacity),
              String(weight),
              String(floor),
              String(Date.now()),
            ],
          }),
        );
      } catch {
        // Redis caído: se limita en memoria. Limitar de más en un proceso es
        // recuperable; dejar de limitar acaba en un veto del venue por IP.
        return this.fallback.take(venue, weight, priority, testnet);
      }

      if (waitMs <= 0) return;
      await sleep(Math.max(20, Math.min(waitMs, 5000)));
    }
  }
}

/** Presupuesto que no limita nada. Para tests y para el simulador. */
export const NO_BUDGET: VenueBudget = {
  take: () => Promise.resolve(),
};
