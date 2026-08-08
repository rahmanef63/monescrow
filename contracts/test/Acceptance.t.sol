// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";

/// @notice The money is already in the contract the moment it is created, so the two doors
///         at the front of the agreement are the ones that decide whether it ever starts:
///         the freelancer accepting the terms, or the client withdrawing the offer. Both
///         must be shut to everyone else, both must be one-way, and pulling the offer must
///         return every single wei.
contract AcceptanceTest is BaseTest {
    /*//////////////////////////////////////////////////////////////
                                 ACCEPT
    //////////////////////////////////////////////////////////////*/

    /// Only the named freelancer can accept, so nobody else can bind the client to a
    /// counterparty they never agreed to — not the client themselves, not the arbiter who
    /// is supposed to stay neutral, not a passer-by.
    function test_RevertWhen_SomeoneOtherThanTheFreelancerAccepts() public {
        Escrow e = _newEscrow();

        vm.prank(client);
        vm.expectRevert(Escrow.NotFreelancer.selector);
        e.accept();

        vm.prank(arbiter);
        vm.expectRevert(Escrow.NotFreelancer.selector);
        e.accept();

        vm.prank(stranger);
        vm.expectRevert(Escrow.NotFreelancer.selector);
        e.accept();

        assertEq(e.acceptedAt(), 0, "still unaccepted after three impostors");

        // And the door is not simply nailed shut: the real freelancer still gets in.
        vm.prank(freelancer);
        e.accept();
        assertEq(e.acceptedAt(), uint64(block.timestamp), "the named freelancer can accept");
    }

    /// Acceptance is timestamped at the moment it happens, because that instant is the
    /// public record of when both sides were bound to the same terms.
    function test_AcceptRecordsTheTimeAndEmitsAccepted() public {
        Escrow e = _newEscrow();
        assertEq(e.acceptedAt(), 0, "unaccepted at birth");

        vm.warp(block.timestamp + 3 days);
        uint64 expectedAt = uint64(block.timestamp);

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Accepted(freelancer, expectedAt);

        vm.prank(freelancer);
        e.accept();

        assertEq(e.acceptedAt(), expectedAt, "acceptedAt is the block it happened in");
        assertEq(e.summary(client).acceptedAt, expectedAt, "the summary the UI reads agrees");
        assertFalse(e.cancelled(), "accepting does not cancel anything");
    }

    /// Acceptance happens once. A second accept must not be able to move the recorded
    /// start of the agreement forward and quietly rewrite when the clock began.
    function test_RevertWhen_AcceptingTwice() public {
        Escrow e = _acceptedEscrow();
        uint64 firstAcceptance = e.acceptedAt();

        vm.warp(block.timestamp + 5 days);

        vm.prank(freelancer);
        vm.expectRevert(Escrow.AlreadyAccepted.selector);
        e.accept();

        assertEq(e.acceptedAt(), firstAcceptance, "the original acceptance time survives");
    }

    /// The deadline is the last moment work can be agreed to; one second before it the
    /// offer is still live, which is what makes the rejection at the deadline meaningful.
    function test_AcceptOneSecondBeforeTheDeadline() public {
        Escrow e = _newEscrow();
        uint64 dl = e.deadline();

        vm.warp(dl - 1);

        vm.prank(freelancer);
        e.accept();

        assertEq(e.acceptedAt(), dl - 1, "accepted in the final second");
    }

    /// The deadline check is inclusive: at exactly the deadline the offer has expired, so
    /// a freelancer cannot accept a job in the same second it is already too late to
    /// submit any work for.
    function test_RevertWhen_AcceptingExactlyAtTheDeadline() public {
        Escrow e = _newEscrow();
        uint64 dl = e.deadline();

        vm.warp(dl);

        vm.prank(freelancer);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        e.accept();

        assertEq(e.acceptedAt(), 0, "expired offers stay unaccepted");
    }

    /// Long after the deadline the offer is just as dead — the client's funds cannot be
    /// dragged into a job that can no longer be delivered.
    function test_RevertWhen_AcceptingAfterTheDeadline() public {
        Escrow e = _newEscrow();
        uint64 dl = e.deadline();

        vm.warp(uint256(dl) + 30 days);

        vm.prank(freelancer);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        e.accept();

        assertEq(e.acceptedAt(), 0, "expired offers stay unaccepted");
    }

    /// A withdrawn offer cannot be accepted. Once the client has cancelled and been
    /// credited the refund, an acceptance would bind them to work they no longer fund.
    function test_RevertWhen_AcceptingACancelledEscrow() public {
        Escrow e = _newEscrow();

        vm.prank(client);
        e.cancel();

        vm.prank(freelancer);
        vm.expectRevert(Escrow.EscrowCancelled.selector);
        e.accept();

        assertEq(e.acceptedAt(), 0, "a cancelled escrow is never accepted");
        assertEq(e.owed(client), TOTAL, "the refund is untouched");
        assertEq(e.owed(freelancer), 0, "the freelancer is owed nothing");
    }

    /*//////////////////////////////////////////////////////////////
                                 CANCEL
    //////////////////////////////////////////////////////////////*/

    /// Only the client who funded the job can pull the offer. If the freelancer, the
    /// arbiter or a stranger could cancel, anyone could force a refund the client never
    /// asked for and kill an agreement that was about to start.
    function test_RevertWhen_SomeoneOtherThanTheClientCancels() public {
        Escrow e = _newEscrow();

        vm.prank(freelancer);
        vm.expectRevert(Escrow.NotClient.selector);
        e.cancel();

        vm.prank(arbiter);
        vm.expectRevert(Escrow.NotClient.selector);
        e.cancel();

        vm.prank(stranger);
        vm.expectRevert(Escrow.NotClient.selector);
        e.cancel();

        assertFalse(e.cancelled(), "still live after three impostors");
        assertEq(e.refundedAmount(), 0, "no refund was booked");
        assertEq(e.owed(client), 0, "nobody was credited");
        _assertEveryMilestone(e, Escrow.MState.Pending, "milestone untouched");

        // And the door is not simply nailed shut: the client still gets in.
        vm.prank(client);
        e.cancel();
        assertTrue(e.cancelled(), "the client can cancel");
    }

    /// Cancelling before anyone accepted returns the whole job, not part of it: every
    /// milestone is marked Refunded and the client is credited exactly what they funded.
    function test_CancelBeforeAcceptanceRefundsEveryMilestone() public {
        Escrow e = _newEscrow();
        assertEq(e.totalAmount(), TOTAL, "funded in full at creation");

        vm.prank(client);
        e.cancel();

        assertTrue(e.cancelled(), "marked cancelled");
        _assertEveryMilestone(e, Escrow.MState.Refunded, "milestone refunded");
        assertEq(e.refundedAmount(), e.totalAmount(), "refunded the whole job");
        assertEq(e.refundedAmount(), TOTAL, "refunded exactly what was funded");
        assertEq(e.releasedAmount(), 0, "nothing was released to the freelancer");
        assertEq(e.owed(client), TOTAL, "the client is credited the full amount");
        assertEq(e.owed(freelancer), 0, "the freelancer is credited nothing");
    }

    /// The refund is real money, not just a number: after cancelling, the client's own
    /// withdraw() hands back the full amount and empties the escrow.
    function test_ClientWithdrawsTheFullAmountAfterCancelling() public {
        Escrow e = _newEscrow();
        uint256 balanceBefore = client.balance;
        assertEq(address(e).balance, TOTAL, "escrow holds the funds");

        vm.prank(client);
        e.cancel();

        vm.prank(client);
        e.withdraw();

        assertEq(client.balance, balanceBefore + TOTAL, "client got every wei back");
        assertEq(address(e).balance, 0, "escrow drained");
        assertEq(e.owed(client), 0, "credit consumed");

        // Pull-based means the credit is spent, not standing: a second pull finds nothing.
        vm.prank(client);
        vm.expectRevert(Escrow.NothingOwed.selector);
        e.withdraw();

        assertEq(client.balance, balanceBefore + TOTAL, "no double refund");
    }

    /// Once the freelancer has accepted, the client can no longer walk away unilaterally.
    /// Work may already be under way, and the only routes out from here are the deadline
    /// reclaim or the arbiter.
    function test_RevertWhen_CancellingAfterTheFreelancerAccepted() public {
        Escrow e = _acceptedEscrow();

        vm.prank(client);
        vm.expectRevert(Escrow.AlreadyStarted.selector);
        e.cancel();

        assertFalse(e.cancelled(), "the agreement is still live");
        assertEq(e.refundedAmount(), 0, "no refund was booked");
        assertEq(e.owed(client), 0, "the client was not credited");
        _assertEveryMilestone(e, Escrow.MState.Pending, "milestone untouched");
    }

    /// Cancelling is idempotent only in the sense that it cannot be repeated: a second
    /// cancel must not credit the client a second time and let them drain an escrow that
    /// only ever held one job's worth of funds.
    function test_RevertWhen_CancellingTwice() public {
        Escrow e = _newEscrow();

        vm.prank(client);
        e.cancel();

        vm.prank(client);
        vm.expectRevert(Escrow.EscrowCancelled.selector);
        e.cancel();

        assertEq(e.refundedAmount(), TOTAL, "refund counted exactly once");
        assertEq(e.owed(client), TOTAL, "credited exactly once");
        assertEq(address(e).balance, TOTAL, "the escrow still only holds one job");
    }

    /// The cancellation is legible on-chain without an indexer: one Refunded per milestone
    /// with its own amount, then one Cancelled carrying the total handed back.
    function test_CancelEmitsCancelledAndOneRefundPerMilestone() public {
        Escrow e = _newEscrow();

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Refunded(0, M0, "cancelled before acceptance");
        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Refunded(1, M1, "cancelled before acceptance");
        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Refunded(2, M2, "cancelled before acceptance");
        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Cancelled(client, TOTAL);

        vm.prank(client);
        e.cancel();

        assertEq(e.refundedAmount(), TOTAL, "the logged total matches the books");
    }

    /// A cancelled escrow is terminal: time passing does not reopen it, the freelancer can
    /// never accept it, and with no acceptance there is no way to submit work into it. The
    /// funds can only ever go back to the client.
    function test_CancelledEscrowIsTerminal() public {
        Escrow e = _newEscrow();

        vm.prank(client);
        e.cancel();

        vm.warp(block.timestamp + 7 days);

        vm.prank(freelancer);
        vm.expectRevert(Escrow.EscrowCancelled.selector);
        e.accept();

        vm.prank(freelancer);
        vm.expectRevert(Escrow.NotAccepted.selector);
        e.submit(0, EVIDENCE);

        assertEq(e.acceptedAt(), 0, "never accepted");
        assertEq(e.milestoneAt(0).submissions, 0, "no work was ever submitted");
        assertEq(e.releasedAmount(), 0, "nothing ever released");
        assertEq(e.refundedAmount(), TOTAL, "the whole job stayed refunded");
        assertEq(e.owed(client), TOTAL, "the client still holds the whole credit");
        assertEq(e.owed(freelancer), 0, "the freelancer is owed nothing");
        _assertEveryMilestone(e, Escrow.MState.Refunded, "milestone still refunded");
    }

    /// Cancelling refunds only what is still unrefunded. An offer the freelancer never
    /// took up still expires, and after the deadline the client may reclaim a milestone
    /// out of it — that milestone's money has already been credited once. Cancelling
    /// afterwards is still legal, and it must walk past that milestone rather than pay for
    /// it a second time: an escrow that credits more than it holds cannot honour the
    /// credit, and the client's own withdraw() would revert on a refund they are owed.
    function test_CancelAfterAReclaimDoesNotRefundTheSameMilestoneTwice() public {
        Escrow e = _newEscrow();
        uint64 dl = e.deadline();

        // Nobody ever accepted, the deadline arrives, and the client takes one milestone
        // back the only way an unaccepted escrow allows.
        vm.warp(dl);
        vm.prank(client);
        e.reclaim(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Refunded), "milestone 0 came back on the deadline");
        assertEq(e.refundedAmount(), M0, "credited once, for exactly that milestone");
        assertEq(e.owed(client), M0, "and only that milestone");

        // cancel() is still open: nobody accepted, so the offer can still be withdrawn.
        // Only the two milestones left standing may be handed back by it.
        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Refunded(1, M1, "cancelled before acceptance");
        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Refunded(2, M2, "cancelled before acceptance");
        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Cancelled(client, TOTAL - M0);

        vm.prank(client);
        e.cancel();

        assertTrue(e.cancelled(), "the offer was withdrawn");
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Refunded), "the reclaimed milestone was left alone");
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Refunded), "milestone 1 came back with the cancellation");
        assertEq(uint256(_state(e, 2)), uint256(Escrow.MState.Refunded), "milestone 2 came back with the cancellation");

        assertEq(e.refundedAmount(), TOTAL, "the job was refunded once over, not once and a bit");
        assertEq(e.owed(client), TOTAL, "the client is credited the job exactly once");
        assertEq(e.releasedAmount(), 0, "the freelancer never earned anything");
        assertEq(e.owed(freelancer), 0, "and is credited nothing");
        assertLe(e.owed(client), address(e).balance, "the escrow can cover everything it promised");

        // The credit is payable, which is the point: a double-booked milestone would make
        // this transfer ask for more than the contract holds.
        uint256 balanceBefore = client.balance;
        vm.prank(client);
        e.withdraw();

        assertEq(client.balance, balanceBefore + TOTAL, "the client got the whole job back, once");
        assertEq(address(e).balance, 0, "escrow drained to the wei");
        assertEq(e.owed(client), 0, "credit consumed");
    }

    /// The same guard at its limit: if the client reclaimed every milestone after the
    /// deadline, a later cancel has nothing left to hand back. It must credit zero and say
    /// so — not re-refund a job the client has already been credited for in full.
    function test_CancelAfterEverythingWasReclaimedCreditsNothingMore() public {
        Escrow e = _newEscrow();
        uint64 dl = e.deadline();

        vm.warp(uint256(dl) + 1 days);
        vm.startPrank(client);
        e.reclaim(0);
        e.reclaim(1);
        e.reclaim(2);
        vm.stopPrank();

        _assertEveryMilestone(e, Escrow.MState.Refunded, "milestone reclaimed at the deadline");
        assertEq(e.refundedAmount(), TOTAL, "the whole job is already booked back");
        assertEq(e.owed(client), TOTAL, "and already credited in full");

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Cancelled(client, 0);

        vm.prank(client);
        e.cancel();

        assertTrue(e.cancelled(), "the empty offer was still withdrawable");
        _assertEveryMilestone(e, Escrow.MState.Refunded, "milestone still refunded, unchanged");
        assertEq(e.refundedAmount(), TOTAL, "no milestone was refunded a second time");
        assertEq(e.owed(client), TOTAL, "the client's credit did not double");
        assertLe(e.owed(client), address(e).balance, "the escrow can cover everything it promised");

        uint256 balanceBefore = client.balance;
        vm.prank(client);
        e.withdraw();

        assertEq(client.balance, balanceBefore + TOTAL, "paid out once, in full");
        assertEq(address(e).balance, 0, "escrow drained to the wei");
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _assertEveryMilestone(Escrow e, Escrow.MState expected, string memory what) private view {
        uint256 n = e.milestoneCount();
        assertEq(n, 3, "fixture shape");
        for (uint256 i = 0; i < n; ++i) {
            assertEq(uint256(_state(e, i)), uint256(expected), what);
        }
    }
}
