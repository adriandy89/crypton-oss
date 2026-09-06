-- Los campos del venue que faltaban en la fila de `markets` (spec 024).
--
-- `MarketSpec` gano cuatro campos en los specs 013, 014, 019 y 023 —tope de
-- ordenes activas por mercado, cifras significativas de un precio, tasa de
-- margen de mantenimiento y tope de cantidad de las ordenes a mercado— y los
-- adaptadores los rellenan desde el venue. Pero el motor, la API y la app
-- construyen el mercado desde ESTA fila, que no los guardaba: las cuatro
-- correcciones se quedaban en el adaptador. En Hyperliquid, la estrategia
-- seguia redondeando al tick sin la regla de cinco cifras mientras el adaptador
-- si la aplicaba, y el reconciliador veia dos precios distintos en cada tick.
--
-- Cuatro columnas NULL y ninguna fila tocada: segura con el sistema en marcha.
-- Hasta la siguiente sincronizacion del catalogo (cada diez minutos) estan
-- vacias y todo se comporta exactamente como hoy.

ALTER TABLE "markets"
  ADD COLUMN "max_market_qty" DECIMAL(38,18),
  ADD COLUMN "max_active_orders" INTEGER,
  ADD COLUMN "max_significant_digits" INTEGER,
  ADD COLUMN "maintenance_margin_rate" DECIMAL(38,18);
