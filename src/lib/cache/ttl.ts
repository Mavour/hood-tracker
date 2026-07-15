/**
 * In-process TTL cache (Redis optional later).
 * Used for pool slot0 + per-position live snapshots.
 */

type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();

export function ttlGet<T>(key: string): T | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    store.delete(key);
    return null;
  }
  return e.value as T;
}

export function ttlSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export async function ttlGetOrSet<T>(
  key: string,
  ttlMs: number,
  factory: () => Promise<T>,
): Promise<T> {
  const hit = ttlGet<T>(key);
  if (hit != null) return hit;
  const value = await factory();
  ttlSet(key, value, ttlMs);
  return value;
}
