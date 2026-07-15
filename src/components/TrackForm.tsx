"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isValidEthAddress } from "@/lib/utils";
import { Button } from "./ui/button";
import { ArrowRight, Search } from "lucide-react";

export function TrackForm({ initial }: { initial?: string }) {
  const router = useRouter();
  const [address, setAddress] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const a = address.trim();
    if (!isValidEthAddress(a)) {
      setError("Enter a valid 0x address (40 hex chars)");
      return;
    }
    setError(null);
    router.push(`/dashboard?address=${a}`);
  }

  return (
    <form onSubmit={onSubmit} className="w-full">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-rh-muted" />
          <input
            type="text"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setError(null);
            }}
            placeholder="0x… paste wallet address"
            spellCheck={false}
            autoComplete="off"
            className="h-12 w-full rounded-2xl border border-white/10 bg-rh-ink/80 pl-11 pr-4 font-mono text-sm text-rh-white placeholder:text-rh-muted/80 focus:border-rh-neon/50 focus:outline-none focus:ring-2 focus:ring-rh-neon/20"
          />
        </div>
        <Button type="submit" size="lg" className="group gap-2 sm:min-w-[148px]">
          View PNL
          <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </Button>
      </div>
      {error ? (
        <p className="mt-3 text-center text-sm text-rh-red sm:text-left">
          {error}
        </p>
      ) : (
        <p className="mt-3 text-center text-xs text-rh-muted sm:text-left">
          Read-only · no wallet connect · first paint aims under 10s
        </p>
      )}
    </form>
  );
}
