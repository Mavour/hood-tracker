/**
 * Pure PnL calculation engine (unit-testable).
 * Simplified to match UniLP-Monitoring data model:
 *
 *   netPnL = withdrawn + feesCollected + currentValue - deposit
 *   pnlBps = (netPnL / deposit) * 10000
 *
 * ETH-denominated fields removed — all pricing is USD only.
 * feePnl/pricePnl breakdown removed — only netPnlUsd is tracked.
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
  withdrawnUsd: number;
  feesCollectedUsd: number;
  currentValueUsd: number;
  unclaimedFeesUsd: number;
  netPnlUsd: number;
  pnlBps: number | null;
  isOpen: boolean;
  /** "events" = from mint/increase events, "estimate" = inferred from current value (inaccurate) */
  costBasisSource: "events" | "estimate";
};

export type MintDeposit = {
  amount0: number;
  amount1: number;
  price0Usd: number;
  price1Usd: number;
  price0Eth: number;
  price1Eth: number;
  blockNumber?: number;
  /** "onchain" = resolved from mint tx, "estimate" = inferred from current live amounts */
  source?: "onchain" | "estimate";
};

export type DailyPnl = {
  date: string; // YYYY-MM-DD
  netPnlUsd: number;
  depositUsd: number;
  withdrawUsd: number;
  feesUsd: number;
  positionsOpened: number;
  positionsClosed: number;
  eventCount: number;
  closeCount: number;
  winCount: number;
};

function eventValue(e: PricedEvent): number {
  return e.amount0 * e.price0Usd + e.amount1 * e.price1Usd;
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
  unclaimedFeesUsd?: number;
  isOpen?: boolean;
  /**
   * Canonical deposit resolved from the on-chain MINT transaction. When
   * present it is the authoritative cost basis; IncreaseLiquidity events at or
   * before the mint block are excluded to avoid double-counting (the mint IS
   * the first increase). Subsequent increases still add to the deposit.
   */
  mintDeposit?: MintDeposit | null;
}): PositionPnl {
  const {
    tokenId,
    events,
    currentValueUsd = 0,
    unclaimedFeesUsd = 0,
    isOpen = false,
    mintDeposit = null,
  } = params;

  let depositUsd = 0;
  let withdrawnUsd = 0;
  let feesCollectedUsd = 0;

  // Authoritative initial deposit from the MINT transaction (block-priced).
  const mintBlock = mintDeposit?.blockNumber;
  if (mintDeposit && (mintDeposit.amount0 > 0 || mintDeposit.amount1 > 0)) {
    depositUsd += mintDeposit.amount0 * mintDeposit.price0Usd + mintDeposit.amount1 * mintDeposit.price1Usd;
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  for (const e of sorted) {
    if (e.eventType === "increase") {
      if (e.amount0 === 0 && e.amount1 === 0) continue;
      if (mintDeposit && mintBlock != null && (e.blockNumber ?? 0) <= mintBlock) {
        continue;
      }
      depositUsd += eventValue(e);
    } else if (e.eventType === "decrease") {
      withdrawnUsd += eventValue(e);
    } else if (e.eventType === "collect") {
      feesCollectedUsd += eventValue(e);
    }
  }

  // Principal mark (currentValue) + unclaimed fees separate
  // net = withdraw + feesCollected + principalNow + unclaimed - deposit
  const principalUsd = isOpen ? currentValueUsd : 0;
  const unclUsd = isOpen ? unclaimedFeesUsd : 0;

  // Fallback cost basis when mint/increase events are missing
  const costBasisMissing = depositUsd === 0;
  let costBasisSource: "events" | "estimate" = "events";
  if (costBasisMissing) {
    const estUsd = principalUsd + withdrawnUsd + feesCollectedUsd;
    if (estUsd > 0) {
      depositUsd = estUsd;
      costBasisSource = "estimate";
      console.warn(
        `[pnl] cost basis ESTIMATE for ${tokenId}: deposit=0, estUsd=${estUsd.toFixed(2)} (principal=${principalUsd.toFixed(2)} withdrawn=${withdrawnUsd.toFixed(2)} fees=${feesCollectedUsd.toFixed(2)})`,
      );
    }
  }

  const netPnlUsd = withdrawnUsd + feesCollectedUsd + principalUsd + unclUsd - depositUsd;

  const pnlBps = depositUsd > 1e-9 ? (netPnlUsd / depositUsd) * 10000 : null;

  return {
    tokenId,
    depositUsd,
    withdrawnUsd,
    feesCollectedUsd,
    currentValueUsd: isOpen ? currentValueUsd : 0,
    unclaimedFeesUsd: isOpen ? unclaimedFeesUsd : 0,
    netPnlUsd,
    pnlBps,
    isOpen,
    costBasisSource,
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
        depositUsd: 0,
        withdrawUsd: 0,
        feesUsd: 0,
        positionsOpened: 0,
        positionsClosed: 0,
        eventCount: 0,
        closeCount: 0,
        winCount: 0,
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
      const usd = eventValue(e);

      if (e.eventType === "increase") {
        d.depositUsd += usd;
        d.netPnlUsd -= usd;
      } else if (e.eventType === "decrease") {
        d.withdrawUsd += usd;
        d.netPnlUsd += usd;
      } else if (e.eventType === "collect") {
        d.feesUsd += usd;
        d.netPnlUsd += usd;
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
      d.netPnlUsd += p.currentValueUsd + p.unclaimedFeesUsd;
    }
  }

  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function aggregatePortfolio(pnls: PositionPnl[]) {
  const sum = {
    depositUsd: 0,
    withdrawnUsd: 0,
    feesCollectedUsd: 0,
    currentValueUsd: 0,
    unclaimedFeesUsd: 0,
    netPnlUsd: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    openCount: 0,
    closedCount: 0,
  };

  for (const p of pnls) {
    sum.depositUsd += p.depositUsd;
    sum.withdrawnUsd += p.withdrawnUsd;
    sum.feesCollectedUsd += p.feesCollectedUsd;
    sum.currentValueUsd += p.currentValueUsd;
    sum.unclaimedFeesUsd += p.unclaimedFeesUsd;
    sum.netPnlUsd += p.netPnlUsd;
    if (p.isOpen) {
      sum.openCount += 1;
      sum.unrealizedPnlUsd += p.netPnlUsd;
    } else {
      sum.closedCount += 1;
      sum.realizedPnlUsd += p.netPnlUsd;
    }
  }

  return {
    ...sum,
    totalPnlUsd: sum.realizedPnlUsd + sum.unrealizedPnlUsd,
    pnlBps: sum.depositUsd > 1e-9 ? (sum.netPnlUsd / sum.depositUsd) * 10000 : null,
  };
}
