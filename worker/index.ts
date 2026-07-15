/**
 * Optional BullMQ worker process for heavy indexing.
 * Falls back to no-op if REDIS_URL is missing.
 *
 * Run: npx tsx worker/index.ts
 * PM2: pm2 start ecosystem.config.cjs
 */

import { Queue, Worker } from "bullmq";
import { indexAddress } from "../src/lib/indexer/run";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error(
    "[worker] REDIS_URL not set — exit. Use in-process indexing via API instead.",
  );
  process.exit(0);
}

// Pass connection opts object (avoids ioredis type mismatch with bullmq's nested dep)
const connection = { url: REDIS_URL };

export const indexQueue = new Queue("lp-index", { connection });

const worker = new Worker(
  "lp-index",
  async (job) => {
    const { address, jobId } = job.data as { address: string; jobId: string };
    console.log(`[worker] indexing ${address} job=${jobId}`);
    const result = await indexAddress(address, jobId, 1);
    console.log(
      `[worker] done ${address} positions=${result.positions.length} pnlUsd=${result.summary.netPnlUsd}`,
    );
    return { ok: true, address };
  },
  { connection, concurrency: 2 },
);

worker.on("failed", (job, err) => {
  console.error("[worker] failed", job?.id, err.message);
});

console.log("[worker] LP index worker running");
