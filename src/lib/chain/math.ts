/**
 * Uniswap V3 liquidity → token amounts (pure math, no SDK dependency at runtime).
 * Ported from Uniswap v3-core formulas.
 */

const Q96 = 2n ** 96n;

export function tickToSqrtPriceX96(tick: number): bigint {
  const absTick = Math.abs(tick);
  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;

  // sqrtPriceX96 = (ratio >> 32) + (remainder ? 1 : 0)
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function getAmount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  let a = sqrtRatioAX96;
  let b = sqrtRatioBX96;
  if (a > b) [a, b] = [b, a];
  if (a === 0n) return 0n;
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  return (numerator1 * numerator2) / b / a;
}

function getAmount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  let a = sqrtRatioAX96;
  let b = sqrtRatioBX96;
  if (a > b) [a, b] = [b, a];
  return (liquidity * (b - a)) / Q96;
}

export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };

  const sqrtA = tickToSqrtPriceX96(tickLower);
  const sqrtB = tickToSqrtPriceX96(tickUpper);

  if (sqrtPriceX96 <= sqrtA) {
    return {
      amount0: getAmount0Delta(sqrtA, sqrtB, liquidity),
      amount1: 0n,
    };
  }
  if (sqrtPriceX96 < sqrtB) {
    return {
      amount0: getAmount0Delta(sqrtPriceX96, sqrtB, liquidity),
      amount1: getAmount1Delta(sqrtA, sqrtPriceX96, liquidity),
    };
  }
  return {
    amount0: 0n,
    amount1: getAmount1Delta(sqrtA, sqrtB, liquidity),
  };
}

/** price of token0 in token1 units from sqrtPriceX96 */
export function price0In1FromSqrt(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 === 0n) return 0;
  // (sqrtP / 2^96)^2 * 10^(dec0 - dec1)
  const p = Number(sqrtPriceX96) / Number(Q96);
  const raw = p * p;
  return raw * 10 ** (decimals0 - decimals1);
}

export function price1In0FromSqrt(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const p0 = price0In1FromSqrt(sqrtPriceX96, decimals0, decimals1);
  return p0 > 0 ? 1 / p0 : 0;
}

export function humanAmount(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const s = raw.toString();
  if (decimals === 0) return Number(s);
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const frac = padded.slice(-decimals);
  return Number(`${neg ? "-" : ""}${whole}.${frac}`);
}
