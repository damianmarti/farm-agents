// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { LandAuction } from "./LandAuction.sol";
import { SeedShop } from "./SeedShop.sol";
import { SeedToken } from "./SeedToken.sol";
import { FruitToken } from "./FruitToken.sol";

/**
 * @title FarmManager
 * @notice Core farming contract: plant seeds, harvest, and clean up land.
 *
 * @dev State machine per land:
 *
 *   Empty ──plant()──► Growing ──(maturationTime)──► Mature ──harvest()──► NeedsCleanup
 *                                                       │                       │
 *                                                  time passes            cleanUp()
 *                                                       │                       │
 *                                                       ▼                       ▼
 *                                                     Rotten                  Empty
 *                                                       │
 *                                                  cleanUp()
 *                                                       │
 *                                                       ▼
 *                                                     Empty
 *
 *   - Growing/Mature/Rotten are COMPUTED from timestamps (not stored).
 *   - cleanUp() is only allowed from Rotten or NeedsCleanup states.
 *   - Cleanup fees are forwarded to the DishMarket treasury.
 *   - Only the land owner can plant, harvest, and clean up.
 */
contract FarmManager is ReentrancyGuard {
    address public immutable owner;
    LandAuction public immutable landAuction;
    SeedShop public immutable seedShop;
    address public dishMarket;

    // ---- Enums ----

    enum LandState {
        Empty,        // nothing planted, ready to plant
        Growing,      // planted, not yet mature
        Mature,       // ready to harvest
        Rotten,       // harvest window expired
        NeedsCleanup  // successfully harvested, waiting for cleanup
    }

    // ---- Structs ----

    struct FarmConfig {
        uint256 maxCapacity;    // max seeds plantable per land
        uint256 maturationTime; // seconds from planting to harvest-ready
        uint256 rotTime;        // seconds after maturation before rotting
        uint256 cleanupCost;    // ETH (wei) to clean up this plot
        uint256 harvestYield;   // fruit tokens minted per seed planted
        FruitToken fruitToken;  // ERC20 issued on harvest
        bool configured;
    }

    struct LandPlot {
        uint256 seedId;
        uint256 seedAmount;
        uint256 plantedAt;
        bool hasPlanting;   // true while Growing / Mature / Rotten (pre-harvest)
        bool needsCleanup;  // true after a successful harvest
    }

    // ---- Storage ----

    mapping(uint256 => FarmConfig) public farmConfigs; // seedId => config
    mapping(uint256 => LandPlot) public plots;          // landId => plot

    // Reverse lookup: fruitToken address → seedId (populated in addFarmConfig)
    mapping(address => bool) public isFruitToken;
    mapping(address => uint256) public fruitToSeedId;

    // ---- Custom errors ----

    error OnlyOwner();
    error ZeroAddress();
    error NotLandOwner();
    error SeedNotConfigured();
    error ConfigAlreadyExists();
    error InvalidFarmConfig();
    error LandNotEmpty();
    error InvalidSeedAmount();
    error NotReadyToHarvest();
    error NothingToCleanUp();
    error WrongCleanupPayment();
    error TransferFailed();
    error NothingToWithdraw();

    // ---- Events ----

    event FarmConfigAdded(
        uint256 indexed seedId,
        address indexed fruitToken,
        uint256 maxCapacity,
        uint256 maturationTime,
        uint256 rotTime,
        uint256 cleanupCost,
        uint256 harvestYield
    );
    event SeedsPlanted(uint256 indexed landId, uint256 indexed seedId, uint256 amount, address indexed planter);
    event LandHarvested(uint256 indexed landId, address indexed harvester, uint256 fruitAmount);
    event LandCleaned(uint256 indexed landId, address indexed cleaner, uint256 cost);
    event Withdrawal(address indexed to, uint256 amount);

    // ---- Constructor ----

    constructor(address _owner, address _landAuction, address _seedShop) {
        if (_owner == address(0) || _landAuction == address(0) || _seedShop == address(0)) revert ZeroAddress();
        owner = _owner;
        landAuction = LandAuction(_landAuction);
        seedShop = SeedShop(_seedShop);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function setDishMarket(address _dishMarket) external onlyOwner {
        dishMarket = _dishMarket;
    }

    // ---- Admin ----

    /**
     * @notice Register farming parameters for a seed type and deploy its FruitToken.
     * @param seedId         ID from SeedShop
     * @param maxCapacity    Max seeds plantable per land in a single planting
     * @param maturationTime Seconds from planting until harvest-ready
     * @param rotTime        Seconds after maturation before the harvest window closes
     * @param cleanupCost    ETH (wei) to clean up a used plot of this seed type (can be 0)
     * @param harvestYield   Fruit tokens minted per seed planted
     * @param fruitName      ERC20 name for the harvested produce (e.g. "Tomato")
     * @param fruitSymbol    ERC20 symbol for the harvested produce (e.g. "TOM")
     */
    function addFarmConfig(
        uint256 seedId,
        uint256 maxCapacity,
        uint256 maturationTime,
        uint256 rotTime,
        uint256 cleanupCost,
        uint256 harvestYield,
        string calldata fruitName,
        string calldata fruitSymbol
    ) external onlyOwner {
        if (farmConfigs[seedId].configured) revert ConfigAlreadyExists();
        if (maxCapacity == 0 || maturationTime == 0 || rotTime == 0 || harvestYield == 0)
            revert InvalidFarmConfig();

        FruitToken fruit = new FruitToken(fruitName, fruitSymbol, address(this));
        isFruitToken[address(fruit)] = true;
        fruitToSeedId[address(fruit)] = seedId;
        farmConfigs[seedId] = FarmConfig({
            maxCapacity: maxCapacity,
            maturationTime: maturationTime,
            rotTime: rotTime,
            cleanupCost: cleanupCost,
            harvestYield: harvestYield,
            fruitToken: fruit,
            configured: true
        });

        emit FarmConfigAdded(seedId, address(fruit), maxCapacity, maturationTime, rotTime, cleanupCost, harvestYield);
    }

    // ---- View ----

    /**
     * @notice Compute the current state of a land plot.
     * @dev Growing/Mature/Rotten are derived from timestamps — no state writes needed.
     */
    function getLandState(uint256 landId) public view returns (LandState) {
        LandPlot storage plot = plots[landId];

        if (!plot.hasPlanting && !plot.needsCleanup) return LandState.Empty;
        if (plot.needsCleanup) return LandState.NeedsCleanup;

        FarmConfig storage config = farmConfigs[plot.seedId];
        uint256 age = block.timestamp - plot.plantedAt;
        if (age < config.maturationTime) return LandState.Growing;
        if (age < config.maturationTime + config.rotTime) return LandState.Mature;
        return LandState.Rotten;
    }

    /// @notice Returns the FruitToken address for a given seed type.
    function fruitToken(uint256 seedId) external view returns (address) {
        if (!farmConfigs[seedId].configured) revert SeedNotConfigured();
        return address(farmConfigs[seedId].fruitToken);
    }

    /// @notice Returns the number of fruit tokens minted per seed planted for a seed type.
    function harvestYield(uint256 seedId) external view returns (uint256) {
        if (!farmConfigs[seedId].configured) revert SeedNotConfigured();
        return farmConfigs[seedId].harvestYield;
    }

    // ---- Farming actions ----

    /**
     * @notice Plant seeds on an empty land.
     * @dev Burns `amount` SeedTokens from the caller — requires prior approval.
     *      The land must be in Empty state. Amount must be between 1 and maxCapacity.
     * @param landId  ID of the land (0-99 from LandAuction)
     * @param seedId  ID of the seed type (from SeedShop)
     * @param amount  Number of seeds to plant
     */
    function plant(uint256 landId, uint256 seedId, uint256 amount) external nonReentrant {
        if (landAuction.landOwner(landId) != msg.sender) revert NotLandOwner();
        if (getLandState(landId) != LandState.Empty) revert LandNotEmpty();

        FarmConfig storage config = farmConfigs[seedId];
        if (!config.configured) revert SeedNotConfigured();
        if (amount == 0 || amount > config.maxCapacity) revert InvalidSeedAmount();

        // Burn seeds from planter (requires prior approve(farmManager, amount))
        SeedToken seedTkn = SeedToken(seedShop.seedToken(seedId));
        seedTkn.burnFrom(msg.sender, amount);

        plots[landId] = LandPlot({
            seedId: seedId,
            seedAmount: amount,
            plantedAt: block.timestamp,
            hasPlanting: true,
            needsCleanup: false
        });

        emit SeedsPlanted(landId, seedId, amount, msg.sender);
    }

    /**
     * @notice Harvest mature crops. Mints FruitTokens to the land owner.
     * @dev Land must be in Mature state. Only the land owner can harvest.
     *      After harvesting, the land enters NeedsCleanup state.
     */
    function harvest(uint256 landId) external nonReentrant {
        if (landAuction.landOwner(landId) != msg.sender) revert NotLandOwner();
        if (getLandState(landId) != LandState.Mature) revert NotReadyToHarvest();

        LandPlot storage plot = plots[landId];
        FarmConfig storage config = farmConfigs[plot.seedId];

        uint256 fruitAmount = plot.seedAmount * config.harvestYield;

        // Transition to NeedsCleanup (effects before interaction)
        plot.hasPlanting = false;
        plot.needsCleanup = true;

        config.fruitToken.mint(msg.sender, fruitAmount);

        emit LandHarvested(landId, msg.sender, fruitAmount);
    }

    /**
     * @notice Clean up a Rotten or post-harvest plot so it can be planted again.
     * @dev Only allowed from Rotten or NeedsCleanup states — active crops cannot be removed.
     *      Send exactly `cleanupCost` ETH. Fees are forwarded to the DishMarket treasury.
     *      Only the land owner can clean up.
     * @param landId ID of the land to clean
     */
    function cleanUp(uint256 landId) external payable nonReentrant {
        if (landAuction.landOwner(landId) != msg.sender) revert NotLandOwner();

        LandState state = getLandState(landId);
        if (state != LandState.Rotten && state != LandState.NeedsCleanup) revert NothingToCleanUp();

        uint256 cost = farmConfigs[plots[landId].seedId].cleanupCost;
        if (msg.value != cost) revert WrongCleanupPayment();

        delete plots[landId];

        // Forward cleanup fee to DishMarket treasury
        if (dishMarket != address(0) && msg.value > 0) {
            (bool success, ) = dishMarket.call{ value: msg.value }("");
            if (!success) revert TransferFailed();
        }

        emit LandCleaned(landId, msg.sender, cost);
    }

    // ---- Owner ----

    /**
     * @notice Withdraw accumulated fees to the owner.
     */
    function withdrawFees() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToWithdraw();
        (bool success, ) = owner.call{ value: amount }("");
        if (!success) revert TransferFailed();
        emit Withdrawal(owner, amount);
    }
}
