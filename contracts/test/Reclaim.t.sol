// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";

/// @notice What the deadline does to the money. The deadline is the client's protection
///         against a freelancer who never delivers — but it must not become a way to run
///         out the clock on work that was already proven. Everything unearned goes back to
///         the client; anything a verifier passed in time is untouchable by reclaim and
///         still pays out afterwards.
contract ReclaimTest is BaseTest {
    /// Work never started: once the deadline is past, the client gets that milestone's
    /// money back, credited to their pull balance and counted in refundedAmount.
    function test_ClientReclaimsPendingMilestoneAfterDeadline() public {
        Escrow e = _acceptedEscrow();
        vm.warp(uint256(e.deadline()) + 1);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Pending), "nothing was ever submitted");

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Refunded(0, M0, "deadline passed unearned");

        vm.prank(client);
        e.reclaim(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Refunded), "milestone refunded");
        assertEq(e.owed(client), M0, "client credited the milestone amount");
        assertEq(e.refundedAmount(), M0, "refunded total bumped");
        assertEq(e.owed(freelancer), 0, "freelancer credited nothing");
        assertEq(e.releasedAmount(), 0, "nothing released");
    }

    /// Submitted-but-never-attested is not proven work. Uploading something at the last
    /// minute must not let a freelancer hold the client's money hostage past the deadline.
    function test_ClientReclaimsSubmittedMilestoneAfterDeadline() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(1, EVIDENCE);
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Submitted), "evidence posted, nobody signed it");

        vm.warp(uint256(e.deadline()) + 1);

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Refunded(1, M1, "deadline passed unearned");

        vm.prank(client);
        e.reclaim(1);

        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Refunded), "milestone refunded");
        assertEq(e.owed(client), M1, "client credited");
        assertEq(e.refundedAmount(), M1, "refunded total bumped");
        assertEq(e.owed(freelancer), 0, "unattested submission earns nothing");
    }

    /// THE ONE THAT MATTERS. A milestone the verifier passed before the deadline is out of
    /// reclaim's reach forever, and the challenge window keeps running across the deadline:
    /// the client cannot wait out the clock to seize work that was already shown to be done,
    /// and once the window elapses the freelancer is still paid — deadline long gone.
    function test_RevertWhen_ReclaimingAttestedMilestoneAfterDeadline() public {
        Escrow e = _acceptedEscrow();
        uint64 dl = e.deadline();

        // Delivered and verified with an hour to spare.
        vm.warp(uint256(dl) - 1 hours);
        _submitAndPass(e, 0);

        uint64 releasable = e.releasableAt(0);
        assertEq(releasable, uint64(block.timestamp) + WINDOW, "challenge window outlives the deadline");

        // The deadline passes while the challenge window is still open.
        vm.warp(uint256(dl) + 1);
        assertGt(uint256(releasable), block.timestamp, "window genuinely still open");

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Attested));
        e.reclaim(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "still attested, not seized");
        assertEq(e.owed(client), 0, "client took nothing");
        assertEq(e.refundedAmount(), 0, "nothing refunded");

        // The deadline did not shortcut the window either — it still has to elapse.
        vm.expectRevert(abi.encodeWithSelector(Escrow.ChallengeWindowOpen.selector, releasable));
        e.release(0);

        // Second half: the window elapses and the proven work pays out, deadline or not.
        vm.warp(uint256(releasable));
        uint256 balanceBefore = freelancer.balance;

        vm.prank(stranger);
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "released after the deadline");
        assertEq(e.owed(freelancer), M0, "freelancer credited in full");
        assertEq(e.releasedAmount(), M0, "released total bumped");
        assertEq(e.refundedAmount(), 0, "client never got a share of proven work");

        vm.prank(freelancer);
        e.withdraw();
        assertEq(freelancer.balance, balanceBefore + M0, "and the money actually leaves the escrow");
    }

    /// Before the deadline the milestone still belongs to the job, so the client cannot pull
    /// their funding out from under a freelancer who is still inside the agreed time.
    function test_RevertWhen_ReclaimingBeforeDeadline() public {
        Escrow e = _acceptedEscrow();
        uint64 dl = e.deadline();

        vm.prank(client);
        vm.expectRevert(Escrow.DeadlineNotPassed.selector);
        e.reclaim(0);

        // And at the very last second before the deadline — the check is strict `<`.
        vm.warp(uint256(dl) - 1);

        vm.prank(client);
        vm.expectRevert(Escrow.DeadlineNotPassed.selector);
        e.reclaim(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Pending), "milestone untouched");
        assertEq(e.owed(client), 0, "client credited nothing");
        assertEq(e.refundedAmount(), 0, "nothing refunded");
        assertEq(address(e).balance, TOTAL, "the whole escrow is still funded");
    }

    /// The boundary itself: at exactly `deadline` the time is up. One second decides whether
    /// the money is reclaimable, so the UI and the chain must agree on which side it lands.
    function test_ReclaimAtExactlyTheDeadlineSucceeds() public {
        Escrow e = _acceptedEscrow();
        uint64 dl = e.deadline();

        vm.warp(uint256(dl));
        assertEq(block.timestamp, uint256(dl), "sitting exactly on the deadline");

        vm.prank(client);
        e.reclaim(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Refunded), "reclaimable on the deadline itself");
        assertEq(e.owed(client), M0, "client credited");
        assertEq(e.refundedAmount(), M0, "refunded total bumped");
    }

    /// Reclaim moves the client's own money, so only the client may call it. Nobody else —
    /// not the counterparty, not the arbiter, not a passer-by — can trigger a refund.
    function test_RevertWhen_NonClientReclaims() public {
        Escrow e = _acceptedEscrow();
        vm.warp(uint256(e.deadline()) + 1);

        vm.prank(freelancer);
        vm.expectRevert(Escrow.NotClient.selector);
        e.reclaim(0);

        vm.prank(arbiter);
        vm.expectRevert(Escrow.NotClient.selector);
        e.reclaim(0);

        vm.prank(stranger);
        vm.expectRevert(Escrow.NotClient.selector);
        e.reclaim(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Pending), "milestone untouched");
        assertEq(e.owed(client), 0, "no refund was credited");
        assertEq(e.refundedAmount(), 0, "nothing refunded");
        assertEq(address(e).balance, TOTAL, "the whole escrow is still funded");
    }

    /// A refund is once and for all. Replaying reclaim must not credit the client twice and
    /// drain money that belongs to the other milestones.
    function test_RevertWhen_ReclaimingTwice() public {
        Escrow e = _acceptedEscrow();
        vm.warp(uint256(e.deadline()) + 1);

        vm.prank(client);
        e.reclaim(0);
        assertEq(e.owed(client), M0, "credited once");

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Refunded));
        e.reclaim(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Refunded), "still just refunded");
        assertEq(e.owed(client), M0, "credited exactly once, not twice");
        assertEq(e.refundedAmount(), M0, "refunded total counted once");
    }

    /// Money already earned by the freelancer cannot be clawed back by waiting for the
    /// deadline — a released milestone is settled and reclaim must bounce off it.
    function test_RevertWhen_ReclaimingReleasedMilestone() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(2, EVIDENCE);
        vm.prank(client);
        e.approve(2);
        assertEq(uint256(_state(e, 2)), uint256(Escrow.MState.Released), "client approved it before the deadline");

        vm.warp(uint256(e.deadline()) + 1);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Released));
        e.reclaim(2);

        assertEq(uint256(_state(e, 2)), uint256(Escrow.MState.Released), "still released");
        assertEq(e.owed(freelancer), M2, "freelancer keeps the whole milestone");
        assertEq(e.owed(client), 0, "client clawed back nothing");
        assertEq(e.refundedAmount(), 0, "nothing refunded");
    }

    /// A disputed milestone belongs to the arbiter, not to the deadline. The client cannot
    /// escape a ruling they might lose by objecting and then reclaiming once time runs out.
    function test_RevertWhen_ReclaimingDisputedMilestone() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(1, EVIDENCE);
        vm.prank(client);
        e.dispute(1);
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Disputed), "frozen for the arbiter");

        vm.warp(uint256(e.deadline()) + 1);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Disputed));
        e.reclaim(1);

        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Disputed), "still frozen");
        assertEq(e.owed(client), 0, "client credited nothing");
        assertEq(e.refundedAmount(), 0, "nothing refunded");

        // The arbiter still owns it, and the deadline did not take that away.
        vm.prank(arbiter);
        e.resolveDispute(1, true);
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Released), "arbiter still rules after the deadline");
        assertEq(e.owed(freelancer), M1, "arbiter's ruling, not the clock, decided this");
    }

    /// An index nobody agreed to must be rejected outright, so a typo cannot be interpreted
    /// as a claim on some other milestone's money.
    function test_RevertWhen_ReclaimIndexOutOfRange() public {
        Escrow e = _acceptedEscrow();
        vm.warp(uint256(e.deadline()) + 1);

        uint256 count = e.milestoneCount();

        vm.prank(client);
        vm.expectRevert(Escrow.BadMilestone.selector);
        e.reclaim(count);

        vm.prank(client);
        vm.expectRevert(Escrow.BadMilestone.selector);
        e.reclaim(99);

        assertEq(e.milestoneCount(), count, "no milestone was conjured up");
        assertEq(e.owed(client), 0, "client credited nothing");
        assertEq(e.refundedAmount(), 0, "nothing refunded");
        assertEq(address(e).balance, TOTAL, "the whole escrow is still funded");
    }

    /// The books must balance at the end of a job that half-finished: the client withdraws
    /// exactly what was unearned, and what stays behind in the contract is exactly what the
    /// freelancer is still owed. No wei is invented or stranded.
    function test_ClientWithdrawsExactlyTheReclaimedSum() public {
        Escrow e = _acceptedEscrow();

        // Milestone 0 is earned and settled; 1 was submitted but never attested; 2 is
        // untouched. Only the last two are reclaimable.
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        vm.prank(client);
        e.approve(0);

        vm.prank(freelancer);
        e.submit(1, EVIDENCE);

        vm.warp(uint256(e.deadline()) + 1);

        vm.startPrank(client);
        e.reclaim(1);
        e.reclaim(2);
        vm.stopPrank();

        uint256 unearned = uint256(M1) + uint256(M2);
        assertEq(e.owed(client), unearned, "client owed exactly the unearned milestones");
        assertEq(e.refundedAmount(), unearned, "refunded total matches");
        assertEq(e.releasedAmount(), M0, "released total unchanged");
        assertEq(e.releasedAmount() + e.refundedAmount(), e.totalAmount(), "every wei is accounted for");

        uint256 clientBefore = client.balance;

        vm.prank(client);
        e.withdraw();

        assertEq(client.balance, clientBefore + unearned, "client received exactly the reclaimed sum");
        assertEq(e.owed(client), 0, "client's pull balance cleared");
        assertEq(e.owed(freelancer), M0, "freelancer's credit untouched by the reclaims");
        assertEq(address(e).balance, M0, "what is left in escrow is exactly what is still owed");
        assertEq(address(e).balance, e.owed(freelancer), "remaining balance equals remaining obligation");
    }
}
