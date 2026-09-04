import { NextRequest, NextResponse } from "next/server";
import { parseNftTokenId } from "@/lib/utils";
import { lookupNftByTokenId } from "@/lib/chain/nft-lookup";
import { checkNftLookupRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const fetchCache = "force-no-store";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: { tokenId: string } },
) {
  const rl = await checkNftLookupRateLimit(clientIp(req));
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429 },
    );
  }

  const tokenId = parseNftTokenId(params.tokenId ?? "");
  if (tokenId == null) {
    return NextResponse.json(
      { error: "Enter a numeric NFT LP id (e.g. 1442316)" },
      { status: 400 },
    );
  }

  try {
    const result = await lookupNftByTokenId(tokenId);
    console.log(
      `[api/nft] #${result.tokenId} hits=${result.hits.length} ` +
        result.hits.map((h) => `${h.protocol}:${h.status}:${h.wallet.slice(0, 10)}`).join(","),
    );
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/nft]", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: "Lookup failed. RPC or explorer may be slow — retry." },
      { status: 502 },
    );
  }
}
