import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { getPnlCache } from "@/lib/db";
import { explorerTx } from "@config/contracts";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { address: string; date: string } },
) {
  const { address, date } = params;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const cache = await getPnlCache(address);
  if (!cache) {
    return NextResponse.json({ error: "No data — track address first" }, { status: 404 });
  }

  const daily = (cache.daily as Array<Record<string, unknown>>).find(
    (d) => d.date === date,
  );
  const positions = cache.positions as Array<Record<string, unknown>>;

  // Positions opened/closed that day
  const opened = positions.filter((p) => {
    const ts = p.openedAt as number | null;
    if (!ts) return false;
    return new Date(ts * 1000).toISOString().slice(0, 10) === date;
  });
  const closed = positions.filter((p) => {
    const ts = p.closedAt as number | null;
    if (!ts) return false;
    return new Date(ts * 1000).toISOString().slice(0, 10) === date;
  });

  return NextResponse.json({
    date,
    day: daily ?? null,
    positionsOpened: opened,
    positionsClosed: closed,
    // helper for explorer links
    explorerTxTemplate: explorerTx("{hash}"),
  });
}
