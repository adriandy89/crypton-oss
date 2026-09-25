-- Agentes de IA (spec 074).
--
-- Cinco enums y cinco tablas nuevas: agentes, rondas, candidatos, propuestas y
-- acciones de seguimiento. No toca ninguna fila existente: es segura de aplicar
-- con el sistema en marcha, y solo hacia delante.
--
-- Va DESPUES de la que anade AGENT_TRADE a StrategyKind y aparte de ella: esa
-- solo anade un valor al enum, y Postgres no deja usarlo en la misma
-- transaccion. Esta no lo usa.

-- CreateEnum
CREATE TYPE "AiDeskAgentState" AS ENUM ('ACTIVO', 'PAUSADO', 'ARCHIVADO');

-- CreateEnum
CREATE TYPE "AiDeskRoundKind" AS ENUM ('ENTRADA', 'SEGUIMIENTO');

-- CreateEnum
CREATE TYPE "AiDeskRoundState" AS ENUM ('EN_CURSO', 'COMPLETADA', 'SALTADA', 'FALLIDA');

-- CreateEnum
CREATE TYPE "AiDeskProposalState" AS ENUM ('PROPUESTA', 'APROBANDO', 'EJECUTANDO', 'ABIERTA', 'CERRADA', 'SIN_ENTRADA', 'RECHAZADA', 'CADUCADA', 'DESCARTADA', 'FALLIDA', 'SOMBRA');

-- CreateEnum
CREATE TYPE "AiDeskActionState" AS ENUM ('PROPUESTA', 'APLICANDO', 'APLICADA', 'RECHAZADA', 'CADUCADA', 'DESCARTADA', 'FALLIDA', 'SOMBRA');

-- CreateTable
CREATE TABLE "ai_desk_agents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "exchange_account_id" TEXT NOT NULL,
    "venue" "Venue" NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "state" "AiDeskAgentState" NOT NULL DEFAULT 'ACTIVO',
    "pause_reason" VARCHAR(32),
    "symbols" TEXT[],
    "interval" VARCHAR(8) NOT NULL,
    "families" TEXT[],
    "sides" TEXT[],
    "decision_mode" VARCHAR(8) NOT NULL DEFAULT 'IA',
    "limits" JSONB NOT NULL,
    "auto_entry" "AiMode" NOT NULL DEFAULT 'MANUAL',
    "auto_reduce" "AiMode" NOT NULL DEFAULT 'AUTO',
    "auto_close" "AiMode" NOT NULL DEFAULT 'MANUAL',
    "next_round_at" TIMESTAMPTZ(6),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "sleeping_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "usage_day" DATE,
    "calls_today" INTEGER NOT NULL DEFAULT 0,
    "cost_today" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_desk_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_desk_rounds" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "kind" "AiDeskRoundKind" NOT NULL,
    "bar_t" TIMESTAMPTZ(6) NOT NULL,
    "trigger" VARCHAR(16) NOT NULL,
    "proposal_id" TEXT,
    "state" "AiDeskRoundState" NOT NULL DEFAULT 'EN_CURSO',
    "reason" VARCHAR(32),
    "decision_mode" VARCHAR(8) NOT NULL,
    "huella" VARCHAR(2048),
    "snapshot" JSONB,
    "decision" JSONB,
    "model" VARCHAR(64),
    "prompt_version" VARCHAR(64),
    "latency_ms" INTEGER,
    "cost" DECIMAL(38,18),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_desk_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_desk_candidates" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "candidate_key" VARCHAR(128) NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "family" VARCHAR(16) NOT NULL,
    "side" "Direction" NOT NULL,
    "letter" VARCHAR(2),
    "eligible" BOOLEAN NOT NULL,
    "chosen" BOOLEAN NOT NULL DEFAULT false,
    "judge_choice" BOOLEAN NOT NULL DEFAULT false,
    "measurable" JSONB,
    "outcome" JSONB,
    "measured_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_desk_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_desk_proposals" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "round_id" TEXT,
    "candidate_key" VARCHAR(128) NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "family" VARCHAR(16) NOT NULL,
    "side" "Direction" NOT NULL,
    "state" "AiDeskProposalState" NOT NULL DEFAULT 'PROPUESTA',
    "reason" VARCHAR(32),
    "plan" JSONB NOT NULL,
    "final_plan" JSONB,
    "decision" JSONB,
    "dry_run" BOOLEAN NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by" VARCHAR(16),
    "decided_at" TIMESTAMPTZ(6),
    "bot_id" TEXT,
    "opened_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "exit" VARCHAR(20),
    "realized_pnl" DECIMAL(38,18),
    "r_real" DECIMAL(20,8),
    "outcome" JSONB,
    "measured_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_desk_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_desk_actions" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "round_id" TEXT,
    "action" VARCHAR(24) NOT NULL,
    "action_class" VARCHAR(12) NOT NULL,
    "state" "AiDeskActionState" NOT NULL DEFAULT 'PROPUESTA',
    "reason" VARCHAR(32),
    "change" JSONB NOT NULL,
    "decision" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by" VARCHAR(16),
    "decided_at" TIMESTAMPTZ(6),
    "applied_version" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_desk_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_ai_desk_agent_user" ON "ai_desk_agents"("user_id");

-- CreateIndex
CREATE INDEX "idx_ai_desk_agent_ronda" ON "ai_desk_agents"("state", "next_round_at");

-- CreateIndex
CREATE INDEX "idx_ai_desk_round_agent_fecha" ON "ai_desk_rounds"("agent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ai_desk_candidate_agent_fecha" ON "ai_desk_candidates"("agent_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_ai_desk_proposal_bot" ON "ai_desk_proposals"("bot_id");

-- CreateIndex
CREATE INDEX "idx_ai_desk_proposal_agent_fecha" ON "ai_desk_proposals"("agent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ai_desk_proposal_estado_vence" ON "ai_desk_proposals"("state", "expires_at");

-- CreateIndex
CREATE INDEX "idx_ai_desk_action_proposal_fecha" ON "ai_desk_actions"("proposal_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ai_desk_action_estado_vence" ON "ai_desk_actions"("state", "expires_at");

-- AddForeignKey
ALTER TABLE "ai_desk_agents" ADD CONSTRAINT "ai_desk_agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_agents" ADD CONSTRAINT "ai_desk_agents_exchange_account_id_fkey" FOREIGN KEY ("exchange_account_id") REFERENCES "exchange_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_rounds" ADD CONSTRAINT "ai_desk_rounds_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_desk_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_rounds" ADD CONSTRAINT "ai_desk_rounds_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "ai_desk_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_candidates" ADD CONSTRAINT "ai_desk_candidates_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "ai_desk_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_proposals" ADD CONSTRAINT "ai_desk_proposals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_desk_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_proposals" ADD CONSTRAINT "ai_desk_proposals_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "ai_desk_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_proposals" ADD CONSTRAINT "ai_desk_proposals_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_actions" ADD CONSTRAINT "ai_desk_actions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "ai_desk_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_desk_actions" ADD CONSTRAINT "ai_desk_actions_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "ai_desk_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Indices PARCIALES, que Prisma no expresa (ver el comentario del esquema).

-- Una ronda de intervalo por agente y vela: dos replicas del planificador no
-- consultan dos veces por lo mismo. Las manuales («analizar ahora») no cuentan.
CREATE UNIQUE INDEX "uq_ai_desk_round_entrada" ON "ai_desk_rounds"("agent_id", "bar_t")
    WHERE "kind" = 'ENTRADA' AND "trigger" = 'INTERVALO';

-- Una ronda de seguimiento por operacion, vela y disparador.
CREATE UNIQUE INDEX "uq_ai_desk_round_seguimiento" ON "ai_desk_rounds"("proposal_id", "bar_t", "trigger")
    WHERE "kind" = 'SEGUIMIENTO' AND "trigger" <> 'MANUAL';

-- Una operacion viva por agente y par (R-20), tambien en simulacion.
CREATE UNIQUE INDEX "uq_ai_desk_proposal_viva" ON "ai_desk_proposals"("agent_id", "symbol")
    WHERE "state" IN ('APROBANDO', 'EJECUTANDO', 'ABIERTA');

-- Una accion pendiente por operacion: la siguiente espera a que se resuelva esta.
CREATE UNIQUE INDEX "uq_ai_desk_action_pendiente" ON "ai_desk_actions"("proposal_id")
    WHERE "state" IN ('PROPUESTA', 'APLICANDO');

-- Los candidatos que aun no se han medido: los recorre la medicion.
CREATE INDEX "idx_ai_desk_candidate_pendiente" ON "ai_desk_candidates"("created_at")
    WHERE "measured_at" IS NULL;
