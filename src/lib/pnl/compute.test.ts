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
// source = events (no mint deposit provided)
assert(v4closed.costBasisSource === "events", `v4 source got ${v4closed.costBasisSource}`);
assert(v4closed.closedAt === 1_700_200_000, "v4 closedAt set");

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
assert(v4mint.costBasisSource === "mint", `v4 mint source got ${v4mint.costBasisSource}`);

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
assert(v4mintBlocked.costBasisSource === "mint", `v4 mintBlocked source`);
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
// feePnl = fees = 260
assert(
  Math.abs(v4closedReal.feePnlUsd - 260) < 1e-6,
  `v4 real feePnl got ${v4closedReal.feePnlUsd}`,
);
// pricePnl = net - feePnl = -420 - 260 = -680
assert(
  Math.abs(v4closedReal.pricePnlUsd - -680) < 1e-6,
  `v4 real pricePnl got ${v4closedReal.pricePnlUsd}`,
);
// source = events (no mint deposit)
assert(
  v4closedReal.costBasisSource === "events",
  `v4 real source got ${v4closedReal.costBasisSource}`,
);
assert(v4closedReal.closedAt === 1_800_200_000, "v4 real closedAt set");
assert(!v4closedReal.costBasisMissing, "v4 real costBasis not missing");

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

console.log("✓ V4 closed with real amounts tests passed");
