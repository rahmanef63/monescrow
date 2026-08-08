// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";

/// @notice The client's objection and the arbiter's ruling. A passing attestation is only
///         a proposal, so the client must always be able to freeze a milestone before the
///         clock pays it out — and once frozen, nobody but the arbiter may unfreeze it.
///         These tests pin down both halves: who may object, and who may rule.
contract DisputeTest is BaseTest {
    /*//////////////////////////////////////////////////////////////
                             FREEZING THE WORK
    //////////////////////////////////////////////////////////////*/

    /// The client can object the moment evidence lands, before any verifier has looked at
    /// it, so a deliverable the client already knows is wrong never gets the chance to
    /// become releasable in the first place.
    function test_ClientCanDisputeFromSubmitted() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Submitted), "submitted before the objection");

        vm.expectEmit(true, true, false, true, address(e));
        emit Escrow.Disputed(0, client);
        vm.prank(client);
        e.dispute(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Disputed), "frozen straight from Submitted");
        assertEq(e.releasedAmount(), 0, "freezing pays nobody");
        assertEq(e.refundedAmount(), 0, "freezing refunds nobody");
        assertEq(e.owed(freelancer), 0, "freelancer credited nothing");
        assertEq(e.owed(client), 0, "client credited nothing");
    }

    /// A passing attestation only starts a countdown, it does not decide anything, so the
    /// client can still object while the challenge window is running — and the objection
    /// stops the countdown dead.
    function test_ClientCanDisputeFromAttested() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "attested before the objection");
        assertEq(e.challengeRemaining(0), WINDOW, "clock running before the objection");

        vm.expectEmit(true, true, false, true, address(e));
        emit Escrow.Disputed(0, client);
        vm.prank(client);
        e.dispute(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Disputed), "frozen straight from Attested");
        assertEq(e.challengeRemaining(0), 0, "no countdown left to run");
        assertEq(e.releasableAt(0), 0, "no automatic release scheduled any more");
        assertEq(e.releasedAmount(), 0, "freezing pays nobody");
    }

    /// Only the client is a party with money at risk here. If the freelancer, the arbiter
    /// or a passer-by could freeze a milestone, any of them could stall a payout the
    /// client never objected to.
    function test_RevertWhen_NonClientDisputes() public {
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        vm.prank(freelancer);
        vm.expectRevert(Escrow.NotClient.selector);
        e.dispute(0);

        vm.prank(arbiter);
        vm.expectRevert(Escrow.NotClient.selector);
        e.dispute(0);

        vm.prank(stranger);
        vm.expectRevert(Escrow.NotClient.selector);
        e.dispute(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Submitted), "never frozen by an outsider");
    }

    /// There is nothing to object to until work has been submitted, so the client cannot
    /// pre-emptively freeze a milestone the freelancer has not touched yet.
    function test_RevertWhen_DisputingPendingMilestone() public {
        Escrow e = _acceptedEscrow();
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Pending), "nothing submitted yet");

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Pending));
        e.dispute(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Pending), "still pending");
    }

    /// Money that is already out the door cannot be clawed back by objecting late — a
    /// released milestone is final, so the client's window to speak up really is a window.
    function test_RevertWhen_DisputingAnAlreadyReleasedMilestone() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);

        vm.warp(block.timestamp + WINDOW);
        e.release(0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "released by the clock");

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Released));
        e.dispute(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "stays released");
        assertEq(e.owed(freelancer), M0, "freelancer keeps the credit");
        assertEq(e.releasedAmount(), M0, "released total unchanged");
        assertEq(e.owed(client), 0, "client claws back nothing");
    }

    /*//////////////////////////////////////////////////////////////
                        THE FREEZE BEATS THE CLOCK
    //////////////////////////////////////////////////////////////*/

    /// The core of the whole mechanism: an objection beats the clock. Once the client has
    /// frozen a milestone, the automatic "silence means yes" release stays shut forever —
    /// even long after the challenge window would have elapsed — so waiting the client out
    /// is not a way to overrule them.
    function test_RevertWhen_ReleasingDisputedMilestoneAfterWindowElapsed() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);

        uint64 wouldHaveReleasedAt = e.releasableAt(0);
        assertGt(uint256(wouldHaveReleasedAt), block.timestamp, "window still running when the client objects");

        vm.prank(client);
        e.dispute(0);

        // Far past the moment silence would have paid out.
        vm.warp(uint256(wouldHaveReleasedAt) + 365 days);
        assertGt(block.timestamp, uint256(wouldHaveReleasedAt), "the clock has long since run out");

        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Disputed));
        e.release(0);

        // Not by the freelancer either, and not by a helpful bystander.
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Disputed));
        e.release(0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Disputed));
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Disputed), "still frozen, waiting on the arbiter");
        assertEq(e.releasedAmount(), 0, "not a wei released by the clock");
        assertEq(e.owed(freelancer), 0, "freelancer credited nothing");
        assertEq(address(e).balance, TOTAL, "escrow still holds everything it was funded with");
    }

    /// A freeze is not a thing the client can quietly undo by approving instead: once the
    /// milestone is in front of the arbiter, the arbiter's ruling is the only exit. That
    /// keeps the dispute record honest for both sides.
    function test_RevertWhen_ApprovingDisputedMilestone() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);

        vm.prank(client);
        e.dispute(0);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Disputed));
        e.approve(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Disputed), "still frozen");
        assertEq(e.owed(freelancer), 0, "no payout slipped through approve()");
        assertEq(e.releasedAmount(), 0, "released total untouched");
    }

    /*//////////////////////////////////////////////////////////////
                             THE ARBITER RULES
    //////////////////////////////////////////////////////////////*/

    /// The arbiter is the single named human judge. Neither party — nor a stranger — may
    /// rule on their own dispute, or the freeze would be worthless to whoever loses.
    function test_RevertWhen_NonArbiterResolvesDispute() public {
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        vm.prank(client);
        e.dispute(0);

        vm.prank(client);
        vm.expectRevert(Escrow.NotArbiter.selector);
        e.resolveDispute(0, false);

        vm.prank(freelancer);
        vm.expectRevert(Escrow.NotArbiter.selector);
        e.resolveDispute(0, true);

        vm.prank(stranger);
        vm.expectRevert(Escrow.NotArbiter.selector);
        e.resolveDispute(0, true);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Disputed), "still frozen");
        assertEq(e.owed(freelancer), 0, "freelancer could not rule for themselves");
        assertEq(e.owed(client), 0, "client could not rule for themselves");
        assertEq(e.releasedAmount(), 0, "nothing released");
        assertEq(e.refundedAmount(), 0, "nothing refunded");
    }

    /// Ruling for the freelancer credits exactly that milestone to the freelancer and
    /// records it as released, so the arbiter's decision is what actually moves the money.
    function test_ResolveDisputeForFreelancerCreditsTheFreelancer() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        vm.prank(client);
        e.dispute(0);

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.DisputeResolved(0, true);
        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Released(0, M0, "dispute resolved for freelancer");
        vm.prank(arbiter);
        e.resolveDispute(0, true);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "released by the ruling");
        assertEq(e.owed(freelancer), M0, "freelancer credited the milestone amount");
        assertEq(e.owed(client), 0, "client credited nothing");
        assertEq(e.releasedAmount(), M0, "released total bumped by the milestone");
        assertEq(e.refundedAmount(), 0, "refunded total untouched");
    }

    /// Ruling for the client refunds exactly that milestone to the client and records it
    /// as refunded — the losing side's money comes back, it is not left stranded.
    function test_ResolveDisputeForClientCreditsTheClient() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        vm.prank(client);
        e.dispute(0);

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.DisputeResolved(0, false);
        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Refunded(0, M0, "dispute resolved for client");
        vm.prank(arbiter);
        e.resolveDispute(0, false);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Refunded), "refunded by the ruling");
        assertEq(e.owed(client), M0, "client credited the milestone amount");
        assertEq(e.owed(freelancer), 0, "freelancer credited nothing");
        assertEq(e.refundedAmount(), M0, "refunded total bumped by the milestone");
        assertEq(e.releasedAmount(), 0, "released total untouched");
    }

    /// The arbiter's authority begins and ends at a milestone the client actually froze.
    /// Without an objection there is no dispute to rule on, so the arbiter cannot reach in
    /// and hand a pending, submitted or attested milestone to either side.
    function test_RevertWhen_ResolvingAMilestoneThatIsNotDisputed() public {
        Escrow e = _acceptedEscrow();

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Pending));
        e.resolveDispute(0, true);

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Submitted));
        e.resolveDispute(0, true);

        bytes memory sig = _signCurrent(e, verifierPk, 0, true);
        e.attest(0, 1, true, REPORT, sig);

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Attested));
        e.resolveDispute(0, false);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "the arbiter changed nothing");
        assertEq(e.owed(freelancer), 0, "no payout");
        assertEq(e.owed(client), 0, "no refund");
        assertEq(e.releasedAmount(), 0, "released total untouched");
        assertEq(e.refundedAmount(), 0, "refunded total untouched");
    }

    /// A ruling is spent once it is made. Re-running it — either way round — must not pay
    /// the same milestone out a second time or credit both sides for one piece of work.
    function test_RevertWhen_ResolvingTheSameDisputeTwice() public {
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        vm.prank(client);
        e.dispute(0);

        vm.prank(arbiter);
        e.resolveDispute(0, true);
        assertEq(e.owed(freelancer), M0, "paid once");

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Released));
        e.resolveDispute(0, true);

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Released));
        e.resolveDispute(0, false);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "still exactly once released");
        assertEq(e.owed(freelancer), M0, "credited exactly once");
        assertEq(e.owed(client), 0, "the second ruling credited the client nothing");
        assertEq(e.releasedAmount(), M0, "released total not double counted");
        assertEq(e.refundedAmount(), 0, "nothing refunded");
        assertEq(address(e).balance, TOTAL, "escrow balance untouched by the replays");
    }

    /*//////////////////////////////////////////////////////////////
                               ISOLATION
    //////////////////////////////////////////////////////////////*/

    /// One objection freezes one milestone, not the whole job. Work the client never
    /// challenged keeps releasing on the clock and by hand, so a single argument cannot be
    /// used to hold the entire agreement hostage.
    function test_DisputingOneMilestoneLeavesTheOthersAlone() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        _submitAndPass(e, 1);
        vm.prank(freelancer);
        e.submit(2, EVIDENCE);

        vm.prank(client);
        e.dispute(1);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "milestone 0 still attested");
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Disputed), "milestone 1 frozen");
        assertEq(uint256(_state(e, 2)), uint256(Escrow.MState.Submitted), "milestone 2 still submitted");
        assertEq(e.challengeRemaining(0), WINDOW, "milestone 0's clock still runs");

        // The undisputed milestones still travel their normal paths.
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        e.release(0);
        vm.prank(client);
        e.approve(2);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "milestone 0 released on the clock");
        assertEq(uint256(_state(e, 2)), uint256(Escrow.MState.Released), "milestone 2 approved by hand");
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Disputed), "milestone 1 is still the only frozen one");
        assertEq(e.owed(freelancer), uint256(M0) + M2, "only the undisputed milestones paid out");
        assertEq(e.releasedAmount(), uint256(M0) + M2, "the frozen amount is not counted as released");
        assertEq(e.owed(client), 0, "nothing refunded while the dispute is open");
    }
}
