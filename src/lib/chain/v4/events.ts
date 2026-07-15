/**
 * Normalize V4 position history → same PositionEvent shape as V3 engine.
 *
 * V4 does not always emit V3-style Collect; fee claims often ride with
 * ModifyLiquidity / take. We still map:
 *  - Transfer mint/burn on PositionManager
 *  - ModifyLiquidity on PoolManager (salt = bytes32(tokenId)):
 *      liquidityDelta > 0 → increase, < 0 → decrease
 *
 * Token amounts for modify are not in the event — amount0/1 left 0 unless
 * we later price via pool at block (MVP: liquidity delta only for open/close timing;
 * cost basis for V4 open uses live principal as last resort is DISABLED —
 * we try to estimate deposit from current liquidity * entry is not available,
 * so we use unclaimed + zero deposit until modify amounts are decoded).
 *
 * Better path: when we only have liquidityDelta, skip amount and mark cost basis
 * missing unless we find associated ERC20 transfers in the same tx (future).
 */

import {
  type Address,
  type Hex,
  pad,
  parseAbiItem,
  toHex,
  zeroAddress,
} from "viem";
import { getPublicClient } from "../client";
import type { PositionEvent } from "../events";
import { getBlockTimestamp } from "../events";
import {
  getV4PoolManager,
  getV4PositionManager,
  type LiveV4Position,
} from "./positions";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

const modifyLiquidityEvent = parseAbiItem(
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
);

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
 * Fetch V4 NFT lifecycle + ModifyLiquidity for one tokenId.
 * amount0/amount1 often 0 for ModifyLiquidity (event has liquidityDelta only).
 */
export async function getV4PositionEvents(
  pos: Pick<
    LiveV4Position,
    "tokenId" | "poolId" | "tickLower" | "tickUpper" | "token0" | "token1"
  >,
  toBlock: bigint,
): Promise<PositionEvent[]> {
  const client = getPublicClient();
  const posm = getV4PositionManager();
  const pm = getV4PoolManager();
  const tokenId = pos.tokenId;
  const salt = pad(toHex(tokenId), { size: 32 });
  const from = toBlock > 3_000_000n ? toBlock - 3_000_000n : 1n;

  const events: PositionEvent[] = [];

  // NFT transfers
  try {
    const xfer = await withTimeout(
      client.getLogs({
        address: posm,
        event: transferEvent,
        args: { tokenId },
        fromBlock: from,
        toBlock,
      }),
      10_000,
    );
    for (const log of xfer) {
      const fromA = (log.args.from as Address)?.toLowerCase();
      const toA = (log.args.to as Address)?.toLowerCase();
      let type: PositionEvent["eventType"] | null = null;
      if (fromA === zeroAddress.toLowerCase()) type = "transfer_mint";
      else if (toA === zeroAddress.toLowerCase()) type = "transfer_burn";
      if (!type) continue;
      events.push({
        tokenId,
        eventType: type,
        blockNumber: log.blockNumber!,
        txHash: log.transactionHash!,
        logIndex: log.logIndex ?? 0,
        timestamp: 0,
        amount0: 0,
        amount1: 0,
        amount0Raw: 0n,
        amount1Raw: 0n,
      });
    }
  } catch (e) {
    console.warn("[v4 events] transfer", e instanceof Error ? e.message : e);
  }

  // PoolManager ModifyLiquidity filtered by poolId, then salt match
  try {
    const mods = await withTimeout(
      client.getLogs({
        address: pm,
        event: modifyLiquidityEvent,
        args: { id: pos.poolId },
        fromBlock: from,
        toBlock,
      }),
      12_000,
    );
    for (const log of mods) {
      const logSalt = (log.args.salt as Hex)?.toLowerCase();
      if (logSalt !== salt.toLowerCase()) continue;
      const delta = log.args.liquidityDelta as bigint;
      if (delta === 0n) continue;
      // Positive delta = add liquidity; negative = remove
      // Without token amounts we still record timing for calendar open/close
      events.push({
        tokenId,
        eventType: delta > 0n ? "increase" : "decrease",
        blockNumber: log.blockNumber!,
        txHash: log.transactionHash!,
        logIndex: log.logIndex ?? 0,
        timestamp: 0,
        amount0: 0,
        amount1: 0,
        amount0Raw: 0n,
        amount1Raw: 0n,
      });
    }
  } catch (e) {
    console.warn("[v4 events] modify", e instanceof Error ? e.message : e);
  }

  // Timestamps
  const blocks = [...new Set(events.map((e) => e.blockNumber.toString()))];
  const tsMap = new Map<string, number>();
  await Promise.all(
    blocks.map(async (bn) => {
      try {
        tsMap.set(bn, await withTimeout(getBlockTimestamp(BigInt(bn)), 4_000));
      } catch {
        tsMap.set(bn, Math.floor(Date.now() / 1000));
      }
    }),
  );
  for (const e of events) {
    e.timestamp = tsMap.get(e.blockNumber.toString()) ?? 0;
  }

  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  console.log(
    `[v4 events] #${tokenId} n=${events.length} (inc/dec may have 0 token amounts)`,
  );
  return events;
}
