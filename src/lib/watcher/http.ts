import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { WatcherState } from "./state";

export function createWatcherServer(state: WatcherState, key: string) {
  if (key.length < 16) throw new Error("LP Watcher API key must have at least 16 characters");
  const expected = Buffer.from(`Bearer ${key}`);
  return createServer((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const send = (code: number, body: unknown) => { res.writeHead(code); res.end(JSON.stringify(body)); };
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return send(405, { error: "Method not allowed" }); }
    const path = req.url?.split("?")[0];
    if (path === "/health") return send(200, { ok: true, service: "hood-lp-watcher" });
    if (path !== "/status") return send(404, { error: "Not found" });
    const received = Buffer.from(req.headers.authorization || "");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return send(401, { error: "Unauthorized" });
    return send(200, state.snapshot());
  });
}
