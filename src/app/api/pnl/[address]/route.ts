import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { getPnlCache, getLatestJobForAddress } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { address: string } },
) {
  const address = params.address;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const currency = (req.nextUrl.searchParams.get("currency") ?? "usd") as
    | "usd"
    | "eth";
  const range = req.nextUrl.searchParams.get("range");

  const job = await getLatestJobForAddress(address);
  const cache = await getPnlCache(address);

  if (!cache) {
    return NextResponse.json({
      status: job?.status ?? "missing",
      jobId: job?.jobId,
      progress: job?.progress,
      progressMessage: job?.progressMessage,
      ready: false,
    });
  }

  let daily = cache.daily as Array<{ date: string; [k: string]: unknown }>;
  if (range && range.includes("..")) {
    const [from, to] = range.split("..");
    daily = daily.filter((d) => d.date >= from && d.date <= to);
  }

  const positions = cache.positions as unknown[];
  const phase =
    cache.phase ??
    (Array.isArray(positions) &&
    positions.some(
      (p) => (p as { historyPending?: boolean })?.historyPending,
    )
      ? "fast"
      : "full");

  return NextResponse.json({
    status: "ready",
    ready: true,
    phase,
    currency,
    address: address.toLowerCase(),
    summary: cache.summary,
    positions: cache.positions,
    daily,
    computedAt: cache.computedAt,
    lastUpdated: cache.computedAt,
    progressMessage: job?.progressMessage,
    progress: job?.progress,
  });
}
