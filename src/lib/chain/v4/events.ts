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
import { throttledRpc } from "../rpc-throttle";

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
    const latest = await withTimeout(throttledRpc(() => client.getBlockNumber()), 5_000);
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
        throttledRpc(() => client.getLogs({
          address: posm as Hex,
          event: transferEvent,
          args: { to: ownerAddr },
          fromBlock: from,
          toBlock: latest,
        })),
        10_000,
      ).catch(() => []),
      withTimeout(
        throttledRpc(() => client.getLogs({
          address: posm as Hex,
          event: transferEvent,
          args: { from: ownerAddr },
          fromBlock: from,
          toBlock: latest,
        })),
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
      throttledRpc(() => client.getTransactionReceipt({ hash: txHash })),
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
    const latest = await withTimeout(throttledRpc(() => client.getBlockNumber()), 5_000);
    // Alchemy free tier: max 10 block range per eth_getLogs call — this function is
    // now a supplement for very recent activity not yet indexed by Blockscout, not the
    // primary source.
    const from = latest > 9n ? latest - 9n : 0n;

    const logs = await withTimeout(
      throttledRpc(() => client.getLogs({
        address: pm as Hex,
        event: modifyEvent,
        args: poolId ? { id: poolId } : undefined,
        fromBlock: from,
        toBlock: latest,
      })),
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

/** Primary source for V4 decrease/collect discovery — Blockscout module=logs has
 *  no block-range limit (unlike Alchemy free tier's 10-block eth_getLogs cap),
 *  same pattern as the working V3 pipeline in ../events.ts. topic0 = ModifyLiquidity
 *  signature, topic1 = poolId (indexed). Salt (tokenId) is verified from the log
 *  data afterward since it's a non-indexed field. */
async function fetchModifyLiquidityHashesViaBlockscout(
  tokenId: bigint,
  poolId?: Hex,
): Promise<string[]> {
  if (!poolId) return [];
  const pm = getV4PoolManager();
  const MODIFY_LIQUIDITY_TOPIC =
    "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
  const saltHex = tokenId.toString(16).padStart(64, "0");

  const url =
    `${ROBINHOOD.explorer}/api?module=logs&action=getLogs` +
    `&fromBlock=0&toBlock=latest` +
    `&address=${pm}` +
    `&topic0=${MODIFY_LIQUIDITY_TOPIC}&topic1=${poolId}&topic0_1_opr=and`;

  try {
    const res = await withTimeout(fetch(url), 8_000);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      status?: string;
      result?: Array<{ data?: string; transactionHash?: string }>;
    };
    if (json.status === "0" || !Array.isArray(json.result)) return [];

    const hashes = new Set<string>();
    for (const l of json.result) {
      const hex = (l.data ?? "0x").startsWith("0x")
        ? (l.data ?? "0x").slice(2)
        : (l.data ?? "");
      if (hex.length < 256) continue;
      // salt (tokenId) is the last 32 bytes — non-indexed 4th field in the data
      if (hex.slice(192, 256) !== saltHex) continue;
      if (l.transactionHash) hashes.add(l.transactionHash);
    }
    return [...hashes];
  } catch (e) {
    console.warn(
      "[v4 modify blockscout]",
      tokenId.toString(),
      e instanceof Error ? e.message.slice(0, 80) : e,
    );
    return [];
  }
}

/** Discover V4 fee collection (collect/claim) tx hashes via Blockscout.
 *  Collect txs emit ERC20 Transfer events FROM PoolManager/PositionManager TO
 *  the owner. ~93% also have ModifyLiquidity events (matched by salt in
 *  fetchModifyLiquidityFromTxs); ~7% are standalone (routed via Router) with
 *  no ModifyLiquidity. We search for Transfer logs where `to` = owner (topic2)
 *  and filter for `from` being PoolManager or PositionManager. Using the
 *  blockscout module=logs API (no block-range limit). */
async function fetchV4CollectHashesViaBlockscout(
  owner: string,
  token0?: Address,
  token1?: Address,
): Promise<string[]> {
  const pm = getV4PoolManager().toLowerCase();
  const posm = getV4PositionManager().toLowerCase();
  const TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ownerPadded = "0x" + "0".repeat(24) + owner.toLowerCase().slice(2);

  // Search both token0 and token1 contract addresses for Transfer → owner
  const tokenAddrs = [token0, token1].filter(Boolean) as Address[];
  if (!tokenAddrs.length) return [];

  const hashes = new Set<string>();

  for (const tokenAddr of tokenAddrs) {
    const url =
      `${ROBINHOOD.explorer}/api?module=logs&action=getLogs` +
      `&fromBlock=0&toBlock=latest` +
      `&address=${tokenAddr}` +
      `&topic0=${TRANSFER_TOPIC}&topic2=${ownerPadded}&topic0_2_opr=and`;

    try {
      const res = await withTimeout(fetch(url), 8_000);
      if (!res.ok) continue;
      const json = (await res.json()) as {
        status?: string;
        result?: Array<{
          data?: string;
          transactionHash?: string;
          topics?: string[];
        }>;
      };
      if (json.status === "0" || !Array.isArray(json.result)) continue;

      for (const l of json.result) {
        // topic1 = from address (padded)
        const fromTopic = l.topics?.[1] ?? "";
        const fromAddr = ("0x" + fromTopic.slice(26)).toLowerCase();
        // Only collect if from is PoolManager or PositionManager
        if (fromAddr !== pm && fromAddr !== posm) continue;
        if (l.transactionHash) hashes.add(l.transactionHash);
      }
    } catch (e) {
      console.warn(
        "[v4 collect blockscout]",
        e instanceof Error ? e.message.slice(0, 80) : e,
      );
    }
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

  // Source 2: Blockscout log scan for ModifyLiquidity events (catches decrease/collect
  // txs that don't involve NFT transfers) — full history, no RPC block-range limit.
  const modifyHashesBs = await fetchModifyLiquidityHashesViaBlockscout(tokenId, poolId);
  for (const h of modifyHashesBs) allTxHashes.add(h);

  // Source 2b: RPC scan bounded to the last 10 blocks (Alchemy free tier cap) —
  // catches very recent activity Blockscout hasn't indexed yet. Supplement only.
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

  // Source 4: ERC20 Transfer events TO owner FROM PoolManager/PositionManager —
  // these are fee collections (collect/claim). They don't emit ModifyLiquidity
  // events and don't involve NFT transfers, so Sources 1-2b miss them entirely.
  if (owner) {
    const collectHashes = await fetchV4CollectHashesViaBlockscout(owner, token0, token1);
    for (const h of collectHashes) allTxHashes.add(h);
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

/**
 * Track standalone collect tx hashes already attributed to a position.
 * Standalone collects (no ModifyLiquidity events) can't be salt-matched to a
 * specific position. We attribute them to whichever position processes the tx
 * first (first-come-first-served). This prevents both loss (current bug) and
 * duplication (multi-position pools). Total owner fees remain accurate.
 * Reset per indexing run via clearStandaloneCollectTracker().
 */
const attributedStandaloneCollects = new Set<string>();

export function clearStandaloneCollectTracker() {
  attributedStandaloneCollects.clear();
  v4CollectEventsByPool.clear();
}

/** Raw collect events accumulated during indexing, keyed by "token0:token1". */
const v4CollectEventsByPool = new Map<string, Array<{ amount0Raw: bigint; amount1Raw: bigint }>>();

export function consumeV4CollectEvents(): Map<string, Array<{ amount0Raw: bigint; amount1Raw: bigint }>> {
  const copy = new Map(v4CollectEventsByPool);
  v4CollectEventsByPool.clear();
  return copy;
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

    // First pass: collect salts from ModifyLiquidity events in this tx.
    // This lets us verify that ERC20 Transfers (fee collects) belong to this
    // specific position rather than another position in the same pool.
    const txModifySalts = new Set<string>();
    for (const log of logs) {
      if ((log.topics[0] ?? "") === MODIFY_TOPIC) {
        const h = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
        if (h.length >= 256) {
          txModifySalts.add(h.slice(192, 256));
        }
      }
    }
    const txHasMySalt = txModifySalts.has(saltHex);

    // Second pass: process ModifyLiquidity events first to capture principal amounts
    // from "decrease" events. We need these to subtract from Transfer values later.
    const decreasePrincipal = { amount0Raw: 0n, amount1Raw: 0n };
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
            amount0 = am.amount0;
            amount1 = am.amount1;
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

        // Track principal from decrease events to subtract from Transfer values later
        if (eventType === "decrease") {
          decreasePrincipal.amount0Raw += amount0;
          decreasePrincipal.amount1Raw += amount1;
        }
      }
    }

    // Third pass: process ERC20 Transfer events for fee collection
    // Subtract principal (from decrease) from Transfer value to get pure fees
    const isStandaloneCollect = txModifySalts.size === 0;
    const canCollect = txHasMySalt || (isStandaloneCollect && !attributedStandaloneCollects.has(txHash));
    if (!owner || !canCollect) continue;

    const ownerLc = owner.toLowerCase();
    for (const log of logs) {
      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;

      if ((log.topics[0] ?? "") === TRANSFER_TOPIC) {
        const fromAddr = ("0x" + ((log.topics[1] ?? "").slice(26))).toLowerCase();
        const toAddr = ("0x" + ((log.topics[2] ?? "").slice(26))).toLowerCase();

        // Fee collection: tokens sent TO the owner FROM PoolManager or PositionManager
        if (
          toAddr === ownerLc &&
          fromAddr !== ownerLc &&
          (fromAddr === pm || fromAddr === posm)
        ) {
          if (hex.length >= 64) {
            const rawValue = BigInt("0x" + hex.slice(0, 64));
            if (rawValue === 0n) continue;

            const tokenAddr = log.address.toLowerCase();
            const isToken0 = t0 ? tokenAddr === t0 : false;
            const isToken1 = t1 ? tokenAddr === t1 : false;
            if (!isToken0 && !isToken1) continue;

            // Subtract principal that was already recorded as "decrease" in this tx
            // The Transfer combines principal + fees; we only want the fee portion
            let feeValue = rawValue;
            if (isToken0 && decreasePrincipal.amount0Raw > 0n) {
              const used = decreasePrincipal.amount0Raw < feeValue ? decreasePrincipal.amount0Raw : feeValue;
              feeValue -= used;
              decreasePrincipal.amount0Raw -= used;
            } else if (isToken1 && decreasePrincipal.amount1Raw > 0n) {
              const used = decreasePrincipal.amount1Raw < feeValue ? decreasePrincipal.amount1Raw : feeValue;
              feeValue -= used;
              decreasePrincipal.amount1Raw -= used;
            }

            // Only record as "collect" if there's actual fee value remaining
            if (feeValue > 0n) {
              if (isStandaloneCollect) attributedStandaloneCollects.add(txHash);
              const a0 = isToken0 ? feeValue : 0n;
              const a1 = isToken1 ? feeValue : 0n;
              events.push({
                tokenId,
                eventType: "collect",
                blockNumber: log.blockNumber,
                txHash: txHash as Hex,
                logIndex: 0,
                timestamp: 0,
                amount0: isToken0 ? humanAmount(feeValue, decimals0) : 0,
                amount1: isToken1 ? humanAmount(feeValue, decimals1) : 0,
                amount0Raw: a0,
                amount1Raw: a1,
              });
              if (t0 && t1) {
                const poolKey = `${t0}:${t1}`;
                const arr = v4CollectEventsByPool.get(poolKey) ?? [];
                arr.push({ amount0Raw: a0, amount1Raw: a1 });
                v4CollectEventsByPool.set(poolKey, arr);
              }
            }
          }
        }
      }
    }
  }

  return events;
}

/**
 * On-chain ground truth for fee collections.
 * Sums ALL ERC20 Transfer events from PoolManager/PositionManager → owner
 * for the given token pair. This is the actual amount received on-chain,
 * independent of which position it was attributed to.
 */
export async function fetchOnChainCollectTotals(
  owner: string,
  token0?: Address,
  token1?: Address,
): Promise<{ total0Raw: bigint; total1Raw: bigint; txCount: number }> {
  const pm = getV4PoolManager().toLowerCase();
  const posm = getV4PositionManager().toLowerCase();
  const ownerPadded = "0x" + "0".repeat(24) + owner.toLowerCase().slice(2);
  const tokenAddrs = [token0, token1].filter(Boolean) as Address[];

  let total0Raw = 0n;
  let total1Raw = 0n;
  const txHashes = new Set<string>();

  for (const tokenAddr of tokenAddrs) {
    const url =
      `${ROBINHOOD.explorer}/api?module=logs&action=getLogs` +
      `&fromBlock=0&toBlock=latest` +
      `&address=${tokenAddr}` +
      `&topic0=${TRANSFER_TOPIC}&topic2=${ownerPadded}&topic0_2_opr=and`;

    try {
      const res = await withTimeout(fetch(url), 8_000);
      if (!res.ok) continue;
      const json = (await res.json()) as {
        status?: string;
        result?: Array<{
          data?: string;
          transactionHash?: string;
          topics?: string[];
        }>;
      };
      if (json.status === "0" || !Array.isArray(json.result)) continue;

      const isToken0 = token0 ? tokenAddr.toLowerCase() === token0.toLowerCase() : false;

      for (const l of json.result) {
        const fromTopic = l.topics?.[1] ?? "";
        const fromAddr = ("0x" + fromTopic.slice(26)).toLowerCase();
        if (fromAddr !== pm && fromAddr !== posm) continue;

        const hex = (l.data ?? "0x").startsWith("0x")
          ? (l.data ?? "0x").slice(2)
          : (l.data ?? "");
        if (hex.length < 64) continue;
        const value = BigInt("0x" + hex.slice(0, 64));
        if (value <= 0n) continue;

        if (isToken0) total0Raw += value;
        else total1Raw += value;
        if (l.transactionHash) txHashes.add(l.transactionHash);
      }
    } catch (e) {
      console.warn(
        "[v4 reconcile]",
        e instanceof Error ? e.message.slice(0, 80) : e,
      );
    }
  }

  return { total0Raw, total1Raw, txCount: txHashes.size };
}

export type ReconcileResult = {
  poolLabel: string;
  systemTotal0Raw: bigint;
  systemTotal1Raw: bigint;
  groundTruth0Raw: bigint;
  groundTruth1Raw: bigint;
  diff0Pct: number;
  diff1Pct: number;
  ok: boolean;
};

/**
 * Reconcile system-computed collect totals against on-chain ground truth.
 * Returns diff percentages for each token. ok=true if both diffs < 2%.
 */
export async function reconcilePoolFees(
  owner: string,
  token0: Address | undefined,
  token1: Address | undefined,
  systemCollectEvents: Array<{ amount0Raw: bigint; amount1Raw: bigint }>,
): Promise<ReconcileResult> {
  const ground = await fetchOnChainCollectTotals(owner, token0, token1);

  let sys0 = 0n;
  let sys1 = 0n;
  for (const e of systemCollectEvents) {
    sys0 += e.amount0Raw;
    sys1 += e.amount1Raw;
  }

  const diff0 = ground.total0Raw > 0n
    ? Number((sys0 > ground.total0Raw ? sys0 - ground.total0Raw : ground.total0Raw - sys0) * 10000n / ground.total0Raw) / 100
    : sys0 > 0n ? 100 : 0;
  const diff1 = ground.total1Raw > 0n
    ? Number((sys1 > ground.total1Raw ? sys1 - ground.total1Raw : ground.total1Raw - sys1) * 10000n / ground.total1Raw) / 100
    : sys1 > 0n ? 100 : 0;

  const ok = diff0 < 2 && diff1 < 2;
  const label = `${token0?.slice(0, 8)}…/${token1?.slice(0, 8)}…`;

  return {
    poolLabel: label,
    systemTotal0Raw: sys0,
    systemTotal1Raw: sys1,
    groundTruth0Raw: ground.total0Raw,
    groundTruth1Raw: ground.total1Raw,
    diff0Pct: diff0,
    diff1Pct: diff1,
    ok,
  };
}
