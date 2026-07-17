/**
 * Pricing layer: pool ratio → ETH, stables → USD, DexScreener/CoinGecko fallback.
 * Dual denomination (ETH + USD) stored so UI toggle is instant.
 */

import type { Address, Hex } from "viem";
import { ROBINHOOD } from "@config/contracts";
import { poolAbi } from "../chain/abis";
import { getPublicClient } from "../chain/client";
import { price0In1FromSqrt } from "../chain/math";
import { getTokenMeta, resolvePool } from "../chain/positions";
import { stateViewAbi } from "../chain/v4/abis";
import { getV4StateView } from "../chain/v4/positions";
import { throttledRpc, throttledFetch } from "../chain/rpc-throttle";

export type DualPrice = {
  usd: number;
  eth: number;
  source: string;
  /** false when price could not be resolved (RPC failure, no pool, etc.) */
  ok: boolean;
};

const liveCache = new Map<string, { price: DualPrice; at: number }>();
const LIVE_TTL = 20_000;
/** Short TTL for failed lookups so a recovered RPC gets retried quickly. */
const FAIL_TTL = 3_000;

/**
 * Block-scoped price cache so we don't re-query the same (pool, block) twice
 * while pricing a position's event history.
 */
const blockPriceCache = new Map<
  string,
  {
    price: {
      price0Usd: number;
      price1Usd: number;
      price0Eth: number;
      price1Eth: number;
    };
    at: number;
  }
>();
const BLOCK_PRICE_TTL = 120_000;

function isStable(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === ROBINHOOD.usdg.toLowerCase();
}

function isWeth(addr: string): boolean {
  return addr.toLowerCase() === ROBINHOOD.wrapped.toLowerCase();
}

async function fetchDexScreenerUsd(token: Address): Promise<number | null> {
  try {
    const res = await throttledFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`,
      { next: { revalidate: 30 } } as RequestInit,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        priceUsd?: string;
        baseToken?: { address?: string };
        quoteToken?: { address?: string };
        liquidity?: { usd?: number };
      }>;
    };
    const slug = ROBINHOOD.dexscreenerSlug;
    const pairs = (data.pairs ?? [])
      .filter((p) => p.chainId?.toLowerCase() === slug)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    const t = token.toLowerCase();
    for (const p of pairs) {
      const base = p.baseToken?.address?.toLowerCase();
      if (base === t && p.priceUsd) {
        const n = Number(p.priceUsd);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    // fallback first pair price if base matches
    if (pairs[0]?.priceUsd && pairs[0].baseToken?.address?.toLowerCase() === t) {
      const n = Number(pairs[0].priceUsd);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  } catch {
    return null;
  }
}

export async function ethUsdLive(): Promise<number> {
  // Prefer WETH/USDG pool if exists
  try {
    const pool = await resolvePool(ROBINHOOD.wrapped, ROBINHOOD.usdg, 500);
    if (pool) {
      const client = getPublicClient();
      const slot0 = await throttledRpc(() => client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      }));
      const meta0 = await getTokenMeta(ROBINHOOD.wrapped);
      const meta1 = await getTokenMeta(ROBINHOOD.usdg);
      // token0 is lower address
      const t0 =
        ROBINHOOD.wrapped.toLowerCase() < ROBINHOOD.usdg.toLowerCase()
          ? ROBINHOOD.wrapped
          : ROBINHOOD.usdg;
      const sqrt = slot0[0] as bigint;
      if (t0.toLowerCase() === ROBINHOOD.wrapped.toLowerCase()) {
        // price of WETH in USDG
        const p = price0In1FromSqrt(sqrt, meta0.decimals, meta1.decimals);
        if (p > 0) return p;
      } else {
        const p = price0In1FromSqrt(sqrt, meta1.decimals, meta0.decimals);
        if (p > 0) return 1 / p;
      }
    }
  } catch {
    /* fall through */
  }

  const ds = await fetchDexScreenerUsd(ROBINHOOD.wrapped);
  if (ds) return ds;
  return 3000; // last-resort stub so UI still renders
}

/**
 * Historical ETH/USD price anchored to the WETH/USDG pool AT a specific block
 * (archive node). Falls back to the live ETH/USD only when the pool cannot be
 * read at that block (no archive access) — and warns, since that is a degraded
 * path per the "no live fallback for historical" rule.
 */
async function ethUsdAtBlock(blockNumber: bigint): Promise<number> {
  try {
    const pool = await resolvePool(ROBINHOOD.wrapped, ROBINHOOD.usdg, 500);
    if (pool) {
      const client = getPublicClient();
      const slot0 = await throttledRpc(() => client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
        blockNumber,
      }));
      const meta0 = await getTokenMeta(ROBINHOOD.wrapped);
      const meta1 = await getTokenMeta(ROBINHOOD.usdg);
      const t0 =
        ROBINHOOD.wrapped.toLowerCase() < ROBINHOOD.usdg.toLowerCase()
          ? ROBINHOOD.wrapped
          : ROBINHOOD.usdg;
      const sqrt = slot0[0] as bigint;
      if (t0.toLowerCase() === ROBINHOOD.wrapped.toLowerCase()) {
        const p = price0In1FromSqrt(sqrt, meta0.decimals, meta1.decimals);
        if (p > 0) return p;
      } else {
        const p = price0In1FromSqrt(sqrt, meta1.decimals, meta0.decimals);
        if (p > 0) return 1 / p;
      }
    }
  } catch {
    /* fall through to live */
  }
  console.warn(
    `[pricing] ethUsdAtBlock(${blockNumber}) unavailable — using live ETH/USD fallback`,
  );
  return ethUsdLive();
}

/**
 * Live dual price for a token pair from a KNOWN pool address.
 * Reads slot0 directly — no fee tier guessing needed.
 * Same logic as getPoolPriceAtBlock but live (no blockNumber).
 */
export async function getPairPriceLiveFromPool(
  poolAddress: Address,
  token0: Address,
  token1: Address,
  decimals0: number,
  decimals1: number,
): Promise<{ price0Usd: number; price1Usd: number; price0Eth: number; price1Eth: number }> {
  try {
    const client = getPublicClient();
    const slot0 = await throttledRpc(() => client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "slot0",
    }));
    const sqrt = slot0[0] as bigint;
    const p0in1 = price0In1FromSqrt(sqrt, decimals0, decimals1);

    if (isWeth(token0)) {
      const ethUsd = await ethUsdLive();
      return {
        price0Usd: ethUsd,
        price0Eth: 1,
        price1Usd: p0in1 > 0 ? ethUsd / p0in1 : 0,
        price1Eth: p0in1 > 0 ? 1 / p0in1 : 0,
      };
    }
    if (isWeth(token1)) {
      const ethUsd = await ethUsdLive();
      return {
        price0Usd: p0in1 * ethUsd,
        price0Eth: p0in1,
        price1Usd: ethUsd,
        price1Eth: 1,
      };
    }
    if (isStable(token0)) {
      const ethUsd = await ethUsdLive();
      return {
        price0Usd: 1,
        price0Eth: ethUsd > 0 ? 1 / ethUsd : 0,
        price1Usd: p0in1 > 0 ? 1 / p0in1 : 0,
        price1Eth: ethUsd > 0 && p0in1 > 0 ? 1 / p0in1 / ethUsd : 0,
      };
    }
    if (isStable(token1)) {
      const ethUsd = await ethUsdLive();
      return {
        price0Usd: p0in1,
        price0Eth: ethUsd > 0 ? p0in1 / ethUsd : 0,
        price1Usd: 1,
        price1Eth: ethUsd > 0 ? 1 / ethUsd : 0,
      };
    }
    // Generic token pair (neither is WETH or stable) — price each independently
    const [p0, p1] = await Promise.all([
      getTokenPriceLive(token0),
      getTokenPriceLive(token1),
    ]);
    return {
      price0Usd: p0.usd,
      price0Eth: p0.eth,
      price1Usd: p1.usd,
      price1Eth: p1.eth,
    };
  } catch {
    /* fall through */
  }
  return { price0Usd: 0, price1Usd: 0, price0Eth: 0, price1Eth: 0 };
}

/** Cache helper: store price result with appropriate TTL based on success. */
function cachePrice(key: string, price: DualPrice): void {
  const ttl = price.ok ? LIVE_TTL : FAIL_TTL;
  liveCache.set(key, { price, at: Date.now() - LIVE_TTL + ttl });
}

/**
 * Live dual price for a token.
 * Each fee-tier attempt is individually try/caught so a single RPC failure
 * doesn't abort the entire loop — the next fee tier is tried instead.
 */
export async function getTokenPriceLive(token: Address): Promise<DualPrice> {
  const key = token.toLowerCase();
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.price;

  if (isStable(key)) {
    const ethUsd = await ethUsdLive();
    const price: DualPrice = {
      usd: 1,
      eth: ethUsd > 0 ? 1 / ethUsd : 0,
      source: "stable",
      ok: true,
    };
    cachePrice(key, price);
    return price;
  }

  if (isWeth(key)) {
    const ethUsd = await ethUsdLive();
    const price: DualPrice = { usd: ethUsd, eth: 1, source: "weth", ok: true };
    cachePrice(key, price);
    return price;
  }

  // Try pool vs WETH — include custom fee tiers (Uniswap V3 fork allows arbitrary fees).
  // Each fee tier is individually try/caught so one RPC failure doesn't abort the loop.
  for (const fee of [50000, 36900, 29900, 10000, 3000, 500, 100]) {
    try {
      const pool = await resolvePool(token, ROBINHOOD.wrapped, fee);
      if (!pool) continue;
      const client = getPublicClient();
      const slot0 = await throttledRpc(() => client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      }));
      const metaT = await getTokenMeta(token);
      const metaW = await getTokenMeta(ROBINHOOD.wrapped);
      const sqrt = slot0[0] as bigint;
      const tokenIs0 = token.toLowerCase() < ROBINHOOD.wrapped.toLowerCase();
      let priceInEth: number;
      if (tokenIs0) {
        priceInEth = price0In1FromSqrt(sqrt, metaT.decimals, metaW.decimals);
      } else {
        const p = price0In1FromSqrt(sqrt, metaW.decimals, metaT.decimals);
        priceInEth = p > 0 ? 1 / p : 0;
      }
      if (priceInEth > 0) {
        const ethUsd = await ethUsdLive();
        const price: DualPrice = {
          usd: priceInEth * ethUsd,
          eth: priceInEth,
          source: `pool-weth-${fee}`,
          ok: true,
        };
        cachePrice(key, price);
        return price;
      }
    } catch (e) {
      console.warn(`[price] pool-weth-${fee} failed for ${token}`, e instanceof Error ? e.message : e);
      continue; // try next fee tier
    }
  }

  // Pool vs USDG
  for (const fee of [50000, 36900, 29900, 10000, 3000, 500, 100]) {
    try {
      const pool = await resolvePool(token, ROBINHOOD.usdg, fee);
      if (!pool) continue;
      const client = getPublicClient();
      const slot0 = await throttledRpc(() => client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      }));
      const metaT = await getTokenMeta(token);
      const metaS = await getTokenMeta(ROBINHOOD.usdg);
      const sqrt = slot0[0] as bigint;
      const tokenIs0 = token.toLowerCase() < ROBINHOOD.usdg.toLowerCase();
      let priceUsd: number;
      if (tokenIs0) {
        priceUsd = price0In1FromSqrt(sqrt, metaT.decimals, metaS.decimals);
      } else {
        const p = price0In1FromSqrt(sqrt, metaS.decimals, metaT.decimals);
        priceUsd = p > 0 ? 1 / p : 0;
      }
      if (priceUsd > 0) {
        const ethUsd = await ethUsdLive();
        const price: DualPrice = {
          usd: priceUsd,
          eth: ethUsd > 0 ? priceUsd / ethUsd : 0,
          source: `pool-usdg-${fee}`,
          ok: true,
        };
        cachePrice(key, price);
        return price;
      }
    } catch (e) {
      console.warn(`[price] pool-usdg-${fee} failed for ${token}`, e instanceof Error ? e.message : e);
      continue; // try next fee tier
    }
  }

  const ds = await fetchDexScreenerUsd(token);
  if (ds) {
    const ethUsd = await ethUsdLive();
    const price: DualPrice = {
      usd: ds,
      eth: ethUsd > 0 ? ds / ethUsd : 0,
      source: "dexscreener",
      ok: true,
    };
    cachePrice(key, price);
    return price;
  }

  const price: DualPrice = { usd: 0, eth: 0, source: "unavailable", ok: false };
  cachePrice(key, price);
  return price;
}

export async function valueDual(
  amount0: number,
  amount1: number,
  token0: Address,
  token1: Address,
): Promise<{ usd: number; eth: number; pricingIncomplete: boolean }> {
  const [p0, p1] = await Promise.all([
    getTokenPriceLive(token0),
    getTokenPriceLive(token1),
  ]);
  return {
    usd: amount0 * p0.usd + amount1 * p1.usd,
    eth: amount0 * p0.eth + amount1 * p1.eth,
    pricingIncomplete: !p0.ok || !p1.ok,
  };
}

/**
 * Historical price for a token pair AT a specific block.
 *
 * Priority (per Uniswap docs / accurate PnL):
 *   1) Pool slot0 via eth_call with `blockNumber` (exact, block-matched)
 *   2) Bridge ETH/USD via the WETH/USDG pool AT the same block
 *   — live prices are used ONLY as a last-resort when the archive node cannot
 *     serve the historical slot0 (and a warning is emitted).
 */
export async function getPoolPriceAtBlock(
  poolAddress: Address,
  token0: Address,
  token1: Address,
  decimals0: number,
  decimals1: number,
  blockNumber: bigint,
): Promise<{ price0Usd: number; price1Usd: number; price0Eth: number; price1Eth: number }> {
  const cacheKey = `${poolAddress.toLowerCase()}:${blockNumber.toString()}`;
  const cached = blockPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < BLOCK_PRICE_TTL) return cached.price;

  try {
    const client = getPublicClient();
    const slot0 = await throttledRpc(() => client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "slot0",
      blockNumber,
    }));
    const sqrt = slot0[0] as bigint;
    const p0in1 = price0In1FromSqrt(sqrt, decimals0, decimals1);

    // Anchor to WETH or stable using the BLOCK-matched ETH/USD bridge
    if (isWeth(token0)) {
      const ethUsd = await ethUsdAtBlock(blockNumber);
      const out = {
        price0Usd: ethUsd,
        price0Eth: 1,
        price1Usd: p0in1 > 0 ? ethUsd / p0in1 : 0,
        price1Eth: p0in1 > 0 ? 1 / p0in1 : 0,
      };
      blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
      return out;
    }
    if (isWeth(token1)) {
      const ethUsd = await ethUsdAtBlock(blockNumber);
      const out = {
        price0Usd: p0in1 * ethUsd,
        price0Eth: p0in1,
        price1Usd: ethUsd,
        price1Eth: 1,
      };
      blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
      return out;
    }
    if (isStable(token0)) {
      const ethUsd = await ethUsdAtBlock(blockNumber);
      const out = {
        price0Usd: 1,
        price0Eth: ethUsd > 0 ? 1 / ethUsd : 0,
        price1Usd: p0in1 > 0 ? 1 / p0in1 : 0,
        price1Eth: ethUsd > 0 && p0in1 > 0 ? 1 / p0in1 / ethUsd : 0,
      };
      blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
      return out;
    }
    if (isStable(token1)) {
      const ethUsd = await ethUsdAtBlock(blockNumber);
      const out = {
        price0Usd: p0in1,
        price0Eth: ethUsd > 0 ? p0in1 / ethUsd : 0,
        price1Usd: 1,
        price1Eth: ethUsd > 0 ? 1 / ethUsd : 0,
      };
      blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
      return out;
    }
  } catch {
    console.warn(
      `[pricing] getPoolPriceAtBlock(${poolAddress}, ${blockNumber}) failed — live fallback`,
    );
  }

  // Absolute last resort: live prices (degraded historical accuracy)
  const [p0, p1] = await Promise.all([
    getTokenPriceLive(token0),
    getTokenPriceLive(token1),
  ]);
  return {
    price0Usd: p0.usd,
    price1Usd: p1.usd,
    price0Eth: p0.eth,
    price1Eth: p1.eth,
  };
}

/**
 * V4 equivalent of getPoolPriceAtBlock — V4 pools are virtual (live inside the
 * singleton PoolManager, no per-pool contract), so price is read via
 * StateView.getSlot0(poolId) instead of pool.slot0(). Same block-matched /
 * WETH-USDG-bridge logic, no fee-tier guessing (poolId already identifies the
 * exact pool+fee for this position).
 */
export async function getV4PairPriceAtBlock(
  poolId: Hex,
  token0: Address,
  token1: Address,
  decimals0: number,
  decimals1: number,
  blockNumber: bigint,
): Promise<{ price0Usd: number; price1Usd: number; price0Eth: number; price1Eth: number }> {
  const cacheKey = `v4:${poolId.toLowerCase()}:${blockNumber.toString()}`;
  const cached = blockPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < BLOCK_PRICE_TTL) return cached.price;

  try {
    const client = getPublicClient();
    const stateView = getV4StateView();
    const slot0 = await throttledRpc(() => client.readContract({
      address: stateView,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
      blockNumber,
    }));
    const sqrt = slot0[0] as bigint;
    const p0in1 = price0In1FromSqrt(sqrt, decimals0, decimals1);

    if (isWeth(token0)) {
      const ethUsd = await ethUsdAtBlock(blockNumber);
      const out = {
        price0Usd: ethUsd,
        price0Eth: 1,
        price1Usd: p0in1 > 0 ? ethUsd / p0in1 : 0,
        price1Eth: p0in1 > 0 ? 1 / p0in1 : 0,
      };
      blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
      return out;
    }
    if (isWeth(token1)) {
      const ethUsd = await ethUsdAtBlock(blockNumber);
      const out = {
        price0Usd: p0in1 * ethUsd,
        price0Eth: p0in1,
        price1Usd: ethUsd,
        price1Eth: 1,
      };
      blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
      return out;
    }
    if (isStable(token0)) {
      const ethUsd = await ethUsdAtBlock(blockNumber);
      const out = {
        price0Usd: 1,
        price0Eth: ethUsd > 0 ? 1 / ethUsd : 0,
        price1Usd: p0in1 > 0 ? 1 / p0in1 : 0,
        price1Eth: ethUsd > 0 && p0in1 > 0 ? 1 / p0in1 / ethUsd : 0,
      };
      blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
      return out;
    }
    if (isStable(token1)) {
      const ethUsd = await ethUsdAtBlock(blockNumber);
      const out = {
        price0Usd: p0in1,
        price0Eth: ethUsd > 0 ? p0in1 / ethUsd : 0,
        price1Usd: 1,
        price1Eth: ethUsd > 0 ? 1 / ethUsd : 0,
      };
      blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
      return out;
    }
    // Generic pair (neither WETH nor stable) — price each independently
    const [p0, p1] = await Promise.all([
      getTokenPriceLive(token0),
      getTokenPriceLive(token1),
    ]);
    const out = {
      price0Usd: p0.usd,
      price0Eth: p0.eth,
      price1Usd: p1.usd,
      price1Eth: p1.eth,
    };
    blockPriceCache.set(cacheKey, { price: out, at: Date.now() });
    return out;
  } catch {
    console.warn(
      `[pricing] getV4PairPriceAtBlock(${poolId}, ${blockNumber}) failed — live fallback`,
    );
  }

  // Absolute last resort: live prices (degraded historical accuracy)
  const [p0, p1] = await Promise.all([
    getTokenPriceLive(token0),
    getTokenPriceLive(token1),
  ]);
  return {
    price0Usd: p0.usd,
    price1Usd: p1.usd,
    price0Eth: p0.eth,
    price1Eth: p1.eth,
  };
}

/**
 * Single-token historical price at a block, matched to the event timestamp.
 * Resolves via a pool vs WETH/USDG at `blockNumber` — never silently uses live
 * unless no pool path exists at that block.
 */
export async function getHistoricalPrice(
  token: Address,
  blockNumber: bigint,
): Promise<DualPrice> {
  const key = token.toLowerCase();
  if (isStable(key)) {
    const ethUsd = await ethUsdAtBlock(blockNumber);
    return { usd: 1, eth: ethUsd > 0 ? 1 / ethUsd : 0, source: "block-stable", ok: true };
  }
  if (isWeth(key)) {
    const ethUsd = await ethUsdAtBlock(blockNumber);
    return { usd: ethUsd, eth: 1, source: "block-weth", ok: true };
  }
  for (const quote of [ROBINHOOD.wrapped, ROBINHOOD.usdg]) {
    const pool = await resolvePool(token, quote, 500);
    if (!pool) continue;
    const metaT = await getTokenMeta(token);
    const metaQ = await getTokenMeta(quote);
    const t0IsToken = token.toLowerCase() < quote.toLowerCase();
    const pair = await getPoolPriceAtBlock(
      pool,
      t0IsToken ? token : quote,
      t0IsToken ? quote : token,
      metaT.decimals,
      metaQ.decimals,
      blockNumber,
    );
    const inEth = t0IsToken ? pair.price0Eth : pair.price1Eth;
    const inUsd = t0IsToken ? pair.price0Usd : pair.price1Usd;
    if (inEth > 0 || inUsd > 0) {
      return { usd: inUsd, eth: inEth, source: `block-pool-${quote === ROBINHOOD.wrapped ? "weth" : "usdg"}`, ok: true };
    }
  }
  return { usd: 0, eth: 0, source: "unavailable", ok: false };
}
