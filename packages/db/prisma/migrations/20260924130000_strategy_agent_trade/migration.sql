-- Operacion de un agente de IA (spec 074).
--
-- Un valor nuevo en `StrategyKind`, nada mas. No toca ninguna fila: es segura
-- de aplicar con el sistema en marcha, y solo hacia delante.
--
-- Va sola en su migracion a proposito: Postgres admite ALTER TYPE ... ADD VALUE
-- dentro de una transaccion, pero no deja usar el valor nuevo en la misma. Las
-- tablas de los agentes van en otra migracion y no lo necesitan.

-- AlterEnum
ALTER TYPE "StrategyKind" ADD VALUE IF NOT EXISTS 'AGENT_TRADE';
