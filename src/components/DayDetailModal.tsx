"use client";

import { X } from "lucide-react";
import { formatSigned } from "@/lib/utils";
import type { Currency } from "./CurrencyToggle";
import type { DayPnl } from "./PnlCalendar";
import { Button } from "./ui/button";

export function DayDetailModal({
  day,
  currency,
  onClose,
}: {
  day: DayPnl;
  currency: Currency;
  onClose: () => void;
}) {
  const net = day.netPnlUsd;
  const cc = day.closeCount ?? 0;
  const wc = day.winCount ?? 0;
  const wr = cc > 0 ? `${((wc * 100) / cc).toFixed(1)}%` : "--";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-rh-black/80 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="rh-card-glow w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-rh-muted">
              Daily PnL
            </p>
            <h3 className="text-xl font-semibold text-rh-white">{day.date}</h3>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div
          className={`mb-6 text-3xl font-bold tabular-nums ${
            net >= 0 ? "text-rh-green" : "text-rh-red"
          }`}
        >
          {formatSigned(net, currency)}
        </div>

        <div className="space-y-3 text-sm">
          <div className="my-2 border-t border-rh-line" />
          <Row
            label="Positions opened"
            value={String(day.positionsOpened ?? 0)}
          />
          <Row
            label="Positions closed"
            value={String(day.positionsClosed ?? 0)}
          />
          <Row label="Events" value={String(day.eventCount ?? 0)} />
          {cc > 0 && (
            <>
              <div className="my-2 border-t border-rh-line" />
              <Row
                label="LP settlements"
                value={`${cc} (${wc}W / ${cc - wc}L)`}
              />
              <Row label="Win rate" value={wr} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-rh-soft">{label}</p>
        {hint && <p className="text-[11px] text-rh-muted">{hint}</p>}
      </div>
      <p className="font-mono text-rh-white">{value}</p>
    </div>
  );
}
