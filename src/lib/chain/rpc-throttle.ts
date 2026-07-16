/**
 * Global RPC request throttle matching UniLP-Monitoring's approach:
 * - 25ms minimum delay between requests when using Alchemy
 * - Retry with exponential backoff on 429 errors
 * - Concurrency limiter for parallel RPC calls
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const RPC_DELAY_MS = Number(process.env.RPC_REQUEST_DELAY_MS ?? 25);
const isAlchemy = (process.env.ROBINHOOD_CHAIN_RPC ?? "")
  .toLowerCase()
  .includes("alchemy");

const effectiveDelay = isAlchemy ? RPC_DELAY_MS : 0;

let lastRequestAt = 0;
let throttleTail: Promise<unknown> = Promise.resolve();

/**
 * Throttle wrapper: ensures minimum spacing between RPC calls.
 * Matches UniLP-Monitoring's throttledGetLogs pattern.
 */
export async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  if (effectiveDelay <= 0) return fn();

  const run = throttleTail.then(async () => {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < effectiveDelay) {
      await sleep(effectiveDelay - elapsed);
    }
    lastRequestAt = Date.now();
    return fn();
  });
  throttleTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Check if an error is a transient RPC error (429, 5xx, network).
 * Matches UniLP-Monitoring's isTransientRpcError.
 */
function isTransientRpcError(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    cause?: { code?: unknown; status?: unknown; message?: unknown };
  };
  const code = e?.code ?? e?.cause?.code;
  const status = e?.status ?? e?.cause?.status;
  if (code === 429 || status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  if (typeof code === "number" && [-32000, -32005, -32603].includes(code))
    return true;
  const msg = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`.toLowerCase();
  return /timeout|timed out|fetch failed|network|socket|econnreset|econnrefused|rate limit|too many requests|service unavailable|gateway|exceeded/.test(
    msg,
  );
}

/**
 * Retry with exponential backoff on transient errors (429, 5xx).
 * Matches UniLP-Monitoring's getLogsWithRetry pattern: 5 attempts, 500ms-8s backoff.
 */
export async function retryOnTransient<T>(
  fn: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(error)) throw error;
      const delay = 500 * 2 ** attempt;
      console.warn(
        `[rpc] transient error (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Concurrency limiter matching UniLP-Monitoring's mapWithConcurrency.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}
