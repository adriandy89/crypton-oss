# 049 — La API no arranca: el supervisor no se puede inyectar

Estado: `hecho` · Tipo: `corrección` · Rama: `spec/049-el-supervisor-no-se-inyecta`

## Objetivo

Que la API vuelva a arrancar, y que el agujero por el que se coló esto deje de existir.

Se sabrá que está hecho cuando `pnpm test` incluya una prueba que levante el grafo de inyección
completo y que **falle si se quita el arreglo**.

## Síntoma

El contenedor de la API muere al arrancar, antes de escuchar en ningún puerto:

```
ERROR [ExceptionHandler] UnknownDependenciesException [Error]: Nest can't resolve dependencies of
the SupervisorService (DbService, CacheService, BusService, ConfigService, ?, MarketDataService,
MarketsService, RiskService, BotsService). Please make sure that the argument OpenRouterClient at
index [4] is available in the SupervisorModule module.
```

## Causa

Una línea del plan del spec 046 que nunca se ejecutó. El plan decía, literalmente:

> `advisor.module.ts` — exportar `OpenRouterClient`

`AdvisorModule` declara `OpenRouterClient` en `providers` y exportaba solo `AdvisorService`. En Nest,
un provider no exportado es privado de su módulo: `SupervisorModule` importa `AdvisorModule` y aun
así no lo ve. `SupervisorService` lo pide por constructor en el índice 4, y el inyector no lo
encuentra.

De la tanda del 046 se tocaron `build.ts`, `openrouter.client.ts` y su test. `advisor.module.ts` no
aparece en `git diff --name-only a3e74dd HEAD`.

## Por qué no lo cazó nada

Es lo que importa de este spec, más que el arreglo, que es una palabra.

**Los 5519 tests de la API instancian los servicios a mano con dobles.** `new SupervisorService(db,
cache, bus, config, openrouter, ...)` no construye el grafo de Nest: no hay módulo, no hay inyector,
no hay nada que resolver y por tanto nada que pueda fallar. Un test así comprueba la lógica del
servicio y es ciego por construcción a cómo se ensambla la aplicación.

**El único sitio donde la aplicación se levantaba era el e2e**, que necesita Postgres y Redis y por
eso no entra en `pnpm test`. Así que la línea base del spec 047 —«todo en verde antes de empezar»—
era cierta y la API estaba muerta al mismo tiempo. Dos revisiones (047 con catorce hallazgos, 048 con
once) y un merge a `main` pasaron por encima sin tocarlo.

`pnpm lint` tampoco: exportar o no un provider es correcto en TypeScript de las dos maneras. Y
`pnpm build:packages` menos, porque `apps/api` ni se compila ahí.

## Requisitos

- **R-1** `AdvisorModule` exporta `OpenRouterClient`, con el comentario de por qué se comparte la
  instancia (sigue habiendo un solo fichero que habla con un LLM).
- **R-2** Un test en `pnpm test` que resuelva el grafo de inyección **entero** desde `AppModule`.
- **R-3** Ese test no necesita Postgres ni Redis, o no correría donde tiene que correr.
- **R-4** Ese test falla si se revierte R-1. Comprobado revirtiendo de verdad, no razonando.
- **R-5** Ese test no depende de un `.env` con credenciales reales.

## Decisión de diseño: `compile()`, no un analizador propio

El primer intento fue leer la metadata de los decoradores y resolver a mano la misma pregunta que se
hace el inyector. Funcionó —encontró el fallo— pero dio tres tandas de falsos positivos antes de
callarse: los módulos `@Global()` cuyo contenido vive en el módulo dinámico (`CacheModule` es
`@Module({})` vacío), los tokens que provee el núcleo de Nest y no un módulo nuestro
(`ModulesContainer`), y el detalle de que `ConfigModule.forRoot()` devuelve una **promesa** de módulo
dinámico en esta versión.

Reimplementar las reglas del inyector es código que se desincroniza de Nest en cuanto Nest cambie.
`Test.createTestingModule({ imports: [AppModule] }).compile()` pregunta al propio Nest, cabe en cinco
líneas y no puede estar en desacuerdo con la realidad.

`compile()` y no `init()` porque compilar resuelve el grafo —lo que fallaba— sin disparar
`onModuleInit`, que es donde Prisma y Redis abren conexiones. De ahí que cumpla R-3: seis segundos,
sin infraestructura y sin un handle abierto (comprobado con `--detectOpenHandles`).

## R-5, que salió sola y merece su párrafo

La primera versión del test pasaba. También pasaba **por el motivo equivocado**: este repositorio
tiene un `.env` real, y varios constructores exigen variables presentes antes de que se llegue a
resolver nada —`requireSecret` para los secretos de firma, `GoogleService.require` para el OAuth,
`EnvelopeService` para la clave maestra—. Al portarlo al fork, que es un clon sin `.env`, el test
murió con «Falta GOOGLE_CLIENT_ID» en lugar de comprobar el grafo.

Un test de arranque que solo pasa en la máquina donde hay credenciales es exactamente el tipo de
test que dejó pasar este incidente: verde por accidente. Así que el test **se fabrica el entorno
mínimo** con valores evidentemente falsos y lo restaura al terminar (`process.env` lo comparten los
ficheros que corren en el mismo worker). Ninguno de esos valores se usa para nada: compilar el grafo
no firma, no cifra y no sale a la red.

Efecto colateral útil: ese bloque es ahora la lista, ejecutable, de lo que la API exige tener puesto
para poder siquiera arrancar.

## Severidad

No es **Crítica** por la escala de `specs/README.md`: no produce ninguno de los cinco efectos que esa
escala exige —posición sin stop, exposición duplicada, caída del worker, firma contra host equivocado
o rechazo sistemático de órdenes—. El worker es otro proceso y sigue operando los bots con normalidad.

Es **Alta**, y de las que más: con la API caída nadie llega a su kill-switch, que es justo el
razonamiento con el que el invariante 9 justifica dejar pasar peticiones con Redis caído —*«cerrar la
API dejaría a quien tiene bots operando sin poder llegar a su kill-switch»*. Aquí la API estaba
cerrada del todo.

## Criterios de aceptación

- **CA-1** `pnpm --filter api test` en verde, con el test nuevo dentro. ✔
- **CA-2** Revertir R-1 hace fallar ese test con el mensaje exacto del incidente. ✔
- **CA-3** `pnpm test` completo, `pnpm lint` y `pnpm check:env` en verde. ✔
- **CA-4** El arreglo y el test, portados al fork OSS. ✔
- **CA-6** El test pasa en un clon sin `.env` (comprobado en el fork, que no lo tiene). ✔
- **CA-5** *(manual, del usuario)* El contenedor de la API arranca y responde.

## Fuera de alcance

Convertir los tests de la API a `Test.createTestingModule` con dobles inyectados: son 5519 y funcionan.
El test de grafo cubre el ensamblaje, que es lo que faltaba; cada test sigue cubriendo su lógica.
