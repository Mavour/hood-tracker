import Image from "next/image";
import { TrackForm } from "@/components/TrackForm";
import { BrandMark } from "@/components/BrandMark";
import {
  Activity,
  Layers,
  Lock,
  Sparkles,
  TrendingUp,
  Zap,
} from "lucide-react";

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* layered atmosphere */}
      <div className="pointer-events-none absolute inset-0 bg-rh-ink" />
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-50" />
      <div
        className="pointer-events-none absolute -left-40 top-0 h-[520px] w-[520px] rounded-full bg-rh-neon/20 blur-[120px]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute right-[-10%] top-20 h-[420px] w-[420px] rounded-full bg-rh-violet/25 blur-[100px]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-0 left-1/3 h-[300px] w-[500px] rounded-full bg-rh-cyan/10 blur-[90px]"
        aria-hidden
      />

      <header className="relative z-20 border-b border-white/[0.07] bg-black/30 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-8">
          <BrandMark size="md" />
          <nav className="flex items-center gap-2 sm:gap-3">
            <span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-rh-soft md:inline-flex">
              <Zap className="h-3.5 w-3.5 text-rh-neon" />
              First paint &lt; 10s
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-rh-neon/30 bg-rh-neon/10 px-3 py-1.5 text-[11px] font-bold text-rh-neon">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rh-neon opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-rh-neon" />
              </span>
              Robinhood Chain
            </span>
          </nav>
        </div>
      </header>

      <div className="relative z-10 mx-auto grid max-w-7xl gap-12 px-4 py-12 sm:px-8 lg:grid-cols-12 lg:gap-10 lg:py-16">
        {/* LEFT — copy + form */}
        <section className="flex flex-col justify-center lg:col-span-6">
          <div className="mb-6 flex items-center gap-3">
            <div className="relative h-14 w-14 overflow-hidden rounded-2xl shadow-neon ring-2 ring-rh-neon/40 sm:h-16 sm:w-16">
              <Image
                src="/robinhood.png"
                alt="Robinhood logo"
                fill
                className="object-cover"
                priority
              />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-rh-neon">
                Robinhood PNL
              </p>
              <p className="text-sm font-medium text-rh-muted">
                LP Viewer for Chain 4663
              </p>
            </div>
          </div>

          <h1 className="text-balance text-4xl font-black leading-[1.05] tracking-tight text-rh-white sm:text-5xl xl:text-6xl">
            Liquidity PNL,
            <span className="mt-1 block bg-gradient-to-r from-rh-neon via-[#f0ff7a] to-rh-cyan bg-clip-text text-transparent">
              crystal clear.
            </span>
          </h1>

          <p className="mt-5 max-w-lg text-base leading-relaxed text-rh-muted sm:text-lg">
            Track Uniswap{" "}
            <span className="font-semibold text-rh-soft">V3 &amp; V4</span>{" "}
            positions on Robinhood Chain. Live open marks, claimed fees, and
            portfolio history —{" "}
            <span className="text-rh-soft">no wallet connect</span>.
          </p>

          <div className="mt-8 rh-card-glow p-3 sm:p-4">
            <TrackForm />
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {["Read-only", "No keys", "V3 + V4", "Claimed fees"].map((t) => (
              <span
                key={t}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-rh-soft"
              >
                {t}
              </span>
            ))}
          </div>
        </section>

        {/* RIGHT — mock terminal / dashboard panel */}
        <section className="relative lg:col-span-6">
          <div className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-rh-neon/20 via-rh-violet/10 to-transparent blur-2xl" />
          <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-gradient-to-b from-[#141822] to-[#0a0c12] shadow-glass">
            {/* window chrome */}
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              </div>
              <div className="flex items-center gap-2">
                <Image
                  src="/robinhood.png"
                  alt=""
                  width={18}
                  height={18}
                  className="rounded-md"
                />
                <span className="text-[11px] font-semibold text-rh-muted">
                  portfolio.live
                </span>
              </div>
              <span className="rounded-md bg-rh-green/15 px-2 py-0.5 text-[10px] font-bold text-rh-green">
                LIVE
              </span>
            </div>

            <div className="space-y-4 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-rh-muted">
                    Total LP PNL
                  </p>
                  <p className="mt-1 text-4xl font-black tracking-tight text-rh-green sm:text-5xl">
                    +$1,284.40
                  </p>
                  <p className="mt-1 text-sm font-semibold text-rh-green/90">
                    +12.4% · 30d
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/30 p-2">
                  <Image
                    src="/robinhood.png"
                    alt="Robinhood"
                    width={44}
                    height={44}
                    className="rounded-xl"
                  />
                </div>
              </div>

              {/* mini chart bars */}
              <div className="flex h-16 items-end gap-1.5 rounded-2xl border border-white/[0.06] bg-black/25 px-3 py-2">
                {[40, 55, 35, 70, 48, 82, 60, 95, 72, 88, 65, 100].map((h, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-sm bg-gradient-to-t from-rh-green/40 to-rh-neon"
                    style={{ height: `${h}%`, opacity: 0.55 + (i % 3) * 0.15 }}
                  />
                ))}
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[
                  { l: "Realized", v: "+$840", c: "text-rh-green" },
                  { l: "Unrealized", v: "+$444", c: "text-rh-neon" },
                  { l: "Fees", v: "+$128", c: "text-rh-cyan" },
                ].map((x) => (
                  <div
                    key={x.l}
                    className="rounded-2xl border border-white/[0.06] bg-white/[0.03] px-3 py-3"
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-rh-muted">
                      {x.l}
                    </p>
                    <p className={`mt-1 font-mono text-sm font-bold ${x.c}`}>
                      {x.v}
                    </p>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                {[
                  {
                    pair: "WETH / JUGGERNAUT",
                    tag: "V3",
                    pnl: "+4.1%",
                    fee: "1%",
                  },
                  {
                    pair: "USDG / ETH",
                    tag: "V4",
                    pnl: "+1.8%",
                    fee: "0.3%",
                  },
                ].map((row) => (
                  <div
                    key={row.pair}
                    className="flex items-center justify-between rounded-2xl border border-white/[0.06] bg-gradient-to-r from-white/[0.04] to-transparent px-3.5 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rh-neon/15 text-xs font-black text-rh-neon">
                        {row.tag}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-rh-white">
                          {row.pair}
                        </p>
                        <p className="text-[11px] text-rh-muted">
                          Fee {row.fee} · In range
                        </p>
                      </div>
                    </div>
                    <p className="font-mono text-sm font-bold text-rh-green">
                      {row.pnl}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* bottom feature band */}
      <section className="relative z-10 border-t border-white/[0.06] bg-black/40 backdrop-blur-xl">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 py-10 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
          {[
            {
              icon: Lock,
              t: "Zero custody",
              d: "Public address only. We never ask for a signature.",
            },
            {
              icon: Activity,
              t: "Live marks",
              d: "Open LPs refresh while you watch. Fees split claimed vs unclaimed.",
            },
            {
              icon: Layers,
              t: "V3 + V4",
              d: "One surface for classic NPM and Uniswap v4 PositionManager.",
            },
            {
              icon: TrendingUp,
              t: "History path",
              d: "First paint is live. Cost basis & closed PnL fill in after.",
            },
          ].map((f) => (
            <div
              key={f.t}
              className="group rounded-3xl border border-white/[0.07] bg-gradient-to-b from-white/[0.05] to-transparent p-5 transition hover:border-rh-neon/25 hover:shadow-neon"
            >
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-rh-neon/10 text-rh-neon ring-1 ring-rh-neon/20">
                <f.icon className="h-5 w-5" />
              </div>
              <p className="font-semibold text-rh-white">{f.t}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-rh-muted">
                {f.d}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer className="relative z-10 border-t border-white/[0.06] py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-8">
          <div className="flex items-center gap-3">
            <Image
              src="/robinhood.png"
              alt=""
              width={28}
              height={28}
              className="rounded-lg"
            />
            <div>
              <p className="text-sm font-bold text-rh-white">
                Robinhood PNL LP Viewer
              </p>
              <p className="text-[11px] text-rh-muted">
                Analytics only · Unofficial fan tool
              </p>
            </div>
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-rh-muted">
            <Sparkles className="h-3.5 w-3.5 text-rh-neon" />
            Not affiliated with Robinhood Markets or Uniswap
          </p>
        </div>
      </footer>
    </main>
  );
}
