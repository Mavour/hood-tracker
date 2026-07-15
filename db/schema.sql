-- Hood Tracker: cache/event store only — NOT a user identity DB

CREATE TABLE IF NOT EXISTS positions (
  token_id           BIGINT PRIMARY KEY,
  owner_address      TEXT,
  pool_address       TEXT,
  token0             TEXT NOT NULL,
  token1             TEXT NOT NULL,
  fee_tier           INT NOT NULL,
  tick_lower         INT NOT NULL,
  tick_upper         INT NOT NULL,
  symbol0            TEXT,
  symbol1            TEXT,
  decimals0          INT DEFAULT 18,
  decimals1          INT DEFAULT 18,
  opened_at          TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  last_indexed_block BIGINT DEFAULT 0,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_positions_owner ON positions (owner_address);

CREATE TABLE IF NOT EXISTS position_events (
  id           BIGSERIAL PRIMARY KEY,
  token_id     BIGINT NOT NULL REFERENCES positions (token_id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL, -- increase | decrease | collect | transfer_mint | transfer_burn
  block_number BIGINT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INT NOT NULL DEFAULT 0,
  timestamp    TIMESTAMPTZ NOT NULL,
  amount0      NUMERIC DEFAULT 0,
  amount1      NUMERIC DEFAULT 0,
  price0_usd   NUMERIC,
  price1_usd   NUMERIC,
  price0_eth   NUMERIC,
  price1_eth   NUMERIC,
  value_usd    NUMERIC,
  value_eth    NUMERIC,
  UNIQUE (token_id, event_type, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_events_token ON position_events (token_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON position_events (timestamp);

CREATE TABLE IF NOT EXISTS daily_pnl_snapshot (
  owner_address     TEXT NOT NULL,
  date              DATE NOT NULL,
  net_pnl_usd       NUMERIC DEFAULT 0,
  net_pnl_eth       NUMERIC DEFAULT 0,
  fee_pnl_usd       NUMERIC DEFAULT 0,
  fee_pnl_eth       NUMERIC DEFAULT 0,
  price_pnl_usd     NUMERIC DEFAULT 0,
  price_pnl_eth     NUMERIC DEFAULT 0,
  positions_opened  INT DEFAULT 0,
  positions_closed  INT DEFAULT 0,
  deposit_usd       NUMERIC DEFAULT 0,
  withdraw_usd      NUMERIC DEFAULT 0,
  PRIMARY KEY (owner_address, date)
);

CREATE TABLE IF NOT EXISTS price_cache (
  token_address TEXT NOT NULL,
  price_date    DATE NOT NULL,
  price_usd     NUMERIC,
  price_eth     NUMERIC,
  source        TEXT,
  PRIMARY KEY (token_address, price_date)
);

CREATE TABLE IF NOT EXISTS block_timestamps (
  block_number BIGINT PRIMARY KEY,
  timestamp    TIMESTAMPTZ NOT NULL
);

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

CREATE TABLE IF NOT EXISTS address_pnl_cache (
  owner_address  TEXT PRIMARY KEY,
  summary_json   JSONB NOT NULL,
  positions_json JSONB NOT NULL,
  daily_json     JSONB NOT NULL,
  computed_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL
);
