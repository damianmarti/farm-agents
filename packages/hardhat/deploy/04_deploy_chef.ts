import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const MIN = 60;

// FruitToken seedId index (matches 02_deploy_seed_shop.ts catalog order)
const TOMATO = 0;
const LETTUCE = 1;
const CARROT = 2;
const POTATO = 3;
const ONION = 4;
const PEPPER = 5;
const CUCUMBER = 6;
const SPINACH = 7;
const PUMPKIN = 8;
// BROCCOLI = 9: token exists but no recipe designed yet
const STRAWBERRY = 10;
const WATERMELON = 11;
const BLUEBERRY = 12;
const MANGO = 13;
const PINEAPPLE = 14;
const LEMON = 15;
const GRAPE = 16;
// PEACH = 17: token exists but no recipe designed yet
const CHERRY = 18;
// MELON = 19: token exists but no recipe designed yet

const deployChef: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const deployResult = await deploy("Chef", {
    from: deployer,
    args: [deployer],
    log: true,
    autoMine: true,
    skipIfAlreadyDeployed: true,
  });

  // skipIfAlreadyDeployed handles re-runs; nothing else to do if not newly deployed
  if (!deployResult.newlyDeployed) return;

  const chef = await hre.ethers.getContract("Chef", deployer);
  const farmManager = await hre.ethers.getContract("FarmManager", deployer);

  // Fetch all fruit token addresses from FarmManager
  const ft = async (seedId: number): Promise<string> => farmManager.fruitToken(seedId);

  const recipes = [
    {
      name: "Tomato Soup",
      ingredients: [
        { seedId: TOMATO, amount: 3 },
        { seedId: ONION, amount: 1 },
      ],
      prepTime: 3 * MIN,
      dishAmount: 1,
      dishName: "Tomato Soup",
      dishSymbol: "TSOUP",
    },
    {
      name: "Green Salad",
      ingredients: [
        { seedId: LETTUCE, amount: 2 },
        { seedId: CUCUMBER, amount: 1 },
        { seedId: SPINACH, amount: 1 },
      ],
      prepTime: 2 * MIN,
      dishAmount: 1,
      dishName: "Green Salad",
      dishSymbol: "GSALAD",
    },
    {
      name: "Lemonade",
      ingredients: [{ seedId: LEMON, amount: 3 }],
      prepTime: 1 * MIN,
      dishAmount: 1,
      dishName: "Lemonade",
      dishSymbol: "LMNADE",
    },
    {
      name: "Carrot Cake",
      ingredients: [
        { seedId: CARROT, amount: 3 },
        { seedId: LEMON, amount: 2 },
      ],
      prepTime: 5 * MIN,
      dishAmount: 1,
      dishName: "Carrot Cake",
      dishSymbol: "CCAKE",
    },
    {
      name: "Pumpkin Pie",
      ingredients: [
        { seedId: PUMPKIN, amount: 2 },
        { seedId: POTATO, amount: 1 },
      ],
      prepTime: 7 * MIN,
      dishAmount: 1,
      dishName: "Pumpkin Pie",
      dishSymbol: "PPIE",
    },
    {
      name: "Mango Juice",
      ingredients: [{ seedId: MANGO, amount: 3 }],
      prepTime: 2 * MIN,
      dishAmount: 1,
      dishName: "Mango Juice",
      dishSymbol: "MJUICE",
    },
    {
      name: "Watermelon Smoothie",
      ingredients: [
        { seedId: WATERMELON, amount: 2 },
        { seedId: LEMON, amount: 1 },
      ],
      prepTime: 2 * MIN,
      dishAmount: 1,
      dishName: "Watermelon Smoothie",
      dishSymbol: "WSMTH",
    },
    {
      name: "Fruit Salad",
      ingredients: [
        { seedId: STRAWBERRY, amount: 2 },
        { seedId: BLUEBERRY, amount: 2 },
        { seedId: GRAPE, amount: 2 },
      ],
      prepTime: 3 * MIN,
      dishAmount: 1,
      dishName: "Fruit Salad",
      dishSymbol: "FSALAD",
    },
    {
      name: "Pineapple Sorbet",
      ingredients: [
        { seedId: PINEAPPLE, amount: 2 },
        { seedId: CHERRY, amount: 2 },
      ],
      prepTime: 4 * MIN,
      dishAmount: 1,
      dishName: "Pineapple Sorbet",
      dishSymbol: "PSORBET",
    },
    {
      name: "Mixed Pickle",
      ingredients: [
        { seedId: CARROT, amount: 2 },
        { seedId: CUCUMBER, amount: 2 },
        { seedId: ONION, amount: 1 },
        { seedId: PEPPER, amount: 1 },
      ],
      prepTime: 4 * MIN,
      dishAmount: 1,
      dishName: "Mixed Pickle",
      dishSymbol: "PICKLE",
    },
  ];

  for (const recipe of recipes) {
    const tokens = await Promise.all(recipe.ingredients.map(i => ft(i.seedId)));
    const amounts = recipe.ingredients.map(i => i.amount);

    try {
      const tx = await chef.addRecipe(
        recipe.name,
        tokens,
        amounts,
        recipe.prepTime,
        recipe.dishAmount,
        recipe.dishName,
        recipe.dishSymbol,
      );
      await tx.wait();
      console.log(`🍳 Recipe added: ${recipe.name}`);
    } catch (err) {
      console.error(`Failed to add recipe "${recipe.name}":`, err);
      throw err;
    }
  }
};

export default deployChef;

deployChef.tags = ["Chef"];
deployChef.dependencies = ["FarmManager"];
