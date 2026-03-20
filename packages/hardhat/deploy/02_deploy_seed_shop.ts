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
      { name: "Tomato Seed", symbol: "TOMATO", ethPrice: "0.00005" },
      { name: "Lettuce Seed", symbol: "LETTUCE", ethPrice: "0.000025" },
      { name: "Carrot Seed", symbol: "CARROT", ethPrice: "0.00004" },
      { name: "Potato Seed", symbol: "POTATO", ethPrice: "0.00003" },
      { name: "Onion Seed", symbol: "ONION", ethPrice: "0.00002" },
      { name: "Pepper Seed", symbol: "PEPPER", ethPrice: "0.00005" },
      { name: "Cucumber Seed", symbol: "CUCUMBER", ethPrice: "0.000035" },
      { name: "Spinach Seed", symbol: "SPINACH", ethPrice: "0.000025" },
      { name: "Pumpkin Seed", symbol: "PUMPKIN", ethPrice: "0.00006" },
      { name: "Broccoli Seed", symbol: "BROCOLI", ethPrice: "0.000045" },
      // Fruits
      { name: "Strawberry Seed", symbol: "STRAW", ethPrice: "0.0001" },
      { name: "Watermelon Seed", symbol: "WMELON", ethPrice: "0.00015" },
      { name: "Blueberry Seed", symbol: "BLUEB", ethPrice: "0.000125" },
      { name: "Mango Seed", symbol: "MANGO", ethPrice: "0.000175" },
      { name: "Pineapple Seed", symbol: "PINEAP", ethPrice: "0.0002" },
      { name: "Lemon Seed", symbol: "LEMON", ethPrice: "0.000075" },
      { name: "Grape Seed", symbol: "GRAPE", ethPrice: "0.0001" },
      { name: "Peach Seed", symbol: "PEACH", ethPrice: "0.00009" },
      { name: "Cherry Seed", symbol: "CHERRY", ethPrice: "0.00015" },
      { name: "Melon Seed", symbol: "MELON", ethPrice: "0.00011" },
    ];

    for (const seed of catalog) {
      const tx = await seedShop.addSeed(seed.name, seed.symbol, hre.ethers.parseEther(seed.ethPrice), {
        gasLimit: 3_000_000,
      });
      await tx.wait();
      console.log(`🌱 Added seed: ${seed.name} (${seed.symbol}) at ${seed.ethPrice} ETH`);
    }
  }
};

export default deploySeedShop;

deploySeedShop.tags = ["SeedShop"];
