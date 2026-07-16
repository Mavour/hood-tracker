"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, ArrowLeft } from "lucide-react";
import Link from "next/link";
import {
  formatPct,
  formatSigned,
  shortAddress,
} from "@/lib/utils";
import { CurrencyToggle, type Currency } from "./CurrencyToggle";
import { PnlCalendar, type DayPnl } from "./PnlCalendar";
import { DayDetailModal } from "./DayDetailModal";
import { PositionList, type PositionRow } from "./PositionList";
import { LiveOpenPositions } from "./LiveOpenPositions";
import { Button } from "./ui/button";

type Summary = {
  netPnlUsd: number;
  netPnlEth: number;
  feePnlUsd: number;
  feePnlEth: number;
  pricePnlUsd: number;
  pricePnlEth: number;
  depositUsd: number;
  depositEth: number;
  currentValueUsd: number;
  currentValueEth: number;
  unclaimedFeesUsd: number;
  unclaimedFeesEth: number;
  realizedPnlUsd?: number;
  realizedPnlEth?: number;
  unrealizedPnlUsd?: number;
  unrealizedPnlEth?: number;
  totalPnlUsd?: number;
  totalPnlEth?: number;
  openCount: number;
  closedCount: number;
  pnlPctUsd: number | null;
  pnlPctEth: number | null;
};

type JobStatus = {
  status?: string;
  progress?: number;
  progressMessage?: string;
  errorMessage?: string;
  jobId?: string;
};

export function Dashboard({ address }: { address: string }) {
  const [currency, setCurrency] = useState<Currency>("usd");
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [daily, setDaily] = useState<DayPnl[]>([]);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<DayPnl | null>(null);
  const [liveUnrealized, setLiveUnrealized] = useState<{
    usd: number;
    eth: number;
  } | null>(null);

  /** Bumps on unmount / new track so stale polls stop. */
  const genRef = useRef(0);

  const loadPnl = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/pnl/${address}`, { cache: "no-store" });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.ready) {
        setSummary(data.summary);
        setPositions(data.positions ?? []);
        setDaily(data.daily ?? []);
        setComputedAt(data.computedAt);
        setLoading(false);
        setIndexing(false);
        setError(null);
        // Soft banner while phase-2 backfill runs
        if (
          typeof data.progressMessage === "string" &&
          /backfill|background|history|closed|enrich|stubs/i.test(
            data.progressMessage,
          )
        ) {
          setProgressMsg(data.progressMessage);
        } else if (
          data.phase === "fast" ||
          (Array.isArray(data.positions) &&
            data.positions.some((p: { historyPending?: boolean }) => p.historyPending))
        ) {
          setProgressMsg("History for closed positions loading in background…");
        } else if (data.progress != null && Number(data.progress) < 100) {
          setProgressMsg(String(data.progressMessage || "Finishing history…"));
        } else {
          setProgressMsg("");
        }
        return true;
      }
      if (data.progress != null) setProgress(Number(data.progress) || 0);
      if (data.progressMessage) setProgressMsg(String(data.progressMessage));
      if (data.status === "error" && data.errorMessage) {
        setError(String(data.errorMessage));
      }
      return false;
    } catch {
      return false;
    }
  }, [address]);

  /** Always poll by address (source of truth). jobId is optional hint only. */
  const fetchJobStatus = useCallback(async (): Promise<JobStatus | null> => {
    try {
      const res = await fetch(
        `/api/track?address=${encodeURIComponent(address)}`,
        { cache: "no-store" },
      );
      // API always returns 200 for known query shapes; treat non-ok as soft fail
      if (!res.ok) return null;
      return (await res.json()) as JobStatus;
    } catch {
      return null;
    }
  }, [address]);

  const runTrack = useCallback(
    async (force: boolean, gen: number) => {
      setError(null);
      setIndexing(true);
      setLoading(true);
      setProgress(0);
      setProgressMsg("Starting…");

      try {
        const res = await fetch("/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, force }),
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (gen !== genRef.current) return;

        if (!res.ok) {
          setError(
            (data as { error?: string }).error ??
              `Track failed (${res.status})`,
          );
          setIndexing(false);
          setLoading(false);
          return;
        }

        if (data.status === "ready") {
          await loadPnl();
          return;
        }

        setProgress(Number(data.progress) || 0);
        setProgressMsg(
          String(data.progressMessage ?? "Indexing LP positions…"),
        );

        // Poll by address only — never depend on ephemeral jobId memory
        for (let i = 0; i < 240; i++) {
          if (gen !== genRef.current) return;
          await new Promise((r) => setTimeout(r, 1500));
          if (gen !== genRef.current) return;

          const jd = await fetchJobStatus();
          if (gen !== genRef.current) return;

          if (jd) {
            if (jd.progress != null) setProgress(Number(jd.progress) || 0);
            if (jd.progressMessage) setProgressMsg(String(jd.progressMessage));

            if (jd.status === "ready") {
              await loadPnl();
              // Don't stop early while phase-2 backfill is still running
              const msg = String(jd.progressMessage ?? "");
              const pct = Number(jd.progress) || 0;
              const stillBg =
                pct < 100 ||
                /backfill|background|history|closed|enrich/i.test(msg);
              if (!stillBg) return;
              // keep polling so closed history lands in UI
              continue;
            }
            if (jd.status === "error") {
              setError(jd.errorMessage ?? "Indexing failed");
              setIndexing(false);
              setLoading(false);
              return;
            }
            // Stuck on pre-fix full-chain scanner — auto restart fast path
            if (
              jd.status === "stale" ||
              (typeof jd.progressMessage === "string" &&
                jd.progressMessage.includes("Scanning transfers blocks"))
            ) {
              setProgressMsg("Cancelling old scan — starting fast indexer…");
              if (gen !== genRef.current) return;
              const nextGen = ++genRef.current;
              // Re-enter with force (new generation cancels old server job)
              void (async () => {
                await runTrack(true, nextGen);
              })();
              return;
            }
          }

          const ready = await loadPnl();
          if (ready) return;
        }

        if (gen !== genRef.current) return;
        setError("Indexing timed out — try Refresh");
        setIndexing(false);
        setLoading(false);
      } catch (e) {
        if (gen !== genRef.current) return;
        setError(e instanceof Error ? e.message : "Network error");
        setIndexing(false);
        setLoading(false);
      }
    },
    [address, loadPnl, fetchJobStatus],
  );

  useEffect(() => {
    const gen = ++genRef.current;
    void runTrack(false, gen);
    return () => {
      // Invalidate in-flight polls when address changes or Strict Mode remounts
      genRef.current += 1;
    };
  }, [address, runTrack]);

  // After first ready, keep polling cache so phase-2 closed history appears
  useEffect(() => {
    if (!summary || !computedAt) return;
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      void loadPnl();
      // ~5 min @ 4s — enough for 30 closed NFTs with Alchemy
      if (n >= 75) clearInterval(id);
    }, 4_000);
    return () => clearInterval(id);
  }, [summary, computedAt, loadPnl]);

  const onRefresh = () => {
    const gen = ++genRef.current;
    void runTrack(true, gen);
  };

  const realized =
    summary &&
    (currency === "usd"
      ? (summary.realizedPnlUsd ?? 0)
      : (summary.realizedPnlEth ?? 0));
  const unrealizedBase =
    summary &&
    (currency === "usd"
      ? (summary.unrealizedPnlUsd ?? 0)
      : (summary.unrealizedPnlEth ?? 0));
  const unrealizedLive =
    liveUnrealized != null
      ? currency === "usd"
        ? liveUnrealized.usd
        : liveUnrealized.eth
      : null;
  const unrealized = unrealizedLive ?? unrealizedBase ?? 0;
  const net =
    summary &&
    (realized ?? 0) + unrealized;
  const fee =
    summary &&
    (currency === "usd" ? summary.feePnlUsd : summary.feePnlEth);
  const price =
    summary &&
    (currency === "usd" ? summary.pricePnlUsd : summary.pricePnlEth);
  const dep =
    summary &&
    (currency === "usd" ? summary.depositUsd : summary.depositEth);
  const cur =
    summary &&
    (currency === "usd" ? summary.currentValueUsd : summary.currentValueEth);
  const pct =
    summary && dep && dep > 1e-9 && net != null
      ? (net / dep) * 100
      : summary
        ? currency === "usd"
          ? summary.pnlPctUsd
          : summary.pnlPctEth
        : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="icon" className="border border-white/10 bg-rh-elevated/50">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-rh-muted">
              Wallet
            </p>
            <p className="mt-0.5 font-mono text-sm font-medium text-rh-white sm:text-[15px]">
              <span className="hidden sm:inline">{address}</span>
              <span className="sm:hidden">{shortAddress(address)}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CurrencyToggle value={currency} onChange={setCurrency} />
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            disabled={indexing}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${indexing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rh-red/40 bg-rh-red/10 px-4 py-3 text-sm text-rh-red">
          <p className="font-medium">Could not finish indexing</p>
          <p className="mt-1 whitespace-pre-wrap text-rh-red/80">{error}</p>
          {(error.includes("fetch failed") ||
            error.includes("HTTP request failed") ||
            error.includes("Timeout")) && (
            <p className="mt-2 text-xs text-rh-red/80">
              RPC unreachable. Set{" "}
              <code className="rounded bg-rh-elevated px-1">ALCHEMY_API_KEY</code>{" "}
              or{" "}
              <code className="rounded bg-rh-elevated px-1">
                ROBINHOOD_CHAIN_RPC
              </code>{" "}
              in <code className="rounded bg-rh-elevated px-1">.env</code>, then
              restart <code className="rounded bg-rh-elevated px-1">npm run dev</code>
              .
            </p>
          )}
        </div>
      )}

      {(loading || indexing) && !summary && (
        <div className="rh-card-glow mb-8 p-8">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-rh-neon/15">
              <RefreshCw className="h-4 w-4 animate-spin text-rh-neon" />
            </span>
            <div>
              <p className="text-sm font-semibold text-rh-white">
                Scanning open liquidity…
              </p>
              <p className="text-xs text-rh-muted">{progressMsg || "Connecting"}</p>
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-rh-elevated">
            <div
              className="h-full rounded-full bg-gradient-to-r from-rh-neon to-rh-green transition-all duration-500"
              style={{ width: `${Math.max(progress, 8)}%` }}
            />
          </div>
          <p className="mt-3 text-right font-mono text-[11px] text-rh-muted">
            {Math.round(progress)}% · first paint target &lt;10s
          </p>
        </div>
      )}

      {summary && progressMsg && progressMsg.includes("background") && (
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-rh-cyan/20 bg-rh-cyan/5 px-4 py-2.5 text-xs text-rh-cyan">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rh-cyan" />
          {progressMsg}
        </div>
      )}

      {summary && (
        <>
          <div className="relative mb-8 overflow-hidden rounded-[1.75rem] border border-white/10 bg-gradient-to-br from-[#161a24] via-[#101218] to-[#0a0c12] p-6 shadow-glass sm:p-8">
            <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-rh-neon/15 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-16 left-1/4 h-40 w-40 rounded-full bg-rh-violet/20 blur-3xl" />
            <div className="relative flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/robinhood.png"
                  alt=""
                  className="h-11 w-11 rounded-xl shadow-neon ring-1 ring-rh-neon/30"
                />
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rh-muted">
                    Total LP PNL
                  </p>
                  <p className="text-xs text-rh-soft/70">Robinhood PNL LP Viewer</p>
                </div>
              </div>
              {liveUnrealized != null && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-rh-green/30 bg-rh-green/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-rh-green">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rh-green" />
                  Live
                </span>
              )}
            </div>
            <p
              className={`relative mt-4 text-5xl font-black tabular-nums tracking-tight sm:text-6xl ${
                (net ?? 0) >= 0 ? "text-rh-green" : "text-rh-red"
              }`}
            >
              {formatSigned(net ?? 0, currency)}
            </p>
            <p className="relative mt-2 text-lg font-semibold text-rh-soft">
              {formatPct(pct ?? null)}
            </p>

            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Mini
                label="Realized (closed)"
                value={formatSigned(realized ?? 0, currency)}
                hint="Withdraw + fees − deposit on closed NFTs"
              />
              <Mini
                label="Unrealized (open)"
                value={formatSigned(unrealized, currency)}
                hint="Paper PnL on open liquidity"
                accent
              />
              <Mini
                label="Total"
                value={formatSigned(net ?? 0, currency)}
                hint="Realized + unrealized"
              />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Mini
                label="Deposits"
                value={formatSigned(dep ?? 0, currency).replace(/^\+/, "")}
              />
              <Mini
                label="Open value"
                value={formatSigned(cur ?? 0, currency).replace(/^\+/, "")}
              />
              <Mini
                label="Fee PnL"
                value={formatSigned(fee ?? 0, currency)}
              />
              <Mini
                label="Price / IL"
                value={formatSigned(price ?? 0, currency)}
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-4 text-xs text-rh-muted">
              <span>{summary.openCount} open</span>
              <span>{summary.closedCount} closed</span>
              {computedAt && (
                <span>Indexed {new Date(computedAt).toLocaleString()}</span>
              )}
            </div>
          </div>

          {/* Split: calendar | open positions */}
          <section className="mb-10 grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start">
            <div className="lg:col-span-5">
              <div className="mb-3 flex items-end justify-between gap-2">
                <h2 className="text-base font-semibold tracking-tight text-rh-white sm:text-lg">
                  PNL calendar
                </h2>
                <span className="text-[10px] font-medium text-rh-muted">
                  month view
                </span>
              </div>
              <PnlCalendar
                daily={daily}
                currency={currency}
                onSelectDay={setSelectedDay}
                compact
              />
            </div>

            <div className="lg:col-span-7">
              <div className="mb-3 flex items-end justify-between gap-2">
                <h2 className="text-base font-semibold tracking-tight text-rh-white sm:text-lg">
                  Open positions
                  <span className="ml-2 text-sm font-normal text-rh-muted">
                    ({positions.filter((p) => p.isOpen).length})
                  </span>
                </h2>
                <span className="text-[10px] font-medium text-rh-muted">
                  live · 15s
                </span>
              </div>
              <div className="max-h-[min(70vh,560px)] overflow-y-auto pr-1">
                <div className="mb-2 flex items-center gap-2 text-[11px] text-rh-muted">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rh-green opacity-50" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-rh-green" />
                  </span>
                  Live totals refresh every 15s · list from last index
                </div>
                <LiveOpenPositions
                  address={address}
                  currency={currency}
                  onTotals={(t) => {
                    if (!t) return;
                    setLiveUnrealized({
                      usd: t.unrealizedPnlUsd,
                      eth: t.unrealizedPnlEth,
                    });
                    if (summary) {
                      setSummary({
                        ...summary,
                        currentValueUsd: t.openValueUsd,
                        currentValueEth: t.openValueEth,
                        unrealizedPnlUsd: t.unrealizedPnlUsd,
                        unrealizedPnlEth: t.unrealizedPnlEth,
                      });
                    }
                  }}
                />
              </div>
            </div>
          </section>

          {/* Closed positions — full section */}
          <section className="mb-6">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-base font-semibold tracking-tight text-rh-white sm:text-lg">
                Closed positions
                <span className="ml-2 text-sm font-normal text-rh-muted">
                  ({positions.filter((p) => !p.isOpen).length})
                </span>
              </h2>
              <span className="text-[10px] font-medium text-rh-muted">
                realized PnL · history may load in background
              </span>
            </div>
            <PositionList
              positions={positions.filter((p) => !p.isOpen)}
              currency={currency}
              emptyText="No closed LP NFTs yet — or history still indexing in the background. Hit Refresh after a minute."
            />
          </section>
        </>
      )}

      {selectedDay && (
        <DayDetailModal
          day={selectedDay}
          currency={currency}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </div>
  );
}

function Mini({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: string;
  accent?: boolean;
  hint?: string;
}) {
  return (
    <div className="rh-stat px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-rh-muted">
        {label}
      </p>
      <p
        className={`mt-1.5 font-mono text-sm font-bold tabular-nums ${
          accent ? "text-rh-neon" : "text-rh-white"
        }`}
      >
        {value}
      </p>
      {hint && (
        <p className="mt-1 text-[10px] leading-snug text-rh-muted/90">{hint}</p>
      )}
    </div>
  );
}
