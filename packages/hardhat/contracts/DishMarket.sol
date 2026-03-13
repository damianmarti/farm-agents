// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { Chef } from "./Chef.sol";
import { FarmManager } from "./FarmManager.sol";
import { SeedShop } from "./SeedShop.sol";

/**
 * @title DishMarket
 * @notice Reverse auction that demands a different dish every minute.
 *
 * @dev Each minute a dish is selected pseudo-randomly using `minute % recipeCount`.
 *      Any holder of that dish can escrow 1 token and submit an ETH ask price.
 *      After the minute ends, only the winner (lowest ask) can call settle() —
 *      their dish is burned and they receive their ETH in the same transaction.
 *      Non-winners can withdraw their escrowed dish at any time once the minute ends,
 *      without waiting for the winner to settle.
 *
 *      The contract must be funded with ETH (via receive()) to pay winners.
 *      `availableFunds` tracks uncommitted ETH to prevent over-committing the treasury.
 */
contract DishMarket is ReentrancyGuard {
    address public immutable owner;
    Chef public immutable chef;
    FarmManager public immutable farmManager;

    // ---- Structs ----

    struct Offer {
        address seller;
        uint256 askPrice; // ETH (wei) the seller wants
        bool claimed;     // true once dish returned (loser) or burned (winner)
    }

    struct MinuteState {
        uint256 recipeId;       // snapshotted on first offer to avoid modulo drift
        bool hasOffers;
        bool settled;
        uint256 winnerIndex;    // index into _offers[minute]
        uint256 winnerAskPrice; // running lowest ask (updated on each new offer)
    }

    // ---- Storage ----

    mapping(uint256 => Offer[]) private _offers;         // minute => offers
    mapping(uint256 => MinuteState) public minuteState;  // minute => state
    mapping(uint256 => mapping(address => bool)) public hasOffered; // minute => user => offered

    uint256 public availableFunds; // uncommitted ETH available to pay winners

    // ---- Custom errors ----

    error OnlyOwner();
    error ZeroAddress();
    error NoRecipes();
    error ZeroAskPrice();
    error AskPriceTooHigh();
    error AskPriceExceedsCap();
    error AlreadyOffered();
    error MinuteNotOver();
    error AlreadySettled();
    error NoOffers();
    error NotWinner();
    error InsufficientFunds();
    error OfferIsCurrentWinner();
    error NotYourOffer();
    error AlreadyClaimed();
    error InvalidOfferIndex();
    error TransferFailed();
    error TokenNotRegistered();

    // ---- Events ----

    event OfferSubmitted(uint256 indexed minute, uint256 indexed recipeId, address indexed seller, uint256 askPrice);
    event MinuteSettled(uint256 indexed minute, uint256 indexed recipeId, address indexed winner, uint256 askPrice);
    event OfferWithdrawn(uint256 indexed minute, uint256 offerIndex, address indexed seller);
    event Funded(address indexed funder, uint256 amount);

    // ---- Constructor ----

    constructor(address _owner, address _chef, address _farmManager) {
        if (_owner == address(0) || _chef == address(0) || _farmManager == address(0)) revert ZeroAddress();
        owner = _owner;
        chef = Chef(_chef);
        farmManager = FarmManager(_farmManager);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ---- Funding ----

    /// @notice Fund the market treasury so it can pay winners.
    receive() external payable {
        availableFunds += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Owner withdraws uncommitted funds.
    function withdrawFunds(uint256 amount) external onlyOwner nonReentrant {
        if (amount > availableFunds) revert InsufficientFunds();
        availableFunds -= amount;
        (bool ok, ) = owner.call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }

    // ---- View ----

    /// @notice Current minute index (block.timestamp / 60).
    function currentMinute() public view returns (uint256) {
        return block.timestamp / 60;
    }

    /**
     * @notice The dish demanded during `minute`.
     * @dev Uses the snapshotted recipeId if offers exist, otherwise computes live.
     *      Snapshotting prevents modulo drift when new recipes are added to Chef.
     */
    function getDemandForMinute(uint256 minute) public view returns (uint256 recipeId) {
        MinuteState storage state = minuteState[minute];
        if (state.hasOffers) return state.recipeId;
        uint256 count = chef.recipeCount();
        if (count == 0) revert NoRecipes();
        return minute % count;
    }

    /// @notice The dish demanded right now.
    function currentDemand() external view returns (uint256 recipeId) {
        return getDemandForMinute(currentMinute());
    }

    /// @notice All offers submitted for a given minute.
    function getOffers(uint256 minute) external view returns (Offer[] memory) {
        return _offers[minute];
    }

    // ---- Internal helpers ----

    /**
     * @notice Computes the maximum allowed ask price for a recipe: 2 × total seed cost.
     * @dev Iterates the recipe's ingredient tokens. Every token must be registered in FarmManager
     *      as a fruit token — reverts with TokenNotRegistered otherwise.
     *      Converts each required fruit amount to seed units using ceiling division
     *      (partial seeds still cost a full seed), then multiplies by the seed price.
     * @param recipeId The recipe whose seed cost to compute.
     */
    function _recipeSeedCostCap(uint256 recipeId) internal view returns (uint256) {
        Chef.Ingredient[] memory ingredients = chef.getIngredients(recipeId);
        SeedShop shop = farmManager.seedShop();
        uint256 seedCost = 0;
        uint256 len = ingredients.length;
        for (uint256 i = 0; i < len; ) {
            address token = ingredients[i].token;
            if (!farmManager.isFruitToken(token)) revert TokenNotRegistered();
            uint256 seedId = farmManager.fruitToSeedId(token);
            uint256 yield  = farmManager.harvestYield(seedId); // fruit tokens per seed
            // Convert fruit amount → seeds needed (ceiling: partial seeds cost a full seed)
            uint256 seeds  = (ingredients[i].amount + yield - 1) / yield;
            seedCost += shop.seedPrice(seedId) * seeds;
            unchecked { ++i; }
        }
        return seedCost * 2;
    }

    // ---- Actions ----

    /**
     * @notice Submit an offer to sell the currently demanded dish.
     * @dev Escrows 1 DishToken. Requires prior approve(dishMarket, 1) on the DishToken.
     *      One offer per address per minute. The running lowest ask is tracked on-chain
     *      so settle() is O(1).
     * @param askPrice ETH (wei) the seller wants to receive for their dish.
     */
    function submitOffer(uint256 askPrice) external nonReentrant {
        uint256 count = chef.recipeCount();
        if (count == 0) revert NoRecipes();
        if (askPrice == 0) revert ZeroAskPrice();
        if (askPrice > availableFunds) revert AskPriceTooHigh();

        uint256 minute = currentMinute();
        if (hasOffered[minute][msg.sender]) revert AlreadyOffered();

        MinuteState storage state = minuteState[minute];

        // Snapshot recipeId on first offer to prevent modulo drift
        uint256 recipeId;
        if (!state.hasOffers) {
            recipeId = minute % count;
            state.recipeId = recipeId;
        } else {
            recipeId = state.recipeId;
        }

        // Enforce price cap: ask price must not exceed 2× the seed cost of the dish
        uint256 cap = _recipeSeedCostCap(recipeId);
        if (askPrice > cap) revert AskPriceExceedsCap();

        (, , , address dishTokenAddr) = chef.getRecipe(recipeId);

        // Effects before external call (CEI + nonReentrant mutex)
        uint256 idx = _offers[minute].length;
        _offers[minute].push(Offer({ seller: msg.sender, askPrice: askPrice, claimed: false }));
        hasOffered[minute][msg.sender] = true;

        // Update running minimum. hasOffers set first to keep condition unambiguous.
        bool isFirstOffer = !state.hasOffers;
        state.hasOffers = true;
        if (isFirstOffer || askPrice < state.winnerAskPrice) {
            state.winnerAskPrice = askPrice;
            state.winnerIndex = idx;
        }

        IERC20(dishTokenAddr).transferFrom(msg.sender, address(this), 1);

        emit OfferSubmitted(minute, recipeId, msg.sender, askPrice);
    }

    /**
     * @notice Winner settles their auction, burning their dish and receiving ETH.
     * @dev Only callable by the winner (lowest ask). ETH is sent directly in the
     *      same transaction — no separate claim needed.
     * @param minute The minute index to settle.
     */
    function settle(uint256 minute) external nonReentrant {
        if (currentMinute() <= minute) revert MinuteNotOver();

        MinuteState storage state = minuteState[minute];
        if (state.settled) revert AlreadySettled();
        if (!state.hasOffers) revert NoOffers();

        Offer storage winner = _offers[minute][state.winnerIndex];
        if (msg.sender != winner.seller) revert NotWinner();

        uint256 payment = state.winnerAskPrice;
        if (availableFunds < payment) revert InsufficientFunds();

        // Effects
        state.settled = true;
        availableFunds -= payment;
        winner.claimed = true;

        // Burn the winner's escrowed dish token
        (, , , address dishTokenAddr) = chef.getRecipe(state.recipeId);
        ERC20Burnable(dishTokenAddr).burn(1);

        emit MinuteSettled(minute, state.recipeId, winner.seller, payment);

        // Pay the winner directly (they are the caller)
        (bool ok, ) = winner.seller.call{ value: payment }("");
        if (!ok) revert TransferFailed();
    }

    /**
     * @notice Reclaim an escrowed dish token for a non-winning offer.
     * @dev Two withdrawal paths:
     *   - During the minute: allowed if this offer is NOT the current lowest ask.
     *   - After the minute ends: allowed for any non-winner, with no dependency
     *     on whether the winner has called settle() yet.
     *   The winner's offer can only be freed via settle().
     * @param minute     The minute index the offer was submitted in.
     * @param offerIndex Index of the offer within that minute's offer list.
     */
    function withdrawOffer(uint256 minute, uint256 offerIndex) external nonReentrant {
        if (offerIndex >= _offers[minute].length) revert InvalidOfferIndex();

        MinuteState storage state = minuteState[minute];

        // The winner is always blocked from withdrawing here — they must use settle()
        if (state.hasOffers && offerIndex == state.winnerIndex) revert OfferIsCurrentWinner();

        // During the minute, non-winners can withdraw early
        // After the minute ends, non-winners can withdraw freely (no settlement needed)
        // (The winner check above already blocks the winner in both cases)

        Offer storage offer = _offers[minute][offerIndex];
        if (offer.seller != msg.sender) revert NotYourOffer();
        if (offer.claimed) revert AlreadyClaimed();

        offer.claimed = true;

        (, , , address dishTokenAddr) = chef.getRecipe(state.recipeId);
        IERC20(dishTokenAddr).transfer(msg.sender, 1);

        emit OfferWithdrawn(minute, offerIndex, msg.sender);
    }
}
