import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const MIN = 60;

/**
 * Farm configs for all 20 seed types.
 * Times are in minutes (for fast local/testnet iteration).
 * Scale up to hours/days for production by replacing MIN with HOUR/DAY.
 *
 * Fields:
 *   maxCapacity    — max seeds per land planting
 *   waterInterval  — seconds between required waterings
 *   maturationTime — seconds from planting to harvest-ready
 *   rotTime        — seconds after maturation before the plot rots
 *   cleanupCost    — ETH price (as string) to clean up this plot
 *   harvestYield   — fruit tokens minted per seed planted
 *   fruitName      — ERC20 name for the harvested produce
 *   fruitSymbol    — ERC20 symbol for the harvested produce
 */
const FARM_CONFIGS = [
  // ── Vegetables ──────────────────────────────────────────────────────────────
  // 0: Tomato        water=1m  mature=3m  rot=1m
  {
    maxCapacity: 20,
    waterInterval: 1 * MIN,
    maturationTime: 3 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000002",
    harvestYield: 3,
    fruitName: "Tomato",
    fruitSymbol: "TOM",
  },
  // 1: Lettuce       water=1m  mature=2m  rot=1m
  {
    maxCapacity: 30,
    waterInterval: 1 * MIN,
    maturationTime: 2 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000001",
    harvestYield: 2,
    fruitName: "Lettuce",
    fruitSymbol: "LET",
  },
  // 2: Carrot        water=1m  mature=4m  rot=1m
  {
    maxCapacity: 25,
    waterInterval: 1 * MIN,
    maturationTime: 4 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000002",
    harvestYield: 2,
    fruitName: "Carrot",
    fruitSymbol: "CAR",
  },
  // 3: Potato        water=2m  mature=5m  rot=2m
  {
    maxCapacity: 20,
    waterInterval: 2 * MIN,
    maturationTime: 5 * MIN,
    rotTime: 2 * MIN,
    cleanupCost: "0.000003",
    harvestYield: 4,
    fruitName: "Potato",
    fruitSymbol: "POT",
  },
  // 4: Onion         water=2m  mature=6m  rot=2m
  {
    maxCapacity: 30,
    waterInterval: 2 * MIN,
    maturationTime: 6 * MIN,
    rotTime: 2 * MIN,
    cleanupCost: "0.000002",
    harvestYield: 2,
    fruitName: "Onion",
    fruitSymbol: "ONI",
  },
  // 5: Pepper        water=1m  mature=4m  rot=1m
  {
    maxCapacity: 15,
    waterInterval: 1 * MIN,
    maturationTime: 4 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000002",
    harvestYield: 3,
    fruitName: "Pepper",
    fruitSymbol: "PEP",
  },
  // 6: Cucumber      water=1m  mature=3m  rot=1m
  {
    maxCapacity: 20,
    waterInterval: 1 * MIN,
    maturationTime: 3 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000002",
    harvestYield: 3,
    fruitName: "Cucumber",
    fruitSymbol: "CUC",
  },
  // 7: Spinach       water=1m  mature=2m  rot=1m
  {
    maxCapacity: 40,
    waterInterval: 1 * MIN,
    maturationTime: 2 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000001",
    harvestYield: 2,
    fruitName: "Spinach",
    fruitSymbol: "SPI",
  },
  // 8: Pumpkin       water=2m  mature=7m  rot=3m
  {
    maxCapacity: 10,
    waterInterval: 2 * MIN,
    maturationTime: 7 * MIN,
    rotTime: 3 * MIN,
    cleanupCost: "0.000005",
    harvestYield: 5,
    fruitName: "Pumpkin",
    fruitSymbol: "PUMP",
  },
  // 9: Broccoli      water=1m  mature=3m  rot=1m
  {
    maxCapacity: 20,
    waterInterval: 1 * MIN,
    maturationTime: 3 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000002",
    harvestYield: 2,
    fruitName: "Broccoli",
    fruitSymbol: "BROC",
  },
  // ── Fruits ──────────────────────────────────────────────────────────────────
  // 10: Strawberry   water=1m  mature=4m  rot=1m
  {
    maxCapacity: 15,
    waterInterval: 1 * MIN,
    maturationTime: 4 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000003",
    harvestYield: 4,
    fruitName: "Strawberry",
    fruitSymbol: "SBERRY",
  },
  // 11: Watermelon   water=2m  mature=7m  rot=2m
  {
    maxCapacity: 5,
    waterInterval: 2 * MIN,
    maturationTime: 7 * MIN,
    rotTime: 2 * MIN,
    cleanupCost: "0.000005",
    harvestYield: 5,
    fruitName: "Watermelon",
    fruitSymbol: "WFRUIT",
  },
  // 12: Blueberry    water=2m  mature=5m  rot=1m
  {
    maxCapacity: 20,
    waterInterval: 2 * MIN,
    maturationTime: 5 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000003",
    harvestYield: 3,
    fruitName: "Blueberry",
    fruitSymbol: "BBFRT",
  },
  // 13: Mango        water=2m  mature=6m  rot=2m
  {
    maxCapacity: 10,
    waterInterval: 2 * MIN,
    maturationTime: 6 * MIN,
    rotTime: 2 * MIN,
    cleanupCost: "0.000004",
    harvestYield: 4,
    fruitName: "Mango",
    fruitSymbol: "MNGO",
  },
  // 14: Pineapple    water=2m  mature=7m  rot=3m
  {
    maxCapacity: 5,
    waterInterval: 2 * MIN,
    maturationTime: 7 * MIN,
    rotTime: 3 * MIN,
    cleanupCost: "0.000006",
    harvestYield: 6,
    fruitName: "Pineapple",
    fruitSymbol: "PINE",
  },
  // 15: Lemon        water=1m  mature=4m  rot=1m
  {
    maxCapacity: 15,
    waterInterval: 1 * MIN,
    maturationTime: 4 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000003",
    harvestYield: 3,
    fruitName: "Lemon",
    fruitSymbol: "LMN",
  },
  // 16: Grape        water=2m  mature=5m  rot=2m
  {
    maxCapacity: 20,
    waterInterval: 2 * MIN,
    maturationTime: 5 * MIN,
    rotTime: 2 * MIN,
    cleanupCost: "0.000003",
    harvestYield: 4,
    fruitName: "Grape",
    fruitSymbol: "GRP",
  },
  // 17: Peach        water=2m  mature=6m  rot=2m
  {
    maxCapacity: 10,
    waterInterval: 2 * MIN,
    maturationTime: 6 * MIN,
    rotTime: 2 * MIN,
    cleanupCost: "0.000004",
    harvestYield: 4,
    fruitName: "Peach",
    fruitSymbol: "PCHFRT",
  },
  // 18: Cherry       water=2m  mature=5m  rot=1m
  {
    maxCapacity: 15,
    waterInterval: 2 * MIN,
    maturationTime: 5 * MIN,
    rotTime: 1 * MIN,
    cleanupCost: "0.000004",
    harvestYield: 5,
    fruitName: "Cherry",
    fruitSymbol: "CHRRY",
  },
  // 19: Melon        water=2m  mature=6m  rot=2m
  {
    maxCapacity: 8,
    waterInterval: 2 * MIN,
    maturationTime: 6 * MIN,
    rotTime: 2 * MIN,
    cleanupCost: "0.000004",
    harvestYield: 4,
    fruitName: "Melon",
    fruitSymbol: "MLON",
  },
];

const deployFarmManager: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const landAuction = await hre.deployments.get("LandAuction");
  const seedShop = await hre.deployments.get("SeedShop");

  const deployResult = await deploy("FarmManager", {
    from: deployer,
    args: [deployer, landAuction.address, seedShop.address],
    log: true,
    autoMine: true,
    skipIfAlreadyDeployed: true,
  });

  if (deployResult.newlyDeployed) {
    const farmManager = await hre.ethers.getContract("FarmManager", deployer);

    for (let seedId = 0; seedId < FARM_CONFIGS.length; seedId++) {
      const c = FARM_CONFIGS[seedId];
      const tx = await farmManager.addFarmConfig(
        seedId,
        c.maxCapacity,
        c.waterInterval,
        c.maturationTime,
        c.rotTime,
        hre.ethers.parseEther(c.cleanupCost),
        c.harvestYield,
        c.fruitName,
        c.fruitSymbol,
        { gasLimit: 3_000_000 },
      );
      await tx.wait();
      console.log(`🌾 Config added: seedId=${seedId} ${c.fruitName} (${c.fruitSymbol})`);
    }
  }
};

export default deployFarmManager;

deployFarmManager.tags = ["FarmManager"];
deployFarmManager.dependencies = ["LandAuction", "SeedShop"];
