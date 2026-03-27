/**
 * Farm Bot v2 — multi-recipe, demand-aware strategy.
 *
 * Strategy:
 *   1. Acquire up to MAX_LANDS land plots via LandAuction.
 *   2. Look LOOKAHEAD_MINUTES ahead to see which recipes will be demanded.
 *   3. Plant the seeds most urgently needed for those upcoming recipes.
 *   4. Harvest / cleanup plots as needed.
 *   5. Cook all recipes whose ingredients are available (multiple simultaneously).
 *   6. Submit the lowest ask for whichever dish the market currently demands.
 *   7. Settle winning offers; withdraw losing ones.
 *
 * Usage:
 *   yarn bot                              (localhost)
 *   yarn hardhat run scripts/farmBot.ts --network <net>
 *
 * Notes:
 *   - Uses Hardhat account[1] by default (not the deployer).
 *   - Demand cycle: minute % 10 = recipeId (10 recipes, repeating).
 */

import hre from "hardhat";
import { ethers } from "ethers";
import type { Signer } from "ethers";
import type { FarmManager, Chef, DishMarket, LandAuction, SeedShop } from "../typechain-types";

// ─── Config ───────────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 10_000; // 10 s between ticks
const MAX_LANDS = 3; // max land plots to acquire
const BID_INCREMENT = ethers.parseEther("0.001");
const MAX_BID = ethers.parseEther("0.1");
const SEEDS_TO_BUY = 20n; // seeds to purchase per shop call
const SEEDS_TO_PLANT = 5n; // seeds to plant per land per cycle
const ASK_PRICE_PCT = 120n; // ask at 120% of seed cost
const LOOKAHEAD_MINUTES = 12; // plan this many minutes ahead (> 1 full 10-recipe cycle)

// ─── Recipe catalog ───────────────────────────────────────────────────────────
// Matches deploy/04_deploy_chef.ts — demand cycle: minute % RECIPE_COUNT = recipeId

type Ingredient = { seedId: number; amount: bigint };
type Recipe = { id: number; name: string; prepSecs: number; ingredients: Ingredient[] };

const RECIPES: Recipe[] = [
  {
    id: 0,
    name: "Tomato Soup",
    prepSecs: 180,
    ingredients: [
      { seedId: 0, amount: 3n },
      { seedId: 4, amount: 1n },
    ],
  },
  {
    id: 1,
    name: "Green Salad",
    prepSecs: 120,
    ingredients: [
      { seedId: 1, amount: 2n },
      { seedId: 6, amount: 1n },
      { seedId: 7, amount: 1n },
    ],
  },
  { id: 2, name: "Lemonade", prepSecs: 60, ingredients: [{ seedId: 15, amount: 3n }] },
  {
    id: 3,
    name: "Carrot Cake",
    prepSecs: 300,
    ingredients: [
      { seedId: 2, amount: 3n },
      { seedId: 15, amount: 2n },
    ],
  },
  {
    id: 4,
    name: "Pumpkin Pie",
    prepSecs: 420,
    ingredients: [
      { seedId: 8, amount: 2n },
      { seedId: 3, amount: 1n },
    ],
  },
  { id: 5, name: "Mango Juice", prepSecs: 120, ingredients: [{ seedId: 13, amount: 3n }] },
  {
    id: 6,
    name: "Watermelon Smoothie",
    prepSecs: 120,
    ingredients: [
      { seedId: 11, amount: 2n },
      { seedId: 15, amount: 1n },
    ],
  },
  {
    id: 7,
    name: "Fruit Salad",
    prepSecs: 180,
    ingredients: [
      { seedId: 10, amount: 2n },
      { seedId: 12, amount: 2n },
      { seedId: 16, amount: 2n },
    ],
  },
  {
    id: 8,
    name: "Pineapple Sorbet",
    prepSecs: 240,
    ingredients: [
      { seedId: 14, amount: 2n },
      { seedId: 18, amount: 2n },
    ],
  },
  {
    id: 9,
    name: "Mixed Pickle",
    prepSecs: 240,
    ingredients: [
      { seedId: 2, amount: 2n },
      { seedId: 6, amount: 2n },
      { seedId: 4, amount: 1n },
      { seedId: 5, amount: 1n },
    ],
  },
];

const RECIPE_COUNT = RECIPES.length; // 10

// ─── Runtime state ────────────────────────────────────────────────────────────

/** Minutes where we submitted an offer that may need settle or withdraw. */
const pendingOfferMinutes = new Set<bigint>();

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(msg: string) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function tryTx(label: string, fn: () => Promise<{ wait: () => Promise<unknown> }>): Promise<boolean> {
  try {
    const tx = await fn();
    await tx.wait();
    log(`  ✅ ${label}`);
    return true;
  } catch (err: unknown) {
    const msg =
      (err as { shortMessage?: string; message?: string })?.shortMessage ??
      (err as { message?: string })?.message ??
      String(err);
    log(`  ⚠️  ${label} → ${msg.slice(0, 100)}`);
    return false;
  }
}

async function ensureApproved(tokenAddr: string, spender: string, signer: Signer): Promise<void> {
  const erc20 = await hre.ethers.getContractAt("ERC20", tokenAddr, signer);
  const owner = await signer.getAddress();
  const allowance: bigint = await erc20.allowance(owner, spender);
  if (allowance === 0n) {
    await tryTx(`approve ${tokenAddr.slice(0, 10)}… → ${spender.slice(0, 10)}…`, () =>
      erc20.approve(spender, ethers.MaxUint256, { gasLimit: 100_000 }),
    );
  }
}

// ─── Demand planning ──────────────────────────────────────────────────────────

/** Compute the secondary (pseudo-random) demanded recipe for an epoch — mirrors DishMarket._secondDemandForEpoch. */
function computeSecondDemand(epoch: bigint, primaryId: number, count: number): number {
  const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["dish2", epoch]));
  let raw = Number(BigInt(hash) % BigInt(count));
  if (raw === primaryId) raw = (raw + 1) % count;
  return raw;
}

/** Returns the sequence of recipe demands within the lookahead window (both primary + secondary), soonest first. */
function upcomingDemands(currentMinute: bigint): { recipeId: number; minutesUntil: number }[] {
  const result: { recipeId: number; minutesUntil: number }[] = [];
  for (let i = 0; i <= LOOKAHEAD_MINUTES; i++) {
    const epoch = currentMinute + BigInt(i);
    const primaryId = Number(epoch % BigInt(RECIPE_COUNT));
    const secondaryId = computeSecondDemand(epoch, primaryId, RECIPE_COUNT);
    result.push({ recipeId: primaryId, minutesUntil: i });
    if (secondaryId !== primaryId) {
      result.push({ recipeId: secondaryId, minutesUntil: i });
    }
  }
  return result;
}

/**
 * Returns seedIds sorted by urgency: seeds whose fruit tokens are most needed
 * for the soonest upcoming demanded recipe come first. Seeds we already have
 * enough fruit tokens for are excluded.
 */
async function prioritizedSeedNeeds(
  currentMinute: bigint,
  chef: Chef,
  farmManager: FarmManager,
  botAddr: string,
  signer: Signer,
): Promise<number[]> {
  // seedId → minutes until earliest demand that needs it
  const seedUrgency = new Map<number, number>();

  for (const { recipeId, minutesUntil } of upcomingDemands(currentMinute)) {
    // Skip if we already hold a dish token for this recipe
    const recipeInfo = await chef.getRecipe(recipeId);
    const dishToken = await hre.ethers.getContractAt("ERC20", recipeInfo[3], signer);
    if ((await dishToken.balanceOf(botAddr)) > 0n) continue;

    // Skip if already cooking and will finish before this recipe is demanded
    const cookStart: bigint = await chef.cookingStartTime(botAddr, recipeId);
    if (cookStart > 0n) {
      const timeLeft: bigint = await chef.timeUntilReady(botAddr, recipeId);
      if (Number(timeLeft) <= minutesUntil * 60) continue;
    }

    const ingredients = await chef.getIngredients(recipeId);
    for (const ing of ingredients) {
      const fruitToken = await hre.ethers.getContractAt("ERC20", ing.token, signer);
      const bal: bigint = await fruitToken.balanceOf(botAddr);
      if (bal < ing.amount) {
        const seedId = Number(await farmManager.fruitToSeedId(ing.token));
        const existing = seedUrgency.get(seedId);
        if (existing === undefined || minutesUntil < existing) {
          seedUrgency.set(seedId, minutesUntil);
        }
      }
    }
  }

  return [...seedUrgency.entries()].sort((a, b) => a[1] - b[1]).map(([seedId]) => seedId);
}

// ─── Auction management ───────────────────────────────────────────────────────

async function manageAuction(auction: LandAuction, botAddr: string, ownedLands: number[]): Promise<void> {
  if (ownedLands.length >= MAX_LANDS) return;

  const totalLands = await auction.TOTAL_LANDS();
  const currentLandId = await auction.currentLandId();
  if (currentLandId >= totalLands) {
    log("  🏁 All 100 lands have been auctioned");
    return;
  }

  const [active, highestBid, highestBidder, endTime] = await Promise.all([
    auction.auctionActive(),
    auction.highestBid(),
    auction.highestBidder(),
    auction.auctionEndTime(),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (active && endTime > 0n && now >= endTime && highestBidder.toLowerCase() === botAddr.toLowerCase()) {
    await tryTx(`settle auction → land #${currentLandId}`, () => auction.settleAuction({ gasLimit: 200_000 }));
    return;
  }

  if (highestBidder.toLowerCase() === botAddr.toLowerCase()) {
    log(`  🏆 Leading land #${currentLandId} auction at ${ethers.formatEther(highestBid)} ETH`);
    return;
  }

  const bidAmount = highestBid === 0n ? ethers.parseEther("0.001") : highestBid + BID_INCREMENT;
  if (bidAmount > MAX_BID) {
    log(`  💸 Bid ${ethers.formatEther(bidAmount)} ETH exceeds cap, skipping`);
    return;
  }
  await tryTx(`bid ${ethers.formatEther(bidAmount)} ETH on land #${currentLandId}`, () =>
    auction.bid({ value: bidAmount, gasLimit: 200_000 }),
  );
}

async function claimRefund(auction: LandAuction, botAddr: string): Promise<void> {
  const pending: bigint = await auction.pendingWithdrawals(botAddr);
  if (pending > 0n) {
    await tryTx(`withdraw refund ${ethers.formatEther(pending)} ETH`, () =>
      auction.withdrawRefund({ gasLimit: 100_000 }),
    );
  }
}

// ─── Farm plot management ─────────────────────────────────────────────────────

async function managePlots(
  farmManager: FarmManager,
  seedShop: SeedShop,
  chef: Chef,
  dishMarket: DishMarket,
  ownedLands: number[],
  botAddr: string,
  signer: Signer,
): Promise<void> {
  const farmManagerAddr = await farmManager.getAddress();

  const currentMinute: bigint = await dishMarket.currentMinute();
  // Compute seed priority once; mutate as we assign seeds to empty lands so
  // each land gets a different (next-priority) seed.
  const seedQueue = await prioritizedSeedNeeds(currentMinute, chef, farmManager, botAddr, signer);

  for (const landId of ownedLands) {
    const state: bigint = await farmManager.getLandState(landId);

    if (state === 2n) {
      // ── Mature: harvest ──
      await tryTx(`harvest land #${landId}`, () => farmManager.harvest(landId, { gasLimit: 200_000 }));
    } else if (state === 3n || state === 4n) {
      // ── Rotten / NeedsCleanup ──
      const plot = await farmManager.plots(landId);
      const config = await farmManager.farmConfigs(plot[0]);
      await tryTx(`cleanup land #${landId}`, () =>
        farmManager.cleanUp(landId, { value: config[3], gasLimit: 200_000 }),
      );
    } else if (state === 1n) {
      // ── Growing: just wait ──
      log(`  🌱 land #${landId} — growing`);
    } else if (state === 0n) {
      // ── Empty: plant highest-priority needed seed ──
      if (seedQueue.length === 0) {
        log(`  🌱 land #${landId} empty — no urgent seed needs right now`);
        continue;
      }

      const targetSeedId = seedQueue[0];
      const seedTokenAddr: string = await seedShop.seedToken(targetSeedId);
      const seedErc20 = await hre.ethers.getContractAt("ERC20", seedTokenAddr, signer);
      let seedBal: bigint = await seedErc20.balanceOf(botAddr);

      if (seedBal < SEEDS_TO_PLANT) {
        const price: bigint = await seedShop.seedPrice(targetSeedId);
        await tryTx(`buy ${SEEDS_TO_BUY} × seedId #${targetSeedId}`, () =>
          seedShop.buy(targetSeedId, SEEDS_TO_BUY, { value: price * SEEDS_TO_BUY, gasLimit: 100_000 }),
        );
        seedBal = await seedErc20.balanceOf(botAddr);
      }

      if (seedBal >= 1n) {
        await ensureApproved(seedTokenAddr, farmManagerAddr, signer);
        const toPlant = seedBal < SEEDS_TO_PLANT ? seedBal : SEEDS_TO_PLANT;
        await tryTx(`plant ${toPlant} × seedId #${targetSeedId} on land #${landId}`, () =>
          farmManager.plant(landId, targetSeedId, toPlant, { gasLimit: 200_000 }),
        );
        // Consume this slot so the next empty land plants the next-priority seed
        seedQueue.shift();
      }
    }
  }
}

// ─── Cooking management ───────────────────────────────────────────────────────

async function manageCooking(chef: Chef, dishMarket: DishMarket, botAddr: string, signer: Signer): Promise<void> {
  const chefAddr = await chef.getAddress();
  const currentMinute: bigint = await dishMarket.currentMinute();

  for (const { recipeId, minutesUntil } of upcomingDemands(currentMinute)) {
    const recipeInfo = await chef.getRecipe(recipeId);
    const recipeName: string = recipeInfo[0];
    const dishTokenAddr: string = recipeInfo[3];

    const cookStart: bigint = await chef.cookingStartTime(botAddr, recipeId);

    if (cookStart > 0n) {
      // Already cooking — claim if ready
      const timeLeft: bigint = await chef.timeUntilReady(botAddr, recipeId);
      if (timeLeft === 0n) {
        await tryTx(`claim ${recipeName} (recipe #${recipeId})`, () => chef.claim(recipeId, { gasLimit: 400_000 }));
      } else {
        log(`  🍳 Cooking ${recipeName} — ready in ${timeLeft}s (demand in ${minutesUntil}m)`);
      }
      continue;
    }

    // Skip if we already hold a dish token
    const dishToken = await hre.ethers.getContractAt("ERC20", dishTokenAddr, signer);
    if ((await dishToken.balanceOf(botAddr)) > 0n) continue;

    // Check if we have all fruit-token ingredients
    const ingredients = await chef.getIngredients(recipeId);
    let canCook = true;
    for (const ing of ingredients) {
      const fruitToken = await hre.ethers.getContractAt("ERC20", ing.token, signer);
      if ((await fruitToken.balanceOf(botAddr)) < ing.amount) {
        canCook = false;
        break;
      }
    }
    if (!canCook) continue;

    // Approve all ingredient tokens and start cooking
    for (const ing of ingredients) {
      await ensureApproved(ing.token, chefAddr, signer);
    }
    await tryTx(`start cooking ${recipeName} (recipe #${recipeId}, demand in ${minutesUntil}m)`, () =>
      chef.startCooking(recipeId, 1, { gasLimit: 600_000 }),
    );
  }
}

// ─── Market management ────────────────────────────────────────────────────────

async function manageMarket(
  dishMarket: DishMarket,
  chef: Chef,
  seedShop: SeedShop,
  farmManager: FarmManager,
  botAddr: string,
  signer: Signer,
): Promise<void> {
  const dishMarketAddr = await dishMarket.getAddress();
  const currentMin: bigint = await dishMarket.currentMinute();

  // ── Settle / withdraw past offers ────────────────────────────────────────
  const MAX_WINNERS = 3;
  for (const pastMin of [...pendingOfferMinutes]) {
    if (pastMin >= currentMin) continue;

    const offers = await dishMarket.getOffers(pastMin);
    const myIdxs = offers
      .map((o, i) => i)
      .filter(i => offers[i].seller.toLowerCase() === botAddr.toLowerCase() && !offers[i].claimed);

    if (myIdxs.length === 0) {
      pendingOfferMinutes.delete(pastMin);
      continue;
    }

    for (const myIdx of myIdxs) {
      const myAsk = offers[myIdx].askPrice;
      const myRecipeId = offers[myIdx].recipeId;
      const betterCount = offers.filter(
        (o, i) => i !== myIdx && o.recipeId === myRecipeId && o.askPrice < myAsk,
      ).length;
      const amWinner = betterCount < MAX_WINNERS;

      if (amWinner) {
        await tryTx(`settle market epoch #${pastMin} recipe #${myRecipeId}`, () =>
          dishMarket.settle(pastMin, myIdx, { gasLimit: 200_000 }),
        );
      } else {
        await tryTx(`withdraw losing offer epoch #${pastMin} recipe #${myRecipeId}`, () =>
          dishMarket.withdrawOffer(pastMin, myIdx, { gasLimit: 100_000 }),
        );
      }
    }

    pendingOfferMinutes.delete(pastMin);
  }

  // ── Submit offer for both demanded dishes ────────────────────────────────
  const availableFunds: bigint = await dishMarket.availableFunds();
  if (availableFunds === 0n) {
    log("  ⚠️  DishMarket treasury is empty");
    return;
  }

  const primaryId: bigint = await dishMarket.currentDemand();
  const secondId: bigint = await dishMarket.currentSecondDemand();
  const demandedIds = [primaryId, secondId].filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate

  let submittedAny = false;
  for (const demandedRecipeId of demandedIds) {
    const alreadyOffered: boolean = await dishMarket.hasOffered(currentMin, demandedRecipeId, botAddr);
    if (alreadyOffered) {
      log(`  📈 Offer already submitted for epoch #${currentMin} recipe #${demandedRecipeId}`);
      continue;
    }

    const recipeInfo = await chef.getRecipe(demandedRecipeId);
    const demandedName: string = recipeInfo[0];
    const dishTokenAddr: string = recipeInfo[3];
    const dishToken = await hre.ethers.getContractAt("ERC20", dishTokenAddr, signer);
    const dishBal: bigint = await dishToken.balanceOf(botAddr);
    if (dishBal === 0n) {
      log(`  📈 Market demands ${demandedName} — no dish tokens yet`);
      continue;
    }

    // Compute ask price = ASK_PRICE_PCT% of the seed cost to produce one dish
    const ingredients = await chef.getIngredients(demandedRecipeId);
    let seedCost = 0n;
    for (const ing of ingredients) {
      const seedId: bigint = await farmManager.fruitToSeedId(ing.token);
      const yld: bigint = await farmManager.harvestYield(seedId);
      const seedsNeeded = (ing.amount + yld - 1n) / yld; // ceiling division
      seedCost += (await seedShop.seedPrice(seedId)) * seedsNeeded;
    }

    let askPrice = (seedCost * ASK_PRICE_PCT) / 100n;
    if (askPrice === 0n) askPrice = 1n;
    if (askPrice > availableFunds) askPrice = availableFunds;

    await ensureApproved(dishTokenAddr, dishMarketAddr, signer);

    const ok = await tryTx(
      `submit offer ${ethers.formatEther(askPrice)} ETH for ${demandedName} (epoch #${currentMin})`,
      () => dishMarket.submitOffer(demandedRecipeId, askPrice, 1, { gasLimit: 600_000 }),
    );
    if (ok) submittedAny = true;
  }

  if (submittedAny) pendingOfferMinutes.add(currentMin);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, signer] = await hre.ethers.getSigners(); // account[1], not deployer
  const botAddr = await signer.getAddress();

  log("╔══════════════════════════════════════════╗");
  log("║  🌾 On-Chain Farm Bot v2                 ║");
  log("╚══════════════════════════════════════════╝");
  log(`Account  : ${botAddr}`);
  log(`Network  : ${hre.network.name}`);
  log(`Strategy : demand-aware — all ${RECIPE_COUNT} recipes, ${LOOKAHEAD_MINUTES}-minute lookahead`);
  log(`Interval : ${TICK_INTERVAL_MS / 1000}s — max ${MAX_LANDS} lands`);
  log("");

  const [aD, sD, fD, cD, mD] = await Promise.all([
    hre.deployments.get("LandAuction"),
    hre.deployments.get("SeedShop"),
    hre.deployments.get("FarmManager"),
    hre.deployments.get("Chef"),
    hre.deployments.get("DishMarket"),
  ]);

  const auction = await hre.ethers.getContractAt("LandAuction", aD.address, signer);
  const seedShop = await hre.ethers.getContractAt("SeedShop", sD.address, signer);
  const farmManager = await hre.ethers.getContractAt("FarmManager", fD.address, signer);
  const chef = await hre.ethers.getContractAt("Chef", cD.address, signer);
  const dishMarket = await hre.ethers.getContractAt("DishMarket", mD.address, signer);

  log("Contracts:");
  log(`  LandAuction: ${aD.address}`);
  log(`  SeedShop:    ${sD.address}`);
  log(`  FarmManager: ${fD.address}`);
  log(`  Chef:        ${cD.address}`);
  log(`  DishMarket:  ${mD.address}`);
  log("");

  let tick = 0;
  while (true) {
    tick++;
    const bal: bigint = await hre.ethers.provider.getBalance(botAddr);
    log(`── Tick #${tick} ── Balance: ${ethers.formatEther(bal).slice(0, 8)} ETH ──`);

    // Discover which lands this bot owns
    const currentLandId: bigint = await auction.currentLandId();
    const ownedLands: number[] = [];
    for (let i = 0; i < Number(currentLandId); i++) {
      const owner: string = await auction.landOwner(i);
      if (owner.toLowerCase() === botAddr.toLowerCase()) ownedLands.push(i);
    }
    log(`  🏞️  Owned lands: [${ownedLands.length > 0 ? ownedLands.join(", ") : "none"}]`);

    // Show upcoming demand schedule
    const currentMinute: bigint = await dishMarket.currentMinute();
    const upcoming = upcomingDemands(currentMinute);
    log(
      `  📅 Upcoming: ${upcoming
        .slice(0, 6)
        .map(d => `${RECIPES[d.recipeId].name}(+${d.minutesUntil}m)`)
        .join(" → ")}`,
    );

    await manageAuction(auction, botAddr, ownedLands).catch((e: Error) => log(`  ❌ auction: ${e.message}`));
    await claimRefund(auction, botAddr).catch((e: Error) => log(`  ❌ refund: ${e.message}`));
    if (ownedLands.length > 0) {
      await managePlots(farmManager, seedShop, chef, dishMarket, ownedLands, botAddr, signer).catch((e: Error) =>
        log(`  ❌ plots: ${e.message}`),
      );
    }
    await manageCooking(chef, dishMarket, botAddr, signer).catch((e: Error) => log(`  ❌ cooking: ${e.message}`));
    await manageMarket(dishMarket, chef, seedShop, farmManager, botAddr, signer).catch((e: Error) =>
      log(`  ❌ market: ${e.message}`),
    );

    log("");
    await sleep(TICK_INTERVAL_MS);
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
