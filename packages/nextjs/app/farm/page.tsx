"use client";

import { useEffect, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { formatEther, maxUint256, parseEther } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import {
  useDeployedContractInfo,
  useScaffoldEventHistory,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTransactor,
} from "~~/hooks/scaffold-eth";

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtCountdown(secs: number): string {
  if (secs <= 0) return "now";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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

// ── Static catalogs ────────────────────────────────────────────────────────

const SEED_OPTIONS = [
  { id: 0, name: "Tomato", emoji: "🍅" },
  { id: 1, name: "Lettuce", emoji: "🥬" },
  { id: 2, name: "Carrot", emoji: "🥕" },
  { id: 3, name: "Potato", emoji: "🥔" },
  { id: 4, name: "Onion", emoji: "🧅" },
  { id: 5, name: "Pepper", emoji: "🫑" },
  { id: 6, name: "Cucumber", emoji: "🥒" },
  { id: 7, name: "Spinach", emoji: "🥬" },
  { id: 8, name: "Pumpkin", emoji: "🎃" },
  { id: 9, name: "Broccoli", emoji: "🥦" },
  { id: 10, name: "Strawberry", emoji: "🍓" },
  { id: 11, name: "Watermelon", emoji: "🍉" },
  { id: 12, name: "Blueberry", emoji: "🫐" },
  { id: 13, name: "Mango", emoji: "🥭" },
  { id: 14, name: "Pineapple", emoji: "🍍" },
  { id: 15, name: "Lemon", emoji: "🍋" },
  { id: 16, name: "Grape", emoji: "🍇" },
  { id: 17, name: "Peach", emoji: "🍑" },
  { id: 18, name: "Cherry", emoji: "🍒" },
  { id: 19, name: "Melon", emoji: "🍈" },
] as const;

const RECIPE_META: Record<number, { name: string; emoji: string }> = {
  0: { name: "Tomato Soup", emoji: "🍲" },
  1: { name: "Green Salad", emoji: "🥗" },
  2: { name: "Lemonade", emoji: "🥤" },
  3: { name: "Carrot Cake", emoji: "🎂" },
  4: { name: "Pumpkin Pie", emoji: "🥧" },
  5: { name: "Mango Juice", emoji: "🥭" },
  6: { name: "Watermelon Smoothie", emoji: "🍹" },
  7: { name: "Fruit Salad", emoji: "🍱" },
  8: { name: "Pineapple Sorbet", emoji: "🍦" },
  9: { name: "Mixed Pickle", emoji: "🫙" },
};

// ── Minimal ERC-20 ABI ──────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "approve",
    type: "function" as const,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "allowance",
    type: "function" as const,
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ── Dish Market offer panel ────────────────────────────────────────────────

function DishMarketOfferPanel({
  recipeId,
  recipeName,
  recipeEmoji,
  currentMinute,
}: {
  recipeId: number | null;
  recipeName: string;
  recipeEmoji: string;
  currentMinute: bigint | undefined;
}) {
  const { address: userAddr, isConnected } = useAccount();
  const { data: dishMarketInfo } = useDeployedContractInfo({ contractName: "DishMarket" });
  const dishMarketAddr = dishMarketInfo?.address;

  const { data: recipeData } = useScaffoldReadContract({
    contractName: "Chef",
    functionName: "getRecipe",
    args: [BigInt(recipeId ?? 0)],
    query: { enabled: recipeId !== null },
  });
  const dishTokenAddr = recipeData?.[3] as `0x${string}` | undefined;

  const ZERO = "0x0000000000000000000000000000000000000000" as const;
  const user = (userAddr ?? ZERO) as `0x${string}`;
  const market = (dishMarketAddr ?? ZERO) as `0x${string}`;

  const { data: dishBal } = useReadContract({
    address: dishTokenAddr,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
    query: { enabled: !!dishTokenAddr && !!userAddr },
  });

  const { data: alreadyOffered } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "hasOffered",
    args: [currentMinute ?? 0n, BigInt(recipeId ?? 0), user],
    query: { enabled: !!userAddr && currentMinute !== undefined && recipeId !== null },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: dishTokenAddr,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [user, market],
    query: { enabled: !!dishTokenAddr && !!userAddr && !!dishMarketAddr },
  });

  const { writeContractAsync: approveRaw } = useWriteContract();
  const writeTx = useTransactor();
  const [isApproving, setIsApproving] = useState(false);
  const [askInput, setAskInput] = useState("0.0001");

  const { writeContractAsync: writeMarket, isPending: offerPending } = useScaffoldWriteContract({
    contractName: "DishMarket",
  });

  if (!isConnected || recipeId === null) return null;

  const hasDish = dishBal !== undefined && dishBal > 0n;
  const needsApproval = allowance !== undefined && (allowance as bigint) < 1n;

  if (!hasDish) {
    return (
      <div className="mt-4 pt-4 border-t border-base-200">
        <p className="text-xs text-base-content/40">
          You have no <strong>{recipeName}</strong> — cook it in{" "}
          <a href="/dishes" className="link link-primary">
            /dishes
          </a>{" "}
          to submit an offer.
        </p>
      </div>
    );
  }

  if (alreadyOffered) {
    return (
      <div className="mt-4 pt-4 border-t border-base-200 flex items-center gap-2">
        <span className="text-success font-bold">✓</span>
        <p className="text-xs font-semibold text-success">Offer submitted for epoch #{currentMinute?.toString()}</p>
      </div>
    );
  }

  const handleApprove = async () => {
    if (!dishTokenAddr || !dishMarketAddr) return;
    setIsApproving(true);
    try {
      await writeTx(() =>
        approveRaw({
          address: dishTokenAddr,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [market, maxUint256],
        }),
      );
      await refetchAllowance();
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-base-200 flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-widest text-base-content/40">💸 Submit Offer</p>
        <span className="text-xs text-success font-semibold">
          {recipeEmoji} {String(dishBal)} in wallet
        </span>
      </div>

      {needsApproval ? (
        <button
          onClick={handleApprove}
          disabled={isApproving || !dishTokenAddr || !dishMarketAddr}
          className="btn btn-warning btn-sm w-full gap-1"
        >
          {isApproving ? <span className="loading loading-spinner loading-xs" /> : "🔓"}
          Approve {recipeName}
        </button>
      ) : (
        <div className="flex gap-2">
          <input
            type="number"
            value={askInput}
            onChange={e => setAskInput(e.target.value)}
            className="input input-bordered input-sm flex-1 font-mono text-right"
            step="0.0001"
            min="0"
          />
          <span className="self-center text-sm text-base-content/60 font-semibold shrink-0">ETH</span>
          <button
            onClick={async () => {
              try {
                await writeMarket({
                  functionName: "submitOffer",
                  args: [BigInt(recipeId ?? 0), parseEther(askInput), 1n],
                });
              } catch {}
            }}
            disabled={offerPending || !askInput}
            className="btn btn-primary btn-sm gap-1 shrink-0"
          >
            {offerPending ? <span className="loading loading-spinner loading-xs" /> : "📈"}
            Offer
          </button>
        </div>
      )}

      <p className="text-xs text-base-content/30">Cap: 20-30× seed cost · top 3 cheapest offers per epoch win</p>
    </div>
  );
}

// ── Plant form ─────────────────────────────────────────────────────────────

function PlantForm({ landId, userAddr }: { landId: number; userAddr: string }) {
  const [seedId, setSeedId] = useState(0);
  const [amount, setAmount] = useState(1);

  const { data: farmManagerInfo } = useDeployedContractInfo({ contractName: "FarmManager" });
  const farmManagerAddr = farmManagerInfo?.address;

  const { data: seedTokenAddr } = useScaffoldReadContract({
    contractName: "SeedShop",
    functionName: "seedToken",
    args: [BigInt(seedId)],
  });

  const { data: seedCfg } = useScaffoldReadContract({
    contractName: "FarmManager",
    functionName: "farmConfigs",
    args: [BigInt(seedId)],
  });

  const { data: seedBalance } = useReadContract({
    address: seedTokenAddr as `0x${string}` | undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [userAddr as `0x${string}`],
    query: { enabled: !!seedTokenAddr },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: seedTokenAddr as `0x${string}` | undefined,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [userAddr as `0x${string}`, (farmManagerAddr ?? "0x0") as `0x${string}`],
    query: { enabled: !!seedTokenAddr && !!farmManagerAddr },
  });

  const { writeContractAsync: approveRaw } = useWriteContract();
  const writeTx = useTransactor();
  const [isApproving, setIsApproving] = useState(false);
  const { writeContractAsync: writeFarm, isPending: isPlanting } = useScaffoldWriteContract({
    contractName: "FarmManager",
  });

  const maxCap = seedCfg ? Number(seedCfg[0]) : 20;
  const balNum = seedBalance !== undefined ? Math.min(Number(seedBalance), maxCap) : maxCap;
  const needsApproval = allowance !== undefined && BigInt(amount) > (allowance as bigint);
  const selectedSeed = SEED_OPTIONS[seedId];
  const notEnough = seedBalance !== undefined && BigInt(amount) > (seedBalance as bigint);

  const handleApprove = async () => {
    if (!seedTokenAddr || !farmManagerAddr) return;
    setIsApproving(true);
    try {
      await writeTx(() =>
        approveRaw({
          address: seedTokenAddr as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [farmManagerAddr as `0x${string}`, maxUint256],
        }),
      );
      await refetchAllowance();
    } finally {
      setIsApproving(false);
    }
  };

  const handlePlant = async () => {
    await writeFarm({
      functionName: "plant",
      args: [BigInt(landId), BigInt(seedId), BigInt(amount)],
    });
  };

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-base-200">
      <p className="text-xs font-semibold uppercase tracking-widest text-base-content/40">🌱 Plant seeds</p>

      <select
        value={seedId}
        onChange={e => setSeedId(Number(e.target.value))}
        className="select select-bordered select-sm w-full"
      >
        {SEED_OPTIONS.map(s => (
          <option key={s.id} value={s.id}>
            {s.emoji} {s.name}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-3">
        <div className="flex items-center border border-base-300 rounded-lg overflow-hidden h-8 shrink-0">
          <button
            onClick={() => setAmount(q => Math.max(1, q - 1))}
            className="btn btn-ghost btn-xs h-8 w-7 rounded-none border-0 min-h-0"
          >
            −
          </button>
          <span className="px-2 text-sm font-bold w-8 text-center tabular-nums">{amount}</span>
          <button
            onClick={() => setAmount(q => Math.min(maxCap, q + 1))}
            className="btn btn-ghost btn-xs h-8 w-7 rounded-none border-0 min-h-0"
          >
            +
          </button>
        </div>
        <button
          onClick={() => setAmount(balNum)}
          disabled={balNum === 0}
          className="btn btn-ghost btn-xs h-8 px-2 font-bold text-primary border border-primary/30"
        >
          Max
        </button>
        <div className="text-xs text-base-content/50 flex flex-col leading-tight">
          <span>
            Balance:{" "}
            <span className={`font-mono font-semibold ${notEnough ? "text-error" : "text-base-content"}`}>
              {seedBalance !== undefined ? String(seedBalance) : "—"}
            </span>
          </span>
          <span>
            Max/plot: <span className="font-mono font-semibold text-base-content">{maxCap}</span>
          </span>
        </div>
      </div>

      {needsApproval ? (
        <button
          onClick={handleApprove}
          disabled={isApproving || !seedTokenAddr || !farmManagerAddr}
          className="btn btn-warning btn-sm gap-1 w-full"
        >
          {isApproving && <span className="loading loading-spinner loading-xs" />}
          Approve {selectedSeed?.name} seeds
        </button>
      ) : (
        <button
          onClick={handlePlant}
          disabled={isPlanting || !seedTokenAddr || notEnough}
          className="btn btn-success btn-sm gap-1 w-full"
        >
          {isPlanting ? <span className="loading loading-spinner loading-xs" /> : selectedSeed?.emoji}
          Plant {amount} {selectedSeed?.name}
        </button>
      )}
    </div>
  );
}

// ── Land detail panel ──────────────────────────────────────────────────────

const STATE_LABEL = ["Empty", "Growing", "Mature", "Rotten", "Needs Cleanup"];
const STATE_COLOR = [
  "text-base-content/40 bg-base-200",
  "text-info bg-info/15",
  "text-success bg-success/15",
  "text-error bg-error/15",
  "text-warning bg-warning/15",
];
const STATE_ICON = ["◌", "🌱", "🌾", "💀", "🧹"];

function LandDetailPanel({
  landId,
  soldCount,
  currentAuctionId,
}: {
  landId: number;
  soldCount: number;
  currentAuctionId: number;
}) {
  const { address: userAddr } = useAccount();

  const { data: owner } = useScaffoldReadContract({
    contractName: "LandAuction",
    functionName: "landOwner",
    args: [BigInt(landId)],
  });

  const { data: landState } = useScaffoldReadContract({
    contractName: "FarmManager",
    functionName: "getLandState",
    args: [BigInt(landId)],
  });

  const { data: plot } = useScaffoldReadContract({
    contractName: "FarmManager",
    functionName: "plots",
    args: [BigInt(landId)],
  });

  const { data: cfg } = useScaffoldReadContract({
    contractName: "FarmManager",
    functionName: "farmConfigs",
    args: [plot?.[0] ?? 0n],
  });

  const { writeContractAsync: writeFarm, isPending: farmPending } = useScaffoldWriteContract({
    contractName: "FarmManager",
  });

  const stateNum = landState !== undefined ? Number(landState) : -1;
  const isOwner = !!userAddr && !!owner && owner.toLowerCase() === userAddr.toLowerCase();

  const now = Math.floor(Date.now() / 1000);
  const harvestAt = plot && cfg ? Number(plot[2]) + Number(cfg[1]) : null;
  const harvestIn = harvestAt !== null ? harvestAt - now : null;

  const seedMeta = plot ? SEED_OPTIONS[Number(plot[0])] : null;
  const fruitYield = plot && cfg ? Number(plot[1]) * Number(cfg[3]) : 0;

  if (landId === currentAuctionId) {
    return (
      <div className="mt-4 flex flex-col items-center gap-3 py-8 text-center">
        <span className="text-5xl">🏷️</span>
        <p className="font-bold text-lg">Auction in progress</p>
        <p className="text-base-content/50 text-sm max-w-xs">
          Win the current auction to become owner and start farming.
        </p>
      </div>
    );
  }

  if (landId >= soldCount) {
    return (
      <div className="mt-4 flex flex-col items-center gap-3 py-8 text-center">
        <span className="text-5xl opacity-30">🏞️</span>
        <p className="text-base-content/40 text-sm">Not yet auctioned</p>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-4">
      {/* Owner row + state badge */}
      <div className="flex items-center justify-between gap-3 pb-3 border-b border-base-200">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs text-base-content/40 shrink-0">Owner</span>
          {owner ? (
            <Address address={owner} size="xs" />
          ) : (
            <span className="text-base-content/30 text-xs">loading…</span>
          )}
          {isOwner && <span className="badge badge-primary badge-xs ml-1">you</span>}
        </div>
        {stateNum >= 0 ? (
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full shrink-0 ${STATE_COLOR[stateNum]}`}>
            {STATE_ICON[stateNum]} {STATE_LABEL[stateNum]}
          </span>
        ) : (
          <span className="badge badge-ghost animate-pulse shrink-0">…</span>
        )}
      </div>

      {/* Growing info */}
      {stateNum === 1 && plot && cfg && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="bg-base-200/70 rounded-xl p-3">
              <p className="text-xs text-base-content/40 mb-1">Planted</p>
              <p className="font-bold text-base">
                {plot[1].toString()} × {seedMeta?.emoji} {seedMeta?.name}
              </p>
            </div>
            <div className="bg-base-200/70 rounded-xl p-3">
              <p className="text-xs text-base-content/40 mb-1">Harvest in</p>
              <p className="font-bold text-base">
                {harvestIn !== null && harvestIn > 0 ? fmtCountdown(harvestIn) : "⏳ soon"}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Mature */}
      {stateNum === 2 && plot && cfg && (
        <div className="flex items-start gap-3 bg-success/10 border border-success/25 rounded-xl p-4">
          <span className="text-3xl mt-0.5" aria-hidden="true">
            🌾
          </span>
          <div>
            <p className="font-bold text-success text-base">Ready to harvest!</p>
            <p className="text-sm text-base-content/60 mt-0.5">
              {plot[1].toString()} × {seedMeta?.name} → <strong>{fruitYield}</strong> fruit token
              {fruitYield !== 1 ? "s" : ""}
            </p>
            <p className="text-xs text-error/60 mt-1">
              Rot window: {cfg[2] !== undefined ? fmtCountdown(Number(cfg[2])) : "—"} after maturity
            </p>
          </div>
        </div>
      )}

      {/* Rotten / needs cleanup */}
      {(stateNum === 3 || stateNum === 4) && cfg && (
        <div className="flex items-start gap-3 bg-warning/10 border border-warning/25 rounded-xl p-4">
          <span className="text-3xl mt-0.5" aria-hidden="true">
            {stateNum === 3 ? "💀" : "🧹"}
          </span>
          <div>
            <p className="font-bold text-base">{stateNum === 3 ? "Plot rotted" : "Harvested"} — cleanup needed</p>
            <p className="text-sm text-base-content/50 mt-0.5">
              Cost: <span className="font-mono font-semibold">{formatEther(cfg[3])} ETH</span>
            </p>
          </div>
        </div>
      )}

      {/* Empty */}
      {stateNum === 0 && (
        <div className="flex items-center gap-3 bg-base-200/50 rounded-xl p-3 text-sm text-base-content/40">
          <span className="text-2xl">◌</span>
          <span>Plot is empty</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {stateNum === 2 && isOwner && (
          <button
            onClick={() => writeFarm({ functionName: "harvest", args: [BigInt(landId)] })}
            disabled={farmPending}
            className="btn btn-success btn-sm gap-1"
          >
            {farmPending ? <span className="loading loading-spinner loading-xs" /> : "🌾"}
            Harvest
          </button>
        )}
        {(stateNum === 3 || stateNum === 4) && isOwner && cfg && (
          <button
            onClick={() => writeFarm({ functionName: "cleanUp", args: [BigInt(landId)], value: cfg[3] })}
            disabled={farmPending}
            className="btn btn-warning btn-sm gap-1"
          >
            {farmPending ? <span className="loading loading-spinner loading-xs" /> : "🧹"}
            Clean Up ({formatEther(cfg[3])} ETH)
          </button>
        )}
        {stateNum === 2 && !isOwner && <p className="text-xs text-base-content/40 self-center">Owner must harvest</p>}
        {(stateNum === 3 || stateNum === 4) && !isOwner && (
          <p className="text-xs text-base-content/40 self-center">Owner must clean up</p>
        )}
      </div>

      {stateNum === 0 && isOwner && userAddr && <PlantForm landId={landId} userAddr={userAddr} />}
    </div>
  );
}

// ── Pending offer row ──────────────────────────────────────────────────────

function PendingOfferRow({ minute, userAddr }: { minute: bigint; userAddr: string }) {
  const { data: offersRaw } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "getOffers",
    args: [minute],
  });

  const { writeContractAsync: writeMarket, isPending } = useScaffoldWriteContract({
    contractName: "DishMarket",
  });

  if (!offersRaw) {
    return (
      <div className="flex items-center justify-between py-2 text-xs text-base-content/30 animate-pulse">
        <span>Epoch #{minute.toString()}</span>
        <span>loading…</span>
      </div>
    );
  }

  type OfferEntry = { seller: string; askPrice: bigint; amount: bigint; recipeId: bigint; claimed: boolean };
  const offers = offersRaw as unknown as OfferEntry[];
  const myIdxs = offers.map((o, i) => i).filter(i => offers[i].seller.toLowerCase() === userAddr.toLowerCase());
  if (myIdxs.length === 0) return null;

  const unclaimed = myIdxs.filter(i => !offers[i].claimed);
  if (unclaimed.length === 0) return null;

  const MAX_WINNERS = 5;

  return (
    <>
      {unclaimed.map(myIdx => {
        const myOffer = offers[myIdx];
        const myRecipeId = Number(myOffer.recipeId);
        const recipe = RECIPE_META[myRecipeId];
        const betterCount = offers.filter(
          (o, i) => i !== myIdx && Number(o.recipeId) === myRecipeId && o.askPrice < myOffer.askPrice,
        ).length;
        const isWinner = betterCount < MAX_WINNERS;

        return (
          <div key={myIdx} className="flex items-center gap-3 py-2.5 border-b border-base-200 last:border-0">
            {/* Recipe + epoch */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-xl leading-none">{recipe?.emoji ?? "🍽"}</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight truncate">
                  {recipe?.name ?? `Recipe #${myRecipeId}`}
                </p>
                <p className="text-xs text-base-content/40 font-mono">epoch #{minute.toString()}</p>
              </div>
            </div>

            {/* Ask price + rank */}
            <div className="text-right shrink-0">
              <p className="text-xs text-base-content/40">Ask</p>
              <p className="font-mono font-semibold text-sm">{formatEther(myOffer.askPrice)} ETH</p>
              <p className="text-xs text-base-content/30">rank #{betterCount + 1}</p>
            </div>

            {/* Status + action */}
            <div className="shrink-0">
              {isWinner ? (
                <button
                  onClick={() => writeMarket({ functionName: "settle", args: [minute, BigInt(myIdx)] })}
                  disabled={isPending}
                  className="btn btn-success btn-sm gap-1"
                >
                  {isPending ? <span className="loading loading-spinner loading-xs" /> : "💸"}
                  Collect {formatEther(myOffer.askPrice)} ETH
                </button>
              ) : (
                <button
                  onClick={() => writeMarket({ functionName: "withdrawOffer", args: [minute, BigInt(myIdx)] })}
                  disabled={isPending}
                  className="btn btn-ghost btn-sm gap-1 text-base-content/60"
                >
                  {isPending ? <span className="loading loading-spinner loading-xs" /> : "↩"}
                  Withdraw
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ── Land cell ──────────────────────────────────────────────────────────────

function LandCell({
  i,
  isSold,
  isCurrent,
  isOwned,
  onOpen,
}: {
  i: number;
  isSold: boolean;
  isCurrent: boolean;
  isOwned: boolean;
  onOpen: (id: number) => void;
}) {
  const { data: plot } = useScaffoldReadContract({
    contractName: "FarmManager",
    functionName: "plots",
    args: [BigInt(i)],
    query: { enabled: isSold && !isCurrent },
  });

  const hasPlanting = plot?.[4] ?? false;
  const seedEmoji = hasPlanting && plot ? SEED_OPTIONS[Number(plot[0])]?.emoji : null;
  const seedAmount = hasPlanting && plot ? Number(plot[1]) : 0;
  const clickable = isSold || isCurrent;

  return (
    <button
      onClick={() => clickable && onOpen(i)}
      title={`Land #${i}${isSold ? " — sold" : isCurrent ? " — auction live" : " — upcoming"}`}
      className={[
        "aspect-square rounded-md flex items-center justify-center select-none transition-all overflow-hidden",
        clickable ? "cursor-pointer hover:scale-110 hover:z-10 relative" : "cursor-default",
        isCurrent
          ? "bg-warning text-warning-content animate-pulse ring-2 ring-warning shadow-md"
          : isOwned
            ? "bg-secondary text-secondary-content hover:brightness-95 ring-1 ring-secondary/50"
            : isSold
              ? "bg-primary/70 text-primary-content hover:bg-primary"
              : "bg-base-200 text-base-content/20",
      ].join(" ")}
    >
      {hasPlanting && seedEmoji ? (
        <span className="flex flex-wrap justify-center items-center gap-px p-px leading-none">
          {Array.from({ length: Math.min(seedAmount, 9) }, (_, k) => (
            <span key={k} style={{ fontSize: "7px" }}>
              {seedEmoji}
            </span>
          ))}
        </span>
      ) : (
        <span className="text-[8px] font-bold opacity-60">{i}</span>
      )}
    </button>
  );
}

// ── Land grid ──────────────────────────────────────────────────────────────

function LandGrid({
  soldCount,
  currentId,
  ownerMap,
  userAddr,
}: {
  soldCount: number;
  currentId: number;
  ownerMap: Map<number, string>;
  userAddr: string | undefined;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const open = (i: number) => {
    setSelected(i);
    dialogRef.current?.showModal();
  };

  const ownedCount = userAddr
    ? Array.from(ownerMap.entries()).filter(([, addr]) => addr.toLowerCase() === userAddr.toLowerCase()).length
    : 0;

  return (
    <section className="w-full">
      <div className="flex items-end justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">🗺️ Land Map</h2>
          <p className="text-base-content/50 text-sm mt-0.5">
            {soldCount} / 100 plots sold · click any sold plot to interact
          </p>
        </div>
        {ownedCount > 0 && (
          <span className="badge badge-secondary gap-1 text-xs">
            🏡 You own {ownedCount} plot{ownedCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* 10×10 grid */}
      <div
        className="grid gap-1.5 p-3 bg-base-100 rounded-2xl border border-base-200 shadow-sm"
        style={{ gridTemplateColumns: "repeat(10, 1fr)" }}
      >
        {Array.from({ length: 100 }, (_, i) => (
          <LandCell
            key={i}
            i={i}
            isSold={i < soldCount}
            isCurrent={i === currentId}
            isOwned={!!userAddr && ownerMap.get(i)?.toLowerCase() === userAddr.toLowerCase()}
            onOpen={open}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3 text-xs text-base-content/50">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-secondary ring-1 ring-secondary/50 inline-block" />
          Yours
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-primary/70 inline-block" />
          Sold
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-warning inline-block" />
          Live Auction
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-base-200 inline-block" />
          Upcoming
        </span>
      </div>

      {/* Land detail modal */}
      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-lg p-0 overflow-hidden">
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-base-200">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
                <span className="text-sm font-bold text-primary">{selected ?? "—"}</span>
              </div>
              <div>
                <h3 className="font-bold text-lg leading-none">Land #{selected ?? "—"}</h3>
                <p className="text-xs text-base-content/40 mt-0.5">On-Chain Farm</p>
              </div>
            </div>
            <form method="dialog">
              <button className="btn btn-sm btn-circle btn-ghost">✕</button>
            </form>
          </div>
          <div className="px-5 pb-6 overflow-y-auto max-h-[70vh]">
            {selected !== null && (
              <LandDetailPanel landId={selected} soldCount={soldCount} currentAuctionId={currentId} />
            )}
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button>close</button>
        </form>
      </dialog>
    </section>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

const FarmPage: NextPage = () => {
  // ── LandAuction reads ─────────────────────────────────────────────────────
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

  const { address: connectedAddr } = useAccount();

  const { data: pendingRefund } = useScaffoldReadContract({
    contractName: "LandAuction",
    functionName: "pendingWithdrawals",
    args: [connectedAddr ?? "0x0000000000000000000000000000000000000000"],
  });

  const { writeContractAsync: writeAuction, isPending: auctionPending } = useScaffoldWriteContract({
    contractName: "LandAuction",
  });

  const [bidInput, setBidInput] = useState("0.001");
  useEffect(() => {
    const next = highestBid !== undefined ? highestBid + parseEther("0.001") : parseEther("0.001");
    setBidInput(formatEther(next));
  }, [highestBid]);

  // ── DishMarket reads ──────────────────────────────────────────────────────
  const { data: currentMinute } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "currentMinute",
  });
  const { data: currentDemandId } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "currentDemand",
  });
  const { data: currentSecondDemandId } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "currentSecondDemand",
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

  // ── Chef ──────────────────────────────────────────────────────────────────
  const { data: recipeData } = useScaffoldReadContract({
    contractName: "Chef",
    functionName: "getRecipe",
    args: [currentDemandId ?? 0n],
  });

  // ── Events ────────────────────────────────────────────────────────────────
  const { data: settledEvents } = useScaffoldEventHistory({
    contractName: "DishMarket",
    eventName: "EpochSettled",
    fromBlock: 0n,
    watch: true,
  });
  const { data: auctionSettledEvents } = useScaffoldEventHistory({
    contractName: "LandAuction",
    eventName: "AuctionSettled",
    fromBlock: 0n,
    watch: true,
  });
  const { data: offerSubmittedEvents } = useScaffoldEventHistory({
    contractName: "DishMarket",
    eventName: "OfferSubmitted",
    fromBlock: 0n,
    watch: true,
  });

  // ── Countdowns ────────────────────────────────────────────────────────────
  const auctionCountdown = useCountdown(auctionEndTime ? Number(auctionEndTime) : undefined);
  const minuteCountdown = useMinuteCountdown();

  // ── Derived ───────────────────────────────────────────────────────────────
  const landsSold = currentLandId !== undefined ? Number(currentLandId) : 0;
  const currentAuctionId = landsSold;
  const landsAvailable = 99 - landsSold;

  const isLeading = !!connectedAddr && highestBidder?.toLowerCase() === connectedAddr.toLowerCase();
  const auctionEnded = !!auctionActive && auctionCountdown === 0;

  const offerCount = offers?.filter(o => !o.claimed).length ?? 0;
  const minOffer = marketState?.[1] ? marketState[4] : null;
  const recipeMeta =
    currentDemandId !== undefined
      ? (RECIPE_META[Number(currentDemandId)] ?? { name: recipeData?.[0] ?? "—", emoji: "🍽" })
      : null;

  const secondRecipeMeta =
    currentSecondDemandId !== undefined ? (RECIPE_META[Number(currentSecondDemandId)] ?? null) : null;

  const recentSales = settledEvents?.slice(0, 8) ?? [];

  // Past minutes where the connected user submitted an offer (deduplicated)
  const myPendingMinutes: bigint[] = connectedAddr
    ? [
        ...new Map(
          (offerSubmittedEvents ?? [])
            .filter(ev => ev.args.seller?.toLowerCase() === connectedAddr.toLowerCase())
            .filter(ev => ev.args.epoch !== undefined && ev.args.epoch < (currentMinute ?? 0n))
            .map(ev => [ev.args.epoch!.toString(), ev.args.epoch!] as [string, bigint]),
        ).values(),
      ].sort((a, b) => Number(b - a))
    : [];
  const recentLandSales = auctionSettledEvents?.slice(0, 5) ?? [];

  const ownerMap = new Map<number, string>(
    (auctionSettledEvents ?? [])
      .filter(ev => ev.args.landId !== undefined && ev.args.winner)
      .map(ev => [Number(ev.args.landId), ev.args.winner as string]),
  );

  const treasuryEth = availableFunds !== undefined ? Number(formatEther(availableFunds)) : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
      {/* ── Hero header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold flex items-center gap-2">
            <span aria-hidden="true">🌾</span> Farm Dashboard
          </h1>
          <p className="text-base-content/50 mt-1 text-sm">Live on-chain state · updates every block</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-base-content/40 bg-base-100 border border-base-200 rounded-xl px-3 py-2">
          <span className="w-2 h-2 rounded-full bg-success animate-pulse inline-block" />
          Live
        </div>
      </div>

      {/* ── Stats grid ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body p-4 gap-1">
            <span className="text-2xl">🏞️</span>
            <p className="text-2xl font-extrabold leading-none mt-1">{landsSold}</p>
            <p className="text-xs text-base-content/50 uppercase tracking-widest">Lands Sold</p>
          </div>
        </div>
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body p-4 gap-1">
            <span className="text-2xl">🔓</span>
            <p className="text-2xl font-extrabold leading-none mt-1">{landsAvailable}</p>
            <p className="text-xs text-base-content/50 uppercase tracking-widest">Available</p>
          </div>
        </div>
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body p-4 gap-1">
            <span className="text-2xl">💰</span>
            <p className="text-2xl font-extrabold leading-none mt-1 font-mono">
              {treasuryEth !== null ? `${treasuryEth.toFixed(3)}` : "—"}
            </p>
            <p className="text-xs text-base-content/50 uppercase tracking-widest">Treasury (ETH)</p>
          </div>
        </div>
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body p-4 gap-1">
            <span className="text-2xl">📋</span>
            <p className="text-2xl font-extrabold leading-none mt-1">{offerCount}</p>
            <p className="text-xs text-base-content/50 uppercase tracking-widest">
              Offers min #{currentMinute?.toString() ?? "—"}
            </p>
          </div>
        </div>
      </div>

      {/* ── Two-column: Auction + Market ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Land Auction */}
        <div
          className={[
            "card bg-base-100 border shadow-sm",
            auctionActive && !auctionEnded ? "border-warning/60 ring-1 ring-warning/30" : "border-base-200",
          ].join(" ")}
        >
          <div className="card-body gap-0 p-5">
            {/* Card header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-base flex items-center gap-2">🏞️ Land Auction</h2>
              {auctionActive && !auctionEnded ? (
                <span className="badge badge-warning gap-1 animate-pulse text-xs">● Live</span>
              ) : auctionEnded ? (
                <span className="badge badge-error text-xs">Ended</span>
              ) : (
                <span className="badge badge-ghost text-xs">Idle</span>
              )}
            </div>

            {/* Big land # + bid display */}
            <div className="flex items-stretch gap-3 mb-4">
              <div className="flex-1 bg-base-200/70 rounded-xl p-4 flex flex-col items-center justify-center text-center">
                <p className="text-xs text-base-content/40 uppercase tracking-widest mb-1">Plot</p>
                <p className="text-4xl font-extrabold text-primary leading-none">#{currentAuctionId}</p>
              </div>
              <div className="flex-1 bg-base-200/70 rounded-xl p-4 flex flex-col items-center justify-center text-center">
                <p className="text-xs text-base-content/40 uppercase tracking-widest mb-1">
                  {auctionActive ? "Top Bid" : "Min Bid"}
                </p>
                <p className="text-xl font-extrabold font-mono text-warning leading-none">
                  {highestBid !== undefined && highestBid > 0n ? `${formatEther(highestBid)}` : "0.001"}
                </p>
                <p className="text-xs text-base-content/40 mt-0.5">ETH</p>
              </div>
              {auctionActive && !auctionEnded && (
                <div className="flex-1 bg-warning/10 border border-warning/25 rounded-xl p-4 flex flex-col items-center justify-center text-center">
                  <p className="text-xs text-base-content/40 uppercase tracking-widest mb-1">Ends in</p>
                  <p className="text-xl font-extrabold font-mono text-warning tabular-nums leading-none">
                    {formatDuration(auctionCountdown)}
                  </p>
                </div>
              )}
            </div>

            {/* Leading bidder */}
            {highestBidder && highestBidder !== "0x0000000000000000000000000000000000000000" && (
              <div className="flex items-center justify-between text-sm mb-3">
                <span className="text-base-content/50 text-xs">Leading bidder</span>
                <div className="flex items-center gap-1">
                  {isLeading && <span className="badge badge-success badge-xs">you</span>}
                  <Address address={highestBidder} size="xs" />
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-2 pt-3 border-t border-base-200">
              {auctionEnded && isLeading && (
                <button
                  onClick={() => writeAuction({ functionName: "settleAuction" })}
                  disabled={auctionPending}
                  className="btn btn-success btn-sm w-full gap-1"
                >
                  {auctionPending ? <span className="loading loading-spinner loading-xs" /> : "🏆"}
                  Settle & Claim Land #{currentAuctionId}
                </button>
              )}
              {auctionEnded && !isLeading && (
                <p className="text-xs text-base-content/40 text-center py-1">Auction ended — winner must settle</p>
              )}

              {!auctionEnded &&
                currentAuctionId < 100 &&
                (isLeading ? (
                  <div className="flex items-center gap-2 justify-center bg-success/10 border border-success/25 rounded-xl py-2.5">
                    <span className="text-success text-sm">🏆</span>
                    <span className="text-xs font-semibold text-success">You are currently leading</span>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={bidInput}
                      onChange={e => setBidInput(e.target.value)}
                      className="input input-bordered input-sm flex-1 font-mono text-right"
                      step="0.001"
                      min="0"
                    />
                    <span className="self-center text-sm font-semibold text-base-content/60">ETH</span>
                    <button
                      onClick={() => {
                        try {
                          writeAuction({ functionName: "bid", value: parseEther(bidInput) });
                        } catch {}
                      }}
                      disabled={auctionPending || !connectedAddr}
                      className="btn btn-warning btn-sm gap-1 shrink-0"
                    >
                      {auctionPending ? <span className="loading loading-spinner loading-xs" /> : "🏷️"}
                      {connectedAddr ? (auctionActive ? "Bid" : "First Bid") : "Connect"}
                    </button>
                  </div>
                ))}

              {pendingRefund !== undefined && pendingRefund > 0n && (
                <button
                  onClick={() => writeAuction({ functionName: "withdrawRefund" })}
                  disabled={auctionPending}
                  className="btn btn-ghost btn-sm w-full text-success gap-1"
                >
                  ↩ Withdraw refund {formatEther(pendingRefund)} ETH
                </button>
              )}
            </div>

            {/* Recent land sales */}
            {recentLandSales.length > 0 && (
              <div className="mt-4 pt-4 border-t border-base-200">
                <p className="text-xs uppercase tracking-widest text-base-content/40 mb-2">Recent sales</p>
                <div className="flex flex-col gap-1.5">
                  {recentLandSales.map((ev, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-base-content/50">Land #{ev.args.landId?.toString()}</span>
                      <span className="font-mono font-semibold">
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

        {/* Dish Market */}
        <div className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body gap-0 p-5">
            {/* Card header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-base flex items-center gap-2">📈 Dish Market</h2>
              <span className="badge badge-ghost text-xs font-mono">min #{currentMinute?.toString() ?? "—"}</span>
            </div>

            {/* Demanded dishes — hero */}
            {recipeMeta ? (
              <div className="flex flex-col gap-2 mb-4">
                {/* Primary demand */}
                <div className="flex items-center gap-4 bg-warning/10 border border-warning/30 rounded-2xl p-4">
                  <span className="text-5xl leading-none" aria-hidden="true">
                    {recipeMeta.emoji}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-base-content/50 uppercase tracking-widest">Demanded now</p>
                    <p className="font-extrabold text-xl leading-tight">{recipeMeta.name}</p>
                    {marketState?.[2] && <span className="badge badge-success badge-sm mt-1">✓ Won (top 3)</span>}
                  </div>
                  <div className="text-center shrink-0">
                    <p className="font-mono text-2xl font-extrabold text-warning tabular-nums">
                      00:{String(minuteCountdown).padStart(2, "0")}
                    </p>
                    <p className="text-xs text-base-content/40">remaining</p>
                  </div>
                </div>
                {/* Secondary demand */}
                {secondRecipeMeta && (
                  <div className="flex items-center gap-4 bg-secondary/10 border border-secondary/30 rounded-2xl p-4">
                    <span className="text-5xl leading-none" aria-hidden="true">
                      {secondRecipeMeta.emoji}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-base-content/50 uppercase tracking-widest">Also demanded</p>
                      <p className="font-extrabold text-xl leading-tight">{secondRecipeMeta.name}</p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="h-24 bg-base-200/60 rounded-2xl animate-pulse mb-4" />
            )}

            {/* Market stats */}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="bg-base-200/70 rounded-xl p-3">
                <p className="text-xs text-base-content/40 mb-0.5">Active offers</p>
                <p className="font-extrabold text-lg">{offerCount}</p>
              </div>
              <div className="bg-base-200/70 rounded-xl p-3">
                <p className="text-xs text-base-content/40 mb-0.5">Best ask · top 3 win</p>
                <p
                  className={`font-extrabold text-lg font-mono ${
                    minOffer !== null ? "text-success" : "text-base-content/30"
                  }`}
                >
                  {minOffer !== null ? `${formatEther(minOffer)} ETH` : "—"}
                </p>
              </div>
              <div className="col-span-2 bg-base-200/70 rounded-xl p-3 flex items-center justify-between">
                <p className="text-xs text-base-content/40">Treasury balance</p>
                <p className="font-extrabold font-mono">
                  {treasuryEth !== null ? `${treasuryEth.toFixed(4)} ETH` : "—"}
                </p>
              </div>
            </div>

            {recipeMeta && (
              <DishMarketOfferPanel
                recipeId={currentDemandId !== undefined ? Number(currentDemandId) : null}
                recipeName={recipeMeta.name}
                recipeEmoji={recipeMeta.emoji}
                currentMinute={currentMinute}
              />
            )}
            {secondRecipeMeta && (
              <DishMarketOfferPanel
                recipeId={currentSecondDemandId !== undefined ? Number(currentSecondDemandId) : null}
                recipeName={secondRecipeMeta.name}
                recipeEmoji={secondRecipeMeta.emoji}
                currentMinute={currentMinute}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── My pending offers ── */}
      {myPendingMinutes.length > 0 && connectedAddr && (
        <section className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body p-5">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="font-bold text-base">💸 My Pending Offers</h2>
              <span className="badge badge-warning badge-sm">{myPendingMinutes.length}</span>
            </div>
            <p className="text-xs text-base-content/40 mb-3">
              Past epochs where you submitted an offer — collect if you won, or reclaim your dish token if you lost.
            </p>
            <div className="flex flex-col divide-y divide-base-200">
              {myPendingMinutes.map(minute => (
                <PendingOfferRow key={minute.toString()} minute={minute} userAddr={connectedAddr} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Recent dish sales ── */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-xl font-bold">🍲 Recent Dish Sales</h2>
          <span className="badge badge-ghost text-xs">{recentSales.length} shown</span>
        </div>

        {recentSales.length === 0 ? (
          <div className="card bg-base-100 border border-base-200">
            <div className="card-body items-center py-12 gap-3">
              <span className="text-4xl opacity-30">🫙</span>
              <p className="text-base-content/40">No dish sales yet — be the first!</p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-base-200 bg-base-100 shadow-sm">
            <table className="table table-sm w-full">
              <thead className="bg-base-200/80 text-base-content/50 text-xs uppercase tracking-widest">
                <tr>
                  <th>Epoch</th>
                  <th>Dish</th>
                  <th>Winner</th>
                  <th className="text-right">Ask Price</th>
                </tr>
              </thead>
              <tbody>
                {recentSales.map((ev, i) => {
                  const meta = ev.args.recipeId !== undefined ? RECIPE_META[Number(ev.args.recipeId)] : null;
                  return (
                    <tr key={i} className="hover:bg-base-50 border-base-200">
                      <td className="font-mono text-base-content/40 text-xs">#{ev.args.epoch?.toString()}</td>
                      <td>
                        <span className="flex items-center gap-1.5">
                          {meta && <span aria-hidden="true">{meta.emoji}</span>}
                          <span className="text-sm font-semibold">
                            {meta ? meta.name : `Recipe #${ev.args.recipeId?.toString()}`}
                          </span>
                        </span>
                      </td>
                      <td>
                        <Address address={ev.args.winner ?? "0x0"} size="xs" />
                      </td>
                      <td className="text-right font-mono font-bold text-success">
                        {ev.args.askPrice !== undefined ? `${formatEther(ev.args.askPrice)} ETH` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Land map ── */}
      <LandGrid soldCount={landsSold} currentId={currentAuctionId} ownerMap={ownerMap} userAddr={connectedAddr} />
    </div>
  );
};

export default FarmPage;
