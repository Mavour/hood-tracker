/**
 * Live / unrealized value for an OPEN LP position.
 * Reuses cached position meta from index; only refreshes slot0 + tokensOwed via RPC.
 * Supports both V3 (NPM) and V4 (StateView) positions.
 * Spec addendum: lib/pnl/getLiveValue.ts
 */

import { type Address, type Hex, pad, toHex } from "viem";
import { poolAbi, npmAbi } from "../chain/abis";
import { getPublicClient } from "../chain/client";
import { getAmountsForLiquidity, humanAmount } from "../chain/math";
import { getNpmAddress, ROBINHOOD } from "@config/contracts";
import { computeV3UnclaimedFees, feesFromGrowth } from "../chain/fees";
import { getTokenPriceLive, getPairPriceLiveFromPool } from "../pricing";
import { ttlGetOrSet } from "../cache/ttl";
import { stateViewAbi } from "../chain/v4/abis";
import { getV4StateView } from "../chain/v4/positions";
import { throttled } from "../chain/rpc-throttle";

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
  protocol?: "v3" | "v4";
  poolId?: string | null;
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
  /** true when deposit is unknown — PnL cannot be computed */
  depositMissing?: boolean;
};

const SLOT0_TTL_MS = 10_000;
const POSITION_TTL_MS = 30_000;

async function readSlot0(pool: Address): Promise<{
  sqrtPriceX96: bigint;
  tick: number;
}> {
  return ttlGetOrSet(`slot0:${pool.toLowerCase()}`, SLOT0_TTL_MS, async () => {
    const client = getPublicClient();
    const slot0 = await throttled(() => client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
    }));
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
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tickLower: number;
  tickUpper: number;
}> {
  return ttlGetOrSet(
    `posowed:${tokenId.toString()}`,
    POSITION_TTL_MS,
    async () => {
      const client = getPublicClient();
      const npm = getNpmAddress();
      const pos = await throttled(() => client.readContract({
        address: npm,
        abi: npmAbi,
        functionName: "positions",
        args: [tokenId],
      }));
      return {
        liquidity: pos[7] as bigint,
        tokensOwed0: pos[10] as bigint,
        tokensOwed1: pos[11] as bigint,
        feeGrowthInside0LastX128: pos[8] as bigint,
        feeGrowthInside1LastX128: pos[9] as bigint,
        tickLower: Number(pos[5]),
        tickUpper: Number(pos[6]),
      };
    },
  );
}

/**
 * Compute live mark + unrealized PnL for one open position.
 * V3: reads NPM positions() + pool slot0 + V3 fee growth.
 * V4: reads StateView getSlot0 + V4 fee growth (no NPM needed).
 * unrealized = currentValue + unclaimedFees + withdrawn + feesCollected - deposit
 */
export async function getLiveValue(
  meta: CachedPositionMeta,
): Promise<LiveValueResult | null> {
  const liqCached = BigInt(meta.liquidity || "0");
  const isV4 = meta.protocol === "v4";

  if (liqCached === 0n && !meta.poolAddress && !isV4) {
    return null;
  }

  const tokenId = BigInt(meta.tokenId);

  let amount0 = 0n;
  let amount1 = 0n;
  let inRange = false;
  let currentTick = 0;
  let f0Raw = 0n;
  let f1Raw = 0n;
  let liquidity = liqCached;

  if (isV4) {
    // V4: use StateView for slot0 + V4 fee growth
    const poolId = (meta.poolId as Hex) || null;
    if (!poolId) {
      console.warn("[getLiveValue] v4 missing poolId", meta.tokenId);
      return null;
    }
    const stateView = getV4StateView();
    const client = getPublicClient();
    const salt = pad(toHex(tokenId), { size: 32 });

    try {
      const slot0 = await ttlGetOrSet(
        `v4slot0:${poolId.toLowerCase()}`,
        SLOT0_TTL_MS,
        async () => {
          const s = await throttled(() => client.readContract({
            address: stateView,
            abi: stateViewAbi,
            functionName: "getSlot0",
            args: [poolId],
          }));
          return {
            sqrtPriceX96: s[0] as bigint,
            tick: Number(s[1]),
          };
        },
      );
      currentTick = slot0.tick;
      inRange = currentTick >= meta.tickLower && currentTick < meta.tickUpper;

      if (liquidity > 0n) {
        const am = getAmountsForLiquidity(
          slot0.sqrtPriceX96,
          meta.tickLower,
          meta.tickUpper,
          liquidity,
        );
        amount0 = am.amount0;
        amount1 = am.amount1;
      }
    } catch (e) {
      console.warn("[getLiveValue] v4 slot0", meta.tokenId, e);
    }

    // V4 fee growth (serialized to avoid 429s)
    if (liquidity > 0n) {
      try {
        const inside = await throttled(() => client.readContract({
          address: stateView,
          abi: stateViewAbi,
          functionName: "getFeeGrowthInside",
          args: [poolId, meta.tickLower, meta.tickUpper],
        }));
        const posInfo = await throttled(() => client.readContract({
          address: stateView,
          abi: stateViewAbi,
          functionName: "getPositionInfo",
          args: [
            poolId,
            (process.env.V4_POSITION_MANAGER as Address) ||
              ROBINHOOD.v4PositionManager,
            meta.tickLower,
            meta.tickUpper,
            salt,
          ],
        }));
        const last0 = posInfo[1] as bigint;
        const last1 = posInfo[2] as bigint;
        const liqPos = (posInfo[0] as bigint) || liquidity;
        f0Raw = feesFromGrowth(
          inside[0] as bigint,
          last0,
          liqPos,
        );
        f1Raw = feesFromGrowth(
          inside[1] as bigint,
          last1,
          liqPos,
        );
      } catch (e) {
        console.warn("[getLiveValue] v4 fees", meta.tokenId, e);
      }
    }
  } else {
    // V3 path
    const owed = await readTokensOwed(tokenId);
    liquidity = owed.liquidity > 0n ? owed.liquidity : liqCached;
    f0Raw = owed.tokensOwed0;
    f1Raw = owed.tokensOwed1;

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

      try {
        const fees = await computeV3UnclaimedFees({
          poolAddress: meta.poolAddress as Address,
          tickLower: owed.tickLower,
          tickUpper: owed.tickUpper,
          liquidity,
          feeGrowthInside0LastX128: owed.feeGrowthInside0LastX128,
          feeGrowthInside1LastX128: owed.feeGrowthInside1LastX128,
          tokensOwed0: owed.tokensOwed0,
          tokensOwed1: owed.tokensOwed1,
          currentTick,
        });
        f0Raw = fees.fees0;
        f1Raw = fees.fees1;
      } catch {
        /* keep tokensOwed */
      }
    }
  }

  const a0 = humanAmount(amount0, meta.decimals0);
  const a1 = humanAmount(amount1, meta.decimals1);
  const f0 = humanAmount(f0Raw, meta.decimals0);
  const f1 = humanAmount(f1Raw, meta.decimals1);

  let p0: { usd: number; eth: number };
  let p1: { usd: number; eth: number };

  // Use pool address directly when available (bypasses fee-tier guessing)
  if (meta.poolAddress && !isV4) {
    const pp = await getPairPriceLiveFromPool(
      meta.poolAddress as Address,
      meta.token0 as Address,
      meta.token1 as Address,
      meta.decimals0,
      meta.decimals1,
    );
    p0 = { usd: pp.price0Usd, eth: pp.price0Eth };
    p1 = { usd: pp.price1Usd, eth: pp.price1Eth };
  } else {
    // For V4 (no poolAddress) or when pool pricing fails, fall back to generic
    const [p0r, p1r] = await Promise.all([
      getTokenPriceLive(meta.token0 as Address),
      getTokenPriceLive(meta.token1 as Address),
    ]);
    p0 = p0r;
    p1 = p1r;
  }

  const principalUsd = a0 * p0.usd + a1 * p1.usd;
  const principalEth = a0 * p0.eth + a1 * p1.eth;
  const feeUnclaimedUsd = f0 * p0.usd + f1 * p1.usd;
  const feeUnclaimedEth = f0 * p0.eth + f1 * p1.eth;
  const currentValueUsd = principalUsd;
  const currentValueEth = principalEth;

  // PnL = (current + unclaimed) - deposit. Without deposit, PnL is unknown.
  const depositMissing = meta.depositUsd <= 0 && meta.depositEth <= 0;

  const unrealizedPnlUsd = depositMissing
    ? 0
    : meta.withdrawnUsd +
      meta.feesCollectedUsd +
      currentValueUsd +
      feeUnclaimedUsd -
      meta.depositUsd;
  const unrealizedPnlEth = depositMissing
    ? 0
    : meta.withdrawnEth +
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
    depositMissing,
  };
}
