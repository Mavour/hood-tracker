"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Fingerprint,
  Loader2,
  Search,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  cn,
  feeTierLabel,
  parseNftTokenId,
  shortAddress,
} from "@/lib/utils";
import type { NftLookupHit, NftLookupResult } from "@/lib/chain/nft-lookup";

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function formatQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a >= 1_000_000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 5 });
}

function statusMeta(status: NftLookupHit["status"]): {
  text: string;
  className: string;
} {
  if (status === "open") {
    return { text: "Open", className: "bg-rh-green/15 text-rh-green" };
  }
  if (status === "closed") {
    return { text: "Closed · NFT held", className: "bg-rh-cyan/15 text-rh-cyan" };
  }
  return { text: "Burned", className: "bg-rh-red/15 text-rh-red" };
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 text-[12px] font-semibold text-rh-soft hover:border-rh-neon/30 hover:text-rh-white"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-rh-green" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function HitCard({ hit }: { hit: NftLookupHit }) {
  const st = statusMeta(hit.status);
  const pair =
    hit.symbol0 && hit.symbol1 ? `${hit.symbol0} / ${hit.symbol1}` : null;
  const minted = formatWhen(hit.mintedAt);
  const burnedAt = formatWhen(hit.burnedAt);
  const hasTicks =
    hit.tickLower != null &&
    hit.tickUpper != null &&
    !(hit.status === "burned" && hit.tickLower === 0 && hit.tickUpper === 0);
  const hasFee = hit.fee != null && hit.fee > 0;
  const hasOpenAmounts =
    hit.status === "open" &&
    hit.amount0Human != null &&
    hit.symbol0 != null &&
    hit.symbol1 != null;
  const showStats = pair || hasTicks || hasOpenAmounts;

  return (
    <article className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-gradient-to-br from-[#161a24] via-[#101218] to-[#0a0c12] p-5 shadow-glass sm:p-7">
      <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-rh-neon/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-16 left-1/4 h-36 w-36 rounded-full bg-rh-violet/20 blur-3xl" />

      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-rh-neon/15 px-2 py-0.5 text-[11px] font-black text-rh-neon">
              {hit.protocol.toUpperCase()}
            </span>
            <span
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px] font-bold",
                st.className,
              )}
            >
              {st.text}
            </span>
            {hit.inRange != null && hit.status === "open" && (
              <span
                className={cn(
                  "rounded-md px-2 py-0.5 text-[11px] font-semibold",
                  hit.inRange
                    ? "bg-rh-green/10 text-rh-green"
                    : "bg-rh-red/10 text-rh-red",
                )}
              >
                {hit.inRange ? "In range" : "Out of range"}
              </span>
            )}
            {hasFee && (
              <span className="rounded-md bg-rh-elevated px-2 py-0.5 text-[11px] font-medium text-rh-soft">
                {feeTierLabel(hit.fee!)}
              </span>
            )}
          </div>
          <h2 className="mt-2 text-xl font-black tracking-tight text-rh-white sm:text-2xl">
            {pair ?? `NFT #${hit.tokenId}`}
          </h2>
          <p className="mt-1 text-xs text-rh-muted">
            NFT #{hit.tokenId}
            {pair ? " · Uniswap position" : ""}
          </p>
        </div>
        <a
          href={hit.links.nft}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-black/20 px-3 text-[12px] font-semibold text-rh-muted hover:border-rh-neon/30 hover:text-rh-neon"
        >
          NFT
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="relative mt-5 rounded-2xl border border-white/[0.08] bg-black/35 p-4 sm:p-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-rh-muted">
          {hit.status === "burned" ? "Last wallet" : "Owner wallet"}
        </p>
        <p className="mt-2 font-mono text-[15px] font-semibold leading-snug text-rh-white sm:hidden">
          {shortAddress(hit.wallet)}
        </p>
        <p className="mt-2 hidden break-all font-mono text-[15px] font-semibold leading-snug text-rh-white sm:block">
          {hit.wallet}
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Link href={`/dashboard?address=${hit.wallet}`} className="sm:order-last sm:ml-auto">
            <Button size="lg" className="group w-full gap-2 sm:w-auto sm:min-w-[168px]">
              View wallet PnL
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Button>
          </Link>
          <div className="flex gap-2">
            <CopyAddress address={hit.wallet} />
            <a
              href={hit.links.wallet}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 text-[12px] font-semibold text-rh-soft hover:border-rh-neon/30 hover:text-rh-white"
            >
              Explorer
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
        {hit.minter && hit.minter !== hit.wallet && (
          <p className="mt-3 text-[11px] text-rh-muted">
            Minted by{" "}
            <span className="font-mono text-rh-soft">
              {shortAddress(hit.minter)}
            </span>
          </p>
        )}
      </div>

      {showStats && (
        <div
          className={cn(
            "relative mt-4 grid gap-2",
            hasTicks || hasOpenAmounts ? "sm:grid-cols-3" : "sm:grid-cols-1",
          )}
        >
          {pair && (
            <div className="rh-stat px-3.5 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-rh-muted">
                Pair
              </p>
              <p className="mt-1 text-sm font-bold text-rh-white">{pair}</p>
              {hasFee && (
                <p className="mt-0.5 text-[11px] text-rh-muted">
                  Fee {feeTierLabel(hit.fee!)}
                </p>
              )}
            </div>
          )}
          {hasTicks && (
            <div className="rh-stat px-3.5 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-rh-muted">
                Tick range
              </p>
              <p className="mt-1 font-mono text-sm font-bold text-rh-white">
                {hit.tickLower} → {hit.tickUpper}
              </p>
            </div>
          )}
          {hasOpenAmounts && (
            <div className="rh-stat px-3.5 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-rh-muted">
                Position
              </p>
              <p className="mt-1 text-sm font-bold text-rh-white">
                {formatQty(hit.amount0Human)} {hit.symbol0}
              </p>
              <p className="mt-0.5 text-[11px] text-rh-muted">
                {formatQty(hit.amount1Human)} {hit.symbol1}
              </p>
            </div>
          )}
        </div>
      )}

      {hasOpenAmounts &&
        hit.unclaimed0Human != null &&
        hit.unclaimed0Human + (hit.unclaimed1Human ?? 0) > 0 && (
          <p className="relative mt-3 text-sm text-rh-soft">
            Unclaimed{" "}
            <span className="font-semibold text-rh-white">
              {formatQty(hit.unclaimed0Human)} {hit.symbol0}
            </span>
            {" / "}
            <span className="font-semibold text-rh-white">
              {formatQty(hit.unclaimed1Human)} {hit.symbol1}
            </span>
          </p>
        )}

      {(minted || burnedAt) && (
        <ol className="relative mt-5 space-y-3 border-l border-white/10 pl-4">
          {minted && (
            <li className="relative">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-rh-neon shadow-neon" />
              <p className="text-[11px] font-semibold uppercase tracking-wider text-rh-muted">
                Minted
              </p>
              <p className="mt-0.5 text-sm text-rh-soft">
                {minted}
                {hit.links.mintTx && (
                  <>
                    {" · "}
                    <a
                      href={hit.links.mintTx}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-rh-white hover:text-rh-neon"
                    >
                      tx
                    </a>
                  </>
                )}
              </p>
            </li>
          )}
          {burnedAt && (
            <li className="relative">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-rh-red" />
              <p className="text-[11px] font-semibold uppercase tracking-wider text-rh-muted">
                Burned
              </p>
              <p className="mt-0.5 text-sm text-rh-soft">
                {burnedAt}
                {hit.links.burnTx && (
                  <>
                    {" · "}
                    <a
                      href={hit.links.burnTx}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-rh-white hover:text-rh-neon"
                    >
                      tx
                    </a>
                  </>
                )}
              </p>
            </li>
          )}
        </ol>
      )}
    </article>
  );
}

export function NftLookup() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initial = searchParams.get("id") ?? "";
  const [value, setValue] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NftLookupResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (raw: string) => {
      const id = parseNftTokenId(raw);
      if (id == null) {
        setError("Enter a numeric NFT LP id (e.g. 1442316)");
        setResult(null);
        return;
      }
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setError(null);
      setLoading(true);
      setResult(null);
      router.replace(`/nft?id=${id.toString()}`, { scroll: false });
      try {
        const res = await fetch(`/api/nft/${id.toString()}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        const data = (await res.json()) as NftLookupResult & { error?: string };
        if (ac.signal.aborted) return;
        if (!res.ok) {
          setError(data.error || "Lookup failed");
          return;
        }
        setResult(data);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError("Network error — retry in a moment");
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    if (initial && parseNftTokenId(initial) != null) {
      void run(initial);
    }
    return () => abortRef.current?.abort();
    // auto-run once from the URL
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void run(value);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-8">
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-rh-neon">
          Reverse lookup
        </p>
        <div className="mt-3 flex items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-rh-neon/10 text-rh-neon ring-1 ring-rh-neon/25 sm:h-14 sm:w-14">
            <Fingerprint className="h-6 w-6 sm:h-7 sm:w-7" />
          </div>
          <div className="min-w-0">
            <h1 className="text-balance text-3xl font-black leading-[1.1] tracking-tight text-rh-white sm:text-4xl">
              NFT LP{" "}
              <span className="bg-gradient-to-r from-rh-neon via-[#f0ff7a] to-rh-cyan bg-clip-text text-transparent">
                → wallet
              </span>
            </h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-rh-muted sm:text-[15px]">
              Paste a Uniswap V3 or V4 position token id. We resolve the current
              owner — or the last holder if the NFT was burned.
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={onSubmit} className="rh-card-glow p-3 sm:p-4">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-rh-muted" />
            <input
              type="text"
              inputMode="numeric"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder="Paste NFT id — 1442316"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              disabled={loading}
              className="h-12 w-full rounded-2xl border border-white/10 bg-rh-ink/80 pl-11 pr-4 font-mono text-sm text-rh-white placeholder:text-rh-muted/80 focus:border-rh-neon/50 focus:outline-none focus:ring-2 focus:ring-rh-neon/20 disabled:opacity-60"
            />
          </div>
          <Button
            type="submit"
            size="lg"
            disabled={loading}
            className="group h-12 gap-2 sm:min-w-[160px]"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Looking up…
              </>
            ) : (
              <>
                Find wallet
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </>
            )}
          </Button>
        </div>
        {error ? (
          <p className="mt-3 text-center text-sm text-rh-red sm:text-left">
            {error}
          </p>
        ) : (
          <p className="mt-3 text-center text-xs text-rh-muted sm:text-left">
            Read-only · V3 NPM + V4 PositionManager · chain 4663
          </p>
        )}
      </form>

      <div className="mt-4 flex flex-wrap gap-2">
        {["V3 + V4", "Burned NFTs too", "No wallet connect"].map((t) => (
          <span
            key={t}
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-rh-soft"
          >
            {t}
          </span>
        ))}
      </div>

      {loading && (
        <div className="rh-card-glow mt-6 p-6 sm:p-8">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-rh-neon/15">
              <Loader2 className="h-4 w-4 animate-spin text-rh-neon" />
            </span>
            <div>
              <p className="text-sm font-semibold text-rh-white">
                Resolving NFT #{parseNftTokenId(value)?.toString() ?? value}…
              </p>
              <p className="text-xs text-rh-muted">
                ownerOf on V3 &amp; V4, then explorer transfers if burned
              </p>
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-rh-elevated">
            <div className="h-full w-2/5 animate-pulse rounded-full bg-gradient-to-r from-rh-neon to-rh-green" />
          </div>
        </div>
      )}

      {!loading && result && result.hits.length === 0 && (
        <div className="mt-6 rounded-[1.5rem] border border-dashed border-white/12 bg-white/[0.02] px-5 py-10 text-center">
          <p className="text-base font-bold text-rh-white">
            No LP NFT with id {result.tokenId}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-rh-muted">
            Not minted on Uniswap V3 or V4 on Robinhood Chain. Double-check the
            id, or track a wallet instead.
          </p>
          <Link href="/" className="mt-5 inline-block">
            <Button variant="secondary" size="sm" className="gap-1.5">
              Track wallet
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      )}

      {!loading && result && result.hits.length > 0 && (
        <div className="mt-6 space-y-4">
          {result.hits.length > 1 && (
            <p className="text-xs font-semibold text-rh-muted">
              Found on {result.hits.length} protocols
            </p>
          )}
          {result.hits.map((hit) => (
            <HitCard key={`${hit.protocol}-${hit.tokenId}`} hit={hit} />
          ))}
        </div>
      )}
    </div>
  );
}
