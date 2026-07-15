/**
 * Normalize V4 position history → same PositionEvent shape as V3 engine.
 * Uses Blockscout address token-transfers API — reliable, no rate limits.
 */

import { type Hex, zeroAddress } from "viem";
import { ROBINHOOD } from "@config/contracts";
import type { PositionEvent } from "../events";
import { getV4PositionManager, type LiveV4Position } from "./positions";

const MODIFY_TOPIC =
  "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";

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

/**
 * Fetch ALL V4 token transfers for an address from Blockscout (paginated).
 * Returns mint, burn, and intermediate transfer events.
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
        block_number?: number;
        from?: { hash?: string };
        to?: { hash?: string };
        timestamp?: string;
        total?: { token_id?: string };
      }>;
      next_page_params?: unknown;
    };

    for (const t of data.items ?? []) {
      if (!t.tx_hash || !t.total?.token_id) continue;
      all.push({
        tx_hash: t.tx_hash,
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

  return all;
}

/**
 * Fetch V4 NFT lifecycle + ModifyLiquidity for one tokenId via Blockscout.
 * owner is optional — if provided, uses cached transfers from fetchV4TransferCache(owner).
 */
export async function getV4PositionEvents(
  pos: Pick<LiveV4Position, "tokenId">,
  owner?: string,
): Promise<PositionEvent[]> {
  const tokenId = pos.tokenId;

  // Try cached transfers for this owner
  if (owner) {
    const key = owner.toLowerCase();
    let transfers = transferCache.get(key);
    if (!transfers) {
      transfers = await fetchAllV4Transfers(owner);
      transferCache.set(key, transfers);
    }
    const events = buildV4EventsFromCache(tokenId, transfers);
    if (events.length) {
      const txHashes = [...new Set(events.map((e) => e.txHash))];
      const mods = await fetchModifyLiquidityFromTxs(tokenId, txHashes);
      const all = [...events, ...mods];
      all.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber)
          return a.blockNumber < b.blockNumber ? -1 : 1;
        return a.logIndex - b.logIndex;
      });
      console.log(`[v4 events] #${tokenId} total=${all.length} (cache)`);
      return all;
    }
  }

  // Fallback to token instance API
  const events: PositionEvent[] = [];
  const posm = getV4PositionManager();

  try {
    const xferUrl = `${ROBINHOOD.explorer}/api/v2/tokens/${posm}/instances/${tokenId}/transfers`;
    const res = await withTimeout(fetch(xferUrl), 6_000);
    if (res.ok) {
      const data = (await res.json()) as {
        items?: Array<{
          tx_hash?: string;
          block_number?: number;
          from?: { hash?: string };
          to?: { hash?: string };
          log_index?: number;
          timestamp?: string;
        }>;
      };
      const seenTx = new Set<string>();
      for (const t of data.items ?? []) {
        if (!t.tx_hash) continue;
        seenTx.add(t.tx_hash);
        const fromA = (t.from?.hash ?? "").toLowerCase();
        const toA = (t.to?.hash ?? "").toLowerCase();
        let eventType: PositionEvent["eventType"] | null = null;
        if (fromA === zeroAddress) eventType = "transfer_mint";
        else if (toA === zeroAddress) eventType = "transfer_burn";
        if (!eventType) continue;

        events.push({
          tokenId,
          eventType,
          blockNumber: BigInt(t.block_number ?? 0),
          txHash: t.tx_hash as Hex,
          logIndex: t.log_index ?? 0,
          timestamp: t.timestamp ? Math.floor(new Date(t.timestamp).getTime() / 1000) : 0,
          amount0: 0,
          amount1: 0,
          amount0Raw: 0n,
          amount1Raw: 0n,
        });
      }

      // Fetch ModifyLiquidity for these txs
      const mods = await fetchModifyLiquidityFromTxs(tokenId, [...seenTx]);
      events.push(...mods);
    }
  } catch (e) {
    console.warn("[v4 events] fallback", tokenId.toString(), e instanceof Error ? e.message : e);
  }

  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  return events;
}

/** Global cache of V4 transfers per address, valid for current index run */
const transferCache = new Map<string, V4Transfer[]>();

/** Fetch and cache all V4 transfers for an address */
export async function fetchV4TransferCache(owner: string): Promise<V4Transfer[]> {
  const key = owner.toLowerCase();
  if (transferCache.has(key)) return transferCache.get(key)!;
  const transfers = await fetchAllV4Transfers(owner);
  transferCache.set(key, transfers);
  console.log(`[v4 cache] ${transfers.length} transfers for ${key.slice(0, 10)}…`);
  return transfers;
}

/** Clear the transfer cache */
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
  const seenTx = new Set<string>();

  for (const t of tokenTransfers) {
    seenTx.add(t.tx_hash);
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

/**
 * Fetch ModifyLiquidity events from tx logs for given tx hashes.
 * Returns additional events to merge with transfer events.
 */
export async function fetchModifyLiquidityFromTxs(
  tokenId: bigint,
  txHashes: string[],
): Promise<PositionEvent[]> {
  const events: PositionEvent[] = [];
  const saltHex = tokenId.toString(16).padStart(64, "0");

  for (const txHash of txHashes) {
    try {
      const url = `${ROBINHOOD.explorer}/api/v2/transactions/${txHash}/logs`;
      const res = await withTimeout(fetch(url), 8_000);
      if (!res.ok) continue;
      const data = (await res.json()) as {
        items?: Array<{ data?: string; topics?: string[] }>;
      };

      for (const log of data.items ?? []) {
        if ((log.topics?.[0] ?? "") !== MODIFY_TOPIC) continue;

        const hex = (log.data ?? "0x").startsWith("0x")
          ? (log.data ?? "0x").slice(2)
          : (log.data ?? "");
        if (hex.length < 256) continue;
        if (hex.slice(192, 256) !== saltHex) continue;

        const liqDelta = BigInt("0x" + hex.slice(128, 192));
        const isNeg = liqDelta > (1n << 255n);
        const delta = isNeg
          ? -(liqDelta ^ ((1n << 256n) - 1n)) - 1n
          : liqDelta;
        if (delta === 0n) continue;

        events.push({
          tokenId,
          eventType: delta > 0n ? "increase" : "decrease",
          blockNumber: 0n,
          txHash: txHash as Hex,
          logIndex: 0,
          timestamp: 0,
          amount0: 0,
          amount1: 0,
          amount0Raw: 0n,
          amount1Raw: 0n,
        });
      }
    } catch {
      /* skip failed tx */
    }
  }

  return events;
}
