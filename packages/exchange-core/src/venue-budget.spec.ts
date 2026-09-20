/**
 * El presupuesto de caudal, visto desde lo que de verdad le pide la plataforma
 * (spec 065).
 *
 * Los tests que ya había viven en `exchange-core.spec.ts` y siguen ahí: estos
 * no los sustituyen, cubren lo que el canal con IA destapó — lecturas de peso
 * 37 contra un depósito de 34, y una cola que repartía por carrera.
 */
import { Venue } from '@crypton/shared';
import { sleep } from './rate-limit';
import { MemoryVenueBudget, RedisVenueBudget, capacidadDe, type BudgetRedis } from './venue-budget';
import { QUOTA_HEADROOM, VENUE_QUOTA_PER_MINUTE, hyperliquidWeight } from './venue-weights';

/** Las tres series del canal con IA, tal como las pide el motor (`barras + 2`). */
const PESO_ESTRUCTURA = hyperliquidWeight('candleSnapshot', 1002);
const PESO_REGIMEN = hyperliquidWeight('candleSnapshot', 482);

describe('capacidad del depósito (spec 065)', () => {
  /**
   * El defecto era `burstSeconds = 2`, elegido en el spec 020 cuando la lectura
   * más cara pesaba 2. El canal con IA trajo ventanas de mil velas, que pesan
   * 37: con capacidad 34 y suelo de lectura 6,8, `need = min(37 + 6,8; 34)`
   * exigía el depósito LLENO y lo dejaba en −3 de deuda, que pagaban durmiendo
   * todas las lecturas de todos los bots de esa IP.
   */
  it('una ventana de mil velas no exige el depósito lleno ni deja deuda', async () => {
    const budget = new MemoryVenueBudget();
    // Un worker vivo no tiene el depósito lleno nunca: alguien acaba de leer.
    await budget.take(Venue.HYPERLIQUID, 6, 'read', false);

    const empezado = Date.now();
    await budget.take(Venue.HYPERLIQUID, PESO_ESTRUCTURA, 'read', false);
    expect(Date.now() - empezado).toBeLessThan(100);

    // Y no deja deuda: un `l2Book` justo detrás tampoco espera.
    const detras = Date.now();
    await budget.take(Venue.HYPERLIQUID, 2, 'read', false);
    expect(Date.now() - detras).toBeLessThan(100);
  });

  /**
   * Las tres series juntas son 89 de peso, y esperar por ellas es el
   * presupuesto haciendo su trabajo: a 17/s son cinco segundos de caudal y la
   * ráfaga absorbe casi todo. Lo que NO era trabajo eran los tres segundos y
   * medio de antes, que salían de encadenar tres esperas a «depósito lleno» más
   * la deuda de −3 que dejaba la de mil velas.
   *
   * Medido: con la ráfaga de 2, 3557 ms; con la de 6, 442 ms.
   */
  it('las tres series de un bot del canal caben en menos de un segundo', async () => {
    const budget = new MemoryVenueBudget();
    const empezado = Date.now();
    await budget.take(Venue.HYPERLIQUID, hyperliquidWeight('candleSnapshot', 146), 'read', false);
    await budget.take(Venue.HYPERLIQUID, PESO_ESTRUCTURA, 'read', false);
    await budget.take(Venue.HYPERLIQUID, PESO_REGIMEN, 'read', false);
    expect(Date.now() - empezado).toBeLessThan(1000);
  });

  /**
   * El techo que hace seguro subir la ráfaga, y que blinda el número para
   * siempre. Un depósito de fichas con caudal `r` y capacidad `C` consume como
   * mucho `C + r·T` en cualquier ventana `T`. Con `T = 60 s`:
   *
   *   C + cupo × HEADROOM ≤ cupo   ⟺   C ≤ (1 − HEADROOM) × cupo
   */
  it('el depósito no puede pasarse del cupo del venue en una ventana de 60 s', () => {
    for (const venue of [Venue.HYPERLIQUID, Venue.LIGHTER, Venue.ASTER]) {
      const cupo = VENUE_QUOTA_PER_MINUTE[venue];
      const rate = (cupo * QUOTA_HEADROOM) / 60;
      const capacity = capacidadDe(rate, 6, venue);

      expect(capacity + rate * 60).toBeLessThanOrEqual(cupo);
      expect(capacity).toBeLessThanOrEqual((1 - QUOTA_HEADROOM) * cupo);
    }
  });

  it('y la capacidad de cada venue es la que dice el spec', () => {
    const de = (venue: Venue) =>
      capacidadDe((VENUE_QUOTA_PER_MINUTE[venue] * QUOTA_HEADROOM) / 60, 6, venue);

    expect(de(Venue.HYPERLIQUID)).toBeCloseTo(102, 6);
    expect(de(Venue.LIGHTER)).toBeCloseTo(5.1, 6);
    expect(de(Venue.ASTER)).toBeCloseTo(204, 6);
  });

  it('una ráfaga disparatada se topa en el cupo, no crece sin freno', () => {
    // La red por si alguien sube `burstSeconds` sin rehacer la aritmética.
    const rate = (VENUE_QUOTA_PER_MINUTE[Venue.HYPERLIQUID] * QUOTA_HEADROOM) / 60;
    expect(capacidadDe(rate, 600, Venue.HYPERLIQUID)).toBeCloseTo(180, 6);
  });

  it('la lectura más cara del canal sigue cabiendo con holgura', () => {
    const rate = (VENUE_QUOTA_PER_MINUTE[Venue.HYPERLIQUID] * QUOTA_HEADROOM) / 60;
    const capacity = capacidadDe(rate, 6, Venue.HYPERLIQUID);
    // Peso más suelo de lectura, que es lo que de verdad se le exige al depósito.
    expect(PESO_ESTRUCTURA + capacity * 0.2).toBeLessThan(capacity);
  });
});

describe('reparto del depósito: cola, no carrera (spec 065)', () => {
  /** Un depósito pequeño y previsible: 100 de caudal, ráfaga de 1, capacidad 100. */
  const pequeno = () =>
    new MemoryVenueBudget({ ratePerSecond: { [Venue.HYPERLIQUID]: 100 }, burstSeconds: 1 });

  /** Vacía el depósito con una escritura, que llega hasta el fondo. */
  const vaciar = (b: MemoryVenueBudget) => b.take(Venue.HYPERLIQUID, 95, 'write', false);

  /**
   * El titular del spec. El bucle de espera no tenía cola: los que esperaban
   * competían al despertar, y el que necesitaba más fichas perdía siempre
   * contra los que necesitaban pocas. Con un goteo de lecturas baratas —que es
   * lo que hacen cuatro bots latiendo— la lectura de velas no llegaba nunca.
   */
  it('una lectura cara no se muere de hambre entre lecturas baratas', async () => {
    const budget = pequeno();
    await vaciar(budget);

    const orden: string[] = [];
    const cara = budget.take(Venue.HYPERLIQUID, 70, 'read', false).then(() => orden.push('cara'));

    const baratas: Promise<void>[] = [];
    for (let i = 0; i < 12; i++) {
      baratas.push(
        new Promise<void>((listo) => {
          setTimeout(() => {
            void budget
              .take(Venue.HYPERLIQUID, 5, 'read', false)
              .then(() => orden.push(`barata${i}`))
              .then(() => listo());
          }, i * 30);
        }),
      );
    }

    await Promise.all([cara, ...baratas]);
    expect(orden[0]).toBe('cara');
  });

  /**
   * La reserva de las críticas era una condición de CONCESIÓN, no de orden: una
   * crítica pesada seguía perdiendo la carrera contra lecturas ligeras. Un
   * PANIC no puede depender de eso.
   */
  it('una crítica no espera detrás de una cola de lecturas', async () => {
    const budget = pequeno();
    await vaciar(budget);

    const orden: string[] = [];
    const lecturas = Array.from({ length: 20 }, (_, i) =>
      budget.take(Venue.HYPERLIQUID, 10, 'read', false).then(() => orden.push(`lectura${i}`)),
    );
    const critica = budget
      .take(Venue.HYPERLIQUID, 60, 'critical', false)
      .then(() => orden.push('critica'));

    await Promise.all([critica, ...lecturas]);
    expect(orden[0]).toBe('critica');
  });

  /**
   * Sin envejecimiento, un goteo de escrituras —un market maker de muchas
   * capas— dejaría a las lecturas al final de la cola para siempre. A los
   * `envejecimientoMs` una espera sube una clase A EFECTOS DE ORDEN; su suelo
   * NO cambia, porque el suelo es una reserva de seguridad y no se presta.
   */
  it('una lectura que lleva mucho esperando deja de ir detrás de cada escritura nueva', async () => {
    const budget = new MemoryVenueBudget({
      ratePerSecond: { [Venue.HYPERLIQUID]: 100 },
      burstSeconds: 1,
      envejecimientoMs: 100,
    });
    await vaciar(budget);

    const orden: string[] = [];
    const lectura = budget
      .take(Venue.HYPERLIQUID, 10, 'read', false)
      .then(() => orden.push('lectura'));

    const escrituras: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      escrituras.push(
        new Promise<void>((listo) => {
          setTimeout(() => {
            void budget
              .take(Venue.HYPERLIQUID, 10, 'write', false)
              .then(() => orden.push(`escritura${i}`))
              .then(() => listo());
          }, i * 40);
        }),
      );
    }

    await Promise.all([lectura, ...escrituras]);
    expect(orden[orden.length - 1]).not.toBe('lectura');
  });
});

describe('el presupuesto compartido en Redis (spec 065)', () => {
  /**
   * Un Redis de mentira que ejecuta la MISMA aritmética que `TAKE_SCRIPT`, para
   * poder contar consultas sin levantar nada.
   */
  class RedisDeMentira implements BudgetRedis {
    evals = 0;
    caido = false;
    private readonly deposito = new Map<string, { tokens: number; at: number }>();

    eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
      this.evals++;
      if (this.caido) return Promise.reject(new Error('Redis no responde'));
      const [key] = options.keys;
      const [rate, capacity, weight, floor, now] = options.arguments.map(Number);
      const previo = this.deposito.get(key) ?? { tokens: capacity, at: now };
      const tokens = Math.min(capacity, previo.tokens + ((now - previo.at) / 1000) * rate);
      const need = Math.min(weight + floor, capacity);
      if (tokens >= need) {
        this.deposito.set(key, { tokens: tokens - weight, at: now });
        return Promise.resolve(0);
      }
      this.deposito.set(key, { tokens, at: now });
      return Promise.resolve(Math.ceil(((need - tokens) / rate) * 1000));
    }
  }

  const opciones = { ratePerSecond: { [Venue.HYPERLIQUID]: 100 }, burstSeconds: 1 };

  /**
   * Antes, cada durmiente evaluaba el script por su cuenta cada veinte
   * milisegundos contra el mismo Redis que sostiene los leases del motor
   * (invariante 10). Treinta concesiones son treinta consultas como poco; lo
   * que se mide es que las ESPERAS no multipliquen eso.
   *
   * Medido con este mismo doble: el bucle de antes, 495 consultas; el servidor
   * único, 61.
   */
  it('treinta esperas son una consulta por ciclo, no treinta', async () => {
    const redis = new RedisDeMentira();
    const budget = new RedisVenueBudget(redis, 'test', opciones);
    await budget.take(Venue.HYPERLIQUID, 95, 'write', false);
    redis.evals = 0;

    await Promise.all(
      Array.from({ length: 30 }, () => budget.take(Venue.HYPERLIQUID, 10, 'read', false)),
    );

    expect(redis.evals).toBeLessThan(90);
  });

  it('con Redis caído no se deja de limitar: pasan todos al depósito de memoria', async () => {
    const redis = new RedisDeMentira();
    const budget = new RedisVenueBudget(redis, 'test', opciones);
    redis.caido = true;

    await expect(budget.take(Venue.HYPERLIQUID, 10, 'read', false)).resolves.toBeUndefined();
    // Y los que estaban esperando también salen, no se quedan colgados.
    redis.caido = false;
    const redis2 = new RedisDeMentira();
    const budget2 = new RedisVenueBudget(redis2, 'test', opciones);
    await budget2.take(Venue.HYPERLIQUID, 95, 'write', false);
    const esperando = Array.from({ length: 5 }, () =>
      budget2.take(Venue.HYPERLIQUID, 10, 'read', false),
    );
    redis2.caido = true;
    await expect(Promise.all(esperando)).resolves.toHaveLength(5);
  });

  it('una crítica interrumpe el descanso del servidor', async () => {
    const redis = new RedisDeMentira();
    const budget = new RedisVenueBudget(redis, 'test', opciones);
    await budget.take(Venue.HYPERLIQUID, 95, 'write', false);

    const orden: string[] = [];
    const lectura = budget
      .take(Venue.HYPERLIQUID, 60, 'read', false)
      .then(() => orden.push('lectura'));
    const critica = budget
      .take(Venue.HYPERLIQUID, 5, 'critical', false)
      .then(() => orden.push('critica'));

    await Promise.all([lectura, critica]);
    expect(orden[0]).toBe('critica');
  });
});

describe('el servidor de Redis no hace esperar a quien llega con más prioridad', () => {
  /**
   * El servidor duerme entre consultas. Una cancelación que aparece durante ese
   * descanso no puede quedarse detrás de las lecturas que ya estaban: es el
   * camino de un PANIC.
   *
   * El depósito empieza a medias a propósito: hay fichas de sobra para la
   * escritura (11) y no para la lectura (100), que es justo el escenario que
   * distingue «se despertó» de «esperó a que venciera el descanso».
   */
  class RedisMedioLleno implements BudgetRedis {
    private tokens = 50;
    private at = Date.now();

    eval(_s: string, o: { keys: string[]; arguments: string[] }): Promise<unknown> {
      const [rate, capacity, weight, floor, now] = o.arguments.map(Number);
      this.tokens = Math.min(capacity, this.tokens + ((now - this.at) / 1000) * rate);
      this.at = now;
      const need = Math.min(weight + floor, capacity);
      if (this.tokens >= need) {
        this.tokens -= weight;
        return Promise.resolve(0);
      }
      return Promise.resolve(Math.ceil(((need - this.tokens) / rate) * 1000));
    }
  }

  it('una escritura interrumpe el descanso que dejó una lectura', async () => {
    const budget = new RedisVenueBudget(new RedisMedioLleno(), 'test', {
      // El depósito arranca a 50 fichas: sobran para la escritura (necesita 19)
      // y no para la lectura (126), así que el servidor se duerme por ella.
      ratePerSecond: { [Venue.HYPERLIQUID]: 100 },
      burstSeconds: 10,
    });
    const orden: string[] = [];
    const lectura = budget
      .take(Venue.HYPERLIQUID, 90, 'read', false)
      .then(() => orden.push('lectura'));
    await sleep(20);
    const escritura = budget
      .take(Venue.HYPERLIQUID, 1, 'write', false)
      .then(() => orden.push('escritura'));

    const empezado = Date.now();
    await escritura;
    expect(orden).toEqual(['escritura']);
    expect(Date.now() - empezado).toBeLessThan(500);

    await lectura;
    expect(orden).toEqual(['escritura', 'lectura']);
  });
});
