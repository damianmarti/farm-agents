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

  // Fund the market treasury so it can pay winners on local/testnet
  if (hre.network.name === "localhost" || hre.network.name === "hardhat") {
    const signer = await hre.ethers.getSigner(deployer);
    const tx = await signer.sendTransaction({
      to: deployResult.address,
      value: hre.ethers.parseEther("1"),
      gasLimit: 100_000,
    });
    await tx.wait();
    console.log("💰 DishMarket funded with 1 ETH");
  }
};

export default deployDishMarket;

deployDishMarket.tags = ["DishMarket"];
deployDishMarket.dependencies = ["Chef", "FarmManager"];
