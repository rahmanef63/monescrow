// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";

/// @notice `submit` is the only way work enters the contract, and the submission counter it
///         bumps is what makes a stale attestation worthless. These tests pin down who may
///         submit, when, over which states, and exactly what a submit changes — because a UI
///         that offers a submit the chain would reject is a UI that loses the freelancer gas.
contract SubmissionTest is BaseTest {
    bytes32 private constant EVIDENCE_V2 = keccak256("revised deliverable, second attempt");
    bytes32 private constant EVIDENCE_ALT = keccak256("evidence for a different milestone");

    /*//////////////////////////////////////////////////////////////
                                  WHO
    //////////////////////////////////////////////////////////////*/

    /// Only the named freelancer may submit. If anyone else could, a stranger could park
    /// evidence the client never agreed to and start the attestation machinery on work the
    /// counterparty never did — so client, arbiter and stranger are all refused alike.
    /// The client being refused matters most: paying for the job does not make you its author.
    function test_RevertWhen_NonFreelancerSubmits() public {
        Escrow e = _acceptedEscrow();

        vm.prank(client);
        vm.expectRevert(Escrow.NotFreelancer.selector);
        e.submit(0, EVIDENCE);

        vm.prank(arbiter);
        vm.expectRevert(Escrow.NotFreelancer.selector);
        e.submit(0, EVIDENCE);

        vm.prank(stranger);
        vm.expectRevert(Escrow.NotFreelancer.selector);
        e.submit(0, EVIDENCE);

        Escrow.Milestone memory m = e.milestoneAt(0);
        assertEq(uint256(m.state), uint256(Escrow.MState.Pending), "still pending after three refusals");
        assertEq(m.submissions, 0, "no counter bump from an unauthorised submit");
        assertEq(m.evidenceHash, bytes32(0), "no evidence recorded by an outsider");
    }

    /*//////////////////////////////////////////////////////////////
                                  WHEN
    //////////////////////////////////////////////////////////////*/

    /// Work cannot start before the freelancer has accepted the terms. Until then the
    /// client is still free to cancel and take the whole balance back, so allowing a
    /// submission would let the freelancer build a claim on money that is not committed.
    function test_RevertWhen_SubmittingBeforeAcceptance() public {
        Escrow e = _newEscrow();
        assertEq(e.acceptedAt(), 0, "fixture is unaccepted");

        vm.prank(freelancer);
        vm.expectRevert(Escrow.NotAccepted.selector);
        e.submit(0, EVIDENCE);

        Escrow.Milestone memory m = e.milestoneAt(0);
        assertEq(uint256(m.state), uint256(Escrow.MState.Pending), "state untouched before acceptance");
        assertEq(m.submissions, 0, "counter untouched before acceptance");
        assertEq(e.acceptedAt(), 0, "a failed submit did not accept the job");
    }

    /// The deadline is exclusive: at the exact second it arrives the window has closed, not
    /// closes-next-block. That boundary is what makes `reclaim` safe — the client must be
    /// able to trust that no new submission can appear once they are entitled to reclaim.
    function test_RevertWhen_SubmittingAtOrAfterTheDeadline() public {
        Escrow e = _acceptedEscrow();
        uint64 dl = e.deadline();

        // One second early is still fine — proves the boundary is where we say it is.
        vm.warp(dl - 1);
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        assertEq(e.milestoneAt(0).submissions, 1, "the last legal second still works");

        vm.warp(dl);
        vm.prank(freelancer);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        e.submit(1, EVIDENCE);

        vm.warp(dl + 1 days);
        vm.prank(freelancer);
        vm.expectRevert(Escrow.DeadlinePassed.selector);
        e.submit(1, EVIDENCE);

        Escrow.Milestone memory m1 = e.milestoneAt(1);
        assertEq(uint256(m1.state), uint256(Escrow.MState.Pending), "nothing landed at or after the deadline");
        assertEq(m1.submissions, 0, "counter never moved past the deadline");
        assertEq(m1.evidenceHash, bytes32(0), "no late evidence recorded");
    }

    /*//////////////////////////////////////////////////////////////
                              WHAT IT WRITES
    //////////////////////////////////////////////////////////////*/

    /// The first submit is the whole handoff: it flips Pending -> Submitted, records the
    /// evidence hash the verifier will be asked to sign over, and opens the counter at 1.
    /// Everything downstream — attestation, approval, dispute — keys off these three writes.
    function test_FirstSubmitMovesPendingToSubmitted() public {
        Escrow e = _acceptedEscrow();
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Pending), "starts pending");

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        Escrow.Milestone memory m = e.milestoneAt(0);
        assertEq(uint256(m.state), uint256(Escrow.MState.Submitted), "pending -> submitted");
        assertEq(m.evidenceHash, EVIDENCE, "evidence hash recorded verbatim");
        assertEq(m.submissions, 1, "first submission is number one, not zero");
        assertEq(m.attestedAt, 0, "submitting does not pretend anything was attested");
        assertEq(m.amount, M0, "amount is not disturbed by a submit");
        assertEq(e.releasableAt(0), 0, "no release clock runs on a mere submission");
    }

    /// A freelancer may iterate: resubmitting from Submitted overwrites the evidence hash
    /// and bumps the counter to 2. That bump is precisely what invalidates any attestation
    /// signed against attempt 1, so a rejected deliverable can never be swapped for a
    /// passing one behind the verifier's back.
    function test_ResubmitFromSubmittedBumpsCounterAndOverwritesEvidence() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        Escrow.Milestone memory first = e.milestoneAt(0);
        assertEq(first.submissions, 1, "first attempt counted");
        assertEq(first.evidenceHash, EVIDENCE, "first evidence stored");

        vm.prank(freelancer);
        e.submit(0, EVIDENCE_V2);

        Escrow.Milestone memory second = e.milestoneAt(0);
        assertEq(uint256(second.state), uint256(Escrow.MState.Submitted), "still submitted, not reset to pending");
        assertEq(second.submissions, 2, "counter bumped to 2, so attempt 1 signatures are now stale");
        assertEq(second.evidenceHash, EVIDENCE_V2, "evidence overwritten by the newer attempt");
        assertTrue(second.evidenceHash != first.evidenceHash, "the stored deliverable actually changed");
    }

    /// Every submit announces the counter it produced, so the off-chain verifier can sign
    /// for exactly the attempt it looked at rather than guessing which one is current.
    function test_EachSubmitEmitsSubmittedWithTheNewCounter() public {
        Escrow e = _acceptedEscrow();

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Submitted(0, uint32(1), EVIDENCE);
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Submitted(0, uint32(2), EVIDENCE_V2);
        vm.prank(freelancer);
        e.submit(0, EVIDENCE_V2);

        assertEq(e.milestoneAt(0).submissions, 2, "the logged counter matches storage");
    }

    /*//////////////////////////////////////////////////////////////
                            OVER A CLOSED STATE
    //////////////////////////////////////////////////////////////*/

    /// Once a pass is attested the challenge window is running and the client is counting
    /// on the deliverable staying frozen. A resubmit here would silently move the goalposts
    /// under a client who already decided not to object.
    function test_RevertWhen_SubmittingOverAttested() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "attested first");
        uint64 clockBefore = e.releasableAt(0);

        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Attested));
        e.submit(0, EVIDENCE_V2);

        Escrow.Milestone memory m = e.milestoneAt(0);
        assertEq(uint256(m.state), uint256(Escrow.MState.Attested), "still attested");
        assertEq(m.submissions, 1, "counter not bumped, so the live attestation stays valid");
        assertEq(m.evidenceHash, EVIDENCE, "attested evidence not overwritten");
        assertEq(e.releasableAt(0), clockBefore, "the challenge clock was not restarted");
    }

    /// A disputed milestone is frozen for the arbiter. If the freelancer could resubmit
    /// they would be editing the exhibit while it is in front of the judge.
    function test_RevertWhen_SubmittingOverDisputed() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        vm.prank(client);
        e.dispute(0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Disputed), "disputed first");

        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Disputed));
        e.submit(0, EVIDENCE_V2);

        Escrow.Milestone memory m = e.milestoneAt(0);
        assertEq(uint256(m.state), uint256(Escrow.MState.Disputed), "still frozen for the arbiter");
        assertEq(m.submissions, 1, "counter untouched while frozen");
        assertEq(m.evidenceHash, EVIDENCE, "the disputed evidence is exactly what the arbiter will see");
    }

    /// A released milestone is paid. Re-opening it would let the freelancer queue a second
    /// claim on money already credited once.
    function test_RevertWhen_SubmittingOverReleased() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        vm.prank(client);
        e.approve(0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "released first");

        uint256 owedBefore = e.owed(freelancer);
        uint256 releasedBefore = e.releasedAmount();

        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Released));
        e.submit(0, EVIDENCE_V2);

        Escrow.Milestone memory m = e.milestoneAt(0);
        assertEq(uint256(m.state), uint256(Escrow.MState.Released), "stays released");
        assertEq(m.submissions, 1, "no second attempt recorded against paid work");
        assertEq(e.owed(freelancer), owedBefore, "no extra credit conjured");
        assertEq(e.releasedAmount(), releasedBefore, "released total unchanged");
    }

    /// A refunded milestone belongs to the client again. Resubmitting would let the
    /// freelancer re-attach a claim to money the arbiter already sent back.
    function test_RevertWhen_SubmittingOverRefunded() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        vm.prank(client);
        e.dispute(0);
        vm.prank(arbiter);
        e.resolveDispute(0, false);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Refunded), "refunded first");

        uint256 clientOwedBefore = e.owed(client);
        uint256 refundedBefore = e.refundedAmount();

        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Refunded));
        e.submit(0, EVIDENCE_V2);

        Escrow.Milestone memory m = e.milestoneAt(0);
        assertEq(uint256(m.state), uint256(Escrow.MState.Refunded), "stays refunded");
        assertEq(m.submissions, 1, "no attempt recorded against refunded work");
        assertEq(e.owed(client), clientOwedBefore, "the client's refund is not clawed back");
        assertEq(e.refundedAmount(), refundedBefore, "refunded total unchanged");
    }

    /*//////////////////////////////////////////////////////////////
                                INDEXING
    //////////////////////////////////////////////////////////////*/

    /// An index past the end is rejected explicitly rather than reverting on an array
    /// panic, so a mistyped index in the UI surfaces as a named error and never silently
    /// reads or writes a neighbouring slot.
    function test_RevertWhen_MilestoneIndexOutOfRange() public {
        Escrow e = _acceptedEscrow();
        uint256 count = e.milestoneCount();
        assertEq(count, 3, "fixture has three milestones");

        // The first index past the end — the off-by-one a UI is most likely to send.
        vm.prank(freelancer);
        vm.expectRevert(Escrow.BadMilestone.selector);
        e.submit(count, EVIDENCE);

        vm.prank(freelancer);
        vm.expectRevert(Escrow.BadMilestone.selector);
        e.submit(99, EVIDENCE);

        assertEq(e.milestoneCount(), count, "no milestone was appended by a bad index");
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Pending), "milestone 0 untouched");
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Pending), "milestone 1 untouched");
        assertEq(uint256(_state(e, 2)), uint256(Escrow.MState.Pending), "milestone 2 untouched");
    }

    /// Milestones are independent ledgers. If a submit on one bled into another's counter,
    /// an attestation signed for milestone 0 could be aimed at milestone 1 — so prove the
    /// counters, evidence hashes, states and amounts stay strictly per-milestone.
    function test_SubmittingOneMilestoneLeavesTheOthersAlone() public {
        Escrow e = _acceptedEscrow();

        vm.startPrank(freelancer);
        e.submit(0, EVIDENCE);
        e.submit(0, EVIDENCE_V2);
        e.submit(1, EVIDENCE_ALT);
        vm.stopPrank();

        Escrow.Milestone memory m0 = e.milestoneAt(0);
        Escrow.Milestone memory m1 = e.milestoneAt(1);
        Escrow.Milestone memory m2 = e.milestoneAt(2);

        assertEq(m0.submissions, 2, "milestone 0 counted its own two attempts");
        assertEq(m0.evidenceHash, EVIDENCE_V2, "milestone 0 holds its own latest evidence");
        assertEq(uint256(m0.state), uint256(Escrow.MState.Submitted), "milestone 0 submitted");

        assertEq(m1.submissions, 1, "milestone 1 counted exactly one attempt, not three");
        assertEq(m1.evidenceHash, EVIDENCE_ALT, "milestone 1 holds its own evidence");
        assertEq(uint256(m1.state), uint256(Escrow.MState.Submitted), "milestone 1 submitted");

        assertEq(m2.submissions, 0, "milestone 2 never touched");
        assertEq(m2.evidenceHash, bytes32(0), "milestone 2 has no evidence");
        assertEq(uint256(m2.state), uint256(Escrow.MState.Pending), "milestone 2 still pending");

        assertEq(m0.amount, M0, "milestone 0 amount unchanged");
        assertEq(m1.amount, M1, "milestone 1 amount unchanged");
        assertEq(m2.amount, M2, "milestone 2 amount unchanged");
        assertEq(e.releasedAmount(), 0, "submitting alone releases nothing");
        assertEq(e.refundedAmount(), 0, "submitting alone refunds nothing");
    }
}
