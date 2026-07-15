/**
 * Robinhood Chain Uniswap V3 (and related) contract addresses.
 *
 * Sources:
 * - unicrit reference config (chain 4663)
 * - Blockscout token UNI-V3-POS: 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3
 *
 * TODO: re-verify from Uniswap official deployment list / Blockscout before prod.
 */

import type { Address } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663 as const;

export const ROBINHOOD = {
  chainId: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeSymbol: "ETH",
  wrappedSymbol: "WETH",
  explorer: "https://robinhoodchain.blockscout.com",
  dexscreenerSlug: "robinhood",
  defaultRpc: "https://rpc.mainnet.chain.robinhood.com",
  alchemyRpcTemplate: "https://robinhood-mainnet.g.alchemy.com/v2/",

  // Uniswap V3
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as Address,
  npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3" as Address,
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2" as Address,

  // Tokens
  wrapped: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,

  // Uniswap V4 — from unicrit / on-chain (TODO: re-verify Uniswap official deploys)
  // PoolManager, PositionManager (≠ V3 NPM), StateView
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address,
  v4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7" as Address,
  v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address,
} as const;

/** Structured contracts map (addendum V4) */
export const CONTRACTS = {
  v3: {
    positionManager: ROBINHOOD.npm,
    factory: ROBINHOOD.factory,
  },
  v4: {
    poolManager: ROBINHOOD.v4PoolManager,
    positionManager: ROBINHOOD.v4PositionManager,
    stateView: ROBINHOOD.v4StateView,
  },
} as const;

/** Protocol adapter id — schema designed so Pleiades AMM etc. can plug in later */
export type ProtocolAdapterId = "uniswap-v3" | "uniswap-v4" | "pleiades";

export function getNpmAddress(): Address {
  return (process.env.NPM_CONTRACT_ADDRESS as Address) || ROBINHOOD.npm;
}

export function getFactoryAddress(): Address {
  return (
    (process.env.UNISWAP_V3_FACTORY_ADDRESS as Address) || ROBINHOOD.factory
  );
}

export function explorerTx(hash: string): string {
  return `${ROBINHOOD.explorer}/tx/${hash}`;
}

export function explorerAddress(addr: string): string {
  return `${ROBINHOOD.explorer}/address/${addr}`;
}

export function explorerToken(tokenId: string | number | bigint): string {
  return `${ROBINHOOD.explorer}/token/${getNpmAddress()}/instance/${tokenId}`;
}
