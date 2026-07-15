import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isValidEthAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatUsd(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(2)}k`;
  if (a >= 1) return `${sign}$${a.toFixed(digits)}`;
  if (a >= 0.01) return `${sign}$${a.toFixed(4)}`;
  if (a === 0) return "$0.00";
  return `${sign}$${a.toFixed(6)}`;
}

export function formatEth(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "0 ETH";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1000) return `${sign}${a.toFixed(2)} ETH`;
  if (a >= 1) return `${sign}${a.toFixed(digits)} ETH`;
  if (a === 0) return "0 ETH";
  return `${sign}${a.toFixed(6)} ETH`;
}

export function formatPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function formatSigned(
  n: number,
  currency: "usd" | "eth",
): string {
  const body = currency === "usd" ? formatUsd(Math.abs(n)) : formatEth(Math.abs(n));
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body.replace(/^-/, "")}`;
  return body;
}

export function feeTierLabel(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}
