"use client";

import { useEffect, useState } from "react";
import type { NextPage } from "next";
import { formatEther, maxUint256, parseEther } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import {
  useDeployedContractInfo,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTransactor,
} from "~~/hooks/scaffold-eth";

// ── Static catalog ─────────────────────────────────────────────────────────

type Ingredient = {
  readonly seedId: number;
  readonly amount: number;
};

type RecipeInfo = {
  readonly id: number;
  readonly name: string;
  readonly emoji: string;
  readonly dishSymbol: string;
  readonly prepTimeSecs: number;
  readonly ingredients: readonly Ingredient[];
};

const RECIPES: readonly RecipeInfo[] = [
  {
    id: 0,
    name: "Tomato Soup",
    emoji: "🍲",
    dishSymbol: "TSOUP",
    prepTimeSecs: 3 * 60,
    ingredients: [
      { seedId: 0, amount: 3 },
      { seedId: 4, amount: 1 },
    ],
  },
  {
    id: 1,
    name: "Green Salad",
    emoji: "🥗",
    dishSymbol: "GSALAD",
    prepTimeSecs: 2 * 60,
    ingredients: [
      { seedId: 1, amount: 2 },
      { seedId: 6, amount: 1 },
      { seedId: 7, amount: 1 },
    ],
  },
  {
    id: 2,
    name: "Lemonade",
    emoji: "🥤",
    dishSymbol: "LMNADE",
    prepTimeSecs: 1 * 60,
    ingredients: [{ seedId: 15, amount: 3 }],
  },
  {
    id: 3,
    name: "Carrot Cake",
    emoji: "🎂",
    dishSymbol: "CCAKE",
    prepTimeSecs: 5 * 60,
    ingredients: [
      { seedId: 2, amount: 3 },
      { seedId: 15, amount: 2 },
    ],
  },
  {
    id: 4,
    name: "Pumpkin Pie",
    emoji: "🥧",
    dishSymbol: "PPIE",
    prepTimeSecs: 7 * 60,
    ingredients: [
      { seedId: 8, amount: 2 },
      { seedId: 3, amount: 1 },
    ],
  },
  {
    id: 5,
    name: "Mango Juice",
    emoji: "🥭",
    dishSymbol: "MJUICE",
    prepTimeSecs: 2 * 60,
    ingredients: [{ seedId: 13, amount: 3 }],
  },
  {
    id: 6,
    name: "Watermelon Smoothie",
    emoji: "🍹",
    dishSymbol: "WSMTH",
    prepTimeSecs: 2 * 60,
    ingredients: [
      { seedId: 11, amount: 2 },
      { seedId: 15, amount: 1 },
    ],
  },
  {
    id: 7,
    name: "Fruit Salad",
    emoji: "🍱",
    dishSymbol: "FSALAD",
    prepTimeSecs: 3 * 60,
    ingredients: [
      { seedId: 10, amount: 2 },
      { seedId: 12, amount: 2 },
      { seedId: 16, amount: 2 },
    ],
  },
  {
    id: 8,
    name: "Pineapple Sorbet",
    emoji: "🍦",
    dishSymbol: "PSORBET",
    prepTimeSecs: 4 * 60,
    ingredients: [
      { seedId: 14, amount: 2 },
      { seedId: 18, amount: 2 },
    ],
  },
  {
    id: 9,
    name: "Mixed Pickle",
    emoji: "🫙",
    dishSymbol: "PICKLE",
    prepTimeSecs: 4 * 60,
    ingredients: [
      { seedId: 2, amount: 2 },
      { seedId: 6, amount: 2 },
      { seedId: 4, amount: 1 },
      { seedId: 5, amount: 1 },
    ],
  },
];

const SEED_META: Record<number, { name: string; emoji: string; yield: number }> = {
  0: { name: "Tomato", emoji: "🍅", yield: 3 },
  1: { name: "Lettuce", emoji: "🥬", yield: 2 },
  2: { name: "Carrot", emoji: "🥕", yield: 2 },
  3: { name: "Potato", emoji: "🥔", yield: 4 },
  4: { name: "Onion", emoji: "🧅", yield: 2 },
  5: { name: "Pepper", emoji: "🫑", yield: 3 },
  6: { name: "Cucumber", emoji: "🥒", yield: 3 },
  7: { name: "Spinach", emoji: "🥬", yield: 2 },
  8: { name: "Pumpkin", emoji: "🎃", yield: 5 },
  9: { name: "Broccoli", emoji: "🥦", yield: 2 },
  10: { name: "Strawberry", emoji: "🍓", yield: 4 },
  11: { name: "Watermelon", emoji: "🍉", yield: 5 },
  12: { name: "Blueberry", emoji: "🫐", yield: 3 },
  13: { name: "Mango", emoji: "🥭", yield: 4 },
  14: { name: "Pineapple", emoji: "🍍", yield: 6 },
  15: { name: "Lemon", emoji: "🍋", yield: 3 },
  16: { name: "Grape", emoji: "🍇", yield: 4 },
  17: { name: "Peach", emoji: "🍑", yield: 4 },
  18: { name: "Cherry", emoji: "🍒", yield: 5 },
  19: { name: "Melon", emoji: "🍈", yield: 4 },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(secs: number): string {
  if (secs <= 0) return "0s";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function seedsNeeded(fruitAmount: number, yieldPerSeed: number): number {
  return Math.ceil(fruitAmount / yieldPerSeed);
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

// ── ERC-20 ABI ─────────────────────────────────────────────────────────────

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
  {
    name: "totalSupply",
    type: "function" as const,
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ── Cooking countdown hook ──────────────────────────────────────────────────

function useCookingCountdown(cookStartSecs: number | undefined, prepSecs: number): number {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!cookStartSecs) return;
    const readyAt = cookStartSecs + prepSecs;
    const tick = () => setRemaining(Math.max(0, Math.floor(readyAt - Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cookStartSecs, prepSecs]);
  return remaining;
}

// ── Cook panel ─────────────────────────────────────────────────────────────

function CookPanel({ recipe }: { recipe: RecipeInfo }) {
  const { address: userAddr, isConnected } = useAccount();
  const { data: chefInfo } = useDeployedContractInfo({ contractName: "Chef" });
  const chefAddr = chefInfo?.address;

  const { data: recipeData } = useScaffoldReadContract({
    contractName: "Chef",
    functionName: "getRecipe",
    args: [BigInt(recipe.id)],
  });
  const dishTokenAddr = recipeData?.[3] as `0x${string}` | undefined;

  const { data: ingredients } = useScaffoldReadContract({
    contractName: "Chef",
    functionName: "getIngredients",
    args: [BigInt(recipe.id)],
  });

  const { data: cookingStart, refetch: refetchCooking } = useScaffoldReadContract({
    contractName: "Chef",
    functionName: "cookingStartTime",
    args: [userAddr ?? "0x0000000000000000000000000000000000000000", BigInt(recipe.id)],
    query: { enabled: !!userAddr },
  });
  const { data: contractTimeLeft } = useScaffoldReadContract({
    contractName: "Chef",
    functionName: "timeUntilReady",
    args: [userAddr ?? "0x0000000000000000000000000000000000000000", BigInt(recipe.id)],
    query: { enabled: !!userAddr },
  });

  // Fixed 4-slot reads — hooks can't be in loops
  const ing0 = ingredients?.[0];
  const ing1 = ingredients?.[1];
  const ing2 = ingredients?.[2];
  const ing3 = ingredients?.[3];

  const ZERO = "0x0000000000000000000000000000000000000000" as const;
  const user = (userAddr ?? ZERO) as `0x${string}`;
  const chef = (chefAddr ?? ZERO) as `0x${string}`;

  const { data: bal0 } = useReadContract({
    address: ing0?.token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
    query: { enabled: !!ing0 && !!userAddr },
  });
  const { data: bal1 } = useReadContract({
    address: ing1?.token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
    query: { enabled: !!ing1 && !!userAddr },
  });
  const { data: bal2 } = useReadContract({
    address: ing2?.token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
    query: { enabled: !!ing2 && !!userAddr },
  });
  const { data: bal3 } = useReadContract({
    address: ing3?.token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
    query: { enabled: !!ing3 && !!userAddr },
  });

  const { data: alw0, refetch: refetchAlw0 } = useReadContract({
    address: ing0?.token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [user, chef],
    query: { enabled: !!ing0 && !!userAddr && !!chefAddr },
  });
  const { data: alw1, refetch: refetchAlw1 } = useReadContract({
    address: ing1?.token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [user, chef],
    query: { enabled: !!ing1 && !!userAddr && !!chefAddr },
  });
  const { data: alw2, refetch: refetchAlw2 } = useReadContract({
    address: ing2?.token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [user, chef],
    query: { enabled: !!ing2 && !!userAddr && !!chefAddr },
  });
  const { data: alw3, refetch: refetchAlw3 } = useReadContract({
    address: ing3?.token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [user, chef],
    query: { enabled: !!ing3 && !!userAddr && !!chefAddr },
  });

  const { data: dishBal } = useReadContract({
    address: dishTokenAddr,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [user],
    query: { enabled: !!dishTokenAddr && !!userAddr },
  });

  const { writeContractAsync: writeChef, isPending: chefPending } = useScaffoldWriteContract({ contractName: "Chef" });
  const { writeContractAsync: approveRaw } = useWriteContract();
  const writeTx = useTransactor();
  const [approvingIdx, setApprovingIdx] = useState<number | null>(null);

  const cookingCountdown = useCookingCountdown(
    cookingStart !== undefined && cookingStart > 0n ? Number(cookingStart) : undefined,
    recipe.prepTimeSecs,
  );

  const isCooking = cookingStart !== undefined && cookingStart > 0n;
  const isReady = isCooking && (contractTimeLeft === 0n || cookingCountdown === 0);

  const bals = [bal0, bal1, bal2, bal3];
  const alws = [alw0, alw1, alw2, alw3];
  const ingList = ingredients ? ([...ingredients] as { token: `0x${string}`; amount: bigint }[]) : [];

  const allHaveIngredients = ingList.length > 0 && ingList.every((ing, i) => (bals[i] ?? 0n) >= ing.amount);
  const toApprove = ingList.filter((ing, i) => (alws[i] ?? 0n) < ing.amount);
  const canCook = allHaveIngredients && toApprove.length === 0 && !isCooking;

  const cookProgress =
    isCooking && !isReady
      ? Math.min(100, Math.round(((recipe.prepTimeSecs - cookingCountdown) / recipe.prepTimeSecs) * 100))
      : isReady
        ? 100
        : 0;

  const refetches = [refetchAlw0, refetchAlw1, refetchAlw2, refetchAlw3];

  if (!isConnected) {
    return (
      <div className="mt-3 pt-3 border-t border-base-200 flex items-center justify-center gap-2 py-3 text-xs text-base-content/40">
        <span>🔌</span> Connect wallet to cook
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-base-200 flex flex-col gap-3">
      <p className="text-xs font-semibold uppercase tracking-widest text-base-content/40">👨‍🍳 Your Kitchen</p>

      {/* Dish balance */}
      {dishBal !== undefined && dishBal > 0n && (
        <div className="flex items-center gap-2 bg-success/10 border border-success/25 rounded-xl px-3 py-2">
          <span className="text-success text-sm">✓</span>
          <span className="text-xs font-semibold text-success">
            You hold {String(dishBal)} {recipe.name} {Number(dishBal) === 1 ? "token" : "tokens"}
          </span>
        </div>
      )}

      {/* Ingredient balance rows with progress bars */}
      <div className="flex flex-col gap-2">
        {recipe.ingredients.map((staticIng, i) => {
          const seed = SEED_META[staticIng.seedId];
          const bal = bals[i];
          const needed = BigInt(staticIng.amount);
          const balNum = bal !== undefined ? Number(bal) : 0;
          const hasEnough = (bal ?? 0n) >= needed;
          const pct = Math.min(100, bal !== undefined ? Math.round((balNum / staticIng.amount) * 100) : 0);
          const ing = ingList[i];
          const alw = alws[i];
          const needsApprove = ing && alw !== undefined && alw < ing.amount;
          const isApproving = approvingIdx === i;

          return (
            <div key={staticIng.seedId} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true">{seed.emoji}</span>
                  <span className="text-base-content/70 font-medium">{seed.name}</span>
                </span>
                <span className={`font-mono font-semibold tabular-nums ${hasEnough ? "text-success" : "text-error"}`}>
                  {bal !== undefined ? String(bal) : "…"} / {staticIng.amount}
                  {hasEnough ? " ✓" : ""}
                </span>
              </div>
              <div className="h-1.5 bg-base-300 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    hasEnough ? "bg-success" : "bg-error/60"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {/* Inline approve button */}
              {!isCooking && needsApprove && hasEnough && (
                <button
                  onClick={async () => {
                    setApprovingIdx(i);
                    try {
                      await writeTx(() =>
                        approveRaw({
                          address: ing.token,
                          abi: ERC20_ABI,
                          functionName: "approve",
                          args: [chef, maxUint256],
                        }),
                      );
                      await refetches[i]();
                    } finally {
                      setApprovingIdx(null);
                    }
                  }}
                  disabled={isApproving}
                  className="btn btn-warning btn-xs w-full gap-1 mt-0.5"
                >
                  {isApproving ? <span className="loading loading-spinner loading-xs" /> : "🔓"}
                  Approve {seed.name}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Cooking progress */}
      {isCooking && !isReady && (
        <div className="flex flex-col gap-1.5 bg-warning/10 border border-warning/25 rounded-xl px-3 py-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-warning flex items-center gap-1.5">
              <span className="loading loading-spinner loading-xs" />
              Cooking…
            </span>
            <span className="font-mono font-bold text-warning tabular-nums">{fmtTime(cookingCountdown)}</span>
          </div>
          <div className="h-1.5 bg-warning/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-warning rounded-full transition-all duration-1000"
              style={{ width: `${cookProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Ready to claim */}
      {isReady && (
        <button
          onClick={async () => {
            await writeChef({ functionName: "claim", args: [BigInt(recipe.id)] });
            refetchCooking();
          }}
          disabled={chefPending}
          className="btn btn-success btn-sm w-full gap-1.5"
        >
          {chefPending ? <span className="loading loading-spinner loading-xs" /> : recipe.emoji}
          Claim {recipe.name}
        </button>
      )}

      {/* Cook button */}
      {canCook && (
        <button
          onClick={async () => {
            await writeChef({ functionName: "startCooking", args: [BigInt(recipe.id), 1n] });
            refetchCooking();
          }}
          disabled={chefPending}
          className="btn btn-primary btn-sm w-full gap-1.5"
        >
          {chefPending ? <span className="loading loading-spinner loading-xs" /> : "👨‍🍳"}
          Cook {recipe.name}
        </button>
      )}

      {/* Missing ingredients notice */}
      {!isCooking && !allHaveIngredients && ingList.length > 0 && (
        <p className="text-xs text-base-content/40 text-center">Grow more fruits to unlock cooking</p>
      )}
    </div>
  );
}

// ── Offer panel ────────────────────────────────────────────────────────────

function OfferPanel({
  recipeId,
  recipeName,
  recipeEmoji,
  currentMinute,
}: {
  recipeId: number;
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
    args: [BigInt(recipeId)],
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
    args: [currentMinute ?? 0n, BigInt(recipeId), user],
    query: { enabled: !!userAddr && currentMinute !== undefined },
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

  if (!isConnected) return null;

  const hasDish = dishBal !== undefined && dishBal > 0n;
  const needsApproval = allowance !== undefined && (allowance as bigint) < 1n;

  if (!hasDish) {
    return (
      <div className="border-t border-warning/20 px-5 py-3">
        <p className="text-xs text-base-content/50">
          No tienes <strong>{recipeName}</strong> — cocínalo primero para poder ofertar.
        </p>
      </div>
    );
  }

  if (alreadyOffered) {
    return (
      <div className="border-t border-warning/20 bg-success/10 px-5 py-3 flex items-center gap-2">
        <span className="text-success font-bold">✓</span>
        <p className="text-xs font-semibold text-success">Oferta enviada para este minuto</p>
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
    <div className="border-t border-warning/20 bg-warning/5 px-5 py-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-widest text-base-content/50">💸 Submit Offer</p>
        <span className="text-xs text-success font-semibold">
          {recipeEmoji} {String(dishBal)} token{Number(dishBal) !== 1 ? "s" : ""} in wallet
        </span>
      </div>

      {needsApproval ? (
        <button
          onClick={handleApprove}
          disabled={isApproving || !dishTokenAddr || !dishMarketAddr}
          className="btn btn-warning btn-sm w-full gap-1"
        >
          {isApproving ? <span className="loading loading-spinner loading-xs" /> : "🔓"}
          Approve {recipeName} for Market
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
                await writeMarket({ functionName: "submitOffer", args: [BigInt(recipeId), parseEther(askInput), 1n] });
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

      <p className="text-xs text-base-content/40">Cap: 20-30× seed cost · top 3 cheapest offers per epoch win</p>
    </div>
  );
}

// ── Recipe card ────────────────────────────────────────────────────────────

function RecipeCard({
  recipe,
  isLive,
  isSecondary,
  currentMinute,
}: {
  recipe: RecipeInfo;
  isLive: boolean;
  isSecondary?: boolean;
  currentMinute: number | null;
}) {
  const { data: recipeData } = useScaffoldReadContract({
    contractName: "Chef",
    functionName: "getRecipe",
    args: [BigInt(recipe.id)],
  });
  const dishTokenAddr = recipeData?.[3] as `0x${string}` | undefined;

  const { data: totalSupply } = useReadContract({
    address: dishTokenAddr,
    abi: ERC20_ABI,
    functionName: "totalSupply",
    query: { enabled: !!dishTokenAddr },
  });

  return (
    <div
      className={[
        "card bg-base-100 flex flex-col overflow-hidden transition-shadow",
        isLive
          ? "border-2 border-warning shadow-md"
          : isSecondary
            ? "border-2 border-secondary shadow-md"
            : "border border-base-200 shadow-sm",
      ].join(" ")}
    >
      {/* Live strip */}
      {isLive && (
        <div className="bg-warning text-warning-content text-xs font-bold uppercase tracking-widest text-center py-1.5 flex items-center justify-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-warning-content animate-ping inline-block" />
          Demanded right now
        </div>
      )}
      {isSecondary && !isLive && (
        <div className="bg-secondary text-secondary-content text-xs font-bold uppercase tracking-widest text-center py-1.5 flex items-center justify-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-secondary-content animate-ping inline-block" />
          Also demanded now
        </div>
      )}

      <div className="card-body p-5 gap-4 flex-1">
        {/* Header: emoji + name + badges */}
        <div className="flex items-start gap-4">
          <div
            className={[
              "w-16 h-16 rounded-2xl flex items-center justify-center text-4xl shrink-0 shadow-sm",
              isLive ? "bg-warning/20" : "bg-base-200",
            ].join(" ")}
          >
            {recipe.emoji}
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h2 className="font-extrabold text-lg leading-tight">{recipe.name}</h2>
            <p className="font-mono text-xs text-base-content/40 mt-0.5">{recipe.dishSymbol}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              <span className="badge badge-ghost badge-sm font-mono">#{recipe.id}</span>
              <span className="badge badge-ghost badge-sm">⏱ {Math.floor(recipe.prepTimeSecs / 60)} min</span>
              <span className="badge badge-ghost badge-sm font-mono">
                supply: {totalSupply !== undefined ? String(totalSupply) : "…"}
              </span>
            </div>
          </div>
        </div>

        {/* Demand countdown */}
        {(() => {
          const minutesUntil = currentMinute !== null ? (recipe.id - (currentMinute % 10) + 10) % 10 : null;
          return (
            <div
              className={[
                "flex items-center justify-between rounded-xl px-3 py-2 text-xs",
                isLive ? "bg-warning/15 border border-warning/30" : "bg-base-200/60",
              ].join(" ")}
            >
              <span className="text-base-content/40 font-mono">min % 10 = {recipe.id}</span>
              {minutesUntil === null ? (
                <span className="text-base-content/30">…</span>
              ) : isLive ? (
                <span className="font-bold text-warning flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-warning animate-ping inline-block" />
                  Demanded now
                </span>
              ) : minutesUntil === 1 ? (
                <span className="font-bold text-success">Next up ›</span>
              ) : (
                <span className="font-semibold text-base-content/60">
                  in <span className="font-mono font-bold text-base-content">{minutesUntil}</span> min
                </span>
              )}
            </div>
          );
        })()}

        {/* Ingredients */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-base-content/40 mb-2">Ingredients</p>
          <div className="flex flex-col gap-1.5">
            {recipe.ingredients.map(ing => {
              const seed = SEED_META[ing.seedId];
              const seeds = seedsNeeded(ing.amount, seed.yield);
              return (
                <div key={ing.seedId} className="flex items-center gap-3 bg-base-200/50 rounded-xl px-3 py-2">
                  <span className="text-xl leading-none shrink-0" aria-hidden="true">
                    {seed.emoji}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-sm">
                      {ing.amount}× {seed.name}
                    </span>
                    <span className="text-xs text-base-content/40 ml-1">fruit tokens</span>
                  </div>
                  <div className="text-right text-xs text-base-content/40 shrink-0">
                    ≥{seeds} seed{seeds !== 1 ? "s" : ""}
                    <div className="text-base-content/25">{seed.yield}×/harvest</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <CookPanel recipe={recipe} />
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

const DishesPage: NextPage = () => {
  const minuteCountdown = useMinuteCountdown();

  const { data: currentDemandId } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "currentDemand",
  });

  const { data: currentSecondDemandId } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "currentSecondDemand",
  });

  const { data: currentMinute } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "currentMinute",
  });

  const { data: availableFunds } = useScaffoldReadContract({
    contractName: "DishMarket",
    functionName: "availableFunds",
  });

  const liveId = currentDemandId !== undefined ? Number(currentDemandId) : null;
  const liveRecipe = liveId !== null ? RECIPES[liveId] : null;

  const secondLiveId = currentSecondDemandId !== undefined ? Number(currentSecondDemandId) : null;
  const secondLiveRecipe = secondLiveId !== null ? RECIPES[secondLiveId] : null;

  // Next 3 upcoming dishes (based on primary deterministic cycle)
  const upNext = liveId !== null ? [1, 2, 3].map(offset => RECIPES[(liveId + offset) % RECIPES.length]) : [];

  const treasuryFmt = availableFunds !== undefined ? Number(formatEther(availableFunds)).toFixed(4) : null;

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-extrabold flex items-center gap-2">
            <span aria-hidden="true">🍽</span> Dish Recipes
          </h1>
          <p className="text-base-content/50 mt-1 text-sm">
            10 recipes · grow fruits · cook dishes · sell every minute
          </p>
        </div>
        {treasuryFmt !== null && (
          <div className="flex items-center gap-2 bg-base-100 border border-base-200 rounded-xl px-4 py-2.5 shadow-sm">
            <span className="text-xl">💰</span>
            <div>
              <p className="text-xs text-base-content/40 uppercase tracking-widest">Treasury</p>
              <p className="font-extrabold font-mono text-base leading-none">{treasuryFmt} ETH</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Live demand banner ── */}
      {liveRecipe && (
        <div className="bg-warning/10 border border-warning/30 rounded-2xl overflow-hidden">
          {/* Main row */}
          <div className="flex items-center gap-5 px-5 py-4">
            <div className="w-16 h-16 rounded-2xl bg-warning/20 flex items-center justify-center text-4xl shrink-0 shadow-sm">
              {liveRecipe.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-base-content/50 uppercase tracking-widest">Market demands right now</p>
              <p className="font-extrabold text-2xl leading-tight">{liveRecipe.name}</p>
              <p className="text-xs text-base-content/40 font-mono mt-0.5">
                min #{currentMinute?.toString() ?? "—"} · cycle #{liveId}
              </p>
            </div>
            <div className="text-center shrink-0">
              <p className="font-mono text-3xl font-extrabold text-warning tabular-nums leading-none">
                00:{String(minuteCountdown).padStart(2, "0")}
              </p>
              <p className="text-xs text-base-content/40 mt-1">remaining</p>
            </div>
          </div>

          {/* Offer panel */}
          {liveRecipe && (
            <OfferPanel
              recipeId={liveRecipe.id}
              recipeName={liveRecipe.name}
              recipeEmoji={liveRecipe.emoji}
              currentMinute={currentMinute}
            />
          )}

          {/* Up next strip */}
          {upNext.length > 0 && (
            <div className="border-t border-warning/20 bg-warning/5 px-5 py-2.5 flex items-center gap-3">
              <span className="text-xs text-base-content/40 shrink-0 uppercase tracking-widest">Up next</span>
              <div className="flex items-center gap-2 flex-wrap">
                {upNext.map((r, i) => (
                  <span key={r.id} className="flex items-center gap-1 text-sm text-base-content/60">
                    {i > 0 && <span className="text-base-content/20 text-xs">›</span>}
                    <span aria-hidden="true">{r.emoji}</span>
                    <span className="text-xs">{r.name}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Secondary demand banner ── */}
      {secondLiveRecipe && (
        <div className="bg-secondary/10 border border-secondary/30 rounded-2xl overflow-hidden">
          <div className="flex items-center gap-5 px-5 py-4">
            <div className="w-16 h-16 rounded-2xl bg-secondary/20 flex items-center justify-center text-4xl shrink-0 shadow-sm">
              {secondLiveRecipe.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-base-content/50 uppercase tracking-widest">Also demanded this epoch</p>
              <p className="font-extrabold text-2xl leading-tight">{secondLiveRecipe.name}</p>
              <p className="text-xs text-base-content/40 font-mono mt-0.5">
                min #{currentMinute?.toString() ?? "—"} · pseudo-random demand
              </p>
            </div>
          </div>
          <OfferPanel
            recipeId={secondLiveRecipe.id}
            recipeName={secondLiveRecipe.name}
            recipeEmoji={secondLiveRecipe.emoji}
            currentMinute={currentMinute}
          />
        </div>
      )}

      {/* ── Recipe grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {RECIPES.map(recipe => (
          <RecipeCard
            key={recipe.id}
            recipe={recipe}
            isLive={recipe.id === liveId}
            isSecondary={recipe.id === secondLiveId}
            currentMinute={currentMinute !== undefined ? Number(currentMinute) : null}
          />
        ))}
      </div>

      {/* ── How it works ── */}
      <section>
        <p className="font-bold text-base mb-3">How it works</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              step: "1",
              icon: "🌱",
              title: "Grow",
              desc: "Buy seeds, plant on your land, wait for maturity, harvest fruit tokens.",
            },
            {
              step: "2",
              icon: "👨‍🍳",
              title: "Cook",
              desc: "Approve the Chef, burn ingredients with startCooking, claim your dish token after prep time.",
            },
            {
              step: "3",
              icon: "📈",
              title: "Sell",
              desc: "Approve DishMarket, submit an ask ≤ 2× seed cost. Every minute a recipe is demanded — lowest ask wins.",
            },
            {
              step: "4",
              icon: "💸",
              title: "Collect",
              desc: "After the minute ends, the winner calls settle() to burn their dish and receive ETH from the treasury.",
            },
          ].map(({ step, icon, title, desc }) => (
            <div
              key={step}
              className="bg-base-100 border border-base-200 rounded-2xl p-4 flex flex-col gap-2 shadow-sm"
            >
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-extrabold flex items-center justify-center shrink-0">
                  {step}
                </span>
                <span className="text-xl leading-none">{icon}</span>
                <span className="font-bold">{title}</span>
              </div>
              <p className="text-xs text-base-content/50 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export default DishesPage;
