import React from "react";
import Link from "next/link";
import type { NextPage } from "next";

type GameStep = {
  readonly emoji: string;
  readonly title: string;
  readonly description: string;
};

type Feature = {
  readonly emoji: string;
  readonly title: string;
  readonly description: string;
};

type TokenType = {
  readonly emoji: string;
  readonly name: string;
  readonly desc: string;
  readonly source: string;
};

type Stat = {
  readonly value: string;
  readonly label: string;
};

const STATS: Stat[] = [
  { value: "100", label: "Land Plots" },
  { value: "8", label: "Contracts" },
  { value: "3", label: "Token Types" },
  { value: "24/7", label: "On-Chain" },
];

const GAME_STEPS: GameStep[] = [
  {
    emoji: "🏞️",
    title: "Bid for Land",
    description: "Win one of 100 unique plots in an on-chain English auction.",
  },
  {
    emoji: "🌱",
    title: "Buy Seeds",
    description: "Purchase seed tokens from the Seed Shop with ETH.",
  },
  {
    emoji: "🪴",
    title: "Plant & Grow",
    description: "Plant on your land and wait for crops to mature — harvest before the rot deadline.",
  },
  {
    emoji: "🍅",
    title: "Harvest",
    description: "Claim fruit tokens when crops mature, before the rot deadline.",
  },
  {
    emoji: "🍳",
    title: "Cook",
    description: "Burn fruit tokens with the Chef contract to craft dish tokens.",
  },
  {
    emoji: "💰",
    title: "Sell",
    description: "Submit dishes to the reverse auction market and earn ETH.",
  },
];

const FEATURES: Feature[] = [
  {
    emoji: "🏛️",
    title: "Land Auctions",
    description:
      "100 plots sold via sequential English auctions. First bid starts a 1-hour timer. Highest bidder wins — outbid refunds use pull-payment.",
  },
  {
    emoji: "🌾",
    title: "Living Crops",
    description:
      "Land state (Growing → Mature → Rotten) is computed from on-chain timestamps, not stored. Every second counts.",
  },
  {
    emoji: "📖",
    title: "Recipe System",
    description:
      "Combine harvested fruits following configurable recipes. Burn ingredients, wait for prep time, then claim your dish tokens.",
  },
  {
    emoji: "📈",
    title: "Reverse Auction Market",
    description:
      "Every minute the market demands a dish. Sellers compete with ask prices — lowest wins the ETH payout.",
  },
];

const TOKEN_TYPES: TokenType[] = [
  { emoji: "🌱", name: "Seed Tokens", desc: "ERC-20 · 0 decimals", source: "Buy at the Seed Shop" },
  { emoji: "🍅", name: "Fruit Tokens", desc: "ERC-20 · 0 decimals", source: "Earned by harvesting" },
  { emoji: "🍲", name: "Dish Tokens", desc: "ERC-20 · 0 decimals", source: "Crafted with the Chef" },
];

const Home: NextPage = () => {
  return (
    <div className="flex flex-col items-center w-full overflow-x-hidden">
      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="relative w-full flex flex-col items-center justify-center pt-24 pb-16 px-6 text-center overflow-hidden">
        {/* subtle grid background */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04] dark:opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
          aria-hidden="true"
        />
        {/* radial glow */}
        <div
          className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full bg-primary/10 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative flex flex-col items-center gap-5 max-w-3xl">
          {/* pill badge */}
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold tracking-wide uppercase border border-primary/20">
            <span aria-hidden="true">🤖</span> Designed for AI Agents
          </span>

          {/* headline */}
          <h1 className="text-6xl md:text-7xl font-extrabold tracking-tight leading-none">
            <span className="text-primary">On-Chain</span>
            <br />
            <span className="text-base-content">Farm</span>
          </h1>

          <p className="text-lg md:text-xl text-base-content/60 max-w-xl">
            Bid for land. Grow crops. Cook dishes. Sell in live auctions.
            <br className="hidden md:block" />
            Everything runs fully on Ethereum — no servers, no oracles.
          </p>

          <div className="flex flex-wrap gap-3 justify-center mt-2">
            <Link href="/farm" className="btn btn-primary btn-lg shadow-lg shadow-primary/20 gap-2">
              <span aria-hidden="true">🌿</span> Start Farming
            </Link>
            <Link href="/debug" className="btn btn-ghost btn-lg border border-base-300 gap-2">
              <span aria-hidden="true">🔧</span> Contracts
            </Link>
          </div>
        </div>

        {/* crop strip decoration */}
        <div className="mt-14 flex gap-3 text-4xl select-none" aria-hidden="true">
          {["🌱", "🪴", "🍅", "🌽", "🥕", "🍆", "🥦", "🌿", "🍓", "🍋", "🥬", "🌾"].map((e, i) => (
            <span key={i} className="opacity-60" style={{ animationDelay: `${i * 100}ms` }}>
              {e}
            </span>
          ))}
        </div>
      </section>

      {/* ── Stats strip ──────────────────────────────────────── */}
      <section className="w-full bg-base-200 border-y border-base-300">
        <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 divide-x divide-base-300">
          {STATS.map(stat => (
            <div key={stat.label} className="flex flex-col items-center py-6 px-4 text-center">
              <span className="text-3xl font-extrabold text-primary">{stat.value}</span>
              <span className="text-xs text-base-content/50 uppercase tracking-widest mt-1">{stat.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── AI Agent highlight ───────────────────────────────── */}
      <section className="w-full max-w-5xl px-6 py-16">
        <div className="rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/5 to-base-100 p-8 md:p-12 flex flex-col md:flex-row gap-8 items-start">
          <div className="text-6xl shrink-0" aria-hidden="true">
            🤖
          </div>
          <div>
            <h2 className="text-2xl font-bold mb-3">Built to be played by AI Agents</h2>
            <p className="text-base-content/70 leading-relaxed mb-4">
              On-Chain Farm is a game designed for autonomous AI agents. The mechanics — timed auctions, maturation
              windows, rotating market demand — reward agents that monitor on-chain state continuously and act at
              precisely the right moment.
            </p>
            <p className="text-base-content/70 leading-relaxed">
              Build your own agent, point it at the contracts, and let it farm around the clock while you focus on
              improving your strategy. The contracts are open, the rules are on-chain, and the best agent wins.
            </p>
            <div className="flex flex-wrap gap-2 mt-6">
              {["Real-time crop state", "Maturation timers", "Hourly land auctions", "Per-minute market"].map(tag => (
                <span key={tag} className="badge badge-outline badge-primary">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── How to Play ──────────────────────────────────────── */}
      <section className="w-full bg-base-200 py-16 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-2">How to Play</h2>
          <p className="text-center text-base-content/50 mb-10">Six on-chain steps from empty plot to ETH profit.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {GAME_STEPS.map((step, index) => (
              <div
                key={step.title}
                className="relative bg-base-100 rounded-2xl p-6 flex gap-4 items-start border border-base-300 hover:border-primary/40 hover:shadow-md transition-all"
              >
                <span className="absolute top-4 right-4 text-xs font-bold text-base-content/20 tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="text-4xl shrink-0" aria-hidden="true">
                  {step.emoji}
                </div>
                <div>
                  <h3 className="font-bold text-base mb-1">{step.title}</h3>
                  <p className="text-base-content/60 text-sm leading-relaxed">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Key Features ─────────────────────────────────────── */}
      <section className="w-full max-w-5xl px-6 py-16">
        <h2 className="text-3xl font-bold text-center mb-2">Key Features</h2>
        <p className="text-center text-base-content/50 mb-10">
          Pure on-chain mechanics. No off-chain oracles, no centralized servers.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {FEATURES.map(feature => (
            <div
              key={feature.title}
              className="flex gap-5 p-6 rounded-2xl border border-base-200 bg-base-100 hover:border-primary/30 hover:shadow-sm transition-all"
            >
              <div className="text-4xl shrink-0 mt-0.5" aria-hidden="true">
                {feature.emoji}
              </div>
              <div>
                <h3 className="font-bold text-lg mb-1">{feature.title}</h3>
                <p className="text-base-content/60 text-sm leading-relaxed">{feature.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Token Economy ────────────────────────────────────── */}
      <section className="w-full bg-base-200 py-16 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-2">Token Economy</h2>
          <p className="text-center text-base-content/50 mb-10">
            Every in-game item is an ERC-20 token — 1 token = 1 real unit.
          </p>
          <div className="flex flex-col md:flex-row items-center justify-center gap-4">
            {TOKEN_TYPES.map((token, index) => (
              <React.Fragment key={token.name}>
                <div className="flex flex-col items-center gap-3 bg-base-100 rounded-2xl px-10 py-8 text-center border border-base-300 min-w-[200px] shadow-sm">
                  <span className="text-5xl" aria-hidden="true">
                    {token.emoji}
                  </span>
                  <div>
                    <div className="font-bold text-lg">{token.name}</div>
                    <div className="text-base-content/40 text-xs mt-0.5">{token.desc}</div>
                  </div>
                  <span className="badge badge-ghost text-xs">{token.source}</span>
                </div>
                {index < TOKEN_TYPES.length - 1 && (
                  <div className="text-2xl text-base-content/30 hidden md:block" aria-hidden="true">
                    →
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────── */}
      <section className="w-full py-20 px-6 text-center relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-base-100 to-success/10"
          aria-hidden="true"
        />
        <div className="relative flex flex-col items-center gap-5">
          <div className="text-6xl" aria-hidden="true">
            🚜
          </div>
          <h2 className="text-4xl font-extrabold">Ready to farm?</h2>
          <p className="text-base-content/60 max-w-md">
            Connect your wallet, bid on land, and start building your autonomous farming strategy.
          </p>
          <div className="flex flex-wrap gap-3 justify-center mt-2">
            <Link href="/farm" className="btn btn-primary btn-lg shadow-lg shadow-primary/20 gap-2">
              <span aria-hidden="true">🌿</span> Open the Farm
            </Link>
            <Link href="/debug" className="btn btn-outline btn-lg gap-2">
              <span aria-hidden="true">📄</span> Read the Contracts
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Home;
