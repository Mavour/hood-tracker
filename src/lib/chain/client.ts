/**
 * RPC client for Robinhood Chain (4663).
 * Mirrors unicrit: env RPC_4663 → ROBINHOOD_CHAIN_RPC → public default.
 * Alchemy is optional and only used when you pass a full Alchemy URL
 * (and have Robinhood Mainnet enabled on that Alchemy app).
 */

import {
  createPublicClient,
  http,
  fallback,
  type PublicClient,
  type Chain,
} from "viem";
import { ROBINHOOD, ROBINHOOD_CHAIN_ID } from "@config/contracts";

export const robinhoodChain: Chain = {
  id: ROBINHOOD_CHAIN_ID,
  name: ROBINHOOD.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD.defaultRpc] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: ROBINHOOD.explorer },
  },
};

const RPC_TIMEOUT_MS = 20_000;

/**
 * Same priority as unicrit `config.rpc[4663]`:
 *   process.env.RPC_4663 ?? public https://rpc.mainnet.chain.robinhood.com
 *
 * Plus aliases used by this app:
 *   ROBINHOOD_CHAIN_RPC, or ALCHEMY full URL if you opt in.
 */
export function resolveRpcUrl(): string {
  // unicrit-compatible
  if (process.env.RPC_4663?.trim()) return process.env.RPC_4663.trim();

  // hood-tracker alias
  if (process.env.ROBINHOOD_CHAIN_RPC?.trim()) {
    return process.env.ROBINHOOD_CHAIN_RPC.trim();
  }

  // Only auto-build Alchemy URL if key set AND user opted in
  if (
    process.env.ALCHEMY_API_KEY?.trim() &&
    process.env.USE_ALCHEMY === "1"
  ) {
    return `${ROBINHOOD.alchemyRpcTemplate}${process.env.ALCHEMY_API_KEY.trim()}`;
  }

  // unicrit default — public Robinhood RPC (no Alchemy network enable needed)
  return ROBINHOOD.defaultRpc;
}

/** Secondary URLs tried if primary fails (public always last resort). */
function rpcCandidates(): string[] {
  const primary = resolveRpcUrl();
  const list = [primary];
  const pub = ROBINHOOD.defaultRpc;
  if (primary !== pub) list.push(pub);
  return list;
}

let _client: PublicClient | null = null;
let _boundUrl: string | null = null;

export function getPublicClient(): PublicClient {
  const urls = rpcCandidates();
  const key = urls.join("|");
  if (_client && _boundUrl === key) return _client;

  const transports = urls.map((url) =>
    http(url, {
      timeout: RPC_TIMEOUT_MS,
      retryCount: 1,
      retryDelay: 500,
    }),
  );

  _client = createPublicClient({
    chain: robinhoodChain,
    transport:
      transports.length === 1
        ? transports[0]
        : fallback(transports, { rank: false }),
  });
  _boundUrl = key;

  if (process.env.NODE_ENV !== "production") {
    console.log("[rpc] Robinhood →", urls[0]);
    if (urls.length > 1) console.log("[rpc] fallback →", urls.slice(1).join(", "));
  }

  return _client;
}

export function getRpcUrl(): string {
  return resolveRpcUrl();
}

/** Quick connectivity check used by /api/health */
export async function pingRpc(): Promise<{
  ok: boolean;
  url: string;
  blockNumber?: string;
  error?: string;
}> {
  const url = resolveRpcUrl();
  try {
    const client = getPublicClient();
    const n = await client.getBlockNumber();
    return { ok: true, url: redactUrl(url), blockNumber: n.toString() };
  } catch (e) {
    return {
      ok: false,
      url: redactUrl(url),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function redactUrl(url: string): string {
  // hide API keys in logs/UI
  return url.replace(/\/v2\/[A-Za-z0-9_-]+/g, "/v2/***");
}
