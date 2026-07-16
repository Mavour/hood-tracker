/**
 * V3 NPM events — FAST path for open positions, full path optional.
 *
 * Public UX: phase-1 must not hang on mint-scan / multi-million-block chunking.
 */

import {
  type Address,
  type Hex,
  parseAbiItem,
  zeroAddress,
} from "viem";
import { getNpmAddress, ROBINHOOD } from "@config/contracts";
import { getPublicClient, getRpcUrl } from "./client";
import { humanAmount } from "./math";
import { getTokenMeta } from "./positions";

export type PositionEventType =
  | "increase"
  | "decrease"
  | "collect"
  | "transfer_mint"
  | "transfer_burn";

export type PositionEvent = {
  tokenId: bigint;
  eventType: PositionEventType;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
  timestamp: number;
  amount0: number;
  amount1: number;
  amount0Raw: bigint;
  amount1Raw: bigint;
};

const increaseEvent = parseAbiItem(
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const decreaseEvent = parseAbiItem(
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const collectEvent = parseAbiItem(
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

const BLOCK_TIME_SEC = 0.25;

export async function getBlockTimestamp(blockNumber: bigint): Promise<number> {
  const client = getPublicClient();
  const block = await client.getBlock({ blockNumber });
  return Number(block.timestamp);
}

export async function getLatestBlock(): Promise<bigint> {
  return withTimeout(
    getPublicClient().getBlockNumber(),
    12_000,
    "getLatestBlock"
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout ${ms}ms${label ? `: ${label}` : ""}`)),
      ms,
    );
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

function estimateTs(
  blockNumber: bigint,
  latest: bigint,
  latestTs: number,
): number {
  if (latestTs > 1_000_000_000) {
    return Math.max(
      0,
      Math.floor(latestTs - Number(latest - blockNumber) * BLOCK_TIME_SEC),
    );
  }
  return Math.floor(Date.now() / 1000);
}

type LogLike = {
  blockNumber?: bigint | null;
  transactionHash?: Hex | null;
  logIndex?: number | null;
  args?: {
    amount0?: bigint;
    amount1?: bigint;
    from?: Address;
    to?: Address;
  };
};

/**
 * Blockscout module=logs — works for full history on Alchemy free tier
 * (Alchemy eth_getLogs free is capped at 10 blocks).
 *
 * topic0 = event signature, topic1 = indexed tokenId
 */
async function getLogsViaBlockscoutModule(params: {
  event:
    | typeof increaseEvent
    | typeof decreaseEvent
    | typeof collectEvent
    | typeof transferEvent;
  tokenId: bigint;
  timeoutMs: number;
}): Promise<LogLike[]> {
  const npm = getNpmAddress();
  const INCREASE_TOPIC =
    "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
  const DECREASE_TOPIC =
    "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";
  const COLLECT_TOPIC =
    "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01";

  const topic0 =
    params.event === increaseEvent
      ? INCREASE_TOPIC
      : params.event === decreaseEvent
        ? DECREASE_TOPIC
        : params.event === collectEvent
          ? COLLECT_TOPIC
          : null;
  if (!topic0) return [];

  const topic1 = "0x" + params.tokenId.toString(16).padStart(64, "0");
  const url =
    `${ROBINHOOD.explorer}/api?module=logs&action=getLogs` +
    `&fromBlock=0&toBlock=latest` +
    `&address=${npm}` +
    `&topic0=${topic0}&topic1=${topic1}&topic0_1_opr=and`;

  try {
    const res = await withTimeout(fetch(url), params.timeoutMs, "bs-logs");
    if (!res.ok) return [];
    const json = (await res.json()) as {
      status?: string;
      result?: Array<{
        data?: string;
        topics?: string[];
        transactionHash?: string;
        transactionIndex?: string;
        blockNumber?: string;
        logIndex?: string;
        timeStamp?: string;
      }>;
    };
    if (json.status === "0" || !Array.isArray(json.result)) return [];

    const logs: LogLike[] = [];
    for (const l of json.result) {
      const hex = (l.data ?? "0x").startsWith("0x")
        ? (l.data ?? "0x").slice(2)
        : (l.data ?? "");
      let amount0 = 0n;
      let amount1 = 0n;
      // Increase/Decrease: liquidity, amount0, amount1
      // Collect: recipient, amount0, amount1
      if (hex.length >= 192) {
        amount0 = BigInt("0x" + hex.slice(64, 128));
        amount1 = BigInt("0x" + hex.slice(128, 192));
      }
      const bn = l.blockNumber?.startsWith("0x")
        ? BigInt(l.blockNumber)
        : BigInt(l.blockNumber ?? 0);
      const li = l.logIndex?.startsWith("0x")
        ? Number(BigInt(l.logIndex))
        : Number(l.logIndex ?? 0);
      logs.push({
        blockNumber: bn,
        transactionHash: (l.transactionHash ?? "0x") as Hex,
        logIndex: li,
        args: { amount0, amount1 },
      });
    }
    return logs;
  } catch (e) {
    console.warn(
      "[events] blockscout module=logs",
      e instanceof Error ? e.message.slice(0, 80) : e,
    );
    return [];
  }
}

async function getLogsOnce(params: {
  event:
    | typeof increaseEvent
    | typeof decreaseEvent
    | typeof collectEvent
    | typeof transferEvent;
  tokenId: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  timeoutMs: number;
  extraArgs?: Record<string, unknown>;
}): Promise<LogLike[]> {
  // 1) Blockscout full-history first (Alchemy free eth_getLogs = 10 blocks only)
  const viaBs = await getLogsViaBlockscoutModule({
    event: params.event,
    tokenId: params.tokenId,
    timeoutMs: Math.max(params.timeoutMs, 12_000),
  });
  if (viaBs.length) return viaBs;

  // 2) Legacy transfer→tx-logs path
  const viaXfer = await getLogsViaBlockscout({
    ...params,
    timeoutMs: Math.max(params.timeoutMs, 12_000),
  });
  if (viaXfer.length) return viaXfer;

  // 3) Last resort: tiny RPC windows (mostly useless on free Alchemy)
  try {
    const client = getPublicClient();
    const npm = getNpmAddress();
    const to = params.toBlock;
    const from = to > 9n ? to - 9n : 0n;
    const logs = await withTimeout(
      client.getLogs({
        address: npm,
        event: params.event,
        args: { tokenId: params.tokenId, ...params.extraArgs } as never,
        fromBlock: from,
        toBlock: to,
      }),
      5_000,
      "getLogs",
    );
    return logs as LogLike[];
  } catch {
    return [];
  }
}

/** Cache of V3 token transfers per address, fetched once per index run */
const v3TransferCache = new Map<string, Array<{ tx_hash: string; block_number: number; tokenId: string }>>();

export function setV3TransferCache(owner: string, items: Array<{ tx_hash: string; block_number: number; tokenId: string }>) {
  v3TransferCache.set(owner.toLowerCase(), items);
}

export function clearV3TransferCache() {
  v3TransferCache.clear();
}

/** Blockscout-based event fetching — bypasses Alchemy getLogs limits.
 *  Uses address token-transfers API (more reliable than per-instance API). */
async function getLogsViaBlockscout(params: {
  event:
    | typeof increaseEvent
    | typeof decreaseEvent
    | typeof collectEvent
    | typeof transferEvent;
  tokenId: bigint;
  timeoutMs: number;
}): Promise<LogLike[]> {
  const npm = getNpmAddress();
  const tokenId = params.tokenId;

  const INCREASE_TOPIC = "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
  const DECREASE_TOPIC = "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";
  const COLLECT_TOPIC = "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01";

  const wantedTopic =
    params.event === increaseEvent ? INCREASE_TOPIC
    : params.event === decreaseEvent ? DECREASE_TOPIC
    : params.event === collectEvent ? COLLECT_TOPIC
    : null;

  if (!wantedTopic) return [];

  const logs: LogLike[] = [];

  try {
    // Try address-based cache first (populated by indexer)
    let txs: Array<{ tx_hash: string; block_number: number }> = [];
    for (const [, items] of v3TransferCache) {
      const matches = items.filter((t) => t.tokenId === tokenId.toString());
      txs = matches.map((t) => ({ tx_hash: t.tx_hash, block_number: t.block_number }));
      if (txs.length) break;
    }

    // Fallback to per-instance API (Blockscout v2 field is transaction_hash)
    if (!txs.length) {
      const xferUrl = `${ROBINHOOD.explorer}/api/v2/tokens/${npm}/instances/${tokenId}/transfers`;
      const res = await withTimeout(fetch(xferUrl), params.timeoutMs);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        items?: Array<{
          tx_hash?: string;
          transaction_hash?: string;
          block_number?: number;
        }>;
      };
      for (const t of data.items ?? []) {
        const hash = t.transaction_hash ?? t.tx_hash;
        if (hash) txs.push({ tx_hash: hash, block_number: t.block_number ?? 0 });
      }
    }

    for (const t of txs) {
      // Get tx logs from Blockscout
      const logUrl = `${ROBINHOOD.explorer}/api/v2/transactions/${t.tx_hash}/logs`;
      const logRes = await withTimeout(fetch(logUrl), params.timeoutMs);
      if (!logRes.ok) continue;
      const logData = (await logRes.json()) as {
        items?: Array<{
          data?: string;
          topics?: string[];
          address?: { hash?: string };
        }>;
      };

      for (const l of logData.items ?? []) {
        if ((l.topics?.[0] ?? "") !== wantedTopic) continue;
        if ((l.address?.hash ?? "").toLowerCase() !== npm.toLowerCase()) continue;

        const hex = (l.data ?? "0x").startsWith("0x") ? (l.data ?? "0x").slice(2) : (l.data ?? "");
        let amount0 = 0n;
        let amount1 = 0n;

        if (params.event === collectEvent) {
          if (hex.length >= 192) {
            amount0 = BigInt("0x" + hex.slice(64, 128));
            amount1 = BigInt("0x" + hex.slice(128, 192));
          }
        } else {
          if (hex.length >= 192) {
            amount0 = BigInt("0x" + hex.slice(64, 128));
            amount1 = BigInt("0x" + hex.slice(128, 192));
          }
        }

        logs.push({
          blockNumber: BigInt(t.block_number ?? 0),
          transactionHash: t.tx_hash as Hex,
          logIndex: 0,
          args: { amount0, amount1 },
        });
      }
    }
  } catch (e) {
    console.warn("[events] blockscout fallback", e instanceof Error ? e.message : e);
  }

  return logs;
}

async function attachTimestamps(
  raw: Array<{
    eventType: PositionEventType;
    blockNumber: bigint;
    txHash: Hex;
    logIndex: number;
    amount0Raw: bigint;
    amount1Raw: bigint;
  }>,
  tokenId: bigint,
  meta0: { decimals: number },
  meta1: { decimals: number },
  toBlock: bigint,
): Promise<PositionEvent[]> {
  if (!raw.length) return [];

  let latestTs = Math.floor(Date.now() / 1000);
  try {
    latestTs = await withTimeout(getBlockTimestamp(toBlock), 3_000);
  } catch {
    /* keep */
  }

  const blockSet = [...new Set(raw.map((l) => l.blockNumber.toString()))];
  const tsMap = new Map<string, number>();

  // Cap block timestamp RPCs — estimate the rest
  const toFetch = blockSet.slice(0, 12);
  await Promise.all(
    toFetch.map(async (bn) => {
      try {
        tsMap.set(
          bn,
          await withTimeout(getBlockTimestamp(BigInt(bn)), 2_500),
        );
      } catch {
        tsMap.set(bn, estimateTs(BigInt(bn), toBlock, latestTs));
      }
    }),
  );
  for (const bn of blockSet) {
    if (!tsMap.has(bn)) {
      tsMap.set(bn, estimateTs(BigInt(bn), toBlock, latestTs));
    }
  }

  const events: PositionEvent[] = raw.map((l) => ({
    tokenId,
    eventType: l.eventType,
    blockNumber: l.blockNumber,
    txHash: l.txHash,
    logIndex: l.logIndex,
    timestamp: tsMap.get(l.blockNumber.toString()) ?? latestTs,
    amount0: humanAmount(l.amount0Raw, meta0.decimals),
    amount1: humanAmount(l.amount1Raw, meta1.decimals),
    amount0Raw: l.amount0Raw,
    amount1Raw: l.amount1Raw,
  }));

  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  return events;
}

export type GetPositionEventsOpts = {
  /** fast = last 300k blocks, 4s/log, no mint scan, no chunking */
  mode?: "fast" | "full";
};

/**
 * Fetch V3 position events.
 * `fast` is default for open positions during first paint.
 */
export async function getPositionEvents(
  tokenId: bigint,
  _fromBlock: bigint,
  toBlock: bigint,
  token0: Address,
  token1: Address,
  onProgress?: (msg: string) => void,
  opts?: GetPositionEventsOpts,
): Promise<PositionEvent[]> {
  if (process.env.SKIP_POSITION_EVENTS === "1") return [];

  const mode = opts?.mode ?? "fast";
  const [meta0, meta1] = await Promise.all([
    getTokenMeta(token0),
    getTokenMeta(token1),
  ]);

  // Smaller windows + chunked getLogs (Alchemy rejects multi-million ranges).
  const lookback = mode === "fast" ? 300_000n : 2_000_000n;
  const timeoutMs = mode === "fast" ? 8_000 : 20_000;
  const from = toBlock > lookback ? toBlock - lookback : 1n;

  onProgress?.(
    mode === "fast"
      ? `Events #${tokenId} (fast)…`
      : `Events #${tokenId} (full)…`,
  );

  const t0 = Date.now();

  // Only Increase + Collect needed for open PnL cost basis + claimed fees
  // Decrease optional for open. Skip Transfer in fast mode.
  const [inc, dec, col] = await Promise.all([
    getLogsOnce({
      event: increaseEvent,
      tokenId,
      fromBlock: from,
      toBlock,
      timeoutMs,
    }),
    mode === "fast"
      ? Promise.resolve([] as LogLike[])
      : getLogsOnce({
          event: decreaseEvent,
          tokenId,
          fromBlock: from,
          toBlock,
          timeoutMs,
        }),
    getLogsOnce({
      event: collectEvent,
      tokenId,
      fromBlock: from,
      toBlock,
      timeoutMs,
    }),
  ]);

  const raw: Array<{
    eventType: PositionEventType;
    blockNumber: bigint;
    txHash: Hex;
    logIndex: number;
    amount0Raw: bigint;
    amount1Raw: bigint;
  }> = [];

  for (const log of inc) {
    raw.push({
      eventType: "increase",
      blockNumber: log.blockNumber!,
      txHash: log.transactionHash!,
      logIndex: log.logIndex ?? 0,
      amount0Raw: log.args?.amount0 ?? 0n,
      amount1Raw: log.args?.amount1 ?? 0n,
    });
  }
  for (const log of dec) {
    raw.push({
      eventType: "decrease",
      blockNumber: log.blockNumber!,
      txHash: log.transactionHash!,
      logIndex: log.logIndex ?? 0,
      amount0Raw: log.args?.amount0 ?? 0n,
      amount1Raw: log.args?.amount1 ?? 0n,
    });
  }
  for (const log of col) {
    raw.push({
      eventType: "collect",
      blockNumber: log.blockNumber!,
      txHash: log.transactionHash!,
      logIndex: log.logIndex ?? 0,
      amount0Raw: log.args?.amount0 ?? 0n,
      amount1Raw: log.args?.amount1 ?? 0n,
    });
  }

  // Prefer Blockscout if RPC returned nothing (common on new chains / rate limits)
  if (raw.length === 0) {
    try {
      const [incBs, decBs, colBs] = await Promise.all([
        getLogsViaBlockscout({
          event: increaseEvent,
          tokenId,
          timeoutMs: Math.max(timeoutMs, 10_000),
        }),
        getLogsViaBlockscout({
          event: decreaseEvent,
          tokenId,
          timeoutMs: Math.max(timeoutMs, 10_000),
        }),
        getLogsViaBlockscout({
          event: collectEvent,
          tokenId,
          timeoutMs: Math.max(timeoutMs, 10_000),
        }),
      ]);
      for (const log of incBs) {
        raw.push({
          eventType: "increase",
          blockNumber: log.blockNumber!,
          txHash: log.transactionHash!,
          logIndex: log.logIndex ?? 0,
          amount0Raw: log.args?.amount0 ?? 0n,
          amount1Raw: log.args?.amount1 ?? 0n,
        });
      }
      for (const log of decBs) {
        raw.push({
          eventType: "decrease",
          blockNumber: log.blockNumber!,
          txHash: log.transactionHash!,
          logIndex: log.logIndex ?? 0,
          amount0Raw: log.args?.amount0 ?? 0n,
          amount1Raw: log.args?.amount1 ?? 0n,
        });
      }
      for (const log of colBs) {
        raw.push({
          eventType: "collect",
          blockNumber: log.blockNumber!,
          txHash: log.transactionHash!,
          logIndex: log.logIndex ?? 0,
          amount0Raw: log.args?.amount0 ?? 0n,
          amount1Raw: log.args?.amount1 ?? 0n,
        });
      }
      if (raw.length) {
        console.log(
          `[events] blockscout filled #${tokenId} inc/dec/col from explorer (${raw.length})`,
        );
      }
    } catch (e) {
      console.warn("[events] blockscout batch", e);
    }
  }

  // If still nothing in fast mode, one more wider RPC window
  if (mode === "fast" && raw.length === 0) {
    const from2 = toBlock > 1_500_000n ? toBlock - 1_500_000n : 1n;
    const [inc2, col2] = await Promise.all([
      getLogsOnce({
        event: increaseEvent,
        tokenId,
        fromBlock: from2,
        toBlock,
        timeoutMs: 5_000,
      }),
      getLogsOnce({
        event: collectEvent,
        tokenId,
        fromBlock: from2,
        toBlock,
        timeoutMs: 5_000,
      }),
    ]);
    for (const log of inc2) {
      raw.push({
        eventType: "increase",
        blockNumber: log.blockNumber!,
        txHash: log.transactionHash!,
        logIndex: log.logIndex ?? 0,
        amount0Raw: log.args?.amount0 ?? 0n,
        amount1Raw: log.args?.amount1 ?? 0n,
      });
    }
    for (const log of col2) {
      raw.push({
        eventType: "collect",
        blockNumber: log.blockNumber!,
        txHash: log.transactionHash!,
        logIndex: log.logIndex ?? 0,
        amount0Raw: log.args?.amount0 ?? 0n,
        amount1Raw: log.args?.amount1 ?? 0n,
      });
    }
  }

  const events = await attachTimestamps(raw, tokenId, meta0, meta1, toBlock);
  console.log(
    `[events] #${tokenId} mode=${mode} n=${events.length} inc=${inc.length} col=${col.length} ${Date.now() - t0}ms`,
  );
  return events;
}

export async function discoverTokenIdsViaAlchemy(
  owner: Address,
): Promise<bigint[]> {
  const rpc = getRpcUrl();
  if (!rpc.includes("alchemy")) return [];
  const npm = getNpmAddress();
  const ids = new Set<string>();
  try {
    const res = await withTimeout(
      fetch(rpc, {
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
              contractAddresses: [npm],
              category: ["erc721"],
              maxCount: "0x64",
            },
          ],
        }),
      }).then((r) => r.json()),
      6_000,
    ) as {
      result?: {
        transfers?: Array<{ tokenId?: string; erc721TokenId?: string }>;
      };
    };
    for (const t of res.result?.transfers ?? []) {
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
    console.warn("[alchemy discover]", e);
  }
  return [...ids].map((s) => BigInt(s));
}

// silence
void zeroAddress;
void transferEvent;
