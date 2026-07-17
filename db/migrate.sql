-- Migration: Simplify schema to align with UniLP-Monitoring
-- Run manually: psql -U hood -d hood_tracker -f db/migrate.sql

-- Drop unused tables
DROP TABLE IF EXISTS daily_pnl_snapshot CASCADE;
DROP TABLE IF EXISTS price_cache CASCADE;
DROP TABLE IF EXISTS block_timestamps CASCADE;

-- Remove columns not in UniLP from positions
ALTER TABLE positions DROP COLUMN IF EXISTS symbol0;
ALTER TABLE positions DROP COLUMN IF EXISTS symbol1;
ALTER TABLE positions DROP COLUMN IF EXISTS decimals0;
ALTER TABLE positions DROP COLUMN IF EXISTS decimals1;
ALTER TABLE positions DROP COLUMN IF EXISTS opened_at;
ALTER TABLE positions DROP COLUMN IF EXISTS closed_at;
ALTER TABLE positions DROP COLUMN IF EXISTS last_indexed_block;

-- Remove ETH pricing columns from position_events
ALTER TABLE position_events DROP COLUMN IF EXISTS price0_eth;
ALTER TABLE position_events DROP COLUMN IF EXISTS price1_eth;
ALTER TABLE position_events DROP COLUMN IF EXISTS value_eth;

-- Ensure required columns exist (idempotent)
ALTER TABLE positions ADD COLUMN IF NOT EXISTS quote_token    TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'open';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS liquidity      TEXT DEFAULT '0';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS opened_at_block BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS metadata      JSONB DEFAULT '{}';
