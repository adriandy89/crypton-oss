/**
 * Los dos carriles del limitador (spec 065).
 *
 * Los tests de siempre viven en `exchange-core.spec.ts` y siguen ahí: fijan el
 * carril ORDENADO, que es el que no puede cambiar porque sostiene los nonces.
 */
import { RateLimiter, sleep } from './rate-limit';

/** Cuenta cuántas llamadas hay dentro de `fn` a la vez. */
function contador() {
  const estado = { dentro: 0, maximo: 0, orden: [] as number[] };
  const trabajo = (n: number, ms: number) => async () => {
    estado.dentro++;
    estado.maximo = Math.max(estado.maximo, estado.dentro);
    await sleep(ms);
    estado.orden.push(n);
    estado.dentro--;
  };
  return { estado, trabajo };
}

describe('RateLimiter: el carril libre (spec 065)', () => {
  /**
   * El motivo de todo esto. `run` encadenaba `this.cola.then(fn)` y esperaba a
   * que `fn` TERMINASE antes de soltar la cola, así que una llamada que agota
   * el plazo del SDK —diez segundos en Hyperliquid— retenía a todas las de
   * detrás. Y como todos los bots simulados de un venue comparten una sola
   * fuente, y con ella un solo limitador, eso son todos los bots del venue.
   */
  it('una llamada colgada no retiene a las de detrás', async () => {
    const limiter = new RateLimiter(1000, { maxEnVuelo: 2 });
    let segundaEmpezoEn = 0;
    const empezado = Date.now();

    const lenta = limiter.runLibre(() => sleep(400));
    const rapida = limiter.runLibre(async () => {
      segundaEmpezoEn = Date.now() - empezado;
    });

    await Promise.all([lenta, rapida]);
    expect(segundaEmpezoEn).toBeLessThan(150);
  });

  /**
   * El espaciado se reserva EN LA LLAMADA, no al terminar. Antes el caudal real
   * era `1/max(intervalo, latencia)`: con `MARKETDATA_RATE_LIMIT_PER_SECOND=6`
   * y velas que tardan medio segundo, seis por segundo eran en realidad dos.
   */
  it('el espaciado no depende de lo que tarde cada llamada', async () => {
    const limiter = new RateLimiter(20, { maxEnVuelo: 3 }); // 50 ms entre turnos
    const empezado = Date.now();
    await Promise.all([
      limiter.runLibre(() => sleep(100)),
      limiter.runLibre(() => sleep(100)),
      limiter.runLibre(() => sleep(100)),
    ]);
    // Tres turnos a 50 ms más los 100 de la última: ~200, no ~300.
    expect(Date.now() - empezado).toBeLessThan(280);
  });

  it('pero el carril libre NO se pasa del caudal configurado', async () => {
    const limiter = new RateLimiter(10, { maxEnVuelo: 10 }); // 100 ms entre turnos
    const empezado = Date.now();
    const arranques: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.runLibre(async () => {
          arranques.push(Date.now() - empezado);
        }),
      ),
    );
    expect(arranques[arranques.length - 1]).toBeGreaterThanOrEqual(480);
  });

  it('y nunca hay más de `maxEnVuelo` dentro a la vez', async () => {
    const limiter = new RateLimiter(1000, { maxEnVuelo: 3 });
    const { estado, trabajo } = contador();
    await Promise.all(Array.from({ length: 10 }, (_, i) => limiter.runLibre(trabajo(i, 30))));
    expect(estado.maximo).toBe(3);
  });

  it('un fallo no rompe el carril libre', async () => {
    const limiter = new RateLimiter(1000, { maxEnVuelo: 2 });
    await expect(limiter.runLibre(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.runLibre(() => Promise.resolve('sigue viva'))).resolves.toBe('sigue viva');
  });
});

describe('RateLimiter: el carril ordenado (spec 065)', () => {
  /**
   * Lo que este carril sostiene: el `nonce_manager` del SDK de Lighter asigna
   * un contador secuencial por clave de API DENTRO de la llamada, y dos
   * transacciones en vuelo que lleguen invertidas dan `21104 invalid nonce`,
   * tras el cual el SDK DECREMENTA su contador y el adaptador se queda sin
   * poder colocar nada. Aster firma con un nonce dentro de una ventana de diez
   * segundos. Por eso las escrituras no van nunca por el carril libre.
   */
  it('no solapa dos llamadas, pase lo que pase con sus duraciones', async () => {
    const limiter = new RateLimiter(1000, { maxEnVuelo: 4 });
    const { estado, trabajo } = contador();
    await Promise.all([
      limiter.run(trabajo(1, 60)),
      limiter.run(trabajo(2, 5)),
      limiter.run(trabajo(3, 40)),
    ]);
    expect(estado.maximo).toBe(1);
    expect(estado.orden).toEqual([1, 2, 3]);
  });

  it('sin `maxEnVuelo`, el carril libre se comporta como el de siempre', async () => {
    // La red que protege el despliegue por fases: el codigo entra con el
    // interruptor a uno y se sube despues.
    const limiter = new RateLimiter(1000);
    const { estado, trabajo } = contador();
    await Promise.all([limiter.runLibre(trabajo(1, 40)), limiter.runLibre(trabajo(2, 5))]);
    expect(estado.maximo).toBe(1);
    expect(estado.orden).toEqual([1, 2]);
  });
});
