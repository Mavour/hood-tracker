import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { parseWatchlist, readWatcherConfig } from "./config";
import { WatcherState, type WatchPosition, type ProtocolResult } from "./state";
import { createCollector, type CollectorDependencies } from "./collector";
import { createWatcherServer } from "./http";
import type { LivePosition } from "../chain/positions";

const address = "0x1111111111111111111111111111111111111111";
const second = "0x2222222222222222222222222222222222222222";
const wallet = { address, label: "Fixture" };
const position = (id = "4663:manager:1"): WatchPosition => ({
  id, pair: "A/B", protocol: "Uniswap v3", walletAddress: address,
  rangeLow: 1, rangeHigh: 2, price: 1.5, inRange: true,
  valueUsd: 100, feesEarnedUsd: 2, unrealizedPnlUsd: null,
  ilPct: null, openedAt: null, updatedAt: new Date().toISOString(), feesEstimated: true,
});
const live: LivePosition = {
  tokenId: 1n, token0: address, token1: second, liquidity: 1n,
  tickLower: -10, tickUpper: 10, decimals0: 18, decimals1: 18,
  symbol0: "A", symbol1: "B", sqrtPriceX96: 2n ** 96n,
  amount0Human: 1, amount1Human: 1, unclaimed0Human: 0.1, unclaimed1Human: 0.1,
  inRange: true, owner: address, poolAddress: second, fee: 500,
  feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n, tokensOwed1: 0n, currentTick: 0,
  amount0: 1n, amount1: 1n, unclaimed0: 0n, unclaimed1: 0n,
};
const deps = (): CollectorDependencies => ({
  manager: (p) => p === "v3" ? address : second,
  balance: async (manager) => manager === address ? 1n : 0n,
  ids: async () => [1n], owner: async () => address,
  live: async () => live,
  value: async (a, b) => ({ usd: a + b, eth: 0, pricingIncomplete: false }),
  now: Date.now,
});

test("watchlist persists through JSON config; deduplicates address case and preserves labels", () => {
  const mixed = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const wallets = parseWatchlist(JSON.stringify([{ address: mixed.toUpperCase().replace("0X", "0x"), label: "Main" }, mixed]));
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].address, mixed);
  assert.equal(wallets[0].label, "Main");
  assert.throws(() => parseWatchlist('["private-key"]'));
  assert.throws(() => parseWatchlist('{}'));
});

test("disabled by default; enabled worker requires wallets, strong API key and valid interval", () => {
  assert.equal(readWatcherConfig({}).enabled, false);
  assert.throws(() => readWatcherConfig({ LP_WATCHER_ENABLED: "true" }));
  assert.throws(() => readWatcherConfig({ LP_WATCH_INTERVAL_SECONDS: "1" }));
  assert.throws(() => readWatcherConfig({ LP_WATCHER_PORT: "NaN" }));
  const config = readWatcherConfig({ LP_WATCHER_ENABLED: "true", LP_WATCHLIST: JSON.stringify([address]), LP_WATCHER_API_KEY: "fixture-key-123456" });
  assert.equal(config.port, 9003);
  assert.equal(config.host, "127.0.0.1");
});

test("collector verifies balance and owner, identifies NFTs by manager, leaves unverified history null", async () => {
  const result = await createCollector(deps())(wallet);
  const p = result[0].positions![0];
  assert.equal(p.id, `4663:${address}:1`);
  assert.equal(p.valueUsd, 2.2);
  assert.equal(p.price, 1);
  assert.equal(p.unrealizedPnlUsd, null);
  assert.equal(p.ilPct, null);
  assert.deepEqual(result[1].positions, []);
});

test("incomplete discovery and ownership changes fail only the affected protocol", async () => {
  for (const d of [{ ...deps(), ids: async () => [] }, { ...deps(), owner: async () => second }]) {
    const result = await createCollector(d)(wallet);
    assert.ok(result[0].error);
    assert.deepEqual(result[1].positions, []);
  }
});

test("pool read failure cannot become out-of-range or zero-valued position", async () => {
  const result = await createCollector({ ...deps(), live: async () => ({ ...live, sqrtPriceX96: 0n }) })(wallet);
  assert.ok(result[0].error);
  assert.equal(result[0].positions, undefined);
});

test("missing USD prices stay null; closed NFTs are omitted", async () => {
  const result = await createCollector({ ...deps(), value: async () => ({ usd: 0, eth: 0, pricingIncomplete: true }) })(wallet);
  assert.equal(result[0].positions![0].valueUsd, null);
  assert.equal(result[0].positions![0].feesEarnedUsd, null);
  const closed = await createCollector({ ...deps(), live: async () => ({ ...live, liquidity: 0n }) })(wallet);
  assert.deepEqual(closed[0].positions, []);
});

test("refreshes never overlap, and all wallets are visited sequentially", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const visited: string[] = [];
  const state = new WatcherState([wallet, { address: second, label: "Second" }], 60_000, async (w) => {
    visited.push(w.address); await gate;
    return [{ protocol: "v3", positions: [] }, { protocol: "v4", positions: [] }];
  });
  const first = state.refresh();
  assert.equal(first, state.refresh());
  assert.deepEqual(visited, [address]);
  release(); await first;
  assert.deepEqual(visited, [address, second]);
});

test("failed wallet retains last good positions while other wallets continue; recovered empty scan removes closed LPs", async () => {
  let failed = false;
  let empty = false;
  let count = 0;
  const state = new WatcherState([wallet, { address: second, label: "Second" }], 60_000, async (w) => {
    count++;
    if (failed && w.address === address) throw new Error("secret RPC URL");
    return [{ protocol: "v3", positions: w.address === address && !empty ? [position()] : [] }, { protocol: "v4", positions: [] }];
  });
  await state.refresh(); failed = true; await state.refresh();
  const snapshot = state.snapshot();
  assert.equal(count, 4);
  assert.equal(snapshot.metrics.positions.length, 1);
  assert.equal(snapshot.metrics.positions[0].stale, true);
  assert.equal(snapshot.status, "warn");
  assert.equal(snapshot.metrics.totalsComplete.valueUsd, false);
  assert.ok(!JSON.stringify(snapshot).includes("secret RPC"));
  failed = false; empty = true; await state.refresh();
  assert.equal(state.snapshot().metrics.positions.length, 0);
});

test("a transferred NFT is counted once across watched wallets", async () => {
  const state = new WatcherState([wallet, { address: second, label: "Second" }], 60_000, async () => [
    { protocol: "v3", positions: [position()] }, { protocol: "v4", positions: [] },
  ]);
  await state.refresh();
  assert.equal(state.snapshot().metrics.positions.length, 1);
  assert.equal(state.snapshot().metrics.totals.valueUsd, 100);
});

test("stale heartbeat and unknown PnL are explicitly represented", async () => {
  let now = Date.now();
  const state = new WatcherState([wallet], 60_000, async () => [
    { protocol: "v3", positions: [position()] }, { protocol: "v4", positions: [] },
  ], () => now);
  await state.refresh();
  assert.equal(state.snapshot().metrics.totalsComplete.unrealizedPnlUsd, false);
  const at = state.snapshot().updatedAt;
  now += 181_000;
  assert.equal(state.snapshot().status, "warn");
  assert.equal(state.snapshot().updatedAt, at);
});

test("authenticated HTTP serves memory only, rejects writes and hides wallet data on health", async () => {
  let reads = 0;
  const results: ProtocolResult[] = [{ protocol: "v3", positions: [position()] }, { protocol: "v4", positions: [] }];
  const state = new WatcherState([wallet], 60_000, async () => { reads++; return results; });
  await state.refresh();
  const server = createWatcherServer(state, "fixture-key-123456");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${url}/status`)).status, 401);
    assert.equal((await fetch(`${url}/status`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const health = await (await fetch(`${url}/health`)).text();
    assert.ok(!health.includes(address));
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${url}/status`, { headers: { Authorization: "Bearer fixture-key-123456" } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).metrics.positions.length, 1);
    }
    assert.equal((await fetch(`${url}/status`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${url}/missing`)).status, 404);
    assert.equal(reads, 1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
