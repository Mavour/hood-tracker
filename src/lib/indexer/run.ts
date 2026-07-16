/**
 * Two-phase indexer for public UX:
 *
 * Phase 1 (seconds): open LP NFTs only → cost basis events + live mark → READY
 * Phase 2 (background): closed history + calendar days → refresh cache
 *
 * Users never wait on 40× eth_getLogs for closed NFTs before seeing the dashboard.
 */

import type { Address } from "viem";
import { isAddress } from "viem";
import {
  getLatestBlock,
  getPositionEvents,
  getBlockTimestamp,
  type PositionEvent,
} from "../chain/events";
import { setV3TransferCache } from "../chain/events";
import {
  getLivePosition,
  listNpmTokenIds,
  readPosition,
  resolvePool,
  getTokenMeta,
} from "../chain/positions";
import { humanAmount } from "../chain/math";
import { getMintDeposit } from "../chain/mint";
import {
  listLiveV4Positions,
  getLiveV4Position,
  type LiveV4Position,
} from "../chain/v4/positions";
import { getV4PositionEvents } from "../chain/v4/events";
import { getTokenPriceLive, valueDual, getPoolPriceAtBlock } from "../pricing";
import {
  computePositionPnl,
  aggregatePortfolio,
  type MintDeposit,
  type PricedEvent,
  type PositionPnl,
} from "../pnl/compute";
import { buildDailyPnl } from "../pnl/daily";
import {
  upsertJob,
  setPnlCache,
  savePosition,
  saveEvents,
  type IndexJob,
} from "../db";
import { ROBINHOOD } from "@config/contracts";
import { isIndexCancelled } from "./cancel";

function withTimeout<T>(p: Promise<T>, ms: number, label = ""): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout${label ? ` ${label}` : ""}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export type PositionView = PositionPnl & {
  protocol: "v3" | "v4";
  poolAddress: string | null;
  poolId?: string | null;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  fee: number;
  tickLower: number;
  tickUpper: number;
  inRange: boolean | null;
  amount0Human: number;
  amount1Human: number;
  liquidity: string;
  explorerUrl: string;
  costBasisEstimated?: boolean;
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  historyPending?: boolean;
  hasCustomHook?: boolean;
};

export type TrackResult = {
  summary: ReturnType<typeof aggregatePortfolio>;
  positions: PositionView[];
  daily: ReturnType<typeof buildDailyPnl>;
  address: string;
  computedAt: string;
  lastUpdated: string;
  phase?: "fast" | "full";
};

async function updateJob(
  jobId: string,
  address: string,
  patch: Partial<IndexJob>,
) {
  await upsertJob({
    jobId,
    ownerAddress: address,
    status: patch.status ?? "indexing",
    progress: patch.progress ?? 0,
    progressMessage: patch.progressMessage ?? "",
    errorMessage: patch.errorMessage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function livePricesForPair(token0: Address, token1: Address) {
  const [p0, p1] = await Promise.all([
    getTokenPriceLive(token0),
    getTokenPriceLive(token1),
  ]);
  return {
    price0Usd: p0.usd,
    price1Usd: p1.usd,
    price0Eth: p0.eth,
    price1Eth: p1.eth,
  };
}

/**
 * Price a position's events at EACH event's block (historical, block-matched),
 * not with a single live snapshot. Groups by block to minimize RPC calls and
 * reuses the block-price cache inside getPoolPriceAtBlock.
 *
 * For V4 (no poolAddress) we fall back to live prices — V4 has no V3-style pool
 * to query at block; this is a known degraded path.
 */
async function priceEventsAtBlocks(
  events: PositionEvent[],
  token0: Address,
  token1: Address,
  poolAddress: Address | null,
  decimals0: number,
  decimals1: number,
): Promise<PricedEvent[]> {
  if (!poolAddress || events.length === 0) {
    const lp = await livePricesForPair(token0, token1);
    return toPriced(events, lp);
  }

  const byBlock = new Map<number, PositionEvent[]>();
  for (const e of events) {
    const b = Number(e.blockNumber);
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b)!.push(e);
  }

  const batches = [...byBlock.entries()];
  const results = await mapPool(batches, 4, async ([b, evs]) => {
    const prices = await getPoolPriceAtBlock(
      poolAddress,
      token0,
      token1,
      decimals0,
      decimals1,
      BigInt(b),
    ).catch(() => livePricesForPair(token0, token1));
    return evs.map((e) => ({
      eventType: e.eventType,
      timestamp: e.timestamp,
      amount0: e.amount0,
      amount1: e.amount1,
      ...prices,
      txHash: e.txHash,
      blockNumber: b,
    }));
  });

  return results.flat();
}

function toPriced(
  events: PositionEvent[],
  prices: Awaited<ReturnType<typeof livePricesForPair>>,
): PricedEvent[] {
  return events.map((e) => ({
    eventType: e.eventType,
    timestamp: e.timestamp,
    amount0: e.amount0,
    amount1: e.amount1,
    ...prices,
    txHash: e.txHash,
    blockNumber: Number(e.blockNumber),
  }));
}

/**
 * Resolve the canonical deposit from the on-chain MINT transaction and price it
 * at the mint block. Returns null when it cannot be resolved (caller keeps
 * using IncreaseLiquidity events).
 */
async function resolveMintDeposit(
  protocol: "v3" | "v4",
  tokenId: bigint,
  token0: Address,
  token1: Address,
  fee: number,
  poolAddress: Address | null,
  decimals0: number,
  decimals1: number,
): Promise<MintDeposit | null> {
  const mint = await getMintDeposit({
    protocol,
    tokenId,
    token0,
    token1,
    fee,
    decimals0,
    decimals1,
  }).catch(() => null);
  if (!mint || (mint.amount0 === 0n && mint.amount1 === 0n)) return null;

  const prices = poolAddress
    ? await getPoolPriceAtBlock(
        poolAddress,
        token0,
        token1,
        decimals0,
        decimals1,
        mint.blockNumber,
      ).catch(() => livePricesForPair(token0, token1))
    : await livePricesForPair(token0, token1);

  return {
    amount0: humanAmount(mint.amount0, decimals0),
    amount1: humanAmount(mint.amount1, decimals1),
    price0Usd: prices.price0Usd,
    price1Usd: prices.price1Usd,
    price0Eth: prices.price0Eth,
    price1Eth: prices.price1Eth,
    blockNumber: Number(mint.blockNumber),
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () =>
      worker(),
    ),
  );
  return out;
}

type BuildOpts = {
  fetchEvents: boolean;
  historyPending: boolean;
};

async function buildOnePosition(
  tokenId: bigint,
  owner: Address,
  latest: bigint,
  livePos: Awaited<ReturnType<typeof getLivePosition>> | null,
  opts: BuildOpts,
): Promise<{ view: PositionView; pnl: PositionPnl; priced: PricedEvent[] } | null> {
  const raw = livePos ?? (await readPosition(tokenId).catch(() => null));
  if (!raw) return null;

  // Open if either live mark or raw positions() still has liquidity.
  // Previously required livePos — so failed getLivePosition dropped open V3 rows.
  const liq = livePos?.liquidity ?? raw.liquidity;
  const isOpen = liq > 0n;
  const token0 = raw.token0;
  const token1 = raw.token1;
  const fee = raw.fee;

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(token0),
    getTokenMeta(token1),
  ]);

  const poolAddress =
    livePos?.poolAddress ?? (await resolvePool(token0, token1, fee));

  let events: PositionEvent[] = [];
  if (opts.fetchEvents) {
    try {
      // Closed needs full event set (increase/decrease/collect); open can be fast.
      const mode = isOpen ? "fast" : "full";
      const budget = isOpen ? 10_000 : 20_000;
      events = await Promise.race([
        getPositionEvents(
          tokenId,
          1n,
          latest,
          token0,
          token1,
          undefined,
          { mode },
        ),
        new Promise<PositionEvent[]>((r) => setTimeout(() => r([]), budget)),
      ]);
    } catch (e) {
      console.warn("[index] events", tokenId.toString(), e);
    }
  }

  const priced = await priceEventsAtBlocks(
    events,
    token0,
    token1,
    poolAddress,
    meta0.decimals,
    meta1.decimals,
  );

  // Canonical deposit from the on-chain MINT transaction (authoritative cost
  // basis). Done during enrichment/backfill (when events are fetched) so the
  // first paint stays fast; falls back to IncreaseLiquidity events otherwise.
  let mintDeposit = opts.fetchEvents
    ? await resolveMintDeposit(
        "v3",
        tokenId,
        token0,
        token1,
        fee,
        poolAddress,
        meta0.decimals,
        meta1.decimals,
      ).catch(() => null)
    : null;

  // V3 fallback: if on-chain resolution fails for an open position, use current live amounts
  if (!mintDeposit && isOpen && livePos && (livePos.amount0Human > 0 || livePos.amount1Human > 0)) {
    const estPrices = await livePricesForPair(token0, token1);
    mintDeposit = {
      amount0: livePos.amount0Human,
      amount1: livePos.amount1Human,
      price0Usd: estPrices.price0Usd,
      price1Usd: estPrices.price1Usd,
      price0Eth: estPrices.price0Eth,
      price1Eth: estPrices.price1Eth,
      blockNumber: 0,
    };
  }

  let currentValueUsd = 0;
  let currentValueEth = 0;
  let unclaimedFeesUsd = 0;
  let unclaimedFeesEth = 0;

  if (livePos && isOpen) {
    const principal = await valueDual(
      livePos.amount0Human,
      livePos.amount1Human,
      token0,
      token1,
    );
    const fees = await valueDual(
      livePos.unclaimed0Human,
      livePos.unclaimed1Human,
      token0,
      token1,
    );
    currentValueUsd = principal.usd;
    currentValueEth = principal.eth;
    unclaimedFeesUsd = fees.usd;
    unclaimedFeesEth = fees.eth;
  }

  const hasIncrease = priced.some(
    (e) => e.eventType === "increase" && (e.amount0 > 0 || e.amount1 > 0),
  );
  const costBasisEstimated = !hasIncrease && !mintDeposit;

  // Closed with no events yet → still show a row (never drop from UI).
  if (!isOpen && priced.length === 0) {
    const stubPnl = computePositionPnl({
      tokenId: tokenId.toString(),
      events: [],
      isOpen: false,
    });
    const view: PositionView = {
      ...stubPnl,
      protocol: "v3",
      poolAddress,
      token0,
      token1,
      symbol0: livePos?.symbol0 ?? meta0.symbol,
      symbol1: livePos?.symbol1 ?? meta1.symbol,
      decimals0: meta0.decimals,
      decimals1: meta1.decimals,
      fee,
      tickLower: raw.tickLower,
      tickUpper: raw.tickUpper,
      inRange: null,
      amount0Human: 0,
      amount1Human: 0,
      liquidity: "0",
      explorerUrl: `${ROBINHOOD.explorer}/token/${ROBINHOOD.npm}/instance/${tokenId}`,
      costBasisEstimated: true,
      historyPending: opts.historyPending || !opts.fetchEvents,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
    };
    return { view, pnl: stubPnl, priced: [] };
  }

  let openedTs: number | null = null;
  let closedTs: number | null = null;
  for (const e of priced) {
    if (!e.timestamp || e.timestamp < 1_000_000_000) continue;
    if (
      (e.eventType === "increase" || e.eventType === "transfer_mint") &&
      (openedTs == null || e.timestamp < openedTs)
    ) {
      openedTs = e.timestamp;
    }
    if (
      !isOpen &&
      (e.eventType === "decrease" ||
        e.eventType === "collect" ||
        e.eventType === "transfer_burn")
    ) {
      if (closedTs == null || e.timestamp > closedTs) closedTs = e.timestamp;
    }
  }

  const pnl = computePositionPnl({
    tokenId: tokenId.toString(),
    events: priced,
    currentValueUsd,
    currentValueEth,
    unclaimedFeesUsd,
    unclaimedFeesEth,
    isOpen,
    mintDeposit,
  });
  if (!isOpen && pnl.closedAt == null && closedTs) {
    (pnl as { closedAt: number | null }).closedAt = closedTs;
  }
  if (pnl.openedAt == null && openedTs) {
    (pnl as { openedAt: number | null }).openedAt = openedTs;
  }

  const openedAt =
    pnl.openedAt != null ? new Date(pnl.openedAt * 1000).toISOString() : null;
  const closedAt =
    !isOpen && pnl.closedAt != null
      ? new Date(pnl.closedAt * 1000).toISOString()
      : !isOpen && closedTs
        ? new Date(closedTs * 1000).toISOString()
        : null;

  await savePosition({
    tokenId: tokenId.toString(),
    ownerAddress: owner,
    poolAddress,
    token0,
    token1,
    feeTier: fee,
    tickLower: raw.tickLower,
    tickUpper: raw.tickUpper,
    symbol0: livePos?.symbol0 ?? meta0.symbol,
    symbol1: livePos?.symbol1 ?? meta1.symbol,
    decimals0: meta0.decimals,
    decimals1: meta1.decimals,
    openedAt,
    closedAt,
    lastIndexedBlock: Number(latest),
  });

  if (priced.length) {
    await saveEvents(
      priced.map((e, i) => ({
        tokenId: tokenId.toString(),
        eventType: e.eventType,
        blockNumber: e.blockNumber ?? 0,
        txHash: e.txHash ?? `synthetic-${tokenId}-${i}`,
        logIndex: i,
        timestamp:
          e.timestamp > 0
            ? new Date(e.timestamp * 1000).toISOString()
            : new Date().toISOString(),
        amount0: e.amount0,
        amount1: e.amount1,
        price0Usd: e.price0Usd,
        price1Usd: e.price1Usd,
        price0Eth: e.price0Eth,
        price1Eth: e.price1Eth,
        valueUsd: e.amount0 * e.price0Usd + e.amount1 * e.price1Usd,
        valueEth: e.amount0 * e.price0Eth + e.amount1 * e.price1Eth,
      })),
    );
  }

  const view: PositionView = {
    ...pnl,
    protocol: "v3",
    poolAddress,
    token0,
    token1,
    symbol0: livePos?.symbol0 ?? meta0.symbol,
    symbol1: livePos?.symbol1 ?? meta1.symbol,
    decimals0: meta0.decimals,
    decimals1: meta1.decimals,
    fee,
    tickLower: raw.tickLower,
    tickUpper: raw.tickUpper,
    inRange: livePos?.inRange ?? null,
    amount0Human: livePos?.amount0Human ?? 0,
    amount1Human: livePos?.amount1Human ?? 0,
    liquidity: (livePos?.liquidity ?? raw.liquidity).toString(),
    explorerUrl: `${ROBINHOOD.explorer}/token/${ROBINHOOD.npm}/instance/${tokenId}`,
    costBasisEstimated: costBasisEstimated || Boolean(pnl.costBasisMissing) || pnl.costBasisSource === "estimate",
    historyPending: opts.historyPending,
    realizedPnlUsd: isOpen ? 0 : pnl.netPnlUsd,
    unrealizedPnlUsd: isOpen ? pnl.netPnlUsd : 0,
  };

  if (isOpen) {
    console.log(
      `[pnl] #${tokenId} incEvents=${pnl.increaseEventCount ?? 0} ` +
        `depEth=${pnl.depositEth.toFixed(6)} curEth=${pnl.currentValueEth.toFixed(6)} ` +
        `unclEth=${pnl.unclaimedFeesEth.toFixed(6)} netEth=${pnl.netPnlEth.toFixed(6)} ` +
        `feeEth=${pnl.feePnlEth.toFixed(6)} priceEth=${pnl.pricePnlEth.toFixed(6)} ` +
        `missing=${pnl.costBasisMissing}`,
    );
  }

  return { view, pnl, priced };
}

/** Build normalized position from Uniswap V4 live state (+ optional events). */
async function buildOneV4Position(
  vp: LiveV4Position,
  latest: bigint,
  fetchEvents: boolean,
): Promise<{ view: PositionView; pnl: PositionPnl; priced: PricedEvent[] } | null> {
  const isOpen = vp.liquidity > 0n;
  let events: PositionEvent[] = [];
  if (fetchEvents) {
    try {
      events = await getV4PositionEvents(vp, vp.owner, vp.token0, vp.token1, vp.poolId);
    } catch (e) {
      console.warn("[v4] events", vp.tokenId.toString(), e);
    }
  }

  // Convert raw→human amounts and fix timestamps from block numbers
  if (events.length) {
    const blockSet = [...new Set(events.map((e) => e.blockNumber.toString()))];
    const tsMap = new Map<string, number>();
    const toBlock = latest > 0n ? latest : 1n;
    let latestTs = Math.floor(Date.now() / 1000);
    try {
      latestTs = await withTimeout(getBlockTimestamp(toBlock), 3_000);
    } catch { /* keep estimate */ }

    const toFetch = blockSet.slice(0, 12);
    await Promise.all(
      toFetch.map(async (bn) => {
        try {
          tsMap.set(bn, await withTimeout(getBlockTimestamp(BigInt(bn)), 2_500));
        } catch {
          const b = BigInt(bn);
          tsMap.set(
            bn,
            Math.max(0, Math.floor(latestTs - Number(toBlock - b) * 0.25)),
          );
        }
      }),
    );
    for (const bn of blockSet) {
      if (!tsMap.has(bn)) {
        const b = BigInt(bn);
        tsMap.set(
          bn,
          Math.max(0, Math.floor(latestTs - Number(toBlock - b) * 0.25)),
        );
      }
    }

    for (const e of events) {
      if (e.amount0 === 0 && e.amount0Raw !== 0n) {
        e.amount0 = humanAmount(e.amount0Raw, vp.decimals0);
      }
      if (e.amount1 === 0 && e.amount1Raw !== 0n) {
        e.amount1 = humanAmount(e.amount1Raw, vp.decimals1);
      }
      if (e.timestamp === 0 && e.blockNumber > 0n) {
        e.timestamp = tsMap.get(e.blockNumber.toString()) ?? 0;
      }
    }
  }

  const prices = await livePricesForPair(vp.token0, vp.token1);
  const priced = toPriced(events, prices);

  // V4 mint deposit: resolve during enrichment/events phase, skip during fast first paint
  let mintDeposit: MintDeposit | null = null;
  if (fetchEvents) {
    mintDeposit = await resolveMintDeposit(
      "v4",
      vp.tokenId,
      vp.token0,
      vp.token1,
      vp.fee,
      null,
      vp.decimals0,
      vp.decimals1,
    ).catch(() => null);
  }

  // V4 fallback: if on-chain resolution fails for an open position, use current live amounts
  if (!mintDeposit && isOpen) {
    const estPrices = await livePricesForPair(vp.token0, vp.token1);
    mintDeposit = {
      amount0: vp.amount0Human,
      amount1: vp.amount1Human,
      price0Usd: estPrices.price0Usd,
      price1Usd: estPrices.price1Usd,
      price0Eth: estPrices.price0Eth,
      price1Eth: estPrices.price1Eth,
      blockNumber: 0,
    };
  }

  let currentValueUsd = 0;
  let currentValueEth = 0;
  let unclaimedFeesUsd = 0;
  let unclaimedFeesEth = 0;
  if (isOpen) {
    const principal = await valueDual(
      vp.amount0Human,
      vp.amount1Human,
      vp.token0,
      vp.token1,
    );
    const fees = await valueDual(
      vp.unclaimed0Human,
      vp.unclaimed1Human,
      vp.token0,
      vp.token1,
    );
    currentValueUsd = principal.usd;
    currentValueEth = principal.eth;
    unclaimedFeesUsd = fees.usd;
    unclaimedFeesEth = fees.eth;
  }

  const pnl = computePositionPnl({
    tokenId: vp.tokenId.toString(),
    events: priced,
    currentValueUsd,
    currentValueEth,
    unclaimedFeesUsd,
    unclaimedFeesEth,
    isOpen,
    mintDeposit,
  });

  const view: PositionView = {
    ...pnl,
    protocol: "v4",
    poolAddress: null,
    poolId: vp.poolId,
    token0: vp.token0,
    token1: vp.token1,
    symbol0: vp.symbol0,
    symbol1: vp.symbol1,
    decimals0: vp.decimals0,
    decimals1: vp.decimals1,
    fee: vp.fee,
    tickLower: vp.tickLower,
    tickUpper: vp.tickUpper,
    inRange: vp.inRange,
    amount0Human: vp.amount0Human,
    amount1Human: vp.amount1Human,
    liquidity: vp.liquidity.toString(),
    explorerUrl: `${ROBINHOOD.explorer}/token/${ROBINHOOD.v4PositionManager}/instance/${vp.tokenId}`,
    costBasisEstimated: pnl.costBasisSource !== "mint" && pnl.costBasisSource !== "estimate",
    hasCustomHook: vp.hasCustomHook,
    realizedPnlUsd: isOpen ? 0 : pnl.netPnlUsd,
    unrealizedPnlUsd: isOpen ? pnl.netPnlUsd : 0,
  };

  console.log(
    `[pnl v4] #${vp.tokenId} liq=${vp.liquidity} curEth=${currentValueEth.toFixed(6)} ` +
      `unclEth=${unclaimedFeesEth.toFixed(6)} claimedEth=${pnl.feesCollectedEth.toFixed(6)} ` +
      `hook=${vp.hasCustomHook}`,
  );

  return { view, pnl, priced };
}

function publishCache(
  address: string,
  views: PositionView[],
  pnls: PositionPnl[],
  eventsByPosition: Map<string, PricedEvent[]>,
  phase: "fast" | "full",
): TrackResult {
  const summary = aggregatePortfolio(pnls);
  const daily = buildDailyPnl(eventsByPosition, pnls);
  const computedAt = new Date().toISOString();

  views.sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    return Math.abs(b.netPnlUsd) - Math.abs(a.netPnlUsd);
  });

  const result: TrackResult = {
    summary,
    positions: views,
    daily,
    address: address.toLowerCase(),
    computedAt,
    lastUpdated: computedAt,
    phase,
  };

  void setPnlCache(
    address,
    {
      summary: result.summary,
      positions: result.positions,
      daily: result.daily,
      phase,
    },
    Number(process.env.PNL_CACHE_TTL ?? 600),
  );

  return result;
}

/**
 * Phase 2: backfill closed NFT events + calendar (does not block UI).
 */
async function backfillClosedHistory(
  address: string,
  jobId: string,
  gen: number,
  owner: Address,
  latest: bigint,
  closedIds: bigint[],
  v4ClosedIds: bigint[],
  openViews: PositionView[],
  openPnls: PositionPnl[],
  openEvents: Map<string, PricedEvent[]>,
  liveMap: Map<string, NonNullable<Awaited<ReturnType<typeof getLivePosition>>>>,
) {
  if (isIndexCancelled(address, gen)) return;
  const totalClosed = closedIds.length + v4ClosedIds.length;
  if (!totalClosed) return;

  console.log(
    `[index] backfill start v3=${closedIds.length} v4=${v4ClosedIds.length}`,
  );

  await updateJob(jobId, address, {
    status: "ready",
    progress: 92,
    progressMessage: `Backfilling ${totalClosed} closed (${closedIds.length} V3 + ${v4ClosedIds.length} V4)…`,
  });

  const closedViews: PositionView[] = [];
  const closedPnls: PositionPnl[] = [];
  const eventsByPosition = new Map(openEvents);

  // Cap heavy closed backfill so wallets with 50+ NFTs still finish.
  const MAX_CLOSED_V3 = 30;
  const MAX_CLOSED_V4 = 20;
  const closedV3Work = closedIds.slice(0, MAX_CLOSED_V3);
  const closedV4Work = v4ClosedIds.slice(0, MAX_CLOSED_V4);
  const workTotal = closedV3Work.length + closedV4Work.length || 1;

  const publishPartial = (phase: "fast" | "full", msg: string, progress: number) => {
    const allViews = [...openViews, ...closedViews];
    const allPnls = [...openPnls, ...closedPnls];
    publishCache(address, allViews, allPnls, eventsByPosition, phase);
    void updateJob(jobId, address, {
      status: "ready",
      progress,
      progressMessage: msg,
    });
  };

  // Immediate stubs so Closed section is not empty while events load
  if (closedV3Work.length) {
    await mapPool(closedV3Work, 6, async (tokenId) => {
      if (isIndexCancelled(address, gen)) return;
      const livePos = liveMap.get(tokenId.toString()) ?? null;
      const built = await buildOnePosition(tokenId, owner, latest, livePos, {
        fetchEvents: false,
        historyPending: true,
      }).catch(() => null);
      if (built) {
        closedViews.push(built.view);
        closedPnls.push(built.pnl);
      }
    });
    publishPartial(
      "fast",
      `Showing ${closedViews.length} closed stubs — loading history…`,
      93,
    );
  }

  let done = 0;
  await mapPool(closedV3Work, 5, async (tokenId) => {
    if (isIndexCancelled(address, gen)) return;
    done += 1;

    const livePos = liveMap.get(tokenId.toString()) ?? null;
    const built = await buildOnePosition(tokenId, owner, latest, livePos, {
      fetchEvents: true,
      historyPending: false,
    }).catch(() => null);

    if (built) {
      const idStr = tokenId.toString();
      const idx = closedViews.findIndex(
        (v) => v.protocol === "v3" && v.tokenId === idStr,
      );
      const pIdx = closedPnls.findIndex((p) => p.tokenId === idStr);
      if (idx >= 0) closedViews[idx] = built.view;
      else closedViews.push(built.view);
      if (pIdx >= 0) closedPnls[pIdx] = built.pnl;
      else closedPnls.push(built.pnl);
      eventsByPosition.set(idStr, built.priced);
    }

    if (done % 4 === 0 || done === closedV3Work.length) {
      publishPartial(
        "fast",
        `Backfilling V3 history ${done}/${closedV3Work.length}…`,
        93 + Math.floor((done / workTotal) * 6),
      );
    }
  });

  if (isIndexCancelled(address, gen)) return;

  // V4 closed positions
  if (closedV4Work.length) {
    let v4Done = 0;
    await mapPool(closedV4Work, 4, async (tokenId) => {
      if (isIndexCancelled(address, gen)) return;
      v4Done += 1;

      const vp = await getLiveV4Position(tokenId, owner).catch(() => null);
      if (!vp) return;
      const built = await buildOneV4Position(vp, latest, true).catch(() => null);
      if (built) {
        closedViews.push(built.view);
        closedPnls.push(built.pnl);
        eventsByPosition.set(`v4:${tokenId}`, built.priced);
      }

      if (v4Done % 3 === 0 || v4Done === closedV4Work.length) {
        publishPartial(
          "fast",
          `Backfilling V4 history ${v4Done}/${closedV4Work.length}…`,
          93 + Math.floor(((closedV3Work.length + v4Done) / workTotal) * 6),
        );
      }
    });
  }

  if (isIndexCancelled(address, gen)) return;

  const allViews = [...openViews, ...closedViews];
  const allPnls = [...openPnls, ...closedPnls];
  const result = publishCache(
    address,
    allViews,
    allPnls,
    eventsByPosition,
    "full",
  );

  await updateJob(jobId, address, {
    status: "ready",
    progress: 100,
    progressMessage: `Ready — ${result.summary.openCount} open / ${result.summary.closedCount} closed · history full`,
  });

  console.log(
    `[index] phase2 done days=${result.daily.length} closed=${closedViews.length} ` +
      `(v3 work ${closedV3Work.length}/${closedIds.length}, v4 work ${closedV4Work.length}/${v4ClosedIds.length})`,
  );
}

/**
 * First scan (no cache) — what fast public trackers actually do:
 *
 *   ≤ ~8–10s wall clock
 *   1) list currently owned LP NFTs (1 Alchemy call)
 *   2) positions() liquidity filter → only OPEN
 *   3) live mark (slot0 + amounts + tokensOwed) for open only
 *   4) RETURN READY
 *
 * History / claimed Collect / closed PnL / full fee growth = BACKGROUND.
 * Other products feel fast because first paint ≠ full history RPC.
 */
export async function indexAddress(
  address: string,
  jobId: string,
  gen: number,
): Promise<TrackResult> {
  if (!isAddress(address)) throw new Error("Invalid address");
  const owner = address as Address;
  const cancelled = () => isIndexCancelled(address, gen);
  const t0 = Date.now();
  /** Hard budget for first paint (first scan, no cache). Increased significantly for unreliable public RPC. */
  const PHASE1_MS = 25_000;
  const deadline = t0 + PHASE1_MS;
  const timeLeft = () => Math.max(0, deadline - Date.now());
  const ok = () => !cancelled() && Date.now() < deadline;

  const checkpoint = async (progress: number, progressMessage: string) => {
    if (cancelled()) throw new Error("CANCELLED");
    await updateJob(jobId, address, {
      status: "indexing",
      progress,
      progressMessage,
    });
  };

  await checkpoint(5, "First scan — live open only (max ~15s, increased RPC timeout)…");

  let latest = 0n;
  try {
    latest = await Promise.race([
      getLatestBlock(),
      new Promise<bigint>((_, rej) =>
        setTimeout(() => rej(new Error("block timeout")), 15_000),
      ),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ROBINHOOD_MAINNET is not enabled")) {
      throw new Error("Alchemy: enable Robinhood Mainnet, then restart.");
    }
    throw new Error(`RPC error: ${msg.slice(0, 240)}`);
  }

  // 1) List held NFT ids only (no historical discover)
  await checkpoint(20, "Listing owned LP NFTs…");
  let heldIds: bigint[] = [];
  try {
    heldIds = await withTimeout(listNpmTokenIds(owner), 18_000, "listNpmTokenIds");
  } catch (e) {
    console.warn("[index] listNpm", e);
  }
  console.log(`[index] held V3 NFTs=${heldIds.length}`);
  if (cancelled()) throw new Error("CANCELLED");

  // 2) Light filter: only read positions() for liquidity (skip closed detail)
  await checkpoint(35, `Filtering open among ${heldIds.length}…`);
  const openIds: bigint[] = [];
  const closedHeldIds: bigint[] = [];
  // Don't hard-abort on PHASE1 deadline here — partial open/closed lists still useful
  await mapPool(heldIds, 8, async (tokenId) => {
    if (cancelled()) return;
    const raw = await readPosition(tokenId).catch(() => null);
    if (!raw) return;
    if (raw.liquidity > 0n) openIds.push(tokenId);
    else closedHeldIds.push(tokenId);
  });
  console.log(
    `[index] filter open=${openIds.length} closedHeld=${closedHeldIds.length}`,
  );

  // 3) Full live mark for open (typically 1–5) — fee growth ON, events in bg
  await checkpoint(
    55,
    openIds.length
      ? `Live mark ${openIds.length} open V3…`
      : "No open V3…",
  );

  const liveMap = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof getLivePosition>>>
  >();
  await mapPool(openIds, 6, async (tokenId) => {
    if (cancelled()) return;
    const p = await getLivePosition(tokenId, owner).catch(() => null);
    if (p) liveMap.set(tokenId.toString(), p);
  });

  const openViews: PositionView[] = [];
  const openPnls: PositionPnl[] = [];
  const openEvents = new Map<string, PricedEvent[]>();

  // Always build open V3 from raw positions() even if live mark failed
  await mapPool(openIds, 6, async (tokenId) => {
    if (cancelled()) return;
    const livePos = liveMap.get(tokenId.toString()) ?? null;
    const built = await buildOnePosition(tokenId, owner, latest, livePos, {
      fetchEvents: false, // NEVER on first paint
      historyPending: false,
    }).catch((e) => {
      console.warn("[index] build open v3", tokenId.toString(), e);
      return null;
    });
    if (built) {
      openViews.push(built.view);
      openPnls.push(built.pnl);
      openEvents.set(`v3:${tokenId}`, built.priced);
    }
  });

  // 4) V4 only if budget remains
  if (ok() && timeLeft() > 2_000) {
    await checkpoint(75, "V4 open (if any)…");
    try {
      const v4Live = await Promise.race([
        withTimeout(listLiveV4Positions(owner), Math.min(15_000, timeLeft()), "listLiveV4"),
        new Promise<LiveV4Position[]>((r) =>
          setTimeout(() => r([]), Math.min(6_000, timeLeft())),
        ),
      ]);
      for (const vp of v4Live) {
        if (!ok() || vp.liquidity === 0n) continue;
        const built = await buildOneV4Position(vp, latest, false).catch(
          () => null,
        );
        if (built) {
          openViews.push(built.view);
          openPnls.push(built.pnl);
          openEvents.set(`v4:${vp.tokenId}`, built.priced);
        }
      }
    } catch (e) {
      console.warn("[index] v4", e);
    }
  }

  if (cancelled()) throw new Error("CANCELLED");

  const result = publishCache(address, openViews, openPnls, openEvents, "fast");
  const v3Open = openViews.filter((v) => v.protocol === "v3").length;
  const v4Open = openViews.filter((v) => v.protocol === "v4").length;
  const elapsed = Date.now() - t0;

  await updateJob(jobId, address, {
    status: "ready",
    progress: 90,
    progressMessage: `Ready in ${(elapsed / 1000).toFixed(1)}s — ${v3Open} V3 + ${v4Open} V4 open (live). ${closedHeldIds.length} V3 closed in background…`,
  });

  console.log(
    `[index] FIRST PAINT ${elapsed}ms open v3=${v3Open} v4=${v4Open} held=${heldIds.length} closed=${closedHeldIds.length}`,
  );

  // Background: never blocks first response
  void (async () => {
    if (cancelled()) return;

    // Pre-fetch V3 transfer cache for Blockscout fallback
    try {
      const npmV3 = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
      const url = `${ROBINHOOD.explorer}/api/v2/addresses/${address}/token-transfers?type=ERC-721&token=${npmV3}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{
            tx_hash?: string;
            transaction_hash?: string;
            block_number?: number;
            total?: { token_id?: string };
          }>;
        };
        const items = (data.items ?? []).map((t) => ({
          tx_hash: t.transaction_hash ?? t.tx_hash ?? "",
          block_number: t.block_number ?? 0,
          tokenId: t.total?.token_id ?? "0",
        }));
        setV3TransferCache(address, items);
        console.log(`[v3 cache] ${items.length} transfers`);
      }
    } catch { /* ignore */ }

    // Enrich open V3 with Increase + Collect (claimed fees + cost basis)
    await mapPool(openIds, 4, async (tokenId) => {
      if (cancelled()) return;
      const live2 = await getLivePosition(tokenId, owner).catch(() => null);
      const built = await buildOnePosition(tokenId, owner, latest, live2, {
        fetchEvents: true,
        historyPending: false,
      }).catch(() => null);
      if (!built) return;
      const idStr = tokenId.toString();
      const idx = openViews.findIndex(
        (v) => v.protocol === "v3" && v.tokenId === idStr,
      );
      const pIdx = openPnls.findIndex((p) => p.tokenId === idStr);
      if (idx >= 0) openViews[idx] = built.view;
      if (pIdx >= 0) openPnls[pIdx] = built.pnl;
      openEvents.set(`v3:${tokenId}`, built.priced);
    });

    if (cancelled()) return;

    // V4: retry in background if not found during first paint
    // Also collect closed V4 positions for backfill
    const v4ClosedIds: bigint[] = [];
    const hasV4 = openViews.some((v) => v.protocol === "v4");
    if (!hasV4) {
      try {
        const v4Live = await listLiveV4Positions(owner);
        for (const vp of v4Live) {
          if (cancelled()) return;
          if (vp.liquidity === 0n) {
            v4ClosedIds.push(vp.tokenId);
            continue;
          }
          const built = await buildOneV4Position(vp, latest, true).catch(
            () => null,
          );
          if (!built) continue;
          openViews.push(built.view);
          openPnls.push(built.pnl);
          openEvents.set(`v4:${vp.tokenId}`, built.priced);
        }
        if (v4Live.length) {
          console.log(`[index] bg V4 found ${v4Live.length} positions (${v4ClosedIds.length} closed)`);
        }
      } catch (e) {
        console.warn("[index] bg V4", e);
      }
    } else {
      // V4 open was found during first paint; still check for closed V4
      try {
        const v4Live = await listLiveV4Positions(owner);
        for (const vp of v4Live) {
          if (vp.liquidity === 0n) v4ClosedIds.push(vp.tokenId);
        }
        if (v4ClosedIds.length) {
          console.log(`[index] bg V4 closed: ${v4ClosedIds.length}`);
        }
      } catch { /* ignore */ }
    }

    if (cancelled()) return;
    publishCache(address, [...openViews], [...openPnls], openEvents, "fast");
    await updateJob(jobId, address, {
      status: "ready",
      progress: 94,
      progressMessage: "Open enriched (fees/cost). Closed history…",
    });

    await backfillClosedHistory(
      address,
      jobId,
      gen,
      owner,
      latest,
      closedHeldIds,
      v4ClosedIds,
      openViews,
      openPnls,
      openEvents,
      liveMap,
    );
  })().catch((e) => console.warn("[index] bg", e));

  return result;
}
