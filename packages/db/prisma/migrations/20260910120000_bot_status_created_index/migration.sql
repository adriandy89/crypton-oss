-- El listado global de bots de la consola de administracion (spec 033).
--
-- La consulta que esta pantalla hace todo el rato es «que hay en marcha ahora
-- mismo» y «que esta en ERROR», ordenado por fecha de alta descendente. Ninguno
-- de los dos indices que ya tenia `bots` sirve para eso: en (user_id, status) la
-- columna guia es `user_id`, y un administrador precisamente no filtra por
-- usuario; (venue, symbol) no tiene nada que ver. Sin este indice, cada carga de
-- la pantalla es un recorrido completo de la tabla mas una ordenacion, y encima
-- dos veces, porque el total se cuenta con el mismo WHERE.
--
-- Sirve a las tres cosas a la vez: el filtro por estado, el orden por defecto y
-- ese recuento.
--
-- Es un indice de LECTURA y se paga con una escritura mas cada vez que un bot
-- cambia de estado. Sale a cuenta porque los cambios de estado son contados
-- —DRAFT, STARTING, RUNNING, PAUSED, STOPPED— mientras que el tick, que es lo
-- que de verdad ocurre sin parar, solo toca `last_tick_at`, que no esta aqui.
--
-- Sin CONCURRENTLY: Prisma envuelve cada migracion en una transaccion y
-- CREATE INDEX CONCURRENTLY no puede ejecutarse dentro de una. Con el tamaño
-- actual de `bots` el bloqueo es de milisegundos. Si algun dia dejara de serlo,
-- esta migracion habria que escribirla a mano y fuera de transaccion.

CREATE INDEX "idx_bot_status_created"
  ON "bots" ("status", "created_at" DESC);
