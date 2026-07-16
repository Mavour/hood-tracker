/**
 * Normalize V4 position history → same PositionEvent shape as V3 engine.
 * Uses Blockscout address token-transfers API with RPC fallback.
 */

import { type Address, type Hex, zeroAddress } from "viem";
import { ROBINHOOD } from "@config/contracts";
import { getPublicClient } from "../client";
import type { PositionEvent } from "../events";
import { getV4PositionManager, getV4PoolManager, type LiveV4Position } from "./positions";
import { getV4HistoricalAmounts } from "../mint";
import { humanAmount } from "../math";
import { getTokenMeta } from "../positions";

const MODIFY_TOPIC =
  "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

type V4Transfer = {
  tx_hash: string;
  block_number: number;
  from: string;
  to: string;
  timestamp: string;
  tokenId: bigint;
};

type TxLogItem = {
  data: string;
  topics: string[];
  address: string;
  blockNumber: bigint;
  txHash: Hex;
};

/**
 * Fetch ALL V4 token transfers for an address from Blockscout (paginated).
 */
async function fetchAllV4Transfers(owner: string): Promise<V4Transfer[]> {
  const posm = getV4PositionManager();
  const all: V4Transfer[] = [];

  try {
    const url = `${ROBINHOOD.explorer}/api/v2/addresses/${owner}/token-transfers?type=ERC-721&token=${posm}`;
    const res = await withTimeout(fetch(url), 15_000);
    if (!res.ok) return all;
    const data = (await res.json()) as {
      items?: Array<{
        tx_hash?: string;
        transaction_hash?: string;
        block_number?: number;
        from?: { hash?: string };
        to?: { hash?: string };
        timestamp?: string;
        total?: { token_id?: string };
      }>;
    };

    for (const t of data.items ?? []) {
      const hash = t.transaction_hash ?? t.tx_hash;
      if (!hash || !t.total?.token_id) continue;
      all.push({
        tx_hash: hash,
        block_number: t.block_number ?? 0,
        from: (t.from?.hash ?? "").toLowerCase(),
        to: (t.to?.hash ?? "").toLowerCase(),
        timestamp: t.timestamp ?? "",
        tokenId: BigInt(t.total.token_id),
      });
    }
  } catch (e) {
    console.warn("[v4 transfers]", e instanceof Error ? e.message : e);
  }

  // RPC fallback when Blockscout returns empty or fails
  if (!all.length) {
    const rpc = await fetchAllV4TransfersRpc(owner);
    if (rpc.length) return rpc;
  }

  return all;
}

/** Fallback: fetch V4 NFT transfers via RPC eth_getLogs when Blockscout fails. */
async function fetchAllV4TransfersRpc(owner: string): Promise<V4Transfer[]> {
  const client = getPublicClient();
  const posm = getV4PositionManager();
  const all: V4Transfer[] = [];

  try {
    const latest = await withTimeout(client.getBlockNumber(), 5_000);
    const from = latest > 2_000_000n ? latest - 2_000_000n : 0n;
    const ownerAddr = owner as Address;

    const transferEvent = {
      type: "event" as const,
      name: "Transfer" as const,
      inputs: [
        { name: "from", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "tokenId", type: "uint256", indexed: true },
      ],
    } as const;

    const [logsTo, logsFrom] = await Promise.all([
      withTimeout(
        client.getLogs({
          address: posm as Hex,
          event: transferEvent,
          args: { to: ownerAddr },
          fromBlock: from,
          toBlock: latest,
        }),
        10_000,
      ).catch(() => []),
      withTimeout(
        client.getLogs({
          address: posm as Hex,
          event: transferEvent,
          args: { from: ownerAddr },
          fromBlock: from,
          toBlock: latest,
        }),
        10_000,
      ).catch(() => []),
    ]);

    for (const log of [...logsTo, ...logsFrom]) {
      const fromAddr = ("0x" + ((log.topics[1] ?? "").slice(26))).toLowerCase();
      const toAddr = ("0x" + ((log.topics[2] ?? "").slice(26))).toLowerCase();
      const tokenId = log.topics[3]
        ? BigInt(log.topics[3])
        : 0n;
      if (tokenId === 0n) continue;
      all.push({
        tx_hash: log.transactionHash ?? "",
        block_number: Number(log.blockNumber ?? 0),
        from: fromAddr,
        to: toAddr,
        timestamp: "",
        tokenId,
      });
    }
  } catch (e) {
    console.warn(
      "[v4 transfers rpc]",
      e instanceof Error ? e.message : e,
    );
  }
  return all;
}

/** Fetch tx logs from Blockscout API. Returns logs with block numbers. */
async function fetchTxLogsFromExplorer(txHash: string): Promise<TxLogItem[] | null> {
  try {
    const url = `${ROBINHOOD.explorer}/api/v2/transactions/${txHash}/logs`;
    const res = await withTimeout(fetch(url), 8_000);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{
        data?: string;
        topics?: string[];
        address?: { hash?: string };
        block_number?: number;
      }>;
    };
    return (data.items ?? []).map((l) => ({
      data: l.data ?? "0x",
      topics: l.topics ?? [],
      address: l.address?.hash ?? "",
      blockNumber: BigInt(l.block_number ?? 0),
      txHash: txHash as Hex,
    }));
  } catch (e) {
    console.warn("[v4 logs]", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Fetch tx logs via RPC (getLogs fallback). Returns raw logs. */
async function fetchTxLogsFromRpc(txHash: Hex): Promise<TxLogItem[] | null> {
  const client = getPublicClient();
  try {
    const receipt = await withTimeout(
      client.getTransactionReceipt({ hash: txHash }),
      8_000,
    );
    if (!receipt?.logs?.length) return null;
    return receipt.logs.map((l) => ({
      data: l.data,
      topics: l.topics,
      address: l.address,
      blockNumber: receipt.blockNumber,
      txHash: txHash,
    }));
  } catch (e) {
    console.warn("[v4 rpc]", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Scan PoolManager for ModifyLiquidity events matching this tokenId via RPC.
 *  Returns tx hashes for ALL modify operations (increase + decrease + collect),
 *  not just mint/burn. Uses poolId for efficient filtering when available. */
async function fetchModifyLiquidityHashesViaRpc(
  tokenId: bigint,
  poolId?: Hex,
): Promise<string[]> {
  const client = getPublicClient();
  const pm = getV4PoolManager();
  const saltHex = tokenId.toString(16).padStart(64, "0");
  const hashes = new Set<string>();

  const modifyEvent = {
    type: "event" as const,
    name: "ModifyLiquidity" as const,
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
      { name: "liquidityDelta", type: "int256", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  } as const;

  try {
    const latest = await withTimeout(client.getBlockNumber(), 5_000);
    const from = latest > 2_000_000n ? latest - 2_000_000n : 0n;

    const logs = await withTimeout(
      client.getLogs({
        address: pm as Hex,
        event: modifyEvent,
        args: poolId ? { id: poolId } : undefined,
        fromBlock: from,
        toBlock: latest,
      }),
      12_000,
    );

    for (const log of logs) {
      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      if (hex.length < 256) continue;
      // salt is last 32 bytes (bytes 192-256 of the full data)
      if (hex.slice(192, 256) !== saltHex) continue;
      if (log.transactionHash) hashes.add(log.transactionHash);
    }
  } catch (e) {
    console.warn(
      "[v4 modify rpc]",
      tokenId.toString(),
      e instanceof Error ? e.message : e,
    );
  }

  return [...hashes];
}

/**
 * Fetch V4 NFT lifecycle + ModifyLiquidity for one tokenId.
 */
export async function getV4PositionEvents(
  pos: Pick<LiveV4Position, "tokenId">,
  owner?: string,
  token0?: Address,
  token1?: Address,
  poolId?: Hex,
): Promise<PositionEvent[]> {
  const tokenId = pos.tokenId;

  // Collect all tx hashes from multiple sources
  const allTxHashes = new Set<string>();

  // Source 1: NFT transfers (mint/burn txs)
  if (owner) {
    const key = owner.toLowerCase();
    let transfers = transferCache.get(key);
    if (!transfers) {
      transfers = await fetchAllV4Transfers(owner);
      transferCache.set(key, transfers);
    }
    const transferEvents = buildV4EventsFromCache(tokenId, transfers);
    for (const e of transferEvents) allTxHashes.add(e.txHash);
  }

  // Source 2: RPC scan for ModifyLiquidity events (catches decrease/collect txs
  // that don't involve NFT transfers)
  const rpcHashes = await fetchModifyLiquidityHashesViaRpc(tokenId, poolId);
  for (const h of rpcHashes) allTxHashes.add(h);

  // Source 3: Blockscout token instance API (fallback)
  if (!allTxHashes.size) {
    const posm = getV4PositionManager();
    try {
      const xferUrl = `${ROBINHOOD.explorer}/api/v2/tokens/${posm}/instances/${tokenId}/transfers`;
      const res = await withTimeout(fetch(xferUrl), 6_000);
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{
            tx_hash?: string;
            transaction_hash?: string;
            block_number?: number;
            from?: { hash?: string };
            to?: { hash?: string };
            log_index?: number;
            timestamp?: string;
          }>;
        };
        for (const t of data.items ?? []) {
          const hash = t.transaction_hash ?? t.tx_hash;
          if (hash) allTxHashes.add(hash);
          const fromA = (t.from?.hash ?? "").toLowerCase();
          const toA = (t.to?.hash ?? "").toLowerCase();
          if (fromA === zeroAddress || toA === zeroAddress) {
            const events: PositionEvent[] = [];
            let eventType: PositionEvent["eventType"] | null = null;
            if (fromA === zeroAddress) eventType = "transfer_mint";
            else if (toA === zeroAddress) eventType = "transfer_burn";
            if (eventType) {
              events.push({
                tokenId,
                eventType,
                blockNumber: BigInt(t.block_number ?? 0),
                txHash: (hash ?? "") as Hex,
                logIndex: t.log_index ?? 0,
                timestamp: t.timestamp ? Math.floor(new Date(t.timestamp).getTime() / 1000) : 0,
                amount0: 0,
                amount1: 0,
                amount0Raw: 0n,
                amount1Raw: 0n,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn("[v4 events] fallback", tokenId.toString(), e instanceof Error ? e.message : e);
    }
  }

  // Process all tx hashes through ModifyLiquidity + ERC20 Transfer detection
  const mods = await fetchModifyLiquidityFromTxs(
    tokenId, [...allTxHashes], owner, token0, token1,
  );

  // Rebuild transfer events from cache (if available)
  let transferEvents: PositionEvent[] = [];
  if (owner) {
    const transfers = transferCache.get(owner.toLowerCase());
    if (transfers) {
      transferEvents = buildV4EventsFromCache(tokenId, transfers);
    }
  }

  const all = [...transferEvents, ...mods];
  all.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  return all;
}

/** Global cache of V4 transfers per address */
const transferCache = new Map<string, V4Transfer[]>();

export async function fetchV4TransferCache(owner: string): Promise<V4Transfer[]> {
  const key = owner.toLowerCase();
  if (transferCache.has(key)) return transferCache.get(key)!;
  const transfers = await fetchAllV4Transfers(owner);
  transferCache.set(key, transfers);
  console.log(`[v4 cache] ${transfers.length} transfers for ${key.slice(0, 10)}…`);
  return transfers;
}

export function clearV4TransferCache() {
  transferCache.clear();
}

/** Build events for one V4 position from transfer cache */
export function buildV4EventsFromCache(
  tokenId: bigint,
  transfers: V4Transfer[],
): PositionEvent[] {
  const tokenTransfers = transfers.filter((t) => t.tokenId === tokenId);
  if (!tokenTransfers.length) return [];

  const events: PositionEvent[] = [];

  for (const t of tokenTransfers) {
    const fromA = t.from;
    const toA = t.to;
    let eventType: PositionEvent["eventType"] | null = null;
    if (fromA === zeroAddress) eventType = "transfer_mint";
    else if (toA === zeroAddress) eventType = "transfer_burn";
    if (!eventType) continue;

    events.push({
      tokenId,
      eventType,
      blockNumber: BigInt(t.block_number),
      txHash: t.tx_hash as Hex,
      logIndex: 0,
      timestamp: t.timestamp ? Math.floor(new Date(t.timestamp).getTime() / 1000) : 0,
      amount0: 0,
      amount1: 0,
      amount0Raw: 0n,
      amount1Raw: 0n,
    });
  }

  return events;
}

/** Decode signed int24 from 32-byte padded hex */
function decodeInt24(hex: string): number {
  const v = Number(BigInt("0x" + hex) & 0xffffffn);
  return v & 0x800000 ? v - 0x1000000 : v;
}

/** Decode signed int256 from 32-byte hex */
function decodeInt256(hex: string): bigint {
  const v = BigInt("0x" + hex);
  return v > (1n << 255n) ? -(v ^ ((1n << 256n) - 1n)) - 1n : v;
}

/**
 * Fetch ModifyLiquidity + Collect events from tx logs.
 * Now computes real amounts using historical sqrtPriceX96.
 * Also detects V4 fee collections via ERC20 Transfer events.
 */
export async function fetchModifyLiquidityFromTxs(
  tokenId: bigint,
  txHashes: string[],
  owner?: string,
  token0?: Address,
  token1?: Address,
): Promise<PositionEvent[]> {
  const events: PositionEvent[] = [];
  const saltHex = tokenId.toString(16).padStart(64, "0");
  const posm = getV4PositionManager().toLowerCase();
  const pm = getV4PoolManager().toLowerCase();
  const t0 = token0?.toLowerCase();
  const t1 = token1?.toLowerCase();

  let decimals0 = 18;
  let decimals1 = 18;
  if (token0) {
    try { decimals0 = (await getTokenMeta(token0)).decimals; } catch { /* keep default */ }
  }
  if (token1) {
    try { decimals1 = (await getTokenMeta(token1)).decimals; } catch { /* keep default */ }
  }

  for (const txHash of txHashes) {
    // Try Blockscout first, then RPC fallback
    let logs: TxLogItem[] | null = await fetchTxLogsFromExplorer(txHash);
    if (!logs) {
      logs = await fetchTxLogsFromRpc(txHash as Hex);
    }
    if (!logs) continue;

    for (const log of logs) {
      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;

      // ModifyLiquidity event
      if ((log.topics[0] ?? "") === MODIFY_TOPIC && hex.length >= 256) {
        if (hex.slice(192, 256) !== saltHex) continue;

        const tickLower = decodeInt24(hex.slice(0, 64));
        const tickUpper = decodeInt24(hex.slice(64, 128));
        const liqDelta = decodeInt256(hex.slice(128, 192));
        if (liqDelta === 0n) continue;

        const eventType: PositionEvent["eventType"] =
          liqDelta > 0n ? "increase" : "decrease";
        const absLiq = liqDelta > 0n ? liqDelta : -liqDelta;
        const poolId = (log.topics[1] || null) as Hex | null;

        // Compute real token amounts from liquidity at this block
        let amount0 = 0n;
        let amount1 = 0n;
        if (poolId && log.blockNumber > 0n) {
          const am = await getV4HistoricalAmounts(
            poolId,
            tickLower,
            tickUpper,
            absLiq,
            log.blockNumber,
          );
          if (am) {
            amount0 = eventType === "increase" ? am.amount0 : -(am.amount0);
            amount1 = eventType === "increase" ? am.amount1 : -(am.amount1);
          }
        }

        events.push({
          tokenId,
          eventType,
          blockNumber: log.blockNumber,
          txHash: txHash as Hex,
          logIndex: 0,
          timestamp: 0,
          amount0: humanAmount(amount0, decimals0),
          amount1: humanAmount(amount1, decimals1),
          amount0Raw: amount0,
          amount1Raw: amount1,
        });
      }

      // ERC20 Transfer — detect fee collections (incoming to owner)
      if ((log.topics[0] ?? "") === TRANSFER_TOPIC && owner) {
        const ownerLc = owner.toLowerCase();
        const fromAddr = ("0x" + ((log.topics[1] ?? "").slice(26))).toLowerCase();
        const toAddr = ("0x" + ((log.topics[2] ?? "").slice(26))).toLowerCase();

        // Fee collection: tokens sent TO the owner FROM PoolManager or PositionManager
        if (
          toAddr === ownerLc &&
          fromAddr !== ownerLc &&
          (fromAddr === pm || fromAddr === posm)
        ) {
          if (hex.length >= 64) {
            const value = BigInt("0x" + hex.slice(0, 64));
            if (value > 0n) {
              const tokenAddr = log.address.toLowerCase();
              const isToken0 = t0 ? tokenAddr === t0 : false;
              const isToken1 = t1 ? tokenAddr === t1 : false;
              if (!isToken0 && !isToken1) continue;
              events.push({
                tokenId,
                eventType: "collect",
                blockNumber: log.blockNumber,
                txHash: txHash as Hex,
                logIndex: 0,
                timestamp: 0,
                amount0: isToken0 ? humanAmount(value, decimals0) : 0,
                amount1: isToken1 ? humanAmount(value, decimals1) : 0,
                amount0Raw: isToken0 ? value : 0n,
                amount1Raw: isToken1 ? value : 0n,
              });
            }
          }
        }
      }
    }
  }

  return events;
}
