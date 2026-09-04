/**
 * Reverse lookup: Uniswap V3/V4 position NFT id → current (or last) wallet.
 * RPC ownerOf first; Blockscout instance + transfers cover burned NFTs.
 */

import { getAddress, type Address, zeroAddress } from "viem";
import {
  ROBINHOOD,
  explorerAddress,
  explorerNft,
  explorerTx,
  getNpmAddress,
} from "@config/contracts";
import { npmAbi } from "./abis";
import { getPublicClient } from "./client";
import { getTokenMeta, getLivePosition, readPosition } from "./positions";
import { throttledRpc } from "./rpc-throttle";
import {
  decodeV4PositionInfo,
  getLiveV4Position,
  getV4PositionManager,
} from "./v4/positions";
import { v4PositionManagerAbi } from "./v4/abis";

const ZERO = zeroAddress.toLowerCase();

export type NftProtocol = "v3" | "v4";

export type NftLookupTransfer = {
  from: string;
  to: string;
  txHash: string;
  timestamp: string | null;
  blockNumber: number | null;
  type: "mint" | "burn" | "transfer";
};

export type NftLookupHit = {
  protocol: NftProtocol;
  tokenId: string;
  status: "open" | "closed" | "burned";
  /** Address to track: current owner, or last holder if burned. */
  wallet: string;
  owner: string | null;
  lastOwner: string | null;
  minter: string | null;
  contract: string;
  symbol0: string | null;
  symbol1: string | null;
  token0: string | null;
  token1: string | null;
  fee: number | null;
  tickLower: number | null;
  tickUpper: number | null;
  liquidity: string;
  amount0Human: number | null;
  amount1Human: number | null;
  unclaimed0Human: number | null;
  unclaimed1Human: number | null;
  inRange: boolean | null;
  mintedAt: string | null;
  burnedAt: string | null;
  mintTx: string | null;
  burnTx: string | null;
  transfers: NftLookupTransfer[];
  links: {
    nft: string;
    wallet: string;
    mintTx: string | null;
    burnTx: string | null;
  };
};

export type NftLookupResult = {
  tokenId: string;
  hits: NftLookupHit[];
};

function isZero(addr: string | null | undefined): boolean {
  return !addr || addr.toLowerCase() === ZERO;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const EXPLORER_HEADERS = {
  Accept: "application/json",
  // Blockscout/Cloudflare 403s bare Node fetch (no User-Agent).
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function fetchJson<T>(url: string, ms: number): Promise<T | null> {
  try {
    const res = await withTimeout(fetch(url, { headers: EXPLORER_HEADERS }), ms);
    if (!res.ok) {
      console.warn("[nft-lookup] http", res.status, url.split("?")[0]);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn(
      "[nft-lookup] fetch",
      url.split("?")[0],
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

function checksum(addr: string): string {
  try {
    return getAddress(addr as Address);
  } catch {
    return addr;
  }
}

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function topicAddress(topic: string | undefined): string {
  if (!topic || topic.length < 66) return "";
  return ("0x" + topic.slice(26)).toLowerCase();
}

type BsInstance = {
  id?: string;
  owner?: { hash?: string };
  token?: { address_hash?: string };
};

type BsTransferItem = {
  from?: { hash?: string };
  to?: { hash?: string };
  transaction_hash?: string;
  timestamp?: string;
  block_number?: number;
  type?: string;
};

function classifyTransfer(from: string, to: string): NftLookupTransfer["type"] {
  if (isZero(from)) return "mint";
  if (isZero(to)) return "burn";
  return "transfer";
}

async function fetchInstance(
  contract: string,
  tokenId: string,
): Promise<BsInstance | null> {
  const c = checksum(contract);
  return fetchJson<BsInstance>(
    `${ROBINHOOD.explorer}/api/v2/tokens/${c}/instances/${tokenId}`,
    12_000,
  );
}

async function fetchTransfersV2(
  contract: string,
  tokenId: string,
): Promise<NftLookupTransfer[]> {
  const c = checksum(contract);
  const data = await fetchJson<{ items?: BsTransferItem[] }>(
    `${ROBINHOOD.explorer}/api/v2/tokens/${c}/instances/${tokenId}/transfers`,
    12_000,
  );
  const items = data?.items ?? [];
  const out: NftLookupTransfer[] = [];
  for (const t of items) {
    const from = (t.from?.hash ?? "").toLowerCase();
    const to = (t.to?.hash ?? "").toLowerCase();
    const txHash = t.transaction_hash ?? "";
    if (!from && !to) continue;
    out.push({
      from,
      to,
      txHash,
      timestamp: t.timestamp ?? null,
      blockNumber: t.block_number ?? null,
      type: classifyTransfer(from, to),
    });
  }
  return out;
}

/** Full-history Transfer logs — works when the instance REST API 404s. */
async function fetchTransfersLogs(
  contract: string,
  tokenId: bigint,
): Promise<NftLookupTransfer[]> {
  const topic3 = "0x" + tokenId.toString(16).padStart(64, "0");
  const url =
    `${ROBINHOOD.explorer}/api?module=logs&action=getLogs` +
    `&fromBlock=0&toBlock=latest` +
    `&address=${checksum(contract)}` +
    `&topic0=${TRANSFER_TOPIC}&topic3=${topic3}&topic0_3_opr=and`;
  const json = await fetchJson<{
    status?: string;
    result?: Array<{
      topics?: string[];
      transactionHash?: string;
      blockNumber?: string;
      timeStamp?: string;
    }>;
  }>(url, 12_000);
  if (!json || json.status === "0" || !Array.isArray(json.result)) return [];
  const out: NftLookupTransfer[] = [];
  for (const l of json.result) {
    const from = topicAddress(l.topics?.[1]);
    const to = topicAddress(l.topics?.[2]);
    const bn = l.blockNumber
      ? Number(l.blockNumber.startsWith("0x") ? BigInt(l.blockNumber) : l.blockNumber)
      : null;
    let timestamp: string | null = null;
    if (l.timeStamp) {
      const sec = l.timeStamp.startsWith("0x")
        ? Number(BigInt(l.timeStamp))
        : Number(l.timeStamp);
      if (Number.isFinite(sec) && sec > 0) {
        timestamp = new Date(sec * 1000).toISOString();
      }
    }
    out.push({
      from,
      to,
      txHash: l.transactionHash ?? "",
      timestamp,
      blockNumber: Number.isFinite(bn as number) ? bn : null,
      type: classifyTransfer(from, to),
    });
  }
  return out;
}

async function fetchTransfers(
  contract: string,
  tokenId: bigint,
): Promise<NftLookupTransfer[]> {
  const viaV2 = await fetchTransfersV2(contract, tokenId.toString());
  const viaLogs = viaV2.length
    ? []
    : await fetchTransfersLogs(contract, tokenId);
  const out = viaV2.length ? viaV2 : viaLogs;
  out.sort((a, b) => (a.blockNumber ?? 0) - (b.blockNumber ?? 0));
  return out;
}

async function ownerOf(
  contract: Address,
  tokenId: bigint,
  abi: typeof npmAbi | typeof v4PositionManagerAbi,
): Promise<Address | null> {
  try {
    const owner = await withTimeout(
      throttledRpc(() =>
        getPublicClient().readContract({
          address: contract,
          abi,
          functionName: "ownerOf",
          args: [tokenId],
        }),
      ),
      8_000,
    );
    if (isZero(owner as string)) return null;
    return owner as Address;
  } catch {
    return null;
  }
}

async function v3Details(
  tokenId: bigint,
  owner: Address | null,
): Promise<{
  symbol0: string | null;
  symbol1: string | null;
  token0: string | null;
  token1: string | null;
  fee: number | null;
  tickLower: number | null;
  tickUpper: number | null;
  liquidity: bigint;
  amount0Human: number | null;
  amount1Human: number | null;
  unclaimed0Human: number | null;
  unclaimed1Human: number | null;
  inRange: boolean | null;
}> {
  const empty = {
    symbol0: null,
    symbol1: null,
    token0: null,
    token1: null,
    fee: null,
    tickLower: null,
    tickUpper: null,
    liquidity: 0n,
    amount0Human: null,
    amount1Human: null,
    unclaimed0Human: null,
    unclaimed1Human: null,
    inRange: null as boolean | null,
  };

  if (owner) {
    try {
      const live = await withTimeout(getLivePosition(tokenId, owner), 10_000);
      if (live) {
        return {
          symbol0: live.symbol0,
          symbol1: live.symbol1,
          token0: live.token0,
          token1: live.token1,
          fee: live.fee,
          tickLower: live.tickLower,
          tickUpper: live.tickUpper,
          liquidity: live.liquidity,
          amount0Human: live.amount0Human,
          amount1Human: live.amount1Human,
          unclaimed0Human: live.unclaimed0Human,
          unclaimed1Human: live.unclaimed1Human,
          inRange: live.inRange,
        };
      }
    } catch {
      /* fall through to raw */
    }
  }

  try {
    const raw = await withTimeout(readPosition(tokenId), 8_000);
    if (!raw || isZero(raw.token0)) return empty;
    const [m0, m1] = await Promise.all([
      getTokenMeta(raw.token0),
      getTokenMeta(raw.token1),
    ]);
    return {
      ...empty,
      symbol0: m0.symbol,
      symbol1: m1.symbol,
      token0: raw.token0,
      token1: raw.token1,
      fee: raw.fee,
      tickLower: raw.tickLower,
      tickUpper: raw.tickUpper,
      liquidity: raw.liquidity,
    };
  } catch {
    return empty;
  }
}

async function v4Details(
  tokenId: bigint,
  owner: Address | null,
): Promise<{
  symbol0: string | null;
  symbol1: string | null;
  token0: string | null;
  token1: string | null;
  fee: number | null;
  tickLower: number | null;
  tickUpper: number | null;
  liquidity: bigint;
  amount0Human: number | null;
  amount1Human: number | null;
  unclaimed0Human: number | null;
  unclaimed1Human: number | null;
  inRange: boolean | null;
}> {
  const empty = {
    symbol0: null,
    symbol1: null,
    token0: null,
    token1: null,
    fee: null,
    tickLower: null,
    tickUpper: null,
    liquidity: 0n,
    amount0Human: null,
    amount1Human: null,
    unclaimed0Human: null,
    unclaimed1Human: null,
    inRange: null as boolean | null,
  };

  if (owner) {
    try {
      const live = await withTimeout(getLiveV4Position(tokenId, owner), 10_000);
      const emptyPool =
        !!live &&
        live.liquidity === 0n &&
        live.fee === 0 &&
        live.tickLower === 0 &&
        live.tickUpper === 0 &&
        isZero(live.poolKey.currency0) &&
        isZero(live.poolKey.currency1);
      if (live && !emptyPool) {
        return {
          symbol0: live.symbol0,
          symbol1: live.symbol1,
          token0: live.token0,
          token1: live.token1,
          fee: live.fee,
          tickLower: live.tickLower,
          tickUpper: live.tickUpper,
          liquidity: live.liquidity,
          amount0Human: live.amount0Human,
          amount1Human: live.amount1Human,
          unclaimed0Human: live.unclaimed0Human,
          unclaimed1Human: live.unclaimed1Human,
          inRange: live.inRange,
        };
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const posm = getV4PositionManager();
    const res = await withTimeout(
      throttledRpc(() =>
        getPublicClient().readContract({
          address: posm,
          abi: v4PositionManagerAbi,
          functionName: "getPoolAndPositionInfo",
          args: [tokenId],
        }),
      ),
      8_000,
    );
    const pk = res[0] as {
      currency0: Address;
      currency1: Address;
      fee: number;
    };
    const info = res[1] as bigint;
    const { tickLower, tickUpper } = decodeV4PositionInfo(info);
    let liquidity = 0n;
    try {
      liquidity = (await withTimeout(
        throttledRpc(() =>
          getPublicClient().readContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: "getPositionLiquidity",
            args: [tokenId],
          }),
        ),
        6_000,
      )) as bigint;
    } catch {
      /* 0 */
    }
    if (isZero(pk.currency0) && isZero(pk.currency1) && liquidity === 0n) {
      return empty;
    }
    const t0 = isZero(pk.currency0) ? ROBINHOOD.wrapped : pk.currency0;
    const t1 = isZero(pk.currency1) ? ROBINHOOD.wrapped : pk.currency1;
    const [m0, m1] = await Promise.all([getTokenMeta(t0), getTokenMeta(t1)]);
    return {
      ...empty,
      symbol0: isZero(pk.currency0) ? "ETH" : m0.symbol,
      symbol1: isZero(pk.currency1) ? "ETH" : m1.symbol,
      token0: t0,
      token1: t1,
      fee: Number(pk.fee),
      tickLower,
      tickUpper,
      liquidity,
    };
  } catch {
    return empty;
  }
}

/** Burned V4 positions zero out pool key; infer pair from mint/burn ERC-20 moves. */
async function pairFromTx(
  txHash: string | null,
): Promise<{ token0: string; token1: string; symbol0: string; symbol1: string } | null> {
  if (!txHash) return null;
  const data = await fetchJson<{
    token_transfers?: Array<{
      token?: { address_hash?: string; symbol?: string; type?: string };
      token_type?: string;
    }>;
  }>(`${ROBINHOOD.explorer}/api/v2/transactions/${txHash}`, 10_000);
  const tokens = new Map<string, string>();
  for (const t of data?.token_transfers ?? []) {
    const typ = (t.token_type ?? t.token?.type ?? "").toUpperCase();
    if (typ && typ !== "ERC-20") continue;
    const addr = (t.token?.address_hash ?? "").toLowerCase();
    if (!addr || isZero(addr)) continue;
    tokens.set(addr, t.token?.symbol || addr.slice(0, 6));
  }
  if (tokens.size < 1) return null;
  const addrs = [...tokens.keys()].sort();
  const token0 = addrs[0];
  const token1 = addrs[1] ?? addrs[0];
  return {
    token0,
    token1,
    symbol0: tokens.get(token0) ?? "?",
    symbol1: tokens.get(token1) ?? "?",
  };
}

async function lookupProtocol(
  protocol: NftProtocol,
  tokenId: bigint,
): Promise<NftLookupHit | null> {
  const contract =
    protocol === "v3" ? getNpmAddress() : getV4PositionManager();
  const id = tokenId.toString();
  const abi = protocol === "v3" ? npmAbi : v4PositionManagerAbi;

  const [rpcOwner, instance, transfers] = await Promise.all([
    ownerOf(contract, tokenId, abi),
    fetchInstance(contract, id),
    fetchTransfers(contract, tokenId),
  ]);

  const bsOwnerRaw = instance?.owner?.hash ?? null;
  const bsOwner = isZero(bsOwnerRaw) ? null : (bsOwnerRaw as Address);
  const currentOwner = rpcOwner ?? bsOwner;

  const mint = transfers.find((t) => t.type === "mint");
  const burn = [...transfers].reverse().find((t) => t.type === "burn");
  const minter = mint && !isZero(mint.to) ? mint.to : null;
  const lastFromBurn = burn && !isZero(burn.from) ? burn.from : null;

  const lastOwner =
    currentOwner?.toLowerCase() ??
    lastFromBurn ??
    (transfers.length
      ? [...transfers].reverse().find((t) => !isZero(t.to))?.to ?? null
      : null);

  const burned = Boolean(burn) || (!currentOwner && Boolean(lastFromBurn));
  const exists =
    Boolean(currentOwner) ||
    Boolean(instance?.id) ||
    transfers.length > 0 ||
    Boolean(lastOwner);

  if (!exists) return null;

  const detailOwner = (currentOwner ?? lastOwner) as Address | null;
  let details =
    protocol === "v3"
      ? await v3Details(tokenId, detailOwner)
      : await v4Details(tokenId, detailOwner);

  if (!details.token0) {
    const inferred = await pairFromTx(burn?.txHash ?? mint?.txHash ?? null);
    if (inferred) {
      details = {
        ...details,
        token0: inferred.token0,
        token1: inferred.token1,
        symbol0: inferred.symbol0,
        symbol1: inferred.symbol1,
      };
    }
  }

  // Mapping-zero V3 position with no explorer evidence → not this protocol
  if (
    protocol === "v3" &&
    !currentOwner &&
    !instance?.id &&
    !transfers.length &&
    !details.token0
  ) {
    return null;
  }

  const wallet = (currentOwner ?? lastOwner ?? minter)?.toLowerCase();
  if (!wallet) return null;

  let status: NftLookupHit["status"];
  if (burned || !currentOwner) status = "burned";
  else if (details.liquidity === 0n) status = "closed";
  else status = "open";

  return {
    protocol,
    tokenId: id,
    status,
    wallet,
    owner: currentOwner?.toLowerCase() ?? null,
    lastOwner: lastOwner,
    minter,
    contract,
    symbol0: details.symbol0,
    symbol1: details.symbol1,
    token0: details.token0,
    token1: details.token1,
    fee: details.fee,
    tickLower: details.tickLower,
    tickUpper: details.tickUpper,
    liquidity: details.liquidity.toString(),
    amount0Human: details.amount0Human,
    amount1Human: details.amount1Human,
    unclaimed0Human: details.unclaimed0Human,
    unclaimed1Human: details.unclaimed1Human,
    inRange: details.inRange,
    mintedAt: mint?.timestamp ?? null,
    burnedAt: burn?.timestamp ?? null,
    mintTx: mint?.txHash ?? null,
    burnTx: burn?.txHash ?? null,
    transfers,
    links: {
      nft: explorerNft(protocol, id),
      wallet: explorerAddress(wallet),
      mintTx: mint?.txHash ? explorerTx(mint.txHash) : null,
      burnTx: burn?.txHash ? explorerTx(burn.txHash) : null,
    },
  };
}

export async function lookupNftByTokenId(
  tokenId: bigint,
): Promise<NftLookupResult> {
  const [v3, v4] = await Promise.all([
    lookupProtocol("v3", tokenId).catch((e) => {
      console.warn("[nft-lookup] v3", e instanceof Error ? e.message : e);
      return null;
    }),
    lookupProtocol("v4", tokenId).catch((e) => {
      console.warn("[nft-lookup] v4", e instanceof Error ? e.message : e);
      return null;
    }),
  ]);

  return {
    tokenId: tokenId.toString(),
    hits: [v3, v4].filter((h): h is NftLookupHit => h != null),
  };
}
