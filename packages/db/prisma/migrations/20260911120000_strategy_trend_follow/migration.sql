-- Seguimiento de tendencia (spec 040).
--
-- Un valor nuevo en el enum: no altera ninguna fila existente ni ninguna
-- columna. Postgres no permite ALTER TYPE ... ADD VALUE dentro de una
-- transaccion en versiones antiguas, pero si desde la 12, que es la minima de
-- este proyecto.
ALTER TYPE "StrategyKind" ADD VALUE IF NOT EXISTS 'TREND_FOLLOW';
