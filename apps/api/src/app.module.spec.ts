import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * La API se puede construir (spec 049).
 *
 * Motivo literal: el spec 046 anadio `SupervisorService`, que recibe
 * `OpenRouterClient` por constructor, y `AdvisorModule` —el modulo que lo
 * declara— exportaba solo `AdvisorService`. La API dejo de arrancar con
 * `UnknownDependenciesException` y **ni uno de los miles de tests de este
 * paquete se entero**, porque todos instancian los servicios a mano con dobles:
 * `new SupervisorService(db, cache, ...)` no construye el grafo de Nest, asi que
 * no hay nada que resolver ni nada que fallar. El unico sitio donde se levantaba
 * la aplicacion era el e2e, que necesita Postgres y Redis y por eso no corre en
 * `pnpm test`. Resultado: dos revisiones y un merge con la API muerta.
 *
 * `compile()` y no `init()` a proposito: compilar resuelve el grafo entero
 * —que es exactamente lo que fallaba— pero no dispara `onModuleInit`, que es
 * donde Prisma y Redis abren conexiones de verdad. Por eso esto corre sin
 * infraestructura, dentro de `pnpm test`, en unos segundos y sin dejar un solo
 * handle abierto.
 *
 * Se prefiere esto a analizar la metadata por nuestra cuenta: reimplementar las
 * reglas del inyector —modulos dinamicos, `@Global()`, reexportaciones, la
 * promesa que devuelve `ConfigModule.forRoot()`, los tokens del nucleo— es
 * codigo que se desincroniza de Nest y da falsos positivos. Aqui pregunta el
 * propio Nest.
 */

/**
 * El entorno minimo para CONSTRUIR la aplicacion, que no es el minimo para que
 * funcione: son los valores que algun constructor exige presentes y que, si
 * faltan, revientan antes de llegar a la inyeccion (`requireSecret`,
 * `GoogleService.require`, `EnvelopeService`).
 *
 * Se ponen aqui y no se leen del `.env` **a proposito**. Un test que solo pasa
 * en la maquina donde hay credenciales reales no prueba nada: este fallo se
 * descubrio justo asi, viendo el test pasar en el repo con `.env` y fallar en un
 * clon limpio. Todos los valores son evidentemente falsos y ninguno se usa para
 * nada: nada se firma, nada se cifra y nada sale a la red al compilar el grafo.
 */
const ENTORNO_MINIMO: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-'.repeat(10),
  JWT_REFRESH_SECRET: 'test-'.repeat(11),
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.invalid',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  CREDENTIALS_MASTER_KEY: 'a'.repeat(64),
};

describe('AppModule', () => {
  const previo: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [k, v] of Object.entries(ENTORNO_MINIMO)) {
      previo[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    // `process.env` lo comparten los ficheros de test que corren en el mismo
    // worker: dejarlo tocado contaminaria a quien venga detras.
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resuelve el grafo de inyeccion entero', async () => {
    // Importar `app.module` no lee ni una variable: el entorno se consulta en
    // los constructores, y esos corren aqui, dentro de `compile()`.
    const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(modulo).toBeDefined();
    await modulo.close();
  }, 60_000);
});
