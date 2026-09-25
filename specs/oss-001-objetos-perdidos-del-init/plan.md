# oss-001 — Plan

## Enfoque

Una sola migración nueva encima de la cadena, nunca retocar `0_init`: ya está publicado, y una
instalación que lo aplicó no volvería a leerlo. La migración copia de la cadena del privado la
definición final de cada objeto —la de la última migración que lo toca— y lo precede de la
comprobación de los datos que lo harían fallar.

## La migración

`packages/db/prisma/migrations/20260924150000_objetos_perdidos_del_init/migration.sql`, sin
`BEGIN`/`COMMIT` a mano (R-4: Prisma la ejecuta como una transacción implícita, y los explícitos
taparían el mensaje del aborto):

1. Un bloque `DO` que cuenta, sin cambiar nada:
   - pares y conexiones con más de un bot real vivo (`STARTING`, `RUNNING`, `PAUSED`, `STOPPING`,
     `dry_run = false`);
   - conexiones reales sin sobre (`NOT paper AND enc_payload IS NULL`);
   - conexiones de simulación con sobre (`paper AND enc_payload IS NOT NULL`).

   Si hay alguna, `RAISE EXCEPTION` con las filas y qué hacer, y la transacción entera se deshace.
2. Los cinco objetos, cada uno con `DROP … IF EXISTS` delante y su comentario del porqué:
   - `uq_bot_live_account_symbol`, la versión de `20260826142000_pair_exclusivity_simulated_exempt`;
   - `idx_bot_command_pending`, de `20260822120000_engine_hardening`;
   - `idx_activity_failures`, de `20260822180000_activity_log`;
   - `ck_exchange_account_credentials` y `ck_exchange_account_paper_no_secret`, de
     `20260826120000_paper_accounts`.

La marca de tiempo va justo detrás de la última migración de la cadena (`20260924140000_agentes_ia`)
y antes de cualquiera que el privado cree desde hoy: así el orden es el mismo en toda instalación
—la de esta migración siempre entre la última compartida y la siguiente que se porte—, y no hay
que contar con cómo trataría Prisma una migración que llegue fuera de orden.

## El test

`apps/api/src/libs/db/objetos-a-mano.spec.ts`: lee `packages/db/prisma/migrations/*/migration.sql`
en el orden de Prisma (el nombre de la carpeta), les quita los comentarios y, para cada objeto:

- busca su última creación (`CREATE [UNIQUE] INDEX nombre`, `ADD CONSTRAINT nombre`) y su último
  borrado (`DROP INDEX|CONSTRAINT [IF EXISTS] nombre`); tiene que haber creación y ser posterior;
- comprueba que la sentencia de esa creación tiene la definición que el código da por hecha
  (columnas, estados, `dry_run = false`, el predicado del `CHECK`).

Va en la API porque es quien se apoya en ellos (`BotsService` en `START`) y `packages/db` no tiene
tests.

## Verificación

Con el contenedor `crypton-db` local y bases temporales que se borran al acabar, sin leer ningún
`.env` (el usuario es el `$POSTGRES_USER` del propio contenedor):

1. CA-1: el test, antes y después de la migración.
2. CA-2 a CA-5 con `psql`: la cadena sin la migración nueva, las filas que la rompen, la
   migración, y las inserciones que tienen que fallar o pasar después.
3. CA-6 con `prisma migrate deploy` y `prisma migrate status` contra una base temporal con un rol
   temporal, `DATABASE_URL` puesto en el entorno para que `prisma.config.ts` no lea el `.env` de la
   API.
4. CA-7: `pg_dump --schema-only` de las dos cadenas y su diferencia.
5. CA-8: `pnpm --filter api test`, `pnpm lint`, builds de la API y el worker.

Los guiones de las comprobaciones viven en el scratchpad de la sesión, no en el repositorio.

## Commits

En la rama del spec: `docs(specs): …` con el spec y el índice, y `fix(db): …` con el test y la
migración. Después, a `main` de esta edición. Sin push.
