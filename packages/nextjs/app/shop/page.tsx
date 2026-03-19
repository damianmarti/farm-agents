"use client";

import { useState } from "react";
import type { NextPage } from "next";
import { formatEther } from "viem";
import { useAccount } from "wagmi";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";

// ── Static catalog ─────────────────────────────────────────────────────────
// Names, symbols, emojis and recipe relationships are fixed at deploy time.

type SeedInfo = {
  readonly id: number;
  readonly name: string;
  readonly symbol: string;
  readonly emoji: string;
  readonly usedIn: readonly string[]; // dish names this seed's fruit is used in
};

const SEEDS: readonly SeedInfo[] = [
  // ── Vegetables ────────────────────────────────────────────────────────────
  { id: 0, name: "Tomato", symbol: "TOM", emoji: "🍅", usedIn: ["Tomato Soup", "Mixed Pickle"] },
  { id: 1, name: "Lettuce", symbol: "LET", emoji: "🥬", usedIn: ["Green Salad"] },
  { id: 2, name: "Carrot", symbol: "CAR", emoji: "🥕", usedIn: ["Carrot Cake", "Mixed Pickle"] },
  { id: 3, name: "Potato", symbol: "POT", emoji: "🥔", usedIn: ["Pumpkin Pie"] },
  { id: 4, name: "Onion", symbol: "ONI", emoji: "🧅", usedIn: ["Tomato Soup", "Mixed Pickle"] },
  { id: 5, name: "Pepper", symbol: "PEP", emoji: "🫑", usedIn: ["Mixed Pickle"] },
  { id: 6, name: "Cucumber", symbol: "CUC", emoji: "🥒", usedIn: ["Green Salad", "Mixed Pickle"] },
  { id: 7, name: "Spinach", symbol: "SPI", emoji: "🥬", usedIn: ["Green Salad"] },
  { id: 8, name: "Pumpkin", symbol: "PUMP", emoji: "🎃", usedIn: ["Pumpkin Pie"] },
  { id: 9, name: "Broccoli", symbol: "BROC", emoji: "🥦", usedIn: [] },
  // ── Fruits ────────────────────────────────────────────────────────────────
  { id: 10, name: "Strawberry", symbol: "SBERRY", emoji: "🍓", usedIn: ["Fruit Salad"] },
  { id: 11, name: "Watermelon", symbol: "WFRUIT", emoji: "🍉", usedIn: ["Watermelon Smoothie"] },
  { id: 12, name: "Blueberry", symbol: "BBFRT", emoji: "🫐", usedIn: ["Fruit Salad"] },
  { id: 13, name: "Mango", symbol: "MNGO", emoji: "🥭", usedIn: ["Mango Juice"] },
  { id: 14, name: "Pineapple", symbol: "PINE", emoji: "🍍", usedIn: ["Pineapple Sorbet"] },
  { id: 15, name: "Lemon", symbol: "LMN", emoji: "🍋", usedIn: ["Lemonade", "Carrot Cake", "Watermelon Smoothie"] },
  { id: 16, name: "Grape", symbol: "GRP", emoji: "🍇", usedIn: ["Fruit Salad"] },
  { id: 17, name: "Peach", symbol: "PCHFRT", emoji: "🍑", usedIn: [] },
  { id: 18, name: "Cherry", symbol: "CHRRY", emoji: "🍒", usedIn: ["Pineapple Sorbet"] },
  { id: 19, name: "Melon", symbol: "MLON", emoji: "🍈", usedIn: [] },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtSecs(secs: bigint | undefined): string {
  if (secs === undefined) return "—";
  const s = Number(secs);
  if (s < 60) return `${s}s`;
  const m = s / 60;
  return `${m}min`;
}

function fmtEth(wei: bigint | undefined): string {
  if (wei === undefined) return "—";
  // Remove trailing zeros: "0.000015000" → "0.000015"
  return formatEther(wei)
    .replace(/(\.\d*[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

// ── Stat row (used inside a grid-cols-2 parent) ────────────────────────────

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-base-content/50">{label}</span>
      <span className="font-mono font-semibold text-right">{value}</span>
    </>
  );
}

// ── Seed card ─────────────────────────────────────────────────────────────

type SeedCardProps = {
  seed: SeedInfo;
  onBuy: (seedId: number, qty: number, pricePerSeed: bigint) => Promise<void>;
  isBuying: boolean;
};

function SeedCard({ seed, onBuy, isBuying }: SeedCardProps) {
  const [qty, setQty] = useState(1);
  const { isConnected } = useAccount();

  // farmConfigs tuple indices:
  // [0]=maxCapacity [1]=waterInterval [2]=maturationTime [3]=rotTime
  // [4]=cleanupCost [5]=harvestYield  [6]=fruitToken     [7]=configured
  const { data: cfg } = useScaffoldReadContract({
    contractName: "FarmManager",
    functionName: "farmConfigs",
    args: [BigInt(seed.id)],
  });

  const { data: price } = useScaffoldReadContract({
    contractName: "SeedShop",
    functionName: "seedPrice",
    args: [BigInt(seed.id)],
  });

  const totalCost = price !== undefined ? price * BigInt(qty) : undefined;
  const configured = cfg?.[7] ?? false;

  const handleBuy = () => {
    if (price !== undefined) onBuy(seed.id, qty, price);
  };

  return (
    <div className="card bg-base-100 border border-base-200 shadow-sm flex flex-col">
      <div className="card-body gap-3 flex-1 p-4">
        {/* ── Header: emoji + name + price ── */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="text-3xl leading-none" aria-hidden="true">
              {seed.emoji}
            </span>
            <div>
              <p className="font-bold leading-tight">{seed.name}</p>
              <p className="text-xs text-base-content/40 font-mono">{seed.symbol} seed</p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-base font-extrabold text-primary tabular-nums">
              {price !== undefined ? fmtEth(price) : "—"}
            </p>
            <p className="text-xs text-base-content/40">ETH / seed</p>
          </div>
        </div>

        {/* ── Farming stats ── */}
        {configured && cfg ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs bg-base-200/60 rounded-lg px-3 py-2.5">
            <StatRow label="Water every" value={fmtSecs(cfg[1])} />
            <StatRow label="Matures in" value={fmtSecs(cfg[2])} />
            <StatRow label="Rot window" value={fmtSecs(cfg[3])} />
            <StatRow label="Yield" value={`${cfg[5]} per seed`} />
            <StatRow label="Cleanup cost" value={`${fmtEth(cfg[4])} ETH`} />
            <StatRow label="Max / plot" value={`${cfg[0]} seeds`} />
          </div>
        ) : (
          <div className="h-[70px] bg-base-200/40 rounded-lg animate-pulse" />
        )}

        {/* ── Used in recipes ── */}
        <div className="min-h-[22px]">
          {seed.usedIn.length > 0 ? (
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-xs text-base-content/40 mr-0.5" aria-hidden="true">
                🍽
              </span>
              {seed.usedIn.map(dish => (
                <span key={dish} className="badge badge-ghost badge-sm">
                  {dish}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-xs text-base-content/25 italic">No recipe uses this yet</span>
          )}
        </div>
      </div>

      {/* ── Buy controls ── */}
      <div className="px-4 pb-4 pt-0 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {/* Qty stepper */}
          <div className="flex items-center border border-base-300 rounded-lg overflow-hidden h-8">
            <button
              onClick={() => setQty(q => Math.max(1, q - 1))}
              className="btn btn-ghost btn-xs h-8 w-7 rounded-none border-0 min-h-0 text-base"
              aria-label="Decrease quantity"
            >
              −
            </button>
            <span className="px-2 text-sm font-bold tabular-nums w-8 text-center select-none">{qty}</span>
            <button
              onClick={() => setQty(q => Math.min(100, q + 1))}
              className="btn btn-ghost btn-xs h-8 w-7 rounded-none border-0 min-h-0 text-base"
              aria-label="Increase quantity"
            >
              +
            </button>
          </div>

          <p className="text-xs text-base-content/50 flex-1">
            Total:{" "}
            <span className="font-mono font-bold text-base-content">
              {totalCost !== undefined ? `${fmtEth(totalCost)} ETH` : "—"}
            </span>
          </p>
        </div>

        <button
          onClick={handleBuy}
          disabled={!isConnected || isBuying || price === undefined}
          className="btn btn-primary btn-sm w-full"
        >
          {isBuying ? (
            <>
              <span className="loading loading-spinner loading-xs" />
              Buying…
            </>
          ) : !isConnected ? (
            "Connect Wallet"
          ) : (
            `Buy ${qty} Seed${qty !== 1 ? "s" : ""}`
          )}
        </button>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

const ShopPage: NextPage = () => {
  const [buyingSeedId, setBuyingSeedId] = useState<number | null>(null);

  const { writeContractAsync } = useScaffoldWriteContract({
    contractName: "SeedShop",
  });

  const handleBuy = async (seedId: number, qty: number, pricePerSeed: bigint) => {
    setBuyingSeedId(seedId);
    try {
      await writeContractAsync({
        functionName: "buy",
        args: [BigInt(seedId), BigInt(qty)],
        value: pricePerSeed * BigInt(qty),
      });
    } finally {
      setBuyingSeedId(null);
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-6">
      {/* ── Header ── */}
      <div>
        <h1 className="text-3xl font-extrabold">
          <span aria-hidden="true">🌱</span> Seed Shop
        </h1>
        <p className="text-base-content/50 mt-1">20 seed types · grow fruits · cook dishes · sell to the market</p>
      </div>

      {/* ── Legend ── */}
      <div className="flex flex-wrap gap-4 text-xs text-base-content/50">
        <span>
          <strong className="text-base-content">Yield</strong> — fruit tokens minted per seed on harvest
        </span>
        <span>
          <strong className="text-base-content">Rot window</strong> — seconds after maturity before the plot rots
        </span>
        <span>
          <strong className="text-base-content">🍽 badges</strong> — dishes that require this seed&apos;s fruit
        </span>
      </div>

      {/* ── Grid ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {SEEDS.map(seed => (
          <SeedCard key={seed.id} seed={seed} onBuy={handleBuy} isBuying={buyingSeedId === seed.id} />
        ))}
      </div>
    </div>
  );
};

export default ShopPage;
