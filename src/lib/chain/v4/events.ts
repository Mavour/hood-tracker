/**
 * Normalize V4 position history → same PositionEvent shape as V3 engine.
 * Uses Blockscout API instead of eth_getLogs (Alchemy free tier blocks wide ranges).
 */

import { type Hex, zeroAddress } from "viem";
import { ROBINHOOD } from "@config/contracts";
import type { PositionEvent } from "../events";
import {
  getV4PositionManager,
  type LiveV4Position,
} from "./positions";

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

async function fetchTxLogs(
  txHash: Hex,
): Promise<Array<{ data: string; topics: string[]; address: string }> | null> {
  try {
    const url = `${ROBINHOOD.explorer}/api/v2/transactions/${txHash}/logs`;
    const res = await withTimeout(fetch(url), 8_000);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{ data?: string; topics?: string[]; address?: { hash?: string } }>;
    };
    return (data.items ?? []).map((l) => ({
      data: l.data ?? "0x",
      topics: l.topics ?? [],
      address: l.address?.hash ?? "",
    }));
  } catch (e) {
    console.warn("[v4 logs]", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Fetch V4 NFT lifecycle + ModifyLiquidity for one tokenId via Blockscout API.
 */
export async function getV4PositionEvents(
  pos: Pick<LiveV4Position, "tokenId">,
): Promise<PositionEvent[]> {
  const tokenId = pos.tokenId;
  const posm = getV4PositionManager();
  const saltHex = tokenId.toString(16).padStart(64, "0");

  const events: PositionEvent[] = [];
  const seenTx = new Set<string>();

  // 1) Get token transfers (mint + burn) from Blockscout
  try {
    const xferUrl = `${ROBINHOOD.explorer}/api/v2/tokens/${posm}/instances/${tokenId}/transfers`;
    const res = await withTimeout(fetch(xferUrl), 10_000);
    if (res.ok) {
      const data = (await res.json()) as {
        items?: Array<{
          tx_hash?: string;
          block_number?: number;
          type?: string;
          from?: { hash?: string };
          to?: { hash?: string };
          log_index?: number;
          timestamp?: string;
        }>;
      };
      let found = 0;
      for (const t of data.items ?? []) {
        if (!t.tx_hash) continue;
        seenTx.add(t.tx_hash);
        found++;
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
      console.log(`[v4 events] #${tokenId} transfers=${found} txs=${seenTx.size}`);
    }
  } catch (e) {
    console.warn("[v4 events] transfer API", tokenId.toString(), e instanceof Error ? e.message : e);
  }

  // 2) For each transfer tx, get logs to find ModifyLiquidity events
  for (const txHash of seenTx) {
    const logs = await fetchTxLogs(txHash as Hex);
    if (!logs) continue;

    for (const log of logs) {
      if (log.topics[0] !== MODIFY_TOPIC) continue;

      const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      if (hex.length < 256) continue;
      if (hex.slice(192, 256) !== saltHex) continue;

      const liqDelta = BigInt("0x" + hex.slice(128, 192));
      const isNeg = liqDelta > (1n << 255n);
      const delta = isNeg ? -(liqDelta ^ ((1n << 256n) - 1n)) - 1n : liqDelta;
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
  }

  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  console.log(
    `[v4 events] #${tokenId} total=${events.length} (Blockscout)`,
  );
  return events;
}
