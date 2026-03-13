// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Burnable } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/**
 * @title FruitToken
 * @notice ERC20 token representing a harvested fruit or vegetable.
 * @dev Decimals are 0 — each token is exactly one unit of produce.
 *      Only the designated minter (the FarmManager) can mint tokens.
 *      Inherits ERC20Burnable so Chef can call burnFrom() when consuming ingredients.
 */
contract FruitToken is ERC20Burnable {
    address public immutable minter;

    error OnlyMinter();
    error ZeroAddress();

    constructor(string memory name, string memory symbol, address _minter) ERC20(name, symbol) {
        if (_minter == address(0)) revert ZeroAddress();
        minter = _minter;
    }

    /// @notice Returns 0 decimals — one token equals one harvested unit.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /// @notice Mint produce. Only callable by FarmManager.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert OnlyMinter();
        _mint(to, amount);
    }
}
