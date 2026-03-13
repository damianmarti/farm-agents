import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const MIN = 60;

describe("Chef", function () {
  async function deployFixture() {
    const [owner, cook, other] = await ethers.getSigners();

    // Deploy a FruitToken to use as ingredient (minter=owner for test minting)
    const FruitToken = await ethers.getContractFactory("FruitToken");
    const tomato = await FruitToken.deploy("Tomato", "TOM", owner.address);
    const lemon = await FruitToken.deploy("Lemon", "LEM", owner.address);

    const Chef = await ethers.getContractFactory("Chef");
    const chef = await Chef.deploy(owner.address);
    const chefAddr = await chef.getAddress();

    // Add recipe: Tomato Soup = 3 tomato + 1 lemon, prepTime=3min, dishAmount=1
    await chef
      .connect(owner)
      .addRecipe(
        "Tomato Soup",
        [await tomato.getAddress(), await lemon.getAddress()],
        [3, 1],
        3 * MIN,
        1,
        "Tomato Soup",
        "TSOUP",
      );

    // Mint ingredients for cook and approve Chef
    await tomato.connect(owner).mint(cook.address, 10);
    await lemon.connect(owner).mint(cook.address, 5);
    await tomato.connect(cook).approve(chefAddr, 10);
    await lemon.connect(cook).approve(chefAddr, 5);

    return { chef, chefAddr, tomato, lemon, owner, cook, other, recipeId: 0 };
  }

  // ---- addRecipe() ----

  describe("addRecipe", function () {
    it("increments recipeCount and deploys DishToken", async function () {
      const { chef } = await loadFixture(deployFixture);
      expect(await chef.recipeCount()).to.equal(1);
      const [name, , , dishToken] = await chef.getRecipe(0);
      expect(name).to.equal("Tomato Soup");
      expect(dishToken).to.not.equal(ethers.ZeroAddress);
    });

    it("DishToken has correct name, symbol, and 0 decimals", async function () {
      const { chef } = await loadFixture(deployFixture);
      const [, , , dishTokenAddr] = await chef.getRecipe(0);
      const dishToken = await ethers.getContractAt("DishToken", dishTokenAddr);
      expect(await dishToken.name()).to.equal("Tomato Soup");
      expect(await dishToken.symbol()).to.equal("TSOUP");
      expect(await dishToken.decimals()).to.equal(0);
    });

    it("stores ingredients correctly", async function () {
      const { chef, tomato, lemon } = await loadFixture(deployFixture);
      const ingredients = await chef.getIngredients(0);
      expect(ingredients.length).to.equal(2);
      expect(ingredients[0].token).to.equal(await tomato.getAddress());
      expect(ingredients[0].amount).to.equal(3);
      expect(ingredients[1].token).to.equal(await lemon.getAddress());
      expect(ingredients[1].amount).to.equal(1);
    });

    it("reverts when called by non-owner", async function () {
      const { chef, other, tomato } = await loadFixture(deployFixture);
      await expect(
        chef.connect(other).addRecipe("X", [await tomato.getAddress()], [1], MIN, 1, "X", "X"),
      ).to.be.revertedWithCustomError(chef, "OnlyOwner");
    });

    it("reverts with empty ingredients", async function () {
      const { chef, owner } = await loadFixture(deployFixture);
      await expect(chef.connect(owner).addRecipe("X", [], [], MIN, 1, "X", "X")).to.be.revertedWithCustomError(
        chef,
        "InvalidRecipeConfig",
      );
    });

    it("reverts when prepTime is zero", async function () {
      const { chef, owner, tomato } = await loadFixture(deployFixture);
      await expect(
        chef.connect(owner).addRecipe("X", [await tomato.getAddress()], [1], 0, 1, "X", "X"),
      ).to.be.revertedWithCustomError(chef, "InvalidRecipeConfig");
    });

    it("reverts when dishAmount is zero", async function () {
      const { chef, owner, tomato } = await loadFixture(deployFixture);
      await expect(
        chef.connect(owner).addRecipe("X", [await tomato.getAddress()], [1], MIN, 0, "X", "X"),
      ).to.be.revertedWithCustomError(chef, "InvalidRecipeConfig");
    });
  });

  // ---- startCooking() ----

  describe("startCooking", function () {
    it("burns ingredients from cook and records session", async function () {
      const { chef, cook, tomato, lemon, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      // 3 tomato + 1 lemon burned
      expect(await tomato.balanceOf(cook.address)).to.equal(7);
      expect(await lemon.balanceOf(cook.address)).to.equal(4);
      expect(await chef.cookingStartTime(cook.address, recipeId)).to.be.gt(0);
    });

    it("reverts when already cooking same recipe", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      await expect(chef.connect(cook).startCooking(recipeId)).to.be.revertedWithCustomError(chef, "AlreadyCooking");
    });

    it("reverts when recipe not found", async function () {
      const { chef, cook } = await loadFixture(deployFixture);
      await expect(chef.connect(cook).startCooking(99)).to.be.revertedWithCustomError(chef, "RecipeNotFound");
    });
  });

  // ---- claim() ----

  describe("claim", function () {
    it("mints DishToken to cook after prepTime", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      await time.increase(3 * MIN + 1);
      await chef.connect(cook).claim(recipeId);

      const [, , , dishTokenAddr] = await chef.getRecipe(recipeId);
      const dishToken = await ethers.getContractAt("DishToken", dishTokenAddr);
      expect(await dishToken.balanceOf(cook.address)).to.equal(1);
    });

    it("clears cooking session after claim", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      await time.increase(3 * MIN + 1);
      await chef.connect(cook).claim(recipeId);
      expect(await chef.cookingStartTime(cook.address, recipeId)).to.equal(0);
    });

    it("reverts when not cooking", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await expect(chef.connect(cook).claim(recipeId)).to.be.revertedWithCustomError(chef, "NotCooking");
    });

    it("reverts when still cooking", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      await time.increase(MIN); // only 1 min, need 3
      await expect(chef.connect(cook).claim(recipeId)).to.be.revertedWithCustomError(chef, "StillCooking");
    });

    it("allows new session after claim", async function () {
      const { chef, cook, tomato, lemon, chefAddr, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      await time.increase(3 * MIN + 1);
      await chef.connect(cook).claim(recipeId);

      // Mint more ingredients
      const [owner] = await ethers.getSigners();
      await tomato.connect(owner).mint(cook.address, 3);
      await lemon.connect(owner).mint(cook.address, 1);
      await tomato.connect(cook).approve(chefAddr, 3);
      await lemon.connect(cook).approve(chefAddr, 1);

      await expect(chef.connect(cook).startCooking(recipeId)).to.not.be.reverted;
    });
  });

  // ---- timeUntilReady() ----

  describe("timeUntilReady", function () {
    it("returns 0 when not cooking", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      expect(await chef.timeUntilReady(cook.address, recipeId)).to.equal(0);
    });

    it("returns remaining time when cooking", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      const remaining = await chef.timeUntilReady(cook.address, recipeId);
      expect(remaining).to.be.gt(0);
      expect(remaining).to.be.lte(3 * MIN);
    });

    it("returns 0 when ready", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      await time.increase(3 * MIN + 1);
      expect(await chef.timeUntilReady(cook.address, recipeId)).to.equal(0);
    });
  });

  // ---- events ----

  describe("events", function () {
    it("emits CookingStarted", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await expect(chef.connect(cook).startCooking(recipeId)).to.emit(chef, "CookingStarted");
    });

    it("emits DishClaimed", async function () {
      const { chef, cook, recipeId } = await loadFixture(deployFixture);
      await chef.connect(cook).startCooking(recipeId);
      await time.increase(3 * MIN + 1);
      await expect(chef.connect(cook).claim(recipeId)).to.emit(chef, "DishClaimed").withArgs(recipeId, cook.address, 1);
    });
  });
});
