/**
 * Postgres client with graceful in-memory fallback when DATABASE_URL is missing
 * or connection fails (local demo without Docker).
 */

import { Pool, type QueryResultRow } from "pg";
import { getMem, persistJobs, persistPnlCache } from "./memory";

let pool: Pool | null = null;
let useMemory = false;
let initPromise: Promise<void> | null = null;

/** Process-wide memory (survives Next.js HMR module reloads). */
function mem() {
  return getMem();
}

export function isMemoryMode(): boolean {
  return useMemory;
}

export function getRunningJobs(): Map<string, Promise<unknown>> {
  return getMem().running;
}

function getPool(): Pool | null {
  if (useMemory) return null;
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    useMemory = true;
    console.warn("[db] DATABASE_URL not set — using in-memory store");
    return null;
  }
  pool = new Pool({ connectionString: url, max: 10 });
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const p = getPool();
  if (!p) return { rows: [], rowCount: 0 };
  try {
    return await p.query<T>(text, params);
  } catch (e) {
    console.error("[db] query error", e);
    throw e;
  }
}

export async function initDb(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const p = getPool();
    if (!p) return;
    try {
      await p.query("SELECT 1");
      // Ensure tables exist (idempotent)
      const fs = await import("fs");
      const path = await import("path");
      const schemaPath = path.join(process.cwd(), "db", "schema.sql");
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, "utf8");
        await p.query(sql);
      }
      console.log("[db] connected + schema ready");
    } catch (e) {
      console.warn(
        "[db] connection failed, falling back to memory:",
        e instanceof Error ? e.message : e,
      );
      useMemory = true;
      pool = null;
    }
  })();
  return initPromise;
}

// ── Jobs ──────────────────────────────────────────────────────────

export type IndexJob = {
  jobId: string;
  ownerAddress: string;
  status: "queued" | "indexing" | "ready" | "error";
  progress: number;
  progressMessage: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export async function upsertJob(job: IndexJob): Promise<void> {
  await initDb();
  if (useMemory || !getPool()) {
    const m = mem();
    m.jobs.set(job.jobId, { ...job });
    // Also index by address for latest lookup after reloads
    m.jobs.set(`addr:${job.ownerAddress.toLowerCase()}`, { ...job });
    persistJobs();
    return;
  }
  await query(
    `INSERT INTO index_jobs (job_id, owner_address, status, progress, progress_message, error_message, created_at, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW(),NOW() + INTERVAL '24 hours')
     ON CONFLICT (job_id) DO UPDATE SET
       status = EXCLUDED.status,
       progress = EXCLUDED.progress,
       progress_message = EXCLUDED.progress_message,
       error_message = EXCLUDED.error_message,
       updated_at = NOW()`,
    [
      job.jobId,
      job.ownerAddress.toLowerCase(),
      job.status,
      job.progress,
      job.progressMessage,
      job.errorMessage ?? null,
    ],
  );
}

export async function getJob(jobId: string): Promise<IndexJob | null> {
  await initDb();
  if (useMemory || !getPool()) {
    const j = mem().jobs.get(jobId);
    return j ? (j as unknown as IndexJob) : null;
  }
  const { rows } = await query<{
    job_id: string;
    owner_address: string;
    status: IndexJob["status"];
    progress: string;
    progress_message: string;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
  }>(`SELECT * FROM index_jobs WHERE job_id = $1`, [jobId]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    jobId: r.job_id,
    ownerAddress: r.owner_address,
    status: r.status,
    progress: Number(r.progress),
    progressMessage: r.progress_message,
    errorMessage: r.error_message ?? undefined,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function getLatestJobForAddress(
  address: string,
): Promise<IndexJob | null> {
  await initDb();
  const addr = address.toLowerCase();
  if (useMemory || !getPool()) {
    const byAddr = mem().jobs.get(`addr:${addr}`);
    if (byAddr?.jobId) {
      const full = mem().jobs.get(String(byAddr.jobId));
      if (full) return full as unknown as IndexJob;
      return byAddr as unknown as IndexJob;
    }
    const jobs = [...mem().jobs.values()]
      .filter(
        (j) =>
          (j.ownerAddress as string)?.toLowerCase() === addr && j.jobId,
      )
      .sort(
        (a, b) =>
          new Date(b.updatedAt as string).getTime() -
          new Date(a.updatedAt as string).getTime(),
      );
    return jobs[0] ? (jobs[0] as unknown as IndexJob) : null;
  }
  const { rows } = await query<{
    job_id: string;
    owner_address: string;
    status: IndexJob["status"];
    progress: string;
    progress_message: string;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT * FROM index_jobs WHERE owner_address = $1 ORDER BY updated_at DESC LIMIT 1`,
    [addr],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    jobId: r.job_id,
    ownerAddress: r.owner_address,
    status: r.status,
    progress: Number(r.progress),
    progressMessage: r.progress_message,
    errorMessage: r.error_message ?? undefined,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

// ── PnL cache ─────────────────────────────────────────────────────

export async function getPnlCache(address: string): Promise<{
  summary: unknown;
  positions: unknown;
  daily: unknown;
  computedAt: string;
  phase?: string;
} | null> {
  await initDb();
  const addr = address.toLowerCase();
  if (useMemory || !getPool()) {
    const c = mem().pnlCache.get(addr);
    if (!c) return null;
    if (new Date(c.expiresAt as string).getTime() < Date.now()) {
      mem().pnlCache.delete(addr);
      persistPnlCache();
      return null;
    }
    return {
      summary: c.summary,
      positions: c.positions,
      daily: c.daily,
      computedAt: c.computedAt as string,
      phase: c.phase as string | undefined,
    };
  }
  const { rows } = await query<{
    summary_json: unknown;
    positions_json: unknown;
    daily_json: unknown;
    computed_at: Date;
  }>(
    `SELECT summary_json, positions_json, daily_json, computed_at
     FROM address_pnl_cache WHERE owner_address = $1 AND expires_at > NOW()`,
    [addr],
  );
  if (!rows[0]) return null;
  return {
    summary: rows[0].summary_json,
    positions: rows[0].positions_json,
    daily: rows[0].daily_json,
    computedAt: rows[0].computed_at.toISOString(),
  };
}

export async function setPnlCache(
  address: string,
  data: {
    summary: unknown;
    positions: unknown;
    daily: unknown;
    phase?: string;
  },
  ttlSeconds = 300,
): Promise<void> {
  await initDb();
  const addr = address.toLowerCase();
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  if (useMemory || !getPool()) {
    mem().pnlCache.set(addr, {
      summary: data.summary,
      positions: data.positions,
      daily: data.daily,
      phase: data.phase,
      computedAt: new Date().toISOString(),
      expiresAt: expires,
    });
    persistPnlCache();
    return;
  }
  await query(
    `INSERT INTO address_pnl_cache (owner_address, summary_json, positions_json, daily_json, computed_at, expires_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, NOW(), $5)
     ON CONFLICT (owner_address) DO UPDATE SET
       summary_json = EXCLUDED.summary_json,
       positions_json = EXCLUDED.positions_json,
       daily_json = EXCLUDED.daily_json,
       computed_at = NOW(),
       expires_at = EXCLUDED.expires_at`,
    [
      addr,
      JSON.stringify(data.summary),
      JSON.stringify(data.positions),
      JSON.stringify(data.daily),
      expires,
    ],
  );
}

// ── Position + events persistence ─────────────────────────────────

export async function savePosition(row: {
  tokenId: string;
  ownerAddress: string;
  poolAddress: string | null;
  token0: string;
  token1: string;
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  openedAt: string | null;
  closedAt: string | null;
  lastIndexedBlock: number;
}): Promise<void> {
  await initDb();
  if (useMemory || !getPool()) {
    mem().positions.set(row.tokenId, row);
    return;
  }
  await query(
    `INSERT INTO positions (
      token_id, owner_address, pool_address, token0, token1, fee_tier,
      tick_lower, tick_upper, symbol0, symbol1, decimals0, decimals1,
      opened_at, closed_at, last_indexed_block, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
    ON CONFLICT (token_id) DO UPDATE SET
      owner_address = EXCLUDED.owner_address,
      pool_address = EXCLUDED.pool_address,
      opened_at = COALESCE(EXCLUDED.opened_at, positions.opened_at),
      closed_at = EXCLUDED.closed_at,
      last_indexed_block = EXCLUDED.last_indexed_block,
      symbol0 = EXCLUDED.symbol0,
      symbol1 = EXCLUDED.symbol1,
      updated_at = NOW()`,
    [
      row.tokenId,
      row.ownerAddress.toLowerCase(),
      row.poolAddress,
      row.token0,
      row.token1,
      row.feeTier,
      row.tickLower,
      row.tickUpper,
      row.symbol0,
      row.symbol1,
      row.decimals0,
      row.decimals1,
      row.openedAt,
      row.closedAt,
      row.lastIndexedBlock,
    ],
  );
}

export async function saveEvents(
  events: Array<{
    tokenId: string;
    eventType: string;
    blockNumber: number;
    txHash: string;
    logIndex: number;
    timestamp: string;
    amount0: number;
    amount1: number;
    price0Usd: number | null;
    price1Usd: number | null;
    price0Eth: number | null;
    price1Eth: number | null;
    valueUsd: number | null;
    valueEth: number | null;
  }>,
): Promise<void> {
  await initDb();
  if (useMemory || !getPool()) {
    const m = mem();
    for (const e of events) {
      const key = `${e.tokenId}:${e.eventType}:${e.txHash}:${e.logIndex}`;
      const exists = m.events.some(
        (x) =>
          `${x.tokenId}:${x.eventType}:${x.txHash}:${x.logIndex}` === key,
      );
      if (!exists) m.events.push(e);
    }
    return;
  }
  for (const e of events) {
    await query(
      `INSERT INTO position_events (
        token_id, event_type, block_number, tx_hash, log_index, timestamp,
        amount0, amount1, price0_usd, price1_usd, price0_eth, price1_eth, value_usd, value_eth
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (token_id, event_type, tx_hash, log_index) DO NOTHING`,
      [
        e.tokenId,
        e.eventType,
        e.blockNumber,
        e.txHash,
        e.logIndex,
        e.timestamp,
        e.amount0,
        e.amount1,
        e.price0Usd,
        e.price1Usd,
        e.price0Eth,
        e.price1Eth,
        e.valueUsd,
        e.valueEth,
      ],
    );
  }
}

export async function getEventsForToken(tokenId: string) {
  await initDb();
  if (useMemory || !getPool()) {
    return mem()
      .events.filter((e) => e.tokenId === tokenId)
      .sort(
        (a, b) =>
          new Date(a.timestamp as string).getTime() -
          new Date(b.timestamp as string).getTime(),
      );
  }
  const { rows } = await query(
    `SELECT * FROM position_events WHERE token_id = $1 ORDER BY block_number, log_index`,
    [tokenId],
  );
  return rows;
}

// ── Deposits (permanent, canonical cost-basis cache) ──────────────

export type DepositRecord = {
  tokenId: string;
  protocol: "v3" | "v4";
  amount0: number;
  amount1: number;
  /** raw base-unit strings (lossless) — prefer these over amount0/amount1 */
  amount0Raw?: string;
  amount1Raw?: string;
  blockNumber: number;
  txHash: string;
  source: "mint" | "increase" | "estimate";
};

export async function getDeposit(
  tokenId: string,
): Promise<DepositRecord | null> {
  await initDb();
  if (useMemory || !getPool()) {
    const d = mem().deposits.get(tokenId);
    return d ? (d as unknown as DepositRecord) : null;
  }
  const { rows } = await query<{
    token_id: string;
    protocol: string;
    amount0: string;
    amount1: string;
    block_number: string;
    tx_hash: string;
    source: string;
  }>(`SELECT * FROM deposits WHERE token_id = $1`, [tokenId]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    tokenId: r.token_id,
    protocol: (r.protocol as "v3" | "v4") ?? "v3",
    amount0: Number(r.amount0),
    amount1: Number(r.amount1),
    amount0Raw: r.amount0,
    amount1Raw: r.amount1,
    blockNumber: Number(r.block_number),
    txHash: r.tx_hash,
    source: (r.source as DepositRecord["source"]) ?? "mint",
  };
}

export async function saveDeposit(rec: DepositRecord): Promise<void> {
  await initDb();
  if (useMemory || !getPool()) {
    mem().deposits.set(rec.tokenId, { ...rec });
    return;
  }
  await query(
    `INSERT INTO deposits (token_id, protocol, amount0, amount1, block_number, tx_hash, source, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (token_id) DO UPDATE SET
       amount0 = EXCLUDED.amount0,
       amount1 = EXCLUDED.amount1,
       block_number = EXCLUDED.block_number,
       tx_hash = EXCLUDED.tx_hash,
       source = EXCLUDED.source,
       resolved_at = NOW()`,
    [
      rec.tokenId,
      rec.protocol,
      rec.amount0Raw ?? rec.amount0.toString(),
      rec.amount1Raw ?? rec.amount1.toString(),
      rec.blockNumber,
      rec.txHash,
      rec.source,
    ],
  );
}

export async function getPositionsForOwner(address: string) {
  await initDb();
  const addr = address.toLowerCase();
  if (useMemory || !getPool()) {
    return [...mem().positions.values()].filter(
      (p) => (p.ownerAddress as string)?.toLowerCase() === addr,
    );
  }
  const { rows } = await query(
    `SELECT * FROM positions WHERE owner_address = $1`,
    [addr],
  );
  return rows;
}
