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

      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
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

      // Snap to epoch start so both offers land in the same epoch
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
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
      // Snap to epoch start so both offers land in the same epoch
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
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
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
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
      // availableFunds was committed at submitOffer (deducted for both offers: 0.5 + 0.3).
      // settle() pays from committed funds without a second deduction.
      expect(await market.availableFunds()).to.equal(
        ethers.parseEther("10") - ethers.parseEther("0.5") - ethers.parseEther("0.3"),
      );
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

  // ---- submitOffer — additional ----

  describe("submitOffer — additional", function () {
    it("reverts when amount is zero", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await expect(market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 0n)).to.be.revertedWithCustomError(
        market,
        "ZeroAmount",
      );
    });

    it("reverts when recipeId is not demanded this epoch", async function () {
      // With 1 recipe (recipeId 0), both primary and secondary snap to 0.
      // Offering recipeId 1 (nonexistent) is not demanded → NotDemandedRecipe.
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await expect(market.connect(seller1).submitOffer(1, ethers.parseEther("0.1"), 1n)).to.be.revertedWithCustomError(
        market,
        "NotDemandedRecipe",
      );
    });

    it("amount > 1 escrows multiple tokens; settle pays askPrice × amount", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 2);
      await dishToken.connect(seller1).approve(marketAddr, 2);

      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 2n);
      expect(await dishToken.balanceOf(marketAddr)).to.equal(2);

      await time.increase(EPOCH_DURATION + 1);
      const supplyBefore = await dishToken.totalSupply();
      const balBefore = await ethers.provider.getBalance(seller1.address);
      const tx = await market.connect(seller1).settle(minute, 0);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(seller1.address);

      expect(balAfter - balBefore + gas).to.equal(ethers.parseEther("0.2")); // 0.1 × 2
      expect(await dishToken.totalSupply()).to.equal(supplyBefore - 2n); // 2 tokens burned
    });

    it("emits OfferSubmitted with correct recipeId", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      await expect(market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 1n))
        .to.emit(market, "OfferSubmitted")
        .withArgs(minute, 0, seller1.address, ethers.parseEther("0.1"));
    });
  });

  // ---- settle — additional ----

  describe("settle — additional", function () {
    // Shared: 2 sellers, past epoch, seller1@0.5 (index 0), seller2@0.3 (index 1, both win)
    async function pastEpochFixture() {
      const base = await deployFixture();
      const { market, marketAddr, dishToken, seller1, seller2, giveDish } = base;
      await giveDish(seller1, 1);
      await giveDish(seller2, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await dishToken.connect(seller2).approve(marketAddr, 1);
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.5"), 1n); // index 0
      await market.connect(seller2).submitOffer(0, ethers.parseEther("0.3"), 1n); // index 1
      await time.increase(EPOCH_DURATION + 1);
      return { ...base, minute };
    }

    // 5 cheap sellers (fill MAX_WINNERS) + 1 expensive seller (loses)
    async function sixOfferSettleFixture() {
      const base = await deployFixture();
      const { market, marketAddr, dishToken, giveDish } = base;
      const signers = await ethers.getSigners();
      const cheapSellers = signers.slice(1, 6);
      const expensiveSeller = signers[6];
      for (const s of [...cheapSellers, expensiveSeller]) {
        await giveDish(s, 1);
        await dishToken.connect(s).approve(marketAddr, 1);
      }
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      for (const s of cheapSellers) {
        await market.connect(s).submitOffer(0, ethers.parseEther("0.1"), 1n);
      }
      await market.connect(expensiveSeller).submitOffer(0, ethers.parseEther("0.5"), 1n);
      await time.increase(EPOCH_DURATION + 1);
      return { ...base, cheapSellers, expensiveSeller, minute };
    }

    // 6 sellers all at the same price — array fills at 5, 6th is tied at cutoff
    async function tiedOfferFixture() {
      const base = await deployFixture();
      const { market, marketAddr, dishToken, giveDish } = base;
      const signers = await ethers.getSigners();
      const sellers = signers.slice(1, 7); // 6 sellers
      for (const s of sellers) {
        await giveDish(s, 1);
        await dishToken.connect(s).approve(marketAddr, 1);
      }
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      for (const s of sellers) {
        await market.connect(s).submitOffer(0, ethers.parseEther("0.1"), 1n);
      }
      await time.increase(EPOCH_DURATION + 1);
      return { ...base, sellers, minute };
    }

    it("reverts with InvalidOfferIndex when index is out of range", async function () {
      const { market, seller1, minute } = await loadFixture(pastEpochFixture);
      await expect(market.connect(seller1).settle(minute, 99)).to.be.revertedWithCustomError(
        market,
        "InvalidOfferIndex",
      );
    });

    it("reverts with NotYourOffer when caller is not the offer's seller", async function () {
      const { market, seller1, minute } = await loadFixture(pastEpochFixture);
      // seller1 tries to settle seller2's offer at index 1
      await expect(market.connect(seller1).settle(minute, 1)).to.be.revertedWithCustomError(market, "NotYourOffer");
    });

    it("all MAX_WINNERS cheapest offers can each settle independently", async function () {
      const { market, cheapSellers, minute } = await loadFixture(sixOfferSettleFixture);
      for (let i = 0; i < cheapSellers.length; i++) {
        await expect(market.connect(cheapSellers[i]).settle(minute, i)).to.not.be.reverted;
      }
    });

    it("offer tied at the cutoff price also wins", async function () {
      // 6 offers all at 0.1 ETH. Array fills after 5 (cutoff = 0.1). 6th offer: 0.1 <= 0.1 → wins.
      const { market, sellers, minute } = await loadFixture(tiedOfferFixture);
      for (let i = 0; i < sellers.length; i++) {
        await expect(market.connect(sellers[i]).settle(minute, i)).to.not.be.reverted;
      }
    });

    it("winner can withdraw escrowed tokens after epoch ends instead of settling", async function () {
      // The cheapest-ask seller (would be a winner) can choose to withdraw after epoch ends.
      // The epoch-active leader guard only blocks withdrawal DURING the epoch.
      const { market, dishToken, seller2, minute } = await loadFixture(pastEpochFixture);
      const balBefore = await dishToken.balanceOf(seller2.address);
      await market.connect(seller2).withdrawOffer(minute, 1); // seller2 = lowest ask, index 1
      expect(await dishToken.balanceOf(seller2.address)).to.equal(balBefore + 1n);
    });
  });

  // ---- secondary demand ----

  describe("secondary demand", function () {
    // Adds a second recipe (Tomato Salad, same fruit) on top of the base fixture.
    // With 2 recipes, secondary is always 1 - primary (count=2 leaves no other choice).
    async function twoRecipeFixture() {
      const base = await deployFixture();
      const { chef, owner, farm, shop, tomato } = base;
      const farmAddr = await farm.getAddress();
      const chefAddr = await chef.getAddress();
      const seedPrice = ethers.parseEther("0.03");

      await chef
        .connect(owner)
        .addRecipe("Tomato Salad", [await farm.fruitToken(0)], [1], MIN, 1, "Tomato Salad", "TSALAD");
      const [, , , dishToken1Addr] = await chef.getRecipe(1);
      const dishToken1 = await ethers.getContractAt("DishToken", dishToken1Addr);

      // Farm + cook helper for any recipe (same flow as base giveDish but parameterized)
      const giveDishForRecipe = async (signer: typeof owner, recipeId: number, amount: number) => {
        const seedToken = await ethers.getContractAt("SeedToken", await shop.seedToken(0));
        for (let i = 0; i < amount; i++) {
          if (Number(await farm.getLandState(0)) === 4) {
            await farm.connect(owner).cleanUp(0, { value: 0 });
          }
          await shop.connect(owner).buy(0, 1, { value: seedPrice });
          await seedToken.connect(owner).approve(farmAddr, 1);
          await farm.connect(owner).plant(0, 0, 1);
          await time.increase(2 * MIN + 1);
          await farm.connect(owner).harvest(0);
          await tomato.connect(owner).transfer(signer.address, 1);
          await tomato.connect(signer).approve(chefAddr, 1);
          await chef.connect(signer).startCooking(recipeId, 1);
          await time.increase(MIN + 1);
          await chef.connect(signer).claim(recipeId);
        }
      };

      return { ...base, dishToken1, giveDishForRecipe };
    }

    it("primary and secondary are always different when 2 recipes exist", async function () {
      const { market } = await loadFixture(twoRecipeFixture);
      const primary = Number(await market.currentDemand());
      const secondary = Number(await market.currentSecondDemand());
      expect(primary).to.not.equal(secondary);
      expect(primary).to.be.oneOf([0, 1]);
      expect(secondary).to.be.oneOf([0, 1]);
    });

    it("user can offer for both primary and secondary in the same epoch", async function () {
      const { market, marketAddr, dishToken, dishToken1, seller1, giveDish, giveDishForRecipe } =
        await loadFixture(twoRecipeFixture);

      await giveDish(seller1, 1);
      await giveDishForRecipe(seller1, 1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await dishToken1.connect(seller1).approve(marketAddr, 1);

      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      const primaryId = Number(minute % 2n);
      const secondaryId = 1 - primaryId;

      // Both offers must succeed: one per recipe per epoch is allowed
      await market.connect(seller1).submitOffer(primaryId, ethers.parseEther("0.1"), 1n);
      await market.connect(seller1).submitOffer(secondaryId, ethers.parseEther("0.1"), 1n);

      expect(await market.hasOffered(minute, primaryId, seller1.address)).to.equal(true);
      expect(await market.hasOffered(minute, secondaryId, seller1.address)).to.equal(true);
    });

    it("secondary recipe winner settles and receives ETH; secondary dish tokens burned", async function () {
      const { market, marketAddr, dishToken, dishToken1, seller1, giveDish, giveDishForRecipe } =
        await loadFixture(twoRecipeFixture);

      await giveDish(seller1, 1);
      await giveDishForRecipe(seller1, 1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      await dishToken1.connect(seller1).approve(marketAddr, 1);

      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      const primaryId = Number(minute % 2n);
      const secondaryId = 1 - primaryId;

      await market.connect(seller1).submitOffer(primaryId, ethers.parseEther("0.1"), 1n); // index 0
      await market.connect(seller1).submitOffer(secondaryId, ethers.parseEther("0.15"), 1n); // index 1

      await time.increase(EPOCH_DURATION + 1);

      const secondaryDishToken = secondaryId === 0 ? dishToken : dishToken1;
      const supplyBefore = await secondaryDishToken.totalSupply();
      const balBefore = await ethers.provider.getBalance(seller1.address);
      const tx = await market.connect(seller1).settle(minute, 1); // settle secondary offer
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(seller1.address);

      expect(balAfter - balBefore + gas).to.equal(ethers.parseEther("0.15"));
      expect(await secondaryDishToken.totalSupply()).to.equal(supplyBefore - 1n);
    });

    it("reverts when offering for a recipe that is neither primary nor secondary", async function () {
      // With 2 recipes, both 0 and 1 are demanded. Add a 3rd recipe; only 2 of the 3 are demanded.
      const base = await loadFixture(twoRecipeFixture);
      const { chef, owner, farm, market, marketAddr, dishToken, seller1, giveDish } = base;

      // Recipe 2: same tomato fruit, just adds a third option
      await chef
        .connect(owner)
        .addRecipe("Tomato Stew", [await farm.fruitToken(0)], [1], MIN, 1, "Tomato Stew", "TSTEW");
      const [, , , dishToken2Addr] = await chef.getRecipe(2);
      const dishToken2 = await ethers.getContractAt("DishToken", dishToken2Addr);

      // Cook 1 dish for recipe 2 (via the base giveDish + manual startCooking)
      await giveDish(seller1, 0); // just to seed land state — 0 iterations, no-op
      // Farm manually for recipe 2
      const chefAddr = await chef.getAddress();
      const seedPrice = ethers.parseEther("0.03");
      await base.shop.connect(owner).buy(0, 1, { value: seedPrice });
      const seedToken = await ethers.getContractAt("SeedToken", await base.shop.seedToken(0));
      await seedToken.connect(owner).approve(await base.farm.getAddress(), 1);
      await base.farm.connect(owner).plant(0, 0, 1);
      await time.increase(2 * MIN + 1);
      await base.farm.connect(owner).harvest(0);
      await base.tomato.connect(owner).transfer(seller1.address, 1);
      await base.tomato.connect(seller1).approve(chefAddr, 1);
      await chef.connect(seller1).startCooking(2, 1);
      await time.increase(MIN + 1);
      await chef.connect(seller1).claim(2);

      await dishToken2.connect(seller1).approve(marketAddr, 1);

      // Now there are 3 recipes. Primary = epoch % 3 = 0, 1, or 2.
      // Secondary = prevrandao-derived, also one of the 3. One recipe is NOT demanded.
      // The first offer snapshots both demanded recipes. Then offering recipeId that's not in {primary, secondary} must fail.
      // Strategy: submit a valid offer first to lock in the snapshot, then try to offer for the undmanded recipe.
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      const minute = await market.currentMinute();
      // Submit a valid primary offer to snapshot the epoch
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 1n);
      const state = await market.epochState(minute);
      // Find which recipe is NOT in {primary, secondary}
      const demandedSet = new Set([Number(state.recipeId), Number(state.secondRecipeId)]);
      const notDemanded = [0, 1, 2].find(r => !demandedSet.has(r));
      if (notDemanded !== undefined) {
        const notDemandedToken = notDemanded === 0 ? dishToken : notDemanded === 2 ? dishToken2 : base.dishToken1;
        await notDemandedToken.connect(seller1).approve(marketAddr, 1);
        await expect(
          market.connect(seller1).submitOffer(notDemanded, ethers.parseEther("0.1"), 1n),
        ).to.be.revertedWithCustomError(market, "NotDemandedRecipe");
      }
    });
  });

  // ---- funds commitment (fix #1) ----

  describe("funds commitment", function () {
    it("availableFunds decrements on submitOffer and restores on withdrawOffer", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);

      const before = await market.availableFunds();
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 1n);
      expect(await market.availableFunds()).to.equal(before - ethers.parseEther("0.1"));

      // Advance past the epoch so the leader guard doesn't block withdrawal
      await time.increase(EPOCH_DURATION + 1);
      await market.connect(seller1).withdrawOffer(minute, 0);
      expect(await market.availableFunds()).to.equal(before);
    });

    it("concurrent offers cannot collectively exceed availableFunds", async function () {
      // Treasury has 10 ETH. Each call asks 0.5 ETH × 10 = 5 ETH.
      // After two offers (10 ETH committed) the treasury is exhausted; the third must fail.
      const { market, marketAddr, dishToken, seller1, seller2, seller3, giveDish } = await loadFixture(deployFixture);
      for (const s of [seller1, seller2, seller3]) {
        await giveDish(s, 10);
        await dishToken.connect(s).approve(marketAddr, 10);
      }
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);

      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.5"), 10n); // 5 ETH committed
      await market.connect(seller2).submitOffer(0, ethers.parseEther("0.5"), 10n); // 10 ETH committed
      await expect(market.connect(seller3).submitOffer(0, ethers.parseEther("0.5"), 10n)).to.be.revertedWithCustomError(
        market,
        "AskPriceTooHigh",
      );
    });

    it("settle does not double-deduct: availableFunds stays at committed level after payout", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);

      const fundsBefore = await market.availableFunds();
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 1n);
      expect(await market.availableFunds()).to.equal(fundsBefore - ethers.parseEther("0.1"));

      await time.increase(EPOCH_DURATION + 1);
      await market.connect(seller1).settle(minute, 0);

      // The committed 0.1 ETH was paid out; availableFunds was already reduced in submitOffer
      // and must NOT be reduced again by settle().
      expect(await market.availableFunds()).to.equal(fundsBefore - ethers.parseEther("0.1"));
    });
  });

  // ---- getWinnerCutoff (fix #2) ----

  describe("getWinnerCutoff", function () {
    it("returns type(uint256).max when no offers exist for the epoch", async function () {
      const { market } = await loadFixture(deployFixture);
      const epoch = await market.currentMinute();
      expect(await market.getWinnerCutoff(epoch, 0)).to.equal(ethers.MaxUint256);
    });

    it("returns max while fewer than MAX_WINNERS offers exist", async function () {
      const { market, marketAddr, dishToken, seller1, giveDish } = await loadFixture(deployFixture);
      await giveDish(seller1, 1);
      await dishToken.connect(seller1).approve(marketAddr, 1);
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      await market.connect(seller1).submitOffer(0, ethers.parseEther("0.1"), 1n);
      // 1 of MAX_WINNERS=5 slots filled — cutoff is still max (every offer wins)
      expect(await market.getWinnerCutoff(minute, 0)).to.equal(ethers.MaxUint256);
    });

    it("returns the MAX_WINNERS-th cheapest price once slots are full", async function () {
      const base = await loadFixture(deployFixture);
      const { market, marketAddr, dishToken, giveDish } = base;
      const signers = await ethers.getSigners();
      const cheapSellers = signers.slice(1, 6); // 5 sellers
      const expensiveSeller = signers[6];
      for (const s of [...cheapSellers, expensiveSeller]) {
        await giveDish(s, 1);
        await dishToken.connect(s).approve(marketAddr, 1);
      }
      const epochStart = (Math.floor((await time.latest()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
      await time.setNextBlockTimestamp(epochStart);
      const minute = BigInt(epochStart / EPOCH_DURATION);
      for (const s of cheapSellers) {
        await market.connect(s).submitOffer(0, ethers.parseEther("0.1"), 1n);
      }
      await market.connect(expensiveSeller).submitOffer(0, ethers.parseEther("0.5"), 1n);

      // 5 slots filled at 0.1; expensive offer is above cutoff and doesn't displace any slot
      expect(await market.getWinnerCutoff(minute, 0)).to.equal(ethers.parseEther("0.1"));
    });
  });
});
