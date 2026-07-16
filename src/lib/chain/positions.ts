import type { Address } from "viem";
import { getNpmAddress, getFactoryAddress, ROBINHOOD } from "@config/contracts";
import { npmAbi, factoryAbi, poolAbi, erc20Abi } from "./abis";
import { getPublicClient } from "./client";
import { getAmountsForLiquidity, humanAmount } from "./math";
import { computeV3UnclaimedFees } from "./fees";

export type PositionRaw = {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
};

export type TokenMeta = {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
};

export type LivePosition = PositionRaw & {
  owner: Address;
  poolAddress: Address | null;
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
  openedBlock?: number;
};

const metaCache = new Map<string, TokenMeta>();

export async function getTokenMeta(address: Address): Promise<TokenMeta> {
  const key = address.toLowerCase();
  const hit = metaCache.get(key);
  if (hit) return hit;

  if (key === ROBINHOOD.wrapped.toLowerCase()) {
    const m: TokenMeta = {
      address,
      symbol: "WETH",
      decimals: 18,
      name: "Wrapped Ether",
    };
    metaCache.set(key, m);
    return m;
  }
  if (key === ROBINHOOD.usdg.toLowerCase()) {
    const m: TokenMeta = {
      address,
      symbol: "USDG",
      decimals: 6,
      name: "USD Gold",
    };
    metaCache.set(key, m);
    return m;
  }

  const client = getPublicClient();
  try {
    const [symbol, decimals, name] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      client
        .readContract({ address, abi: erc20Abi, functionName: "name" })
        .catch(() => "Token"),
    ]);
    const m: TokenMeta = {
      address,
      symbol: String(symbol),
      decimals: Number(decimals),
      name: String(name),
    };
    metaCache.set(key, m);
    return m;
  } catch {
    const m: TokenMeta = {
      address,
      symbol: address.slice(0, 6),
      decimals: 18,
      name: "Unknown",
    };
    metaCache.set(key, m);
    return m;
  }
}

/** Alchemy NFT API — 1 HTTP call vs N eth_calls for enumerable. */
async function listNpmTokenIdsAlchemy(owner: Address): Promise<bigint[] | null> {
  const { getRpcUrl } = await import("./client");
  const rpc = getRpcUrl();
  if (!rpc.includes("alchemy")) return null;
  const npm = getNpmAddress();
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
            contractAddresses: [npm],
            withMetadata: false,
            omitMetadata: true,
            pageSize: 100,
          },
        ],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: {
        ownedNfts?: Array<{ id?: { tokenId?: string }; tokenId?: string }>;
      };
      error?: { message?: string };
    };
    if (json.error) {
      console.warn("[nft] alchemy_getNFTs", json.error.message);
      return null;
    }
    const ids: bigint[] = [];
    for (const n of json.result?.ownedNfts ?? []) {
      const raw = n.id?.tokenId ?? n.tokenId;
      if (raw != null) {
        try {
          ids.push(BigInt(raw.startsWith("0x") ? raw : raw));
        } catch {
          /* skip */
        }
      }
    }
    console.log(`[nft] alchemy_getNFTs → ${ids.length} for ${owner.slice(0, 10)}…`);
    // Empty array means "API worked but no NFTs" — still valid.
    // null only when API failed (caller falls back to enumerable).
    return ids;
  } catch (e) {
    console.warn("[nft] alchemy", e instanceof Error ? e.message : e);
    return null;
  }
}

/** List NPM NFT token IDs currently owned by address. */
export async function listNpmTokenIds(owner: Address): Promise<bigint[]> {
  const viaAlchemy = await listNpmTokenIdsAlchemy(owner);
  // Prefer Alchemy when it returns a list (including empty). Fall back only on API failure.
  if (viaAlchemy !== null && viaAlchemy.length > 0) return viaAlchemy;

  const client = getPublicClient();
  const npm = getNpmAddress();
  const bal = await client.readContract({
    address: npm,
    abi: npmAbi,
    functionName: "balanceOf",
    args: [owner],
  });

  const ids: bigint[] = [];
  const n = Number(bal);
  // Cap enumerate for pathological wallets
  const limit = Math.min(n, 100);
  console.log(`[nft] balanceOf=${n} enumerating ${limit}`);
  const CHUNK = 12;
  for (let i = 0; i < limit; i += CHUNK) {
    const slice = Array.from({ length: Math.min(CHUNK, limit - i) }, (_, j) =>
      client.readContract({
        address: npm,
        abi: npmAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, BigInt(i + j)],
      }),
    );
    const batch = await Promise.all(slice);
    ids.push(...batch);
  }

  // Merge Alchemy + enumerable if Alchemy returned something incomplete
  if (viaAlchemy && viaAlchemy.length) {
    const set = new Set(ids.map((x) => x.toString()));
    for (const id of viaAlchemy) {
      if (!set.has(id.toString())) ids.push(id);
    }
  }
  return ids;
}

export async function readPosition(tokenId: bigint): Promise<PositionRaw | null> {
  const client = getPublicClient();
  const npm = getNpmAddress();
  try {
    const pos = await client.readContract({
      address: npm,
      abi: npmAbi,
      functionName: "positions",
      args: [tokenId],
    });
    return {
      tokenId,
      token0: pos[2] as Address,
      token1: pos[3] as Address,
      fee: Number(pos[4]),
      tickLower: Number(pos[5]),
      tickUpper: Number(pos[6]),
      liquidity: pos[7] as bigint,
      feeGrowthInside0LastX128: pos[8] as bigint,
      feeGrowthInside1LastX128: pos[9] as bigint,
      tokensOwed0: pos[10] as bigint,
      tokensOwed1: pos[11] as bigint,
    };
  } catch {
    return null;
  }
}

export async function resolvePool(
  token0: Address,
  token1: Address,
  fee: number,
): Promise<Address | null> {
  const client = getPublicClient();
  const factory = getFactoryAddress();
  try {
    const pool = await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, fee],
    });
    if (!pool || pool === "0x0000000000000000000000000000000000000000") return null;
    return pool as Address;
  } catch {
    return null;
  }
}

export async function getLivePosition(
  tokenId: bigint,
  owner: Address,
): Promise<LivePosition | null> {
  const raw = await readPosition(tokenId);
  if (!raw) return null;

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(raw.token0),
    getTokenMeta(raw.token1),
  ]);

  const poolAddress = await resolvePool(raw.token0, raw.token1, raw.fee);
  let currentTick = 0;
  let sqrtPriceX96 = 0n;
  let amount0 = 0n;
  let amount1 = 0n;
  let unclaimed0 = raw.tokensOwed0;
  let unclaimed1 = raw.tokensOwed1;
  let inRange = false;

  if (poolAddress && raw.liquidity > 0n) {
    const client = getPublicClient();
    try {
      const slot0 = await client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "slot0",
      });
      sqrtPriceX96 = slot0[0] as bigint;
      currentTick = Number(slot0[1]);
      inRange = currentTick >= raw.tickLower && currentTick < raw.tickUpper;

      const amounts = getAmountsForLiquidity(
        sqrtPriceX96,
        raw.tickLower,
        raw.tickUpper,
        raw.liquidity,
      );
      amount0 = amounts.amount0;
      amount1 = amounts.amount1;

      // Fee growth math (full algorithm) — always on for accurate unclaimed fees
      try {
        const live = await computeV3UnclaimedFees({
          poolAddress,
          tickLower: raw.tickLower,
          tickUpper: raw.tickUpper,
          liquidity: raw.liquidity,
          feeGrowthInside0LastX128: raw.feeGrowthInside0LastX128,
          feeGrowthInside1LastX128: raw.feeGrowthInside1LastX128,
          tokensOwed0: raw.tokensOwed0,
          tokensOwed1: raw.tokensOwed1,
          currentTick,
        });
        unclaimed0 = live.fees0;
        unclaimed1 = live.fees1;
      } catch {
        /* keep tokensOwed */
      }
    } catch (e) {
      console.warn("[getLivePosition]", tokenId.toString(), e);
    }
  }

  return {
    ...raw,
    owner,
    poolAddress,
    symbol0: meta0.symbol,
    symbol1: meta1.symbol,
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
  };
}

export async function listLivePositions(owner: Address): Promise<LivePosition[]> {
  const ids = await listNpmTokenIds(owner);
  const results = await Promise.all(
    ids.map((id) => getLivePosition(id, owner).catch(() => null)),
  );
  return results.filter((p): p is LivePosition => p != null);
}
