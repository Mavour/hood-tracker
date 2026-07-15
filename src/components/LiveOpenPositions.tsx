"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn, formatSigned, formatPct, feeTierLabel } from "@/lib/utils";
import type { Currency } from "./CurrencyToggle";

type LiveRow = {
  tokenId: string;
  pool: string;
  depositValueUsd: number;
  depositValueEth: number;
  currentValueUsd: number;
  currentValueEth: number;
  unrealizedPnlUsd: number;
  unrealizedPnlEth: number;
  feeUnclaimedUsd: number;
  feeUnclaimedEth: number;
  feesCollectedUsd?: number;
  feesCollectedEth?: number;
  inRange: boolean;
  lastUpdated: string;
  costBasisEstimated?: boolean;
  protocol?: string;
};

type LiveTotals = {
  unrealizedPnlUsd: number;
  unrealizedPnlEth: number;
  realizedPnlUsd: number;
  realizedPnlEth: number;
  totalPnlUsd: number;
  totalPnlEth: number;
  openValueUsd: number;
  openValueEth: number;
  openCount: number;
};

export function LiveOpenPositions({
  address,
  currency,
  onTotals,
}: {
  address: string;
  currency: Currency;
  onTotals?: (t: LiveTotals | null) => void;
}) {
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [, setTotals] = useState<LiveTotals | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ago, setAgo] = useState(0);
  const visible = useRef(true);
  const onTotalsRef = useRef(onTotals);
  onTotalsRef.current = onTotals;

  const load = useCallback(async () => {
    if (!visible.current) return;
    try {
      const res = await fetch(`/api/pnl/${address}/live`, {
        cache: "no-store",
      });
      if (!res.ok) {
        if (res.status === 404) return;
        setError(`Live refresh failed (${res.status})`);
        return;
      }
      const data = await res.json();
      setRows(data.positions ?? []);
      setTotals(data.totals ?? null);
      setUpdatedAt(data.lastUpdated ?? new Date().toISOString());
      setError(null);
      onTotalsRef.current?.(data.totals ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Live fetch error");
    }
  }, [address]);

  useEffect(() => {
    const onVis = () => {
      visible.current = document.visibilityState === "visible";
      if (visible.current) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(id);
    };
  }, [load]);

  useEffect(() => {
    if (!updatedAt) return;
    const tick = () => {
      setAgo(
        Math.max(
          0,
          Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000),
        ),
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [updatedAt]);

  if (!rows.length && !error) {
    return (
      <div className="rounded-2xl border border-dashed border-rh-line bg-rh-card/60 px-4 py-8 text-center text-sm text-rh-muted">
        No open positions right now.
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] text-rh-muted">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rh-green opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rh-green" />
          </span>
          Live feed
          {updatedAt && <span>· {ago}s ago</span>}
        </div>
        {error && <span className="text-xs text-rh-red">{error}</span>}
      </div>

      {rows.map((r) => {
        const pnl =
          currency === "usd" ? r.unrealizedPnlUsd : r.unrealizedPnlEth;
        const dep =
          currency === "usd" ? r.depositValueUsd : r.depositValueEth;
        const cur =
          currency === "usd" ? r.currentValueUsd : r.currentValueEth;
        const fee =
          currency === "usd" ? r.feeUnclaimedUsd : r.feeUnclaimedEth;
        const pct = dep > 1e-9 ? (pnl / dep) * 100 : null;

        return (
          <div
            key={r.tokenId}
            className="rh-card border-rh-green/20 bg-gradient-to-br from-rh-green/10 to-transparent p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="font-semibold text-rh-white">{r.pool}</h4>
                  <span className="rounded-md bg-rh-green/15 px-2 py-0.5 text-[11px] font-semibold text-rh-neon">
                    Open · Live
                  </span>
                  <span
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px] font-semibold",
                      r.inRange
                        ? "bg-rh-green/10 text-rh-green"
                        : "bg-rh-red/10 text-rh-red",
                    )}
                  >
                    {r.inRange ? "In range" : "Out of range"}
                  </span>
                  {r.costBasisEstimated && (
                    <span className="rounded-md bg-rh-elevated px-2 py-0.5 text-[10px] text-rh-muted">
                      cost basis est.
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-rh-muted">NFT #{r.tokenId}</p>
              </div>
              <div className="text-right">
                <p
                  className={cn(
                    "text-xl font-bold tabular-nums",
                    pnl >= 0 ? "text-rh-green" : "text-rh-red",
                  )}
                >
                  {formatSigned(pnl, currency)}
                </p>
                <p className="text-xs text-rh-muted">{formatPct(pct)}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Stat
                label="Deposit"
                value={
                  r.costBasisEstimated || dep === 0
                    ? "—"
                    : formatSigned(dep, currency).replace(/^\+/, "")
                }
              />
              <Stat label="Now (+unclaimed)" value={formatSigned(cur, currency).replace(/^\+/, "")} />
              <Stat
                label="Claimed fees"
                value={formatSigned(
                  currency === "usd"
                    ? (r.feesCollectedUsd ?? 0)
                    : (r.feesCollectedEth ?? 0),
                  currency,
                )}
              />
              <Stat label="Unclaimed fees" value={formatSigned(fee, currency)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-rh-elevated px-3 py-2">
      <p className="text-rh-muted">{label}</p>
      <p className="mt-0.5 font-mono text-rh-white">{value}</p>
    </div>
  );
}

void feeTierLabel;
