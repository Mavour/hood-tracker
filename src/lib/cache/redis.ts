/**
 * Redis client with in-memory fallback.
 */

import Redis from "ioredis";

let redis: Redis | null = null;
let memoryOnly = false;
const mem = new Map<string, { value: string; expiresAt: number }>();

export function getRedis(): Redis | null {
  if (memoryOnly) return null;
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    memoryOnly = true;
    return null;
  }
  try {
    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    redis.on("error", (err) => {
      console.warn("[redis]", err.message);
    });
    return redis;
  } catch {
    memoryOnly = true;
    return null;
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (r) {
    try {
      if (r.status !== "ready") await r.connect().catch(() => null);
      return await r.get(key);
    } catch {
      /* fall through */
    }
  }
  const hit = mem.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    mem.delete(key);
    return null;
  }
  return hit.value;
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      if (r.status !== "ready") await r.connect().catch(() => null);
      await r.set(key, value, "EX", ttlSeconds);
      return;
    } catch {
      /* fall through */
    }
  }
  mem.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function cacheDel(key: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.del(key);
    } catch {
      /* ignore */
    }
  }
  mem.delete(key);
}

/** Simple sliding rate limit: returns true if allowed */
export async function rateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const r = getRedis();
  const rk = `rl:${key}`;
  if (r) {
    try {
      if (r.status !== "ready") await r.connect().catch(() => null);
      const n = await r.incr(rk);
      if (n === 1) await r.expire(rk, windowSeconds);
      return { allowed: n <= max, remaining: Math.max(0, max - n) };
    } catch {
      /* fall through */
    }
  }
  const raw = mem.get(rk);
  let count = 0;
  if (raw && raw.expiresAt > Date.now()) {
    count = Number(raw.value) || 0;
  }
  count += 1;
  mem.set(rk, {
    value: String(count),
    expiresAt: raw?.expiresAt && raw.expiresAt > Date.now()
      ? raw.expiresAt
      : Date.now() + windowSeconds * 1000,
  });
  return { allowed: count <= max, remaining: Math.max(0, max - count) };
}
