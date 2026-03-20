// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SeedToken } from "./SeedToken.sol";

/**
 * @title SeedShop
 * @notice Sells fruit and vegetable seeds at fixed ETH prices.
 * @dev The owner registers seed types, each backed by its own ERC20 (decimals=0).
 *      Buyers call buy() with exact ETH; the shop mints the corresponding SeedTokens.
 */
contract SeedShop is ReentrancyGuard {
    address public immutable owner;
    address public dishMarket;

    struct Seed {
        SeedToken token;   // ERC20 contract for this seed type
        uint256 price;     // price per unit in wei
        bool exists;
    }

    // seedId => Seed
    mapping(uint256 => Seed) public seeds;
    uint256 public seedCount;

    // ---- Custom errors ----
    error OnlyOwner();
    error ZeroAddress();
    error SeedNotFound();
    error QuantityMustBePositive();
    error WrongETHAmount();
    error TransferFailed();
    error PriceMustBePositive();
    error NothingToWithdraw();

    // ---- Events ----
    event SeedAdded(uint256 indexed seedId, address indexed token, string name, string symbol, uint256 price);
    event SeedPurchased(uint256 indexed seedId, address indexed buyer, uint256 quantity, uint256 totalPaid);
    event Withdrawal(address indexed to, uint256 amount);

    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    function setDishMarket(address _dishMarket) external onlyOwner {
        dishMarket = _dishMarket;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /**
     * @notice Register a new seed type. Deploys a fresh SeedToken contract.
     * @param name     ERC20 token name (e.g. "Tomato Seed")
     * @param symbol   ERC20 token symbol (e.g. "TOMATO")
     * @param price    Price per seed in wei
     * @return seedId  The ID assigned to this seed type
     */
    function addSeed(
        string calldata name,
        string calldata symbol,
        uint256 price
    ) external onlyOwner returns (uint256 seedId) {
        if (price == 0) revert PriceMustBePositive();

        seedId = seedCount++;
        SeedToken token = new SeedToken(name, symbol, address(this));
        seeds[seedId] = Seed({ token: token, price: price, exists: true });

        emit SeedAdded(seedId, address(token), name, symbol, price);
    }

    /**
     * @notice Buy seeds. Send exactly `price * quantity` ETH.
     * @param seedId    ID of the seed type to purchase
     * @param quantity  Number of seeds to buy (minimum 1)
     */
    function buy(uint256 seedId, uint256 quantity) external payable nonReentrant {
        Seed storage seed = seeds[seedId];
        if (!seed.exists) revert SeedNotFound();
        if (quantity == 0) revert QuantityMustBePositive();
        if (msg.value != seed.price * quantity) revert WrongETHAmount();

        seed.token.mint(msg.sender, quantity);

        // Forward ETH to DishMarket treasury (or hold for owner withdrawal)
        if (dishMarket != address(0)) {
            (bool success, ) = dishMarket.call{ value: msg.value }("");
            if (!success) revert TransferFailed();
        }

        emit SeedPurchased(seedId, msg.sender, quantity, msg.value);
    }

    /**
     * @notice Withdraw all ETH proceeds to the owner.
     */
    function withdraw() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToWithdraw();
        (bool success, ) = owner.call{ value: amount }("");
        if (!success) revert TransferFailed();

        emit Withdrawal(owner, amount);
    }

    /**
     * @notice Returns the ERC20 token address for a seed type.
     */
    function seedToken(uint256 seedId) external view returns (address) {
        if (!seeds[seedId].exists) revert SeedNotFound();
        return address(seeds[seedId].token);
    }

    /**
     * @notice Returns the price in wei for a given seed type.
     */
    function seedPrice(uint256 seedId) external view returns (uint256) {
        if (!seeds[seedId].exists) revert SeedNotFound();
        return seeds[seedId].price;
    }
}
