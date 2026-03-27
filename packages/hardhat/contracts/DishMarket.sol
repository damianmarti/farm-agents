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
 *      After the epoch ends, the MAX_WINNERS cheapest offers can all call settle() —
 *      their dishes are burned and they receive their ETH payment.
 *      Non-winners can withdraw their escrowed dishes at any time.
 *
 *      The contract must be funded with ETH (via receive()) to pay winners.
 *      `availableFunds` tracks uncommitted ETH to prevent over-committing the treasury.
 */
contract DishMarket is ReentrancyGuard {
    uint256 public constant EPOCH_DURATION = 10; // seconds per demand epoch
    uint256 public constant MAX_WINNERS = 3;      // top-N cheapest offers win each epoch

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
        uint256 recipeId;        // snapshotted on first offer to avoid modulo drift
        bool hasOffers;
        uint256 settledCount;    // how many winners have settled this epoch
        uint256 winnerIndex;     // index of current lowest ask (updated on each offer)
        uint256 winnerAskPrice;  // running lowest ask per dish
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
        return (s.recipeId, s.hasOffers, s.settledCount > 0, s.winnerIndex, s.winnerAskPrice);
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
     * @dev Multiplier scales with ingredient count: 20× (1-3 ingredients), 30× (4+)
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
     *      so the UI can show competition. The MAX_WINNERS cheapest offers win.
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

        // Enforce price cap: ask price per dish must not exceed the seed cost multiplier
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
     * @notice Settle a winning offer: burn escrowed dishes and receive ETH payment.
     * @dev An offer wins if fewer than MAX_WINNERS other offers have a strictly lower
     *      per-dish ask price. All tied offers at the boundary also win.
     *      Callable by the offer's seller after the epoch has ended.
     * @param epoch      The epoch index to settle.
     * @param offerIndex Index of the caller's offer within that epoch's offer list.
     */
    function settle(uint256 epoch, uint256 offerIndex) external nonReentrant {
        if (currentEpoch() <= epoch) revert EpochNotOver();

        EpochState storage state = epochState[epoch];
        if (!state.hasOffers) revert NoOffers();

        Offer[] storage offers = _offers[epoch];
        if (offerIndex >= offers.length) revert InvalidOfferIndex();

        Offer storage myOffer = offers[offerIndex];
        if (myOffer.seller != msg.sender) revert NotYourOffer();
        if (myOffer.claimed) revert AlreadyClaimed();

        // Count how many offers have a strictly lower per-dish ask price
        uint256 betterCount = 0;
        uint256 n = offers.length;
        for (uint256 i = 0; i < n; ) {
            if (i != offerIndex && offers[i].askPrice < myOffer.askPrice) {
                betterCount++;
            }
            unchecked { ++i; }
        }
        if (betterCount >= MAX_WINNERS) revert NotWinner();

        uint256 payment = myOffer.askPrice * myOffer.amount;
        if (availableFunds < payment) revert InsufficientFunds();

        // Effects
        myOffer.claimed = true;
        availableFunds -= payment;
        state.settledCount++;

        // Burn the winner's escrowed dish tokens
        (, , , address dishTokenAddr) = chef.getRecipe(state.recipeId);
        ERC20Burnable(dishTokenAddr).burn(myOffer.amount);

        emit EpochSettled(epoch, state.recipeId, msg.sender, myOffer.askPrice);

        // Pay the winner (they are the caller — no reentrancy risk from untrusted caller)
        (bool ok, ) = msg.sender.call{ value: payment }("");
        if (!ok) revert TransferFailed();
    }

    /**
     * @notice Reclaim an escrowed dish token for a non-winning or forfeited offer.
     * @dev During an active epoch: withdrawal is blocked for the current lowest-ask offer
     *      to prevent gaming (undercutting then withdrawing). All other offers can withdraw.
     *      After the epoch ends: any unclaimed offer can withdraw freely. Winners who
     *      choose to withdraw forfeit their ETH payment.
     * @param epoch      The epoch index the offer was submitted in.
     * @param offerIndex Index of the offer within that epoch's offer list.
     */
    function withdrawOffer(uint256 epoch, uint256 offerIndex) external nonReentrant {
        if (offerIndex >= _offers[epoch].length) revert InvalidOfferIndex();

        EpochState storage state = epochState[epoch];

        // During an active epoch: protect the current lowest offer from being withdrawn
        if (currentEpoch() == epoch && state.hasOffers && offerIndex == state.winnerIndex) {
            revert OfferIsCurrentWinner();
        }

        Offer storage offer = _offers[epoch][offerIndex];
        if (offer.seller != msg.sender) revert NotYourOffer();
        if (offer.claimed) revert AlreadyClaimed();

        offer.claimed = true;

        (, , , address dishTokenAddr) = chef.getRecipe(state.recipeId);
        IERC20(dishTokenAddr).transfer(msg.sender, offer.amount);

        emit OfferWithdrawn(epoch, offerIndex, msg.sender);
    }
}
