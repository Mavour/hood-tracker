import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { getPnlCache } from "@/lib/db";
import {
  getLiveValue,
  type CachedPositionMeta,
} from "@/lib/pnl/getLiveValue";
import { feeTierLabel } from "@/lib/utils";
import { mapWithConcurrency } from "@/lib/chain/rpc-throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/pnl/:address/live
 * Lightweight refresh for OPEN positions only (addendum §C).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { address: string } },
) {
  const address = params.address;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const cache = await getPnlCache(address);
  if (!cache) {
    return NextResponse.json(
      { error: "No indexed data — POST /api/track first" },
      { status: 404 },
    );
  }

  const positions = cache.positions as Array<Record<string, unknown>>;
  const open = positions.filter((p) => p.isOpen === true);

  const liveRows = await mapWithConcurrency(open, 2, async (p) => {
      try {
        const meta: CachedPositionMeta = {
          tokenId: String(p.tokenId),
          token0: String(p.token0),
          token1: String(p.token1),
          tickLower: Number(p.tickLower),
          tickUpper: Number(p.tickUpper),
          liquidity: String(p.liquidity ?? "0"),
          poolAddress: (p.poolAddress as string) ?? null,
          decimals0: Number(p.decimals0 ?? 18),
          decimals1: Number(p.decimals1 ?? 18),
          symbol0: String(p.symbol0 ?? "T0"),
          symbol1: String(p.symbol1 ?? "T1"),
          fee: Number(p.fee ?? 0),
          depositUsd: Number(p.depositUsd ?? 0),
          feesCollectedUsd: Number(p.feesCollectedUsd ?? 0),
          withdrawnUsd: Number(p.withdrawnUsd ?? 0),
          protocol: (p.protocol as "v3" | "v4") ?? "v3",
          poolId: (p.poolId as string) ?? null,
        };

        if (meta.symbol0 === "USDG") meta.decimals0 = 6;
        if (meta.symbol1 === "USDG") meta.decimals1 = 6;

        const live = await getLiveValue(meta);
        if (!live) return null;

        return {
          tokenId: meta.tokenId,
          pool: `${meta.symbol0}/${meta.symbol1} ${feeTierLabel(meta.fee)}`,
          depositValueUsd: meta.depositUsd,
          currentValueUsd: live.currentValueUsd + live.feeUnclaimedUsd,
          principalUsd: live.principalUsd,
          unrealizedPnlUsd: live.unrealizedPnlUsd,
          feeUnclaimedUsd: live.feeUnclaimedUsd,
          feesCollectedUsd: meta.feesCollectedUsd,
          inRange: live.inRange,
          amount0Human: live.amount0Human,
          amount1Human: live.amount1Human,
          lastUpdated: live.lastUpdated,
          protocol: meta.protocol,
          valuationMethod: live.valuationMethod,
        };
      } catch (e) {
        console.warn("[live] position error", p.tokenId, e);
        return null;
      }
    },
  );

  const rows = liveRows.filter(Boolean) as NonNullable<
    (typeof liveRows)[number]
  >[];

  const unrealizedPnlUsd = rows.reduce((s, r) => s + r.unrealizedPnlUsd, 0);
  const openValueUsd = rows.reduce((s, r) => s + r.currentValueUsd, 0);

  // Realized from cache summary if present
  const summary = cache.summary as Record<string, number>;
  const realizedPnlUsd = Number(summary?.realizedPnlUsd ?? 0);

  return NextResponse.json({
    address: address.toLowerCase(),
    positions: rows,
    totals: {
      unrealizedPnlUsd,
      realizedPnlUsd,
      totalPnlUsd: realizedPnlUsd + unrealizedPnlUsd,
      openValueUsd,
      openCount: rows.length,
    },
    lastUpdated: new Date().toISOString(),
  });
}
