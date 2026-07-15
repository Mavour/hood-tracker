/**
 * Pure PnL calculation engine (unit-testable).
 * Formula mirrors unicrit + spec section 3:
 *
 *   netPnL = withdrawn + feesCollected + currentValue - deposit
 *   feePnL = feesCollected
 *   pricePnL = netPnL - feePnL  (IL / price move component)
 */

export type PricedEvent = {
  eventType: "increase" | "decrease" | "collect" | "transfer_mint" | "transfer_burn";
  timestamp: number; // unix seconds
  amount0: number;
  amount1: number;
  price0Usd: number;
  price1Usd: number;
  price0Eth: number;
  price1Eth: number;
  txHash?: string;
  blockNumber?: number;
};

export type PositionPnl = {
  tokenId: string;
  depositUsd: number;
  depositEth: number;
  withdrawnUsd: number;
  withdrawnEth: number;
  feesCollectedUsd: number;
  feesCollectedEth: number;
  currentValueUsd: number;
  currentValueEth: number;
  unclaimedFeesUsd: number;
  unclaimedFeesEth: number;
  netPnlUsd: number;
  netPnlEth: number;
  feePnlUsd: number;
  feePnlEth: number;
  pricePnlUsd: number;
  pricePnlEth: number;
  pnlPctUsd: number | null;
  pnlPctEth: number | null;
  openedAt: number | null;
  closedAt: number | null;
  isOpen: boolean;
  /** true when no IncreaseLiquidity found — deposit/PnL % unreliable */
  costBasisMissing?: boolean;
  /** number of increase events used for cost basis */
  increaseEventCount?: number;
};

export type DailyPnl = {
  date: string; // YYYY-MM-DD
  netPnlUsd: number;
  netPnlEth: number;
  feePnlUsd: number;
  feePnlEth: number;
  pricePnlUsd: number;
  pricePnlEth: number;
  depositUsd: number;
  depositEth: number;
  withdrawUsd: number;
  withdrawEth: number;
  feesUsd: number;
  feesEth: number;
  positionsOpened: number;
  positionsClosed: number;
  eventCount: number;
};

function eventValue(
  e: PricedEvent,
  denom: "usd" | "eth",
): number {
  if (denom === "usd") {
    return e.amount0 * e.price0Usd + e.amount1 * e.price1Usd;
  }
  return e.amount0 * e.price0Eth + e.amount1 * e.price1Eth;
}

function dayKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Compute PnL for a single position from priced events + live mark.
 */
export function computePositionPnl(params: {
  tokenId: string;
  events: PricedEvent[];
  currentValueUsd?: number;
  currentValueEth?: number;
  unclaimedFeesUsd?: number;
  unclaimedFeesEth?: number;
  isOpen?: boolean;
}): PositionPnl {
  const {
    tokenId,
    events,
    currentValueUsd = 0,
    currentValueEth = 0,
    unclaimedFeesUsd = 0,
    unclaimedFeesEth = 0,
    isOpen = false,
  } = params;

  let depositUsd = 0;
  let depositEth = 0;
  let withdrawnUsd = 0;
  let withdrawnEth = 0;
  let feesCollectedUsd = 0;
  let feesCollectedEth = 0;
  let openedAt: number | null = null;
  let closedAt: number | null = null;
  let increaseEventCount = 0;

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  for (const e of sorted) {
    if (e.eventType === "increase") {
      // Skip zero-amount noise
      if (e.amount0 === 0 && e.amount1 === 0) continue;
      depositUsd += eventValue(e, "usd");
      depositEth += eventValue(e, "eth");
      increaseEventCount += 1;
      if (openedAt == null) openedAt = e.timestamp;
    } else if (e.eventType === "decrease") {
      withdrawnUsd += eventValue(e, "usd");
      withdrawnEth += eventValue(e, "eth");
    } else if (e.eventType === "collect") {
      feesCollectedUsd += eventValue(e, "usd");
      feesCollectedEth += eventValue(e, "eth");
    } else if (e.eventType === "transfer_mint") {
      if (openedAt == null) openedAt = e.timestamp;
    } else if (e.eventType === "transfer_burn") {
      closedAt = e.timestamp;
    }
  }

  const costBasisMissing = increaseEventCount === 0;

  // Principal mark (currentValue*) + unclaimed fees separate
  // net = withdraw + feesCollected + principalNow + unclaimed - deposit
  const principalUsd = isOpen ? currentValueUsd : 0;
  const principalEth = isOpen ? currentValueEth : 0;
  const unclUsd = isOpen ? unclaimedFeesUsd : 0;
  const unclEth = isOpen ? unclaimedFeesEth : 0;

  let netPnlUsd: number;
  let netPnlEth: number;
  let feePnlUsd: number;
  let feePnlEth: number;
  let pricePnlUsd: number;
  let pricePnlEth: number;

  if (costBasisMissing && isOpen) {
    // WITHOUT real deposit: do NOT fake deposit=current (that made all profit look like fees).
    // Show unclaimed fees as the only known P&L component; principal IL unknown.
    depositUsd = 0;
    depositEth = 0;
    netPnlUsd = unclUsd; // known: unclaimed fees only
    netPnlEth = unclEth;
    feePnlUsd = unclUsd + feesCollectedUsd;
    feePnlEth = unclEth + feesCollectedEth;
    pricePnlUsd = 0; // unknown without cost basis
    pricePnlEth = 0;
  } else if (costBasisMissing && !isOpen) {
    // Closed with no events — nothing reliable
    netPnlUsd = withdrawnUsd + feesCollectedUsd - depositUsd;
    netPnlEth = withdrawnEth + feesCollectedEth - depositEth;
    feePnlUsd = feesCollectedUsd;
    feePnlEth = feesCollectedEth;
    pricePnlUsd = netPnlUsd - feePnlUsd;
    pricePnlEth = netPnlEth - feePnlEth;
  } else {
    // Real cost basis from IncreaseLiquidity amounts
    netPnlUsd =
      withdrawnUsd + feesCollectedUsd + principalUsd + unclUsd - depositUsd;
    netPnlEth =
      withdrawnEth + feesCollectedEth + principalEth + unclEth - depositEth;
    // Fee contribution = claimed + unclaimed
    feePnlUsd = feesCollectedUsd + unclUsd;
    feePnlEth = feesCollectedEth + unclEth;
    // Price/IL = everything else (principal move vs deposit, after fees)
    pricePnlUsd = netPnlUsd - feePnlUsd;
    pricePnlEth = netPnlEth - feePnlEth;
  }

  return {
    tokenId,
    depositUsd,
    depositEth,
    withdrawnUsd,
    withdrawnEth,
    feesCollectedUsd,
    feesCollectedEth,
    currentValueUsd: isOpen ? currentValueUsd : 0,
    currentValueEth: isOpen ? currentValueEth : 0,
    unclaimedFeesUsd: isOpen ? unclaimedFeesUsd : 0,
    unclaimedFeesEth: isOpen ? unclaimedFeesEth : 0,
    netPnlUsd,
    netPnlEth,
    feePnlUsd,
    feePnlEth,
    pricePnlUsd,
    pricePnlEth,
    pnlPctUsd:
      !costBasisMissing && depositUsd > 1e-9
        ? (netPnlUsd / depositUsd) * 100
        : null,
    pnlPctEth:
      !costBasisMissing && depositEth > 1e-9
        ? (netPnlEth / depositEth) * 100
        : null,
    openedAt,
    closedAt: isOpen ? null : closedAt,
    isOpen,
    costBasisMissing,
    increaseEventCount,
  };
}

/**
 * Aggregate daily PnL deltas from events across positions.
 * For calendar heatmap: each day's realized flow (deposits as negative cash,
 * withdrawals/fees as positive) + optional mark-to-market is simplified to
 * event-day cash flow contribution.
 */
export function computeDailyPnl(
  eventsByPosition: Map<string, PricedEvent[]>,
  positionPnls: PositionPnl[],
): DailyPnl[] {
  const days = new Map<string, DailyPnl>();

  function ensure(date: string): DailyPnl {
    let d = days.get(date);
    if (!d) {
      d = {
        date,
        netPnlUsd: 0,
        netPnlEth: 0,
        feePnlUsd: 0,
        feePnlEth: 0,
        pricePnlUsd: 0,
        pricePnlEth: 0,
        depositUsd: 0,
        depositEth: 0,
        withdrawUsd: 0,
        withdrawEth: 0,
        feesUsd: 0,
        feesEth: 0,
        positionsOpened: 0,
        positionsClosed: 0,
        eventCount: 0,
      };
      days.set(date, d);
    }
    return d;
  }

  for (const [, events] of eventsByPosition) {
    for (const e of events) {
      if (!e.timestamp) continue;
      const d = ensure(dayKey(e.timestamp));
      d.eventCount += 1;
      const usd = eventValue(e, "usd");
      const eth = eventValue(e, "eth");

      if (e.eventType === "increase") {
        d.depositUsd += usd;
        d.depositEth += eth;
        // deposit reduces net (cash out)
        d.netPnlUsd -= usd;
        d.netPnlEth -= eth;
        d.pricePnlUsd -= usd;
        d.pricePnlEth -= eth;
      } else if (e.eventType === "decrease") {
        d.withdrawUsd += usd;
        d.withdrawEth += eth;
        d.netPnlUsd += usd;
        d.netPnlEth += eth;
        d.pricePnlUsd += usd;
        d.pricePnlEth += eth;
      } else if (e.eventType === "collect") {
        d.feesUsd += usd;
        d.feesEth += eth;
        d.feePnlUsd += usd;
        d.feePnlEth += eth;
        d.netPnlUsd += usd;
        d.netPnlEth += eth;
      } else if (e.eventType === "transfer_mint") {
        d.positionsOpened += 1;
      } else if (e.eventType === "transfer_burn") {
        d.positionsClosed += 1;
      }
    }
  }

  // Attribute open-position unrealized PnL to "today" so calendar shows live PnL
  const today = new Date().toISOString().slice(0, 10);
  for (const p of positionPnls) {
    if (p.isOpen) {
      const d = ensure(today);
      // Only add current mark once as residual (current + unclaimed already not in events)
      const residualUsd =
        p.currentValueUsd + p.unclaimedFeesUsd;
      const residualEth =
        p.currentValueEth + p.unclaimedFeesEth;
      d.netPnlUsd += residualUsd;
      d.netPnlEth += residualEth;
      d.feePnlUsd += p.unclaimedFeesUsd;
      d.feePnlEth += p.unclaimedFeesEth;
      d.pricePnlUsd += residualUsd - p.unclaimedFeesUsd;
      d.pricePnlEth += residualEth - p.unclaimedFeesEth;
    }
  }

  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function aggregatePortfolio(pnls: PositionPnl[]) {
  const sum = {
    depositUsd: 0,
    depositEth: 0,
    withdrawnUsd: 0,
    withdrawnEth: 0,
    feesCollectedUsd: 0,
    feesCollectedEth: 0,
    currentValueUsd: 0,
    currentValueEth: 0,
    unclaimedFeesUsd: 0,
    unclaimedFeesEth: 0,
    netPnlUsd: 0,
    netPnlEth: 0,
    feePnlUsd: 0,
    feePnlEth: 0,
    pricePnlUsd: 0,
    pricePnlEth: 0,
    /** Closed positions only — already collected/withdrawn */
    realizedPnlUsd: 0,
    realizedPnlEth: 0,
    /** Open positions — paper PnL, moves with price */
    unrealizedPnlUsd: 0,
    unrealizedPnlEth: 0,
    openCount: 0,
    closedCount: 0,
  };

  for (const p of pnls) {
    sum.depositUsd += p.depositUsd;
    sum.depositEth += p.depositEth;
    sum.withdrawnUsd += p.withdrawnUsd;
    sum.withdrawnEth += p.withdrawnEth;
    sum.feesCollectedUsd += p.feesCollectedUsd;
    sum.feesCollectedEth += p.feesCollectedEth;
    sum.currentValueUsd += p.currentValueUsd;
    sum.currentValueEth += p.currentValueEth;
    sum.unclaimedFeesUsd += p.unclaimedFeesUsd;
    sum.unclaimedFeesEth += p.unclaimedFeesEth;
    sum.netPnlUsd += p.netPnlUsd;
    sum.netPnlEth += p.netPnlEth;
    sum.feePnlUsd += p.feePnlUsd;
    sum.feePnlEth += p.feePnlEth;
    sum.pricePnlUsd += p.pricePnlUsd;
    sum.pricePnlEth += p.pricePnlEth;
    if (p.isOpen) {
      sum.openCount += 1;
      sum.unrealizedPnlUsd += p.netPnlUsd;
      sum.unrealizedPnlEth += p.netPnlEth;
    } else {
      sum.closedCount += 1;
      sum.realizedPnlUsd += p.netPnlUsd;
      sum.realizedPnlEth += p.netPnlEth;
    }
  }

  return {
    ...sum,
    /** total = realized + unrealized */
    totalPnlUsd: sum.realizedPnlUsd + sum.unrealizedPnlUsd,
    totalPnlEth: sum.realizedPnlEth + sum.unrealizedPnlEth,
    pnlPctUsd:
      sum.depositUsd > 1e-9 ? (sum.netPnlUsd / sum.depositUsd) * 100 : null,
    pnlPctEth:
      sum.depositEth > 1e-9 ? (sum.netPnlEth / sum.depositEth) * 100 : null,
  };
}
