import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const deployDishMarket: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const chefDeployment = await hre.deployments.get("Chef");
  const farmManagerDeployment = await hre.deployments.get("FarmManager");

  const deployResult = await deploy("DishMarket", {
    from: deployer,
    args: [deployer, chefDeployment.address, farmManagerDeployment.address],
    log: true,
    autoMine: true,
    skipIfAlreadyDeployed: true,
  });

  if (!deployResult.newlyDeployed) return;

  // Wire up revenue forwarding: LandAuction, SeedShop, FarmManager → DishMarket
  const landAuction = await hre.ethers.getContract("LandAuction", deployer);
  const seedShop = await hre.ethers.getContract("SeedShop", deployer);
  const farmManager = await hre.ethers.getContract("FarmManager", deployer);

  await (await landAuction.setDishMarket(deployResult.address, { gasLimit: 100_000 })).wait();
  console.log("🔗 LandAuction → DishMarket revenue forwarding enabled");

  await (await seedShop.setDishMarket(deployResult.address, { gasLimit: 100_000 })).wait();
  console.log("🔗 SeedShop → DishMarket revenue forwarding enabled");

  await (await farmManager.setDishMarket(deployResult.address, { gasLimit: 100_000 })).wait();
  console.log("🔗 FarmManager → DishMarket revenue forwarding enabled");

  // Seed the market treasury with a small amount for initial liquidity
  if (hre.network.name === "localhost" || hre.network.name === "hardhat") {
    const signer = await hre.ethers.getSigner(deployer);
    const tx = await signer.sendTransaction({
      to: deployResult.address,
      value: hre.ethers.parseEther("0.1"),
      gasLimit: 100_000,
    });
    await tx.wait();
    console.log("💰 DishMarket seeded with 0.1 ETH (land/seed sales will fund the rest)");
  }
};

export default deployDishMarket;

deployDishMarket.tags = ["DishMarket"];
deployDishMarket.dependencies = ["Chef", "FarmManager"];
