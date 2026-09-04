import { Suspense } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { SiteNav } from "@/components/SiteNav";
import { NftLookup } from "@/components/NftLookup";

export const metadata = {
  title: "NFT LP ID → wallet · Robinhood PNL",
  description:
    "Look up the wallet that owns a Uniswap V3 or V4 LP NFT on Robinhood Chain.",
};

export default function NftLookupPage() {
  return (
    <main className="relative min-h-screen overflow-hidden pb-20">
      <div className="pointer-events-none absolute inset-0 bg-rh-ink" />
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-45" />
      <div
        className="pointer-events-none absolute -left-32 top-0 h-[420px] w-[420px] rounded-full bg-rh-neon/20 blur-[120px]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute right-[-8%] top-24 h-[360px] w-[360px] rounded-full bg-rh-violet/22 blur-[100px]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-0 left-1/3 h-[240px] w-[420px] rounded-full bg-rh-cyan/10 blur-[90px]"
        aria-hidden
      />

      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-black/55 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="min-w-0 transition hover:opacity-90">
            <span className="sm:hidden">
              <BrandMark compact size="sm" />
            </span>
            <span className="hidden sm:block">
              <BrandMark />
            </span>
          </Link>
          <SiteNav active="nft" />
        </div>
      </header>

      <div className="relative z-10">
        <Suspense
          fallback={
            <div className="px-4 py-16 text-center text-sm text-rh-muted">
              Loading…
            </div>
          }
        >
          <NftLookup />
        </Suspense>
      </div>
    </main>
  );
}
