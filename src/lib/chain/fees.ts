/**
 * Live unclaimed LP fees via feeGrowthInside (Uniswap does not put accruing
 * fees into positions().tokensOwed until a decreaseLiquidity poke).
 * Adapted from unicrit/src/chain/fees.ts
 */

import type { Address } from "viem";
import { poolAbi } from "./abis";
import { getPublicClient } from "./client";
import { throttled } from "./rpc-throttle";

const Q128 = 1n << 128n;
const UINT256_MOD = 2n ** 256n;

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
  const raw = (liquidity * delta) / Q128;
  // Sanity cap: fees can never realistically exceed 10× the position's total
  // liquidity. When non-atomic RPC reads cause inconsistent feeGrowthInside
  // values, the result can be astronomically large (~2^256). In Solidity this
  // would be truncated to uint128, but BigInt has no truncation.
  if (raw > liquidity * 10n) return 0n;
  return raw;
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
    feeGrowthBelow = ((feeGrowthGlobalX128 - feeGrowthOutsideLowerX128 + UINT256_MOD) % UINT256_MOD);
  }

  let feeGrowthAbove: bigint;
  if (tickCurrent < tickUpper) {
    feeGrowthAbove = feeGrowthOutsideUpperX128;
  } else {
    feeGrowthAbove = ((feeGrowthGlobalX128 - feeGrowthOutsideUpperX128 + UINT256_MOD) % UINT256_MOD);
  }

  return ((feeGrowthGlobalX128 - feeGrowthBelow - feeGrowthAbove + UINT256_MOD * 2n) % UINT256_MOD);
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
    const g0 = await throttled(() => client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "feeGrowthGlobal0X128",
    }));
    const g1 = await throttled(() => client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "feeGrowthGlobal1X128",
    }));
    const tickL = await throttled(() => client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "ticks",
      args: [tickLower],
    }));
    const tickU = await throttled(() => client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "ticks",
      args: [tickUpper],
    }));

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
