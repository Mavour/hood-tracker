import { isAddress } from "viem";

export type WatchedWallet = { address: string; label: string };

export function parseWatchlist(raw = "[]"): WatchedWallet[] {
  const input: unknown = JSON.parse(raw);
  if (!Array.isArray(input)) throw new Error("LP_WATCHLIST must be a JSON array");
  const wallets = new Map<string, WatchedWallet>();
  for (const item of input) {
    const address = typeof item === "string" ? item : item?.address;
    if (typeof address !== "string" || !isAddress(address, { strict: false })) {
      throw new Error("LP_WATCHLIST contains an invalid public EVM address");
    }
    const key = address.toLowerCase();
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (!wallets.has(key)) wallets.set(key, { address: key, label: label.slice(0, 60) || `${key.slice(0, 6)}…${key.slice(-4)}` });
  }
  return [...wallets.values()];
}

export function readWatcherConfig(env: Record<string, string | undefined>) {
  const enabled = env.LP_WATCHER_ENABLED === "true";
  const wallets = parseWatchlist(env.LP_WATCHLIST);
  const key = env.LP_WATCHER_API_KEY?.trim() ?? "";
  const port = Number(env.LP_WATCHER_PORT ?? 9003);
  const intervalMs = Number(env.LP_WATCH_INTERVAL_SECONDS ?? 60) * 1000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid LP_WATCHER_PORT");
  if (!Number.isFinite(intervalMs) || intervalMs < 30_000) throw new Error("LP_WATCH_INTERVAL_SECONDS must be at least 30");
  if (enabled && (!wallets.length || key.length < 16)) throw new Error("Configure LP_WATCHLIST and LP_WATCHER_API_KEY (at least 16 characters) before enabling");
  return { enabled, wallets, key, port, intervalMs, host: env.LP_WATCHER_HOST?.trim() || "127.0.0.1" };
}
