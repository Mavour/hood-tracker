import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { getPnlCache, getEventsForToken } from "@/lib/db";
import { explorerTx, explorerToken, ROBINHOOD } from "@config/contracts";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { address: string; tokenId: string } },
) {
  const { address, tokenId } = params;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const cache = await getPnlCache(address);
  if (!cache) {
    return NextResponse.json({ error: "No data — track address first" }, { status: 404 });
  }

  const positions = cache.positions as Array<Record<string, unknown>>;
  const position = positions.find((p) => String(p.tokenId) === tokenId);
  if (!position) {
    return NextResponse.json({ error: "Position not found" }, { status: 404 });
  }

  const events = await getEventsForToken(tokenId);

  return NextResponse.json({
    position,
    events,
    links: {
      nft: explorerToken(tokenId),
      pool: position.poolAddress
        ? `${ROBINHOOD.explorer}/address/${position.poolAddress}`
        : null,
      explorerTx: (hash: string) => explorerTx(hash),
    },
  });
}
