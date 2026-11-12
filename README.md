# Robinhood PNL LP Viewer

Read-only web app to view **Uniswap V3 & V4 liquidity provider PnL** on **Robinhood Chain** (chain ID `4663`).

UI styled after Robinhood’s crypto brand language (black / white / Robin Neon).

## Status (WIP)

| Area | Status |
|------|--------|
| Open / closed position listing (V3, V4) | Working |
| Live open marks | Working (best-effort) |
| **PnL accuracy** (cost basis, claimed fees history, calendar, closed realized) | **Not finished** — deposit/events often incomplete |
| First-scan speed | Target &lt;10s for open marks only; history in background |

Do not treat dollar/ETH PnL as final until cost-basis indexing is hardened.

- Paste a public `0x` address — **no wallet connect, no private keys, no permanent user DB**
- Dual denomination: **USD** and **ETH** (toggle is instant)
- Monthly **calendar heatmap** with fee vs price/IL breakdown
- Open & closed positions with explorer links

## Stack

| Layer | Tech |
|--------|------|
| Frontend | Next.js 14 (App Router) + TypeScript + Tailwind |
| Chain | `viem` → Alchemy / public Robinhood RPC |
| Cache | Postgres (events/prices) + Redis (optional PnL cache / BullMQ) |
| Worker | In-process job (default) or `worker/index.ts` via BullMQ |

## Quick start

```bash
# 1. Install
npm install

# 2. Env
cp .env.example .env
# Optional but recommended:
#   ALCHEMY_API_KEY=...
#   ROBINHOOD_CHAIN_RPC=https://robinhood-mainnet.g.alchemy.com/v2/<KEY>

# 3. (Optional) Postgres + Redis
npm run db:up

# 4. Dev server
npm run dev
# → http://localhost:3000
```

Without Docker, the app uses an **in-memory store** so you can still demo UI + live RPC reads.

## Environment variables

See [`.env.example`](./.env.example).

| Variable | Purpose |
|----------|---------|
| `ALCHEMY_API_KEY` | Preferred RPC (Alchemy Robinhood mainnet) |
| `ROBINHOOD_CHAIN_RPC` | Override full RPC URL |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis for cache + BullMQ worker |
| `NPM_CONTRACT_ADDRESS` | NonfungiblePositionManager (default from config) |
| `UNISWAP_V3_FACTORY_ADDRESS` | V3 factory |
| `PNL_CACHE_TTL` | Seconds (default 300) |
| `RATE_LIMIT_TRACK_PER_HOUR` | Track API rate limit per IP |

## Contract addresses (Robinhood Chain)

Defined in [`config/contracts.ts`](./config/contracts.ts) (sourced from on-chain / unicrit reference):

| Contract | Address |
|----------|---------|
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| NonfungiblePositionManager | `0x73991a25c818bf1f1128deaab1492d45638de0d3` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

**TODO before production:** re-verify against Uniswap official deployments + [Blockscout](https://robinhoodchain.blockscout.com).

## PnL formula

Per NFT position (aligned with unicrit + product spec):

```
depositValue   = Σ IncreaseLiquidity amounts × price_at_event
withdrawnValue = Σ DecreaseLiquidity amounts × price_at_event
feesCollected  = Σ Collect amounts × price_at_event
currentValue   = open liquidity amounts + unclaimed fees (live), else 0

netPnL   = withdrawn + feesCollected + currentValue − deposit
feePnL   = feesCollected (+ unclaimed if open)
pricePnL = netPnL − feePnL   // IL / price component
```

Pure engine: `src/lib/pnl/compute.ts`  
Unit check: `npm run test:pnl`

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/track` | Body `{ address, force? }` → `{ status, jobId }` |
| `GET` | `/api/track?jobId=` | Job progress |
| `GET` | `/api/pnl/:address?currency=usd\|eth&range=...` | Summary + daily + positions |
| `GET` | `/api/pnl/:address/day/:date` | Day detail |
| `GET` | `/api/pnl/:address/position/:tokenId` | Single position + events |

## Project layout

```
config/contracts.ts      # Chain + Uniswap addresses
db/schema.sql            # Postgres schema (cache only)
src/lib/chain/           # viem client, positions, events, math, fees
src/lib/pricing/         # Pool / DexScreener dual prices
src/lib/pnl/             # Pure PnL engine
src/lib/indexer/         # Address indexing pipeline
src/lib/db/              # Postgres + memory fallback
src/lib/cache/           # Redis + memory fallback
src/app/api/             # API routes
src/components/          # Landing, dashboard, calendar, lists
worker/index.ts          # Optional BullMQ worker
ecosystem.config.cjs     # PM2 (app + worker)
docker-compose.yml       # Postgres + Redis
```

## Deploy (VPS)

```bash
# Docker deps
docker compose up -d

# Build
npm ci
npm run build

# PM2
pm2 start ecosystem.config.cjs
pm2 save
```

Nginx sketch:

```nginx
server {
  listen 80;
  server_name pnl.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
  }
}
```

Then: `certbot --nginx -d pnl.example.com`

## Notes / risks

- Robinhood Chain is new (mainnet ~ July 2026); pool spot prices can be thin — prefer TWAP for production mark-to-market.
- Single sequencer → handle RPC retries / show “last updated” gracefully (UI already shows `computedAt`).
- Historical ETH/USD ideally via Chainlink rounds; current code uses live ETH/USD as approximation when historical oracle rounds are not configured.
- Rate-limited `POST /api/track` to protect Alchemy compute units.

## Multi-wallet LP Watcher / Agent Dorm

A separate read-only watcher runs without an open browser, Redis, wallet connection,
private key, or signing capability. Existing Next.js routes and the BullMQ worker are
unchanged. The watcher discovers held V3/V4 NFTs and refreshes their current amounts,
spot valuation, estimated unclaimed fees, and range status, one wallet at a time.

Set these values in the project's `.env` (public wallet addresses only):

```dotenv
LP_WATCHER_ENABLED=true
LP_WATCHLIST='[{"address":"YOUR_PUBLIC_EVM_ADDRESS","label":"Main"},{"address":"ANOTHER_PUBLIC_EVM_ADDRESS","label":"Second"}]'
LP_WATCHER_API_KEY=YOUR_SEPARATE_RANDOM_KEY_AT_LEAST_16_CHARACTERS
LP_WATCHER_HOST=127.0.0.1
LP_WATCHER_PORT=9003
LP_WATCH_INTERVAL_SECONDS=60
```

Replace the placeholders; no example wallet is enabled by default. Addresses are
deduplicated case-insensitively. Restart the watcher after editing its configuration.
Each cycle visits every configured wallet sequentially, then waits the configured
interval (minimum 30 seconds). Slow RPC responses extend the cycle. No cycle overlaps
another. Run with `npm run watch:lp`, or `pm2 start ecosystem.config.cjs --only hood-lp-watcher`.
Disabled or invalid configuration stops rather than repeatedly restarting under PM2.
Use Node.js 20+ as required by the existing tooling.

API, bound to loopback by default:

- `GET /health`: process liveness only; contains no wallet information.
- `GET /status`: requires `Authorization: Bearer <LP_WATCHER_API_KEY>` and returns
  `agentId: "lpwatcher"`, combined `metrics.positions` / `metrics.totals`, and
  `metrics.wallets` with each wallet's per-protocol last success and stale/error status.
- All other routes return 404; non-GET methods return 405. Requests read the in-memory
  snapshot only, never trigger RPC, index jobs, database writes, or transactions.

For Agent Dorm, use HTTP mode with URL `http://127.0.0.1:9003` and the same API key.
The service does not edit Dorm configuration or restart either application.
Across machines use a private network / authenticated HTTPS proxy; do not expose an
unencrypted financial API publicly.

Data semantics and limits:

- NFT balance and ownership are checked against the chain. Failed/partial discovery
  retains the previous successful protocol snapshot and marks it stale. A successful
  empty scan removes closed/transferred positions. Stable IDs include chain, manager,
  and token ID; an NFT moving between watched wallets is counted once.
- Existing V3 enumeration is limited to 100 NFTs; V4 discovery currently depends on
  Alchemy for nonempty wallets. Provider limitations or count mismatches are reported
  as incomplete scans, never as a successfully empty wallet. Configure the existing
  RPC settings accordingly. No unrelated provider/indexer behavior has been changed.
- Values are current spot estimates including unclaimed fees, not guaranteed exit
  proceeds. Missing USD pricing is `null` per position. Fee growth helpers can fall
  back to owed tokens, so fees are explicitly marked estimated/unclaimed-only.
- This worker does not reconstruct historical deposits/withdrawals. Per-position
  PnL, IL and opening time remain `null`. It never presents an estimated cost basis as
  verified PnL. Historical calculations in the existing dashboard remain unchanged.
- Dorm's numeric totals are **known subtotals**, including retained last-known data;
  check `metrics.totalsComplete`, `totalsAreKnownSubtotals`, `feesBasis`, per-position
  `stale`, and alerts before presenting them as complete. A numeric PnL subtotal of
  zero with `totalsComplete.unrealizedPnlUsd=false` means unknown, not zero profit/loss.
- Last-good snapshots are kept in memory for the current process. After restart the
  API shows pending warnings until each wallet has been scanned again. Wallet lists
  persist in configuration. Nothing reads or modifies private keys.

Verification: `npm run test:watcher`, `npm run test:pnl`, and `npx tsc --noEmit`.

## License

MIT
