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

## License

MIT
