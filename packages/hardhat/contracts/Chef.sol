// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import { DishToken } from "./DishToken.sol";

/**
 * @title Chef
 * @notice Cooking contract: combine ingredient tokens to prepare dishes.
 *
 * @dev Flow:
 *   1. Owner registers recipes via addRecipe() — each recipe has a list of
 *      (token, amount) ingredients, a prep time, and a DishToken deployed on registration.
 *   2. User approves Chef for each ingredient token (standard ERC20 approve).
 *   3. User calls startCooking(recipeId) — ingredients are burned from caller's wallet.
 *   4. After prepTime seconds, user calls claim(recipeId) — DishTokens are minted.
 *
 *   Only one active cooking session per (user, recipe) at a time.
 *   Anyone can cook any recipe.
 */
contract Chef is ReentrancyGuard {
    address public immutable owner;

    // ---- Structs ----

    struct Ingredient {
        address token;  // ERC20Burnable ingredient token
        uint256 amount; // quantity required
    }

    struct Recipe {
        string name;
        Ingredient[] ingredients;
        uint256 prepTime;    // seconds from startCooking to claim
        uint256 dishAmount;  // DishTokens minted per cook
        DishToken dishToken; // ERC20 issued on claim
        bool exists;
    }

    // ---- Storage ----

    mapping(uint256 => Recipe) private _recipes;
    uint256 public recipeCount;

    // user => recipeId => cooking start timestamp (0 = not cooking)
    mapping(address => mapping(uint256 => uint256)) public cookingStartTime;

    // ---- Custom errors ----

    error OnlyOwner();
    error ZeroAddress();
    error RecipeNotFound();
    error InvalidRecipeConfig();
    error AlreadyCooking();
    error NotCooking();
    error StillCooking();

    // ---- Events ----

    event RecipeAdded(uint256 indexed recipeId, address indexed dishToken, string name, uint256 prepTime);
    event CookingStarted(uint256 indexed recipeId, address indexed cook, uint256 readyAt);
    event DishClaimed(uint256 indexed recipeId, address indexed cook, uint256 amount);

    // ---- Constructor ----

    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ---- Admin ----

    /**
     * @notice Register a new recipe and deploy its DishToken.
     * @param name               Display name of the dish (e.g. "Tomato Soup")
     * @param ingredientTokens   ERC20Burnable token addresses for each ingredient
     * @param ingredientAmounts  Required amount of each ingredient (parallel array)
     * @param prepTime           Seconds from startCooking until the dish can be claimed
     * @param dishAmount         DishTokens minted per successful cook
     * @param dishName           ERC20 name for the dish token (e.g. "Tomato Soup")
     * @param dishSymbol         ERC20 symbol for the dish token (e.g. "TSOUP")
     */
    function addRecipe(
        string calldata name,
        address[] calldata ingredientTokens,
        uint256[] calldata ingredientAmounts,
        uint256 prepTime,
        uint256 dishAmount,
        string calldata dishName,
        string calldata dishSymbol
    ) external onlyOwner returns (uint256 recipeId) {
        if (
            ingredientTokens.length == 0 ||
            ingredientTokens.length != ingredientAmounts.length ||
            prepTime == 0 ||
            dishAmount == 0
        ) revert InvalidRecipeConfig();

        recipeId = recipeCount++;
        Recipe storage recipe = _recipes[recipeId];
        recipe.name = name;
        recipe.prepTime = prepTime;
        recipe.dishAmount = dishAmount;
        recipe.dishToken = new DishToken(dishName, dishSymbol, address(this));
        recipe.exists = true;

        uint256 len = ingredientTokens.length;
        for (uint256 i = 0; i < len; ) {
            if (ingredientTokens[i] == address(0) || ingredientAmounts[i] == 0) revert InvalidRecipeConfig();
            recipe.ingredients.push(Ingredient({ token: ingredientTokens[i], amount: ingredientAmounts[i] }));
            unchecked { ++i; }
        }

        emit RecipeAdded(recipeId, address(recipe.dishToken), name, prepTime);
    }

    // ---- View ----

    /**
     * @notice Returns recipe metadata (without ingredients array).
     */
    function getRecipe(
        uint256 recipeId
    ) external view returns (string memory name, uint256 prepTime, uint256 dishAmount, address dishToken) {
        Recipe storage r = _recipes[recipeId];
        if (!r.exists) revert RecipeNotFound();
        return (r.name, r.prepTime, r.dishAmount, address(r.dishToken));
    }

    /**
     * @notice Returns the ingredients list for a recipe.
     */
    function getIngredients(uint256 recipeId) external view returns (Ingredient[] memory) {
        if (!_recipes[recipeId].exists) revert RecipeNotFound();
        return _recipes[recipeId].ingredients;
    }

    /**
     * @notice Seconds remaining until the dish is ready (0 if ready or not cooking).
     */
    function timeUntilReady(address cook, uint256 recipeId) external view returns (uint256) {
        uint256 start = cookingStartTime[cook][recipeId];
        if (start == 0) return 0;
        uint256 readyAt = start + _recipes[recipeId].prepTime;
        if (block.timestamp >= readyAt) return 0;
        return readyAt - block.timestamp;
    }

    // ---- Cooking actions ----

    /**
     * @notice Start cooking a recipe. Burns all required ingredients from the caller.
     * @dev Caller must have approved Chef for each ingredient token beforehand.
     *      Only one active session per (caller, recipeId) at a time.
     * @param recipeId ID of the recipe to cook
     */
    function startCooking(uint256 recipeId) external nonReentrant {
        Recipe storage recipe = _recipes[recipeId];
        if (!recipe.exists) revert RecipeNotFound();
        if (cookingStartTime[msg.sender][recipeId] != 0) revert AlreadyCooking();

        // Set state before external calls.
        // Note: CEI alone is insufficient here because a reentrant call could
        // target claim() rather than startCooking(). The nonReentrant mutex on
        // both functions is the primary protection against reentrancy.
        cookingStartTime[msg.sender][recipeId] = block.timestamp;

        // Burn all ingredients from the caller
        Ingredient[] storage ingredients = recipe.ingredients;
        uint256 len = ingredients.length;
        for (uint256 i = 0; i < len; ) {
            ERC20Burnable(ingredients[i].token).burnFrom(msg.sender, ingredients[i].amount);
            unchecked { ++i; }
        }

        emit CookingStarted(recipeId, msg.sender, block.timestamp + recipe.prepTime);
    }

    /**
     * @notice Claim a finished dish. Mints DishTokens to the caller.
     * @dev The caller must have a cooking session for this recipe and prepTime must have elapsed.
     * @param recipeId ID of the recipe to claim
     */
    function claim(uint256 recipeId) external nonReentrant {
        uint256 start = cookingStartTime[msg.sender][recipeId];
        if (start == 0) revert NotCooking();

        Recipe storage recipe = _recipes[recipeId];
        if (block.timestamp < start + recipe.prepTime) revert StillCooking();

        // Clear session before minting (CEI)
        delete cookingStartTime[msg.sender][recipeId];

        recipe.dishToken.mint(msg.sender, recipe.dishAmount);

        emit DishClaimed(recipeId, msg.sender, recipe.dishAmount);
    }
}
