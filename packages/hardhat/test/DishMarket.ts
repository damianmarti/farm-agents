import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, network } from "hardhat";

const MIN = 60;
const EPOCH_DURATION = 10; // matches DishMarket.EPOCH_DURATION

describe("DishMarket", function () {
  // The hardhat network is configured with auto-mining disabled (interval mode) for realistic
  // local dev behaviour via `yarn chain`. Tests need instant tx inclusion, so we flip it here.
  before(async () => {
    await network.provider.send("evm_setAutomine", [true]);
  });

  async function deployFixture() {
    const [owner, seller1, seller2, seller3] = await ethers.getSigners();

    // Deploy supporting contracts for FarmManager
    const la = await (await ethers.getContractFactory("LandAuction")).deploy(owner.address);
    const shop = await (await ethers.getContractFactory("SeedShop")).deploy(owner.address);
    const farm = await (
      await ethers.getContractFactory("FarmManager")
    ).deploy(owner.address, await la.getAddress(), await shop.getAddress());
    const farmAddr = await farm.getAddress();

    // seedPrice chosen so cap (20 × 1 seed × seedPrice) > 0.5 ETH (highest offer in tests)
    // yield=3, recipe needs 1 fruit → ceil(1/3)=1 seed → cap = 20 × 0.03 ETH = 0.6 ETH
    const seedPrice = ethers.parseEther("0.03");
    await shop.connect(owner).addSeed("Tomato Seed", "TSEED", seedPrice); // seedId=0

    // FarmManager.addFarmConfig: seedId, maxCapacity, maturationTime, rotTime, cleanupCost, harvestYield, name, symbol
    await farm.connect(owner).addFarmConfig(0, 10, 2 * MIN, 5 * MIN, 0, 3, "Tomato", "TOM");
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
        await chef.connect(signer).startCooking(0, 1);
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
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 1n);

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
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.5"), 1n);
      await market.connect(seller2).submitOffer(0, ethers.parseEther("0.3"), 1n);

      const state = await market.minuteState(minute);
      expect(state.winnerAskPrice).to.equal(ethers.parseEther("0.3"));
      expect(state.winnerIndex).to.equal(1); // seller2 is at index 1
    });

    it("reverts when ask price is zero", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await expect(market.connect(seller1).submitOffer(0, 0, 1n)).to.be.revertedWithCustomError(market, "ZeroAskPrice");
    });

    it("reverts when ask price exceeds availableFunds", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await expect(market.connect(seller1).submitOffer(0, ethers.parseEther("11"), 1n)).to.be.revertedWithCustomError(
        market,
        "AskPriceTooHigh",
      );
    });

    it("reverts when same address offers twice in a minute", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 2);
      await dishToken.connect(seller1).approve(marketAddr, 2);
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 1n);
      await expect(market.connect(seller1).submitOffer(0, ethers.parseEther("0.05"), 1n)).to.be.revertedWithCustomError(
        market,
        "AlreadyOffered",
      );
    });

    it("snapshots recipeId on first offer", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      const minute = await market.currentMinute();
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 1n);
      const state = await market.minuteState(minute);
      expect(state.recipeId).to.equal(0);
      expect(state.hasOffers_).to.equal(true);
    });
  });

  // ---- settle() ----

  describe("settle", function () {
    // Two sellers submit: seller1 at 0.5, seller2 at 0.3.
    // With MAX_WINNERS=5 and 2 offers, both sellers win.
    async function settleableFixture() {
      const base = await deployFixture();
      const { market, marketAddr, dishToken, seller1, seller2, giveDish } = base;

      await giveDish(seller1, 1);
      await giveDish(seller2, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await dishToken.connect(seller2).approve(marketAddr, 1);

      // Snap to the start of the next epoch so all offers land within the same 10-second window.
      // Without this, sequential auto-mined blocks (+1s each) can straddle an epoch boundary.
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);

      const minute = BigInt(epochStart / EPOCH_DURATION);
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.5"), 1n); // index 0, ts=epochStart
      await market.connect(seller2).submitOffer(0, ethers.parseEther("0.3"), 1n); // index 1, ts=epochStart+1

      await time.increase(EPOCH_DURATION + 1); // move past the epoch
      return { ...base, minute };
    }

    // Six sellers: first five at 0.1 ETH (fill the MAX_WINNERS=5 slots), sixth at 0.5 ETH (loser).
    async function sixOfferFixture() {
      const base = await deployFixture();
      const { market, marketAddr, dishToken, giveDish } = base;

      const signers = await ethers.getSigners();
      const cheapSellers = signers.slice(1, 6); // 5 cheap sellers
      const expensiveSeller = signers[6]; // 1 expensive seller

      for (const s of [...cheapSellers, expensiveSeller]) {
        await giveDish(s, 1);
        await dishToken.connect(s).approve(marketAddr, 1);
      }

      // Snap to epoch start — 6 sequential blocks (+1s each) must all stay within one 10-second epoch.
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);

      const minute = BigInt(epochStart / EPOCH_DURATION);
      for (let i = 0; i < cheapSellers.length; i++) {
        await market.connect(cheapSellers[i]).submitOffer(0, ethers.parseEther("0.1"), 1n);
      }
      // expensiveSeller is offer index 5; cutoff = 0.1 ETH, 0.5 > 0.1 → not a winner
      await market.connect(expensiveSeller).submitOffer(0, ethers.parseEther("0.5"), 1n);

      await time.increase(EPOCH_DURATION + 1);
      return { ...base, cheapSellers, expensiveSeller, minute };
    }

    it("winner calls settle, receives ETH, dish is burned", async function () {
      const { market, dishToken, seller2, minute } = await loadFixture(settleableFixture);
      const supplyBefore = await dishToken.totalSupply();
      const balBefore = await ethers.provider.getBalance(seller2.address);
      const tx = await market.connect(seller2).settle(minute, 1); // seller2 at index 1
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(seller2.address);

      expect(balAfter - balBefore + gas).to.equal(ethers.parseEther("0.3"));
      // Winner's dish was burned (supply dropped by 1)
      expect(await dishToken.totalSupply()).to.equal(supplyBefore - 1n);
      expect(await market.availableFunds()).to.equal(ethers.parseEther("10") - ethers.parseEther("0.3"));
    });

    it("reverts when non-winner calls settle", async function () {
      const { market, expensiveSeller, minute } = await loadFixture(sixOfferFixture);
      // expensiveSeller is at index 5; 5 cheaper offers fill MAX_WINNERS → not a winner
      await expect(market.connect(expensiveSeller).settle(minute, 5)).to.be.revertedWithCustomError(
        market,
        "NotWinner",
      );
    });

    it("reverts when epoch is not over", async function () {
      const { market, seller1 } = await loadFixture(deployFixture);
      const currentEpoch = await market.currentMinute();
      // Use currentEpoch+1 (a future epoch) so the check fires regardless of when the tx is mined
      await expect(market.connect(seller1).settle(currentEpoch + 1n, 0)).to.be.revertedWithCustomError(
        market,
        "EpochNotOver",
      );
    });

    it("reverts when already claimed", async function () {
      const { market, seller2, minute } = await loadFixture(settleableFixture);
      await market.connect(seller2).settle(minute, 1);
      await expect(market.connect(seller2).settle(minute, 1)).to.be.revertedWithCustomError(market, "AlreadyClaimed");
    });

    it("reverts when no offers", async function () {
      const { market, seller1 } = await loadFixture(deployFixture);
      const minute = (await market.currentMinute()) - 1n;
      await expect(market.connect(seller1).settle(minute, 0)).to.be.revertedWithCustomError(market, "NoOffers");
    });

    it("emits EpochSettled event", async function () {
      const { market, seller2, minute } = await loadFixture(settleableFixture);
      await expect(market.connect(seller2).settle(minute, 1))
        .to.emit(market, "EpochSettled")
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

      // Snap to epoch start so both offers land in the same epoch.
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);

      const minute = BigInt(epochStart / EPOCH_DURATION);
      // seller1 asks 0.5 (higher), seller2 asks 0.3 (lower = leader / current winner)
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.5"), 1n); // index 0
      await market.connect(seller2).submitOffer(0, ethers.parseEther("0.3"), 1n); // index 1

      return { ...base, minute };
    }

    it("non-leader withdraws offer during the epoch (early withdraw)", async function () {
      const { market, dishToken, seller1, minute } = await loadFixture(multiOfferFixture);
      const balBefore = await dishToken.balanceOf(seller1.address);
      await market.connect(seller1).withdrawOffer(minute, 0); // seller1 is at index 0
      expect(await dishToken.balanceOf(seller1.address)).to.equal(balBefore + 1n);
    });

    it("non-leader withdraws after the epoch ends (no settlement required)", async function () {
      const { market, dishToken, seller1, minute } = await loadFixture(multiOfferFixture);
      await time.increase(EPOCH_DURATION + 1);
      const balBefore = await dishToken.balanceOf(seller1.address);
      await market.connect(seller1).withdrawOffer(minute, 0);
      expect(await dishToken.balanceOf(seller1.address)).to.equal(balBefore + 1n);
    });

    it("reverts when leader tries to withdraw during epoch (must use settle)", async function () {
      const { market, seller2, minute } = await loadFixture(multiOfferFixture);
      await expect(
        market.connect(seller2).withdrawOffer(minute, 1), // seller2 at index 1 is the leader
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

  // ---- price cap (20× seed cost) ----

  describe("price cap", function () {
    /**
     * Fixture with a real FarmManager so DishMarket can look up seed costs.
     *
     * Setup:
     *   seed 0 price = 0.1 ETH, harvestYield = 3
     *   recipe 0: 2× tomato fruit
     *   Seeds needed: ceil(2 / 3) = 1 seed → seed cost = 0.1 ETH → cap = 20 × 0.1 = 2 ETH
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

      // FarmManager.addFarmConfig: seedId, maxCapacity, maturationTime, rotTime, cleanupCost, harvestYield, name, symbol
      await farm.connect(owner).addFarmConfig(0, 10, 2 * MIN, 5 * MIN, 0, 3, "Tomato", "TOM");
      const fruitAddr = await farm.fruitToken(0);
      const fruit = await ethers.getContractAt("FruitToken", fruitAddr);

      // Recipe: 2 tomato fruits → seeds needed = ceil(2/3) = 1 → seed cost = 0.1 ETH → cap = 20 × 0.1 = 2 ETH
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

      // Cook to get 1 dish token (uses 2 fruit tokens, seller has 2×3=6 fruits)
      await fruit.connect(seller).approve(chefAddr, 2);
      await chef.connect(seller).startCooking(0, 1);
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

    it("accepts offer at exactly the cap (20× seed cost with yield conversion)", async function () {
      const { market, seller } = await loadFixture(capFixture);
      // harvestYield=3, recipe needs 2 fruits → ceil(2/3)=1 seed × 0.1 ETH = 0.1 → cap = 20 × 0.1 = 2 ETH
      await expect(market.connect(seller).submitOffer(0, ethers.parseEther("2"), 1n)).to.not.be.reverted;
    });

    it("reverts when ask price exceeds 20× seed cost", async function () {
      const { market, seller } = await loadFixture(capFixture);
      await expect(market.connect(seller).submitOffer(0, ethers.parseEther("2.001"), 1n)).to.be.revertedWithCustomError(
        market,
        "AskPriceExceedsCap",
      );
    });

    it("cap is still enforced well below availableFunds", async function () {
      const { market, seller } = await loadFixture(capFixture);
      // availableFunds = 10 ETH, but cap = 2 ETH
      await expect(market.connect(seller).submitOffer(0, ethers.parseEther("3"), 1n)).to.be.revertedWithCustomError(
        market,
        "AskPriceExceedsCap",
      );
    });
  });
});
