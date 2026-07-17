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
  unclaimedFeesUsd: 10,
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
// pnlBps = (-754 / 5000) * 10000 = -1508
assert(Math.abs(open.pnlBps! - (-754 / 5000) * 10000) < 1e-6, `pnlBps ${open.pnlBps}`);
assert(open.costBasisSource === "events", `costBasisSource ${open.costBasisSource}`);

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
  pnlBps: open.pnlBps,
  days: daily.length,
});

// --- V4 closed position with real amounts ---
const v4Events: PricedEvent[] = [
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
    amount0: 0.5,    // 0.5 WETH deposited
    amount1: 1000,   // 1000 USDC
    price0Usd: 2000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 2000,
  },
  {
    eventType: "collect",
    timestamp: 1_700_086_400,
    amount0: 0.01,   // earned 0.01 WETH in fees
    amount1: 20,
    price0Usd: 2100,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 2100,
  },
  {
    eventType: "decrease",
    timestamp: 1_700_172_800,
    amount0: 0.48,   // withdrew 0.48 WETH
    amount1: 980,    // withdrew 980 USDC
    price0Usd: 1900,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 1900,
  },
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
];

const v4closed = computePositionPnl({
  tokenId: "v4-1",
  events: v4Events,
  isOpen: false,
});

// deposit = 0.5*2000 + 1000*1 = 2000
assert(
  Math.abs(v4closed.depositUsd - 2000) < 1e-6,
  `v4 deposit got ${v4closed.depositUsd}`,
);
// withdrawn = 0.48*1900 + 980*1 = 912 + 980 = 1892
assert(
  Math.abs(v4closed.withdrawnUsd - 1892) < 1e-6,
  `v4 withdrawn got ${v4closed.withdrawnUsd}`,
);
// fees collected = 0.01*2100 + 20 = 41
assert(
  Math.abs(v4closed.feesCollectedUsd - 41) < 1e-6,
  `v4 fees got ${v4closed.feesCollectedUsd}`,
);
// net = withdrawn + fees - deposit = 1892 + 41 - 2000 = -67
assert(
  Math.abs(v4closed.netPnlUsd - -67) < 1e-6,
  `v4 net got ${v4closed.netPnlUsd}`,
);
// pnlBps for closed position with no currentValueUsd provided defaults to 0
// net = 1892 + 41 - 2000 = -67
assert(Math.abs(v4closed.pnlBps! - (-67 / 2000) * 10000) < 1e-6, `v4 pnlBps ${v4closed.pnlBps}`);

// V4 with mint deposit provided (blockNumber blocks all subsequent events)
const v4mint = computePositionPnl({
  tokenId: "v4-2",
  events: v4Events,
  isOpen: false,
  mintDeposit: {
    amount0: 0.5,
    amount1: 1000,
    price0Usd: 2000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 2000,
  },
});
// mint deposit used but no blockNumber → increase NOT filtered → deposit = 2000 + 2000 = 4000
assert(Math.abs(v4mint.depositUsd - 4000) < 1e-6, `v4 mint deposit ${v4mint.depositUsd}`);
// net = 1892 + 41 - 4000 = -2067
assert(Math.abs(v4mint.pnlBps! - (-2067 / 4000) * 10000) < 1e-6, `v4 mint pnlBps ${v4mint.pnlBps}`);

// V4 with mint deposit + blockNumbers: mint at block 1.7B blocks increase
const evtWithBlocks = v4Events.map((e, i) => ({
  ...e,
  blockNumber: 1_700_000_100 + i * 10,
}));
const v4mintBlocked = computePositionPnl({
  tokenId: "v4-4",
  events: evtWithBlocks,
  isOpen: false,
  mintDeposit: {
    amount0: 0.5,
    amount1: 1000,
    price0Usd: 2000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 2000,
    blockNumber: 1_700_000_120, // > increase block (1_700_000_100) → increase filtered
  },
});
assert(Math.abs(v4mintBlocked.pnlBps! - (-67 / 2000) * 10000) < 1e-6, `v4 mintBlocked pnlBps`);
assert(Math.abs(v4mintBlocked.depositUsd - 2000) < 1e-6, `v4 mintBlocked deposit ${v4mintBlocked.depositUsd}`);
assert(Math.abs(v4mintBlocked.netPnlUsd - -67) < 1e-6, `v4 mintBlocked net ${v4mintBlocked.netPnlUsd}`);

console.log("✓ V4 closed position tests passed");

// --- V4 closed position with real decrease + collect (no mintDeposit) ---
// Simulates the fixed flow: events have real human-readable amounts,
// no mint tx deposit → costBasisSource = "events"
const v4ClosedReal: PricedEvent[] = [
  {
    eventType: "transfer_mint",
    timestamp: 1_800_000_000,
    amount0: 0,
    amount1: 0,
    price0Usd: 0,
    price1Usd: 0,
    price0Eth: 0,
    price1Eth: 0,
  },
  {
    eventType: "increase",
    timestamp: 1_800_000_100,
    blockNumber: 100,
    amount0: 1.0,    // 1 WETH deposited
    amount1: 3000,   // 3000 USDC deposited
    price0Usd: 3000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3000,
  },
  {
    eventType: "collect",
    timestamp: 1_800_086_400,
    blockNumber: 200,
    amount0: 0.05,   // 0.05 WETH in fees claimed
    amount1: 100,    // 100 USDC in fees claimed
    price0Usd: 3200,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3200,
  },
  {
    eventType: "decrease",
    timestamp: 1_800_172_800,
    blockNumber: 300,
    amount0: 0.9,    // withdrew 0.9 WETH (close position)
    amount1: 2800,   // withdrew 2800 USDC
    price0Usd: 2800,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 2800,
  },
  {
    eventType: "transfer_burn",
    timestamp: 1_800_200_000,
    amount0: 0,
    amount1: 0,
    price0Usd: 0,
    price1Usd: 0,
    price0Eth: 0,
    price1Eth: 0,
  },
];

const v4closedReal = computePositionPnl({
  tokenId: "v4-real-1",
  events: v4ClosedReal,
  isOpen: false,
});

// deposit = 1.0*3000 + 3000*1 = 6000
assert(
  Math.abs(v4closedReal.depositUsd - 6000) < 1e-6,
  `v4 real deposit got ${v4closedReal.depositUsd}`,
);
// withdrawn = 0.9*2800 + 2800*1 = 2520 + 2800 = 5320
assert(
  Math.abs(v4closedReal.withdrawnUsd - 5320) < 1e-6,
  `v4 real withdrawn got ${v4closedReal.withdrawnUsd}`,
);
// fees collected = 0.05*3200 + 100 = 160 + 100 = 260
assert(
  Math.abs(v4closedReal.feesCollectedUsd - 260) < 1e-6,
  `v4 real fees got ${v4closedReal.feesCollectedUsd}`,
);
// net = withdrawn + fees - deposit = 5320 + 260 - 6000 = -420
assert(
  Math.abs(v4closedReal.netPnlUsd - -420) < 1e-6,
  `v4 real net got ${v4closedReal.netPnlUsd}`,
);
// pnlBps = (-420 / 6000) * 10000 = -700
assert(
  Math.abs(v4closedReal.pnlBps! - (-420 / 6000) * 10000) < 1e-6,
  `v4 real pnlBps got ${v4closedReal.pnlBps}`,
);

// --- V4 closed position with collect only (no decrease) ---
const v4CollectOnly: PricedEvent[] = [
  {
    eventType: "increase",
    timestamp: 1_900_000_000,
    blockNumber: 500,
    amount0: 2.0,
    amount1: 6000,
    price0Usd: 3000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3000,
  },
  {
    eventType: "collect",
    timestamp: 1_900_086_400,
    blockNumber: 600,
    amount0: 0.1,
    amount1: 200,
    price0Usd: 3000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3000,
  },
  {
    eventType: "decrease",
    timestamp: 1_900_172_800,
    blockNumber: 700,
    amount0: 2.0,
    amount1: 6000,
    price0Usd: 3000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3000,
  },
  {
    eventType: "transfer_burn",
    timestamp: 1_900_200_000,
    amount0: 0,
    amount1: 0,
    price0Usd: 0,
    price1Usd: 0,
    price0Eth: 0,
    price1Eth: 0,
  },
];

const v4collectOnly = computePositionPnl({
  tokenId: "v4-collect-1",
  events: v4CollectOnly,
  isOpen: false,
});

// deposit = 2*3000 + 6000*1 = 12000
assert(
  Math.abs(v4collectOnly.depositUsd - 12000) < 1e-6,
  `v4 collect deposit got ${v4collectOnly.depositUsd}`,
);
// withdrawn = 2*3000 + 6000*1 = 12000
assert(
  Math.abs(v4collectOnly.withdrawnUsd - 12000) < 1e-6,
  `v4 collect withdrawn got ${v4collectOnly.withdrawnUsd}`,
);
// fees = 0.1*3000 + 200 = 500
assert(
  Math.abs(v4collectOnly.feesCollectedUsd - 500) < 1e-6,
  `v4 collect fees got ${v4collectOnly.feesCollectedUsd}`,
);
// net = 12000 + 500 - 12000 = 500
assert(
  Math.abs(v4collectOnly.netPnlUsd - 500) < 1e-6,
  `v4 collect net got ${v4collectOnly.netPnlUsd}`,
);
// pnlBps = (500 / 12000) * 10000
assert(
  Math.abs(v4collectOnly.pnlBps! - (500 / 12000) * 10000) < 1e-6,
  `v4 collect pnlBps got ${v4collectOnly.pnlBps}`,
);

// --- Cost basis estimate fallback: no mint/increase events, only decrease + collect ---
const estimateEvents: PricedEvent[] = [
  {
    eventType: "collect",
    timestamp: 1_800_086_400,
    amount0: 0.05,
    amount1: 100,
    price0Usd: 3000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3000,
  },
  {
    eventType: "decrease",
    timestamp: 1_800_172_800,
    amount0: 0.9,
    amount1: 2800,
    price0Usd: 3000,
    price1Usd: 1,
    price0Eth: 1,
    price1Eth: 1 / 3000,
  },
];

const estimate = computePositionPnl({
  tokenId: "estimate-1",
  events: estimateEvents,
  currentValueUsd: 0,
  unclaimedFeesUsd: 0,
  isOpen: false,
});

assert(estimate.costBasisSource === "estimate", `costBasisSource ${estimate.costBasisSource}`);
// deposit = 0 (no increase/mint), withdrawn = 0.9*3000+2800=5500, fees=0.05*3000+100=250
// fallback estUsd = principal(0) + withdrawn(5500) + fees(250) = 5750
assert(Math.abs(estimate.depositUsd - 5750) < 1e-6, `estimate deposit ${estimate.depositUsd}`);
// net = 5500 + 250 - 5750 = 0
assert(Math.abs(estimate.netPnlUsd - 0) < 1e-6, `estimate net ${estimate.netPnlUsd}`);

console.log("✓ Cost basis estimate test passed");
console.log("✓ V4 closed with real amounts tests passed");
