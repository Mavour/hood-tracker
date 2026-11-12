import type { WatchedWallet } from "./config";

export type Protocol = "v3" | "v4";
export type WatchPosition = {
  id: string; pair: string; protocol: string; walletAddress: string;
  rangeLow: number | null; rangeHigh: number | null; price: number | null;
  inRange: boolean | null; valueUsd: number | null; feesEarnedUsd: number | null;
  unrealizedPnlUsd: number | null; ilPct: null; openedAt: null;
  updatedAt: string; feesEstimated: boolean;
};
export type ProtocolResult = { protocol: Protocol; positions?: WatchPosition[]; error?: string };
type Entry = { positions: WatchPosition[]; updatedAt: string | null; error: string | null };

/** Only the background worker mutates this state. HTTP reads never perform RPC. */
export class WatcherState {
  private entries = new Map<string, Entry>();
  private active: Promise<void> | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: string;

  constructor(readonly wallets: WatchedWallet[], readonly intervalMs: number,
    private collect: (wallet: WatchedWallet) => Promise<ProtocolResult[]>,
    private now = () => Date.now()) {
    this.heartbeat = new Date(now()).toISOString();
    for (const w of wallets) for (const p of ["v3", "v4"]) {
      this.entries.set(`${w.address}:${p}`, { positions: [], updatedAt: null, error: null });
    }
  }

  refresh(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.cycle().finally(() => { this.active = null; });
    return this.active;
  }

  private async cycle() {
    for (const wallet of this.wallets) {
      if (this.stopped) break;
      let results: ProtocolResult[];
      try { results = await this.collect(wallet); }
      catch { results = []; }
      const ts = new Date(this.now()).toISOString();
      for (const protocol of ["v3", "v4"] as const) {
        const entry = this.entries.get(`${wallet.address}:${protocol}`)!;
        const result = results.find((r) => r.protocol === protocol);
        if (!result || result.error || !result.positions) {
          // Keep the last successful snapshot: an RPC failure is not an empty wallet.
          entry.error = result?.error || "Wallet refresh failed";
        } else {
          entry.positions = result.positions;
          entry.updatedAt = ts;
          entry.error = null;
        }
      }
      this.heartbeat = ts;
    }
  }

  start() {
    this.stopped = false;
    const tick = async () => {
      await this.refresh();
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
    };
    void tick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }

  snapshot() {
    const now = this.now();
    const ts = new Date(now).toISOString();
    const maxAge = Math.max(this.intervalMs * 3, 180_000);
    const positions = new Map<string, WatchPosition & { stale: boolean }>();
    const alerts: Array<{ id: string; level: "info" | "warn"; message: string; ts: string }> = [];
    const wallets = this.wallets.map((wallet) => {
      const protocols = (["v3", "v4"] as const).map((protocol) => {
        const entry = this.entries.get(`${wallet.address}:${protocol}`)!;
        const stale = !!entry.error || !entry.updatedAt || now - Date.parse(entry.updatedAt) > maxAge;
        if (stale) alerts.push({ id: `${wallet.address}:${protocol}`, level: "warn", message: `${wallet.label} ${protocol}: ${entry.error || (entry.updatedAt ? "data stale" : "waiting for first scan")}`, ts: entry.updatedAt || this.heartbeat });
        for (const p of entry.positions) {
          const existing = positions.get(p.id);
          // NFT ids include chain + manager + token id; never double-count transfers.
          if (!existing || (existing.stale && !stale) || (existing.stale === stale && Date.parse(p.updatedAt) > Date.parse(existing.updatedAt))) {
            positions.set(p.id, { ...p, stale });
          }
        }
        return { protocol, updatedAt: entry.updatedAt, stale, error: entry.error };
      });
      return { ...wallet, protocols };
    });
    const rows = [...positions.values()];
    const sum = (key: "valueUsd" | "feesEarnedUsd" | "unrealizedPnlUsd") => rows.reduce((n, p) => n + (p[key] ?? 0), 0);
    const complete = !alerts.length && this.wallets.length > 0;
    const totalsComplete = {
      valueUsd: complete && rows.every((p) => p.valueUsd !== null),
      // Current fees are conservative estimates of unclaimed fees, not lifetime earnings.
      feesEarnedUsd: complete && rows.length === 0,
      unrealizedPnlUsd: complete && rows.every((p) => p.unrealizedPnlUsd !== null),
      positions: complete,
    };
    if (!this.wallets.length) alerts.push({ id: "no-wallets", level: "warn", message: "Configure LP_WATCHLIST", ts });
    if (rows.some((p) => p.valueUsd === null)) alerts.push({ id: "pricing", level: "warn", message: "Some positions have no reliable USD price; totals are known subtotals", ts: this.heartbeat });
    if (rows.length) alerts.push({ id: "estimates", level: "info", message: "Fees: estimated unclaimed subtotal. PnL, IL and opening time unavailable without verified history.", ts: this.heartbeat });
    return {
      agentId: "lpwatcher", status: alerts.some((a) => a.level === "warn") ? "warn" : "ok",
      updatedAt: this.heartbeat, headline: `${this.wallets.length} wallets • ${rows.length} open LP positions`,
      metrics: {
        wallet: `${this.wallets.length} Robinhood wallets`, chainId: 4663, wallets,
        totals: { valueUsd: sum("valueUsd"), feesEarnedUsd: sum("feesEarnedUsd"), unrealizedPnlUsd: sum("unrealizedPnlUsd"),
          positionsInRange: rows.filter((p) => p.inRange === true).length,
          positionsOutOfRange: rows.filter((p) => p.inRange === false).length },
        totalsComplete, totalsAreKnownSubtotals: true, feesBasis: "estimated-unclaimed-only",
        positions: rows,
      }, alerts, events: [],
    };
  }
}
