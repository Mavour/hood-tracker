-- Hood Tracker: cache/event store only — NOT a user identity DB
-- Simplified to align with UniLP-Monitoring data model

CREATE TABLE IF NOT EXISTS positions (
  token_id           BIGINT PRIMARY KEY,
  owner_address      TEXT,
  pool_address       TEXT,
  token0             TEXT NOT NULL,
  token1             TEXT NOT NULL,
  quote_token        TEXT,
  fee_tier           INT NOT NULL,
  tick_lower         INT NOT NULL,
  tick_upper         INT NOT NULL,
  status             TEXT DEFAULT 'open',
  liquidity          TEXT DEFAULT '0',
  opened_at_block    BIGINT,
  metadata           JSONB DEFAULT '{}',
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_positions_owner ON positions (owner_address);

-- Cashflows: per-position monetary flows (aligned with UniLP-Monitoring)
-- flow_type: 'deposit' | 'withdrawal' | 'fee'
-- quote_value: amount denominated in the position's quote token (BigInt stored as text)
CREATE TABLE IF NOT EXISTS cashflows (
  id              BIGSERIAL PRIMARY KEY,
  position_id     TEXT NOT NULL,
  block_number    BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  flow_type       TEXT NOT NULL CHECK (flow_type IN ('deposit', 'withdrawal', 'fee')),
  quote_value     NUMERIC NOT NULL DEFAULT 0,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (position_id, transaction_hash, flow_type)
);

CREATE INDEX IF NOT EXISTS idx_cashflows_position ON cashflows (position_id);

-- Close history: permanent record of settled position PnL (aligned with UniLP-Monitoring)
CREATE TABLE IF NOT EXISTS close_history (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  position_id           TEXT NOT NULL UNIQUE,
  chain_id              INT NOT NULL DEFAULT 4663,
  protocol              TEXT NOT NULL DEFAULT 'v3',
  token0                TEXT NOT NULL,
  token1                TEXT NOT NULL,
  quote_token           TEXT NOT NULL,
  final_pnl_bps         NUMERIC NOT NULL DEFAULT 0,
  final_pnl_quote       NUMERIC NOT NULL DEFAULT 0,
  final_pnl_usd         NUMERIC NOT NULL DEFAULT 0,
  trigger               TEXT DEFAULT 'settled',
  close_transaction_hash TEXT,
  swap_transaction_hash  TEXT,
  settled_at            TIMESTAMPTZ DEFAULT NOW(),
  opened_at_block       BIGINT
);

CREATE INDEX IF NOT EXISTS idx_close_history_settled ON close_history (settled_at);
CREATE INDEX IF NOT EXISTS idx_close_history_quote ON close_history (quote_token);

-- Index job tracking (needed for tracker workflow)
CREATE TABLE IF NOT EXISTS index_jobs (
  job_id           TEXT PRIMARY KEY,
  owner_address    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued', -- queued | indexing | ready | error
  progress         NUMERIC DEFAULT 0,
  progress_message TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  expires_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_owner ON index_jobs (owner_address);

-- PnL result cache (needed to avoid re-computation on every page load)
CREATE TABLE IF NOT EXISTS address_pnl_cache (
  owner_address  TEXT PRIMARY KEY,
  summary_json   JSONB NOT NULL,
  positions_json JSONB NOT NULL,
  daily_json     JSONB NOT NULL,
  computed_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL
);

-- Position events (for position detail API)
CREATE TABLE IF NOT EXISTS position_events (
  id           BIGSERIAL PRIMARY KEY,
  token_id     BIGINT NOT NULL REFERENCES positions (token_id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INT NOT NULL DEFAULT 0,
  timestamp    TIMESTAMPTZ NOT NULL,
  amount0      NUMERIC DEFAULT 0,
  amount1      NUMERIC DEFAULT 0,
  price0_usd   NUMERIC,
  price1_usd   NUMERIC,
  value_usd    NUMERIC,
  UNIQUE (token_id, event_type, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_events_token ON position_events (token_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON position_events (timestamp);

-- Deposit cache (for cost-basis resolution from mint tx)
CREATE TABLE IF NOT EXISTS deposits (
  token_id      BIGINT PRIMARY KEY,
  protocol      TEXT NOT NULL DEFAULT 'v3',
  amount0       TEXT NOT NULL DEFAULT '0',
  amount1       TEXT NOT NULL DEFAULT '0',
  block_number  BIGINT NOT NULL,
  tx_hash       TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'mint',
  resolved_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposits_token ON deposits (token_id);

-- ── Migrations: safe ALTER TABLE for existing databases ────────────
-- These use IF NOT EXISTS so they're idempotent (safe to run on new + existing DBs).

ALTER TABLE positions ADD COLUMN IF NOT EXISTS quote_token    TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'open';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS liquidity      TEXT DEFAULT '0';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS opened_at_block BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS metadata      JSONB DEFAULT '{}';

-- Remove columns not in UniLP (safe to run on existing DBs — errors suppressed)
ALTER TABLE positions DROP COLUMN IF EXISTS symbol0;
ALTER TABLE positions DROP COLUMN IF EXISTS symbol1;
ALTER TABLE positions DROP COLUMN IF EXISTS decimals0;
ALTER TABLE positions DROP COLUMN IF EXISTS decimals1;
ALTER TABLE positions DROP COLUMN IF EXISTS opened_at;
ALTER TABLE positions DROP COLUMN IF EXISTS closed_at;
ALTER TABLE positions DROP COLUMN IF EXISTS last_indexed_block;

-- Remove price0_eth/price1_eth from position_events (no ETH pricing in UniLP)
ALTER TABLE position_events DROP COLUMN IF EXISTS price0_eth;
ALTER TABLE position_events DROP COLUMN IF EXISTS price1_eth;
ALTER TABLE position_events DROP COLUMN IF EXISTS value_eth;

-- Drop unused tables
DROP TABLE IF EXISTS daily_pnl_snapshot CASCADE;
DROP TABLE IF EXISTS price_cache CASCADE;
DROP TABLE IF EXISTS block_timestamps CASCADE;
