import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("LandAuction", function () {
  async function deployFixture() {
    const [owner, bidder1, bidder2, bidder3] = await ethers.getSigners();
    const LandAuction = await ethers.getContractFactory("LandAuction");
    const auction = await LandAuction.deploy(owner.address);
    return { auction, owner, bidder1, bidder2, bidder3 };
  }

  // ---- bid() ----

  describe("bid", function () {
    it("starts auction on first bid", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      expect(await auction.auctionActive()).to.equal(true);
      expect(await auction.highestBidder()).to.equal(bidder1.address);
      expect(await auction.highestBid()).to.equal(ethers.parseEther("1"));
      expect(await auction.currentLandId()).to.equal(0);
    });

    it("sets auctionEndTime ~1 hour from now on first bid", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      const tx = await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      const block = await ethers.provider.getBlock(tx.blockNumber!);
      const endTime = await auction.auctionEndTime();
      expect(endTime).to.equal(BigInt(block!.timestamp) + 3600n);
    });

    it("accepts higher bid and credits previous bidder", async function () {
      const { auction, bidder1, bidder2 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await auction.connect(bidder2).bid({ value: ethers.parseEther("2") });
      expect(await auction.highestBidder()).to.equal(bidder2.address);
      expect(await auction.highestBid()).to.equal(ethers.parseEther("2"));
      expect(await auction.pendingWithdrawals(bidder1.address)).to.equal(ethers.parseEther("1"));
    });

    it("reverts on zero bid", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      await expect(auction.connect(bidder1).bid({ value: 0 })).to.be.revertedWithCustomError(
        auction,
        "BidMustBePositive",
      );
    });

    it("reverts when bid does not exceed current highest", async function () {
      const { auction, bidder1, bidder2 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await expect(auction.connect(bidder2).bid({ value: ethers.parseEther("1") })).to.be.revertedWithCustomError(
        auction,
        "BidMustExceedCurrentHighest",
      );
    });

    it("reverts when auction window has closed", async function () {
      const { auction, bidder1, bidder2 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await time.increase(3601);
      await expect(auction.connect(bidder2).bid({ value: ethers.parseEther("2") })).to.be.revertedWithCustomError(
        auction,
        "AuctionHasEnded",
      );
    });

    it("reverts when all lands are sold", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      // Sell all 100 lands
      for (let i = 0; i < 100; i++) {
        await auction.connect(bidder1).bid({ value: ethers.parseEther("0.1") });
        await time.increase(3601);
        await auction.settleAuction();
      }
      await expect(auction.connect(bidder1).bid({ value: ethers.parseEther("1") })).to.be.revertedWithCustomError(
        auction,
        "AllLandsSold",
      );
    });
  });

  // ---- withdrawRefund() ----

  describe("withdrawRefund", function () {
    it("allows outbid bidder to withdraw refund", async function () {
      const { auction, bidder1, bidder2 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await auction.connect(bidder2).bid({ value: ethers.parseEther("2") });

      const before = await ethers.provider.getBalance(bidder1.address);
      const tx = await auction.connect(bidder1).withdrawRefund();
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(bidder1.address);

      expect(after - before + gas).to.equal(ethers.parseEther("1"));
      expect(await auction.pendingWithdrawals(bidder1.address)).to.equal(0);
    });

    it("reverts when nothing to withdraw", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      await expect(auction.connect(bidder1).withdrawRefund()).to.be.revertedWithCustomError(
        auction,
        "NothingToWithdraw",
      );
    });
  });

  // ---- settleAuction() ----

  describe("settleAuction", function () {
    it("settles after time expires, assigns land to winner, pays owner", async function () {
      const { auction, owner, bidder1 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await time.increase(3601);

      const ownerBefore = await ethers.provider.getBalance(owner.address);
      await auction.settleAuction();
      const ownerAfter = await ethers.provider.getBalance(owner.address);

      expect(await auction.landOwner(0)).to.equal(bidder1.address);
      expect(await auction.currentLandId()).to.equal(1);
      expect(await auction.auctionActive()).to.equal(false);
      expect(ownerAfter - ownerBefore).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.001"));
    });

    it("can be called by anyone", async function () {
      const { auction, bidder1, bidder2 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await time.increase(3601);
      await expect(auction.connect(bidder2).settleAuction()).to.not.be.reverted;
    });

    it("reverts when no active auction", async function () {
      const { auction } = await loadFixture(deployFixture);
      await expect(auction.settleAuction()).to.be.revertedWithCustomError(auction, "NoActiveAuction");
    });

    it("reverts when auction is still in progress", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await expect(auction.settleAuction()).to.be.revertedWithCustomError(auction, "AuctionStillInProgress");
    });

    it("resets auction state after settlement", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await time.increase(3601);
      await auction.settleAuction();

      expect(await auction.highestBidder()).to.equal(ethers.ZeroAddress);
      expect(await auction.highestBid()).to.equal(0);
      expect(await auction.auctionEndTime()).to.equal(0);
    });
  });

  // ---- timeRemaining() ----

  describe("timeRemaining", function () {
    it("returns 0 when no auction active", async function () {
      const { auction } = await loadFixture(deployFixture);
      expect(await auction.timeRemaining()).to.equal(0);
    });

    it("returns remaining time during active auction", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      const remaining = await auction.timeRemaining();
      expect(remaining).to.be.gt(0);
      expect(remaining).to.be.lte(3600);
    });

    it("returns 0 after auction has ended", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await time.increase(3601);
      expect(await auction.timeRemaining()).to.equal(0);
    });
  });

  // ---- events ----

  describe("events", function () {
    it("emits AuctionStarted on first bid", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      const tx = auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await expect(tx).to.emit(auction, "AuctionStarted");
      // Verify the emitted endTime equals the stored value
      const endTime = await auction.auctionEndTime();
      expect(endTime).to.be.gt(0);
    });

    it("emits NewHighestBid on outbid", async function () {
      const { auction, bidder1, bidder2 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await expect(auction.connect(bidder2).bid({ value: ethers.parseEther("2") }))
        .to.emit(auction, "NewHighestBid")
        .withArgs(0, bidder2.address, ethers.parseEther("2"));
    });

    it("emits AuctionSettled", async function () {
      const { auction, bidder1 } = await loadFixture(deployFixture);
      await auction.connect(bidder1).bid({ value: ethers.parseEther("1") });
      await time.increase(3601);
      await expect(auction.settleAuction())
        .to.emit(auction, "AuctionSettled")
        .withArgs(0, bidder1.address, ethers.parseEther("1"));
    });
  });
});
