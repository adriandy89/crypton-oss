-- Canal con IA (spec 058).
--
-- Un valor nuevo en `StrategyKind`, un enum nuevo, dos tablas nuevas y una
-- columna NULA en `bots`. No toca ninguna fila existente: es segura de aplicar
-- con el sistema en marcha, y solo hacia delante.
--
-- Postgres admite ALTER TYPE ... ADD VALUE dentro de una transaccion desde la
-- 12, que es la minima de este proyecto, siempre que el valor nuevo no se use
-- en la misma transaccion. Aqui no se usa.

-- AlterEnum
ALTER TYPE "StrategyKind" ADD VALUE IF NOT EXISTS 'AI_CHANNEL';

-- CreateEnum
CREATE TYPE "AiIntentState" AS ENUM ('SOLICITADA', 'CONSULTANDO', 'DECIDIDA', 'SIN_ENTRADA', 'FALLIDA', 'ACEPTADA', 'ABIERTA', 'CERRADA', 'RECHAZADA', 'CADUCADA');

-- AlterTable
-- El nocional maximo que declara la estrategia. Nulo en los bots de siempre:
-- para ellos el agregado sigue siendo capital por apalancamiento.
ALTER TABLE "bots" ADD COLUMN "max_notional" DECIMAL(38,18);

-- CreateTable
-- Cada intencion de operacion: la oferta que vio quien decidia, lo que eligio y
-- lo que paso despues. No se borra nunca; `snapshot` se vacia con la retencion.
CREATE TABLE "bot_ai_intents" (
    -- Un UUID para las de la IA; `reglas:<bot>:<vela>` para las del juez.
    "id" VARCHAR(80) NOT NULL,
    "bot_id" TEXT NOT NULL,
    "bar_t" TIMESTAMPTZ(6) NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'ENTRADA',
    "origen" VARCHAR(8) NOT NULL,
    "estado" "AiIntentState" NOT NULL DEFAULT 'SOLICITADA',
    "candidato_id" VARCHAR(64),
    "huella" VARCHAR(512) NOT NULL,
    "snapshot" JSONB,
    "decision" JSONB,
    "plan" JSONB,
    "motivo" VARCHAR(512),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "cycle_seq" INTEGER NOT NULL,
    "modelo" VARCHAR(64),
    "prompt_version" VARCHAR(64),
    "latencia_ms" INTEGER,
    "coste" DECIMAL(38,18),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "bot_ai_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- El lazo de la IA de cada bot: fallos seguidos, pausa y el uso del dia UTC.
CREATE TABLE "bot_ai_loops" (
    "bot_id" TEXT NOT NULL,
    "fallos" INTEGER NOT NULL DEFAULT 0,
    "pausado_hasta" TIMESTAMPTZ(6),
    "ultimo_error" TEXT,
    "dia" DATE,
    "llamadas_hoy" INTEGER NOT NULL DEFAULT 0,
    "coste_hoy" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "bot_ai_loops_pkey" PRIMARY KEY ("bot_id")
);

-- CreateIndex
-- El barrido que caduca las vencidas.
CREATE INDEX "idx_bot_ai_intent_estado_vence" ON "bot_ai_intents"("estado", "expires_at");

-- CreateIndex
-- «Que ha decidido este bot», que es la pantalla.
CREATE INDEX "idx_bot_ai_intent_bot_fecha" ON "bot_ai_intents"("bot_id", "created_at" DESC);

-- CreateIndex
-- Una decision por vela y clase: dos replicas de la API no piden dos veces.
CREATE UNIQUE INDEX "uq_bot_ai_intent_bar" ON "bot_ai_intents"("bot_id", "bar_t", "kind");

-- Una sola operacion viva por bot, pase lo que pase en el proceso. Prisma no
-- sabe declarar un indice parcial: vive aqui y en el comentario del modelo.
CREATE UNIQUE INDEX "uq_bot_ai_intent_viva" ON "bot_ai_intents"("bot_id")
    WHERE "estado" IN ('ACEPTADA', 'ABIERTA');

-- AddForeignKey
ALTER TABLE "bot_ai_intents" ADD CONSTRAINT "bot_ai_intents_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_ai_loops" ADD CONSTRAINT "bot_ai_loops_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
