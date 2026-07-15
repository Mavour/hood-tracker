import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { getPnlCache } from "@/lib/db";
import {
  getLiveValue,
  type CachedPositionMeta,
} from "@/lib/pnl/getLiveValue";
import { feeTierLabel } from "@/lib/utils";

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

  const liveRows = await Promise.all(
    open.map(async (p) => {
      const meta: CachedPositionMeta = {
        tokenId: String(p.tokenId),
        token0: String(p.token0),
        token1: String(p.token1),
        tickLower: Number(p.tickLower),
        tickUpper: Number(p.tickUpper),
        liquidity: String(p.liquidity ?? "0"),
        poolAddress: (p.poolAddress as string) ?? null,
        decimals0: 18,
        decimals1: 18,
        symbol0: String(p.symbol0 ?? "T0"),
        symbol1: String(p.symbol1 ?? "T1"),
        fee: Number(p.fee ?? 0),
        depositUsd: Number(p.depositUsd ?? 0),
        depositEth: Number(p.depositEth ?? 0),
        feesCollectedUsd: Number(p.feesCollectedUsd ?? 0),
        feesCollectedEth: Number(p.feesCollectedEth ?? 0),
        withdrawnUsd: Number(p.withdrawnUsd ?? 0),
        withdrawnEth: Number(p.withdrawnEth ?? 0),
      };

      // Prefer decimals from symbols heuristics if missing
      if (meta.symbol0 === "USDG" || meta.symbol1 === "USDG") {
        if (meta.symbol0 === "USDG") meta.decimals0 = 6;
        if (meta.symbol1 === "USDG") meta.decimals1 = 6;
      }

      const live = await getLiveValue(meta);
      if (!live) return null;

      return {
        tokenId: meta.tokenId,
        pool: `${meta.symbol0}/${meta.symbol1} ${feeTierLabel(meta.fee)}`,
        depositValueUsd: meta.depositUsd,
        depositValueEth: meta.depositEth,
        currentValueUsd: live.currentValueUsd + live.feeUnclaimedUsd,
        currentValueEth: live.currentValueEth + live.feeUnclaimedEth,
        principalUsd: live.principalUsd,
        principalEth: live.principalEth,
        unrealizedPnlUsd: live.unrealizedPnlUsd,
        unrealizedPnlEth: live.unrealizedPnlEth,
        feeUnclaimedUsd: live.feeUnclaimedUsd,
        feeUnclaimedEth: live.feeUnclaimedEth,
        feesCollectedUsd: meta.feesCollectedUsd,
        feesCollectedEth: meta.feesCollectedEth,
        inRange: live.inRange,
        amount0Human: live.amount0Human,
        amount1Human: live.amount1Human,
        lastUpdated: live.lastUpdated,
        costBasisEstimated: Boolean(p.costBasisEstimated),
        protocol: (p.protocol as string) ?? "v3",
      };
    }),
  );

  const rows = liveRows.filter(Boolean) as NonNullable<
    (typeof liveRows)[number]
  >[];

  const unrealizedPnlUsd = rows.reduce((s, r) => s + r.unrealizedPnlUsd, 0);
  const unrealizedPnlEth = rows.reduce((s, r) => s + r.unrealizedPnlEth, 0);
  const openValueUsd = rows.reduce((s, r) => s + r.currentValueUsd, 0);
  const openValueEth = rows.reduce((s, r) => s + r.currentValueEth, 0);

  // Realized from cache summary if present
  const summary = cache.summary as Record<string, number>;
  const realizedPnlUsd = Number(summary?.realizedPnlUsd ?? 0);
  const realizedPnlEth = Number(summary?.realizedPnlEth ?? 0);

  return NextResponse.json({
    address: address.toLowerCase(),
    positions: rows,
    totals: {
      unrealizedPnlUsd,
      unrealizedPnlEth,
      realizedPnlUsd,
      realizedPnlEth,
      totalPnlUsd: realizedPnlUsd + unrealizedPnlUsd,
      totalPnlEth: realizedPnlEth + unrealizedPnlEth,
      openValueUsd,
      openValueEth,
      openCount: rows.length,
    },
    lastUpdated: new Date().toISOString(),
  });
}
