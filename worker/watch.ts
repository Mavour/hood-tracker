import { loadEnvConfig } from "@next/env";
import { readWatcherConfig } from "../src/lib/watcher/config";
import { WatcherState } from "../src/lib/watcher/state";
import { createWatcherServer } from "../src/lib/watcher/http";

async function main() {
  Object.assign(process.env, { NODE_ENV: process.env.NODE_ENV || "production" });
  loadEnvConfig(process.cwd());
  let config: ReturnType<typeof readWatcherConfig>;
  try { config = readWatcherConfig(process.env); }
  catch {
    console.error("[lp-watcher] Invalid configuration. Check public wallet list, API key, port and interval.");
    process.exitCode = 2;
    return;
  }
  if (!config.enabled) {
    console.log("[lp-watcher] Disabled. Configure watchlist/API key and set LP_WATCHER_ENABLED=true.");
    return;
  }
  const { createCollector } = await import("../src/lib/watcher/collector");
  const state = new WatcherState(config.wallets, config.intervalMs, createCollector());
  const server = createWatcherServer(state, config.key);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  state.start();
  console.log(`[lp-watcher] Watching ${config.wallets.length} wallets. Read-only API on port ${config.port}.`);
  const stop = () => {
    server.close();
    void state.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => {
  console.error("[lp-watcher] Startup failed. Check LP_WATCHER_* settings and port availability.");
  process.exitCode = 1;
});
