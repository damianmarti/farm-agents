"use client";

import { useEffect, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { formatEther } from "viem";
import { useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function useCountdown(targetTimestampSecs: number | undefined): number {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!targetTimestampSecs) return;
    const tick = () => setRemaining(Math.max(0, Math.floor(targetTimestampSecs - Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetTimestampSecs]);
  return remaining;
}

function useMinuteCountdown(): number {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const tick = () => setRemaining(60 - (Math.floor(Date.now() / 1000) % 60));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return remaining;
}

// ── Stat card ──────────────────────────────────────────────────────────────

function StatCard({ value, label, sub, accent }: { value: string; label: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`flex flex-col items-center py-5 px-4 text-center ${accent ? "bg-primary/10 rounded-xl" : ""}`}>
      <span className={`text-3xl font-extrabold ${accent ? "text-primary" : "text-base-content"}`}>{value}</span>
      <span className="text-xs uppercase tracking-widest text-base-content/50 mt-0.5">{label}</span>
      {sub && <span className="text-xs text-base-content/40 mt-0.5">{sub}</span>}
    </div>
  );
}

// ── Land grid ──────────────────────────────────────────────────────────────

function LandGrid({ soldCount, currentId }: { soldCount: number; currentId: number }) {
  return (
    <section className="w-full">
      <h2 className="text-xl font-bold mb-1">Land Map</h2>
      <p className="text-base-content/50 text-sm mb-4">100 plots — click a land ID to explore</p>
      <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(10, 1fr)" }}>
        {Array.from({ length: 100 }, (_, i) => {
          const isSold = i < soldCount;
          const isCurrent = i === currentId;
          return (
            <div
              key={i}
              title={`Land #${i}${isSold ? " — sold" : isCurrent ? " — auction live" : " — available"}`}
              className={[
                "aspect-square rounded flex items-center justify-center text-[9px] font-bold cursor-default select-none transition-all",
                isCurrent
                  ? "bg-warning text-warning-content animate-pulse ring-2 ring-warning"
                  : isSold
                    ? "bg-primary/70 text-primary-content"
                    : "bg-base-200 text-base-content/30 hover:bg-base-300",
              ].join(" ")}
            >
              {i}
            </div>
          );
        })}
      </div>
      <div className="flex gap-5 mt-4 text-xs text-base-content/50">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-primary/70 inline-block" /> Sold
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-warning inline-block" /> Live Auction
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-base-200 inline-block" /> Available
        </span>
      </div>
    </section>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

const FarmPage: NextPage = () => {
  // ── LandAuction ──────────────────────────────────────────────────────────
  const { data: currentLandId } = useScaffoldReadContract({
    contractName: "LandAuction",
    functionName: "currentLandId",
  });
  const { data: highestBid } = useScaffoldReadContract({
    contractName: "LandAuction",
    functionName: "highestBid",
  });
  const { data: highestBidder } = useScaffoldReadContract({
    contractName: "LandAuction",
    functionName: "highestBidder",
  });
  const { data: auctionEndTime } = useScaffoldReadContract({
    contractName: "LandAuction",
    functionName: "auctionEndTime",
  });
  const { data: auctionActive } = useScaffoldReadContract({
    contractName: "LandAuction",
    functionName: "auctionActive",
  });

  // ── DishMarket ───────────────────────────────────────────────────────────
  const { data: currentMinute } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "currentMinute",
  });
  const { data: currentDemandId } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "currentDemand",
  });
  const { data: marketState } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "minuteState",
    args: [currentMinute ?? 0n],
  });
  const { data: availableFunds } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "availableFunds",
  });
  const { data: offers } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "getOffers",
    args: [currentMinute ?? 0n],
  });

  // ── Chef ─────────────────────────────────────────────────────────────────
  const { data: recipeData } = useScaffoldReadContract({
    contractName: "Chef",
    functionName: "getRecipe",
    args: [currentDemandId ?? 0n],
  });

  // ── Events ───────────────────────────────────────────────────────────────
  const { data: settledEvents } = useScaffoldEventHistory({
    contractName: "DishMarket",
    eventName: "MinuteSettled",
    fromBlock: 0n,
    watch: true,
  });
  const { data: auctionSettledEvents } = useScaffoldEventHistory({
    contractName: "LandAuction",
    eventName: "AuctionSettled",
    fromBlock: 0n,
    watch: true,
  });

  // ── Countdowns ───────────────────────────────────────────────────────────
  const auctionCountdown = useCountdown(auctionEndTime ? Number(auctionEndTime) : undefined);
  const minuteCountdown = useMinuteCountdown();

  // ── Derived values ───────────────────────────────────────────────────────
  const landsSold = currentLandId !== undefined ? Number(currentLandId) : 0;
  const currentAuctionId = landsSold; // currentLandId = next land to auction
  const landsAvailable = 99 - landsSold; // 100 total, currentLandId under auction

  const offerCount = offers?.filter(o => !o.claimed).length ?? 0;
  // minuteState tuple: [recipeId, hasOffers, settled, winnerIndex, winnerAskPrice]
  const minOffer = marketState?.[1] ? marketState[4] : null;

  // getRecipe tuple: [name, prepTime, dishAmount, dishToken]
  const recipeName = recipeData?.[0] ?? `Recipe #${currentDemandId?.toString() ?? "?"}`;
  const recentSales = settledEvents?.slice(0, 8) ?? [];
  const recentLandSales = auctionSettledEvents?.slice(0, 5) ?? [];

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-extrabold">
          <span aria-hidden="true">🌾</span> Farm Dashboard
        </h1>
        <p className="text-base-content/50 mt-1">Live on-chain state — updates every block</p>
      </div>

      {/* ── Stats ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-base-200 bg-base-200 rounded-2xl overflow-hidden border border-base-300">
        <StatCard value={String(landsSold)} label="Lands Sold" accent />
        <StatCard value={String(landsAvailable)} label="Lands Available" />
        <StatCard
          value={availableFunds !== undefined ? `${Number(formatEther(availableFunds)).toFixed(3)} ETH` : "—"}
          label="Market Treasury"
        />
        <StatCard
          value={String(offerCount)}
          label="Current Offers"
          sub={`for minute #${currentMinute?.toString() ?? "?"}`}
        />
      </div>

      {/* ── Two columns ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Land Auction card */}
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body gap-4">
            <div className="flex items-center justify-between">
              <h2 className="card-title text-lg">
                <span aria-hidden="true">🏞️</span> Land Auction
              </h2>
              {auctionActive ? (
                <span className="badge badge-warning gap-1 animate-pulse">● Live</span>
              ) : (
                <span className="badge badge-ghost">Idle</span>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Current land</span>
                <span className="font-bold text-lg">#{currentAuctionId}</span>
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Highest bid</span>
                <span className="font-mono font-bold text-primary">
                  {highestBid !== undefined ? `${formatEther(highestBid)} ETH` : "—"}
                </span>
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Leading bidder</span>
                <div className="max-w-[200px]">
                  {highestBidder && highestBidder !== "0x0000000000000000000000000000000000000000" ? (
                    <Address address={highestBidder} size="sm" />
                  ) : (
                    <span className="text-base-content/30">None yet</span>
                  )}
                </div>
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Time remaining</span>
                {auctionActive && auctionCountdown > 0 ? (
                  <span className="font-mono font-bold text-warning tabular-nums">
                    {formatDuration(auctionCountdown)}
                  </span>
                ) : (
                  <span className="text-base-content/30 text-xs">
                    {auctionActive ? "Ended — needs settlement" : "No active auction"}
                  </span>
                )}
              </div>
            </div>

            {/* Recent land sales */}
            {recentLandSales.length > 0 && (
              <div className="mt-1">
                <p className="text-xs uppercase tracking-widest text-base-content/40 mb-2">Recent land sales</p>
                <div className="flex flex-col gap-1">
                  {recentLandSales.map((ev, i) => (
                    <div key={i} className="flex justify-between items-center text-xs text-base-content/60">
                      <span>Land #{ev.args.landId?.toString()}</span>
                      <span className="font-mono">
                        {ev.args.amount !== undefined ? formatEther(ev.args.amount) : "?"} ETH
                      </span>
                      <Address address={ev.args.winner ?? "0x0"} size="xs" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Dish Market card */}
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body gap-4">
            <div className="flex items-center justify-between">
              <h2 className="card-title text-lg">
                <span aria-hidden="true">📈</span> Dish Market
              </h2>
              <span className="badge badge-primary gap-1">Minute #{currentMinute?.toString() ?? "—"}</span>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Demanded dish</span>
                <span className="font-bold">{currentDemandId !== undefined ? recipeName : "—"}</span>
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Minute ends in</span>
                <span className="font-mono font-bold text-warning tabular-nums">
                  00:{String(minuteCountdown).padStart(2, "0")}
                </span>
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Min ask (current winner)</span>
                <span className="font-mono font-bold text-success">
                  {minOffer !== null ? `${formatEther(minOffer)} ETH` : "No offers yet"}
                </span>
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Total offers</span>
                <span className="font-bold">{offerCount}</span>
              </div>

              <div className="flex justify-between items-center text-sm">
                <span className="text-base-content/50">Already settled</span>
                <span className={marketState?.[2] ? "text-success font-bold" : "text-base-content/30"}>
                  {marketState?.[2] ? "Yes" : "Not yet"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Recent dish sales ─────────────────────────────────────────────── */}
      <section>
        <h2 className="text-xl font-bold mb-4">
          <span aria-hidden="true">🍲</span> Recent Dish Sales
        </h2>
        {recentSales.length === 0 ? (
          <div className="text-center py-10 text-base-content/30 bg-base-200 rounded-2xl">
            No sales yet — be the first to sell a dish!
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-base-200">
            <table className="table table-sm w-full">
              <thead className="bg-base-200 text-base-content/50 text-xs uppercase tracking-widest">
                <tr>
                  <th>Minute</th>
                  <th>Dish</th>
                  <th>Winner</th>
                  <th className="text-right">Ask Price</th>
                </tr>
              </thead>
              <tbody>
                {recentSales.map((ev, i) => (
                  <tr key={i} className="hover:bg-base-50 border-base-200">
                    <td className="font-mono text-base-content/50">#{ev.args.minute?.toString()}</td>
                    <td>
                      <span className="badge badge-ghost text-xs">Recipe #{ev.args.recipeId?.toString()}</span>
                    </td>
                    <td>
                      <Address address={ev.args.winner ?? "0x0"} size="xs" />
                    </td>
                    <td className="text-right font-mono font-bold text-success">
                      {ev.args.askPrice !== undefined ? `${formatEther(ev.args.askPrice)} ETH` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Land grid ─────────────────────────────────────────────────────── */}
      <LandGrid soldCount={landsSold} currentId={currentAuctionId} />
    </div>
  );
};

export default FarmPage;
