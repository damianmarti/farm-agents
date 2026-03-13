import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const deploySeedShop: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const deployResult = await deploy("SeedShop", {
    from: deployer,
    args: [deployer],
    log: true,
    autoMine: true,
    skipIfAlreadyDeployed: true,
  });

  if (deployResult.newlyDeployed) {
    const seedShop = await hre.ethers.getContract("SeedShop", deployer);

    const catalog = [
      // Vegetables
      { name: "Tomato Seed", symbol: "TOMATO", ethPrice: "0.00001" },
      { name: "Lettuce Seed", symbol: "LETTUCE", ethPrice: "0.000005" },
      { name: "Carrot Seed", symbol: "CARROT", ethPrice: "0.000008" },
      { name: "Potato Seed", symbol: "POTATO", ethPrice: "0.000006" },
      { name: "Onion Seed", symbol: "ONION", ethPrice: "0.000004" },
      { name: "Pepper Seed", symbol: "PEPPER", ethPrice: "0.00001" },
      { name: "Cucumber Seed", symbol: "CUCUMBER", ethPrice: "0.000007" },
      { name: "Spinach Seed", symbol: "SPINACH", ethPrice: "0.000005" },
      { name: "Pumpkin Seed", symbol: "PUMPKIN", ethPrice: "0.000012" },
      { name: "Broccoli Seed", symbol: "BROCOLI", ethPrice: "0.000009" },
      // Fruits
      { name: "Strawberry Seed", symbol: "STRAW", ethPrice: "0.00002" },
      { name: "Watermelon Seed", symbol: "WMELON", ethPrice: "0.00003" },
      { name: "Blueberry Seed", symbol: "BLUEB", ethPrice: "0.000025" },
      { name: "Mango Seed", symbol: "MANGO", ethPrice: "0.000035" },
      { name: "Pineapple Seed", symbol: "PINEAP", ethPrice: "0.00004" },
      { name: "Lemon Seed", symbol: "LEMON", ethPrice: "0.000015" },
      { name: "Grape Seed", symbol: "GRAPE", ethPrice: "0.00002" },
      { name: "Peach Seed", symbol: "PEACH", ethPrice: "0.000018" },
      { name: "Cherry Seed", symbol: "CHERRY", ethPrice: "0.00003" },
      { name: "Melon Seed", symbol: "MELON", ethPrice: "0.000022" },
    ];

    for (const seed of catalog) {
      const tx = await seedShop.addSeed(seed.name, seed.symbol, hre.ethers.parseEther(seed.ethPrice));
      await tx.wait();
      console.log(`🌱 Added seed: ${seed.name} (${seed.symbol}) at ${seed.ethPrice} ETH`);
    }
  }
};

export default deploySeedShop;

deploySeedShop.tags = ["SeedShop"];
