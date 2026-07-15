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
  type PositionEvent,
} from "../chain/events";
import {
  getLivePosition,
  listNpmTokenIds,
  readPosition,
  resolvePool,
  getTokenMeta,
} from "../chain/positions";
import {
  listLiveV4Positions,
  type LiveV4Position,
} from "../chain/v4/positions";
import { getV4PositionEvents } from "../chain/v4/events";
import { getTokenPriceLive, valueDual } from "../pricing";
import {
  computePositionPnl,
  aggregatePortfolio,
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

const EVENTS_FROM_BLOCK = 1n;

export type PositionView = PositionPnl & {
  protocol: "v3" | "v4";
  poolAddress: string | null;
  poolId?: string | null;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
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
  historyPending?: boolean;
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

  const isOpen = !!(livePos && livePos.liquidity > 0n);
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
      // Hard budget: race events vs 8s so open path never hangs
      events = await Promise.race([
        getPositionEvents(
          tokenId,
          EVENTS_FROM_BLOCK,
          latest,
          token0,
          token1,
          undefined,
          { mode: "fast" },
        ),
        new Promise<PositionEvent[]>((r) => setTimeout(() => r([]), 8_000)),
      ]);
    } catch (e) {
      console.warn("[index] events", tokenId.toString(), e);
    }
  }

  const prices = await livePricesForPair(token0, token1);
  const priced = toPriced(events, prices);

  // NEVER synthesize deposit = current amounts (that made Fee PnL = all "profit").
  // Real cost basis must come from IncreaseLiquidity events only.

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
  const costBasisEstimated = !hasIncrease;

  // Closed with no events yet → skip noise rows in fast phase
  if (!isOpen && priced.length === 0 && opts.historyPending) {
    // Keep a lightweight closed stub so count is visible
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
      fee,
      tickLower: raw.tickLower,
      tickUpper: raw.tickUpper,
      inRange: null,
      amount0Human: 0,
      amount1Human: 0,
      liquidity: "0",
      explorerUrl: `${ROBINHOOD.explorer}/token/${ROBINHOOD.npm}/instance/${tokenId}`,
      costBasisEstimated: true,
      historyPending: true,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
    };
    return { view, pnl: stubPnl, priced: [] };
  }

  if (!isOpen && priced.length === 0 && !livePos) return null;

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
    fee,
    tickLower: raw.tickLower,
    tickUpper: raw.tickUpper,
    inRange: livePos?.inRange ?? null,
    amount0Human: livePos?.amount0Human ?? 0,
    amount1Human: livePos?.amount1Human ?? 0,
    liquidity: (livePos?.liquidity ?? raw.liquidity).toString(),
    explorerUrl: `${ROBINHOOD.explorer}/token/${ROBINHOOD.npm}/instance/${tokenId}`,
    costBasisEstimated: costBasisEstimated || Boolean(pnl.costBasisMissing),
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
      events = await getV4PositionEvents(vp, latest);
    } catch (e) {
      console.warn("[v4] events", vp.tokenId.toString(), e);
    }
  }

  const prices = await livePricesForPair(vp.token0, vp.token1);
  const priced = toPriced(events, prices);

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

  // V4 ModifyLiquidity often has 0 token amounts → cost basis may be missing
  const hasIncrease = priced.some(
    (e) => e.eventType === "increase" && (e.amount0 > 0 || e.amount1 > 0),
  );

  const pnl = computePositionPnl({
    tokenId: vp.tokenId.toString(),
    events: priced,
    currentValueUsd,
    currentValueEth,
    unclaimedFeesUsd,
    unclaimedFeesEth,
    isOpen,
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
    fee: vp.fee,
    tickLower: vp.tickLower,
    tickUpper: vp.tickUpper,
    inRange: vp.inRange,
    amount0Human: vp.amount0Human,
    amount1Human: vp.amount1Human,
    liquidity: vp.liquidity.toString(),
    explorerUrl: `${ROBINHOOD.explorer}/token/${ROBINHOOD.v4PositionManager}/instance/${vp.tokenId}`,
    costBasisEstimated: !hasIncrease || Boolean(pnl.costBasisMissing),
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
  openViews: PositionView[],
  openPnls: PositionPnl[],
  openEvents: Map<string, PricedEvent[]>,
  liveMap: Map<string, NonNullable<Awaited<ReturnType<typeof getLivePosition>>>>,
) {
  if (isIndexCancelled(address, gen)) return;
  if (!closedIds.length) return;

  await updateJob(jobId, address, {
    status: "ready",
    progress: 92,
    progressMessage: `Backfilling history 0/${closedIds.length} (dashboard already ready)…`,
  });

  const closedViews: PositionView[] = [];
  const closedPnls: PositionPnl[] = [];
  const eventsByPosition = new Map(openEvents);

  let done = 0;
  await mapPool(closedIds, 4, async (tokenId) => {
    if (isIndexCancelled(address, gen)) return;
    done += 1;
    if (done % 3 === 0 || done === closedIds.length) {
      await updateJob(jobId, address, {
        status: "ready",
        progress: 92 + Math.floor((done / closedIds.length) * 7),
        progressMessage: `Backfilling history ${done}/${closedIds.length}…`,
      });
    }

    const livePos = liveMap.get(tokenId.toString()) ?? null;
    const built = await buildOnePosition(tokenId, owner, latest, livePos, {
      fetchEvents: true,
      historyPending: false,
    }).catch(() => null);

    if (built) {
      closedViews.push(built.view);
      closedPnls.push(built.pnl);
      eventsByPosition.set(tokenId.toString(), built.priced);
    }
  });

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
    `[index] phase2 done days=${result.daily.length} closed=${closedViews.length}`,
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
  /** Hard budget for first paint (first scan, no cache). */
  const PHASE1_MS = 8_000;
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

  await checkpoint(5, "First scan — live open only (max ~10s)…");

  let latest = 0n;
  try {
    latest = await Promise.race([
      getLatestBlock(),
      new Promise<bigint>((_, rej) =>
        setTimeout(() => rej(new Error("block timeout")), 3_000),
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
    heldIds = await Promise.race([
      listNpmTokenIds(owner),
      new Promise<bigint[]>((r) => setTimeout(() => r([]), 4_000)),
    ]);
  } catch (e) {
    console.warn("[index] listNpm", e);
  }
  if (cancelled()) throw new Error("CANCELLED");

  // 2) Light filter: only read positions() for liquidity (skip closed detail)
  await checkpoint(35, `Filtering open among ${heldIds.length}…`);
  const openIds: bigint[] = [];
  const closedHeldIds: bigint[] = [];
  await mapPool(heldIds, 12, async (tokenId) => {
    if (!ok()) return;
    const raw = await readPosition(tokenId).catch(() => null);
    if (!raw) return;
    if (raw.liquidity > 0n) openIds.push(tokenId);
    else closedHeldIds.push(tokenId);
  });

  // 3) Full live mark ONLY for open (typically 1–5) — no fee growth, no events
  await checkpoint(
    55,
    openIds.length
      ? `Live mark ${openIds.length} open…`
      : "No open V3…",
  );

  const liveMap = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof getLivePosition>>>
  >();
  process.env.SKIP_FEE_GROWTH = "1";
  await mapPool(openIds, 6, async (tokenId) => {
    if (!ok()) return;
    const p = await getLivePosition(tokenId, owner).catch(() => null);
    if (p) liveMap.set(tokenId.toString(), p);
  });

  const openViews: PositionView[] = [];
  const openPnls: PositionPnl[] = [];
  const openEvents = new Map<string, PricedEvent[]>();

  await mapPool(openIds, 4, async (tokenId) => {
    if (!ok()) return;
    const livePos = liveMap.get(tokenId.toString()) ?? null;
    const built = await buildOnePosition(tokenId, owner, latest, livePos, {
      fetchEvents: false, // NEVER on first paint
      historyPending: false,
    }).catch(() => null);
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
        listLiveV4Positions(owner),
        new Promise<LiveV4Position[]>((r) =>
          setTimeout(() => r([]), Math.min(3_000, timeLeft())),
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
    progressMessage: `Ready in ${(elapsed / 1000).toFixed(1)}s — ${v3Open} V3 + ${v4Open} V4 open (live). History in background…`,
  });

  console.log(
    `[index] FIRST PAINT ${elapsed}ms open v3=${v3Open} v4=${v4Open} held=${heldIds.length}`,
  );

  // Background: never blocks first response
  void (async () => {
    if (cancelled()) return;
    process.env.SKIP_FEE_GROWTH = "0";

    // Enrich open with Increase + Collect (claimed fees + cost basis)
    await mapPool(openIds, 2, async (tokenId) => {
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
      openViews,
      openPnls,
      openEvents,
      liveMap,
    );
  })().catch((e) => console.warn("[index] bg", e));

  return result;
}
