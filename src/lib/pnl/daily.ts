/**
 * Calendar daily rows for heatmap.
 * Simplified to match UniLP-Monitoring data model:
 * - netPnlUsd only (no ETH, no fee/price breakdown)
 * - closeCount/winCount from close_history
 */

import type { DailyPnl, PositionPnl, PricedEvent } from "./compute";

export type CloseHistoryEntry = {
  positionId: string;
  settledAt: string;
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

function emptyDay(date: string): DailyPnl {
  return {
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
}

/**
 * Build daily PnL rows.
 */
export function buildDailyPnl(
  eventsByPosition: Map<string, PricedEvent[]>,
  positionPnls: PositionPnl[],
  closeHistory?: CloseHistoryEntry[],
): DailyPnl[] {
  const days = new Map<string, DailyPnl>();

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

      if (e.eventType === "increase") {
        d.depositUsd += usd;
      } else if (e.eventType === "decrease") {
        d.withdrawUsd += usd;
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

  // ── 2) Closed positions: full realized PnL on close day ──
  for (const p of positionPnls) {
    if (p.isOpen) continue;

    const ch = closeMap.get(p.tokenId);

    let date = "";
    let netPnlUsd: number;

    if (ch) {
      date = ch.settledAt.slice(0, 10);
      netPnlUsd = ch.finalPnlUsd;
    } else {
      // No close_history entry — skip (we rely on close_history for realized PnL)
      continue;
    }

    if (!date) continue;

    const d = ensure(date);
    if (!d) continue;

    d.positionsClosed += 1;
    d.netPnlUsd += netPnlUsd;

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
  }

  // ── 4) Mark deposit days as activity even if netPnl is 0 ──
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
