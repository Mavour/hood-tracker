/**
 * Live unclaimed LP fees via feeGrowthInside (Uniswap does not put accruing
 * fees into positions().tokensOwed until a decreaseLiquidity poke).
 * Adapted from unicrit/src/chain/fees.ts
 */

import type { Address } from "viem";
import { poolAbi } from "./abis";
import { getPublicClient } from "./client";

const Q128 = 1n << 128n;

export function feesFromGrowth(
  feeGrowthInsideX128: bigint,
  feeGrowthInsideLastX128: bigint,
  liquidity: bigint,
): bigint {
  if (liquidity === 0n) return 0n;
  let delta = feeGrowthInsideX128 - feeGrowthInsideLastX128;
  if (delta < 0n) {
    delta = (1n << 256n) + delta;
  }
  return (liquidity * delta) / Q128;
}

export function feeGrowthInside(
  feeGrowthGlobalX128: bigint,
  feeGrowthOutsideLowerX128: bigint,
  feeGrowthOutsideUpperX128: bigint,
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
): bigint {
  let feeGrowthBelow: bigint;
  if (tickCurrent >= tickLower) {
    feeGrowthBelow = feeGrowthOutsideLowerX128;
  } else {
    feeGrowthBelow = feeGrowthGlobalX128 - feeGrowthOutsideLowerX128;
  }

  let feeGrowthAbove: bigint;
  if (tickCurrent < tickUpper) {
    feeGrowthAbove = feeGrowthOutsideUpperX128;
  } else {
    feeGrowthAbove = feeGrowthGlobalX128 - feeGrowthOutsideUpperX128;
  }

  return feeGrowthGlobalX128 - feeGrowthBelow - feeGrowthAbove;
}

export async function computeV3UnclaimedFees(params: {
  poolAddress: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  currentTick: number;
}): Promise<{ fees0: bigint; fees1: bigint }> {
  const {
    poolAddress,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    tokensOwed0,
    tokensOwed1,
    currentTick,
  } = params;

  if (liquidity === 0n) {
    return { fees0: tokensOwed0, fees1: tokensOwed1 };
  }

  const client = getPublicClient();
  try {
    const [g0, g1, tickL, tickU] = await Promise.all([
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "feeGrowthGlobal0X128",
      }),
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "feeGrowthGlobal1X128",
      }),
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "ticks",
        args: [tickLower],
      }),
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "ticks",
        args: [tickUpper],
      }),
    ]);

    const outside0L = tickL[2] as bigint;
    const outside1L = tickL[3] as bigint;
    const outside0U = tickU[2] as bigint;
    const outside1U = tickU[3] as bigint;

    const inside0 = feeGrowthInside(
      g0 as bigint,
      outside0L,
      outside0U,
      currentTick,
      tickLower,
      tickUpper,
    );
    const inside1 = feeGrowthInside(
      g1 as bigint,
      outside1L,
      outside1U,
      currentTick,
      tickLower,
      tickUpper,
    );

    return {
      fees0: tokensOwed0 + feesFromGrowth(inside0, feeGrowthInside0LastX128, liquidity),
      fees1: tokensOwed1 + feesFromGrowth(inside1, feeGrowthInside1LastX128, liquidity),
    };
  } catch (e) {
    console.warn("[fees]", e instanceof Error ? e.message : e);
    return { fees0: tokensOwed0, fees1: tokensOwed1 };
  }
}
