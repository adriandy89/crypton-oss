-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Venue" AS ENUM ('HYPERLIQUID', 'LIGHTER', 'ASTER');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'VERIFIED', 'ACTIVE', 'ERROR', 'REVOKED');

-- CreateEnum
CREATE TYPE "StrategyKind" AS ENUM ('GRID_CLASSIC', 'NEUTRAL_GRID', 'TDCA', 'MARTINGALE', 'GRIDMART', 'MARKET_MAKER', 'MARKET_MAKER_V2');

-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('DRAFT', 'STARTING', 'RUNNING', 'PAUSED', 'STOPPING', 'STOPPED', 'ERROR', 'LIQUIDATED');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('LONG', 'SHORT', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "MarginMode" AS ENUM ('CROSS', 'ISOLATED');

-- CreateEnum
CREATE TYPE "LevelKind" AS ENUM ('BASE', 'SAFETY', 'GRID_BUY', 'GRID_SELL', 'TAKE_PROFIT', 'STOP_LOSS', 'QUOTE_BID', 'QUOTE_ASK', 'LIQUIDATION');

-- CreateEnum
CREATE TYPE "LevelState" AS ENUM ('PLANNED', 'PLACED', 'FILLED', 'CANCELED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderKind" AS ENUM ('LIMIT', 'MARKET', 'POST_ONLY');

-- CreateEnum
CREATE TYPE "EventSeverity" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('USER', 'ADMIN', 'WORKER', 'SYSTEM', 'ANON');

-- CreateEnum
CREATE TYPE "LeaderboardPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH', 'ALL');

-- CreateEnum
CREATE TYPE "BacktestSource" AS ENUM ('BINANCE', 'BYBIT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" VARCHAR NOT NULL,
    "google_sub" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "is_email_verified" BOOLEAN NOT NULL DEFAULT false,
    "language" VARCHAR(5) NOT NULL DEFAULT 'es',
    "role" "Role" NOT NULL DEFAULT 'USER',
    "bio" VARCHAR(280),
    "country" VARCHAR(2),
    "timezone" VARCHAR(64),
    "display_currency" VARCHAR(8),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_user_id" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "venue" "Venue" NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING',
    "public_ref" VARCHAR(128) NOT NULL,
    "enc_payload" TEXT,
    "enc_dek" TEXT,
    "enc_iv" VARCHAR(64),
    "enc_tag" VARCHAR(64),
    "enc_key_id" VARCHAR(32),
    "paper" BOOLEAN NOT NULL DEFAULT false,
    "paper_balance" DECIMAL(38,18),
    "builder_approved" BOOLEAN NOT NULL DEFAULT false,
    "testnet" BOOLEAN NOT NULL DEFAULT false,
    "last_verified_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_exchange_account_id" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_states" (
    "bot_id" TEXT NOT NULL,
    "balance" DECIMAL(38,18) NOT NULL,
    "realized_pnl" DECIMAL(38,18) NOT NULL,
    "fees_paid" DECIMAL(38,18) NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "positions" JSONB NOT NULL,
    "orders" JSONB NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_paper_state_bot" PRIMARY KEY ("bot_id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" SERIAL NOT NULL,
    "venue" "Venue" NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "testnet" BOOLEAN NOT NULL DEFAULT false,
    "canonical" VARCHAR(32) NOT NULL,
    "base" VARCHAR(16) NOT NULL,
    "quote" VARCHAR(16) NOT NULL,
    "tick_size" DECIMAL(38,18) NOT NULL,
    "step_size" DECIMAL(38,18) NOT NULL,
    "min_notional" DECIMAL(38,18),
    "min_qty" DECIMAL(38,18),
    "max_qty" DECIMAL(38,18),
    "max_leverage" INTEGER NOT NULL,
    "price_decimals" INTEGER NOT NULL,
    "qty_decimals" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "exchange_account_id" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "venue" "Venue" NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategy" "StrategyKind" NOT NULL,
    "status" "BotStatus" NOT NULL DEFAULT 'DRAFT',
    "direction" "Direction" NOT NULL,
    "leverage" INTEGER NOT NULL,
    "margin_mode" "MarginMode" NOT NULL DEFAULT 'ISOLATED',
    "total_investment" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6),
    "stopped_at" TIMESTAMPTZ(6),
    "last_tick_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "note" VARCHAR(256),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_bot_id" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_config_revisions" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "diff" JSONB,
    "apply_level" VARCHAR(8),
    "applied_by" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_config_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_levels" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "cycle_seq" INTEGER NOT NULL,
    "kind" "LevelKind" NOT NULL,
    "level_index" INTEGER NOT NULL,
    "state" "LevelState" NOT NULL DEFAULT 'PLANNED',
    "target_price" DECIMAL(38,18) NOT NULL,
    "target_qty" DECIMAL(38,18) NOT NULL,
    "reduce_only" BOOLEAN NOT NULL DEFAULT false,
    "client_order_id" VARCHAR(64) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bot_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_orders" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "client_order_id" VARCHAR(64) NOT NULL,
    "venue_client_id" VARCHAR(64),
    "venue_order_id" VARCHAR(64),
    "level_kind" "LevelKind" NOT NULL,
    "level_index" INTEGER NOT NULL,
    "cycle_seq" INTEGER NOT NULL,
    "side" "OrderSide" NOT NULL,
    "kind" "OrderKind" NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "qty" DECIMAL(38,18) NOT NULL,
    "filled_qty" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "avg_price" DECIMAL(38,18),
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "reduce_only" BOOLEAN NOT NULL DEFAULT false,
    "raw_error" TEXT,
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "bot_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_fills" (
    "id" BIGSERIAL NOT NULL,
    "bot_order_id" BIGINT NOT NULL,
    "venue_fill_id" VARCHAR(96) NOT NULL,
    "side" "OrderSide" NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "qty" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "fee_asset" VARCHAR(16) NOT NULL DEFAULT 'USDC',
    "is_taker" BOOLEAN NOT NULL DEFAULT false,
    "executed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_cycles" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "entries_filled" INTEGER NOT NULL DEFAULT 0,
    "last_entry_at" TIMESTAMPTZ(6),
    "filled_level_indexes" INTEGER[],
    "cooldown_until" TIMESTAMPTZ(6),
    "anchor_price" DECIMAL(38,18),
    "average_entry" DECIMAL(38,18),
    "exit_avg" DECIMAL(38,18),
    "qty" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "realized_pnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "fees" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "scratch" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "bot_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_events" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "severity" "EventSeverity" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" BIGSERIAL NOT NULL,
    "actor" "ActorKind" NOT NULL,
    "actor_id" VARCHAR(64),
    "bot_id" VARCHAR(64),
    "action" VARCHAR(64) NOT NULL,
    "severity" "EventSeverity" NOT NULL DEFAULT 'INFO',
    "outcome" VARCHAR(12) NOT NULL,
    "message" TEXT,
    "route" VARCHAR(160),
    "method" VARCHAR(8),
    "status_code" INTEGER,
    "duration_ms" INTEGER,
    "ip" VARCHAR(45),
    "request_id" VARCHAR(36),
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_commands" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "command" VARCHAR(32) NOT NULL,
    "requested_by" VARCHAR(64),
    "payload" JSONB,
    "claimed_at" TIMESTAMPTZ(6),
    "claimed_by" VARCHAR(64),
    "executed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_mm_stats" (
    "bot_id" TEXT NOT NULL,
    "fills" INTEGER NOT NULL DEFAULT 0,
    "buy_fills" INTEGER NOT NULL DEFAULT 0,
    "sell_fills" INTEGER NOT NULL DEFAULT 0,
    "maker_fills" INTEGER NOT NULL DEFAULT 0,
    "taker_fills" INTEGER NOT NULL DEFAULT 0,
    "closed_cycles" INTEGER NOT NULL DEFAULT 0,
    "gross_matched_profit" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "fees_paid" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "peak_inventory" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "peak_margin" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "last_fill_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bot_mm_stats_pkey" PRIMARY KEY ("bot_id")
);

-- CreateTable
CREATE TABLE "bot_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "equity" DECIMAL(38,18) NOT NULL,
    "position_qty" DECIMAL(38,18) NOT NULL,
    "average_entry" DECIMAL(38,18),
    "mark_price" DECIMAL(38,18) NOT NULL,
    "unrealized_pnl" DECIMAL(38,18) NOT NULL,
    "realized_pnl_acc" DECIMAL(38,18) NOT NULL,
    "margin_used" DECIMAL(38,18) NOT NULL,
    "liquidation_price" DECIMAL(38,18),
    "open_orders" INTEGER NOT NULL DEFAULT 0,
    "taken_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_limits" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "max_notional_per_bot" DECIMAL(38,18),
    "max_total_notional" DECIMAL(38,18),
    "max_leverage" INTEGER,
    "max_open_bots" INTEGER,
    "max_daily_loss" DECIMAL(38,18),
    "kill_switch_drawdown_pct" DECIMAL(10,4),
    "liquidation_alert_pct" DECIMAL(10,4) DEFAULT 10,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "risk_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" VARCHAR(32),
    "link_code" VARCHAR(16),
    "link_code_expires_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_shares" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "share_code" VARCHAR(16) NOT NULL,
    "config_blob" JSONB NOT NULL,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "copies_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_entries" (
    "id" BIGSERIAL NOT NULL,
    "bot_id" TEXT NOT NULL,
    "period" "LeaderboardPeriod" NOT NULL,
    "venue" "Venue" NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategy" "StrategyKind" NOT NULL,
    "roi_pct" DECIMAL(18,6) NOT NULL,
    "aum" DECIMAL(38,18) NOT NULL,
    "total_pnl" DECIMAL(38,18) NOT NULL,
    "uptime_seconds" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT,
    "requested_by" TEXT NOT NULL,
    "venue" "Venue" NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "strategy" "StrategyKind" NOT NULL,
    "config" JSONB NOT NULL,
    "config_version" INTEGER,
    "source" "BacktestSource" NOT NULL,
    "source_symbol" VARCHAR(32) NOT NULL,
    "market_type" VARCHAR(8) NOT NULL,
    "interval" VARCHAR(8) NOT NULL,
    "from_ms" BIGINT NOT NULL,
    "to_ms" BIGINT NOT NULL,
    "params" JSONB NOT NULL,
    "bars" INTEGER NOT NULL,
    "ticks" INTEGER NOT NULL,
    "fills_total" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "metrics" JSONB NOT NULL,
    "equity_curve" JSONB NOT NULL,
    "candles" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_backtest_run_id" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_fills" (
    "id" BIGSERIAL NOT NULL,
    "run_id" TEXT NOT NULL,
    "ts" BIGINT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "level_kind" "LevelKind",
    "level_index" INTEGER,
    "cycle_seq" INTEGER NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "qty" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18) NOT NULL,
    "is_taker" BOOLEAN NOT NULL,
    "liquidation" BOOLEAN NOT NULL DEFAULT false,
    "position_after" DECIMAL(38,18) NOT NULL,
    "realized_acc_after" DECIMAL(38,18) NOT NULL,

    CONSTRAINT "backtest_fills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_email" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_google_sub" ON "users"("google_sub");

-- CreateIndex
CREATE INDEX "idx_user_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_disabled_idx" ON "users"("disabled");

-- CreateIndex
CREATE INDEX "exchange_accounts_user_id_status_idx" ON "exchange_accounts"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_exchange_account_label" ON "exchange_accounts"("user_id", "venue", "testnet", "label", "paper");

-- CreateIndex
CREATE INDEX "markets_canonical_idx" ON "markets"("canonical");

-- CreateIndex
CREATE UNIQUE INDEX "uq_market_venue_symbol" ON "markets"("venue", "testnet", "symbol");

-- CreateIndex
CREATE INDEX "bots_user_id_status_idx" ON "bots"("user_id", "status");

-- CreateIndex
CREATE INDEX "bots_venue_symbol_idx" ON "bots"("venue", "symbol");

-- CreateIndex
CREATE INDEX "bot_config_revisions_bot_id_created_at_idx" ON "bot_config_revisions"("bot_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bot_config_version" ON "bot_config_revisions"("bot_id", "version");

-- CreateIndex
CREATE INDEX "bot_levels_bot_id_state_idx" ON "bot_levels"("bot_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bot_level_coid" ON "bot_levels"("bot_id", "client_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bot_order_coid" ON "bot_orders"("client_order_id");

-- CreateIndex
CREATE INDEX "bot_orders_bot_id_status_idx" ON "bot_orders"("bot_id", "status");

-- CreateIndex
CREATE INDEX "bot_orders_bot_id_cycle_seq_idx" ON "bot_orders"("bot_id", "cycle_seq");

-- CreateIndex
CREATE INDEX "bot_orders_bot_id_venue_client_id_idx" ON "bot_orders"("bot_id", "venue_client_id");

-- CreateIndex
CREATE INDEX "bot_orders_bot_id_venue_order_id_idx" ON "bot_orders"("bot_id", "venue_order_id");

-- CreateIndex
CREATE INDEX "bot_fills_bot_order_id_idx" ON "bot_fills"("bot_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bot_fill_order_venue_id" ON "bot_fills"("bot_order_id", "venue_fill_id");

-- CreateIndex
CREATE INDEX "bot_cycles_bot_id_closed_at_idx" ON "bot_cycles"("bot_id", "closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bot_cycle_seq" ON "bot_cycles"("bot_id", "seq");

-- CreateIndex
CREATE INDEX "bot_events_bot_id_created_at_idx" ON "bot_events"("bot_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bot_events_severity_created_at_idx" ON "bot_events"("severity", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_activity_created" ON "activity_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_activity_actor" ON "activity_log"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_activity_action" ON "activity_log"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bot_commands_bot_id_created_at_idx" ON "bot_commands"("bot_id", "created_at");

-- CreateIndex
CREATE INDEX "bot_snapshots_bot_id_taken_at_idx" ON "bot_snapshots"("bot_id", "taken_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "risk_limits_user_id_key" ON "risk_limits"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_links_user_id_key" ON "telegram_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_links_link_code_key" ON "telegram_links"("link_code");

-- CreateIndex
CREATE UNIQUE INDEX "bot_shares_bot_id_key" ON "bot_shares"("bot_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_shares_share_code_key" ON "bot_shares"("share_code");

-- CreateIndex
CREATE INDEX "bot_shares_public_copies_count_idx" ON "bot_shares"("public", "copies_count" DESC);

-- CreateIndex
CREATE INDEX "leaderboard_entries_period_rank_idx" ON "leaderboard_entries"("period", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "uq_leaderboard_bot_period" ON "leaderboard_entries"("bot_id", "period");

-- CreateIndex
CREATE INDEX "backtest_runs_bot_id_created_at_idx" ON "backtest_runs"("bot_id", "created_at");

-- CreateIndex
CREATE INDEX "backtest_runs_requested_by_created_at_idx" ON "backtest_runs"("requested_by", "created_at");

-- CreateIndex
CREATE INDEX "backtest_fills_run_id_ts_idx" ON "backtest_fills"("run_id", "ts");

-- AddForeignKey
ALTER TABLE "exchange_accounts" ADD CONSTRAINT "exchange_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_states" ADD CONSTRAINT "paper_states_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_exchange_account_id_fkey" FOREIGN KEY ("exchange_account_id") REFERENCES "exchange_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_config_revisions" ADD CONSTRAINT "bot_config_revisions_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_levels" ADD CONSTRAINT "bot_levels_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_orders" ADD CONSTRAINT "bot_orders_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_fills" ADD CONSTRAINT "bot_fills_bot_order_id_fkey" FOREIGN KEY ("bot_order_id") REFERENCES "bot_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_cycles" ADD CONSTRAINT "bot_cycles_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_events" ADD CONSTRAINT "bot_events_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_commands" ADD CONSTRAINT "bot_commands_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_mm_stats" ADD CONSTRAINT "bot_mm_stats_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_snapshots" ADD CONSTRAINT "bot_snapshots_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_shares" ADD CONSTRAINT "bot_shares_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_shares" ADD CONSTRAINT "bot_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_fills" ADD CONSTRAINT "backtest_fills_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "backtest_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

