import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const MIN = 60;

describe("DishMarket", function () {
  async function deployFixture() {
    const [owner, seller1, seller2, seller3] = await ethers.getSigners();

    // Deploy supporting contracts for FarmManager
    const la = await (await ethers.getContractFactory("LandAuction")).deploy(owner.address);
    const shop = await (await ethers.getContractFactory("SeedShop")).deploy(owner.address);
    const farm = await (
      await ethers.getContractFactory("FarmManager")
    ).deploy(owner.address, await la.getAddress(), await shop.getAddress());
    const farmAddr = await farm.getAddress();

    // seedPrice chosen so cap (2 × 1 seed × seedPrice) > 0.5 ETH (highest offer in tests)
    // yield=3, recipe needs 1 fruit → ceil(1/3)=1 seed → cap = 2 × seedPrice = 0.6 ETH
    const seedPrice = ethers.parseEther("0.3");
    await shop.connect(owner).addSeed("Tomato Seed", "TSEED", seedPrice); // seedId=0

    // waterInterval=10min > maturationTime=2min → no watering needed during farming
    await farm.connect(owner).addFarmConfig(0, 10, 10 * MIN, 2 * MIN, 5 * MIN, 0, 3, "Tomato", "TOM");
    const fruitAddr = await farm.fruitToken(0);
    const tomato = await ethers.getContractAt("FruitToken", fruitAddr);

    const chef = await (await ethers.getContractFactory("Chef")).deploy(owner.address);
    const chefAddr = await chef.getAddress();

    // Recipe 0: needs 1 tomato, prepTime=1min, dishAmount=1
    await chef.connect(owner).addRecipe("Tomato Soup", [fruitAddr], [1], MIN, 1, "Tomato Soup", "TSOUP");
    const [, , , dishTokenAddr] = await chef.getRecipe(0);
    const dishToken = await ethers.getContractAt("DishToken", dishTokenAddr);

    // Owner acquires land 0 to farm fruit tokens on behalf of test sellers
    await la.connect(owner).bid({ value: ethers.parseEther("0.01") });
    await time.increase(3601);
    await la.settleAuction();
    const seedToken = await ethers.getContractAt("SeedToken", await shop.seedToken(0));

    const market = await (await ethers.getContractFactory("DishMarket")).deploy(owner.address, chefAddr, farmAddr);
    const marketAddr = await market.getAddress();
    await owner.sendTransaction({ to: marketAddr, value: ethers.parseEther("10") });

    // Helper: farm and give `amount` dish tokens to `signer`.
    // Each iteration: plant 1 seed → harvest (yields 3 fruits) → transfer 1 to signer → cook.
    const giveDish = async (signer: typeof owner, amount: number) => {
      for (let i = 0; i < amount; i++) {
        // Clean up land from previous harvest if needed
        if (Number(await farm.getLandState(0)) === 4 /* NeedsCleanup */) {
          await farm.connect(owner).cleanUp(0, { value: 0 });
        }

        await shop.connect(owner).buy(0, 1, { value: seedPrice });
        await seedToken.connect(owner).approve(farmAddr, 1);
        await farm.connect(owner).plant(0, 0, 1);
        await time.increase(2 * MIN + 1);
        await farm.connect(owner).harvest(0);

        await tomato.connect(owner).transfer(signer.address, 1);
        await tomato.connect(signer).approve(chefAddr, 1);
        await chef.connect(signer).startCooking(0);
        await time.increase(MIN + 1);
        await chef.connect(signer).claim(0);
      }
    };

    return {
      market,
      marketAddr,
      chef,
      chefAddr,
      farm,
      shop,
      la,
      tomato,
      dishToken,
      owner,
      seller1,
      seller2,
      seller3,
      giveDish,
    };
  }

  // ---- funding ----

  describe("funding", function () {
    it("receives ETH and tracks availableFunds", async function () {
      const { market } = await loadFixture(deployFixture);
      // 10 ETH funded in fixture
      expect(await market.availableFunds()).to.equal(ethers.parseEther("10"));
    });

    it("emits Funded event on receive", async function () {
      const { market, marketAddr, owner } = await loadFixture(deployFixture);
      await expect(owner.sendTransaction({ to: marketAddr, value: ethers.parseEther("1") }))
        .to.emit(market, "Funded")
        .withArgs(owner.address, ethers.parseEther("1"));
    });

    it("owner can withdraw uncommitted funds", async function () {
      const { market, owner } = await loadFixture(deployFixture);
      const before = await ethers.provider.getBalance(owner.address);
      const tx = await market.connect(owner).withdrawFunds(ethers.parseEther("5"));
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);
      expect(after - before + gas).to.equal(ethers.parseEther("5"));
      expect(await market.availableFunds()).to.equal(ethers.parseEther("5"));
    });

    it("reverts when withdrawing more than availableFunds", async function () {
      const { market, owner } = await loadFixture(deployFixture);
      await expect(market.connect(owner).withdrawFunds(ethers.parseEther("11"))).to.be.revertedWithCustomError(
        market,
        "InsufficientFunds",
      );
    });

    it("reverts when non-owner calls withdrawFunds", async function () {
      const { market, seller1 } = await loadFixture(deployFixture);
      await expect(market.connect(seller1).withdrawFunds(ethers.parseEther("1"))).to.be.revertedWithCustomError(
        market,
        "OnlyOwner",
      );
    });
  });

  // ---- currentDemand / getDemandForMinute ----

  describe("currentDemand", function () {
    it("returns recipeId derived from current minute", async function () {
      const { market } = await loadFixture(deployFixture);
      // 1 recipe, so demand is always recipeId 0
      expect(await market.currentDemand()).to.equal(0);
    });
  });

  // ---- submitOffer() ----

  describe("submitOffer", function () {
    it("escrows dish token and records offer", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);

      const minute = await market.currentMinute();
      await market.connect(seller1).submitOffer(ethers.parseEther("0.1"));

      const offers = await market.getOffers(minute);
      expect(offers.length).to.equal(1);
      expect(offers[0].seller).to.equal(seller1.address);
      expect(offers[0].askPrice).to.equal(ethers.parseEther("0.1"));
      expect(await dishToken.balanceOf(marketAddr)).to.equal(1);
    });

    it("tracks running minimum winner", async function () {
      const { market, marketAddr, dishToken, seller1, seller2, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await giveDish(seller2, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await dishToken.connect(seller2).approve(marketAddr, 1);

      const minute = await market.currentMinute();
      await market.connect(seller1).submitOffer(ethers.parseEther("0.5"));
      await market.connect(seller2).submitOffer(ethers.parseEther("0.3"));

      const state = await market.minuteState(minute);
      expect(state.winnerAskPrice).to.equal(ethers.parseEther("0.3"));
      expect(state.winnerIndex).to.equal(1); // seller2 is at index 1
    });

    it("reverts when ask price is zero", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await expect(market.connect(seller1).submitOffer(0)).to.be.revertedWithCustomError(market, "ZeroAskPrice");
    });

    it("reverts when ask price exceeds availableFunds", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await expect(market.connect(seller1).submitOffer(ethers.parseEther("11"))).to.be.revertedWithCustomError(
        market,
        "AskPriceTooHigh",
      );
    });

    it("reverts when same address offers twice in a minute", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 2);
      await dishToken.connect(seller1).approve(marketAddr, 2);
      await market.connect(seller1).submitOffer(ethers.parseEther("0.1"));
      await expect(market.connect(seller1).submitOffer(ethers.parseEther("0.05"))).to.be.revertedWithCustomError(
        market,
        "AlreadyOffered",
      );
    });

    it("snapshots recipeId on first offer", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      const minute = await market.currentMinute();
      await market.connect(seller1).submitOffer(ethers.parseEther("0.1"));
      const state = await market.minuteState(minute);
      expect(state.recipeId).to.equal(0);
      expect(state.hasOffers).to.equal(true);
    });
  });

  // ---- settle() ----

  describe("settle", function () {
    async function settleableFixture() {
      const base = await deployFixture();
      const { market, marketAddr, dishToken, seller1, seller2, giveDish } = base;

      await giveDish(seller1, 1);
      await giveDish(seller2, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await dishToken.connect(seller2).approve(marketAddr, 1);

      const minute = await market.currentMinute();
      // seller1 asks 0.5, seller2 asks 0.3 → seller2 is winner
      await market.connect(seller1).submitOffer(ethers.parseEther("0.5"));
      await market.connect(seller2).submitOffer(ethers.parseEther("0.3"));

      await time.increase(MIN + 1); // move to next minute
      return { ...base, minute };
    }

    it("winner calls settle, receives ETH, dish is burned", async function () {
      const { market, dishToken, seller2, minute } = await loadFixture(settleableFixture);
      const supplyBefore = await dishToken.totalSupply();
      const balBefore = await ethers.provider.getBalance(seller2.address);
      const tx = await market.connect(seller2).settle(minute);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(seller2.address);

      expect(balAfter - balBefore + gas).to.equal(ethers.parseEther("0.3"));
      // Winner's dish was burned (supply dropped by 1)
      expect(await dishToken.totalSupply()).to.equal(supplyBefore - 1n);
      expect(await market.availableFunds()).to.equal(ethers.parseEther("10") - ethers.parseEther("0.3"));
    });

    it("reverts when non-winner calls settle", async function () {
      const { market, seller1, minute } = await loadFixture(settleableFixture);
      await expect(market.connect(seller1).settle(minute)).to.be.revertedWithCustomError(market, "NotWinner");
    });

    it("reverts when minute is not over", async function () {
      const { market, seller1 } = await loadFixture(deployFixture);
      const currentMinute = await market.currentMinute();
      // Use currentMinute+1 (a future minute) so the check fires regardless of when the tx is mined
      await expect(market.connect(seller1).settle(currentMinute + 1n)).to.be.revertedWithCustomError(
        market,
        "MinuteNotOver",
      );
    });

    it("reverts when already settled", async function () {
      const { market, seller2, minute } = await loadFixture(settleableFixture);
      await market.connect(seller2).settle(minute);
      await expect(market.connect(seller2).settle(minute)).to.be.revertedWithCustomError(market, "AlreadySettled");
    });

    it("reverts when no offers", async function () {
      const { market, seller1 } = await loadFixture(deployFixture);
      const minute = (await market.currentMinute()) - 1n;
      await expect(market.connect(seller1).settle(minute)).to.be.revertedWithCustomError(market, "NoOffers");
    });

    it("emits MinuteSettled event", async function () {
      const { market, seller2, minute } = await loadFixture(settleableFixture);
      await expect(market.connect(seller2).settle(minute))
        .to.emit(market, "MinuteSettled")
        .withArgs(minute, 0, seller2.address, ethers.parseEther("0.3"));
    });
  });

  // ---- withdrawOffer() ----

  describe("withdrawOffer", function () {
    async function multiOfferFixture() {
      const base = await deployFixture();
      const { market, marketAddr, dishToken, seller1, seller2, giveDish } = base;

      await giveDish(seller1, 1);
      await giveDish(seller2, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await dishToken.connect(seller2).approve(marketAddr, 1);

      const minute = await market.currentMinute();
      // seller1 asks 0.5 (higher), seller2 asks 0.3 (lower = winner)
      await market.connect(seller1).submitOffer(ethers.parseEther("0.5"));
      await market.connect(seller2).submitOffer(ethers.parseEther("0.3"));

      return { ...base, minute };
    }

    it("non-winner withdraws offer during the minute (early withdraw)", async function () {
      const { market, dishToken, seller1, minute } = await loadFixture(multiOfferFixture);
      const balBefore = await dishToken.balanceOf(seller1.address);
      await market.connect(seller1).withdrawOffer(minute, 0); // seller1 is at index 0
      expect(await dishToken.balanceOf(seller1.address)).to.equal(balBefore + 1n);
    });

    it("non-winner withdraws after the minute ends (no settlement required)", async function () {
      const { market, dishToken, seller1, minute } = await loadFixture(multiOfferFixture);
      await time.increase(MIN + 1);
      const balBefore = await dishToken.balanceOf(seller1.address);
      await market.connect(seller1).withdrawOffer(minute, 0);
      expect(await dishToken.balanceOf(seller1.address)).to.equal(balBefore + 1n);
    });

    it("reverts when winner tries to withdraw (must use settle)", async function () {
      const { market, seller2, minute } = await loadFixture(multiOfferFixture);
      await expect(
        market.connect(seller2).withdrawOffer(minute, 1), // seller2 at index 1
      ).to.be.revertedWithCustomError(market, "OfferIsCurrentWinner");
    });

    it("reverts when wrong caller", async function () {
      const { market, seller2, minute } = await loadFixture(multiOfferFixture);
      // seller2 tries to withdraw seller1's offer
      await expect(market.connect(seller2).withdrawOffer(minute, 0)).to.be.revertedWithCustomError(
        market,
        "NotYourOffer",
      );
    });

    it("reverts on double withdraw", async function () {
      const { market, seller1, minute } = await loadFixture(multiOfferFixture);
      await market.connect(seller1).withdrawOffer(minute, 0);
      await expect(market.connect(seller1).withdrawOffer(minute, 0)).to.be.revertedWithCustomError(
        market,
        "AlreadyClaimed",
      );
    });

    it("reverts on invalid offer index", async function () {
      const { market, seller1, minute } = await loadFixture(multiOfferFixture);
      await expect(market.connect(seller1).withdrawOffer(minute, 99)).to.be.revertedWithCustomError(
        market,
        "InvalidOfferIndex",
      );
    });

    it("emits OfferWithdrawn event", async function () {
      const { market, seller1, minute } = await loadFixture(multiOfferFixture);
      await expect(market.connect(seller1).withdrawOffer(minute, 0))
        .to.emit(market, "OfferWithdrawn")
        .withArgs(minute, 0, seller1.address);
    });
  });

  // ---- price cap (2× seed cost) ----

  describe("price cap", function () {
    /**
     * Fixture with a real FarmManager so DishMarket can look up seed costs.
     *
     * Setup:
     *   seed 0 price = 0.1 ETH, harvestYield = 3
     *   recipe 0: 2× tomato fruit
     *   Seeds needed: ceil(2 / 3) = 1 seed → seed cost = 0.1 ETH → cap = 0.2 ETH
     */
    async function capFixture() {
      const [owner, seller] = await ethers.getSigners();

      const la = await (await ethers.getContractFactory("LandAuction")).deploy(owner.address);
      const shop = await (await ethers.getContractFactory("SeedShop")).deploy(owner.address);
      const farm = await (
        await ethers.getContractFactory("FarmManager")
      ).deploy(owner.address, await la.getAddress(), await shop.getAddress());
      const chef = await (await ethers.getContractFactory("Chef")).deploy(owner.address);

      const seedPrice = ethers.parseEther("0.1"); // 0.1 ETH per seed
      await shop.connect(owner).addSeed("Tomato", "TOM", seedPrice); // seedId=0

      // waterInterval=10min > maturation=2min → no watering needed
      await farm.connect(owner).addFarmConfig(0, 10, 10 * MIN, 2 * MIN, 5 * MIN, 0, 3, "Tomato", "TOM");
      const fruitAddr = await farm.fruitToken(0);
      const fruit = await ethers.getContractAt("FruitToken", fruitAddr);

      // Recipe: 2 tomato fruits → seed cost = 2 × 0.1 = 0.2 ETH → cap = 0.4 ETH
      const chefAddr = await chef.getAddress();
      await chef.connect(owner).addRecipe("TomatoSoup", [fruitAddr], [2], MIN, 1, "TomatoSoup", "TSOUP");
      const [, , , dishTokenAddr] = await chef.getRecipe(0);
      const dishToken = await ethers.getContractAt("DishToken", dishTokenAddr);

      // Acquire a land (seller bids)
      const farmAddr = await farm.getAddress();
      await la.connect(seller).bid({ value: ethers.parseEther("0.01") });
      await time.increase(3601);
      await la.settleAuction(); // land 0 → seller

      // Buy and plant seeds, harvest to get fruit tokens
      await shop.connect(seller).buy(0, 2, { value: seedPrice * 2n });
      const seedToken = await ethers.getContractAt("SeedToken", await shop.seedToken(0));
      await seedToken.connect(seller).approve(farmAddr, 2);
      await farm.connect(seller).plant(0, 0, 2);
      await time.increase(2 * MIN + 1);
      await farm.connect(seller).harvest(0);
      await farm.connect(seller).cleanUp(0, { value: 0 }); // cleanupCost=0

      // Cook to get 1 dish token (uses 2 fruit tokens, but seller has 2×3=6 fruits)
      await fruit.connect(seller).approve(chefAddr, 2);
      await chef.connect(seller).startCooking(0);
      await time.increase(MIN + 1);
      await chef.connect(seller).claim(0);

      // Deploy DishMarket WITH FarmManager (cap enforced)
      const market = await (
        await ethers.getContractFactory("DishMarket")
      ).deploy(owner.address, chefAddr, await farm.getAddress());
      const marketAddr = await market.getAddress();
      await owner.sendTransaction({ to: marketAddr, value: ethers.parseEther("10") });
      await dishToken.connect(seller).approve(marketAddr, 1);

      return { market, marketAddr, chef, farm, shop, dishToken, fruit, owner, seller, seedPrice };
    }

    it("accepts offer at exactly the cap (2× seed cost with yield conversion)", async function () {
      const { market, seller } = await loadFixture(capFixture);
      // harvestYield=3, recipe needs 2 fruits → ceil(2/3)=1 seed × 0.1 ETH = 0.1 → cap = 0.2 ETH
      await expect(market.connect(seller).submitOffer(ethers.parseEther("0.2"))).to.not.be.reverted;
    });

    it("reverts when ask price exceeds 2× seed cost", async function () {
      const { market, seller } = await loadFixture(capFixture);
      await expect(market.connect(seller).submitOffer(ethers.parseEther("0.201"))).to.be.revertedWithCustomError(
        market,
        "AskPriceExceedsCap",
      );
    });

    it("cap is still enforced well below availableFunds", async function () {
      const { market, seller } = await loadFixture(capFixture);
      // availableFunds = 10 ETH, but cap = 0.2 ETH
      await expect(market.connect(seller).submitOffer(ethers.parseEther("1"))).to.be.revertedWithCustomError(
        market,
        "AskPriceExceedsCap",
      );
    });
  });
});
