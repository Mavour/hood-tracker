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
  quoteToken?: string | null;
  status?: string;
  liquidity?: string;
  openedAtBlock?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await initDb();
  if (useMemory || !getPool()) {
    mem().positions.set(row.tokenId, row);
    return;
  }
  await query(
    `INSERT INTO positions (
      token_id, owner_address, pool_address, token0, token1, quote_token, fee_tier,
      tick_lower, tick_upper, symbol0, symbol1, decimals0, decimals1,
      status, liquidity, opened_at, closed_at, opened_at_block, metadata, last_indexed_block, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
    ON CONFLICT (token_id) DO UPDATE SET
      owner_address = EXCLUDED.owner_address,
      pool_address = EXCLUDED.pool_address,
      quote_token = COALESCE(EXCLUDED.quote_token, positions.quote_token),
      status = COALESCE(EXCLUDED.status, positions.status),
      liquidity = COALESCE(EXCLUDED.liquidity, positions.liquidity),
      opened_at = COALESCE(EXCLUDED.opened_at, positions.opened_at),
      closed_at = EXCLUDED.closed_at,
      opened_at_block = COALESCE(EXCLUDED.opened_at_block, positions.opened_at_block),
      metadata = COALESCE(EXCLUDED.metadata, positions.metadata),
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
      row.quoteToken ?? null,
      row.feeTier,
      row.tickLower,
      row.tickUpper,
      row.symbol0,
      row.symbol1,
      row.decimals0,
      row.decimals1,
      row.status ?? "open",
      row.liquidity ?? "0",
      row.openedAt,
      row.closedAt,
      row.openedAtBlock ?? null,
      JSON.stringify(row.metadata ?? {}),
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

// ── Cashflows (UniLP-Monitoring aligned) ──────────────────────────

export async function addCashflow(
  positionId: string,
  blockNumber: number,
  txHash: string,
  flowType: "deposit" | "withdrawal" | "fee",
  quoteValue: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await initDb();
  if (useMemory || !getPool()) {
    mem().cashflows.push({
      position_id: positionId,
      block_number: blockNumber,
      transaction_hash: txHash,
      flow_type: flowType,
      quote_value: quoteValue,
      metadata: metadata ?? {},
    });
    return;
  }
  await query(
    `INSERT INTO cashflows (position_id, block_number, transaction_hash, flow_type, quote_value, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (position_id, transaction_hash, flow_type) DO UPDATE SET
       quote_value = EXCLUDED.quote_value,
       metadata = EXCLUDED.metadata`,
    [positionId, blockNumber, txHash, flowType, quoteValue, JSON.stringify(metadata ?? {})],
  );
}

export async function getCashflowTotals(
  positionId: string,
  excludedTransactionHashes: string[] = [],
): Promise<{ deposits: number; realized: number }> {
  await initDb();
  if (useMemory || !getPool()) {
    const flows = mem().cashflows.filter(
      (f) =>
        f.position_id === positionId &&
        (excludedTransactionHashes.length === 0 ||
          !excludedTransactionHashes.includes(f.transaction_hash as string)),
    );
    let deposits = 0;
    let realized = 0;
    for (const f of flows) {
      const v = Number(f.quote_value);
      if (f.flow_type === "deposit") deposits += v;
      else if (f.flow_type === "withdrawal" || f.flow_type === "fee") realized += v;
    }
    return { deposits, realized };
  }
  const { rows } = await query<{
    deposits: string;
    realized: string;
  }>(
    `SELECT
      COALESCE(SUM(quote_value) FILTER (WHERE flow_type = 'deposit'), 0) AS deposits,
      COALESCE(SUM(quote_value) FILTER (WHERE flow_type IN ('withdrawal', 'fee')), 0) AS realized
     FROM cashflows
     WHERE position_id = $1
       AND (cardinality($2::text[]) = 0 OR transaction_hash <> ALL($2::text[]))`,
    [positionId, excludedTransactionHashes],
  );
  const row = rows[0]!;
  return { deposits: Number(row.deposits), realized: Number(row.realized) };
}

// ── Position metadata / status ────────────────────────────────────

export async function updatePositionStatus(
  tokenId: string,
  status: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await initDb();
  if (useMemory || !getPool()) {
    const pos = mem().positions.get(tokenId);
    if (pos) {
      pos.status = status;
      if (extra) {
        const meta = (pos.metadata as Record<string, unknown>) ?? {};
        Object.assign(meta, extra);
        pos.metadata = meta;
      }
    }
    return;
  }
  if (extra) {
    await query(
      `UPDATE positions SET status = $2, metadata = COALESCE(metadata, '{}') || $3::jsonb, updated_at = NOW()
       WHERE token_id = $1`,
      [tokenId, status, JSON.stringify(extra)],
    );
  } else {
    await query(
      `UPDATE positions SET status = $2, updated_at = NOW() WHERE token_id = $1`,
      [tokenId, status],
    );
  }
}

export async function getPositionMetadata(
  tokenId: string,
): Promise<Record<string, unknown> | null> {
  await initDb();
  if (useMemory || !getPool()) {
    const pos = mem().positions.get(tokenId);
    return pos ? ((pos.metadata as Record<string, unknown>) ?? {}) : null;
  }
  const { rows } = await query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM positions WHERE token_id = $1`,
    [tokenId],
  );
  return rows[0]?.metadata ?? null;
}

// ── Close history (UniLP-Monitoring aligned) ──────────────────────

export type CloseHistoryRecord = {
  id: string;
  positionId: string;
  chainId: number;
  protocol: string;
  token0: string;
  token1: string;
  quoteToken: string;
  finalPnlBps: number;
  finalPnlQuote: number;
  finalPnlUsd: number;
  trigger: string;
  closeTransactionHash: string | null;
  swapTransactionHash: string | null;
  settledAt: string;
  openedAtBlock: number | null;
};

export async function upsertCloseHistory(record: {
  positionId: string;
  chainId?: number;
  protocol?: string;
  token0: string;
  token1: string;
  quoteToken: string;
  finalPnlBps: number;
  finalPnlQuote: number;
  finalPnlUsd: number;
  trigger: string;
  closeTransactionHash?: string | null;
  swapTransactionHash?: string | null;
  openedAtBlock?: number | null;
}): Promise<void> {
  await initDb();
  const r = {
    chainId: record.chainId ?? 4663,
    protocol: record.protocol ?? "v3",
    ...record,
  };

  if (useMemory || !getPool()) {
    const idx = mem().closeHistory.findIndex(
      (h) => h.position_id === r.positionId,
    );
    const row: Record<string, unknown> = {
      id: `ch-${r.positionId}`,
      position_id: r.positionId,
      chain_id: r.chainId,
      protocol: r.protocol,
      token0: r.token0,
      token1: r.token1,
      quote_token: r.quoteToken,
      final_pnl_bps: r.finalPnlBps,
      final_pnl_quote: r.finalPnlQuote,
      final_pnl_usd: r.finalPnlUsd,
      trigger: r.trigger,
      close_transaction_hash: r.closeTransactionHash ?? null,
      swap_transaction_hash: r.swapTransactionHash ?? null,
      settled_at: new Date().toISOString(),
      opened_at_block: r.openedAtBlock ?? null,
    };
    if (idx >= 0) mem().closeHistory[idx] = row;
    else mem().closeHistory.push(row);
    return;
  }

  await query(
    `INSERT INTO close_history (position_id, chain_id, protocol, token0, token1, quote_token,
       final_pnl_bps, final_pnl_quote, final_pnl_usd, trigger, close_transaction_hash, swap_transaction_hash, settled_at, opened_at_block)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13)
     ON CONFLICT (position_id) DO UPDATE SET
       final_pnl_bps = EXCLUDED.final_pnl_bps,
       final_pnl_quote = EXCLUDED.final_pnl_quote,
       final_pnl_usd = EXCLUDED.final_pnl_usd,
       trigger = EXCLUDED.trigger,
       close_transaction_hash = COALESCE(EXCLUDED.close_transaction_hash, close_history.close_transaction_hash),
       swap_transaction_hash = COALESCE(EXCLUDED.swap_transaction_hash, close_history.swap_transaction_hash),
       settled_at = NOW()`,
    [
      r.positionId,
      r.chainId,
      r.protocol,
      r.token0,
      r.token1,
      r.quoteToken,
      r.finalPnlBps,
      r.finalPnlQuote,
      r.finalPnlUsd,
      r.trigger,
      r.closeTransactionHash ?? null,
      r.swapTransactionHash ?? null,
      r.openedAtBlock ?? null,
    ],
  );
}

export async function updateCloseHistoryUsd(
  id: string,
  pnlUsd: number,
  settledAt?: Date,
): Promise<void> {
  await initDb();
  if (useMemory || !getPool()) {
    const h = mem().closeHistory.find((x) => x.id === id);
    if (h) {
      h.final_pnl_usd = pnlUsd;
      if (settledAt) h.settled_at = settledAt.toISOString();
    }
    return;
  }
  if (settledAt) {
    await query(
      `UPDATE close_history SET final_pnl_usd = $2, settled_at = $3 WHERE id = $1`,
      [id, pnlUsd, settledAt.toISOString()],
    );
  } else {
    await query(
      `UPDATE close_history SET final_pnl_usd = $2 WHERE id = $1`,
      [id, pnlUsd],
    );
  }
}

export async function listStaleCloseHistoryUsd(): Promise<
  Array<{
    id: string;
    chainId: number;
    positionId: string;
    finalPnlQuote: number;
    quoteToken: string;
    isNativeQuote: boolean;
    closeTransactionHash: string | null;
    swapTransactionHash: string | null;
  }>
> {
  await initDb();
  if (useMemory || !getPool()) {
    return mem()
      .closeHistory.filter(
        (h) =>
          Number(h.final_pnl_usd) === 0 &&
          (h.quote_token === "0x0000000000000000000000000000000000000000" ||
            (h.quote_token as string).toLowerCase() ===
              "0x0bd7d308f8e1639fab988df18a8011f41eacad73"),
      )
      .map((h) => ({
        id: h.id as string,
        chainId: Number(h.chain_id),
        positionId: h.position_id as string,
        finalPnlQuote: Number(h.final_pnl_quote),
        quoteToken: h.quote_token as string,
        isNativeQuote:
          h.quote_token === "0x0000000000000000000000000000000000000000",
        closeTransactionHash: h.close_transaction_hash as string | null,
        swapTransactionHash: h.swap_transaction_hash as string | null,
      }));
  }
  const { rows } = await query<{
    id: string;
    chain_id: number;
    position_id: string;
    final_pnl_quote: string;
    quote_token: string;
    close_transaction_hash: string | null;
    swap_transaction_hash: string | null;
  }>(
    `SELECT id, chain_id, position_id, final_pnl_quote, quote_token,
            close_transaction_hash, swap_transaction_hash
     FROM close_history
     WHERE final_pnl_usd = 0
       AND (quote_token = '0x0000000000000000000000000000000000000000'
            OR LOWER(quote_token) = '0x0bd7d308f8e1639fab988df18a8011f41eacad73')
     ORDER BY settled_at DESC LIMIT 50`,
  );
  return rows.map((r) => ({
    id: r.id,
    chainId: r.chain_id,
    positionId: r.position_id,
    finalPnlQuote: Number(r.final_pnl_quote),
    quoteToken: r.quote_token,
    isNativeQuote: r.quote_token === "0x0000000000000000000000000000000000000000",
    closeTransactionHash: r.close_transaction_hash,
    swapTransactionHash: r.swap_transaction_hash,
  }));
}

// ── Close history for calendar integration ────────────────────────

export async function getCloseHistoryForPositions(
  positionIds: string[],
): Promise<
  Array<{
    positionId: string;
    settledAt: string;
    finalPnlUsd: number;
    finalPnlBps: number;
  }>
> {
  if (positionIds.length === 0) return [];
  await initDb();
  if (useMemory || !getPool()) {
    return mem()
      .closeHistory.filter((h) =>
        positionIds.includes(h.position_id as string),
      )
      .map((h) => ({
        positionId: h.position_id as string,
        settledAt: h.settled_at as string,
        finalPnlUsd: Number(h.final_pnl_usd),
        finalPnlBps: Number(h.final_pnl_bps),
      }));
  }
  const { rows } = await query<{
    position_id: string;
    settled_at: string;
    final_pnl_usd: string;
    final_pnl_bps: string;
  }>(
    `SELECT position_id, settled_at, final_pnl_usd, final_pnl_bps
     FROM close_history
     WHERE position_id = ANY($1::text[])`,
    [positionIds],
  );
  return rows.map((r) => ({
    positionId: r.position_id,
    settledAt: r.settled_at,
    finalPnlUsd: Number(r.final_pnl_usd),
    finalPnlBps: Number(r.final_pnl_bps),
  }));
}

// ── Calendar (UniLP-Monitoring aligned) ───────────────────────────

export async function getPnlCalendarMonth(
  year: number,
  month: number,
): Promise<{
  year: number;
  month: number;
  pnlUsd: number;
  closeCount: number;
  winCount: number;
  activeDays: number;
  days: Array<{
    date: string;
    pnlUsd: number;
    closeCount: number;
    winCount: number;
  }>;
}> {
  await initDb();
  if (useMemory || !getPool()) {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    const days = new Map<
      string,
      { date: string; pnlUsd: number; closeCount: number; winCount: number }
    >();
    for (const h of mem().closeHistory) {
      const settled = new Date(h.settled_at as string);
      if (settled >= start && settled < end) {
        const pnlBps = Number(h.final_pnl_bps);
        if (Math.abs(pnlBps) < 50) continue;
        const pnlUsd = Number(h.final_pnl_usd);
        if (pnlUsd === 0) continue;
        const date = (h.settled_at as string).slice(0, 10);
        let d = days.get(date);
        if (!d) {
          d = { date, pnlUsd: 0, closeCount: 0, winCount: 0 };
          days.set(date, d);
        }
        d.pnlUsd += pnlUsd;
        d.closeCount += 1;
        if (pnlUsd > 0) d.winCount += 1;
      }
    }
    const dayArr = [...days.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    return {
      year,
      month,
      pnlUsd: dayArr.reduce((s, d) => s + d.pnlUsd, 0),
      closeCount: dayArr.reduce((s, d) => s + d.closeCount, 0),
      winCount: dayArr.reduce((s, d) => s + d.winCount, 0),
      activeDays: dayArr.length,
      days: dayArr,
    };
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const { rows } = await query<{
    date: string;
    pnl_usd: string;
    close_count: string;
    win_count: string;
  }>(
    `SELECT (settled_at AT TIME ZONE 'UTC')::date::text AS date,
            SUM(final_pnl_usd) AS pnl_usd,
            COUNT(*) AS close_count,
            COUNT(*) FILTER (WHERE final_pnl_usd > 0) AS win_count
     FROM close_history
     WHERE settled_at >= $1 AND settled_at < $2
       AND ABS(final_pnl_bps) >= 50
       AND final_pnl_usd <> 0
     GROUP BY 1 ORDER BY 1`,
    [start.toISOString(), end.toISOString()],
  );
  const days = rows.map((r) => ({
    date: r.date,
    pnlUsd: Number(r.pnl_usd),
    closeCount: Number(r.close_count),
    winCount: Number(r.win_count),
  }));
  return {
    year,
    month,
    pnlUsd: days.reduce((s, d) => s + d.pnlUsd, 0),
    closeCount: days.reduce((s, d) => s + d.closeCount, 0),
    winCount: days.reduce((s, d) => s + d.winCount, 0),
    activeDays: days.length,
    days,
  };
}

// ── PnL card detail (UniLP-Monitoring aligned) ───────────────────

export async function getPnlCardDetail(
  positionId: string,
): Promise<{
  depositsQuote: number;
  settlementQuote: number;
  feesQuote: number;
  feePips: number | null;
} | null> {
  await initDb();
  if (useMemory || !getPool()) {
    const flows = mem().cashflows.filter(
      (f) => f.position_id === positionId,
    );
    let deposits = 0;
    let fees = 0;
    for (const f of flows) {
      const v = Number(f.quote_value);
      if (f.flow_type === "deposit") deposits += v;
      else if (f.flow_type === "fee") fees += v;
    }
    const pos = mem().positions.get(positionId);
    const meta = (pos?.metadata as Record<string, unknown>) ?? {};
    const settlement = Number(meta.totalReceived ?? 0);
    const feePips = typeof meta.fee === "number" ? meta.fee : null;
    return {
      depositsQuote: deposits,
      settlementQuote: settlement,
      feesQuote: fees,
      feePips,
    };
  }
  const { rows } = await query<{
    deposits: string;
    settlement: string | null;
    fees: string;
    fee: string | null;
  }>(
    `SELECT
      COALESCE(SUM(c.quote_value) FILTER (WHERE c.flow_type = 'deposit'), 0) AS deposits,
      p.metadata->>'totalReceived' AS settlement,
      COALESCE(SUM(c.quote_value) FILTER (WHERE c.flow_type = 'fee'), 0) AS fees,
      p.metadata->>'fee' AS fee
     FROM positions p
     LEFT JOIN cashflows c ON c.position_id = p.id::text
     WHERE p.token_id = $1
     GROUP BY p.id`,
    [positionId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    depositsQuote: Number(r.deposits),
    settlementQuote: r.settlement && /^\d+$/.test(r.settlement) ? Number(r.settlement) : 0,
    feesQuote: Number(r.fees),
    feePips: r.fee && /^\d+$/.test(r.fee) ? Number(r.fee) : null,
  };
}
