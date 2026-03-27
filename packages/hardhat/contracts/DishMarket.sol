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
 * @notice Reverse auction that demands TWO different dishes every 10 seconds.
 *
 * @dev Each epoch (10 s) two dishes are active:
 *   - Primary:   epoch % recipeCount  (deterministic, fully predictable)
 *   - Secondary: keccak256("dish2", epoch) % recipeCount  (pseudo-random, different from primary)
 *
 *      Any holder of either demanded dish can escrow tokens and submit an ETH ask price,
 *      specifying which recipe they are selling. After the epoch ends, the MAX_WINNERS
 *      cheapest offers *per recipe* can all call settle() — their dishes are burned and they
 *      receive their ETH payment. Non-winners can withdraw their escrowed dishes at any time.
 *
 *      One offer per address per recipe per epoch (users can offer for both recipes).
 *      All offers share a single _offers[epoch] array, tagged by recipeId.
 *
 *      The contract must be funded with ETH (via receive()) to pay winners.
 *      `availableFunds` tracks uncommitted ETH to prevent over-committing the treasury.
 */
contract DishMarket is ReentrancyGuard {
    uint256 public constant EPOCH_DURATION = 10; // seconds per demand epoch
    uint256 public constant MAX_WINNERS = 3;      // top-N cheapest offers win per recipe per epoch

    address public immutable owner;
    Chef public immutable chef;
    FarmManager public immutable farmManager;

    // ---- Structs ----

    struct Offer {
        address seller;
        uint256 askPrice; // ETH per dish (wei) the seller wants
        uint256 amount;   // number of dishes offered
        uint256 recipeId; // which demanded recipe this offer is for
        bool claimed;     // true once dish returned (loser) or burned (winner)
    }

    struct EpochState {
        uint256 recipeId;              // primary demand: snapshotted on first offer
        uint256 secondRecipeId;        // secondary demand: pseudo-random, snapshotted on first offer
        bool hasOffers;
        uint256 settledCount;          // total winners settled (both recipes combined)
        uint256 winnerIndex;           // index of lowest-ask offer for primary recipe
        uint256 winnerAskPrice;        // running lowest ask per dish for primary recipe
        uint256 secondWinnerIndex;     // index of lowest-ask offer for secondary recipe
        uint256 secondWinnerAskPrice;  // running lowest ask per dish for secondary recipe
    }

    // ---- Storage ----

    mapping(uint256 => Offer[]) private _offers;          // epoch => offers (all recipes combined)
    mapping(uint256 => EpochState) public epochState;     // epoch => state
    // epoch => recipeId => user => offered (one offer per address per recipe per epoch)
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasOffered;

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
    error NotDemandedRecipe();

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

    // ---- Demand view functions ----

    /**
     * @notice The primary dish demanded during a given epoch.
     * @dev Uses the snapshotted recipeId if offers exist, otherwise computes live.
     */
    function getDemandForMinute(uint256 epoch) public view returns (uint256 recipeId) {
        EpochState storage state = epochState[epoch];
        if (state.hasOffers) return state.recipeId;
        uint256 count = chef.recipeCount();
        if (count == 0) revert NoRecipes();
        return epoch % count;
    }

    /// @notice The primary dish demanded right now.
    function currentDemand() external view returns (uint256 recipeId) {
        return getDemandForMinute(currentEpoch());
    }

    /**
     * @notice The secondary (pseudo-random) dish demanded during a given epoch.
     * @dev Uses the snapshotted secondRecipeId if offers exist, otherwise computes live.
     *      The secondary demand is derived from keccak256("dish2", epoch) and is guaranteed
     *      to differ from the primary demand.
     */
    function secondDemandForEpoch(uint256 epoch) public view returns (uint256) {
        EpochState storage state = epochState[epoch];
        if (state.hasOffers) return state.secondRecipeId;
        uint256 count = chef.recipeCount();
        if (count == 0) revert NoRecipes();
        return _secondDemandForEpoch(epoch, epoch % count, count);
    }

    /// @notice The secondary (pseudo-random) dish demanded right now.
    function currentSecondDemand() external view returns (uint256) {
        return secondDemandForEpoch(currentEpoch());
    }

    /// @notice All offers submitted for a given epoch (both recipes combined).
    function getOffers(uint256 epoch) external view returns (Offer[] memory) {
        return _offers[epoch];
    }

    // ---- Internal helpers ----

    /**
     * @notice Computes the secondary demanded recipe for an epoch.
     * @dev Uses keccak256 of ("dish2", epoch) to derive a pseudo-random recipe index
     *      that is guaranteed to differ from primaryId when recipeCount > 1.
     */
    function _secondDemandForEpoch(uint256 epoch, uint256 primaryId, uint256 count) internal pure returns (uint256) {
        uint256 raw = uint256(keccak256(abi.encode("dish2", epoch))) % count;
        if (raw == primaryId) raw = (raw + 1) % count;
        return raw;
    }

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
     * @notice Submit an offer to sell one or more of a currently demanded dish.
     * @dev Escrows `amount` DishTokens. Requires prior approve(dishMarket, amount).
     *      One offer per address per recipe per epoch (users may offer for both demanded recipes).
     *      The MAX_WINNERS cheapest offers per recipe win. Winner receives askPrice × amount ETH.
     * @param recipeId The recipe being offered — must be either the primary or secondary demand.
     * @param askPrice ETH per dish (wei) the seller wants to receive.
     * @param amount   Number of dishes to sell.
     */
    function submitOffer(uint256 recipeId, uint256 askPrice, uint256 amount) external nonReentrant {
        uint256 count = chef.recipeCount();
        if (count == 0) revert NoRecipes();
        if (askPrice == 0) revert ZeroAskPrice();
        if (amount == 0) revert ZeroAmount();

        uint256 totalPayment = askPrice * amount;
        if (totalPayment > availableFunds) revert AskPriceTooHigh();

        uint256 epoch = currentEpoch();

        EpochState storage state = epochState[epoch];

        // Snapshot both recipes on first offer to prevent modulo drift
        if (!state.hasOffers) {
            state.recipeId = epoch % count;
            state.secondRecipeId = _secondDemandForEpoch(epoch, state.recipeId, count);
        }

        // Validate the submitted recipe is one of the two demanded this epoch
        if (recipeId != state.recipeId && recipeId != state.secondRecipeId) revert NotDemandedRecipe();

        // One offer per address per recipe per epoch
        if (hasOffered[epoch][recipeId][msg.sender]) revert AlreadyOffered();

        // Enforce price cap
        uint256 cap = _recipeSeedCostCap(recipeId);
        if (askPrice > cap) revert AskPriceExceedsCap();

        (, , , address dishTokenAddr) = chef.getRecipe(recipeId);

        // Effects before external call (CEI + nonReentrant mutex)
        uint256 idx = _offers[epoch].length;
        _offers[epoch].push(Offer({
            seller: msg.sender,
            askPrice: askPrice,
            amount: amount,
            recipeId: recipeId,
            claimed: false
        }));
        hasOffered[epoch][recipeId][msg.sender] = true;

        // Update the running minimum for the correct recipe
        bool isFirstOffer = !state.hasOffers;
        state.hasOffers = true;

        if (recipeId == state.recipeId) {
            // Primary recipe winner tracking
            // Safe to use winnerAskPrice == 0 as "no primary offer yet" since askPrice > 0 is enforced
            bool noYet = (state.winnerAskPrice == 0);
            if (isFirstOffer || noYet || askPrice < state.winnerAskPrice) {
                state.winnerAskPrice = askPrice;
                state.winnerIndex = idx;
            }
        } else {
            // Secondary recipe winner tracking
            bool noYet = (state.secondWinnerAskPrice == 0);
            if (isFirstOffer || noYet || askPrice < state.secondWinnerAskPrice) {
                state.secondWinnerAskPrice = askPrice;
                state.secondWinnerIndex = idx;
            }
        }

        IERC20(dishTokenAddr).transferFrom(msg.sender, address(this), amount);

        emit OfferSubmitted(epoch, recipeId, msg.sender, askPrice);
    }

    /**
     * @notice Settle a winning offer: burn escrowed dishes and receive ETH payment.
     * @dev An offer wins if fewer than MAX_WINNERS other offers FOR THE SAME RECIPE have a
     *      strictly lower per-dish ask price. All tied offers at the boundary also win.
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

        // Count how many offers for the SAME recipe have a strictly lower per-dish ask price
        uint256 myRecipeId = myOffer.recipeId;
        uint256 betterCount = 0;
        uint256 n = offers.length;
        for (uint256 i = 0; i < n; ) {
            if (i != offerIndex && offers[i].recipeId == myRecipeId && offers[i].askPrice < myOffer.askPrice) {
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

        // Burn the winner's escrowed dish tokens (use offer's recipeId, not state.recipeId)
        (, , , address dishTokenAddr) = chef.getRecipe(myRecipeId);
        ERC20Burnable(dishTokenAddr).burn(myOffer.amount);

        emit EpochSettled(epoch, myRecipeId, msg.sender, myOffer.askPrice);

        // Pay the winner (they are the caller — no reentrancy risk from untrusted caller)
        (bool ok, ) = msg.sender.call{ value: payment }("");
        if (!ok) revert TransferFailed();
    }

    /**
     * @notice Reclaim an escrowed dish token for a non-winning or forfeited offer.
     * @dev During an active epoch: withdrawal is blocked for each recipe's current lowest-ask
     *      offer to prevent gaming. After the epoch ends: any unclaimed offer can withdraw.
     * @param epoch      The epoch index the offer was submitted in.
     * @param offerIndex Index of the offer within that epoch's offer list.
     */
    function withdrawOffer(uint256 epoch, uint256 offerIndex) external nonReentrant {
        if (offerIndex >= _offers[epoch].length) revert InvalidOfferIndex();

        EpochState storage state = epochState[epoch];

        // During an active epoch: protect the current lowest offer for each recipe
        if (currentEpoch() == epoch && state.hasOffers) {
            Offer storage checkOffer = _offers[epoch][offerIndex];
            bool isPrimaryLeader = (checkOffer.recipeId == state.recipeId && offerIndex == state.winnerIndex);
            bool isSecondaryLeader = (checkOffer.recipeId == state.secondRecipeId && offerIndex == state.secondWinnerIndex);
            if (isPrimaryLeader || isSecondaryLeader) revert OfferIsCurrentWinner();
        }

        Offer storage offer = _offers[epoch][offerIndex];
        if (offer.seller != msg.sender) revert NotYourOffer();
        if (offer.claimed) revert AlreadyClaimed();

        offer.claimed = true;

        // Use offer.recipeId (not state.recipeId) — the offer may be for secondary recipe
        (, , , address dishTokenAddr) = chef.getRecipe(offer.recipeId);
        IERC20(dishTokenAddr).transfer(msg.sender, offer.amount);

        emit OfferWithdrawn(epoch, offerIndex, msg.sender);
    }
}
