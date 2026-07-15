import Image from "next/image";
import { cn } from "@/lib/utils";

export function BrandMark({
  className,
  compact,
  size = "md",
}: {
  className?: string;
  compact?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const box =
    size === "lg" ? "h-12 w-12" : size === "sm" ? "h-8 w-8" : "h-10 w-10";
  const img =
    size === "lg" ? 48 : size === "sm" ? 32 : 40;

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span
        className={cn(
          "relative shrink-0 overflow-hidden rounded-2xl shadow-neon ring-1 ring-black/20",
          box,
        )}
      >
        <Image
          src="/robinhood.png"
          alt="Robinhood"
          width={img}
          height={img}
          className="h-full w-full object-cover"
          priority
        />
      </span>
      {!compact && (
        <div className="min-w-0 leading-none">
          <p className="truncate text-[15px] font-bold tracking-tight text-rh-white sm:text-base">
            Robinhood{" "}
            <span className="bg-gradient-to-r from-rh-neon to-rh-green bg-clip-text text-transparent">
              PNL
            </span>
          </p>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-rh-muted">
            LP Viewer
          </p>
        </div>
      )}
    </div>
  );
}
