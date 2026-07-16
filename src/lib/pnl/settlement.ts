/**
 * Settlement finalization: compute final PnL and insert/update close_history.
 * Aligned with UniLP-Monitoring db.ts finalizeCloseHistory().
 *
 * Key formula (from UniLP-Monitoring):
 *   finalPnl = realized + totalReceived - deposits
 *   finalPnlBps = (finalPnl * 10000) / deposits
 *   threshold: |finalPnlBps| >= 50
 *
 * Since hood-tracker is read-only (no executor wallet), totalReceived is
 * reconstructed from cashflow events rather than balance measurement.
 */

import {
  upsertCloseHistory,
  getCashflowTotals,
  getPositionMetadata,
  updatePositionStatus,
} from "../db";
import { getTokenPriceLive } from "../pricing";
import { ROBINHOOD } from "@config/contracts";

const HISTORY_MIN_PNL_BPS = 50;

const STABLECOIN_ADDRESSES = new Set([
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC Base (legacy)
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isStablecoin(address: string): boolean {
  return STABLECOIN_ADDRESSES.has(address.toLowerCase());
}

function isEthLike(address: string): boolean {
  const lower = address.toLowerCase();
  return (
    lower === ZERO_ADDRESS ||
    lower === ROBINHOOD.wrapped.toLowerCase()
  );
}

/**
 * Compute final PnL from cashflow components.
 * Mirrors UniLP-Monitoring's finalizeCloseHistory SQL formula.
 */
export function computeFinalPnl(
  realized: number,
  totalReceived: number,
  deposits: number,
): { finalPnl: number; finalPnlBps: number } {
  if (deposits === 0) return { finalPnl: 0, finalPnlBps: 0 };
  const finalPnl = realized + totalReceived - deposits;
  const finalPnlBps = (finalPnl * 10000) / deposits;
  return { finalPnl, finalPnlBps };
}

/**
 * Finalize close history for a settled position.
 *
 * In read-only mode (hood-tracker), totalReceived is derived from:
 * - metadata.settlementQuoteFromClose (populated during indexing from collect/swap events)
 * - Or reconstructed from cashflow "withdrawal" entries tagged as settlement
 *
 * Trigger string: "settled" (read-only equivalent of executor's exitTrigger)
 */
export async function finalizeCloseHistory(
  positionId: string,
  trigger: string = "settled",
): Promise<void> {
  // Get position metadata
  const meta = (await getPositionMetadata(positionId)) ?? {};

  // Skip if already finalized or not in a finalizable state
  const status = meta.status as string | undefined;
  if (status === "settled") return;

  // Get cashflow totals (excluding settlement tx hashes if present)
  const closeTxHash = meta.closeTransactionHash as string | undefined;
  const swapTxHash = meta.swapTransactionHash as string | undefined;
  const excludedHashes = [closeTxHash, swapTxHash].filter(
    (h): h is string => typeof h === "string",
  );
  const { deposits, realized } = await getCashflowTotals(
    positionId,
    excludedHashes,
  );

  if (deposits === 0) return;

  // Get totalReceived from metadata (settlement proceeds)
  const totalReceivedStr =
    typeof meta.totalReceived === "string" ? meta.totalReceived : "0";
  const totalReceived = Number(totalReceivedStr);

  // Compute final PnL
  const { finalPnl, finalPnlBps } = computeFinalPnl(
    realized,
    totalReceived,
    deposits,
  );

  // Apply threshold filter (matches UniLP-Monitoring HISTORY_MIN_PNL_BPS = 50)
  if (finalPnlBps > -HISTORY_MIN_PNL_BPS && finalPnlBps < HISTORY_MIN_PNL_BPS) {
    return;
  }

  // Compute USD value
  const quoteToken = (meta.quoteToken as string) ?? "";
  let finalPnlUsd = 0;

  if (isStablecoin(quoteToken)) {
    finalPnlUsd = finalPnl;
  } else if (isEthLike(quoteToken)) {
    // For ETH-denominated PnL, convert to USD using live ETH price
    try {
      const ethPrice = await getTokenPriceLive(ROBINHOOD.wrapped);
      if (ethPrice.usd > 0) {
        finalPnlUsd = finalPnl * ethPrice.usd;
      }
    } catch {
      // If pricing fails, leave finalPnlUsd as 0
    }
  }

  // Insert or update close_history
  await upsertCloseHistory({
    positionId,
    chainId: ROBINHOOD.chainId,
    protocol: (meta.protocol as string) ?? "v3",
    token0: (meta.token0 as string) ?? "",
    token1: (meta.token1 as string) ?? "",
    quoteToken,
    finalPnlBps,
    finalPnlQuote: finalPnl,
    finalPnlUsd,
    trigger,
    closeTransactionHash: closeTxHash ?? null,
    swapTransactionHash: swapTxHash ?? null,
    openedAtBlock: (meta.openedAtBlock as number) ?? null,
  });

  // Mark position as settled
  await updatePositionStatus(positionId, "settled", {
    totalReceived: totalReceivedStr,
    finalPnl: finalPnl.toString(),
    finalPnlBps: finalPnlBps.toString(),
    settledAt: new Date().toISOString(),
  });
}
