/**
 * Canonical deposit resolution from the on-chain MINT transaction.
 *
 * Per deposited-value.md: use Blockscout explorer API throughout
 * (fast, reliable, no RPC rate limits).
 *
 * V3: decode the pool Mint event from tx logs by topic hash
 *      bytes 128-192 = amount0, bytes 192-256 = amount1
 * V4: find ERC20 Transfer events in tx logs
 */

import { type Address, type Hex, zeroAddress } from "viem";
import { getNpmAddress, ROBINHOOD } from "@config/contracts";
import { getPublicClient } from "./client";
import { transferEvent } from "./abis";
import { getV4PositionManager } from "./v4/positions";
import { getDeposit, saveDeposit, type DepositRecord } from "../db";

/** V3 pool Mint event topic (Uniswap V3 pool) */
const MINT_TOPIC =
  "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";

export type MintDeposit = {
  protocol: "v3" | "v4";
  amount0: bigint;
  amount1: bigint;
  blockNumber: bigint;
  txHash: Hex;
  source: "mint" | "increase" | "estimate";
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Find the mint transaction hash for an NFT.
 * Per deposited-value.md: use Blockscout explorer API first (fast, reliable),
 * fallback to getLogs scan if API unavailable.
 */
async function findMintTxHash(
  manager: Address,
  tokenId: bigint,
): Promise<{ txHash: Hex; blockNumber: bigint } | null> {
  // 1) Blockscout explorer API — fast, handles all edge cases
  try {
    const url = `${ROBINHOOD.explorer}/api/v2/tokens/${manager}/instances/${tokenId}/transfers`;
    const res = await withTimeout(fetch(url), 6_000);
    if (res.ok) {
      const data = (await res.json()) as {
        items?: Array<{
          tx_hash?: string;
          block_number?: number;
          type?: string;
        }>;
      };
      const mintTx = data.items?.find((t) => t.type === "token_minting");
      if (mintTx?.tx_hash) {
        return {
          txHash: mintTx.tx_hash as Hex,
          blockNumber: BigInt(mintTx.block_number ?? 0),
        };
      }
    }
  } catch (e) {
    console.warn("[mint] explorer API", e instanceof Error ? e.message : e);
  }

  // 2) Fallback: getLogs scan (tokenId and from=zero are indexed, so this is fast)
  const client = getPublicClient();
  try {
    const latest = await client.getBlockNumber().catch(() => 15_000_000n);
    const from = latest > 8_000_000n ? latest - 8_000_000n : 1n;
    const logs = await withTimeout(
      client.getLogs({
        address: manager,
        event: transferEvent,
        args: { from: zeroAddress, tokenId },
        fromBlock: from,
        toBlock: "latest" as never,
      }),
      10_000,
    );
    const log = (
      logs as Array<{ transactionHash?: Hex; blockNumber?: bigint }>
    )[0];
    if (log?.transactionHash) {
      return {
        txHash: log.transactionHash,
        blockNumber: log.blockNumber ?? 0n,
      };
    }
  } catch (e) {
    console.warn("[mint] findMintTx", tokenId.toString(), e);
  }
  return null;
}

/** Fetch transaction logs via Blockscout API.
 *  Returns raw log objects with data + topics. */
async function fetchTxLogsViaExplorer(
  txHash: Hex,
): Promise<Array<{ data: string; topics: string[]; address: string }> | null> {
  try {
    const url = `${ROBINHOOD.explorer}/api/v2/transactions/${txHash}/logs`;
    const res = await withTimeout(fetch(url), 8_000);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{
        data?: string;
        topics?: string[];
        address?: { hash?: string };
      }>;
    };
    return (data.items ?? []).map((l) => ({
      data: l.data ?? "0x",
      topics: l.topics ?? [],
      address: l.address?.hash ?? "",
    }));
  } catch (e) {
    console.warn("[mint] logs API", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Decode V3 pool Mint event data: bytes 128-192 = amount0, 192-256 = amount1 */
function decodeV3MintData(
  data: string,
): { amount0: bigint; amount1: bigint } | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 256) return null;
  const a0 = BigInt("0x" + hex.slice(128, 192));
  const a1 = BigInt("0x" + hex.slice(192, 256));
  return { amount0: a0, amount1: a1 };
}

/** V3: find the pool Mint event in tx logs via Blockscout API.
 *  Falls back to RPC receipt if API unavailable. */
async function resolveV3MintDeposit(
  tokenId: bigint,
  token0: Address,
  token1: Address,
  fee: number,
): Promise<MintDeposit | null> {
  const npm = getNpmAddress();
  const mint = await findMintTxHash(npm, tokenId);
  if (!mint) {
    console.log("[mint v3] no mint tx for", tokenId.toString(), "on", npm);
    return null;
  }
  console.log("[mint v3] mint tx found", tokenId.toString(), mint.txHash);

  // 1) Blockscout logs API
  const logs = await fetchTxLogsViaExplorer(mint.txHash);
  if (logs && logs.length > 0) {
    for (const log of logs) {
      if (log.topics[0] !== MINT_TOPIC) continue;
      const decoded = decodeV3MintData(log.data);
      if (decoded && (decoded.amount0 > 0n || decoded.amount1 > 0n)) {
        console.log(
          "[mint v3] resolved",
          tokenId.toString(),
          "a0=",
          decoded.amount0.toString(),
          "a1=",
          decoded.amount1.toString(),
        );
        return {
          protocol: "v3",
          amount0: decoded.amount0,
          amount1: decoded.amount1,
          blockNumber: mint.blockNumber,
          txHash: mint.txHash,
          source: "mint",
        };
      }
    }
    console.log("[mint v3] logs found but no Mint event", tokenId.toString(), logs.length, "logs");
  } else {
    console.log("[mint v3] no explorer logs, falling back to RPC", tokenId.toString());
  }

  // 2) RPC receipt fallback
  const { resolvePool } = await import("./positions");
  const poolAddress = await resolvePool(token0, token1, fee);
  if (!poolAddress) {
    console.log("[mint v3] pool not resolved", tokenId.toString());
    return null;
  }

  const client = getPublicClient();
  let receipt: {
    logs: Array<{ data: string; topics: string[]; address: string }>;
  } | null = null;
  try {
    receipt = await withTimeout(
      client.getTransactionReceipt({ hash: mint.txHash }),
      8_000,
    );
  } catch {
    console.log("[mint v3] receipt timeout", tokenId.toString());
    return null;
  }
  if (!receipt?.logs?.length) {
    console.log("[mint v3] empty receipt", tokenId.toString());
    return null;
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue;
    if (log.topics[0] !== MINT_TOPIC) continue;
    const decoded = decodeV3MintData(log.data);
    if (decoded && (decoded.amount0 > 0n || decoded.amount1 > 0n)) {
      console.log(
        "[mint v3] resolved via RPC",
        tokenId.toString(),
        "a0=",
        decoded.amount0.toString(),
      );
      return {
        protocol: "v3",
        amount0: decoded.amount0,
        amount1: decoded.amount1,
        blockNumber: mint.blockNumber,
        txHash: mint.txHash,
        source: "mint",
      };
    }
  }
  console.log("[mint v3] receipt has no matching Mint event", tokenId.toString(), receipt.logs.length, "logs");
  return null;
}

/** V4: decode ModifyLiquidity event (only log with token amounts in V4 mint tx).
 *  Gets liquidityDelta from event data, then calls StateView.getSlot0 at mint
 *  block to reconstruct historical deposit amounts.
 *  Falls back to ERC20 transfers + native ETH if ModifyLiquidity not found. */
async function resolveV4MintDeposit(
  tokenId: bigint,
  token0: Address,
  token1: Address,
): Promise<MintDeposit | null> {
  const posm = getV4PositionManager();
  const mint = await findMintTxHash(posm, tokenId);
  if (!mint) return null;

  // 1) Try to decode ModifyLiquidity from explorer logs
  const logs = await fetchTxLogsViaExplorer(mint.txHash);
  if (logs) {
    // ModifyLiquidity topic
    const MODIFY_TOPIC =
      "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
    const saltHex = BigInt(tokenId).toString(16).padStart(64, "0");

    for (const log of logs) {
      if (log.topics[0] !== MODIFY_TOPIC) continue;
      // Verify salt matches (last 32 bytes of data)
      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      if (hex.length < 256) continue;
      const logSalt = hex.slice(192, 256);
      if (logSalt !== saltHex) continue;

      // Decode: tickLower (bytes 0-32), tickUpper (32-64), liquidityDelta (64-96)
      const tl = Number(BigInt("0x" + hex.slice(0, 64)) & 0xffffffn);
      const tu = Number(BigInt("0x" + hex.slice(64, 128)) & 0xffffffn);
      // Handle signed int24
      const tlSigned = tl & 0x800000 ? tl - 0x1000000 : tl;
      const tuSigned = tu & 0x800000 ? tu - 0x1000000 : tu;
      const liqDelta = BigInt("0x" + hex.slice(128, 192));
      // Handle signed int256
      const isNeg = liqDelta > (1n << 255n);
      const liquidity = isNeg ? 0n : liqDelta;
      if (liquidity === 0n) continue;

      // poolId from topic[1] of the ModifyLiquidity event
      const poolId = (log.topics[1] || null) as Hex | null;
      if (!poolId) continue;

      return await computeV4HistoricalDeposit({
        poolId,
        tickLower: tlSigned,
        tickUpper: tuSigned,
        liquidity,
        token0,
        token1,
        blockNumber: mint.blockNumber,
        txHash: mint.txHash,
      });
    }
  }

  // 2) RPC receipt fallback
  const client = getPublicClient();
  let receipt: {
    logs: Array<{ data: string; topics: string[]; address: string }>;
    value?: bigint;
  } | null = null;
  try {
    receipt = await withTimeout(
      client.getTransactionReceipt({ hash: mint.txHash }),
      8_000,
    );
  } catch {
    return null;
  }
  if (receipt?.logs?.length) {
    const MODIFY_TOPIC =
      "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
    const saltHex = BigInt(tokenId).toString(16).padStart(64, "0");

    for (const log of receipt.logs) {
      if (log.topics[0] !== MODIFY_TOPIC) continue;
      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      if (hex.length < 256) continue;
      if (hex.slice(192, 256) !== saltHex) continue;
      const tl = Number(BigInt("0x" + hex.slice(0, 64)) & 0xffffffn);
      const tu = Number(BigInt("0x" + hex.slice(64, 128)) & 0xffffffn);
      const tlSigned = tl & 0x800000 ? tl - 0x1000000 : tl;
      const tuSigned = tu & 0x800000 ? tu - 0x1000000 : tu;
      const liqDelta = BigInt("0x" + hex.slice(128, 192));
      const isNeg = liqDelta > (1n << 255n);
      const liquidity = isNeg ? 0n : liqDelta;
      if (liquidity === 0n) continue;
      const poolId = (log.topics[1] || null) as Hex | null;
      if (!poolId) continue;
      return await computeV4HistoricalDeposit({
        poolId,
        tickLower: tlSigned,
        tickUpper: tuSigned,
        liquidity,
        token0,
        token1,
        blockNumber: mint.blockNumber,
        txHash: mint.txHash,
      });
    }
  }

  // 3) Native ETH + basic ERC20 fallback
  return await resolveV4MintDepositFallback({
    tokenId,
    token0,
    token1,
    mint,
    receipt: receipt ?? null,
  });
}

/** Historical deposit computation for V4: get sqrtPriceX96 at mint block,
 *  compute token amounts from liquidity. */
async function computeV4HistoricalDeposit(params: {
  poolId: Hex;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  token0: Address;
  token1: Address;
  blockNumber: bigint;
  txHash: Hex;
}): Promise<MintDeposit | null> {
  const { poolId, tickLower, tickUpper, liquidity, blockNumber, txHash } = params;
  try {
    const { stateViewAbi } = await import("./v4/abis");
    const { getV4StateView } = await import("./v4/positions");
    const { getAmountsForLiquidity } = await import("./math");

    const client = getPublicClient();
    const stateView = getV4StateView();
    const slot0 = await client.readContract({
      address: stateView,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
      blockNumber,
    });
    const sqrtPriceX96 = slot0[0] as bigint;
    const am = getAmountsForLiquidity(
      sqrtPriceX96,
      tickLower,
      tickUpper,
      liquidity,
    );

    if (am.amount0 > 0n || am.amount1 > 0n) {
      return {
        protocol: "v4",
        amount0: am.amount0,
        amount1: am.amount1,
        blockNumber,
        txHash,
        source: "mint",
      };
    }
  } catch (e) {
    console.warn("[mint] v4 historical", e instanceof Error ? e.message : e);
  }
  return null;
}

async function resolveV4MintDepositFallback(params: {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  mint: { txHash: Hex; blockNumber: bigint };
  receipt: { logs: Array<{ data: string; topics: string[]; address: string }>; value?: bigint } | null;
}): Promise<MintDeposit | null> {
  const { token0, token1, mint, receipt } = params;
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const weth = ROBINHOOD.wrapped.toLowerCase();
  const ERC20_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  let sum0 = 0n;
  let sum1 = 0n;
  let found0 = false;
  let found1 = false;

  if (receipt?.logs) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== t0 && log.address.toLowerCase() !== t1)
        continue;
      if (log.topics[0] !== ERC20_TOPIC) continue;
      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      if (hex.length < 64) continue;
      const val = BigInt("0x" + hex.slice(0, 64));
      if (val === 0n) continue;
      if (log.address.toLowerCase() === t0) {
        sum0 += val;
        found0 = true;
      } else {
        sum1 += val;
        found1 = true;
      }
    }

    if ((t0 === weth && !found0) || (t1 === weth && !found1)) {
      if (receipt.value && receipt.value > 0n) {
        if (t0 === weth) { sum0 = receipt.value; found0 = true; }
        else { sum1 = receipt.value; found1 = true; }
      }
    }
  }

  if (found0 || found1) {
    return {
      protocol: "v4",
      amount0: sum0,
      amount1: sum1,
      blockNumber: mint.blockNumber,
      txHash: mint.txHash,
      source: "mint",
    };
  }
  return null;
}

/**
 * Resolve the canonical mint deposit for a position.
 * Cached permanently; falls back to `null` if unresolvable (caller keeps
 * using IncreaseLiquidity events as before).
 */
export async function getMintDeposit(params: {
  protocol: "v3" | "v4";
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  decimals0: number;
  decimals1: number;
}): Promise<MintDeposit | null> {
  const idStr = params.tokenId.toString();

  // 1) Permanent cache (blockchain truth — never expires, lossless raw units)
  const cached = await getDeposit(idStr).catch(() => null);
  if (cached && (cached.amount0Raw || cached.amount1Raw)) {
    const a0 = cached.amount0Raw ? BigInt(cached.amount0Raw) : 0n;
    const a1 = cached.amount1Raw ? BigInt(cached.amount1Raw) : 0n;
    if (a0 > 0n || a1 > 0n) {
      return {
        protocol: cached.protocol,
        amount0: a0,
        amount1: a1,
        blockNumber: BigInt(cached.blockNumber),
        txHash: cached.txHash as Hex,
        source: cached.source,
      };
    }
  }

  // 2) Resolve from chain
  let resolved: MintDeposit | null = null;
  try {
    resolved =
      params.protocol === "v3"
        ? await resolveV3MintDeposit(
            params.tokenId,
            params.token0,
            params.token1,
            params.fee,
          )
        : await resolveV4MintDeposit(
            params.tokenId,
            params.token0,
            params.token1,
          );
  } catch (e) {
    console.warn("[mint] resolve", idStr, e);
  }

  if (resolved) {
    const rec: DepositRecord = {
      tokenId: idStr,
      protocol: resolved.protocol,
      amount0:
        Number(resolved.amount0) / 10 ** params.decimals0,
      amount1:
        Number(resolved.amount1) / 10 ** params.decimals1,
      amount0Raw: resolved.amount0.toString(),
      amount1Raw: resolved.amount1.toString(),
      blockNumber: Number(resolved.blockNumber),
      txHash: resolved.txHash,
      source: resolved.source,
    };
    await saveDeposit(rec).catch(() => null);
    return resolved;
  }

  return null;
}
