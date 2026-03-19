// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LandAuction
 * @notice 100 lands sold sequentially via timed English auction.
 * @dev Rules:
 *   - Only one land is auctioned at a time (lands 0-99).
 *   - Anyone starts the auction for the current land by placing the first bid.
 *   - After the first bid, the auction runs for AUCTION_DURATION (1 hour).
 *   - Each new highest bid credits the previous bidder for later withdrawal.
 *   - After the auction ends, anyone can call `settleAuction()` to close it,
 *     send proceeds to the owner, and open the next land.
 *   - Once all 100 lands are sold the contract is done.
 */
contract LandAuction is ReentrancyGuard {
    uint256 public constant TOTAL_LANDS = 100;
    uint256 public constant AUCTION_DURATION = 1 minutes;

    address public immutable owner;

    // ---- Auction state ----
    uint256 public currentLandId;
    address public highestBidder;
    uint256 public highestBid;
    uint256 public auctionEndTime;
    bool public auctionActive;

    // ---- Land ownership ----
    mapping(uint256 => address) public landOwner;

    // ---- Pull-payment: pending refunds ----
    mapping(address => uint256) public pendingWithdrawals;

    // ---- Custom errors ----
    error AllLandsSold();
    error BidMustBePositive();
    error AuctionHasEnded();
    error BidMustExceedCurrentHighest();
    error NoActiveAuction();
    error AuctionStillInProgress();
    error TransferFailed();
    error NothingToWithdraw();

    // ---- Events ----
    event AuctionStarted(uint256 indexed landId, address indexed firstBidder, uint256 amount, uint256 endTime);
    event NewHighestBid(uint256 indexed landId, address indexed bidder, uint256 amount);
    event AuctionSettled(uint256 indexed landId, address indexed winner, uint256 amount);
    event AllLandsSoldOut();
    event Withdrawal(address indexed bidder, uint256 amount);

    constructor(address _owner) {
        owner = _owner;
    }

    /**
     * @notice Place a bid on the current land.
     * @dev If no auction is running, this bid starts the 1-hour window.
     *      Outbid refunds are credited to the previous bidder via pull-payment.
     */
    function bid() external payable nonReentrant {
        if (currentLandId >= TOTAL_LANDS) revert AllLandsSold();
        if (msg.value == 0) revert BidMustBePositive();

        if (!auctionActive) {
            auctionActive = true;
            auctionEndTime = block.timestamp + AUCTION_DURATION;
            highestBidder = msg.sender;
            highestBid = msg.value;
            emit AuctionStarted(currentLandId, msg.sender, msg.value, auctionEndTime);
        } else {
            if (block.timestamp >= auctionEndTime) revert AuctionHasEnded();
            if (msg.value <= highestBid) revert BidMustExceedCurrentHighest();

            address previousBidder = highestBidder;
            uint256 previousBid = highestBid;

            // Effects before interactions (CEI pattern)
            highestBidder = msg.sender;
            highestBid = msg.value;
            pendingWithdrawals[previousBidder] += previousBid;

            emit NewHighestBid(currentLandId, msg.sender, msg.value);
        }
    }

    /**
     * @notice Withdraw a pending refund from a lost bid.
     * @dev Uses pull-payment pattern to avoid reentrancy and griefing.
     */
    function withdrawRefund() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;

        (bool success, ) = msg.sender.call{ value: amount }("");
        if (!success) revert TransferFailed();

        emit Withdrawal(msg.sender, amount);
    }

    /**
     * @notice Settle the current auction after the time window has closed.
     * @dev Can be called by anyone. Transfers proceeds to owner and records the winner.
     */
    function settleAuction() external nonReentrant {
        if (!auctionActive) revert NoActiveAuction();
        if (block.timestamp < auctionEndTime) revert AuctionStillInProgress();

        address winner = highestBidder;
        uint256 amount = highestBid;
        uint256 landId = currentLandId;

        // Effects before interactions (CEI pattern)
        landOwner[landId] = winner;
        currentLandId += 1;
        auctionActive = false;
        highestBidder = address(0);
        highestBid = 0;
        auctionEndTime = 0;

        (bool success, ) = owner.call{ value: amount }("");
        if (!success) revert TransferFailed();

        emit AuctionSettled(landId, winner, amount);

        if (currentLandId == TOTAL_LANDS) {
            emit AllLandsSoldOut();
        }
    }

    /**
     * @notice Returns seconds remaining in the current auction.
     * @return 0 if no auction is active or the auction has ended.
     */
    function timeRemaining() external view returns (uint256) {
        if (!auctionActive || block.timestamp >= auctionEndTime) return 0;
        return auctionEndTime - block.timestamp;
    }
}
