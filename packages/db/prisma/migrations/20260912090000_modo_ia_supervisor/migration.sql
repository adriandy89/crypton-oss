-- Modo IA: un supervisor que vigila bots vivos (spec 046).
--
-- Dos tablas nuevas y dos enums nuevos. NO se toca ninguna columna ni ninguna
-- fila existente, asi que es segura de aplicar con el sistema en marcha.
--
-- Por que tablas aparte y no columnas en `bots`: son doce columnas que no
-- aplican a la inmensa mayoria de los bots, y `bots` es la tabla mas leida del
-- sistema —listados, leaderboard, guardas de riesgo, el tick—. Es el mismo
-- argumento que ya esta escrito en `bot_mm_stats`.
--
-- Y por que NO va en `bot_config_revisions.config`, que es donde vive el resto
-- de la configuracion de un bot: aquello esta gobernado por `meta.fields` de la
-- estrategia, y `diffConfig` trata como COLD todo campo que la estrategia no
-- declare. Un `mode` ahi convertiria «cambiar el modo» en un cambio COLD, es
-- decir, en un cambio RECHAZADO.

-- CreateEnum
CREATE TYPE "AiMode" AS ENUM ('OFF', 'MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "AiDecisionState" AS ENUM ('PROPUESTA', 'APLICADA', 'RECHAZADA', 'CADUCADA', 'DESCARTADA', 'FALLIDA');

-- CreateTable
CREATE TABLE "bot_ai_settings" (
    "bot_id" TEXT NOT NULL,
    "mode" "AiMode" NOT NULL DEFAULT 'OFF',
    -- Las perillas de referencia sobre las que el modelo emite DESPLAZAMIENTOS,
    -- nunca valores. `buildConfig` no es invertible: la configuracion de un bot
    -- que lleva tres semanas no dice con que perillas nacio.
    "knobs" JSONB NOT NULL,
    "trigger" VARCHAR(16) NOT NULL DEFAULT 'AMBOS',
    "review_every_minutes" INTEGER,
    "daily_call_limit" INTEGER,
    -- false = solo cambios HOT. Recolocar la escalera cuesta comisiones.
    "allow_warm" BOOLEAN NOT NULL DEFAULT true,
    "enabled_by" VARCHAR(64),
    "enabled_at" TIMESTAMPTZ(6),
    "last_review_at" TIMESTAMPTZ(6),
    "last_apply_at" TIMESTAMPTZ(6),
    -- Huella cuantizada del ultimo expediente: si no cambia, el regimen es el
    -- mismo y no hace falta pagar otra llamada al modelo.
    "last_bucket" VARCHAR(64),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "paused_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "bot_ai_settings_pkey" PRIMARY KEY ("bot_id")
);

-- CreateTable
CREATE TABLE "bot_ai_decisions" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "trigger" VARCHAR(16) NOT NULL,
    "mode" "AiMode" NOT NULL,
    -- Lo que dijo el modelo, sin transformar. Texto ajeno.
    "raw" JSONB NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "confidence" VARCHAR(8),
    "rationale" TEXT,
    -- El expediente que VIO el modelo. Sin el, una decision rara es imposible
    -- de explicar seis meses despues. Se vacia con la retencion.
    "dossier" JSONB,
    "knobs_before" JSONB NOT NULL,
    "knobs_after" JSONB,
    "proposed_config" JSONB,
    "diff" JSONB,
    "apply_level" VARCHAR(8),
    -- El hilo para revertir, y la comprobacion de frescura al aprobar.
    "config_version_before" INTEGER NOT NULL,
    "config_version_after" INTEGER,
    "state" "AiDecisionState" NOT NULL DEFAULT 'PROPUESTA',
    "discard_reason" VARCHAR(24),
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "decided_by" VARCHAR(64),
    "decided_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),
    "model" VARCHAR(64),
    "prompt_version" INTEGER,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_ai_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- El barrido pregunta «que politicas tocan ya», y eso es exactamente esto.
CREATE INDEX "bot_ai_settings_mode_last_review_at_idx" ON "bot_ai_settings"("mode", "last_review_at");

-- CreateIndex
-- «Que ha decidido el supervisor sobre este bot», que es la pantalla.
CREATE INDEX "bot_ai_decisions_bot_id_created_at_idx" ON "bot_ai_decisions"("bot_id", "created_at" DESC);

-- CreateIndex
-- El barrido que caduca las propuestas vencidas.
CREATE INDEX "bot_ai_decisions_state_expires_at_idx" ON "bot_ai_decisions"("state", "expires_at");

-- AddForeignKey
ALTER TABLE "bot_ai_settings" ADD CONSTRAINT "bot_ai_settings_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_ai_decisions" ADD CONSTRAINT "bot_ai_decisions_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
