import { NextResponse } from "next/server";
import { pingRpc, getRpcUrl } from "@/lib/chain/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rpc = await pingRpc();
  return NextResponse.json({
    ok: rpc.ok,
    chainId: 4663,
    rpc,
    hint: rpc.ok
      ? undefined
      : "Public RPC may be slow, or Alchemy app needs Robinhood Mainnet enabled. Unicrit uses RPC_4663=https://rpc.mainnet.chain.robinhood.com by default.",
    primaryConfigured: getRpcUrl().includes("alchemy")
      ? "alchemy"
      : "public-or-custom",
  });
}
