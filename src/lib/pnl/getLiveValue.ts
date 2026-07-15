/**
 * Live / unrealized value for an OPEN LP position.
 * Reuses cached position meta from index; only refreshes slot0 + tokensOwed via RPC.
 * Spec addendum: lib/pnl/getLiveValue.ts
 */

import type { Address } from "viem";
import { poolAbi, npmAbi } from "../chain/abis";
import { getPublicClient } from "../chain/client";
import { getAmountsForLiquidity, humanAmount } from "../chain/math";
import { getNpmAddress } from "@config/contracts";
import { getTokenPriceLive } from "../pricing";
import { ttlGetOrSet } from "../cache/ttl";

export type CachedPositionMeta = {
  tokenId: string;
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  poolAddress: string | null;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  fee: number;
  /** cost basis from indexed events */
  depositUsd: number;
  depositEth: number;
  feesCollectedUsd: number;
  feesCollectedEth: number;
  withdrawnUsd: number;
  withdrawnEth: number;
};

export type LiveValueResult = {
  tokenId: string;
  currentValueUsd: number;
  currentValueEth: number;
  feeUnclaimedUsd: number;
  feeUnclaimedEth: number;
  /** principal only (amounts from liquidity, excl unclaimed fees) */
  principalUsd: number;
  principalEth: number;
  unrealizedPnlUsd: number;
  unrealizedPnlEth: number;
  inRange: boolean;
  amount0Human: number;
  amount1Human: number;
  lastUpdated: string;
};

const SLOT0_TTL_MS = 10_000;
const POSITION_TTL_MS = 30_000;

async function readSlot0(pool: Address): Promise<{
  sqrtPriceX96: bigint;
  tick: number;
}> {
  return ttlGetOrSet(`slot0:${pool.toLowerCase()}`, SLOT0_TTL_MS, async () => {
    const client = getPublicClient();
    const slot0 = await client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
    });
    return {
      sqrtPriceX96: slot0[0] as bigint,
      tick: Number(slot0[1]),
    };
  });
}

async function readTokensOwed(tokenId: bigint): Promise<{
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}> {
  return ttlGetOrSet(
    `posowed:${tokenId.toString()}`,
    POSITION_TTL_MS,
    async () => {
      const client = getPublicClient();
      const npm = getNpmAddress();
      const pos = await client.readContract({
        address: npm,
        abi: npmAbi,
        functionName: "positions",
        args: [tokenId],
      });
      return {
        liquidity: pos[7] as bigint,
        tokensOwed0: pos[10] as bigint,
        tokensOwed1: pos[11] as bigint,
      };
    },
  );
}

/**
 * Compute live mark + unrealized PnL for one open position.
 * unrealized = currentValue + unclaimedFees + withdrawn + feesCollected - deposit
 * (same as full net PnL while open)
 */
export async function getLiveValue(
  meta: CachedPositionMeta,
): Promise<LiveValueResult | null> {
  const liqCached = BigInt(meta.liquidity || "0");
  if (liqCached === 0n && !meta.poolAddress) {
    return null;
  }

  const tokenId = BigInt(meta.tokenId);
  const owed = await readTokensOwed(tokenId);
  const liquidity = owed.liquidity > 0n ? owed.liquidity : liqCached;

  let amount0 = 0n;
  let amount1 = 0n;
  let inRange = false;
  let currentTick = 0;

  if (meta.poolAddress && liquidity > 0n) {
    try {
      const slot = await readSlot0(meta.poolAddress as Address);
      currentTick = slot.tick;
      inRange =
        currentTick >= meta.tickLower && currentTick < meta.tickUpper;
      const am = getAmountsForLiquidity(
        slot.sqrtPriceX96,
        meta.tickLower,
        meta.tickUpper,
        liquidity,
      );
      amount0 = am.amount0;
      amount1 = am.amount1;
    } catch (e) {
      console.warn("[getLiveValue] slot0", meta.tokenId, e);
    }
  }

  const a0 = humanAmount(amount0, meta.decimals0);
  const a1 = humanAmount(amount1, meta.decimals1);
  const f0 = humanAmount(owed.tokensOwed0, meta.decimals0);
  const f1 = humanAmount(owed.tokensOwed1, meta.decimals1);

  const [p0, p1] = await Promise.all([
    getTokenPriceLive(meta.token0 as Address),
    getTokenPriceLive(meta.token1 as Address),
  ]);

  const principalUsd = a0 * p0.usd + a1 * p1.usd;
  const principalEth = a0 * p0.eth + a1 * p1.eth;
  const feeUnclaimedUsd = f0 * p0.usd + f1 * p1.usd;
  const feeUnclaimedEth = f0 * p0.eth + f1 * p1.eth;
  const currentValueUsd = principalUsd; // principal; fees separate
  const currentValueEth = principalEth;

  // Full open-position net (matches compute engine)
  const unrealizedPnlUsd =
    meta.withdrawnUsd +
    meta.feesCollectedUsd +
    currentValueUsd +
    feeUnclaimedUsd -
    meta.depositUsd;
  const unrealizedPnlEth =
    meta.withdrawnEth +
    meta.feesCollectedEth +
    currentValueEth +
    feeUnclaimedEth -
    meta.depositEth;

  return {
    tokenId: meta.tokenId,
    currentValueUsd,
    currentValueEth,
    feeUnclaimedUsd,
    feeUnclaimedEth,
    principalUsd,
    principalEth,
    unrealizedPnlUsd,
    unrealizedPnlEth,
    inRange,
    amount0Human: a0,
    amount1Human: a1,
    lastUpdated: new Date().toISOString(),
  };
}
