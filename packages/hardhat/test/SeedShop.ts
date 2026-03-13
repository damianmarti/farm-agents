import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("SeedShop", function () {
  async function deployFixture() {
    const [owner, buyer, other] = await ethers.getSigners();
    const SeedShop = await ethers.getContractFactory("SeedShop");
    const shop = await SeedShop.deploy(owner.address);
    return { shop, owner, buyer, other };
  }

  async function shopWithSeedFixture() {
    const base = await deployFixture();
    const { shop, owner } = base;
    await shop.connect(owner).addSeed("Tomato Seed", "TOMATO", ethers.parseEther("0.1"));
    return { ...base, seedId: 0n };
  }

  // ---- constructor ----

  describe("constructor", function () {
    it("reverts with zero address", async function () {
      const SeedShop = await ethers.getContractFactory("SeedShop");
      await expect(SeedShop.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(SeedShop, "ZeroAddress");
    });
  });

  // ---- addSeed() ----

  describe("addSeed", function () {
    it("adds a seed and assigns sequential IDs", async function () {
      const { shop, owner } = await loadFixture(deployFixture);
      await shop.connect(owner).addSeed("Tomato Seed", "TOMATO", ethers.parseEther("0.1"));
      await shop.connect(owner).addSeed("Lettuce Seed", "LETTUCE", ethers.parseEther("0.05"));
      expect(await shop.seedCount()).to.equal(2);
    });

    it("deploys a SeedToken with correct name and symbol", async function () {
      const { shop, owner } = await loadFixture(deployFixture);
      await shop.connect(owner).addSeed("Tomato Seed", "TOMATO", ethers.parseEther("0.1"));
      const tokenAddr = await shop.seedToken(0);
      const token = await ethers.getContractAt("SeedToken", tokenAddr);
      expect(await token.name()).to.equal("Tomato Seed");
      expect(await token.symbol()).to.equal("TOMATO");
      expect(await token.decimals()).to.equal(0);
    });

    it("reverts when price is zero", async function () {
      const { shop, owner } = await loadFixture(deployFixture);
      await expect(shop.connect(owner).addSeed("Tomato Seed", "TOMATO", 0)).to.be.revertedWithCustomError(
        shop,
        "PriceMustBePositive",
      );
    });

    it("reverts when called by non-owner", async function () {
      const { shop, other } = await loadFixture(deployFixture);
      await expect(
        shop.connect(other).addSeed("Tomato Seed", "TOMATO", ethers.parseEther("0.1")),
      ).to.be.revertedWithCustomError(shop, "OnlyOwner");
    });

    it("emits SeedAdded event", async function () {
      const { shop, owner } = await loadFixture(deployFixture);
      const tx = shop.connect(owner).addSeed("Tomato Seed", "TOMATO", ethers.parseEther("0.1"));
      await expect(tx).to.emit(shop, "SeedAdded");
    });
  });

  // ---- buy() ----

  describe("buy", function () {
    it("mints seed tokens to buyer on exact ETH", async function () {
      const { shop, buyer, seedId } = await loadFixture(shopWithSeedFixture);
      await shop.connect(buyer).buy(seedId, 3n, { value: ethers.parseEther("0.3") });
      const tokenAddr = await shop.seedToken(seedId);
      const token = await ethers.getContractAt("SeedToken", tokenAddr);
      expect(await token.balanceOf(buyer.address)).to.equal(3);
    });

    it("reverts when wrong ETH amount sent", async function () {
      const { shop, buyer, seedId } = await loadFixture(shopWithSeedFixture);
      await expect(
        shop.connect(buyer).buy(seedId, 3n, { value: ethers.parseEther("0.2") }),
      ).to.be.revertedWithCustomError(shop, "WrongETHAmount");
    });

    it("reverts when quantity is zero", async function () {
      const { shop, buyer, seedId } = await loadFixture(shopWithSeedFixture);
      await expect(shop.connect(buyer).buy(seedId, 0n, { value: 0n })).to.be.revertedWithCustomError(
        shop,
        "QuantityMustBePositive",
      );
    });

    it("reverts when seed not found", async function () {
      const { shop, buyer } = await loadFixture(deployFixture);
      await expect(shop.connect(buyer).buy(99n, 1n, { value: ethers.parseEther("0.1") })).to.be.revertedWithCustomError(
        shop,
        "SeedNotFound",
      );
    });

    it("emits SeedPurchased event", async function () {
      const { shop, buyer, seedId } = await loadFixture(shopWithSeedFixture);
      await expect(shop.connect(buyer).buy(seedId, 2n, { value: ethers.parseEther("0.2") }))
        .to.emit(shop, "SeedPurchased")
        .withArgs(seedId, buyer.address, 2n, ethers.parseEther("0.2"));
    });
  });

  // ---- withdraw() ----

  describe("withdraw", function () {
    it("allows owner to withdraw ETH proceeds", async function () {
      const { shop, owner, buyer, seedId } = await loadFixture(shopWithSeedFixture);
      await shop.connect(buyer).buy(seedId, 1n, { value: ethers.parseEther("0.1") });

      const before = await ethers.provider.getBalance(owner.address);
      const tx = await shop.connect(owner).withdraw();
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);

      expect(after - before + gas).to.equal(ethers.parseEther("0.1"));
    });

    it("reverts when no ETH to withdraw", async function () {
      const { shop, owner } = await loadFixture(deployFixture);
      await expect(shop.connect(owner).withdraw()).to.be.revertedWithCustomError(shop, "NothingToWithdraw");
    });

    it("reverts when called by non-owner", async function () {
      const { shop, other } = await loadFixture(deployFixture);
      await expect(shop.connect(other).withdraw()).to.be.revertedWithCustomError(shop, "OnlyOwner");
    });
  });

  // ---- view functions ----

  describe("seedToken / seedPrice", function () {
    it("returns correct token address and price", async function () {
      const { shop, owner } = await loadFixture(deployFixture);
      await shop.connect(owner).addSeed("Tomato Seed", "TOMATO", ethers.parseEther("0.1"));
      expect(await shop.seedToken(0)).to.not.equal(ethers.ZeroAddress);
      expect(await shop.seedPrice(0)).to.equal(ethers.parseEther("0.1"));
    });

    it("reverts on unknown seedId", async function () {
      const { shop } = await loadFixture(deployFixture);
      await expect(shop.seedToken(99)).to.be.revertedWithCustomError(shop, "SeedNotFound");
      await expect(shop.seedPrice(99)).to.be.revertedWithCustomError(shop, "SeedNotFound");
    });
  });
});
