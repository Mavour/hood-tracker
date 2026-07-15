/**
 * Pricing layer: pool ratio → ETH, stables → USD, DexScreener/CoinGecko fallback.
 * Dual denomination (ETH + USD) stored so UI toggle is instant.
 */

import type { Address } from "viem";
import { ROBINHOOD } from "@config/contracts";
import { poolAbi } from "../chain/abis";
import { getPublicClient } from "../chain/client";
import { price0In1FromSqrt } from "../chain/math";
import { getTokenMeta, resolvePool } from "../chain/positions";

export type DualPrice = {
  usd: number;
  eth: number;
  source: string;
};

const liveCache = new Map<string, { price: DualPrice; at: number }>();
const LIVE_TTL = 20_000;

function isStable(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === ROBINHOOD.usdg.toLowerCase();
}

function isWeth(addr: string): boolean {
  return addr.toLowerCase() === ROBINHOOD.wrapped.toLowerCase();
}

async function fetchDexScreenerUsd(token: Address): Promise<number | null> {
  try {
    const res = await fetch(
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

async function ethUsdLive(): Promise<number> {
  // Prefer WETH/USDG pool if exists
  try {
    const pool = await resolvePool(ROBINHOOD.wrapped, ROBINHOOD.usdg, 500);
    if (pool) {
      const client = getPublicClient();
      const slot0 = await client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      });
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
 * Live dual price for a token.
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
    };
    liveCache.set(key, { price, at: Date.now() });
    return price;
  }

  if (isWeth(key)) {
    const ethUsd = await ethUsdLive();
    const price: DualPrice = { usd: ethUsd, eth: 1, source: "weth" };
    liveCache.set(key, { price, at: Date.now() });
    return price;
  }

  // Try pool vs WETH
  try {
    for (const fee of [10000, 3000, 500, 100]) {
      const pool = await resolvePool(token, ROBINHOOD.wrapped, fee);
      if (!pool) continue;
      const client = getPublicClient();
      const slot0 = await client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      });
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
        };
        liveCache.set(key, { price, at: Date.now() });
        return price;
      }
    }
  } catch {
    /* fall through */
  }

  // Pool vs USDG
  try {
    for (const fee of [10000, 3000, 500, 100]) {
      const pool = await resolvePool(token, ROBINHOOD.usdg, fee);
      if (!pool) continue;
      const client = getPublicClient();
      const slot0 = await client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      });
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
        };
        liveCache.set(key, { price, at: Date.now() });
        return price;
      }
    }
  } catch {
    /* fall through */
  }

  const ds = await fetchDexScreenerUsd(token);
  if (ds) {
    const ethUsd = await ethUsdLive();
    const price: DualPrice = {
      usd: ds,
      eth: ethUsd > 0 ? ds / ethUsd : 0,
      source: "dexscreener",
    };
    liveCache.set(key, { price, at: Date.now() });
    return price;
  }

  const price: DualPrice = { usd: 0, eth: 0, source: "unknown" };
  liveCache.set(key, { price, at: Date.now() });
  return price;
}

export async function valueDual(
  amount0: number,
  amount1: number,
  token0: Address,
  token1: Address,
): Promise<{ usd: number; eth: number }> {
  const [p0, p1] = await Promise.all([
    getTokenPriceLive(token0),
    getTokenPriceLive(token1),
  ]);
  return {
    usd: amount0 * p0.usd + amount1 * p1.usd,
    eth: amount0 * p0.eth + amount1 * p1.eth,
  };
}

/**
 * Approximate historical price: use live prices as fallback when historical
 * pool eth_call at block is unavailable. Callers should prefer getPoolPriceAtBlock.
 */
export async function getPoolPriceAtBlock(
  poolAddress: Address,
  token0: Address,
  token1: Address,
  decimals0: number,
  decimals1: number,
  blockNumber: bigint,
): Promise<{ price0Usd: number; price1Usd: number; price0Eth: number; price1Eth: number }> {
  try {
    const client = getPublicClient();
    const slot0 = await client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "slot0",
      blockNumber,
    });
    const sqrt = slot0[0] as bigint;
    const p0in1 = price0In1FromSqrt(sqrt, decimals0, decimals1);

    // Anchor to WETH or stable
    if (isWeth(token0)) {
      const ethUsd = await ethUsdLive(); // approx; historical eth/usd ideal via Chainlink
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
  } catch {
    /* fall through to live */
  }

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
