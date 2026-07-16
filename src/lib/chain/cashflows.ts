/**
 * Cashflow reconstruction: maps position events → cashflows table.
 * Aligned with UniLP-Monitoring discovery.ts cashflow logic.
 *
 * V3: IncreaseLiquidity → deposit, DecreaseLiquidity → withdrawal,
 *     Collect → fee (or withdrawal when closing)
 * V4: ModifyLiquidity (liqDelta>0) → deposit, ModifyLiquidity (liqDelta<0) → withdrawal,
 *     ERC20 Transfer from PM to owner → fee/withdrawal
 */

import { addCashflow } from "../db";
import type { PricedEvent } from "../pnl/compute";

/**
 * Compute quote-denominated value from token amounts at given prices.
 * Matches UniLP-Monitoring quoteValueFromPairAmounts().
 *
 * If quote token is token0: value = amount0 (quote-side) + amount1 * (amount0/amount1) ratio
 * If quote token is token1: value = amount1 (quote-side) + amount0 * (amount1/amount0) ratio
 *
 * Simplified: amount0 * price0 + amount1 * price1 (since prices are already in quote denomination).
 */
export function computeQuoteValue(
  amount0: number,
  amount1: number,
  price0Quote: number,
  price1Quote: number,
): number {
  return amount0 * price0Quote + amount1 * price1Quote;
}

/**
 * Reconstruct cashflows from priced events for a position.
 * This is the equivalent of UniLP-Monitoring's syncV3Cashflows / syncV4Cashflows
 * but operates on already-fetched priced events.
 *
 * Each event is mapped to a cashflow flow_type:
 * - increase → "deposit"
 * - decrease → "withdrawal"
 * - collect → "fee" (when position is still open) or "withdrawal" (when closing)
 */
export async function reconstructCashflows(
  positionId: string,
  events: PricedEvent[],
  isOpen: boolean,
): Promise<void> {
  for (const e of events) {
    if (!e.txHash) continue;

    if (e.eventType === "increase") {
      const quoteValue = computeQuoteValue(
        e.amount0,
        e.amount1,
        e.price0Usd,
        e.price1Usd,
      );
      if (quoteValue > 0 || (e.amount0 === 0 && e.amount1 === 0)) {
        await addCashflow(
          positionId,
          e.blockNumber ?? 0,
          e.txHash,
          "deposit",
          quoteValue,
          {
            amount0: e.amount0,
            amount1: e.amount1,
            price0Usd: e.price0Usd,
            price1Usd: e.price1Usd,
          },
        );
      }
    } else if (e.eventType === "decrease") {
      const quoteValue = computeQuoteValue(
        e.amount0,
        e.amount1,
        e.price0Usd,
        e.price1Usd,
      );
      if (quoteValue > 0) {
        await addCashflow(
          positionId,
          e.blockNumber ?? 0,
          e.txHash,
          "withdrawal",
          quoteValue,
          {
            amount0: e.amount0,
            amount1: e.amount1,
            price0Usd: e.price0Usd,
            price1Usd: e.price1Usd,
          },
        );
      }
    } else if (e.eventType === "collect") {
      const quoteValue = computeQuoteValue(
        e.amount0,
        e.amount1,
        e.price0Usd,
        e.price1Usd,
      );
      if (quoteValue > 0) {
        // When position is closing, collect = withdrawal (not fee)
        const flowType = isOpen ? "fee" : "withdrawal";
        await addCashflow(
          positionId,
          e.blockNumber ?? 0,
          e.txHash,
          flowType,
          quoteValue,
          {
            amount0: e.amount0,
            amount1: e.amount1,
            price0Usd: e.price0Usd,
            price1Usd: e.price1Usd,
          },
        );
      }
    }
  }
}

/**
 * Reconstruct cashflows from mint deposit + priced events.
 * The mint deposit is the authoritative first deposit (like UniLP-Monitoring's
 * hydrateV4OpeningCashflow).
 */
export async function reconstructCashflowsWithMint(
  positionId: string,
  events: PricedEvent[],
  mintDeposit: {
    amount0: number;
    amount1: number;
    price0Usd: number;
    price1Usd: number;
    price0Eth: number;
    price1Eth: number;
    blockNumber?: number;
    txHash?: string;
  } | null,
  isOpen: boolean,
): Promise<void> {
  // If mint deposit is available, record it as the first cashflow
  if (mintDeposit && (mintDeposit.amount0 > 0 || mintDeposit.amount1 > 0)) {
    const quoteValue = computeQuoteValue(
      mintDeposit.amount0,
      mintDeposit.amount1,
      mintDeposit.price0Usd,
      mintDeposit.price1Usd,
    );
    if (quoteValue > 0 && mintDeposit.txHash) {
      await addCashflow(
        positionId,
        mintDeposit.blockNumber ?? 0,
        mintDeposit.txHash,
        "deposit",
        quoteValue,
        {
          amount0: mintDeposit.amount0,
          amount1: mintDeposit.amount1,
          price0Usd: mintDeposit.price0Usd,
          price1Usd: mintDeposit.price1Usd,
          source: "mint",
        },
      );
    }
  }

  // Reconstruct remaining cashflows from events
  // Skip increase events that overlap with the mint deposit block
  const mintBlock = mintDeposit?.blockNumber;
  const filteredEvents = mintBlock
    ? events.filter(
        (e) =>
          e.eventType !== "increase" || (e.blockNumber ?? 0) > mintBlock,
      )
    : events;

  await reconstructCashflows(positionId, filteredEvents, isOpen);
}
