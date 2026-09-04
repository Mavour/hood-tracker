import Link from "next/link";
import { cn } from "@/lib/utils";

const ITEMS = [
  {
    id: "track" as const,
    href: "/",
    short: "Wallet",
    label: "Track wallet",
  },
  {
    id: "nft" as const,
    href: "/nft",
    short: "NFT ID",
    label: "NFT LP ID",
  },
];

export function SiteNav({
  active,
}: {
  active: "track" | "nft";
}) {
  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.03] p-0.5"
    >
      {ITEMS.map((item) => {
        const on = active === item.id;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "rounded-full px-3 py-2 text-[12px] font-semibold transition sm:px-3.5 sm:py-1.5 sm:text-[12px]",
              on
                ? "bg-rh-neon/15 text-rh-neon shadow-neon"
                : "text-rh-muted hover:bg-white/5 hover:text-rh-white",
            )}
          >
            <span className="sm:hidden">{item.short}</span>
            <span className="hidden sm:inline">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
