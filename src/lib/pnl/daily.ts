/**
 * Calendar daily rows for heatmap.
 *
 * Per day we show:
 *  - Activity: deposits / withdraws / fees / open / close counts
 *  - netPnl: meaningful P&L for that day
 *      • closed positions → full realized net on their close date
 *      • open positions → unrealized net attributed to today only
 *      • fee collects on their event day (if not already in closed realized)
 *
 * Settlement alignment: For settled positions (in close_history),
 * the final_pnl_usd from close_history is used as the source of truth,
 * matching UniLP-Monitoring's close_history based calendar approach.
 */

import type { DailyPnl, PositionPnl, PricedEvent } from "./compute";

export type CloseHistoryEntry = {
  positionId: string;
  settledAt: string; // ISO date or YYYY-MM-DD
  finalPnlUsd: number;
  finalPnlBps: number;
};

function dayKey(ts: number): string {
  if (!ts || ts < 1_000_000_000) return "";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function eventValueUsd(e: PricedEvent): number {
  return e.amount0 * e.price0Usd + e.amount1 * e.price1Usd;
}
function eventValueEth(e: PricedEvent): number {
  return e.amount0 * e.price0Eth + e.amount1 * e.price1Eth;
}

function emptyDay(date: string): DailyPnl {
  return {
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
    closeCount: 0,
    winCount: 0,
  };
}

/**
 * Build daily PnL rows.
 *
 * @param eventsByPosition - Raw priced events per position
 * @param positionPnls - Computed PnL per position
 * @param closeHistory - Settled positions from close_history (optional, for settlement alignment)
 */
export function buildDailyPnl(
  eventsByPosition: Map<string, PricedEvent[]>,
  positionPnls: PositionPnl[],
  closeHistory?: CloseHistoryEntry[],
): DailyPnl[] {
  const days = new Map<string, DailyPnl>();

  // Build a lookup for close_history by positionId
  const closeMap = new Map<string, CloseHistoryEntry>();
  if (closeHistory) {
    for (const ch of closeHistory) {
      closeMap.set(ch.positionId, ch);
    }
  }

  function ensure(date: string): DailyPnl | null {
    if (!date || date.startsWith("1970")) return null;
    let d = days.get(date);
    if (!d) {
      d = emptyDay(date);
      days.set(date, d);
    }
    return d;
  }

  // ── 1) Activity from raw events (deposits / withdraws / fees / counts) ──
  for (const [, events] of eventsByPosition) {
    for (const e of events) {
      const date = dayKey(e.timestamp);
      const d = ensure(date);
      if (!d) continue;

      d.eventCount += 1;
      const usd = eventValueUsd(e);
      const eth = eventValueEth(e);

      if (e.eventType === "increase") {
        d.depositUsd += usd;
        d.depositEth += eth;
      } else if (e.eventType === "decrease") {
        d.withdrawUsd += usd;
        d.withdrawEth += eth;
      } else if (e.eventType === "collect") {
        d.feesUsd += usd;
        d.feesEth += eth;
        // Fee collects on open positions (or partial) count as that day's fee PnL
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

  // ── 2) Closed positions: full realized PnL on close day ──
  //    Use close_history as source of truth when available (settlement alignment)
  for (const p of positionPnls) {
    if (p.isOpen) continue;

    // Check if this position has a close_history entry
    const ch = closeMap.get(p.tokenId);

    let date = "";
    let netPnlUsd: number;
    let netPnlEth: number;

    if (ch) {
      // Use close_history data (settlement-aligned)
      date = ch.settledAt.slice(0, 10);
      netPnlUsd = ch.finalPnlUsd;
      // For ETH: derive from USD if possible, otherwise use position PnL
      netPnlEth = p.netPnlEth; // Keep ETH value from position PnL
    } else {
      // Fallback to position PnL
      if (p.closedAt && p.closedAt > 1_000_000_000) {
        date = dayKey(p.closedAt);
      } else if (p.openedAt && p.openedAt > 1_000_000_000) {
        date = dayKey(p.openedAt);
      }
      netPnlUsd = p.netPnlUsd;
      netPnlEth = p.netPnlEth;
    }

    if (!date) continue;

    const d = ensure(date);
    if (!d) continue;

    d.positionsClosed += 1;
    d.netPnlUsd += netPnlUsd;
    d.netPnlEth += netPnlEth;
    d.feePnlUsd += p.feePnlUsd;
    d.feePnlEth += p.feePnlEth;
    d.pricePnlUsd += p.pricePnlUsd;
    d.pricePnlEth += p.pricePnlEth;

    // closeCount/winCount from close_history (settlement-aligned)
    if (ch) {
      d.closeCount += 1;
      if (ch.finalPnlUsd > 0) d.winCount += 1;
    }
  }

  // ── 3) Today: open unrealized paper PnL ──
  const today = new Date().toISOString().slice(0, 10);
  for (const p of positionPnls) {
    if (!p.isOpen) continue;
    const d = ensure(today);
    if (!d) continue;
    d.netPnlUsd += p.netPnlUsd;
    d.netPnlEth += p.netPnlEth;
    d.feePnlUsd += p.feePnlUsd;
    d.feePnlEth += p.feePnlEth;
    d.pricePnlUsd += p.pricePnlUsd;
    d.pricePnlEth += p.pricePnlEth;
  }

  // ── 4) Mark deposit days as activity even if netPnl is 0 ──
  // (already have eventCount / depositUsd)

  return [...days.values()]
    .filter(
      (d) =>
        d.eventCount > 0 ||
        Math.abs(d.netPnlUsd) > 1e-12 ||
        d.positionsOpened > 0 ||
        d.positionsClosed > 0 ||
        d.depositUsd > 0 ||
        d.withdrawUsd > 0 ||
        d.feesUsd > 0 ||
        d.closeCount > 0,
    )
    .sort((a, b) => a.date.localeCompare(b.date));
}
