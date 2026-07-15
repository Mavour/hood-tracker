/**
 * Lightweight self-check for PnL math (run: npx tsx src/lib/pnl/compute.test.ts)
 */
import {
  computePositionPnl,
  computeDailyPnl,
  aggregatePortfolio,
  type PricedEvent,
} from "./compute";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const events: PricedEvent[] = [
  {
    eventType: "transfer_mint",
    timestamp: 1_700_000_000,
    amount0: 0,
    amount1: 0,
    price0Usd: 0,
    price1Usd: 0,
    price0Eth: 0,
    price1Eth: 0,
  },
  {
    eventType: "increase",
    timestamp: 1_700_000_100,
    amount0: 1,
    amount1: 2000,
    price0Usd: 3000, // WETH
    price1Usd: 1, // USDG
    price0Eth: 1,
    price1Eth: 1 / 3000,
  },
  {
    eventType: "collect",
    timestamp: 1_700_086_400,
    amount0: 0.01,
    amount1: 5,
    price0Usd: 3100,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3100,
  },
  {
    eventType: "decrease",
    timestamp: 1_700_172_800,
    amount0: 0.5,
    amount1: 1000,
    price0Usd: 3200,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3200,
  },
];

const open = computePositionPnl({
  tokenId: "1",
  events,
  currentValueUsd: 1600,
  currentValueEth: 0.5,
  unclaimedFeesUsd: 10,
  unclaimedFeesEth: 0.003,
  isOpen: true,
});

// deposit = 1*3000 + 2000*1 = 5000
assert(Math.abs(open.depositUsd - 5000) < 1e-6, `deposit ${open.depositUsd}`);
// fees = 0.01*3100 + 5 = 36
assert(Math.abs(open.feesCollectedUsd - 36) < 1e-6, `fees ${open.feesCollectedUsd}`);
// withdrawn = 0.5*3200 + 1000 = 2600
assert(Math.abs(open.withdrawnUsd - 2600) < 1e-6, `wd ${open.withdrawnUsd}`);
// net = 2600 + 36 + 1600 + 10 - 5000 = -754
assert(Math.abs(open.netPnlUsd - -754) < 1e-6, `net ${open.netPnlUsd}`);
// feePnl = 36 + 10 = 46
assert(Math.abs(open.feePnlUsd - 46) < 1e-6, `feePnl ${open.feePnlUsd}`);
// pricePnl = -754 - 46 = -800
assert(Math.abs(open.pricePnlUsd - -800) < 1e-6, `pricePnl ${open.pricePnlUsd}`);

const closed = computePositionPnl({
  tokenId: "2",
  events: [
    ...events,
    {
      eventType: "transfer_burn",
      timestamp: 1_700_200_000,
      amount0: 0,
      amount1: 0,
      price0Usd: 0,
      price1Usd: 0,
      price0Eth: 0,
      price1Eth: 0,
    },
  ],
  isOpen: false,
});
assert(closed.currentValueUsd === 0, "closed current=0");
assert(closed.closedAt === 1_700_200_000, "closedAt set");

const daily = computeDailyPnl(
  new Map([["1", events]]),
  [open],
);
assert(daily.length >= 1, "daily rows");

const port = aggregatePortfolio([open, closed]);
assert(port.openCount === 1 && port.closedCount === 1, "counts");

console.log("✓ PnL compute tests passed");
console.log({
  openNet: open.netPnlUsd,
  feePnl: open.feePnlUsd,
  pricePnl: open.pricePnlUsd,
  days: daily.length,
});
