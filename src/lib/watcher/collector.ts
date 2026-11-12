import type { Address } from "viem";
import { getPublicClient } from "../chain/client";
import { npmAbi } from "../chain/abis";
import { getNpmAddress } from "@config/contracts";
import { listNpmTokenIds, getLivePosition, type LivePosition } from "../chain/positions";
import { getV4PositionManager, listV4TokenIds, getLiveV4Position, type LiveV4Position } from "../chain/v4/positions";
import { throttledRpc } from "../chain/rpc-throttle";
import { price0In1FromSqrt } from "../chain/math";
import { valueDual } from "../pricing";
import type { WatchedWallet } from "./config";
import type { Protocol, ProtocolResult, WatchPosition } from "./state";

type Live = LivePosition | LiveV4Position;
export type CollectorDependencies = {
  manager: (protocol: Protocol) => Address;
  balance: (manager: Address, owner: Address) => Promise<bigint>;
  ids: (protocol: Protocol, owner: Address) => Promise<bigint[]>;
  owner: (manager: Address, id: bigint) => Promise<string>;
  live: (protocol: Protocol, id: bigint, owner: Address) => Promise<Live | null>;
  value: typeof valueDual;
  now: () => number;
};

const dependencies: CollectorDependencies = {
  manager: (p) => p === "v3" ? getNpmAddress() : getV4PositionManager(),
  balance: (address, owner) => throttledRpc(() => getPublicClient().readContract({ address, abi: npmAbi, functionName: "balanceOf", args: [owner] })),
  ids: (p, owner) => p === "v3" ? listNpmTokenIds(owner) : listV4TokenIds(owner),
  owner: (address, id) => throttledRpc(() => getPublicClient().readContract({ address, abi: npmAbi, functionName: "ownerOf", args: [id] })),
  live: (p, id, owner) => p === "v3" ? getLivePosition(id, owner) : getLiveV4Position(id, owner),
  value: valueDual,
  now: Date.now,
};

/** Conservative protocol-level commit: never replace a good list with a partial scan. */
export function createCollector(deps: CollectorDependencies = dependencies) {
  return async (wallet: WatchedWallet): Promise<ProtocolResult[]> => {
    const results: ProtocolResult[] = [];
    const owner = wallet.address as Address;
    for (const protocol of ["v3", "v4"] as const) {
      try {
        const manager = deps.manager(protocol);
        const balance = await deps.balance(manager, owner);
        const ids = balance === 0n ? [] : await deps.ids(protocol, owner);
        // Existing discovery has provider limits. A mismatch is unknown, never zero.
        if (BigInt(new Set(ids.map(String)).size) !== balance) throw new Error("incomplete discovery");
        const positions: WatchPosition[] = [];
        for (const id of new Set(ids)) {
          if ((await deps.owner(manager, id)).toLowerCase() !== wallet.address.toLowerCase()) throw new Error("ownership changed");
          const live = await deps.live(protocol, id, owner);
          if (!live) throw new Error("position unavailable");
          if (live.liquidity === 0n) continue;
          if (live.sqrtPriceX96 <= 0n) throw new Error("pool price unavailable");
          const principal = await deps.value(live.amount0Human, live.amount1Human, live.token0, live.token1);
          const fees = await deps.value(live.unclaimed0Human, live.unclaimed1Human, live.token0, live.token1);
          const priced = !principal.pricingIncomplete && !fees.pricingIncomplete;
          const finite = (n: number) => Number.isFinite(n) ? n : null;
          positions.push({
            id: `4663:${manager.toLowerCase()}:${id}`, walletAddress: wallet.address,
            pair: `${live.symbol0}/${live.symbol1}`, protocol: `Uniswap ${protocol}`,
            rangeLow: finite(Math.pow(1.0001, live.tickLower) * Math.pow(10, live.decimals0 - live.decimals1)),
            rangeHigh: finite(Math.pow(1.0001, live.tickUpper) * Math.pow(10, live.decimals0 - live.decimals1)),
            price: finite(price0In1FromSqrt(live.sqrtPriceX96, live.decimals0, live.decimals1)),
            inRange: live.inRange,
            valueUsd: priced ? finite(principal.usd + fees.usd) : null,
            feesEarnedUsd: !fees.pricingIncomplete ? finite(fees.usd) : null,
            // Discovery does not establish historical cost basis or HODL benchmark.
            unrealizedPnlUsd: null, ilPct: null, openedAt: null,
            updatedAt: new Date(deps.now()).toISOString(), feesEstimated: true,
          });
        }
        results.push({ protocol, positions });
      } catch {
        // Do not leak an RPC URL/API key through provider exception messages.
        results.push({ protocol, error: `${protocol.toUpperCase()} scan incomplete (RPC, ownership or discovery); retry scheduled` });
      }
    }
    return results;
  };
}
