-- El «Bot de IA» (AI_TRADER) se retira entero (spec 072).
--
-- Postgres no sabe quitar un valor de un enum: se crea el tipo sin el, se pasan
-- a el las tres columnas que lo usan y se borra el viejo. Es el patron que
-- genera Prisma, con dos pasos delante que Prisma no sabe dar.
--
-- 1. NO se borra un bot REAL en marcha. Es la misma regla que aplica la app al
--    borrar un bot («Para el bot antes de eliminarlo»): uno real de esta
--    estrategia en STARTING, RUNNING, PAUSED o STOPPING puede tener una posicion
--    abierta, y hacerlo desaparecer de la base la dejaria sin nadie que la
--    mire. Si lo hay, la migracion aborta ANTES de cambiar nada. Para seguir:
--    parar el bot con la version anterior, marcar esta migracion como revertida
--      prisma migrate resolve --rolled-back 20260924120000_retirar_ai_trader
--    y volver a desplegar.
--
-- 2. Lo demas se borra: los bots de la estrategia —sus filas hijas caen en
--    cascada, igual que al borrarlos desde la app—, sus backtests y sus filas
--    del ranking. Los simulados, en cualquier estado: no tienen dinero detras, y
--    exigir pararlos antes obligaria a hacerlo con una version que ya no los
--    sabe leer.
--
-- La API tiene que desplegarse ANTES que el worker: un worker nuevo contra una
-- base que todavia tenga filas de AI_TRADER fallaria al leerlas, porque su
-- cliente de Prisma ya no conoce el valor.
--
-- Todo en una transaccion: o sale entera o no cambia nada.

BEGIN;

DO $$
DECLARE
  vivos INTEGER;
BEGIN
  SELECT count(*) INTO vivos
    FROM "bots"
   WHERE "strategy" = 'AI_TRADER'
     AND "dry_run" = false
     AND "status" IN ('STARTING', 'RUNNING', 'PAUSED', 'STOPPING');
  IF vivos > 0 THEN
    RAISE EXCEPTION 'Hay % bot(s) reales de AI_TRADER sin parar. Paralos con la version anterior antes de desplegar esta (spec 072).', vivos;
  END IF;
END $$;

DELETE FROM "bots" WHERE "strategy" = 'AI_TRADER';
DELETE FROM "backtest_runs" WHERE "strategy" = 'AI_TRADER';
DELETE FROM "leaderboard_entries" WHERE "strategy" = 'AI_TRADER';

-- AlterEnum
CREATE TYPE "StrategyKind_new" AS ENUM ('GRID_CLASSIC', 'NEUTRAL_GRID', 'TDCA', 'MARTINGALE', 'GRIDMART', 'MARKET_MAKER', 'MARKET_MAKER_V2', 'TREND_FOLLOW', 'TRAILING_PROFIT', 'AI_CHANNEL');
ALTER TABLE "bots" ALTER COLUMN "strategy" TYPE "StrategyKind_new" USING ("strategy"::text::"StrategyKind_new");
ALTER TABLE "leaderboard_entries" ALTER COLUMN "strategy" TYPE "StrategyKind_new" USING ("strategy"::text::"StrategyKind_new");
ALTER TABLE "backtest_runs" ALTER COLUMN "strategy" TYPE "StrategyKind_new" USING ("strategy"::text::"StrategyKind_new");
ALTER TYPE "StrategyKind" RENAME TO "StrategyKind_old";
ALTER TYPE "StrategyKind_new" RENAME TO "StrategyKind";
DROP TYPE "StrategyKind_old";

COMMIT;
