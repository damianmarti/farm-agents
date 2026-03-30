/**
 * Off-chain Monte Carlo simulation of the farm game economy (no watering).
 *
 * Models 30 bots with varied strategies competing over 48 hours.
 * All numbers derived from deploy scripts and contract parameters.
 *
 * Usage: npx tsx packages/hardhat/scripts/simulate.ts
 */

// ─── Game parameters (from deploy scripts) ──────────────────────────────────

const GAS_PRICE_GWEI = 0.05;
const WEI_PER_GWEI = 1e9;
const GAS_PRICE_WEI = GAS_PRICE_GWEI * WEI_PER_GWEI;
const ETH = 1e18;

const GAS: Record<string, number> = {
  bid: 80_000,
  settleAuction: 70_000,
  buySeed: 65_000,
  approve: 46_000,
  plant: 95_000,
  harvest: 110_000,
  cleanup: 75_000,
  startCooking: 120_000,
  claim: 90_000,
  submitOffer: 130_000,
  settle: 100_000,
  withdrawOffer: 80_000,
};

function gasCostEth(gasUsed: number): number {
  return (gasUsed * GAS_PRICE_WEI) / ETH;
}

// Seed catalog (from 02_deploy_seed_shop.ts — halved prices)
const SEEDS = [
  { id: 0, name: "Tomato", price: 0.00005, maxCap: 20, matTime: 180, rotTime: 60, cleanupCost: 0.000002, yield: 3 },
  { id: 1, name: "Lettuce", price: 0.000025, maxCap: 30, matTime: 120, rotTime: 60, cleanupCost: 0.000001, yield: 2 },
  { id: 2, name: "Carrot", price: 0.00004, maxCap: 25, matTime: 240, rotTime: 60, cleanupCost: 0.000002, yield: 2 },
  { id: 3, name: "Potato", price: 0.00003, maxCap: 20, matTime: 300, rotTime: 120, cleanupCost: 0.000003, yield: 4 },
  { id: 4, name: "Onion", price: 0.00002, maxCap: 30, matTime: 360, rotTime: 120, cleanupCost: 0.000002, yield: 2 },
  { id: 5, name: "Pepper", price: 0.00005, maxCap: 15, matTime: 240, rotTime: 60, cleanupCost: 0.000002, yield: 3 },
  { id: 6, name: "Cucumber", price: 0.000035, maxCap: 20, matTime: 180, rotTime: 60, cleanupCost: 0.000002, yield: 3 },
  { id: 7, name: "Spinach", price: 0.000025, maxCap: 40, matTime: 120, rotTime: 60, cleanupCost: 0.000001, yield: 2 },
  { id: 8, name: "Pumpkin", price: 0.00006, maxCap: 10, matTime: 420, rotTime: 180, cleanupCost: 0.000005, yield: 5 },
  { id: 9, name: "Broccoli", price: 0.000045, maxCap: 20, matTime: 180, rotTime: 60, cleanupCost: 0.000002, yield: 2 },
  { id: 10, name: "Strawberry", price: 0.0001, maxCap: 15, matTime: 240, rotTime: 60, cleanupCost: 0.000003, yield: 4 },
  {
    id: 11,
    name: "Watermelon",
    price: 0.00015,
    maxCap: 5,
    matTime: 420,
    rotTime: 120,
    cleanupCost: 0.000005,
    yield: 5,
  },
  {
    id: 12,
    name: "Blueberry",
    price: 0.000125,
    maxCap: 20,
    matTime: 300,
    rotTime: 60,
    cleanupCost: 0.000003,
    yield: 3,
  },
  { id: 13, name: "Mango", price: 0.000175, maxCap: 10, matTime: 360, rotTime: 120, cleanupCost: 0.000004, yield: 4 },
  { id: 14, name: "Pineapple", price: 0.0002, maxCap: 5, matTime: 420, rotTime: 180, cleanupCost: 0.000006, yield: 6 },
  { id: 15, name: "Lemon", price: 0.000075, maxCap: 15, matTime: 240, rotTime: 60, cleanupCost: 0.000003, yield: 3 },
  { id: 16, name: "Grape", price: 0.0001, maxCap: 20, matTime: 300, rotTime: 120, cleanupCost: 0.000003, yield: 4 },
  { id: 17, name: "Peach", price: 0.00009, maxCap: 10, matTime: 360, rotTime: 120, cleanupCost: 0.000004, yield: 4 },
  { id: 18, name: "Cherry", price: 0.00015, maxCap: 15, matTime: 300, rotTime: 60, cleanupCost: 0.000004, yield: 5 },
  { id: 19, name: "Melon", price: 0.00011, maxCap: 8, matTime: 360, rotTime: 120, cleanupCost: 0.000004, yield: 4 },
];

type Ingredient = { seedId: number; amount: number };
type Recipe = { id: number; name: string; prepTime: number; dishAmount: number; ingredients: Ingredient[] };

const RECIPES: Recipe[] = [
  {
    id: 0,
    name: "Tomato Soup",
    prepTime: 180,
    dishAmount: 2,
    ingredients: [
      { seedId: 0, amount: 3 },
      { seedId: 4, amount: 1 },
    ],
  },
  {
    id: 1,
    name: "Green Salad",
    prepTime: 120,
    dishAmount: 2,
    ingredients: [
      { seedId: 1, amount: 2 },
      { seedId: 6, amount: 1 },
      { seedId: 7, amount: 1 },
    ],
  },
  { id: 2, name: "Lemonade", prepTime: 60, dishAmount: 3, ingredients: [{ seedId: 15, amount: 3 }] },
  {
    id: 3,
    name: "Carrot Cake",
    prepTime: 300,
    dishAmount: 2,
    ingredients: [
      { seedId: 2, amount: 3 },
      { seedId: 15, amount: 2 },
    ],
  },
  {
    id: 4,
    name: "Pumpkin Pie",
    prepTime: 420,
    dishAmount: 2,
    ingredients: [
      { seedId: 8, amount: 2 },
      { seedId: 3, amount: 1 },
    ],
  },
  { id: 5, name: "Mango Juice", prepTime: 120, dishAmount: 3, ingredients: [{ seedId: 13, amount: 3 }] },
  {
    id: 6,
    name: "Watermelon Smoothie",
    prepTime: 120,
    dishAmount: 2,
    ingredients: [
      { seedId: 11, amount: 2 },
      { seedId: 15, amount: 1 },
    ],
  },
  {
    id: 7,
    name: "Fruit Salad",
    prepTime: 180,
    dishAmount: 2,
    ingredients: [
      { seedId: 10, amount: 2 },
      { seedId: 12, amount: 2 },
      { seedId: 16, amount: 2 },
    ],
  },
  {
    id: 8,
    name: "Pineapple Sorbet",
    prepTime: 240,
    dishAmount: 2,
    ingredients: [
      { seedId: 14, amount: 2 },
      { seedId: 18, amount: 2 },
    ],
  },
  {
    id: 9,
    name: "Mixed Pickle",
    prepTime: 240,
    dishAmount: 3,
    ingredients: [
      { seedId: 2, amount: 2 },
      { seedId: 6, amount: 2 },
      { seedId: 4, amount: 1 },
      { seedId: 5, amount: 1 },
    ],
  },
];

const RECIPE_COUNT = RECIPES.length;

// ─── Secondary demand helper ────────────────────────────────────────────────
// Simulates block.prevrandao — a fresh random value each epoch tick.
// Uses xorshift32 with a per-run salt so each simulation run produces different results.

const RUN_SALT = (Math.random() * 0xffffffff) >>> 0;

function secondDemandForEpoch(epoch: number, primaryId: number, count: number): number {
  // xorshift32 seeded with epoch XOR a per-run salt — different each run
  let x = ((epoch * 2_654_435_761) ^ RUN_SALT) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const raw = (x >>> 0) % count;
  return raw === primaryId ? (raw + 1) % count : raw;
}

// ─── Economics helpers ──────────────────────────────────────────────────────

function recipeSeedCost(recipe: Recipe): number {
  let cost = 0;
  for (const ing of recipe.ingredients) {
    const seed = SEEDS[ing.seedId];
    const seedsNeeded = Math.ceil(ing.amount / seed.yield);
    cost += seed.price * seedsNeeded;
  }
  return cost;
}

function recipePriceCap(recipe: Recipe): number {
  const len = recipe.ingredients.length;
  const multiplier = len >= 4 ? 30 : 20;
  return recipeSeedCost(recipe) * multiplier;
}

// ─── Bot strategy definition ────────────────────────────────────────────────

type BotStrategy = {
  name: string;
  archetype: string; // category for grouping in reports
  lands: number;
  batchSize: number;
  askPricePct: number; // ask as % of seed cost
  dishesPerOffer: number;
  targetRecipes: number[]; // -1 = all
  aggressiveness: number; // 0-1, chance to undercut
  conservatism: number; // 0-1, 1 = only buy seeds when inventory is empty
};

// Generate 30 diverse bots across 6 archetypes
function generateStrategies(): BotStrategy[] {
  const strats: BotStrategy[] = [];
  let idx = 0;

  // ── Archetype 1: Speed Runners (5 bots) — fast cheap recipes, low margins ──
  const fastRecipes = [1, 2, 5]; // Salad 2m, Lemonade 1m, Mango Juice 2m
  for (let i = 0; i < 5; i++) {
    strats.push({
      name: `SpeedRunner-${++idx}`,
      archetype: "Speed Runner",
      lands: 2 + (i % 3),
      batchSize: 3 + i * 2,
      askPricePct: 200 + i * 50,
      dishesPerOffer: 1 + i,
      targetRecipes: fastRecipes,
      aggressiveness: 0.3 + i * 0.1,
      conservatism: 0.2 + i * 0.1,
    });
  }

  // ── Archetype 2: Premium Chefs (5 bots) — expensive recipes, high margins ──
  const expensiveRecipes = [7, 8, 6]; // Fruit Salad, Pineapple Sorbet, Watermelon Smoothie
  for (let i = 0; i < 5; i++) {
    strats.push({
      name: `PremiumChef-${++idx}`,
      archetype: "Premium Chef",
      lands: 3 + (i % 3),
      batchSize: 2 + i,
      askPricePct: 500 + i * 200,
      dishesPerOffer: 1 + Math.floor(i / 2),
      targetRecipes: expensiveRecipes,
      aggressiveness: 0.2 + i * 0.05,
      conservatism: 0.5 + i * 0.05,
    });
  }

  // ── Archetype 3: Generalists (5 bots) — all recipes, moderate margins ──
  for (let i = 0; i < 5; i++) {
    strats.push({
      name: `Generalist-${++idx}`,
      archetype: "Generalist",
      lands: 3 + i,
      batchSize: 5 + i * 3,
      askPricePct: 300 + i * 100,
      dishesPerOffer: 2 + i,
      targetRecipes: [-1],
      aggressiveness: 0.4 + i * 0.1,
      conservatism: 0.3 + i * 0.1,
    });
  }

  // ── Archetype 4: Snipers (5 bots) — only sell when no competition ──
  for (let i = 0; i < 5; i++) {
    const recipeSubset = [i * 2, i * 2 + 1];
    strats.push({
      name: `Sniper-${++idx}`,
      archetype: "Sniper",
      lands: 1 + (i % 2),
      batchSize: 2 + i,
      askPricePct: 800 + i * 300,
      dishesPerOffer: 1,
      targetRecipes: recipeSubset,
      aggressiveness: 0.05,
      conservatism: 0.8,
    });
  }

  // ── Archetype 5: Batch Masters (5 bots) — max batch cooking, volume selling ──
  for (let i = 0; i < 5; i++) {
    const recipeGroup = [i, (i + 3) % 10, (i + 7) % 10];
    strats.push({
      name: `BatchMaster-${++idx}`,
      archetype: "Batch Master",
      lands: 4 + (i % 2),
      batchSize: 15 + i * 5,
      askPricePct: 250 + i * 100,
      dishesPerOffer: 5 + i * 2,
      targetRecipes: recipeGroup,
      aggressiveness: 0.5 + i * 0.05,
      conservatism: 0.3,
    });
  }

  // ── Archetype 6: Undercut Bots (5 bots) — always try to be cheapest ──
  for (let i = 0; i < 5; i++) {
    strats.push({
      name: `Undercut-${++idx}`,
      archetype: "Undercutter",
      lands: 3 + (i % 3),
      batchSize: 5 + i * 2,
      askPricePct: 150 + i * 30,
      dishesPerOffer: 2 + i,
      targetRecipes: [-1],
      aggressiveness: 0.9,
      conservatism: 0.2,
    });
  }

  // ── Archetype 7: Pickle Specialists (2 bots) — target Mixed Pickle (4 ingredients, 30×) ──
  for (let i = 0; i < 2; i++) {
    strats.push({
      name: `PickleBot-${++idx}`,
      archetype: "Pickle Specialist",
      lands: 4 + i,
      batchSize: 5 + i * 5,
      askPricePct: 600 + i * 400,
      dishesPerOffer: 3 + i * 2,
      targetRecipes: [9],
      aggressiveness: 0.3 + i * 0.1,
      conservatism: 0.2,
    });
  }

  return strats;
}

// ─── Bot state ──────────────────────────────────────────────────────────────

type BotState = {
  strategy: BotStrategy;
  balance: number;
  totalInvested: number;
  gasSpent: number;
  seedsSpent: number;
  cleanupSpent: number;
  landCost: number;
  dishesSold: number;
  dishesCooked: number;
  revenue: number;
  wins: number;
  losses: number;
  inventory: Map<number, number>;
  fruitTokens: Map<number, number>;
  cookingUntil: Map<number, number>;
  cookingQty: Map<number, number>;
  plots: { seedId: number; plantedAt: number; seedAmount: number; state: string }[];
  gasBreakdown: Record<string, number>;
  rotCount: number;
};

function createBot(strategy: BotStrategy, initialBalance: number): BotState {
  return {
    strategy,
    balance: initialBalance,
    totalInvested: initialBalance,
    gasSpent: 0,
    seedsSpent: 0,
    cleanupSpent: 0,
    landCost: 0,
    dishesSold: 0,
    dishesCooked: 0,
    revenue: 0,
    wins: 0,
    losses: 0,
    inventory: new Map(),
    fruitTokens: new Map(),
    cookingUntil: new Map(),
    cookingQty: new Map(),
    plots: [],
    gasBreakdown: Object.fromEntries(Object.keys(GAS).map(k => [k, 0])),
    rotCount: 0,
  };
}

function spendGas(bot: BotState, op: string, gasUnits: number): boolean {
  const cost = gasCostEth(gasUnits);
  if (bot.balance < cost) return false;
  bot.balance -= cost;
  bot.gasSpent += cost;
  bot.gasBreakdown[op] = (bot.gasBreakdown[op] || 0) + cost;
  return true;
}

// ─── Simulation ─────────────────────────────────────────────────────────────

const SIM_DURATION = 48 * 3600;
const EPOCH_DURATION = 10; // 10-second demand epochs (matches DishMarket)
const TICK = EPOCH_DURATION; // simulate every epoch
const INITIAL_TREASURY = 0.1;
const LAND_BID_PRICE = 0.001;
const INITIAL_BOT_BALANCE = 1.0;

function simulate(): void {
  console.log("=".repeat(90));
  console.log("  FARM GAME SIMULATION — 32 BOTS, 48 HOURS, NO WATERING");
  console.log("  Seed prices halved, price cap 20×/30×, 10s epochs, tiered dishAmount (2-3)");
  console.log("=".repeat(90));
  console.log(
    `Gas: ${GAS_PRICE_GWEI} gwei | Epoch: ${EPOCH_DURATION}s | Treasury seed: ${INITIAL_TREASURY} ETH | Start balance: ${INITIAL_BOT_BALANCE} ETH`,
  );
  console.log("");

  const strategies = generateStrategies();
  let treasury = INITIAL_TREASURY;
  const bots = strategies.map(s => createBot(s, INITIAL_BOT_BALANCE));

  // Phase 1: Land acquisition
  for (const bot of bots) {
    const landCost = LAND_BID_PRICE * bot.strategy.lands;
    const bidGas = gasCostEth(GAS.bid) * bot.strategy.lands;
    const settleGas = gasCostEth(GAS.settleAuction) * bot.strategy.lands;
    bot.balance -= landCost + bidGas + settleGas;
    bot.landCost = landCost;
    bot.gasSpent += bidGas + settleGas;
    bot.gasBreakdown.bid += bidGas;
    bot.gasBreakdown.settleAuction += settleGas;
    treasury += landCost;
    for (let i = 0; i < bot.strategy.lands; i++) {
      bot.plots.push({ seedId: -1, plantedAt: 0, seedAmount: 0, state: "empty" });
    }
  }

  const totalLands = bots.reduce((s, b) => s + b.strategy.lands, 0);
  console.log(`── Phase 1: ${bots.length} bots acquired ${totalLands} lands (${totalLands}/100) ──`);
  console.log(`   Treasury after land sales: ${treasury.toFixed(4)} ETH`);
  console.log("");

  // Phase 2: Main loop
  let totalMinutes = 0;
  let contestedMinutes = 0;
  let emptyMinutes = 0;
  const recipeWins: number[] = new Array(RECIPE_COUNT).fill(0);
  const recipeTotalPaid: number[] = new Array(RECIPE_COUNT).fill(0);
  const minuteOfferCounts: number[] = [];

  // Track which bots have offered per (epoch, recipeId) to enforce one-offer-per-recipe-per-epoch
  const offeredThisEpoch = new Map<string, Set<number>>(); // key: `${epoch}` → Set<botIdx> per recipe... use `${epoch}_${recipeId}`

  for (let t = 0; t < SIM_DURATION; t += TICK) {
    const epoch = Math.floor(t / EPOCH_DURATION);
    const minute = Math.floor(t / 60);
    const demandedRecipeId = minute % RECIPE_COUNT;
    const secondaryRecipeId = secondDemandForEpoch(epoch, demandedRecipeId, RECIPE_COUNT);
    totalMinutes++;

    // Shuffle bot order each tick to avoid first-mover bias
    const botOrder = bots.map((_, i) => i).sort(() => Math.random() - 0.5);

    // ─── Each bot: manage plots & cooking ───────────────────────────────
    for (const bi of botOrder) {
      const bot = bots[bi];
      const targets = bot.strategy.targetRecipes[0] === -1 ? RECIPES.map(r => r.id) : bot.strategy.targetRecipes;

      // Determine needed seeds
      const neededSeeds = new Map<number, number>(); // seedId → priority (lower = more urgent)
      for (const rid of targets) {
        for (const ing of RECIPES[rid].ingredients) {
          const fruitBal = bot.fruitTokens.get(ing.seedId) || 0;
          const needed = ing.amount * bot.strategy.batchSize;
          if (fruitBal < needed) {
            const current = neededSeeds.get(ing.seedId);
            if (current === undefined || rid < current) neededSeeds.set(ing.seedId, rid);
          }
        }
      }

      // Conservative bots only plant when running low
      const shouldPlant = Math.random() > bot.strategy.conservatism || neededSeeds.size > bot.plots.length;

      for (let p = 0; p < bot.plots.length; p++) {
        const plot = bot.plots[p];

        if (plot.state === "empty" && shouldPlant && neededSeeds.size > 0) {
          const seedId = [...neededSeeds.keys()][0];
          neededSeeds.delete(seedId);
          const seed = SEEDS[seedId];
          const amount = Math.min(seed.maxCap, Math.max(5, bot.strategy.batchSize * 2));

          const seedCost = seed.price * amount;
          const totalCost = seedCost + gasCostEth(GAS.buySeed) + gasCostEth(GAS.plant);
          if (bot.balance < totalCost) continue;

          bot.balance -= seedCost;
          bot.seedsSpent += seedCost;
          treasury += seedCost;
          if (!spendGas(bot, "buySeed", GAS.buySeed)) continue;
          if (!spendGas(bot, "plant", GAS.plant)) continue;

          plot.seedId = seedId;
          plot.plantedAt = t;
          plot.seedAmount = amount;
          plot.state = "growing";
        } else if (plot.state === "growing") {
          const seed = SEEDS[plot.seedId];
          const age = t - plot.plantedAt;

          if (age >= seed.matTime && age < seed.matTime + seed.rotTime) {
            if (!spendGas(bot, "harvest", GAS.harvest)) continue;
            const fruits = plot.seedAmount * seed.yield;
            bot.fruitTokens.set(plot.seedId, (bot.fruitTokens.get(plot.seedId) || 0) + fruits);
            plot.state = "needsCleanup";
          } else if (age >= seed.matTime + seed.rotTime) {
            plot.state = "rotten";
            bot.rotCount++;
          }
        } else if (plot.state === "needsCleanup" || plot.state === "rotten") {
          const seed = SEEDS[plot.seedId];
          const totalCost = seed.cleanupCost + gasCostEth(GAS.cleanup);
          if (bot.balance < totalCost) continue;

          bot.balance -= seed.cleanupCost;
          bot.cleanupSpent += seed.cleanupCost;
          treasury += seed.cleanupCost;
          if (!spendGas(bot, "cleanup", GAS.cleanup)) continue;

          plot.state = "empty";
          plot.seedId = -1;
          plot.plantedAt = 0;
          plot.seedAmount = 0;
        }
      }

      // ─── Cooking ──────────────────────────────────────────────────────
      for (const rid of targets) {
        const r = RECIPES[rid];

        // Claim finished dishes (qty batches × dishAmount per batch)
        const readyAt = bot.cookingUntil.get(rid);
        if (readyAt !== undefined && t >= readyAt) {
          if (spendGas(bot, "claim", GAS.claim)) {
            const qty = bot.cookingQty.get(rid) || 1;
            const dishes = qty * r.dishAmount;
            bot.inventory.set(rid, (bot.inventory.get(rid) || 0) + dishes);
            bot.dishesCooked += dishes;
            bot.cookingUntil.delete(rid);
            bot.cookingQty.delete(rid);
          }
        }

        if (bot.cookingUntil.has(rid)) continue;

        let canCook = true;
        let maxBatch = bot.strategy.batchSize;

        for (const ing of r.ingredients) {
          const fruitBal = bot.fruitTokens.get(ing.seedId) || 0;
          const possible = Math.floor(fruitBal / ing.amount);
          if (possible === 0) {
            canCook = false;
            break;
          }
          maxBatch = Math.min(maxBatch, possible);
        }

        if (canCook && maxBatch > 0) {
          const extraGas = (r.ingredients.length - 1) * 20_000;
          if (!spendGas(bot, "startCooking", GAS.startCooking + extraGas)) continue;

          for (const ing of r.ingredients) {
            const cur = bot.fruitTokens.get(ing.seedId) || 0;
            bot.fruitTokens.set(ing.seedId, cur - ing.amount * maxBatch);
          }
          bot.cookingUntil.set(rid, t + r.prepTime);
          bot.cookingQty.set(rid, maxBatch);
        }
      }
    }

    // ─── Market — run for both demanded recipes per epoch ───────────────
    type MarketOffer = { botIdx: number; askPrice: number; amount: number };
    const MAX_WINNERS = 5;

    let epochTotalOffers = 0;
    let epochHasWinner = false;

    for (const demId of [demandedRecipeId, secondaryRecipeId]) {
      const r = RECIPES[demId];
      const seedCost = recipeSeedCost(r);
      const cap = recipePriceCap(r);
      const offerKey = (bi: number) => `${epoch}_${demId}_${bi}`;

      const demOffers: MarketOffer[] = [];

      for (const bi of botOrder) {
        // One offer per bot per recipe per epoch
        if (offeredThisEpoch.get(offerKey(bi))) continue;

        const bot = bots[bi];
        const dishCount = bot.inventory.get(demId) || 0;
        if (dishCount <= 0) continue;

        const targets = bot.strategy.targetRecipes[0] === -1 ? RECIPES.map(rec => rec.id) : bot.strategy.targetRecipes;
        if (!targets.includes(demId)) continue;

        let askPrice = seedCost * (bot.strategy.askPricePct / 100);
        if (askPrice > cap) askPrice = cap;

        if (demOffers.length > 0 && Math.random() < bot.strategy.aggressiveness) {
          const lowestSoFar = Math.min(...demOffers.map(o => o.askPrice));
          askPrice = Math.max(lowestSoFar * 0.92, seedCost * 0.8);
        }

        const amount = Math.min(dishCount, bot.strategy.dishesPerOffer);
        const totalPayment = askPrice * amount;
        if (totalPayment > treasury) continue;

        if (!spendGas(bot, "submitOffer", GAS.submitOffer)) continue;
        demOffers.push({ botIdx: bi, askPrice, amount });
        offeredThisEpoch.set(offerKey(bi), new Set([bi]));
      }

      epochTotalOffers += demOffers.length;

      if (demOffers.length > 0) {
        if (demOffers.length > 1) contestedMinutes++;

        demOffers.sort((a, b) => a.askPrice - b.askPrice);
        const cutoffPrice = demOffers.length > MAX_WINNERS ? demOffers[MAX_WINNERS - 1].askPrice : Infinity;
        let demWins = 0;

        for (let i = 0; i < demOffers.length; i++) {
          const offer = demOffers[i];
          const offerBot = bots[offer.botIdx];
          const isWinner = i < MAX_WINNERS || offer.askPrice <= cutoffPrice;

          if (isWinner) {
            const payment = offer.askPrice * offer.amount;
            if (treasury >= payment && spendGas(offerBot, "settle", GAS.settle)) {
              treasury -= payment;
              offerBot.balance += payment;
              offerBot.revenue += payment;
              offerBot.dishesSold += offer.amount;
              offerBot.wins++;
              demWins++;
              epochHasWinner = true;
              recipeTotalPaid[demId] += payment;
              const curInv = offerBot.inventory.get(demId) || 0;
              offerBot.inventory.set(demId, curInv - offer.amount);
            } else {
              spendGas(offerBot, "withdrawOffer", GAS.withdrawOffer);
              offerBot.losses++;
            }
          } else {
            spendGas(offerBot, "withdrawOffer", GAS.withdrawOffer);
            offerBot.losses++;
          }
        }

        if (demWins > 0) recipeWins[demId]++;
      }
    }

    minuteOfferCounts.push(epochTotalOffers);
    if (epochTotalOffers === 0) emptyMinutes++;
    void epochHasWinner; // used for future extension
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORTS
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("=".repeat(90));
  console.log("  RESULTS AFTER 48 HOURS — 32 BOTS");
  console.log("=".repeat(90));
  console.log("");

  // ── Market overview ──
  const filledMinutes = totalMinutes - emptyMinutes;
  const avgOffers = minuteOfferCounts.reduce((s, n) => s + n, 0) / totalMinutes;
  console.log("── Market Overview ──");
  console.log(`  Total minutes:       ${totalMinutes}`);
  console.log(`  With offers:         ${filledMinutes} (${pct(filledMinutes, totalMinutes)})`);
  console.log(`  Contested (2+):      ${contestedMinutes} (${pct(contestedMinutes, totalMinutes)})`);
  console.log(`  Empty:               ${emptyMinutes} (${pct(emptyMinutes, totalMinutes)})`);
  console.log(`  Avg offers/minute:   ${avgOffers.toFixed(1)}`);
  console.log(`  Final treasury:      ${treasury.toFixed(4)} ETH`);
  console.log("");

  // ── Archetype summary ──
  console.log("── Performance by Archetype ──");
  console.log("");
  const archetypes = [...new Set(strategies.map(s => s.archetype))];

  const archHeader = [
    "Archetype".padEnd(16),
    "Bots".padStart(5),
    "Avg P&L".padStart(10),
    "Avg ROI".padStart(9),
    "Profitable".padStart(11),
    "Avg Revenue".padStart(12),
    "Avg Gas".padStart(10),
    "Avg Seeds$".padStart(11),
    "Avg Cooked".padStart(11),
    "Avg Sold".padStart(9),
    "Avg W/L".padStart(9),
  ].join(" ");
  console.log(archHeader);
  console.log("-".repeat(archHeader.length));

  for (const arch of archetypes) {
    const group = bots.filter(b => b.strategy.archetype === arch);
    const n = group.length;
    const avgPnl = group.reduce((s, b) => s + (b.balance - b.totalInvested), 0) / n;
    const avgRoi = group.reduce((s, b) => s + ((b.balance - b.totalInvested) / b.totalInvested) * 100, 0) / n;
    const profitable = group.filter(b => b.balance >= b.totalInvested).length;
    const avgRev = group.reduce((s, b) => s + b.revenue, 0) / n;
    const avgGas = group.reduce((s, b) => s + b.gasSpent, 0) / n;
    const avgSeedCost = group.reduce((s, b) => s + b.seedsSpent, 0) / n;
    const avgCooked = group.reduce((s, b) => s + b.dishesCooked, 0) / n;
    const avgSold = group.reduce((s, b) => s + b.dishesSold, 0) / n;
    const avgWins = group.reduce((s, b) => s + b.wins, 0) / n;
    const avgLosses = group.reduce((s, b) => s + b.losses, 0) / n;

    console.log(
      [
        arch.padEnd(16),
        n.toString().padStart(5),
        ((avgPnl >= 0 ? "+" : "") + avgPnl.toFixed(4)).padStart(10),
        (avgRoi.toFixed(1) + "%").padStart(9),
        `${profitable}/${n}`.padStart(11),
        avgRev.toFixed(4).padStart(12),
        avgGas.toFixed(4).padStart(10),
        avgSeedCost.toFixed(4).padStart(11),
        avgCooked.toFixed(0).padStart(11),
        avgSold.toFixed(0).padStart(9),
        `${avgWins.toFixed(0)}/${avgLosses.toFixed(0)}`.padStart(9),
      ].join(" "),
    );
  }

  console.log("");

  // ── Top 10 / Bottom 10 bots ──
  const sorted = [...bots].sort((a, b) => b.balance - b.totalInvested - (a.balance - a.totalInvested));

  console.log("── Top 10 Bots ──");
  console.log("");
  printBotTable(sorted.slice(0, 10));
  console.log("");

  console.log("── Bottom 10 Bots ──");
  console.log("");
  printBotTable(sorted.slice(-10));
  console.log("");

  // ── Recipe demand ──
  console.log("── Recipe Market Activity ──");
  console.log("");
  const recipeHeader = [
    "Recipe".padEnd(22),
    "Demand/48h".padStart(10),
    "Wins".padStart(6),
    "Fill Rate".padStart(10),
    "Avg Payout".padStart(12),
    "Seed Cost".padStart(10),
    "Price Cap".padStart(10),
  ].join(" ");
  console.log(recipeHeader);
  console.log("-".repeat(recipeHeader.length));

  for (const r of RECIPES) {
    const demandCount = Math.floor(totalMinutes / RECIPE_COUNT);
    const wins = recipeWins[r.id];
    const avgPay = wins > 0 ? recipeTotalPaid[r.id] / wins : 0;
    console.log(
      [
        r.name.padEnd(22),
        demandCount.toString().padStart(10),
        wins.toString().padStart(6),
        pct(wins, demandCount).padStart(10),
        avgPay.toFixed(6).padStart(12),
        recipeSeedCost(r).toFixed(6).padStart(10),
        recipePriceCap(r).toFixed(6).padStart(10),
      ].join(" "),
    );
  }
  console.log("");

  // ── Treasury flow ──
  const totalLandRev = bots.reduce((s, b) => s + b.landCost, 0);
  const totalSeedRev = bots.reduce((s, b) => s + b.seedsSpent, 0);
  const totalCleanupRev = bots.reduce((s, b) => s + b.cleanupSpent, 0);
  const totalPaidOut = bots.reduce((s, b) => s + b.revenue, 0);
  const totalIn = INITIAL_TREASURY + totalLandRev + totalSeedRev + totalCleanupRev;

  console.log("── Treasury Flow ──");
  console.log(`  Initial seed:        ${INITIAL_TREASURY.toFixed(4)} ETH`);
  console.log(`  + Land auctions:     ${totalLandRev.toFixed(4)} ETH`);
  console.log(`  + Seed purchases:    ${totalSeedRev.toFixed(4)} ETH`);
  console.log(`  + Cleanup fees:      ${totalCleanupRev.toFixed(4)} ETH`);
  console.log(`  = Total inflow:      ${totalIn.toFixed(4)} ETH`);
  console.log(`  - Paid to sellers:   ${totalPaidOut.toFixed(4)} ETH`);
  console.log(`  = Final treasury:    ${treasury.toFixed(4)} ETH`);
  console.log(
    `  Recycling rate:      ${totalPaidOut > 0 ? (((totalSeedRev + totalCleanupRev) / totalPaidOut) * 100).toFixed(1) : "N/A"}%`,
  );
  console.log("");

  // ── Gas breakdown by archetype ──
  console.log("── Gas % of Total Spending by Archetype ──");
  console.log("");
  for (const arch of archetypes) {
    const group = bots.filter(b => b.strategy.archetype === arch);
    const n = group.length;
    const avgGas = group.reduce((s, b) => s + b.gasSpent, 0) / n;
    const avgSeeds = group.reduce((s, b) => s + b.seedsSpent, 0) / n;
    const avgCleanup = group.reduce((s, b) => s + b.cleanupSpent, 0) / n;
    const avgLand = group.reduce((s, b) => s + b.landCost, 0) / n;
    const total = avgGas + avgSeeds + avgCleanup + avgLand;
    console.log(
      `  ${arch.padEnd(16)} Gas: ${pctN(avgGas, total)}  Seeds: ${pctN(avgSeeds, total)}  Cleanup: ${pctN(avgCleanup, total)}  Land: ${pctN(avgLand, total)}`,
    );
  }
  console.log("");

  // ── Summary stats ──
  const profitableBots = bots.filter(b => b.balance >= b.totalInvested);
  const bankruptBots = bots.filter(b => b.balance < 0.001);
  const totalRotted = bots.reduce((s, b) => s + b.rotCount, 0);
  const totalCooked = bots.reduce((s, b) => s + b.dishesCooked, 0);
  const totalSold = bots.reduce((s, b) => s + b.dishesSold, 0);

  console.log("── Summary ──");
  console.log(`  Profitable bots:     ${profitableBots.length}/30 (${pct(profitableBots.length, 30)})`);
  console.log(`  Bankrupt bots:       ${bankruptBots.length}/30`);
  console.log(`  Total dishes cooked: ${totalCooked.toLocaleString()}`);
  console.log(`  Total dishes sold:   ${totalSold.toLocaleString()}`);
  console.log(`  Sell-through rate:   ${pct(totalSold, totalCooked)}`);
  console.log(`  Total crops rotted:  ${totalRotted.toLocaleString()}`);
  console.log(
    `  Best bot:            ${sorted[0].strategy.name} (${sorted[0].strategy.archetype}) +${(sorted[0].balance - sorted[0].totalInvested).toFixed(4)} ETH`,
  );
  console.log(
    `  Worst bot:           ${sorted[sorted.length - 1].strategy.name} (${sorted[sorted.length - 1].strategy.archetype}) ${(sorted[sorted.length - 1].balance - sorted[sorted.length - 1].totalInvested).toFixed(4)} ETH`,
  );
  console.log("");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  return total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "0.0%";
}

function pctN(n: number, total: number): string {
  return total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "0.0%";
}

function printBotTable(botList: BotState[]) {
  const header = [
    "Bot".padEnd(18),
    "Archetype".padEnd(14),
    "P&L".padStart(10),
    "ROI".padStart(8),
    "Revenue".padStart(9),
    "Gas".padStart(8),
    "Seeds$".padStart(9),
    "Cooked".padStart(7),
    "Sold".padStart(6),
    "W/L".padStart(8),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const bot of botList) {
    const pnl = bot.balance - bot.totalInvested;
    console.log(
      [
        bot.strategy.name.padEnd(18),
        bot.strategy.archetype.padEnd(14),
        ((pnl >= 0 ? "+" : "") + pnl.toFixed(4)).padStart(10),
        (((pnl / bot.totalInvested) * 100).toFixed(1) + "%").padStart(8),
        bot.revenue.toFixed(4).padStart(9),
        bot.gasSpent.toFixed(4).padStart(8),
        bot.seedsSpent.toFixed(4).padStart(9),
        bot.dishesCooked.toString().padStart(7),
        bot.dishesSold.toString().padStart(6),
        `${bot.wins}/${bot.losses}`.padStart(8),
      ].join(" "),
    );
  }
}

simulate();
