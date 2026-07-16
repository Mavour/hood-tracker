/**
 * Gas cost handling for PnL calculation.
 * Aligned with UniLP-Monitoring's gas tracking:
 * - PNL_INCLUDE_GAS env config (default: false = deduct gas from PnL)
 * - When quote token is native ETH and PNL_INCLUDE_GAS=false,
 *   gas costs are subtracted from totalReceived
 *
 * Since hood-tracker is read-only, we estimate gas from transaction receipts
 * rather than recording actual gas used during execution.
 */

import { getPublicClient } from "../chain/client";

/** Whether to include gas costs in PnL (default: false = deduct gas). */
export const PNL_INCLUDE_GAS =
  (process.env.PNL_INCLUDE_GAS ?? "false").toLowerCase() === "true";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Estimate gas cost in quote token units from a transaction receipt.
 * Returns 0 if unable to estimate.
 *
 * For native ETH quote: gas cost = gasUsed * effectiveGasPrice (in wei)
 * For ERC20 quote: returns 0 (gas is paid in native ETH, not quote token)
 */
export async function estimateGasCostQuote(
  txHash: string,
  quoteToken: string,
): Promise<number> {
  if (PNL_INCLUDE_GAS) return 0;

  const isNativeQuote =
    quoteToken.toLowerCase() === ZERO_ADDRESS ||
    quoteToken.toLowerCase() === "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // WETH

  if (!isNativeQuote) return 0;

  try {
    const client = getPublicClient();
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (!receipt) return 0;

    // gasUsed * effectiveGasPrice = gas cost in wei
    const gasCostWei = Number(receipt.gasUsed * receipt.effectiveGasPrice);
    return gasCostWei; // Returns in wei, caller needs to convert to ETH
  } catch {
    return 0;
  }
}

/**
 * Get settlement gas cost from position metadata.
 * Returns accumulated gas in wei, or 0n if not present.
 */
export function getSettlementGasWei(
  metadata: Record<string, unknown>,
): bigint {
  const value = metadata.settlementGasWei;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return 0n;
  return BigInt(value);
}

/**
 * Calculate totalReceived with gas deduction for native ETH quote positions.
 * Matches UniLP-Monitoring's saveSettlementBalance gas handling logic.
 *
 * @param totalReceivedRaw - Total received before gas deduction (in quote token units)
 * @param metadata - Position metadata containing settlementGasWei
 * @param quoteToken - Quote token address
 * @returns Adjusted totalReceived with gas deducted (if applicable)
 */
export function adjustTotalReceivedForGas(
  totalReceivedRaw: number,
  metadata: Record<string, unknown>,
  quoteToken: string,
): number {
  if (PNL_INCLUDE_GAS) return totalReceivedRaw;

  const isNativeQuote =
    quoteToken.toLowerCase() === ZERO_ADDRESS ||
    quoteToken.toLowerCase() === "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

  if (!isNativeQuote) return totalReceivedRaw;

  const gasWei = getSettlementGasWei(metadata);
  if (gasWei === 0n) return totalReceivedRaw;

  // Convert gas from wei to ETH and subtract
  const gasEth = Number(gasWei) / 1e18;
  const adjusted = totalReceivedRaw - gasEth;
  return adjusted > 0 ? adjusted : 0;
}
