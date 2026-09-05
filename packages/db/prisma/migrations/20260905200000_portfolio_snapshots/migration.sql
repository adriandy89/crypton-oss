-- Curva agregada de la cartera (spec 003).
--
-- Una tabla nueva y nada mas: no se toca ninguna fila ni columna existente, asi
-- que es segura de aplicar con el sistema en marcha, como la de backtests.
--
-- Por que se MATERIALIZA en vez de agregar `bot_snapshots` al vuelo: un bot
-- borrado se lleva sus snapshots en cascada, y la suma de los bots que existen
-- hoy seria la historia de los supervivientes, no la de la cartera. Ademas, la
-- pestaña de aterrizaje no puede pagar un GROUP BY sobre 43 200 filas por bot
-- en cada apertura. El worker escribe una fila por usuario y red cada cinco
-- minutos a partir del ULTIMO snapshot de cada bot real con dato reciente: 105
-- filas al dia, 38 000 al año, que la purga (`RETENTION_PORTFOLIO_DAYS`) acota.
--
-- `pnl = realized + unrealized`, la misma definicion que `bot_snapshots.equity`:
-- es resultado, no patrimonio. Los saldos del venue no entran aqui.

-- CreateTable
CREATE TABLE "portfolio_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    -- Testnet y mainnet son libros distintos y no se mezclan.
    "testnet" BOOLEAN NOT NULL,
    "realized" DECIMAL(38,18) NOT NULL,
    "unrealized" DECIMAL(38,18) NOT NULL,
    "pnl" DECIMAL(38,18) NOT NULL,
    -- Suma de total_investment de los bots que aportan: lo que el usuario puso.
    "invested" DECIMAL(38,18) NOT NULL,
    -- Suma de |posicion| x precio medio: lo que hay abierto en el mercado.
    "exposure" DECIMAL(38,18) NOT NULL,
    -- Cuantos bots aportaron. Cuando baja, uno dejo de sumar; el pasado no cambia.
    "bots" INTEGER NOT NULL,
    "taken_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- El unico acceso es «las filas de este usuario y red en este rango, de mas
-- nueva a mas vieja»: con el indice, un año de filas se lee en milisegundos.
CREATE INDEX "portfolio_snapshots_user_id_testnet_taken_at_idx" ON "portfolio_snapshots"("user_id", "testnet", "taken_at" DESC);

-- AddForeignKey
-- En cascada con el usuario, como el resto de lo suyo: borrar la cuenta borra
-- su historia.
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
