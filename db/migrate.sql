-- Migration: add columns for settlement/cashflow feature
-- Run manually: psql -U hood -d hood_tracker -f db/migrate.sql

ALTER TABLE positions ADD COLUMN IF NOT EXISTS quote_token    TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'open';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS liquidity      TEXT DEFAULT '0';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS opened_at_block BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS metadata       JSONB DEFAULT '{}';

CREATE TABLE IF NOT EXISTS cashflows (
  id               BIGSERIAL PRIMARY KEY,
  position_id      TEXT NOT NULL,
  block_number     BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  flow_type        TEXT NOT NULL CHECK (flow_type IN ('deposit', 'withdrawal', 'fee')),
  quote_value      NUMERIC NOT NULL DEFAULT 0,
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (position_id, transaction_hash, flow_type)
);
CREATE INDEX IF NOT EXISTS idx_cashflows_position ON cashflows (position_id);

CREATE TABLE IF NOT EXISTS close_history (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  position_id            TEXT NOT NULL UNIQUE,
  chain_id               INT NOT NULL DEFAULT 4663,
  protocol               TEXT NOT NULL DEFAULT 'v3',
  token0                 TEXT NOT NULL,
  token1                 TEXT NOT NULL,
  quote_token            TEXT NOT NULL,
  final_pnl_bps          NUMERIC NOT NULL DEFAULT 0,
  final_pnl_quote        NUMERIC NOT NULL DEFAULT 0,
  final_pnl_usd          NUMERIC NOT NULL DEFAULT 0,
  trigger                TEXT DEFAULT 'settled',
  close_transaction_hash TEXT,
  swap_transaction_hash  TEXT,
  settled_at             TIMESTAMPTZ DEFAULT NOW(),
  opened_at_block        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_close_history_settled ON close_history (settled_at);
CREATE INDEX IF NOT EXISTS idx_close_history_quote ON close_history (quote_token);
