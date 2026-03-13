import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const MIN = 60;

/**
 * Expanded integration test — full game loop with 3 users, 29 market rounds
 *
 * Contracts: LandAuction · SeedShop · FarmManager · Chef · DishMarket
 *
 * Seeds:    0=Tomato (yield 3) · 1=Lemon (yield 4) · 2=Carrot (yield 2)
 * Recipes:  0=Tomato Soup (3T+1L, 2 min) · 1=Carrot Cake (3C+2L, 3 min)
 * Market demand = minute % 2 → 0=Tomato Soup (even) · 1=Carrot Cake (odd)
 *
 * Per user:
 *   • 4 lands via auction  (bids ÷100 vs original)
 *   • 3 farming cycles: 2 tomato lands + 1 lemon land + 1 carrot land
 *       Yield/cycle: 18T (2×3×3) + 12L (3×4) + 6C (3×2)
 *       After 3 cycles: 54T + 36L + 18C
 *   • Cooking: 6×(Tsoup‖Ccake) + 1×Tsoup = 7 Tsoup + 6 Ccake
 *       Ingredients consumed: 21T + 19L + 18C  →  33T + 17L + 0C remaining
 *   • 29 market rounds — U1 wins 10 · U2 wins 10 · U3 wins 9
 *       U1 earns 0.0027 ETH · U2 earns 0.0026 ETH · U3 earns 0.0022 ETH
 */
describe("Integration – expanded game loop", function () {
  it("3 users farm 3 cycles, cook 2 recipes, compete across 29 market rounds", async function () {
    this.timeout(120_000);

    const { parseEther } = ethers;
    const [owner, user1, user2, user3] = await ethers.getSigners();

    // ════════════════════════════════════════════════════════
    //  DEPLOY
    // ════════════════════════════════════════════════════════

    const landAuction = await (await ethers.getContractFactory("LandAuction")).deploy(owner.address);
    const seedShop = await (await ethers.getContractFactory("SeedShop")).deploy(owner.address);
    const farm = await (
      await ethers.getContractFactory("FarmManager")
    ).deploy(owner.address, await landAuction.getAddress(), await seedShop.getAddress());
    const chef = await (await ethers.getContractFactory("Chef")).deploy(owner.address);
    const market = await (
      await ethers.getContractFactory("DishMarket")
    ).deploy(owner.address, await chef.getAddress(), await farm.getAddress());

    const farmAddr = await farm.getAddress();
    const chefAddr = await chef.getAddress();
    const marketAddr = await market.getAddress();
    await owner.sendTransaction({ to: marketAddr, value: parseEther("15") });

    // ── Seed catalog ─────────────────────────────────────────────────────────
    const SEED_PRICE = parseEther("0.0001");
    await seedShop.connect(owner).addSeed("Tomato Seed", "TOMATO", SEED_PRICE); // 0
    await seedShop.connect(owner).addSeed("Lemon Seed", "LEMON", SEED_PRICE); // 1
    await seedShop.connect(owner).addSeed("Carrot Seed", "CARROT", SEED_PRICE); // 2

    // ── Farm configs (waterInterval=10 min > maturationTime → no watering needed)
    const CLEANUP_COST = parseEther("0.00001");
    await farm.connect(owner).addFarmConfig(0, 10, 10 * MIN, 3 * MIN, 5 * MIN, CLEANUP_COST, 3, "Tomato", "TOM");
    await farm.connect(owner).addFarmConfig(1, 10, 10 * MIN, 3 * MIN, 5 * MIN, CLEANUP_COST, 4, "Lemon", "LEM");
    await farm.connect(owner).addFarmConfig(2, 10, 10 * MIN, 4 * MIN, 5 * MIN, CLEANUP_COST, 2, "Carrot", "CAR");

    const tomatoFruitAddr = await farm.fruitToken(0);
    const lemonFruitAddr = await farm.fruitToken(1);
    const carrotFruitAddr = await farm.fruitToken(2);
    const tomatoFruit = await ethers.getContractAt("FruitToken", tomatoFruitAddr);
    const lemonFruit = await ethers.getContractAt("FruitToken", lemonFruitAddr);
    const carrotFruit = await ethers.getContractAt("FruitToken", carrotFruitAddr);
    const tomatoSeed = await ethers.getContractAt("SeedToken", await seedShop.seedToken(0));
    const lemonSeed = await ethers.getContractAt("SeedToken", await seedShop.seedToken(1));
    const carrotSeed = await ethers.getContractAt("SeedToken", await seedShop.seedToken(2));

    // ── Recipes ───────────────────────────────────────────────────────────────
    // Recipe 0: Tomato Soup = 3T + 1L, prepTime 2 min
    // Recipe 1: Carrot Cake = 3C + 2L, prepTime 3 min
    await chef
      .connect(owner)
      .addRecipe("Tomato Soup", [tomatoFruitAddr, lemonFruitAddr], [3, 1], 2 * MIN, 1, "Tomato Soup", "TSOUP");
    await chef
      .connect(owner)
      .addRecipe("Carrot Cake", [carrotFruitAddr, lemonFruitAddr], [3, 2], 3 * MIN, 1, "Carrot Cake", "CCAKE");
    const [, , , tsoupAddr] = await chef.getRecipe(0);
    const [, , , ccakeAddr] = await chef.getRecipe(1);
    const tsoupToken = await ethers.getContractAt("DishToken", tsoupAddr);
    const ccakeToken = await ethers.getContractAt("DishToken", ccakeAddr);

    // ════════════════════════════════════════════════════════
    //  PHASE 1 — LAND AUCTION (12 lands, 4 per user)
    //  User1: 0,3,6,9 | User2: 1,4,7,10 | User3: 2,5,8,11
    // ════════════════════════════════════════════════════════

    const auctionBids: [typeof user1, bigint][] = [
      [user1, parseEther("0.005")],
      [user2, parseEther("0.006")],
      [user3, parseEther("0.007")],
      [user1, parseEther("0.0051")],
      [user2, parseEther("0.0061")],
      [user3, parseEther("0.0071")],
      [user1, parseEther("0.0052")],
      [user2, parseEther("0.0062")],
      [user3, parseEther("0.0072")],
      [user1, parseEther("0.0053")],
      [user2, parseEther("0.0063")],
      [user3, parseEther("0.0073")],
    ];

    for (const [user, amount] of auctionBids) {
      await landAuction.connect(user).bid({ value: amount });
      await time.increase(3601);
      await landAuction.settleAuction();
    }

    expect(await landAuction.landOwner(0)).to.equal(user1.address);
    expect(await landAuction.landOwner(9)).to.equal(user1.address);
    expect(await landAuction.landOwner(4)).to.equal(user2.address);
    expect(await landAuction.landOwner(11)).to.equal(user3.address);

    const LAND_COST: Record<string, bigint> = {
      [user1.address]: parseEther("0.0206"), // 0.005+0.0051+0.0052+0.0053
      [user2.address]: parseEther("0.0246"), // 0.006+0.0061+0.0062+0.0063
      [user3.address]: parseEther("0.0286"), // 0.007+0.0071+0.0072+0.0073
    };

    // ════════════════════════════════════════════════════════
    //  PHASES 2–4 — FARMING (3 cycles)
    //
    //  Land layout per user: [tomato, tomato, lemon, carrot]
    //    User1: lands [0, 3, 6, 9]
    //    User2: lands [1, 4, 7, 10]
    //    User3: lands [2, 5, 8, 11]
    //
    //  Seeds/cycle: 6 Tomato + 3 Lemon + 3 Carrot = 12 seeds × 0.0001 = 0.0012 ETH
    //  Harvest/cycle per user: 18T (2×3×3) + 12L (3×4) + 6C (3×2)
    //  After 3 cycles per user: 54T + 36L + 18C
    // ════════════════════════════════════════════════════════

    const userPlots = [
      { user: user1, lands: [0, 3, 6, 9] },
      { user: user2, lands: [1, 4, 7, 10] },
      { user: user3, lands: [2, 5, 8, 11] },
    ];

    // slot → [seedToken, seedId, count]
    const plantScheme: [typeof tomatoSeed, number, number][] = [
      [tomatoSeed, 0, 3], // land slot 0: tomato
      [tomatoSeed, 0, 3], // land slot 1: tomato
      [lemonSeed, 1, 3], // land slot 2: lemon
      [carrotSeed, 2, 3], // land slot 3: carrot
    ];

    const SEED_COST_PER_CYCLE = SEED_PRICE * 12n;

    for (let cycle = 0; cycle < 3; cycle++) {
      // Buy seeds
      for (const { user } of userPlots) {
        await seedShop.connect(user).buy(0, 6, { value: SEED_PRICE * 6n });
        await seedShop.connect(user).buy(1, 3, { value: SEED_PRICE * 3n });
        await seedShop.connect(user).buy(2, 3, { value: SEED_PRICE * 3n });
      }

      // Plant
      for (const { user, lands } of userPlots) {
        for (let slot = 0; slot < 4; slot++) {
          const [token, seedId, count] = plantScheme[slot];
          await token.connect(user).approve(farmAddr, count);
          await farm.connect(user).plant(lands[slot], seedId, count);
        }
      }

      // Wait for slowest crop (carrot = 4 min), then harvest + cleanup
      await time.increase(4 * MIN + 1);

      for (const { user, lands } of userPlots) {
        for (const land of lands) await farm.connect(user).harvest(land);
      }
      for (const { user, lands } of userPlots) {
        for (const land of lands) await farm.connect(user).cleanUp(land, { value: CLEANUP_COST });
      }

      const c = BigInt(cycle + 1);
      for (const { user } of userPlots) {
        expect(await tomatoFruit.balanceOf(user.address)).to.equal(18n * c);
        expect(await lemonFruit.balanceOf(user.address)).to.equal(12n * c);
        expect(await carrotFruit.balanceOf(user.address)).to.equal(6n * c);
      }
    }

    const SEED_COST_PER_USER = SEED_COST_PER_CYCLE * 3n;
    const CLEANUP_PER_USER = CLEANUP_COST * 4n * 3n;

    // ════════════════════════════════════════════════════════
    //  PHASE 5 — COOKING (6 parallel rounds + 1 extra Tsoup)
    //
    //  Runs recipe 0 + recipe 1 simultaneously (separate recipeIds → allowed)
    //  6 rounds × (1 Tsoup + 1 Ccake) + 1 extra Tsoup = 7 Tsoup + 6 Ccake
    //
    //  Ingredient usage per user:
    //    Tsoup ×7: 21T + 7L   |   Ccake ×6: 18C + 12L   |   total lemon: 19L
    //  Remaining fruits: 33T + 17L + 0C
    // ════════════════════════════════════════════════════════

    for (const { user } of userPlots) {
      await tomatoFruit.connect(user).approve(chefAddr, 21); // 3T × 7 soups
      await lemonFruit.connect(user).approve(chefAddr, 19); // 7L (soups) + 12L (cakes)
      await carrotFruit.connect(user).approve(chefAddr, 18); // 3C × 6 cakes
    }

    // 6 parallel cook rounds (recipe 0 and recipe 1 simultaneously)
    for (let i = 0; i < 6; i++) {
      for (const { user } of userPlots) {
        await chef.connect(user).startCooking(0);
        await chef.connect(user).startCooking(1);
      }
      await time.increase(3 * MIN + 1); // Ccake needs 3 min (longer recipe)
      for (const { user } of userPlots) {
        await chef.connect(user).claim(0);
        await chef.connect(user).claim(1);
      }
    }

    // 1 extra Tsoup round
    for (const { user } of userPlots) await chef.connect(user).startCooking(0);
    await time.increase(2 * MIN + 1);
    for (const { user } of userPlots) await chef.connect(user).claim(0);

    for (const { user } of userPlots) {
      expect(await tsoupToken.balanceOf(user.address)).to.equal(7);
      expect(await ccakeToken.balanceOf(user.address)).to.equal(6);
    }

    // ════════════════════════════════════════════════════════
    //  PHASE 6 — DISH MARKET (29 rounds, alternating recipes)
    //
    //  Demand = minute % 2 → even=Tsoup (0), odd=Ccake (1)
    //  We use time.increaseTo for exact minute control — no timing ambiguity.
    //
    //  rawRounds[i] = [u1_ask, u2_ask, u3_ask, winner_index]
    //  Even i → Tsoup demand · Odd i → Ccake demand
    //
    //  Dish requirements:
    //    Tsoup — U1 wins 5 rounds, U2 wins 5, U3 wins 5 → need 6, 6, 5 dishes
    //    Ccake — U1 wins 5 rounds, U2 wins 5, U3 wins 4 → need 6, 5, 5 dishes
    //    Both satisfied by 7 Tsoup + 6 Ccake cooked above.
    //
    //  Earnings:  User1 = 0.0027 ETH (10 wins)
    //             User2 = 0.0026 ETH (10 wins)
    //             User3 = 0.0022 ETH  (9 wins)
    //  Treasury after 29 rounds: 15 − 0.0075 = 14.9925 ETH
    // ════════════════════════════════════════════════════════

    // Prices are constrained by the seed-cost cap:
    //   Tsoup cap = 2 × (1 seed T + 1 seed L) × 0.0001 = 0.0004 ETH
    //   Ccake cap = 2 × (2 seeds C + 1 seed L) × 0.0001 = 0.0006 ETH
    //
    // Winner earnings (same winnerIdx pattern as before):
    //   U1: 0.0001+0.0004+0.0003+0.0002+0.0002+0.0005+0.0001+0.0003+0.0002+0.0004 = 0.0027 ETH
    //   U2: 0.0002+0.0003+0.0001+0.0004+0.0003+0.0002+0.0002+0.0005+0.0001+0.0003 = 0.0026 ETH
    //   U3: 0.0001+0.0005+0.0002+0.0003+0.0001+0.0004+0.0003+0.0002+0.0001       = 0.0022 ETH
    //   Treasury: 15 − 0.0075 = 14.9925 ETH
    // [u1_ask, u2_ask, u3_ask, winner_index]
    const rawRounds: [string, string, string, number][] = [
      ["0.0001", "0.0002", "0.0003", 0], // R0  Tsoup  U1 wins 0.0001
      ["0.0004", "0.0005", "0.0006", 0], // R1  Ccake  U1 wins 0.0004
      ["0.0003", "0.0002", "0.0004", 1], // R2  Tsoup  U2 wins 0.0002
      ["0.0005", "0.0003", "0.0006", 1], // R3  Ccake  U2 wins 0.0003
      ["0.0002", "0.0003", "0.0001", 2], // R4  Tsoup  U3 wins 0.0001
      ["0.0006", "0.0006", "0.0005", 2], // R5  Ccake  U3 wins 0.0005
      ["0.0003", "0.0004", "0.0004", 0], // R6  Tsoup  U1 wins 0.0003
      ["0.0002", "0.0004", "0.0006", 0], // R7  Ccake  U1 wins 0.0002
      ["0.0004", "0.0001", "0.0003", 1], // R8  Tsoup  U2 wins 0.0001
      ["0.0005", "0.0004", "0.0006", 1], // R9  Ccake  U2 wins 0.0004
      ["0.0004", "0.0003", "0.0002", 2], // R10 Tsoup  U3 wins 0.0002
      ["0.0006", "0.0005", "0.0003", 2], // R11 Ccake  U3 wins 0.0003
      ["0.0002", "0.0003", "0.0004", 0], // R12 Tsoup  U1 wins 0.0002
      ["0.0005", "0.0006", "0.0006", 0], // R13 Ccake  U1 wins 0.0005
      ["0.0004", "0.0003", "0.0004", 1], // R14 Tsoup  U2 wins 0.0003
      ["0.0004", "0.0002", "0.0005", 1], // R15 Ccake  U2 wins 0.0002
      ["0.0003", "0.0002", "0.0001", 2], // R16 Tsoup  U3 wins 0.0001
      ["0.0005", "0.0006", "0.0004", 2], // R17 Ccake  U3 wins 0.0004
      ["0.0001", "0.0002", "0.0004", 0], // R18 Tsoup  U1 wins 0.0001
      ["0.0003", "0.0004", "0.0005", 0], // R19 Ccake  U1 wins 0.0003
      ["0.0003", "0.0002", "0.0004", 1], // R20 Tsoup  U2 wins 0.0002
      ["0.0006", "0.0005", "0.0006", 1], // R21 Ccake  U2 wins 0.0005
      ["0.0004", "0.0004", "0.0003", 2], // R22 Tsoup  U3 wins 0.0003
      ["0.0004", "0.0005", "0.0002", 2], // R23 Ccake  U3 wins 0.0002
      ["0.0002", "0.0003", "0.0004", 0], // R24 Tsoup  U1 wins 0.0002
      ["0.0004", "0.0005", "0.0006", 0], // R25 Ccake  U1 wins 0.0004
      ["0.0002", "0.0001", "0.0003", 1], // R26 Tsoup  U2 wins 0.0001
      ["0.0004", "0.0003", "0.0005", 1], // R27 Ccake  U2 wins 0.0003
      ["0.0002", "0.0003", "0.0001", 2], // R28 Tsoup  U3 wins 0.0001
    ];

    const users = [user1, user2, user3];

    // Pick first even minute strictly after current time (ensures Tsoup demand for R0)
    const nowTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const startMin =
      (nowTs / 60n) % 2n === 0n
        ? nowTs / 60n + 2n // skip 1 full even minute ahead (need room for increaseTo)
        : nowTs / 60n + 1n; // next minute is already even

    const MARKET_EARNED: Record<string, bigint> = {
      [user1.address]: 0n,
      [user2.address]: 0n,
      [user3.address]: 0n,
    };
    const roundLog: string[] = [];

    for (let i = 0; i < rawRounds.length; i++) {
      const [p0, p1, p2, winnerIdx] = rawRounds[i];
      const prices = [parseEther(p0), parseEther(p1), parseEther(p2)];
      const recipeId = i % 2; // 0=Tsoup (even rounds), 1=Ccake (odd rounds)
      const token = recipeId === 0 ? tsoupToken : ccakeToken;
      const label = recipeId === 0 ? "Tomato Soup" : "Carrot Cake";
      const roundMin = startMin + BigInt(i);

      // Jump to 10 seconds into this minute — guarantees stable minute for all offer txs
      await time.increaseTo(Number(roundMin * 60n + 10n));

      const minute = await market.currentMinute();
      expect(minute).to.equal(roundMin);
      expect(await market.currentDemand()).to.equal(BigInt(recipeId));

      for (let j = 0; j < 3; j++) {
        await token.connect(users[j]).approve(marketAddr, 1);
        await market.connect(users[j]).submitOffer(prices[j]);
      }

      // Jump to 5 seconds into the NEXT minute (safely past the offer window)
      await time.increaseTo(Number((roundMin + 1n) * 60n + 5n));

      const winner = users[winnerIdx];
      const winnerName = winnerIdx === 0 ? "User1" : winnerIdx === 1 ? "User2" : "User3";
      await market.connect(winner).settle(minute);
      MARKET_EARNED[winner.address] += prices[winnerIdx];
      roundLog.push(
        `   R${String(i).padStart(2)}  ${label.padEnd(12)}  ${winnerName} wins  ${ethers.formatEther(prices[winnerIdx])} ETH`,
      );

      // Losers withdraw their dish back (dish is reusable)
      for (let j = 0; j < 3; j++) {
        if (j !== winnerIdx) {
          await market.connect(users[j]).withdrawOffer(minute, j);
        }
      }
    }

    // ── Assertions ────────────────────────────────────────────────────────────
    expect(MARKET_EARNED[user1.address]).to.equal(parseEther("0.0027")); // 10 wins
    expect(MARKET_EARNED[user2.address]).to.equal(parseEther("0.0026")); // 10 wins
    expect(MARKET_EARNED[user3.address]).to.equal(parseEther("0.0022")); //  9 wins

    expect(await market.availableFunds()).to.equal(parseEther("14.9925")); // 15 − 0.0075

    // Tsoup: each user won 5 Tsoup rounds from 7 cooked → 2 remaining each
    // Ccake: U1/U2 won 5 from 6 cooked → 1 remaining; U3 won 4 from 6 cooked → 2 remaining
    expect(await tsoupToken.balanceOf(user1.address)).to.equal(2);
    expect(await tsoupToken.balanceOf(user2.address)).to.equal(2);
    expect(await tsoupToken.balanceOf(user3.address)).to.equal(2);
    expect(await ccakeToken.balanceOf(user1.address)).to.equal(1);
    expect(await ccakeToken.balanceOf(user2.address)).to.equal(1);
    expect(await ccakeToken.balanceOf(user3.address)).to.equal(2);

    // ════════════════════════════════════════════════════════
    //  ECONOMIC REPORT
    // ════════════════════════════════════════════════════════

    const f = (wei: bigint, w = 9) => ethers.formatEther(wei).padStart(w);
    const fpl = (wei: bigint) => (wei < 0n ? "  -" : "  +") + ethers.formatEther(wei < 0n ? -wei : wei).padStart(8);

    const reportRows = [
      { name: "User 1", user: user1 },
      { name: "User 2", user: user2 },
      { name: "User 3", user: user3 },
    ].map(({ name, user }) => {
      const land = LAND_COST[user.address];
      const seeds = SEED_COST_PER_USER;
      const cleanup = CLEANUP_PER_USER;
      const earned = MARKET_EARNED[user.address];
      const spent = land + seeds + cleanup;
      return { name, land, seeds, cleanup, earned, spent, net: earned - spent };
    });

    const tot = reportRows.reduce(
      (a, r) => ({
        land: a.land + r.land,
        seeds: a.seeds + r.seeds,
        cleanup: a.cleanup + r.cleanup,
        earned: a.earned + r.earned,
        spent: a.spent + r.spent,
        net: a.net + r.net,
      }),
      { land: 0n, seeds: 0n, cleanup: 0n, earned: 0n, spent: 0n, net: 0n },
    );

    const L = "─".repeat(88);
    const D = "═".repeat(88);
    console.log(`\n${D}`);
    console.log(" EXPANDED INTEGRATION GAME REPORT");
    console.log(D);
    console.log(" Configuration:");
    console.log("   Seeds      Tomato 0.0001 ETH  ·  Lemon 0.0001 ETH  ·  Carrot 0.0001 ETH");
    console.log("   Recipes    Tomato Soup (3T+1L, 2 min)  ·  Carrot Cake (3C+2L, 3 min)");
    console.log("   Lands      4 per user  ·  2 tomato + 1 lemon + 1 carrot per user");
    console.log("   Cycles     3 farming cycles  →  54T + 36L + 18C per user");
    console.log("   Cooking    6×(Tsoup‖Ccake) + 1×Tsoup  =  7 Tsoup + 6 Ccake per user");
    console.log("   Market     15 ETH treasury  ·  29 rounds  ·  demand alternates by minute  ·  cap enforced");
    console.log(L);
    console.log(" Market rounds:");
    roundLog.forEach(l => console.log(l));
    console.log(L);
    const H =
      ` ${"User".padEnd(7)}` +
      `${"Land Cost".padStart(12)} ETH` +
      `  ${"Seeds".padStart(7)} ETH` +
      `  ${"Cleanup".padStart(7)} ETH` +
      `  ${"Total Spent".padStart(11)} ETH` +
      `  ${"Earned".padStart(8)} ETH` +
      `   ${"Net P&L".padStart(11)} ETH`;
    console.log(H);
    console.log(L);
    for (const { name, land, seeds, cleanup, spent, earned, net } of reportRows) {
      console.log(
        ` ${name.padEnd(7)}` +
          `${f(land, 12)}    ` +
          `${f(seeds, 7)}    ` +
          `${f(cleanup, 7)}    ` +
          `${f(spent, 11)}    ` +
          `${f(earned, 8)}  ` +
          `${fpl(net)}`,
      );
    }
    console.log(L);
    console.log(
      ` ${"TOTAL".padEnd(7)}` +
        `${f(tot.land, 12)}    ` +
        `${f(tot.seeds, 7)}    ` +
        `${f(tot.cleanup, 7)}    ` +
        `${f(tot.spent, 11)}    ` +
        `${f(tot.earned, 8)}  ` +
        `${fpl(tot.net)}`,
    );
    console.log(D);
    const tLeft = Number(await tomatoFruit.balanceOf(user1.address));
    const lLeft = Number(await lemonFruit.balanceOf(user1.address));
    console.log("\n Leftover inventory (tokens, not ETH — decimals=0):");
    console.log(`   Tomato fruit  — ${tLeft} tokens/user  (54 harvested, 21 consumed cooking)`);
    console.log(`   Lemon fruit   — ${lLeft} tokens/user  (36 harvested, 19 consumed cooking)`);
    console.log(
      `   Tsoup dishes  — User1=${await tsoupToken.balanceOf(user1.address)}  User2=${await tsoupToken.balanceOf(user2.address)}  User3=${await tsoupToken.balanceOf(user3.address)}  (7 cooked, 5 burned)`,
    );
    console.log(
      `   Ccake dishes  — User1=${await ccakeToken.balanceOf(user1.address)}  User2=${await ccakeToken.balanceOf(user2.address)}  User3=${await ccakeToken.balanceOf(user3.address)}  (6 cooked, 4-5 burned)`,
    );
    const balMarket = await ethers.provider.getBalance(await market.getAddress());
    const balSeedShop = await ethers.provider.getBalance(await seedShop.getAddress());
    const balFarm = await ethers.provider.getBalance(await farm.getAddress());
    const balAuction = await ethers.provider.getBalance(await landAuction.getAddress());
    const balChef = await ethers.provider.getBalance(await chef.getAddress());

    console.log("\n Contract balances (ETH):");
    console.log(
      `   DishMarket   ${ethers.formatEther(balMarket).padStart(10)} ETH  (availableFunds: ${ethers.formatEther(await market.availableFunds())} ETH)`,
    );
    console.log(`   SeedShop     ${ethers.formatEther(balSeedShop).padStart(10)} ETH`);
    console.log(`   FarmManager  ${ethers.formatEther(balFarm).padStart(10)} ETH`);
    console.log(`   LandAuction  ${ethers.formatEther(balAuction).padStart(10)} ETH`);
    console.log(`   Chef         ${ethers.formatEther(balChef).padStart(10)} ETH`);
    console.log(`${D}\n`);
  });
});
