/**
 * Uniswap V4 positions on Robinhood — parallel to V3 NPM adapter.
 * Addresses from unicrit / config (verify on Blockscout before prod).
 */

import {
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
  zeroAddress,
} from "viem";
import { ROBINHOOD } from "../../../../config/contracts";
import { getPublicClient, getRpcUrl } from "../client";
import { getAmountsForLiquidity, humanAmount } from "../math";
import { getTokenMeta } from "../positions";
import { feesFromGrowth } from "../fees";
import { throttled } from "../rpc-throttle";
import {
  poolManagerAbi,
  stateViewAbi,
  v4PositionManagerAbi,
} from "./abis";

export type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type LiveV4Position = {
  protocol: "v4";
  tokenId: bigint;
  owner: Address;
  poolId: Hex;
  poolKey: V4PoolKey;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  amount0: bigint;
  amount1: bigint;
  amount0Human: number;
  amount1Human: number;
  unclaimed0: bigint;
  unclaimed1: bigint;
  unclaimed0Human: number;
  unclaimed1Human: number;
  currentTick: number;
  sqrtPriceX96: bigint;
  inRange: boolean;
  hasCustomHook: boolean;
  poolAddress: string | null; // null for v4; use poolId
};

function decodeSigned24(raw: bigint): number {
  const masked = raw & 0xffffffn;
  if (masked & 0x800000n) return Number(masked - 0x1000000n);
  return Number(masked);
}

export function decodeV4PositionInfo(info: bigint): {
  tickLower: number;
  tickUpper: number;
} {
  return {
    tickLower: decodeSigned24(info >> 8n),
    tickUpper: decodeSigned24(info >> 32n),
  };
}

export function computePoolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

function resolveCurrency(addr: Address): Address {
  if (addr.toLowerCase() === zeroAddress) return ROBINHOOD.wrapped;
  return addr;
}

export function getV4PositionManager(): Address {
  return (
    (process.env.V4_POSITION_MANAGER as Address) || ROBINHOOD.v4PositionManager
  );
}

export function getV4StateView(): Address {
  return (process.env.V4_STATE_VIEW as Address) || ROBINHOOD.v4StateView;
}

export function getV4PoolManager(): Address {
  return (process.env.V4_POOL_MANAGER as Address) || ROBINHOOD.v4PoolManager;
}

/** Alchemy getNFTs for V4 POSM */
async function listV4IdsAlchemy(owner: Address): Promise<bigint[] | null> {
  const rpc = getRpcUrl();
  if (!rpc.includes("alchemy")) return null;
  const posm = getV4PositionManager();
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getNFTs",
        params: [
          owner,
          {
            contractAddresses: [posm],
            withMetadata: false,
            omitMetadata: true,
          },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: {
        ownedNfts?: Array<{ id?: { tokenId?: string }; tokenId?: string }>;
      };
      error?: { message?: string };
    };
    if (json.error) {
      console.warn("[v4 nft]", json.error.message);
      return null;
    }
    const ids: bigint[] = [];
    for (const n of json.result?.ownedNfts ?? []) {
      const raw = n.id?.tokenId ?? n.tokenId;
      if (raw != null) {
        try {
          ids.push(BigInt(raw));
        } catch {
          /* skip */
        }
      }
    }
    console.log(`[v4] alchemy_getNFTs → ${ids.length}`);
    return ids;
  } catch (e) {
    console.warn("[v4] alchemy", e instanceof Error ? e.message : e);
    return null;
  }
}

async function listV4IdsTransfers(owner: Address): Promise<bigint[]> {
  const rpc = getRpcUrl();
  if (!rpc.includes("alchemy")) return [];
  const posm = getV4PositionManager();
  const ids = new Set<string>();
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [
          {
            fromBlock: "0x0",
            toBlock: "latest",
            toAddress: owner,
            contractAddresses: [posm],
            category: ["erc721"],
            maxCount: "0x3e8",
          },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const json = (await res.json()) as {
      result?: {
        transfers?: Array<{ tokenId?: string; erc721TokenId?: string }>;
      };
    };
    for (const t of json.result?.transfers ?? []) {
      const raw = t.tokenId ?? t.erc721TokenId;
      if (raw != null) {
        try {
          ids.add(BigInt(raw).toString());
        } catch {
          /* skip */
        }
      }
    }
  } catch (e) {
    console.warn("[v4] transfers", e);
  }
  return [...ids].map((s) => BigInt(s));
}

export async function listV4TokenIds(owner: Address): Promise<bigint[]> {
  const viaAlchemy = await listV4IdsAlchemy(owner);
  if (viaAlchemy && viaAlchemy.length) return viaAlchemy;

  // Fallback: transfers then filter ownerOf
  const candidates = await listV4IdsTransfers(owner);
  if (!candidates.length) return [];

  const client = getPublicClient();
  const posm = getV4PositionManager();
  const owned: bigint[] = [];
  const ownerLc = owner.toLowerCase();
  for (let i = 0; i < candidates.length; i += 12) {
    const slice = candidates.slice(i, i + 12);
    const results = await Promise.all(
      slice.map(async (id) => {
        try {
          const o = await throttled(() => client.readContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: "ownerOf",
            args: [id],
          }));
          return (o as string).toLowerCase() === ownerLc ? id : null;
        } catch {
          return null;
        }
      }),
    );
    for (const id of results) if (id != null) owned.push(id);
  }
  return owned;
}

async function computeV4UnclaimedFees(params: {
  poolId: Hex;
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): Promise<{ fees0: bigint; fees1: bigint }> {
  const { poolId, tokenId, tickLower, tickUpper, liquidity } = params;
  if (liquidity === 0n) return { fees0: 0n, fees1: 0n };

  const client = getPublicClient();
  const stateView = getV4StateView();
  const posm = getV4PositionManager();
  const salt = pad(toHex(tokenId), { size: 32 });

  try {
    const inside = await throttled(() => client.readContract({
      address: stateView,
      abi: stateViewAbi,
      functionName: "getFeeGrowthInside",
      args: [poolId, tickLower, tickUpper],
    }));
    const posInfo = await throttled(() => client.readContract({
      address: stateView,
      abi: stateViewAbi,
      functionName: "getPositionInfo",
      args: [poolId, posm, tickLower, tickUpper, salt],
    }));
    const last0 = posInfo[1] as bigint;
    const last1 = posInfo[2] as bigint;
    const liq = (posInfo[0] as bigint) || liquidity;
    return {
      fees0: feesFromGrowth(inside[0] as bigint, last0, liq),
      fees1: feesFromGrowth(inside[1] as bigint, last1, liq),
    };
  } catch (e) {
    console.warn("[v4 fees]", tokenId.toString(), e instanceof Error ? e.message : e);
    return { fees0: 0n, fees1: 0n };
  }
}

export async function getLiveV4Position(
  tokenId: bigint,
  owner: Address,
): Promise<LiveV4Position | null> {
  const client = getPublicClient();
  const posm = getV4PositionManager();
  const stateView = getV4StateView();

  let poolKeyRaw: V4PoolKey;
  let info: bigint;
  try {
    const res = await throttled(() => client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: "getPoolAndPositionInfo",
      args: [tokenId],
    }));
    const pk = res[0] as {
      currency0: Address;
      currency1: Address;
      fee: number;
      tickSpacing: number;
      hooks: Address;
    };
    poolKeyRaw = {
      currency0: pk.currency0,
      currency1: pk.currency1,
      fee: Number(pk.fee),
      tickSpacing: Number(pk.tickSpacing),
      hooks: pk.hooks,
    };
    info = res[1] as bigint;
  } catch {
    return null;
  }

  const { tickLower, tickUpper } = decodeV4PositionInfo(info);
  let liquidity = 0n;
  try {
    liquidity = (await throttled(() => client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: "getPositionLiquidity",
      args: [tokenId],
    }))) as bigint;
  } catch {
    /* 0 */
  }

  const poolId = computePoolId(poolKeyRaw);
  const token0 = resolveCurrency(poolKeyRaw.currency0);
  const token1 = resolveCurrency(poolKeyRaw.currency1);

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(token0),
    getTokenMeta(token1),
  ]);

  let currentTick = 0;
  let sqrtPriceX96 = 0n;
  let amount0 = 0n;
  let amount1 = 0n;
  let unclaimed0 = 0n;
  let unclaimed1 = 0n;
  let inRange = false;

  if (liquidity > 0n) {
    try {
      const slot0 = await throttled(() => client.readContract({
        address: stateView,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [poolId],
      }));
      sqrtPriceX96 = slot0[0] as bigint;
      currentTick = Number(slot0[1]);
      inRange = currentTick >= tickLower && currentTick < tickUpper;
      const am = getAmountsForLiquidity(
        sqrtPriceX96,
        tickLower,
        tickUpper,
        liquidity,
      );
      amount0 = am.amount0;
      amount1 = am.amount1;

      const fees = await computeV4UnclaimedFees({
        poolId,
        tokenId,
        tickLower,
        tickUpper,
        liquidity,
      });
      unclaimed0 = fees.fees0;
      unclaimed1 = fees.fees1;
    } catch (e) {
      console.warn("[v4 live]", tokenId.toString(), e);
    }
  }

  const hasCustomHook =
    poolKeyRaw.hooks.toLowerCase() !== zeroAddress.toLowerCase();

  return {
    protocol: "v4",
    tokenId,
    owner,
    poolId,
    poolKey: poolKeyRaw,
    token0,
    token1,
    fee: poolKeyRaw.fee,
    tickLower,
    tickUpper,
    liquidity,
    symbol0:
      poolKeyRaw.currency0.toLowerCase() === zeroAddress
        ? "ETH"
        : meta0.symbol,
    symbol1:
      poolKeyRaw.currency1.toLowerCase() === zeroAddress
        ? "ETH"
        : meta1.symbol,
    decimals0: meta0.decimals,
    decimals1: meta1.decimals,
    amount0,
    amount1,
    amount0Human: humanAmount(amount0, meta0.decimals),
    amount1Human: humanAmount(amount1, meta1.decimals),
    unclaimed0,
    unclaimed1,
    unclaimed0Human: humanAmount(unclaimed0, meta0.decimals),
    unclaimed1Human: humanAmount(unclaimed1, meta1.decimals),
    currentTick,
    sqrtPriceX96,
    inRange,
    hasCustomHook,
    poolAddress: null,
  };
}

export async function listLiveV4Positions(
  owner: Address,
): Promise<LiveV4Position[]> {
  const ids = await listV4TokenIds(owner);
  const out: LiveV4Position[] = [];
  for (let i = 0; i < ids.length; i += 4) {
    const chunk = ids.slice(i, i + 4);
    const batch = await Promise.all(
      chunk.map((id) => getLiveV4Position(id, owner).catch(() => null)),
    );
    for (const p of batch) if (p) out.push(p);
  }
  console.log(`[v4] live positions ${out.length}/${ids.length}`);
  return out;
}

// silence unused
void poolManagerAbi;
