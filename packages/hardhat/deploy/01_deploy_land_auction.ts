import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const deployLandAuction: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  await deploy("LandAuction", {
    from: deployer,
    args: [deployer],
    log: true,
    autoMine: true,
  });
};

export default deployLandAuction;

deployLandAuction.tags = ["LandAuction"];
