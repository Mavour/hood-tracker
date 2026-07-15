import Image from "next/image";
import { redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { BrandMark } from "@/components/BrandMark";
import { isValidEthAddress } from "@/lib/utils";

export default function DashboardPage({
  searchParams,
}: {
  searchParams: { address?: string };
}) {
  const address = searchParams.address?.trim() ?? "";
  if (!address || !isValidEthAddress(address)) {
    redirect("/");
  }

  return (
    <main className="relative min-h-screen pb-20">
      <div className="pointer-events-none absolute inset-0 bg-rh-ink" />
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-35" />
      <div
        className="pointer-events-none absolute left-1/2 top-0 h-64 w-[80%] -translate-x-1/2 bg-rh-neon/10 blur-[100px]"
        aria-hidden
      />

      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-black/55 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <a href="/" className="transition hover:opacity-90">
            <BrandMark />
          </a>
          <div className="flex items-center gap-2">
            <Image
              src="/robinhood.png"
              alt=""
              width={22}
              height={22}
              className="rounded-md shadow-neon"
            />
            <span className="hidden text-[11px] font-semibold text-rh-muted sm:inline">
              V3 · V4 · 4663
            </span>
          </div>
        </div>
      </header>

      <div className="relative z-10">
        <Dashboard address={address} />
      </div>
    </main>
  );
}
