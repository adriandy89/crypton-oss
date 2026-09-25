# oss-001 — Lo que el `0_init` de esta edición perdió

Estado: `hecho` · Tipo: `corrección` · Rama: `spec/oss-001-objetos-perdidos-del-init` · Solo en
esta edición

## Objetivo

Que la base de esta edición tenga los cinco objetos que el repositorio privado crea a mano en sus
migraciones y que el `0_init` de aquí perdió, con el mismo nombre y la misma definición, sin tocar
un dato de ninguna instalación.

## Contexto

La sincronización 27 (specs 072 a 075, 2026-09-25) aplicó por primera vez las dos cadenas de
migraciones enteras en bases temporales y comparó sus esquemas con `pg_dump --schema-only`. Aparte
de los planes y del orden de algunas columnas, a esta edición le faltaban cinco objetos:

| Objeto | Qué defiende | Dónde lo crea el privado |
|---|---|---|
| `uq_bot_live_account_symbol` | Índice único parcial: un solo bot **real** vivo (`STARTING`, `RUNNING`, `PAUSED`, `STOPPING`) por conexión y símbolo. Es el invariante 11 de `CLAUDE.md` | `20260822120000_engine_hardening`, rehecho en `20260822140000_pair_exclusivity_real_only`, `20260826120000_paper_accounts` y `20260826142000_pair_exclusivity_simulated_exempt` |
| `ck_exchange_account_credentials` | Una conexión real sin credencial no puede firmar: tiene que fallar al escribirla, no al mandar la primera orden | `20260826120000_paper_accounts` |
| `ck_exchange_account_paper_no_secret` | Una conexión de simulación no guarda ningún secreto | `20260826120000_paper_accounts` |
| `idx_bot_command_pending` | Índice parcial de la cola de comandos pendientes: su coste sigue a la cola viva, no al histórico | `20260822120000_engine_hardening` |
| `idx_activity_failures` | Índice parcial de los errores de la bitácora | `20260822180000_activity_log` |

Los cinco son de los que este esquema no declara: un `CHECK` no cabe en el esquema de Prisma, y
un índice parcial solo con la función en *preview* `partialIndexes`, que el proyecto no activa
(Prisma 7.9.1). En el privado viven solo en migraciones escritas a mano y `schema.prisma` los cita
en un comentario. El `0_init` de esta edición (2026-08-27) se generó desde el esquema y se quedó
sin ellos, sin que nada avisara: la comprobación de la sincronización 12 (`prisma migrate diff`
entre las migraciones y el esquema de esta edición) dio «No difference detected» porque comparaba la
cadena con un esquema que tampoco los declara. Hacía falta comparar con la base del privado.

**Severidad: Alta** —red de seguridad documentada que es código muerto—. Desde el 2026-08-27, la
regla de un solo bot real por par y conexión la ha sostenido solo la comprobación previa de la API
(`assertPairFree`): dos arranques a la vez de dos bots distintos sobre el mismo par la pasan los
dos, y el `P2002` que `BotsService` captura en `START` para ese caso no podía llegar nunca. Dos bots
reales sobre el mismo par ven la posición del otro como propia: promedian mal, se cierran el take
profit entre ellos y la contabilidad del ciclo queda corrupta. `schema.prisma` daba por existentes
tres de los cinco. No llega a Crítica porque hace falta una carrera entre dos peticiones; en empate,
la escala manda Alta. Los otros cuatro objetos entran en el mismo arreglo porque el usuario pidió
arreglarlo todo (2026-09-25).

Nada de esto afecta al repositorio privado: allí la cadena los crea.

## Alcance

- Una migración nueva, solo de esta edición:
  `packages/db/prisma/migrations/20260924150000_objetos_perdidos_del_init/migration.sql`.
- Un test en la API que recorre la cadena de migraciones y exige que los cinco acaben creados y con
  su definición: `apps/api/src/libs/db/objetos-a-mano.spec.ts`.
- El índice de specs: la numeración propia de esta edición y su tabla.
- `CLAUDE.md` de esta edición: la trampa, en «Trampas conocidas».

## Fuera de alcance

- **`schema.prisma`**: no cambia. Los `CHECK` no caben en él, y pasar los índices parciales al
  esquema exigiría activar `partialIndexes`, una función en *preview*, en las dos ediciones: es otro
  spec, y del privado. Sus comentarios ya describen la base tal y como queda.
- **El nombre de la clave foránea de `paper_states`**: aquí es `paper_states_bot_id_fkey`, el que
  genera Prisma; el privado arrastra `fk_paper_state_bot`, de una migración escrita a mano. Hacen lo
  mismo, y cambiarlo aquí metería en esta edición la deriva que tiene el privado.
- **El orden de las columnas** de algunas tablas: no cambia nada.
- **Los planes y las suscripciones**: esta edición no los tiene, a propósito.
- **Tocar datos**: ver R-3.

## Requisitos

- **R-1 — Los cinco, idénticos al privado.** Cada objeto se crea con el nombre y la definición con
  que acaba la cadena del privado. Así, una migración futura del privado que los toque aplica igual
  aquí que allí, en lugar de fallar por no encontrarlos.
- **R-2 — Repetible.** Cada objeto se borra si existe antes de crearse (`DROP … IF EXISTS`), el
  mismo patrón que usa el privado: una instalación que lo hubiera creado a mano acaba con la
  definición buena.
- **R-3 — Sin tocar un dato.** Si la base tiene filas que un objeto rechazaría —dos bots reales
  vivos en el mismo par y conexión, una conexión real sin credencial, una de simulación con un
  secreto—, la migración aborta **antes de cambiar nada**, dice qué filas son y qué hacer. Nada de
  eso se puede arreglar sin decidir por el usuario: parar uno de dos bots que operan con dinero, o
  tirar una credencial.
- **R-4 — O entera o nada, y con su mensaje.** Sin `BEGIN`/`COMMIT` a mano: Prisma manda el guion
  en una sola consulta y Postgres la ejecuta como una transacción implícita, que el primer error
  deshace entera y es el que llega a quien despliega. Con `BEGIN`/`COMMIT` explícitos, ese error
  queda tapado por «current transaction is aborted» (ver «Lo que salió al hacerlo»).
- **R-5 — Un test que falla hoy.** `objetos-a-mano.spec.ts` recorre las migraciones en el orden en
  que las aplica Prisma y exige, para cada objeto, que lo último que le pasa sea crearlo y que su
  definición sea la que el código da por hecha. Sin la migración nueva falla por los cinco.

## Criterios de aceptación

- **CA-1** El test falla sin la migración, por los cinco objetos, y pasa con ella.
- **CA-2** En una base temporal con la cadena ANTERIOR, dos bots reales `RUNNING` sobre el mismo par
  y conexión se insertan: el defecto, a la vista.
- **CA-3** Con esas filas, la migración nueva aborta con su mensaje y la base no cambia.
- **CA-4** Parado uno de los dos, la migración aplica; después, volver a arrancar el parado falla
  por unicidad (`23505`), y dos simulados o dos parados sobre el mismo par siguen permitidos.
- **CA-5** Con una conexión real sin credencial, y aparte con una de simulación con secreto, la
  migración aborta con su mensaje; aplicada, insertar cualquiera de las dos falla (`23514`).
- **CA-6** La cadena entera se aplica con `prisma migrate deploy` en una base temporal, y
  `prisma migrate status` la da por al día. Por Prisma también, con datos que la rompen: el aborto
  enseña el mensaje de la migración y no cambia nada; corregidos los datos,
  `prisma migrate resolve --rolled-back` y otro `deploy` la aplican.
- **CA-7** `pg_dump --schema-only` de esta edición frente al del privado: solo difieren los planes,
  el orden de columnas y el nombre de la clave de `paper_states`.
- **CA-8** Tests de la API, `pnpm lint` y los builds de la API y el worker, en verde.

## Riesgos

- **Una instalación con datos que un objeto rechaza**: R-3. El mensaje dice qué hacer; después,
  `prisma migrate resolve --rolled-back 20260924150000_objetos_perdidos_del_init` y volver a
  desplegar.
- **Bloqueos al crear los índices**: `CREATE INDEX` sin `CONCURRENTLY` bloquea las escrituras de su
  tabla mientras se construye, y `CONCURRENTLY` no cabe en una transacción. `bots` y
  `exchange_accounts` son pequeñas, y `bot_commands` y `activity_log` se purgan por retención. Se
  despliega como siempre: la API, que migra, y justo después el worker.
- **Numeración**: el spec no puede llamarse 076 ni 077, que el privado ya tiene comprometidos, y
  esta edición conserva la numeración del privado. Los specs que solo existen aquí se numeran
  aparte: `oss-NNN`.

## Lo que salió al hacerlo

- **`BEGIN`/`COMMIT` a mano tapan el mensaje.** La primera versión de la migración iba entre
  `BEGIN` y `COMMIT`, el patrón de la del 072. Por `psql` abortaba con su mensaje; por
  `prisma migrate deploy` (7.9.1), el error que llegaba era «current transaction is aborted,
  commands ignored until end of transaction block». Prisma manda el guion en una sola consulta: con
  un `BEGIN` dentro, el error deja la conexión en la transacción abortada y lo siguiente que manda
  Prisma choca con ella. Sin `BEGIN`/`COMMIT`, medido en bases temporales: el aborto enseña el
  mensaje (`P3018` con su texto), y un fallo al final del guion, con los cinco objetos ya creados,
  deja la base con cero; la transacción implícita ya da la atomicidad.
- **La migración del 072 tiene lo mismo**, idéntica aquí y en el privado: con un bot real de
  `AI_TRADER` en marcha aborta sin tocar el bot, pero quien despliega ve «current transaction is
  aborted» en lugar de «Hay N bot(s) reales de AI_TRADER sin parar…». Fuera de este spec: es un
  fichero del privado, y se corrige allí y se porta.

## Referencias oficiales

Consultadas el 2026-09-25.

- PostgreSQL 18, *CREATE INDEX* (https://www.postgresql.org/docs/18/sql-createindex.html):
  - «When the `WHERE` clause is present, a *partial index* is created.»
  - «Normally PostgreSQL locks the table to be indexed against writes and performs the entire
    index build with a single scan of the table. Other transactions can still read the table, but
    if they try to insert, update, or delete rows in the table they will block until the index
    build is finished.»
  - «Another difference is that a regular `CREATE INDEX` command can be performed within a
    transaction block, but `CREATE INDEX CONCURRENTLY` cannot.»
- Prisma, *Unsupported database features*
  (https://www.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features):
  «To add an unsupported feature to your database, you must customize a migration to include that
  feature before you apply it.»
- Prisma, *Indexes* (https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes), sobre
  `where` en `@@index`/`@@unique`: «It requires the `partialIndexes` Preview feature.»
