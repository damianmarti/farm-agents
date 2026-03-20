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
 * @notice Reverse auction that demands a different dish every 10 seconds.
 *
 * @dev Each epoch (10 s) a dish is selected using `epoch % recipeCount`.
 *      Any holder of that dish can escrow tokens and submit an ETH ask price.
 *      After the epoch ends, only the winner (lowest ask) can call settle() —
 *      their dishes are burned and they receive their ETH in the same transaction.
 *      Non-winners can withdraw their escrowed dishes at any time once the epoch ends,
 *      without waiting for the winner to settle.
 *
 *      The contract must be funded with ETH (via receive()) to pay winners.
 *      `availableFunds` tracks uncommitted ETH to prevent over-committing the treasury.
 */
contract DishMarket is ReentrancyGuard {
    uint256 public constant EPOCH_DURATION = 10; // seconds per demand epoch

    address public immutable owner;
    Chef public immutable chef;
    FarmManager public immutable farmManager;

    // ---- Structs ----

    struct Offer {
        address seller;
        uint256 askPrice; // ETH per dish (wei) the seller wants
        uint256 amount;   // number of dishes offered
        bool claimed;     // true once dish returned (loser) or burned (winner)
    }

    struct EpochState {
        uint256 recipeId;       // snapshotted on first offer to avoid modulo drift
        bool hasOffers;
        bool settled;
        uint256 winnerIndex;    // index into _offers[epoch]
        uint256 winnerAskPrice; // running lowest ask (updated on each new offer)
    }

    // ---- Storage ----

    mapping(uint256 => Offer[]) private _offers;          // epoch => offers
    mapping(uint256 => EpochState) public epochState;     // epoch => state
    mapping(uint256 => mapping(address => bool)) public hasOffered; // epoch => user => offered

    uint256 public availableFunds; // uncommitted ETH available to pay winners

    // ---- Custom errors ----

    error OnlyOwner();
    error ZeroAddress();
    error NoRecipes();
    error ZeroAskPrice();
    error AskPriceTooHigh();
    error AskPriceExceedsCap();
    error AlreadyOffered();
    error EpochNotOver();
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
    error ZeroAmount();

    // ---- Events ----

    event OfferSubmitted(uint256 indexed epoch, uint256 indexed recipeId, address indexed seller, uint256 askPrice);
    event EpochSettled(uint256 indexed epoch, uint256 indexed recipeId, address indexed winner, uint256 askPrice);
    event OfferWithdrawn(uint256 indexed epoch, uint256 offerIndex, address indexed seller);
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

    /// @notice Current epoch index (block.timestamp / EPOCH_DURATION).
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_DURATION;
    }

    // ---- Backward-compatible aliases ----

    /// @notice Alias for currentEpoch() — kept for frontend/bot compatibility.
    function currentMinute() external view returns (uint256) {
        return currentEpoch();
    }

    /// @notice Alias for epochState — kept for frontend/bot compatibility.
    function minuteState(uint256 epoch) external view returns (
        uint256 recipeId, bool hasOffers_, bool settled,
        uint256 winnerIndex, uint256 winnerAskPrice
    ) {
        EpochState storage s = epochState[epoch];
        return (s.recipeId, s.hasOffers, s.settled, s.winnerIndex, s.winnerAskPrice);
    }

    /**
     * @notice The dish demanded during a given epoch.
     * @dev Uses the snapshotted recipeId if offers exist, otherwise computes live.
     */
    function getDemandForMinute(uint256 epoch) public view returns (uint256 recipeId) {
        EpochState storage state = epochState[epoch];
        if (state.hasOffers) return state.recipeId;
        uint256 count = chef.recipeCount();
        if (count == 0) revert NoRecipes();
        return epoch % count;
    }

    /// @notice The dish demanded right now.
    function currentDemand() external view returns (uint256 recipeId) {
        return getDemandForMinute(currentEpoch());
    }

    /// @notice All offers submitted for a given epoch.
    function getOffers(uint256 epoch) external view returns (Offer[] memory) {
        return _offers[epoch];
    }

    // ---- Internal helpers ----

    /**
     * @notice Computes the maximum allowed ask price for a recipe.
     * @dev Multiplier scales with ingredient count: 20× (1-3), 30× (4+)
     *      to compensate for the higher coordination cost of multi-ingredient dishes.
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
            uint256 yield  = farmManager.harvestYield(seedId);
            uint256 seeds  = (ingredients[i].amount + yield - 1) / yield;
            seedCost += shop.seedPrice(seedId) * seeds;
            unchecked { ++i; }
        }
        uint256 multiplier = len >= 4 ? 30 : 20;
        return seedCost * multiplier;
    }

    // ---- Actions ----

    /**
     * @notice Submit an offer to sell one or more of the currently demanded dish.
     * @dev Escrows `amount` DishTokens. Requires prior approve(dishMarket, amount).
     *      One offer per address per epoch. The running lowest ask is tracked on-chain
     *      so settle() is O(1). The winner receives askPrice × amount ETH.
     * @param askPrice ETH per dish (wei) the seller wants to receive.
     * @param amount   Number of dishes to sell.
     */
    function submitOffer(uint256 askPrice, uint256 amount) external nonReentrant {
        uint256 count = chef.recipeCount();
        if (count == 0) revert NoRecipes();
        if (askPrice == 0) revert ZeroAskPrice();
        if (amount == 0) revert ZeroAmount();

        uint256 totalPayment = askPrice * amount;
        if (totalPayment > availableFunds) revert AskPriceTooHigh();

        uint256 epoch = currentEpoch();
        if (hasOffered[epoch][msg.sender]) revert AlreadyOffered();

        EpochState storage state = epochState[epoch];

        // Snapshot recipeId on first offer to prevent modulo drift
        uint256 recipeId;
        if (!state.hasOffers) {
            recipeId = epoch % count;
            state.recipeId = recipeId;
        } else {
            recipeId = state.recipeId;
        }

        // Enforce price cap: ask price per dish must not exceed 20× the seed cost
        uint256 cap = _recipeSeedCostCap(recipeId);
        if (askPrice > cap) revert AskPriceExceedsCap();

        (, , , address dishTokenAddr) = chef.getRecipe(recipeId);

        // Effects before external call (CEI + nonReentrant mutex)
        uint256 idx = _offers[epoch].length;
        _offers[epoch].push(Offer({ seller: msg.sender, askPrice: askPrice, amount: amount, claimed: false }));
        hasOffered[epoch][msg.sender] = true;

        // Update running minimum (by per-dish askPrice)
        bool isFirstOffer = !state.hasOffers;
        state.hasOffers = true;
        if (isFirstOffer || askPrice < state.winnerAskPrice) {
            state.winnerAskPrice = askPrice;
            state.winnerIndex = idx;
        }

        IERC20(dishTokenAddr).transferFrom(msg.sender, address(this), amount);

        emit OfferSubmitted(epoch, recipeId, msg.sender, askPrice);
    }

    /**
     * @notice Winner settles their auction, burning all their escrowed dishes and receiving ETH.
     * @dev Only callable by the winner (lowest per-dish ask). Payment = askPrice × amount.
     * @param epoch The epoch index to settle.
     */
    function settle(uint256 epoch) external nonReentrant {
        if (currentEpoch() <= epoch) revert EpochNotOver();

        EpochState storage state = epochState[epoch];
        if (state.settled) revert AlreadySettled();
        if (!state.hasOffers) revert NoOffers();

        Offer storage winner = _offers[epoch][state.winnerIndex];
        if (msg.sender != winner.seller) revert NotWinner();

        uint256 payment = winner.askPrice * winner.amount;
        if (availableFunds < payment) revert InsufficientFunds();

        // Effects
        state.settled = true;
        availableFunds -= payment;
        winner.claimed = true;

        // Burn the winner's escrowed dish tokens
        (, , , address dishTokenAddr) = chef.getRecipe(state.recipeId);
        ERC20Burnable(dishTokenAddr).burn(winner.amount);

        emit EpochSettled(epoch, state.recipeId, winner.seller, payment);

        // Pay the winner directly (they are the caller)
        (bool ok, ) = winner.seller.call{ value: payment }("");
        if (!ok) revert TransferFailed();
    }

    /**
     * @notice Reclaim an escrowed dish token for a non-winning offer.
     * @dev Two withdrawal paths:
     *   - During the epoch: allowed if this offer is NOT the current lowest ask.
     *   - After the epoch ends: allowed for any non-winner, with no dependency
     *     on whether the winner has called settle() yet.
     *   The winner's offer can only be freed via settle().
     * @param epoch      The epoch index the offer was submitted in.
     * @param offerIndex Index of the offer within that epoch's offer list.
     */
    function withdrawOffer(uint256 epoch, uint256 offerIndex) external nonReentrant {
        if (offerIndex >= _offers[epoch].length) revert InvalidOfferIndex();

        EpochState storage state = epochState[epoch];

        // The winner is always blocked from withdrawing here — they must use settle()
        if (state.hasOffers && offerIndex == state.winnerIndex) revert OfferIsCurrentWinner();

        Offer storage offer = _offers[epoch][offerIndex];
        if (offer.seller != msg.sender) revert NotYourOffer();
        if (offer.claimed) revert AlreadyClaimed();

        offer.claimed = true;

        (, , , address dishTokenAddr) = chef.getRecipe(state.recipeId);
        IERC20(dishTokenAddr).transfer(msg.sender, offer.amount);

        emit OfferWithdrawn(epoch, offerIndex, msg.sender);
    }
}
