import { Venue, venueKey, type OrderType } from '@crypton/shared';
import { sleep } from './rate-limit';
import { anotarCola, anotarConcesion, claveCaudal } from './caudal-metricas';
import { ASTER_ORDER_QUOTA, QUOTA_HEADROOM, VENUE_QUOTA_PER_MINUTE } from './venue-weights';

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
 *
 * · Y una reserva para las CRITICAS dentro de las escrituras. Un stop-loss
 *   competía de igual a igual con una recotización de un market maker, que
 *   manda 4 peticiones por capa y por tick: la orden que sostiene la posición
 *   perdía por volumen contra la que solo mejora el precio (spec 029).
 */

/**
 * `critical` es lo que no puede esperar: el stop-loss, los cierres y el pánico.
 * `write` es todo lo demás que escribe —cotizar, reponer una linea—, y `read`
 * lo que se puede posponer sin consecuencias.
 */
export type BudgetPriority = 'read' | 'write' | 'critical';

/**
 * La prioridad que le corresponde a una orden.
 *
 * Lleva disparador = sostiene la posición: el stop-loss y las condicionales de
 * cierre. Compiten con las recotizaciones de un market maker, que mandan cuatro
 * peticiones por capa y por tick, y perdían por volumen (spec 029).
 *
 * Una orden a mercado que solo reduce es un CIERRE —manual, de pánico o de una
 * estrategia— y tampoco puede esperar; antes competía como una escritura más
 * (spec 057, F-10). Una límite que reduce sí puede: es un objetivo, y los
 * market makers en alto riesgo las mandan por capas.
 */
export const prioridadDeOrden = (req: {
  triggerPrice?: string;
  type?: OrderType;
  reduceOnly?: boolean;
}): BudgetPriority =>
  req.triggerPrice || (req.type === 'MARKET' && req.reduceOnly === true) ? 'critical' : 'write';

/**
 * Lo que el venue dice haber contado de nosotros (y de cualquier otro cliente
 * de la misma IP) en la ventana en curso. Aster lo devuelve en cabeceras con
 * cada respuesta (001/F-76). Todo opcional: cada venue publica lo que publica.
 */
export interface BudgetObservation {
  /** `X-MBX-USED-WEIGHT-1M`: peso consumido en el minuto en curso. */
  usedWeightPerMinute?: number;
  /** `X-MBX-ORDER-COUNT-1M`: órdenes contadas en el minuto en curso. */
  ordersPerMinute?: number;
  /** `X-MBX-ORDER-COUNT-10S`: órdenes contadas en los diez segundos en curso. */
  ordersPer10s?: number;
}

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

  /**
   * Espera hasta poder COLOCAR `n` órdenes y las consume del cupo de órdenes.
   * Solo Aster publica uno (`ASTER_ORDER_QUOTA`); en los demás venues no hace
   * nada. Opcional para que los dobles de test y `NO_BUDGET` sigan valiendo.
   */
  takeOrders?(venue: Venue, n: number, testnet: boolean): Promise<void>;

  /**
   * Realimenta los depósitos con lo que el venue dice haber contado: nunca los
   * amplía, solo los recorta a lo que queda de verdad. Es lo que hace que el
   * presupuesto deje de ir a ciegas frente a otros clientes de la misma IP
   * (la API y el worker comparten salida) y frente a un contador que no está
   * alineado con el nuestro.
   */
  observe?(venue: Venue, testnet: boolean, lectura: BudgetObservation): void;
}

export interface VenueBudgetOptions {
  /** Peso por segundo que se puede gastar en cada venue. */
  ratePerSecond?: Partial<Record<Venue, number>>;
  /**
   * Ráfaga máxima acumulable, en múltiplos del caudal por segundo.
   *
   * La fija `capacidadDe`, que la topa en lo que el cupo del venue permite. NO
   * es variable de entorno a propósito: la API y el worker comparten depósito
   * en Redis, y el script recorta el saldo a la capacidad de QUIEN pregunta, así
   * que un proceso con la ráfaga vieja limitaría a los demás en silencio y para
   * siempre. El número viaja con la versión del paquete (spec 065).
   */
  burstSeconds?: number;
  /** Fracción del presupuesto reservada a escrituras (0 a 1). */
  writeReserve?: number;
  /** Parte del depósito que solo pueden gastar las peticiones críticas. */
  criticalReserve?: number;
  /**
   * Cuánto tiene que esperar una petición para subir una clase en la cola.
   *
   * Sin esto, un goteo continuo de escrituras —un market maker de muchas
   * capas— dejaría a las lecturas al final para siempre. Sube el ORDEN, nunca
   * el suelo: el suelo es una reserva de seguridad y no se presta (spec 065).
   */
  envejecimientoMs?: number;
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

/**
 * La capacidad del depósito, con su techo demostrable.
 *
 * Un depósito de fichas con caudal `r` y capacidad `C` puede gastar como mucho
 * `C + r·T` en cualquier ventana `T`. Con `T` = 60 s y `r = cupo·HEADROOM/60`,
 * no pasarse del cupo publicado exige:
 *
 *     C + cupo·HEADROOM <= cupo   <=>   C <= (1 - HEADROOM)·cupo
 *
 * Por eso la ráfaga se topa ahí y no se deja al capricho de `burstSeconds`: el
 * tope es lo que hace que subirla siga siendo seguro, y lo que impide que una
 * configuración distraída se lleve por delante la garantía.
 */
/**
 * Segundos de caudal que el depósito puede acumular.
 *
 * Seis, y no los dos del spec 020: aquel número se eligió cuando la lectura más
 * cara pesaba 2, y el canal con IA (spec 058) trajo ventanas de mil velas que
 * pesan 37. Con capacidad 34 y suelo de lectura 6,8, `need` se recortaba a la
 * capacidad entera: la lectura de velas exigía el depósito LLENO y lo dejaba en
 * −3 de deuda que pagaban durmiendo todas las demás. Con 6 ocupa el 36 %.
 *
 * El techo teórico es `60·(1/HEADROOM − 1)` = 10,6 s; se elige 6 para dejar
 * margen sobre el cupo real además del que ya da `QUOTA_HEADROOM`.
 */
const RAFAGA_POR_DEFECTO = 6;

export function capacidadDe(rate: number, burstSeconds: number, venue: Venue): number {
  const techo = (1 - QUOTA_HEADROOM) * VENUE_QUOTA_PER_MINUTE[venue];
  return Math.min(rate * burstSeconds, techo);
}

/**
 * Depósito de órdenes de Aster, derivado de sus DOS límites con el margen de
 * seguridad: el caudal es el del minuto (1200 × 0,85 / 60 = 17 por segundo) y
 * la capacidad la que garantiza que ninguna ventana de diez segundos pase de
 * 300 × 0,85: capacidad + 10 × caudal ≤ 255 → 85. Con un solo depósito de
 * caudal 17 y ráfaga de 300 se colaban 470 en diez segundos.
 */
const ORDER_RATE: Partial<Record<Venue, { rate: number; capacity: number }>> = (() => {
  const rate = (ASTER_ORDER_QUOTA.perMinute * QUOTA_HEADROOM) / 60;
  const capacity = Math.max(rate, ASTER_ORDER_QUOTA.per10Seconds * QUOTA_HEADROOM - 10 * rate);
  return { [Venue.ASTER]: { rate, capacity } };
})();

/** Lo que queda del cupo según el venue, como fracción del depósito (0 a 1). */
function fraccionRestante(usado: number | undefined, cupo: number): number | null {
  if (usado == null || !Number.isFinite(usado) || usado < 0) return null;
  return Math.max(0, 1 - usado / cupo);
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Orden entre clases: primero las críticas, luego las escrituras, luego las lecturas. */
const CLASE: Record<BudgetPriority, number> = { critical: 0, write: 1, read: 2 };

/** Lo mínimo que hace falta para ponerse en la cola, y lo único que decide el orden. */
interface EnCola {
  clase: number;
  llegada: number;
}

/** Lo que espera su turno en el depósito de memoria. */
interface Espera extends EnCola {
  /** El peso que se descuenta al conceder. */
  weight: number;
  /** Las fichas que hacen falta para concederla: peso más el suelo de su clase. */
  need: number;
  conceder: () => void;
}

/** Lo que espera su turno en el depósito de Redis. */
interface EsperaRedis extends EnCola {
  weight: number;
  floor: number;
  conceder: () => void;
  /** Qué hacer si Redis no responde: caer al depósito de memoria. */
  aMemoria: () => void;
}

/** Cada cuánto, como mucho, se vuelve a mirar el depósito. */
const ESPERA_MAX_MS = 5_000;
/** Y cada cuánto, como poco: sin suelo, un `setTimeout(0)` se comería la CPU. */
const ESPERA_MIN_MS = 20;

/** Cuánto tiene que esperar una petición para subir una clase en la cola. */
const ENVEJECIMIENTO_MS = 10_000;

/**
 * Ordena a los que esperan.
 *
 * Las **críticas van siempre delante**, sin excepción: un PANIC no puede
 * depender de cuánto lleve esperando nadie. Entre escrituras y lecturas manda
 * un PLAZO: la llegada más una penalización de `envejecimientoMs` si es lectura.
 *
 * El plazo, y no «subir de clase al envejecer», porque envejecer a todos a la
 * vez no cambia el orden relativo — las escrituras envejecían igual que las
 * lecturas y seguían pasando delante; medido, la lectura salía la última de
 * once. Con el plazo, una escritura solo adelanta a una lectura si llega dentro
 * de esa ventana; pasada la ventana, la lectura va primero. Así un goteo
 * continuo de escrituras —un market maker de muchas capas— no puede matar de
 * hambre a las lecturas, y lo que una lectura paga está ACOTADO (spec 065).
 *
 * Es ORDEN, no suelo: el suelo se calculó al encolar, con la prioridad de
 * verdad, y una reserva de seguridad no se presta.
 *
 * Se reordena en cada pasada y no al insertar porque el plazo se compara con el
 * reloj: lo que ahora va detrás, dentro de unos segundos va delante.
 */
function ordenarEsperas(cola: EnCola[], envejecimientoMs: number): void {
  const plazo = (e: EnCola): number =>
    e.llegada + Math.max(0, e.clase - CLASE.write) * envejecimientoMs;
  cola.sort((a, b) => {
    const criticaA = a.clase === CLASE.critical ? 0 : 1;
    const criticaB = b.clase === CLASE.critical ? 0 : 1;
    return criticaA - criticaB || plazo(a) - plazo(b) || a.llegada - b.llegada;
  });
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
  private readonly criticalReserve: number;
  private readonly envejecimientoMs: number;
  /** Los que esperan, por clave de depósito. Solo existe mientras haya alguien. */
  private readonly colas = new Map<string, Espera[]>();
  /** El despertador de cada cola: uno, no uno por durmiente. */
  private readonly relojes = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: VenueBudgetOptions = {}) {
    this.rate = { ...DEFAULT_RATE, ...(opts.ratePerSecond ?? {}) };
    this.burstSeconds = opts.burstSeconds ?? RAFAGA_POR_DEFECTO;
    this.writeReserve = opts.writeReserve ?? 0.2;
    this.criticalReserve = opts.criticalReserve ?? 0.1;
    this.envejecimientoMs = opts.envejecimientoMs ?? ENVEJECIMIENTO_MS;
  }

  async take(
    venue: Venue,
    weight: number,
    priority: BudgetPriority,
    testnet: boolean,
  ): Promise<void> {
    const rate = this.rate[venue] ?? 10;
    const capacity = capacidadDe(rate, this.burstSeconds, venue);
    // Una lectura no puede vaciar el depósito: se le corta antes, en el borde
    // de la reserva. Una escritura sí puede llegar hasta el fondo.
    // Cada prioridad se corta en un borde distinto: la lectura, la primera;
    // la escritura corriente, dejando intacta la reserva de las críticas; y la
    // crítica llega hasta el fondo del depósito.
    const floor =
      priority === 'critical'
        ? 0
        : priority === 'write'
          ? capacity * this.criticalReserve
          : capacity * this.writeReserve;
    const bucketKey = venueKey(venue, testnet);

    // El umbral de concesión se recorta a la capacidad del depósito: una
    // petición cuyo peso supere lo que el depósito puede llegar a contener
    // esperaría PARA SIEMPRE con la regla ingenua. Se concede con el depósito
    // lleno y el saldo queda en negativo — la deuda se amortiza con el tiempo,
    // que es exactamente cobrar su coste real sin sacrificar la vivacidad.
    const need = Math.min(weight + floor, capacity);

    const clave = claveCaudal(venue, testnet, priority);

    // Camino rápido: sin nadie esperando y con fichas de sobra, no se construye
    // ni un objeto. Es el 95 % de las llamadas y no debe pagar por la cola.
    if (!this.colas.has(bucketKey)) {
      const bucket = this.refill(bucketKey, rate, capacity);
      if (bucket.tokens >= need) {
        bucket.tokens -= weight;
        anotarConcesion(clave, 0);
        return;
      }
    }

    // Y si no hay fichas, se hace COLA, no carrera. Antes cada uno dormía por su
    // cuenta y competía al despertar, así que el que necesitaba más fichas
    // perdía siempre: la lectura de mil velas del canal con IA no llegaba nunca
    // mientras cuatro bots pedían precios baratos (spec 065).
    //
    // Sin tope de intentos: si el presupuesto está agotado hay que esperar, y
    // rendirse aquí solo convertiría una espera en un error que el motor
    // trataría como fallo del venue (specs 020/031).
    const empezado = Date.now();
    await new Promise<void>((conceder) => {
      const cola = this.colas.get(bucketKey) ?? [];
      cola.push({ weight, need, clase: CLASE[priority], llegada: empezado, conceder });
      this.colas.set(bucketKey, cola);
      anotarCola(clave, cola.length);
      this.servir(bucketKey, rate, capacity);
    });
    anotarConcesion(clave, Date.now() - empezado);
  }

  /**
   * El único servidor de una cola: concede lo que quepa y se vuelve a citar.
   *
   * Uno por clave de depósito, no uno por durmiente. Con la versión de Redis
   * esto es además lo que convierte treinta consultas por ciclo en una.
   */
  private servir(bucketKey: string, rate: number, capacity: number): void {
    const reloj = this.relojes.get(bucketKey);
    if (reloj !== undefined) clearTimeout(reloj);
    this.relojes.delete(bucketKey);

    const cola = this.colas.get(bucketKey);
    if (!cola || cola.length === 0) {
      this.colas.delete(bucketKey);
      return;
    }

    const bucket = this.refill(bucketKey, rate, capacity);
    ordenarEsperas(cola, this.envejecimientoMs);
    while (cola.length > 0 && bucket.tokens >= cola[0].need) {
      const espera = cola.shift()!;
      bucket.tokens -= espera.weight;
      espera.conceder();
    }

    if (cola.length === 0) {
      this.colas.delete(bucketKey);
      return;
    }

    const falta = cola[0].need - bucket.tokens;
    const ms = Math.min(ESPERA_MAX_MS, Math.max(ESPERA_MIN_MS, Math.ceil((falta / rate) * 1000)));
    const timer = setTimeout(() => this.servir(bucketKey, rate, capacity), ms);
    timer.unref?.();
    this.relojes.set(bucketKey, timer);
  }

  async takeOrders(venue: Venue, n: number, testnet: boolean): Promise<void> {
    const quota = ORDER_RATE[venue];
    if (!quota) return;
    const bucketKey = venueKey(venue, testnet) + ':orders';
    const need = Math.min(n, quota.capacity);
    for (;;) {
      const bucket = this.refill(bucketKey, quota.rate, quota.capacity);
      if (bucket.tokens >= need) {
        bucket.tokens -= n;
        return;
      }
      await sleep(Math.max(20, Math.ceil(((need - bucket.tokens) / quota.rate) * 1000)));
    }
  }

  observe(venue: Venue, testnet: boolean, lectura: BudgetObservation): void {
    const rate = this.rate[venue] ?? 10;
    const capacity = capacidadDe(rate, this.burstSeconds, venue);
    this.recortar(
      venueKey(venue, testnet),
      rate,
      capacity,
      fraccionRestante(lectura.usedWeightPerMinute, VENUE_QUOTA_PER_MINUTE[venue]),
    );
    const quota = ORDER_RATE[venue];
    if (!quota) return;
    const porMinuto = fraccionRestante(lectura.ordersPerMinute, ASTER_ORDER_QUOTA.perMinute);
    const porDiez = fraccionRestante(lectura.ordersPer10s, ASTER_ORDER_QUOTA.per10Seconds);
    const restante =
      porMinuto == null ? porDiez : porDiez == null ? porMinuto : Math.min(porMinuto, porDiez);
    this.recortar(venueKey(venue, testnet) + ':orders', quota.rate, quota.capacity, restante);
  }

  /** Recorta un depósito a la fracción que el venue dice que queda; nunca lo amplía. */
  private recortar(
    bucketKey: string,
    rate: number,
    capacity: number,
    fraccion: number | null,
  ): void {
    if (fraccion == null) return;
    const bucket = this.refill(bucketKey, rate, capacity);
    bucket.tokens = Math.min(bucket.tokens, capacity * fraccion);
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

/**
 * Recorte del depósito a lo que el venue dice que queda (`observe`). Solo baja:
 * un depósito por encima de la cota se pone en ella; uno por debajo se deja.
 */
const CLAMP_SCRIPT = `
local key = KEYS[1]
local cap = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local data = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(data[1])
if tokens == nil or tokens > cap then
  redis.call('HSET', key, 'tokens', cap, 'at', now)
  redis.call('PEXPIRE', key, 60000)
end
return 0`;

export class RedisVenueBudget implements VenueBudget {
  private readonly rate: Record<Venue, number>;
  private readonly burstSeconds: number;
  private readonly writeReserve: number;
  private readonly criticalReserve: number;
  private readonly envejecimientoMs: number;
  private readonly fallback: MemoryVenueBudget;
  /** Los que esperan, por clave de depósito. */
  private readonly colas = new Map<string, EsperaRedis[]>();
  /** Las claves que ya tienen servidor en marcha. */
  private readonly sirviendo = new Set<string>();
  /** Cómo interrumpir el descanso del servidor de cada clave. */
  private readonly despertadores = new Map<string, () => void>();

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
    this.burstSeconds = opts.burstSeconds ?? RAFAGA_POR_DEFECTO;
    this.writeReserve = opts.writeReserve ?? 0.2;
    this.criticalReserve = opts.criticalReserve ?? 0.1;
    this.envejecimientoMs = opts.envejecimientoMs ?? ENVEJECIMIENTO_MS;
    this.fallback = new MemoryVenueBudget(opts);
  }

  async take(
    venue: Venue,
    weight: number,
    priority: BudgetPriority,
    testnet: boolean,
  ): Promise<void> {
    const rate = this.rate[venue] ?? 10;
    const capacity = capacidadDe(rate, this.burstSeconds, venue);
    // Cada prioridad se corta en un borde distinto: la lectura, la primera;
    // la escritura corriente, dejando intacta la reserva de las críticas; y la
    // crítica llega hasta el fondo del depósito.
    const floor =
      priority === 'critical'
        ? 0
        : priority === 'write'
          ? capacity * this.criticalReserve
          : capacity * this.writeReserve;
    // `venueKey` no pone sufijo en mainnet, así que la clave de mainnet sigue
    // siendo la de siempre: al desplegar no se pierde el saldo acumulado ni se
    // abre una ventana en la que nadie está limitando.
    const key = `crypton:budget:${this.egressId}:${venueKey(venue, testnet)}`;

    // Igual que en memoria: COLA, no carrera. Y aquí hay una razón más, propia
    // de Redis: antes cada durmiente evaluaba el script por su cuenta cada
    // veinte milisegundos, así que treinta esperas eran hasta mil quinientos
    // EVAL por segundo contra el mismo Redis que sostiene los leases del motor
    // (invariante 10). Ahora solo habla con Redis la CABEZA (spec 065).
    const clave = claveCaudal(venue, testnet, priority);
    const empezado = Date.now();
    // Si Redis cae, la concesión la anota el depósito de memoria al servirla:
    // contarla aquí también la duplicaría.
    let delegado = false;
    await new Promise<void>((conceder, fallar) => {
      const cola = this.colas.get(key) ?? [];
      cola.push({
        weight,
        floor,
        clase: CLASE[priority],
        llegada: empezado,
        conceder,
        aMemoria: () => {
          delegado = true;
          this.fallback.take(venue, weight, priority, testnet).then(() => conceder(), fallar);
        },
      });
      this.colas.set(key, cola);
      anotarCola(clave, cola.length);
      // Quien llega con más prioridad que la cabeza no espera a que venza el
      // descanso del servidor. Sin esto, una cancelación que aparece mientras
      // el servidor duerme —hasta cinco segundos— esperaría detrás de las
      // lecturas que ya estaban, y eso es el camino de un PANIC.
      if (cola.length > 1 && CLASE[priority] < Math.min(...cola.slice(0, -1).map((e) => e.clase))) {
        this.despertadores.get(key)?.();
      }
      void this.servir(key, rate, capacity);
    });
    if (!delegado) anotarConcesion(clave, Date.now() - empezado);
  }

  /** El único que habla con Redis por clave de depósito. */
  private async servir(key: string, rate: number, capacity: number): Promise<void> {
    if (this.sirviendo.has(key)) return;
    this.sirviendo.add(key);
    try {
      for (;;) {
        const cola = this.colas.get(key);
        if (!cola || cola.length === 0) {
          this.colas.delete(key);
          return;
        }
        ordenarEsperas(cola, this.envejecimientoMs);
        const cabeza = cola[0];

        let waitMs: number;
        try {
          waitMs = Number(
            await this.redis.eval(TAKE_SCRIPT, {
              keys: [key],
              arguments: [
                String(rate),
                String(capacity),
                String(cabeza.weight),
                String(cabeza.floor),
                String(Date.now()),
              ],
            }),
          );
        } catch {
          // Redis caído: se limita en memoria. Limitar de más en un proceso es
          // recuperable; dejar de limitar acaba en un veto del venue por IP.
          // Pasan TODOS los que esperaban, no solo la cabeza.
          const pendientes = cola.splice(0);
          this.colas.delete(key);
          for (const espera of pendientes) espera.aMemoria();
          return;
        }

        if (waitMs <= 0) {
          cola.shift();
          cabeza.conceder();
          continue;
        }
        await this.descansar(key, Math.min(ESPERA_MAX_MS, Math.max(ESPERA_MIN_MS, waitMs)));
      }
    } finally {
      this.sirviendo.delete(key);
    }
  }

  /** Un descanso que una crítica puede interrumpir. */
  private descansar(key: string, ms: number): Promise<void> {
    return new Promise<void>((seguir) => {
      const timer = setTimeout(() => {
        this.despertadores.delete(key);
        seguir();
      }, ms);
      timer.unref?.();
      this.despertadores.set(key, () => {
        clearTimeout(timer);
        this.despertadores.delete(key);
        seguir();
      });
    });
  }

  async takeOrders(venue: Venue, n: number, testnet: boolean): Promise<void> {
    const quota = ORDER_RATE[venue];
    if (!quota) return;
    const key = `crypton:budget:${this.egressId}:${venueKey(venue, testnet)}:orders`;
    for (;;) {
      let waitMs: number;
      try {
        waitMs = Number(
          await this.redis.eval(TAKE_SCRIPT, {
            keys: [key],
            arguments: [
              String(quota.rate),
              String(quota.capacity),
              String(n),
              '0',
              String(Date.now()),
            ],
          }),
        );
      } catch {
        return this.fallback.takeOrders(venue, n, testnet);
      }
      if (waitMs <= 0) return;
      await sleep(Math.max(20, Math.min(waitMs, 5000)));
    }
  }

  observe(venue: Venue, testnet: boolean, lectura: BudgetObservation): void {
    // Sin esperar: es una pista para el depósito, no una puerta. Si Redis no
    // responde, recorta el de memoria, que es el que se usa cuando Redis falla.
    this.fallback.observe(venue, testnet, lectura);
    const rate = this.rate[venue] ?? 10;
    const capacity = capacidadDe(rate, this.burstSeconds, venue);
    const base = `crypton:budget:${this.egressId}:${venueKey(venue, testnet)}`;
    const recortes: [string, number | null, number][] = [
      [
        base,
        fraccionRestante(lectura.usedWeightPerMinute, VENUE_QUOTA_PER_MINUTE[venue]),
        capacity,
      ],
    ];
    const quota = ORDER_RATE[venue];
    if (quota) {
      const porMinuto = fraccionRestante(lectura.ordersPerMinute, ASTER_ORDER_QUOTA.perMinute);
      const porDiez = fraccionRestante(lectura.ordersPer10s, ASTER_ORDER_QUOTA.per10Seconds);
      const restante =
        porMinuto == null ? porDiez : porDiez == null ? porMinuto : Math.min(porMinuto, porDiez);
      recortes.push([base + ':orders', restante, quota.capacity]);
    }
    for (const [key, fraccion, cap] of recortes) {
      if (fraccion == null) continue;
      void this.redis
        .eval(CLAMP_SCRIPT, {
          keys: [key],
          arguments: [String(cap * fraccion), String(Date.now())],
        })
        .catch(() => undefined);
    }
  }
}

/** Presupuesto que no limita nada. Para tests y para el simulador. */
export const NO_BUDGET: VenueBudget = {
  take: () => Promise.resolve(),
};
