// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {ReentrantFreelancer, RejectingFreelancer} from "./helpers/Attackers.sol";

/// @dev The two attacker helpers expose the same self-driving surface. This interface only
///      names it so one local fixture can drive either of them — it adds no behaviour.
interface IContractFreelancer {
    function doAccept() external;
    function doSubmit(uint256 i, bytes32 evidence) external;
}

/// @notice The payout path. Money only ever leaves this contract through `withdraw()`,
///         called by the account it belongs to, one credit at a time. Everything here
///         exists to prove that a release or a refund is only a *credit* — the ether does
///         not move until the owner pulls it, it cannot be pulled twice, it cannot be
///         pulled by somebody else, and a payee that misbehaves on receipt loses nothing.
contract WithdrawTest is BaseTest {
    /*//////////////////////////////////////////////////////////////
                          FREELANCER PULLS PAY
    //////////////////////////////////////////////////////////////*/

    /// Releasing a milestone must not push ether anywhere: it credits the freelancer, and
    /// only their own `withdraw()` moves the exact credited amount to their address and
    /// clears it. A freelancer who never withdraws leaves the money in the escrow.
    function test_FreelancerWithdrawsExactlyWhatWasReleased() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        vm.warp(block.timestamp + WINDOW);
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "milestone released");
        assertEq(e.owed(freelancer), M0, "release credits, it does not pay");
        assertEq(freelancer.balance, 10 ether, "nothing pushed to the freelancer yet");
        assertEq(address(e).balance, TOTAL, "escrow still holds every wei");

        uint256 before = freelancer.balance;

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Withdrawn(freelancer, M0);

        vm.prank(freelancer);
        e.withdraw();

        assertEq(freelancer.balance - before, M0, "withdraw moved exactly the credited amount");
        assertEq(e.owed(freelancer), 0, "credit cleared");
        assertEq(address(e).balance, TOTAL - M0, "escrow lighter by exactly that milestone");
    }

    /// Two separate releases produce two separate credits: withdrawing after the first one
    /// must not pre-pay the second, and the second withdrawal must pay only the second
    /// milestone rather than re-paying everything released so far.
    function test_PartialWithdrawalsAcrossMilestones() public {
        Escrow e = _acceptedEscrow();

        _submitAndPass(e, 0);
        vm.warp(block.timestamp + WINDOW);
        e.release(0);

        uint256 beforeFirst = freelancer.balance;
        vm.prank(freelancer);
        e.withdraw();
        assertEq(freelancer.balance - beforeFirst, M0, "first withdrawal pays milestone 0 only");
        assertEq(address(e).balance, TOTAL - M0, "only milestone 0 has left the escrow");

        _submitAndPass(e, 1);
        vm.warp(block.timestamp + WINDOW);
        e.release(1);

        assertEq(e.owed(freelancer), M1, "only the newly released milestone is owed");

        uint256 beforeSecond = freelancer.balance;
        vm.prank(freelancer);
        e.withdraw();

        assertEq(freelancer.balance - beforeSecond, M1, "second withdrawal pays milestone 1 only");
        assertEq(e.owed(freelancer), 0, "credit cleared again");
        assertEq(address(e).balance, TOTAL - uint256(M0) - M1, "milestone 2 still escrowed");
        assertEq(e.releasedAmount(), uint256(M0) + M1, "released total matches what was paid out");
    }

    /*//////////////////////////////////////////////////////////////
                            CLIENT PULLS BACK
    //////////////////////////////////////////////////////////////*/

    /// Cancelling an unaccepted offer must not push the refund back to the client either —
    /// the client is credited and pulls it with the same `withdraw()` the freelancer uses.
    function test_ClientWithdrawsAfterCancel() public {
        Escrow e = _newEscrow();

        vm.prank(client);
        e.cancel();

        assertEq(e.owed(client), TOTAL, "cancel credits the whole pot to the client");
        assertEq(address(e).balance, TOTAL, "cancel pushed nothing");

        uint256 before = client.balance;

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Withdrawn(client, TOTAL);

        vm.prank(client);
        e.withdraw();

        assertEq(client.balance - before, TOTAL, "client pulled the full refund");
        assertEq(e.owed(client), 0, "credit cleared");
        assertEq(address(e).balance, 0, "escrow fully drained");
    }

    /// A deadline reclaim is a refund, so it credits the client rather than paying them,
    /// and only the reclaimed milestones — work already released stays released.
    function test_ClientWithdrawsAfterReclaim() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        vm.warp(e.deadline());

        vm.startPrank(client);
        e.reclaim(0); // Submitted but never attested
        e.reclaim(1); // never touched
        vm.stopPrank();

        assertEq(e.owed(client), uint256(M0) + M1, "both unearned milestones credited back");
        assertEq(address(e).balance, TOTAL, "reclaim pushed nothing");

        uint256 before = client.balance;

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Withdrawn(client, uint256(M0) + M1);

        vm.prank(client);
        e.withdraw();

        assertEq(client.balance - before, uint256(M0) + M1, "client pulled exactly the reclaimed amount");
        assertEq(e.owed(client), 0, "credit cleared");
        assertEq(address(e).balance, M2, "the un-reclaimed milestone is untouched");
    }

    /*//////////////////////////////////////////////////////////////
                              NOTHING OWED
    //////////////////////////////////////////////////////////////*/

    /// A credit is spent by the first withdrawal. Calling again must revert rather than
    /// pay a second time out of somebody else's escrowed milestones.
    function test_RevertWhen_WithdrawingTwice() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        vm.warp(block.timestamp + WINDOW);
        e.release(0);

        vm.prank(freelancer);
        e.withdraw();

        uint256 balanceAfterFirst = freelancer.balance;
        uint256 escrowAfterFirst = address(e).balance;

        vm.prank(freelancer);
        vm.expectRevert(Escrow.NothingOwed.selector);
        e.withdraw();

        assertEq(freelancer.balance, balanceAfterFirst, "second withdrawal paid nothing");
        assertEq(address(e).balance, escrowAfterFirst, "escrow untouched by the second attempt");
        assertEq(e.owed(freelancer), 0, "still owed nothing");
    }

    /// An account with no credit cannot drain the escrow just because it holds ether for
    /// somebody else. `withdraw()` is open to anyone, but only pays what it owes them.
    function test_RevertWhen_AccountIsOwedNothing() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        vm.warp(block.timestamp + WINDOW);
        e.release(0);

        uint256 strangerBefore = stranger.balance;
        uint256 escrowBefore = address(e).balance;

        assertEq(e.owed(stranger), 0, "stranger is owed nothing to begin with");

        vm.prank(stranger);
        vm.expectRevert(Escrow.NothingOwed.selector);
        e.withdraw();

        assertEq(stranger.balance, strangerBefore, "stranger got nothing");
        assertEq(address(e).balance, escrowBefore, "escrow untouched");
        assertEq(e.owed(freelancer), M0, "the freelancer's credit is still intact");
    }

    /*//////////////////////////////////////////////////////////////
                               REENTRANCY
    //////////////////////////////////////////////////////////////*/

    /// A payee that calls back into `withdraw()` from its `receive()` must be paid once and
    /// once only. The guard blocks the nested call — the attacker swallows that revert, so
    /// the outer withdrawal still succeeds and the escrow loses exactly one milestone. The
    /// unreleased milestone is still sitting in the escrow, so a second payment would be
    /// real theft, not just an overdraft that would have bounced on its own.
    function test_ReentrantWithdrawIsBlockedAndPaysOnce() public {
        ReentrantFreelancer attacker = new ReentrantFreelancer();
        Escrow e = _escrowWithFreelancer(address(attacker));
        attacker.setEscrow(e);

        _driveToReleased(e, address(attacker));

        assertEq(e.owed(address(attacker)), M0, "attacker credited once");
        assertEq(address(attacker).balance, 0, "attacker holds nothing yet");
        assertEq(address(e).balance, uint256(M0) + M1, "escrow holds both milestones");

        attacker.attackWithdraw();

        assertFalse(attacker.reentrySucceeded(), "nested withdraw must never succeed");
        assertEq(attacker.reentryAttempts(), 1, "the attacker did try to re-enter exactly once");
        assertEq(address(attacker).balance, M0, "attacker received the milestone EXACTLY once");
        assertEq(e.owed(address(attacker)), 0, "credit cleared, not doubled");
        assertEq(address(e).balance, M1, "the unreleased milestone was not drained");
    }

    /*//////////////////////////////////////////////////////////////
                            FAILED TRANSFER
    //////////////////////////////////////////////////////////////*/

    /// If the payee rejects the ether, the withdrawal must revert and the credit must
    /// survive intact. A guard that zeroed `owed` and then swallowed the failed send would
    /// destroy the freelancer's money while leaving it stranded in the escrow forever.
    function test_RevertWhen_RecipientRejectsTheTransfer() public {
        RejectingFreelancer payee = new RejectingFreelancer();
        Escrow e = _escrowWithFreelancer(address(payee));
        payee.setEscrow(e);

        _driveToReleased(e, address(payee));

        uint256 owedBefore = e.owed(address(payee));
        uint256 escrowBefore = address(e).balance;
        assertEq(owedBefore, M0, "payee credited the released milestone");

        vm.expectRevert(Escrow.TransferFailed.selector);
        payee.doWithdraw();

        uint256 owedAfter = e.owed(address(payee));

        assertEq(owedAfter, owedBefore, "credit rolled back, not zeroed");
        assertEq(owedAfter, M0, "the full amount is still claimable");
        assertEq(address(payee).balance, 0, "nothing was transferred");
        assertEq(address(e).balance, escrowBefore, "the ether never left the escrow");
    }

    /*//////////////////////////////////////////////////////////////
                            TWO PAYEES AT ONCE
    //////////////////////////////////////////////////////////////*/

    /// One milestone released and another refunded leaves both parties credited at the same
    /// time. Each pulls their own share; withdrawing does not let either side reach into
    /// the ether that is earmarked for the other.
    function test_BothPartiesWithdrawOnlyTheirOwnShare() public {
        Escrow e = _acceptedEscrow();

        // Milestone 0 goes to the freelancer.
        _submitAndPass(e, 0);
        vm.warp(block.timestamp + WINDOW);
        e.release(0);

        // Milestone 1 goes back to the client via a dispute the arbiter rules on.
        vm.prank(freelancer);
        e.submit(1, EVIDENCE);
        vm.prank(client);
        e.dispute(1);
        vm.prank(arbiter);
        e.resolveDispute(1, false);

        assertEq(e.owed(freelancer), M0, "freelancer owed the released milestone");
        assertEq(e.owed(client), M1, "client owed the refunded milestone");
        assertEq(address(e).balance, TOTAL, "both credits still sitting in the escrow");

        uint256 freelancerBefore = freelancer.balance;
        vm.prank(freelancer);
        e.withdraw();

        assertEq(freelancer.balance - freelancerBefore, M0, "freelancer pulled only their own share");
        assertEq(e.owed(freelancer), 0, "freelancer credit cleared");
        assertEq(e.owed(client), M1, "the client's credit was not touched");
        assertEq(address(e).balance, TOTAL - M0, "escrow still holds the client's share and milestone 2");

        // The freelancer cannot come back for the client's money even though the escrow
        // still holds it.
        vm.prank(freelancer);
        vm.expectRevert(Escrow.NothingOwed.selector);
        e.withdraw();

        assertEq(e.owed(client), M1, "the client's credit survived the freelancer's second attempt");

        uint256 clientBefore = client.balance;
        vm.prank(client);
        e.withdraw();

        assertEq(client.balance - clientBefore, M1, "client pulled only their own share");
        assertEq(e.owed(client), 0, "client credit cleared");
        assertEq(address(e).balance, M2, "only the untouched milestone remains");
    }

    /*//////////////////////////////////////////////////////////////
                             CONSERVATION
    //////////////////////////////////////////////////////////////*/

    /// The escrow is a closed pot: it is funded once with `totalAmount` and every wei that
    /// leaves it leaves through a withdrawal. At every point the balance must equal
    /// `totalAmount` minus the sum of everything withdrawn so far — no leak, no shortfall.
    function test_EscrowBalanceIsTotalMinusEverythingWithdrawn() public {
        Escrow e = _acceptedEscrow();
        assertEq(address(e).balance, TOTAL, "funded up front with the whole job");
        assertEq(e.totalAmount(), TOTAL, "totalAmount matches the funding");

        // Milestone 0: attested, window elapses, anyone triggers the release.
        _submitAndPass(e, 0);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        e.release(0);

        // Milestone 1: the client approves it by hand.
        vm.prank(freelancer);
        e.submit(1, EVIDENCE);
        vm.prank(client);
        e.approve(1);

        // Milestone 2: never delivered, reclaimed by the client after the deadline.
        vm.warp(e.deadline());
        vm.prank(client);
        e.reclaim(2);

        assertEq(e.owed(freelancer), uint256(M0) + M1, "freelancer credited both earned milestones");
        assertEq(e.owed(client), M2, "client credited the unearned one");
        assertEq(address(e).balance, TOTAL, "crediting alone moves no ether");

        uint256 withdrawn;

        vm.prank(freelancer);
        e.withdraw();
        withdrawn += uint256(M0) + M1;
        assertEq(address(e).balance, TOTAL - withdrawn, "balance is total minus everything withdrawn");

        vm.prank(client);
        e.withdraw();
        withdrawn += M2;
        assertEq(address(e).balance, TOTAL - withdrawn, "balance is total minus everything withdrawn");

        assertEq(withdrawn, TOTAL, "every wei of the job was accounted for");
        assertEq(e.releasedAmount() + e.refundedAmount(), TOTAL, "released plus refunded reconciles to the total");
        assertEq(address(e).balance, 0, "nothing stranded in the escrow");
    }

    /*//////////////////////////////////////////////////////////////
                             LOCAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev A two-milestone escrow whose freelancer is `f` — used to put one of the attacker
    ///      contracts from `helpers/Attackers.sol` on the receiving end. Two milestones, not
    ///      one, on purpose: only milestone 0 is ever released, so the escrow still holds
    ///      milestone 1's ether while the payee withdraws. With a single milestone a
    ///      double-payment would bounce for lack of funds and the test would pass without
    ///      the reentrancy guard doing anything.
    function _escrowWithFreelancer(address f) private returns (Escrow) {
        Escrow.Params memory p = _params();
        p.freelancer = f;

        Escrow.MilestoneInit[] memory ms = new Escrow.MilestoneInit[](2);
        ms[0] = Escrow.MilestoneInit({amount: M0, check: Escrow.Check.Http, criteriaHash: keccak256("http")});
        ms[1] = Escrow.MilestoneInit({amount: M1, check: Escrow.Check.Http, criteriaHash: keccak256("http two")});

        return _createEscrow(client, p, ms, uint256(M0) + M1);
    }

    /// @dev Accept, submit, pass and release milestone 0 of a contract-freelancer escrow.
    ///      `_submitAndPass` cannot be reused here: it pranks the EOA freelancer, while
    ///      these escrows are held by a contract that must call for itself.
    function _driveToReleased(Escrow e, address contractFreelancer) private {
        IContractFreelancer(contractFreelancer).doAccept();
        IContractFreelancer(contractFreelancer).doSubmit(0, EVIDENCE);

        bytes memory sig = _signCurrent(e, verifierPk, 0, true);
        e.attest(0, 1, true, REPORT, sig);

        vm.warp(block.timestamp + WINDOW);
        e.release(0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "milestone released to the contract");
    }
}
