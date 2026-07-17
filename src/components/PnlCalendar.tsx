"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn, formatSigned } from "@/lib/utils";
import type { Currency } from "./CurrencyToggle";
import { Button } from "./ui/button";

export type DayPnl = {
  date: string;
  netPnlUsd: number;
  depositUsd?: number;
  withdrawUsd?: number;
  feesUsd?: number;
  positionsOpened?: number;
  positionsClosed?: number;
  eventCount?: number;
  closeCount?: number;
  winCount?: number;
};

function intensity(value: number, maxAbs: number): number {
  if (maxAbs <= 0 || value === 0) return 0;
  const t = Math.min(1, Math.abs(value) / maxAbs);
  return 0.18 + t * 0.7;
}

function winrate(winCount: number, closeCount: number): string {
  if (closeCount === 0) return "--";
  return `${((winCount * 100) / closeCount).toFixed(1)}%`;
}

/** Compact month grid — fits desktop split pane without overflowing viewport. */
export function PnlCalendar({
  daily,
  currency,
  onSelectDay,
  compact = true,
}: {
  daily: DayPnl[];
  currency: Currency;
  onSelectDay: (day: DayPnl) => void;
  compact?: boolean;
}) {
  const initialMonth = useMemo(() => {
    if (!daily.length) return new Date();
    const sorted = [...daily].sort((a, b) => b.date.localeCompare(a.date));
    const latest = sorted[0]?.date;
    if (latest) {
      const [y, m] = latest.split("-").map(Number);
      return new Date(y, m - 1, 1);
    }
    return new Date();
  }, [daily]);

  const [cursor, setCursor] = useState(initialMonth);
  useEffect(() => {
    setCursor(initialMonth);
  }, [initialMonth]);

  const byDate = useMemo(() => {
    const m = new Map<string, DayPnl>();
    for (const d of daily) m.set(d.date, d);
    return m;
  }, [daily]);

  const maxAbs = useMemo(() => {
    let m = 0;
    for (const d of daily) {
      m = Math.max(m, Math.abs(d.netPnlUsd));
    }
    return m || 1;
  }, [daily]);

  const monthStart = startOfMonth(cursor);
  const monthEnd = endOfMonth(cursor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  const monthStats = useMemo(() => {
    const mKey = format(cursor, "yyyy-MM");
    let totalPnl = 0;
    let totalClose = 0;
    let totalWin = 0;
    let activeDays = 0;
    for (const d of daily) {
      if (!d.date.startsWith(mKey)) continue;
      totalPnl += d.netPnlUsd;
      const cc = d.closeCount ?? 0;
      const wc = d.winCount ?? 0;
      totalClose += cc;
      totalWin += wc;
      if (cc > 0 || Math.abs(d.netPnlUsd) > 1e-12) activeDays += 1;
    }
    return { totalPnl, totalClose, totalWin, activeDays };
  }, [daily, cursor]);

  return (
    <div className="rh-card flex h-full flex-col p-4 sm:p-5">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-rh-white sm:text-base">
          {format(cursor, "MMMM yyyy")}
        </h3>
        <div className="flex gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCursor((d) => subMonths(d, 1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCursor((d) => addMonths(d, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.06] pb-2 text-[11px]">
        <span
          className={cn(
            "font-semibold tabular-nums",
            monthStats.totalPnl >= 0 ? "text-rh-green" : "text-rh-red",
          )}
        >
          {formatSigned(monthStats.totalPnl, currency)}
        </span>
        <span className="text-rh-muted">
          {monthStats.activeDays} active day{monthStats.activeDays !== 1 ? "s" : ""}
        </span>
        {monthStats.totalClose > 0 && (
          <>
            <span className="text-rh-muted">
              {monthStats.totalClose} LP close{monthStats.totalClose !== 1 ? "s" : ""}
            </span>
            <span
              className={cn(
                "font-semibold",
                monthStats.totalWin > monthStats.totalClose - monthStats.totalWin
                  ? "text-rh-green"
                  : monthStats.totalWin < monthStats.totalClose - monthStats.totalWin
                    ? "text-rh-red"
                    : "text-rh-muted",
              )}
            >
              {winrate(monthStats.totalWin, monthStats.totalClose)} win
            </span>
          </>
        )}
      </div>

      {/* Day-of-week headers */}
      <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[10px] font-semibold uppercase tracking-wider text-rh-muted">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
          <div key={d} className="py-0.5">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {days.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const data = byDate.get(key);
          const inMonth = isSameMonth(day, cursor);
          const value = data ? data.netPnlUsd : 0;
          const a = data ? intensity(value, maxAbs) : 0;
          const isProfit = value > 0;
          const isLoss = value < 0;
          const cc = data?.closeCount ?? 0;
          const wc = data?.winCount ?? 0;

          return (
            <button
              key={key}
              type="button"
              disabled={!data}
              onClick={() => data && onSelectDay(data)}
              title={
                data
                  ? [
                      `${key}`,
                      `${formatSigned(value, currency)}`,
                      cc > 0 ? `${cc} LP close${cc !== 1 ? "s" : ""}` : null,
                      cc > 0 ? `${winrate(wc, cc)} win` : null,
                    ]
                      .filter(Boolean)
                      .join("\n")
                  : key
              }
              className={cn(
                "relative flex flex-col items-center justify-center rounded-md border text-[10px] transition-all",
                compact ? "h-10 sm:h-11" : "aspect-square",
                inMonth ? "border-white/[0.06]" : "border-transparent opacity-30",
                data
                  ? "cursor-pointer hover:ring-1 hover:ring-rh-neon/50"
                  : "cursor-default bg-rh-elevated/40",
              )}
              style={
                data
                  ? {
                      backgroundColor: isProfit
                        ? `rgba(0, 214, 107, ${a})`
                        : isLoss
                          ? `rgba(255, 77, 77, ${a})`
                          : "rgba(28, 28, 30, 0.85)",
                    }
                  : undefined
              }
            >
              <span
                className={cn(
                  "font-medium leading-none",
                  inMonth ? "text-rh-white" : "text-rh-muted",
                )}
              >
                {format(day, "d")}
              </span>
              {data && (
                <span
                  className={cn(
                    "mt-0.5 leading-none tabular-nums",
                    isProfit
                      ? "text-rh-green"
                      : isLoss
                        ? "text-rh-red"
                        : "text-rh-muted",
                  )}
                >
                  {formatSigned(value, currency)}
                </span>
              )}
              {data && cc > 0 && (
                <span className="mt-0.5 leading-none text-rh-muted">
                  {cc}c {winrate(wc, cc)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3 text-[10px] text-rh-muted">
        <span>
          {daily.length
            ? `${daily.length} active day(s) · click a cell`
            : "No history yet — Refresh to index events"}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-rh-red" />
          Loss
          <span className="ml-1 h-2 w-2 rounded-sm bg-rh-elevated" />
          Flat
          <span className="ml-1 h-2 w-2 rounded-sm bg-rh-green" />
          Profit
        </div>
      </div>
    </div>
  );
}
