import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * El worker se puede construir (spec 065, con el motivo del 049).
 *
 * El spec 049 descubrió que la API estuvo MUERTA con 5555 tests en verde: todos
 * instancian los servicios a mano con dobles, y `new Servicio(db, cache, …)` no
 * construye el grafo de Nest, así que no hay nada que resolver ni nada que
 * fallar. Se cerró con un test que compila `AppModule`… en la API, y solo en la
 * API. El worker se quedó con el mismo agujero, y es el proceso que firma.
 *
 * `compile()` y no `init()` a propósito: compilar resuelve el grafo entero
 * —que es exactamente lo que falla cuando alguien añade un proveedor y olvida
 * declararlo— pero no dispara `onModuleInit`, que es donde Prisma, Redis y los
 * temporizadores abrirían conexiones de verdad. Por eso esto corre sin
 * infraestructura, dentro de `pnpm test`, y no deja un handle abierto.
 */

/**
 * El entorno mínimo para CONSTRUIR, que no es el mínimo para funcionar: son los
 * valores que algún constructor exige presentes y que, si faltan, revientan
 * antes de llegar a la inyección. Van aquí y no se leen del `.env` a propósito:
 * un test que solo pasa en la máquina donde hay credenciales reales no prueba
 * nada. Todos son evidentemente falsos; al compilar el grafo no se firma, no se
 * cifra y no sale nada a la red.
 */
const ENTORNO_MINIMO: Record<string, string> = {
  CREDENTIALS_MASTER_KEY: 'a'.repeat(64),
};

describe('AppModule del worker', () => {
  const previo: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [k, v] of Object.entries(ENTORNO_MINIMO)) {
      previo[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resuelve el grafo de inyección entero', async () => {
    const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(modulo).toBeDefined();
    await modulo.close();
  }, 60_000);
});
