"use client";

import { ExternalLink } from "lucide-react";
import {
  cn,
  feeTierLabel,
  formatPct,
  formatSigned,
  shortAddress,
} from "@/lib/utils";
import type { Currency } from "./CurrencyToggle";

export type PositionRow = {
  tokenId: string;
  protocol?: "v3" | "v4";
  symbol0: string;
  symbol1: string;
  fee: number;
  isOpen: boolean;
  inRange: boolean | null;
  netPnlUsd: number;
  netPnlEth: number;
  feePnlUsd: number;
  feePnlEth: number;
  pricePnlUsd: number;
  pricePnlEth: number;
  depositUsd: number;
  depositEth: number;
  withdrawnUsd?: number;
  withdrawnEth?: number;
  currentValueUsd: number;
  currentValueEth: number;
  feesCollectedUsd?: number;
  feesCollectedEth?: number;
  unclaimedFeesUsd?: number;
  unclaimedFeesEth?: number;
  pnlPctUsd: number | null;
  pnlPctEth: number | null;
  explorerUrl: string;
  poolAddress: string | null;
  costBasisEstimated?: boolean;
  hasCustomHook?: boolean;
  historyPending?: boolean;
};

export function PositionList({
  positions,
  currency,
  emptyText = "No positions in this list.",
  compact,
}: {
  positions: PositionRow[];
  currency: Currency;
  emptyText?: string;
  compact?: boolean;
}) {
  if (!positions.length) {
    return (
      <div className="rounded-2xl border border-dashed border-rh-line bg-rh-card/50 px-4 py-8 text-center text-sm text-rh-muted">
        {emptyText}
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      {positions.map((p) => {
        const net = currency === "usd" ? p.netPnlUsd : p.netPnlEth;
        const dep = currency === "usd" ? p.depositUsd : p.depositEth;
        const cur =
          currency === "usd" ? p.currentValueUsd : p.currentValueEth;
        const pct = currency === "usd" ? p.pnlPctUsd : p.pnlPctEth;
        const fee = currency === "usd" ? p.feePnlUsd : p.feePnlEth;
        const price = currency === "usd" ? p.pricePnlUsd : p.pricePnlEth;

        return (
          <div
            key={`${p.protocol ?? "v3"}-${p.tokenId}`}
            className={cn(
              "rh-card transition hover:border-white/15",
              compact ? "p-3.5" : "p-5",
              p.isOpen && p.inRange != null && (
                p.inRange
                  ? "border-rh-green/20 bg-gradient-to-br from-rh-green/10 to-transparent"
                  : "border-rh-red/20 bg-gradient-to-br from-rh-red/10 to-transparent"
              ),
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-base font-semibold text-rh-white">
                    {p.symbol0}/{p.symbol1}
                  </h4>
                  <span
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px] font-bold",
                      p.protocol === "v4"
                        ? "bg-rh-neon/15 text-rh-neon"
                        : "bg-rh-elevated text-rh-soft",
                    )}
                  >
                    {(p.protocol ?? "v3").toUpperCase()}
                  </span>
                  <span className="rounded-md bg-rh-elevated px-2 py-0.5 text-[11px] font-medium text-rh-soft">
                    {feeTierLabel(p.fee)}
                  </span>
                  <span
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px] font-semibold",
                      p.isOpen
                        ? "bg-rh-green/15 text-rh-green"
                        : "bg-rh-elevated text-rh-muted",
                    )}
                  >
                    {p.isOpen ? "Open" : "Closed"}
                  </span>
                  {p.isOpen && p.inRange != null && (
                    <span
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[11px] font-semibold",
                        p.inRange
                          ? "bg-rh-green/10 text-rh-green"
                          : "bg-rh-red/10 text-rh-red",
                      )}
                    >
                      {p.inRange ? "In range" : "Out of range"}
                    </span>
                  )}
                  {p.hasCustomHook && (
                    <span
                      className="rounded-md bg-rh-red/15 px-2 py-0.5 text-[10px] font-semibold text-rh-red"
                      title="Pool has a custom Uniswap V4 hook — fee/PnL may be less precise"
                    >
                      ⚠ Custom Hook
                    </span>
                  )}
                  {p.costBasisEstimated && (
                    <span className="rounded-md bg-rh-elevated px-2 py-0.5 text-[10px] text-rh-muted">
                      no cost basis
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-rh-muted">
                  NFT #{p.tokenId}
                  {p.poolAddress && (
                    <> · Pool {shortAddress(p.poolAddress)}</>
                  )}
                </p>
              </div>

              <div className="text-right">
                <p
                  className={cn(
                    "text-xl font-bold tabular-nums",
                    net >= 0 ? "text-rh-green" : "text-rh-red",
                  )}
                >
                  {formatSigned(net, currency)}
                </p>
                <p className="text-xs text-rh-muted">{formatPct(pct)}</p>
              </div>
            </div>

            <div
              className={cn(
                "mt-3 grid gap-2 text-xs",
                compact
                  ? "grid-cols-2 sm:grid-cols-3"
                  : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
              )}
            >
              <Stat
                label="Deposit"
                value={
                  p.costBasisEstimated || dep === 0
                    ? "—"
                    : formatSigned(dep, currency).replace(/^\+/, "")
                }
              />
              {!p.isOpen ? (
                <Stat
                  label="Withdrawn"
                  value={formatSigned(
                    currency === "usd"
                      ? (p.withdrawnUsd ?? 0)
                      : (p.withdrawnEth ?? 0),
                    currency,
                  ).replace(/^\+/, "")}
                />
              ) : (
                <Stat
                  label="Current"
                  value={formatSigned(cur, currency).replace(/^\+/, "")}
                />
              )}
              <Stat
                label="Claimed fees"
                value={formatSigned(
                  currency === "usd"
                    ? (p.feesCollectedUsd ?? 0)
                    : (p.feesCollectedEth ?? 0),
                  currency,
                )}
              />
              {p.isOpen && (
                <Stat
                  label="Unclaimed"
                  value={formatSigned(
                    currency === "usd"
                      ? (p.unclaimedFeesUsd ?? 0)
                      : (p.unclaimedFeesEth ?? 0),
                    currency,
                  )}
                />
              )}
              {!compact && (
                <>
                  <Stat label="Fee PnL" value={formatSigned(fee, currency)} />
                  <Stat
                    label={p.costBasisEstimated ? "Net*" : "Price / IL"}
                    value={
                      p.costBasisEstimated
                        ? formatSigned(net, currency)
                        : formatSigned(price, currency)
                    }
                  />
                </>
              )}
            </div>
            {p.costBasisEstimated && (
              <p className="mt-2 text-[10px] text-rh-red/80">
                Cost basis not found yet — deposit/history may still be loading.
              </p>
            )}
            {p.historyPending && (
              <p className="mt-1 text-[10px] text-rh-cyan/90">
                Closed history pending background index…
              </p>
            )}

            <div className="mt-3 flex justify-end">
              <a
                href={p.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-rh-green/90 hover:text-rh-neon"
              >
                View on explorer <ExternalLink className="h-3 w-3" />
              </a>
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
