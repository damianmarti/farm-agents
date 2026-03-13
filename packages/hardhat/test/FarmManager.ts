import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const MIN = 60;

describe("FarmManager", function () {
  async function deployFixture() {
    const [owner, landOwner, other] = await ethers.getSigners();

    // Deploy dependencies
    const LandAuction = await ethers.getContractFactory("LandAuction");
    const landAuction = await LandAuction.deploy(owner.address);

    const SeedShop = await ethers.getContractFactory("SeedShop");
    const seedShop = await SeedShop.deploy(owner.address);

    const FarmManager = await ethers.getContractFactory("FarmManager");
    const farm = await FarmManager.deploy(owner.address, await landAuction.getAddress(), await seedShop.getAddress());

    // Give landOwner land 0 via auction
    await landAuction.connect(landOwner).bid({ value: ethers.parseEther("1") });
    await time.increase(3601);
    await landAuction.connect(owner).settleAuction();

    // Add seed type 0 (Tomato) in shop
    await seedShop.connect(owner).addSeed("Tomato Seed", "TOMATO", ethers.parseEther("0.01"));

    // Add farm config for seedId=0
    await farm.connect(owner).addFarmConfig(
      0, // seedId
      10, // maxCapacity
      2 * MIN, // waterInterval (2 min)
      4 * MIN, // maturationTime (4 min)
      2 * MIN, // rotTime (2 min)
      ethers.parseEther("0.001"), // cleanupCost
      2, // harvestYield (2 fruit per seed)
      "Tomato",
      "TOM",
    );

    // Buy and approve seeds for landOwner
    const seedTokenAddr = await seedShop.seedToken(0);
    const seedToken = await ethers.getContractAt("SeedToken", seedTokenAddr);
    await seedShop.connect(landOwner).buy(0, 10n, { value: ethers.parseEther("0.1") });
    await seedToken.connect(landOwner).approve(await farm.getAddress(), 10n);

    return { farm, landAuction, seedShop, seedToken, owner, landOwner, other, landId: 0, seedId: 0 };
  }

  // ---- addFarmConfig() ----

  describe("addFarmConfig", function () {
    it("stores config and deploys FruitToken", async function () {
      const { farm, owner, seedShop } = await loadFixture(deployFixture);
      // seedId=0 already configured in fixture; add seedId=1
      await seedShop.connect(owner).addSeed("Lettuce Seed", "LETTUCE", ethers.parseEther("0.01"));
      await farm.connect(owner).addFarmConfig(1, 5, MIN, 3 * MIN, MIN, 0, 1, "Lettuce", "LET");
      const fruitAddr = await farm.fruitToken(1);
      expect(fruitAddr).to.not.equal(ethers.ZeroAddress);
    });

    it("reverts on duplicate config", async function () {
      const { farm, owner } = await loadFixture(deployFixture);
      await expect(
        farm.connect(owner).addFarmConfig(0, 10, 2 * MIN, 4 * MIN, 2 * MIN, 0, 2, "Tomato2", "TOM2"),
      ).to.be.revertedWithCustomError(farm, "ConfigAlreadyExists");
    });

    it("reverts on zero maxCapacity", async function () {
      const { farm, owner, seedShop } = await loadFixture(deployFixture);
      await seedShop.connect(owner).addSeed("X", "X", ethers.parseEther("0.01"));
      await expect(
        farm.connect(owner).addFarmConfig(1, 0, MIN, 3 * MIN, MIN, 0, 1, "X", "X"),
      ).to.be.revertedWithCustomError(farm, "InvalidFarmConfig");
    });

    it("reverts when called by non-owner", async function () {
      const { farm, other, seedShop, owner } = await loadFixture(deployFixture);
      await seedShop.connect(owner).addSeed("X", "X", ethers.parseEther("0.01"));
      await expect(
        farm.connect(other).addFarmConfig(1, 5, MIN, 3 * MIN, MIN, 0, 1, "X", "X"),
      ).to.be.revertedWithCustomError(farm, "OnlyOwner");
    });
  });

  // ---- getLandState() ----

  describe("getLandState", function () {
    it("returns Empty on unplanted land", async function () {
      const { farm, landId } = await loadFixture(deployFixture);
      expect(await farm.getLandState(landId)).to.equal(0); // Empty
    });

    it("returns Growing after planting", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      expect(await farm.getLandState(landId)).to.equal(1); // Growing
    });

    it("returns Mature after maturationTime", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      // Water every minute to stay within waterInterval (2 min)
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN + 1); // total ~4 min → Mature
      expect(await farm.getLandState(landId)).to.equal(2); // Mature
    });

    it("returns Rotten after rotTime expires", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(4 * MIN + 2 * MIN + 1);
      expect(await farm.getLandState(landId)).to.equal(3); // Rotten
    });

    it("returns Rotten when watering is missed", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(2 * MIN + 1); // waterInterval exceeded
      expect(await farm.getLandState(landId)).to.equal(3); // Rotten
    });

    it("returns NeedsCleanup after harvest", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      // Water every minute to stay within waterInterval (2 min), reach maturity at 4 min
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN + 1);
      await farm.connect(landOwner).harvest(landId);
      expect(await farm.getLandState(landId)).to.equal(4); // NeedsCleanup
    });
  });

  // ---- plant() ----

  describe("plant", function () {
    it("plants seeds and burns them from caller", async function () {
      const { farm, landOwner, seedToken, landId, seedId } = await loadFixture(deployFixture);
      const before = await seedToken.balanceOf(landOwner.address);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      expect(await seedToken.balanceOf(landOwner.address)).to.equal(before - 3n);
      expect(await farm.getLandState(landId)).to.equal(1); // Growing
    });

    it("reverts when caller is not land owner", async function () {
      const { farm, other, landId, seedId } = await loadFixture(deployFixture);
      await expect(farm.connect(other).plant(landId, seedId, 3)).to.be.revertedWithCustomError(farm, "NotLandOwner");
    });

    it("reverts when land is not empty", async function () {
      const { farm, landOwner, seedToken, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await seedToken.connect(landOwner).approve(await farm.getAddress(), 10n);
      await expect(farm.connect(landOwner).plant(landId, seedId, 3)).to.be.revertedWithCustomError(
        farm,
        "LandNotEmpty",
      );
    });

    it("reverts when seed is not configured", async function () {
      const { farm, landOwner, landId } = await loadFixture(deployFixture);
      await expect(farm.connect(landOwner).plant(landId, 99, 1)).to.be.revertedWithCustomError(
        farm,
        "SeedNotConfigured",
      );
    });

    it("reverts when amount exceeds maxCapacity", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await expect(farm.connect(landOwner).plant(landId, seedId, 11)).to.be.revertedWithCustomError(
        farm,
        "InvalidSeedAmount",
      );
    });

    it("reverts when amount is zero", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await expect(farm.connect(landOwner).plant(landId, seedId, 0)).to.be.revertedWithCustomError(
        farm,
        "InvalidSeedAmount",
      );
    });
  });

  // ---- water() ----

  describe("water", function () {
    it("resets the watering timer", async function () {
      const { farm, landOwner, other, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(MIN + 30);
      await farm.connect(other).water(landId); // anyone can water
      // lastWateredAt should be fresh (not triggering rotten)
      expect(await farm.getLandState(landId)).to.equal(1); // still Growing
    });

    it("reverts on empty land", async function () {
      const { farm, landOwner, landId } = await loadFixture(deployFixture);
      await expect(farm.connect(landOwner).water(landId)).to.be.revertedWithCustomError(farm, "NothingPlanted");
    });

    it("reverts on rotten plant", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(2 * MIN + 1);
      await expect(farm.connect(landOwner).water(landId)).to.be.revertedWithCustomError(farm, "CannotWaterDeadPlant");
    });
  });

  // ---- harvest() ----

  describe("harvest", function () {
    async function maturePlotFixture() {
      const base = await deployFixture();
      const { farm, landOwner, landId, seedId } = base;
      await farm.connect(landOwner).plant(landId, seedId, 3);
      // Water every minute to stay within waterInterval (2 min), reach maturity at 4 min
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN + 1); // total ~4 min → Mature
      return base;
    }

    it("mints fruit tokens and transitions to NeedsCleanup", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(maturePlotFixture);
      const fruitAddr = await farm.fruitToken(seedId);
      const fruitToken = await ethers.getContractAt("FruitToken", fruitAddr);

      await farm.connect(landOwner).harvest(landId);
      // 3 seeds * 2 yield = 6 fruit
      expect(await fruitToken.balanceOf(landOwner.address)).to.equal(6);
      expect(await farm.getLandState(landId)).to.equal(4); // NeedsCleanup
    });

    it("reverts when not mature", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await expect(farm.connect(landOwner).harvest(landId)).to.be.revertedWithCustomError(farm, "NotReadyToHarvest");
    });

    it("reverts when caller is not land owner", async function () {
      const { farm, other, landId } = await loadFixture(maturePlotFixture);
      await expect(farm.connect(other).harvest(landId)).to.be.revertedWithCustomError(farm, "NotLandOwner");
    });
  });

  // ---- cleanUp() ----

  describe("cleanUp", function () {
    it("cleans up rotten land and resets to Empty", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(2 * MIN + 1); // Rotten from missed watering
      await farm.connect(landOwner).cleanUp(landId, { value: ethers.parseEther("0.001") });
      expect(await farm.getLandState(landId)).to.equal(0); // Empty
    });

    it("cleans up NeedsCleanup land", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN);
      await farm.connect(landOwner).water(landId);
      await time.increase(MIN + 1);
      await farm.connect(landOwner).harvest(landId);
      await farm.connect(landOwner).cleanUp(landId, { value: ethers.parseEther("0.001") });
      expect(await farm.getLandState(landId)).to.equal(0); // Empty
    });

    it("accumulates fees and owner can withdraw", async function () {
      const { farm, landOwner, owner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(2 * MIN + 1);
      await farm.connect(landOwner).cleanUp(landId, { value: ethers.parseEther("0.001") });
      expect(await ethers.provider.getBalance(await farm.getAddress())).to.equal(ethers.parseEther("0.001"));
      await farm.connect(owner).withdrawFees();
      expect(await ethers.provider.getBalance(await farm.getAddress())).to.equal(0);
    });

    it("reverts when land is Growing", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await expect(
        farm.connect(landOwner).cleanUp(landId, { value: ethers.parseEther("0.001") }),
      ).to.be.revertedWithCustomError(farm, "NothingToCleanUp");
    });

    it("reverts with wrong ETH amount", async function () {
      const { farm, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(2 * MIN + 1);
      await expect(
        farm.connect(landOwner).cleanUp(landId, { value: ethers.parseEther("0.002") }),
      ).to.be.revertedWithCustomError(farm, "WrongCleanupPayment");
    });

    it("reverts when caller is not land owner", async function () {
      const { farm, other, landOwner, landId, seedId } = await loadFixture(deployFixture);
      await farm.connect(landOwner).plant(landId, seedId, 3);
      await time.increase(2 * MIN + 1);
      await expect(
        farm.connect(other).cleanUp(landId, { value: ethers.parseEther("0.001") }),
      ).to.be.revertedWithCustomError(farm, "NotLandOwner");
    });
  });

  // ---- withdrawFees() ----

  describe("withdrawFees", function () {
    it("reverts with nothing to withdraw", async function () {
      const { farm, owner } = await loadFixture(deployFixture);
      await expect(farm.connect(owner).withdrawFees()).to.be.revertedWithCustomError(farm, "NothingToWithdraw");
    });

    it("reverts when called by non-owner", async function () {
      const { farm, other } = await loadFixture(deployFixture);
      await expect(farm.connect(other).withdrawFees()).to.be.revertedWithCustomError(farm, "OnlyOwner");
    });
  });
});
