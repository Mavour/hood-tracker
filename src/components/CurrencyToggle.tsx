"use client";

import { cn } from "@/lib/utils";

export type Currency = "usd" | "eth";

export function CurrencyToggle({
  value,
  onChange,
}: {
  value: Currency;
  onChange: (c: Currency) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-white/10 bg-rh-elevated/80 p-1 backdrop-blur">
      {(["usd", "eth"] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide transition-all",
            value === c
              ? "bg-rh-neon text-rh-black shadow-neon"
              : "text-rh-muted hover:text-rh-white",
          )}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
