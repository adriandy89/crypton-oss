-- Lo que el `0_init` de esta edicion perdio (spec oss-001). Solo existe aqui.
--
-- `0_init` se genero desde `schema.prisma`, y el esquema no declara un indice
-- parcial ni un CHECK: los cinco objetos que el repositorio privado crea a mano
-- en sus migraciones del 22 al 26 de agosto se quedaron fuera sin que nada
-- avisara. Entre ellos, `uq_bot_live_account_symbol`, el indice unico que impide
-- dos bots REALES vivos sobre el mismo par y conexion (invariante 11 de
-- `CLAUDE.md`). Sin el, esa regla la sostenia solo la comprobacion previa de la
-- API, y dos arranques a la vez podian colarse los dos.
--
-- Cada objeto se crea con el nombre y la definicion con que acaba la cadena del
-- privado, y con `DROP ... IF EXISTS` delante, el mismo patron que alli: asi una
-- migracion futura que los toque aplica igual aqui que alli, y una instalacion
-- que los hubiera creado a mano acaba con la definicion buena.
--
-- 1. NO se toca un dato. Si la base ya tiene filas que un objeto rechazaria, la
--    migracion aborta ANTES de cambiar nada y dice cuales son y que hacer.
--    Nada de eso se puede arreglar desde aqui sin decidir por el usuario: parar
--    uno de dos bots reales que operan el mismo par, o tirar una credencial.
--    Corregido lo que diga el mensaje:
--      prisma migrate resolve --rolled-back 20260924150000_objetos_perdidos_del_init
--    y volver a desplegar.
--
-- 2. O sale entera o no cambia nada. Prisma manda el guion en UNA consulta y
--    Postgres la ejecuta como una transaccion implicita: el primer error la
--    deshace entera y es el que llega a quien despliega. Por eso NO lleva BEGIN
--    ni COMMIT a mano: con ellos, un error deja la conexion dentro de la
--    transaccion abortada, lo siguiente que manda Prisma choca con ella, y lo
--    que se ve es «current transaction is aborted» en lugar del mensaje de
--    aqui (comprobado con Prisma 7.9.1). Y los indices no son CONCURRENTLY, que
--    no cabe en una transaccion: bloquean las escrituras de su tabla mientras se
--    construyen. `bots` y `exchange_accounts` son pequenas, y `bot_commands` y
--    `activity_log` se purgan por retencion.

DO $$
DECLARE
  pares TEXT;
  sin_credencial TEXT;
  con_secreto TEXT;
BEGIN
  SELECT string_agg(format('%s en la conexion %s (%s bots)', d.symbol, d.exchange_account_id, d.n), '; ')
    INTO pares
    FROM (
      SELECT "exchange_account_id", "symbol", count(*) AS n
        FROM "bots"
       WHERE "status" IN ('STARTING', 'RUNNING', 'PAUSED', 'STOPPING')
         AND "dry_run" = false
       GROUP BY "exchange_account_id", "symbol"
      HAVING count(*) > 1
    ) d;
  IF pares IS NOT NULL THEN
    RAISE EXCEPTION 'Hay mas de un bot real en marcha sobre el mismo par y conexion: %. Para todos menos uno desde la app y vuelve a desplegar (spec oss-001).', pares;
  END IF;

  SELECT string_agg("id", ', ' ORDER BY "id")
    INTO sin_credencial
    FROM "exchange_accounts"
   WHERE NOT "paper" AND "enc_payload" IS NULL;
  IF sin_credencial IS NOT NULL THEN
    RAISE EXCEPTION 'Hay conexiones reales sin credencial, que no pueden firmar: %. Vuelve a guardar su clave o borralas, y vuelve a desplegar (spec oss-001).', sin_credencial;
  END IF;

  SELECT string_agg("id", ', ' ORDER BY "id")
    INTO con_secreto
    FROM "exchange_accounts"
   WHERE "paper" AND "enc_payload" IS NOT NULL;
  IF con_secreto IS NOT NULL THEN
    RAISE EXCEPTION 'Hay conexiones de simulacion con una credencial guardada: %. Una simulacion no guarda secretos: vacia su sobre (enc_*) o borralas, y vuelve a desplegar (spec oss-001).', con_secreto;
  END IF;
END $$;

-- ── Un solo bot REAL vivo por par y conexion ───────────────────
-- En un DEX la posicion es unica por cuenta y simbolo. Dos bots sobre el mismo
-- par ven la posicion del otro como propia: promedian mal, se cierran el take
-- profit entre ellos y la contabilidad del ciclo queda corrupta. La validacion
-- de la API da el mensaje legible; esto es la red que impide que una carrera
-- entre dos peticiones se cuele. Los simulados quedan fuera: cada uno tiene su
-- propio simulador y su posicion no compite con nadie.
DROP INDEX IF EXISTS "uq_bot_live_account_symbol";
CREATE UNIQUE INDEX "uq_bot_live_account_symbol"
    ON "bots"("exchange_account_id", "symbol")
    WHERE "status" IN ('STARTING', 'RUNNING', 'PAUSED', 'STOPPING')
      AND "dry_run" = false;

-- ── La cola de comandos pendientes ─────────────────────────────
-- El drenaje pregunta siempre por lo pendiente. Un indice parcial mantiene su
-- coste proporcional a la cola viva, no al historico de comandos.
DROP INDEX IF EXISTS "idx_bot_command_pending";
CREATE INDEX "idx_bot_command_pending" ON "bot_commands"("bot_id", "id")
    WHERE "executed_at" IS NULL;

-- ── Los errores de la bitacora ─────────────────────────────────
-- «¿Esta todo bien o hay errores?» merece su indice. Parcial porque solo indexa
-- las filas malas: en un sistema sano son una fraccion diminuta.
DROP INDEX IF EXISTS "idx_activity_failures";
CREATE INDEX "idx_activity_failures" ON "activity_log"("created_at" DESC)
    WHERE "outcome" <> 'OK';

-- ── Las credenciales de una conexion ───────────────────────────
-- Una conexion REAL sin sobre es una conexion que no puede firmar: tiene que
-- fallar al escribirla, no al mandar la primera orden.
ALTER TABLE "exchange_accounts" DROP CONSTRAINT IF EXISTS "ck_exchange_account_credentials";
ALTER TABLE "exchange_accounts"
  ADD CONSTRAINT "ck_exchange_account_credentials"
  CHECK ("paper" OR "enc_payload" IS NOT NULL);

-- Y al reves: una conexion de simulacion no guarda secreto ninguno. Sin esto,
-- nada impediria sellar una credencial de verdad en una fila marcada como
-- simulada.
ALTER TABLE "exchange_accounts" DROP CONSTRAINT IF EXISTS "ck_exchange_account_paper_no_secret";
ALTER TABLE "exchange_accounts"
  ADD CONSTRAINT "ck_exchange_account_paper_no_secret"
  CHECK (NOT "paper" OR "enc_payload" IS NULL);
