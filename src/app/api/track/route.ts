import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { randomUUID } from "crypto";
import {
  getLatestJobForAddress,
  getPnlCache,
  getRunningJobs,
  upsertJob,
  getJob,
} from "@/lib/db";
import { checkTrackRateLimit } from "@/lib/rate-limit";
import { indexAddress } from "@/lib/indexer/run";
import { bumpIndexGeneration } from "@/lib/indexer/cancel";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Old full-chain scanner progress text — treat as dead job */
function isStaleSlowJob(msg?: string): boolean {
  if (!msg) return false;
  return (
    msg.includes("Scanning transfers blocks") ||
    msg.includes("Scanning block") ||
    /blocks \d+/.test(msg)
  );
}

export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";

    const rl = await checkTrackRateLimit(ip);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Try again later." },
        { status: 429 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const address = String(body.address ?? "").trim();
    const force = Boolean(body.force);
    if (!isAddress(address)) {
      return NextResponse.json(
        { error: "Invalid Ethereum address" },
        { status: 400 },
      );
    }

    const key = address.toLowerCase();
    const running = getRunningJobs();

    // Fresh cache (unless force)
    if (!force) {
      const cache = await getPnlCache(address);
      if (cache) {
        const jobId = randomUUID();
        await upsertJob({
          jobId,
          ownerAddress: address,
          status: "ready",
          progress: 100,
          progressMessage: "Served from cache",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return NextResponse.json({
          status: "ready",
          jobId,
          cached: true,
          computedAt: cache.computedAt,
        });
      }
    }

    // Existing in-flight — only reattach if it's the NEW fast indexer
    const existing = await getLatestJobForAddress(address);
    if (
      !force &&
      existing &&
      (existing.status === "indexing" || existing.status === "queued") &&
      Date.now() - new Date(existing.updatedAt).getTime() < 3 * 60_000 &&
      running.has(key) &&
      !isStaleSlowJob(existing.progressMessage)
    ) {
      return NextResponse.json({
        status: existing.status,
        jobId: existing.jobId,
        progress: existing.progress,
        progressMessage: existing.progressMessage,
      });
    }

    // Cancel any previous run (including stuck full-chain scan)
    const gen = bumpIndexGeneration(address);
    running.delete(key);

    const jobId = randomUUID();
    await upsertJob({
      jobId,
      ownerAddress: address,
      status: "queued",
      progress: 0,
      progressMessage: "Queued (fast path)",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const p = indexAddress(address, jobId, gen)
      .catch(async (e) => {
        if (e instanceof Error && e.message === "CANCELLED") {
          console.log("[track] cancelled", address);
          return;
        }
        console.error("[track]", e);
        await upsertJob({
          jobId,
          ownerAddress: address,
          status: "error",
          progress: 0,
          progressMessage: "Failed",
          errorMessage: e instanceof Error ? e.message : String(e),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      })
      .finally(() => {
        // Only clear if still this generation's slot
        if (running.get(key) === p) running.delete(key);
      });
    running.set(key, p);

    return NextResponse.json({
      status: "indexing",
      jobId,
      progress: 0,
      progressMessage: "Starting fast index…",
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Server error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  const address = req.nextUrl.searchParams.get("address");

  if (jobId) {
    const job = await getJob(jobId);
    if (job) {
      // Don't keep UI stuck on old scanner text
      if (isStaleSlowJob(job.progressMessage) && job.status === "indexing") {
        return NextResponse.json({
          status: "stale",
          jobId: job.jobId,
          progress: 0,
          progressMessage: "Old slow job — click Refresh",
          errorMessage: undefined,
        });
      }
      return NextResponse.json({
        status: job.status,
        jobId: job.jobId,
        progress: job.progress,
        progressMessage: job.progressMessage,
        errorMessage: job.errorMessage,
      });
    }
  }

  if (address && isAddress(address)) {
    const job = await getLatestJobForAddress(address);
    if (job) {
      if (isStaleSlowJob(job.progressMessage) && job.status === "indexing") {
        return NextResponse.json({
          status: "stale",
          jobId: job.jobId,
          progress: 0,
          progressMessage: "Old slow job — click Refresh",
        });
      }
      return NextResponse.json({
        status: job.status,
        jobId: job.jobId,
        progress: job.progress,
        progressMessage: job.progressMessage,
        errorMessage: job.errorMessage,
      });
    }
  }

  if (!jobId && !address) {
    return NextResponse.json(
      { error: "jobId or address required" },
      { status: 400 },
    );
  }

  return NextResponse.json(
    {
      status: "missing",
      progress: 0,
      progressMessage: "Job not found yet",
    },
    { status: 200 },
  );
}
