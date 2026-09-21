-- El «Bot de IA» (spec 068): motor propio de banda, solo administradores.
--
-- Postgres >= 12 admite ADD VALUE dentro de una transaccion siempre que el
-- valor nuevo NO se use en la misma transaccion. Aqui solo se anade.
ALTER TYPE "StrategyKind" ADD VALUE IF NOT EXISTS 'AI_TRADER';
