// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";

/// @notice The challenge window is the whole point of the design: a passing attestation is
///         only a *proposal*. It starts a clock. The client's silence for the length of
///         that clock is what authorises the payout, and once the clock runs out anybody
///         at all can push the button — the freelancer never has to chase anyone, and no
///         off-chain checker ever moved the money by itself. These tests pin the clock:
///         when it starts, when it does not, what the countdown views tell the UI, and
///         exactly which second is the first releasable one.
contract ChallengeWindowTest is BaseTest {
    /// @dev Mirrors of the contract's bounds (D-7). Duplicated rather than read at runtime so
    ///      they can be used in `Params` before an escrow exists;
    ///      `test_MirroredBoundsMatchTheContract` fails if the contract ever moves them.
    uint32 private constant MIN_WINDOW = 60;
    uint32 private constant MAX_WINDOW = 30 days;

    /*//////////////////////////////////////////////////////////////
                            LOCAL FIXTURES
    //////////////////////////////////////////////////////////////*/

    /// @dev An accepted escrow whose window is exactly `MIN_CHALLENGE_WINDOW` — the shortest
    ///      configuration the contract now allows, and the one the 90-second demo preset
    ///      sits just above.
    function _minWindowEscrow() private returns (Escrow e, uint32 window) {
        window = MIN_WINDOW;
        Escrow.Params memory p = _params();
        p.challengeWindow = window;
        Escrow.MilestoneInit[] memory ms = _oneMilestone(M0, Escrow.Check.Http);
        e = _createEscrow(client, p, ms, _sum(ms));
        vm.prank(freelancer);
        e.accept();
    }

    /// @dev Relay a passing attestation for whatever the milestone's current submission is.
    ///      Unlike `_submitAndPass` this does not submit first, so it can be used on a
    ///      milestone that was submitted earlier in the test.
    function _pass(Escrow e, uint256 i) private {
        Escrow.Milestone memory m = e.milestoneAt(i);
        bytes memory sig = _signCurrent(e, verifierPk, i, true);
        e.attest(i, m.submissions, true, REPORT, sig);
    }

    /*//////////////////////////////////////////////////////////////
                              CLIENT SILENCE
    //////////////////////////////////////////////////////////////*/

    /// Silence is consent: once the window has elapsed with no objection, the release is
    /// permissionless. A stranger with no stake in the job can trigger it, which is what
    /// guarantees an honest freelancer gets paid even if the client simply disappears.
    function test_ClientSilenceLetsAnyoneReleaseToTheFreelancer() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "window is running");

        vm.warp(block.timestamp + WINDOW);

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Released(0, M0, "challenge window elapsed");
        vm.prank(stranger);
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "released by silence");
        assertEq(e.owed(freelancer), M0, "freelancer credited the milestone amount");
        assertEq(e.releasedAmount(), M0, "released total tracks the payout");
        assertEq(e.owed(client), 0, "client is owed nothing");
        assertEq(e.refundedAmount(), 0, "nothing was refunded");
        assertEq(address(e).balance, TOTAL, "still pull-based: release moved no ether");
        assertEq(freelancer.balance, 10 ether, "freelancer's wallet only moves on withdraw()");
    }

    /// One second before the window closes the client can still object, so the money must
    /// stay put — and the revert has to carry the exact timestamp the UI is counting to.
    function test_RevertWhen_ReleasingOneSecondBeforeWindowCloses() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);

        // Read the deadline BEFORE arming expectRevert: a view call would eat the arm.
        uint64 openUntil = e.releasableAt(0);
        vm.warp(uint256(openUntil) - 1);
        assertEq(e.challengeRemaining(0), 1, "one second still on the clock");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Escrow.ChallengeWindowOpen.selector, openUntil));
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "still only attested");
        assertEq(e.owed(freelancer), 0, "nothing credited early");
        assertEq(e.releasedAmount(), 0, "nothing released early");
    }

    /// The boundary is inclusive: `releasableAt` is the FIRST releasable second, not the
    /// last blocked one. The countdown hitting zero and the release succeeding must be the
    /// same instant, or the UI enables the button a second too early.
    function test_ReleaseAtExactlyReleasableAtSucceeds() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);

        uint64 openUntil = e.releasableAt(0);
        vm.warp(openUntil);
        assertEq(block.timestamp, openUntil, "sitting exactly on the boundary");
        assertEq(e.challengeRemaining(0), 0, "countdown reads zero at the boundary");

        vm.prank(stranger);
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "the boundary second is releasable");
        assertEq(e.owed(freelancer), M0, "freelancer credited on the boundary second");
        assertEq(e.releasedAmount(), M0, "released total tracks the payout");
    }

    /// The two constants above are copies, and a copy that drifts is worse than no copy —
    /// every bound test would keep passing against numbers the contract no longer uses.
    function test_MirroredBoundsMatchTheContract() public {
        Escrow e = _acceptedEscrow();
        assertEq(uint256(e.MIN_CHALLENGE_WINDOW()), uint256(MIN_WINDOW), "min mirror is stale");
        assertEq(uint256(e.MAX_CHALLENGE_WINDOW()), uint256(MAX_WINDOW), "max mirror is stale");
    }

    /// A zero window is refused at construction, and that refusal IS the mechanism. At zero,
    /// `release` computes `openUntil == attestedAt == block.timestamp`, so whoever holds the
    /// verifier key could attest and release in one transaction and the client would never
    /// get to object — the verifier acting as a unilateral authority over somebody's funds,
    /// which is the one thing this design says must never happen. Rejecting it in the
    /// constructor is what stops the product's headline claim from being configurable away.
    /// (D-7; this test previously asserted the opposite and was inverted when the bound
    /// landed, so it stays here as the guard against the bound being removed again.)
    function test_RevertWhen_ChallengeWindowIsZero() public {
        Escrow.Params memory p = _params();
        p.challengeWindow = 0;
        Escrow.MilestoneInit[] memory ms = _oneMilestone(M0, Escrow.Check.Http);
        uint256 value = _sum(ms);

        vm.expectRevert(
            abi.encodeWithSelector(Escrow.ChallengeWindowOutOfRange.selector, uint32(0), MIN_WINDOW, MAX_WINDOW)
        );
        _createEscrow(client, p, ms, value);
    }

    /// The shortest legal window still behaves like a window: nothing releases inside it,
    /// everything releases once it elapses. This is the configuration the 90-second demo
    /// preset sits just above, so if the floor were ever raised past the preset the demo
    /// would break here rather than on camera.
    function test_MinimumWindowStillHoldsTheMoneyUntilItElapses() public {
        (Escrow e, uint32 window) = _minWindowEscrow();
        assertEq(e.challengeWindow(), window, "escrow runs the shortest legal window");

        _submitAndPass(e, 0);
        uint64 openUntil = e.releasableAt(0);
        assertEq(openUntil, uint64(block.timestamp) + window, "window opens on attestation");
        assertEq(e.challengeRemaining(0), window, "the full window is left");

        vm.warp(openUntil - 1);
        vm.expectRevert(abi.encodeWithSelector(Escrow.ChallengeWindowOpen.selector, openUntil));
        e.release(0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "still frozen one second early");

        vm.warp(openUntil);
        vm.prank(stranger);
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "released once the window elapsed");
        assertEq(e.owed(freelancer), M0, "freelancer credited");
    }

    /*//////////////////////////////////////////////////////////////
                             COUNTDOWN VIEWS
    //////////////////////////////////////////////////////////////*/

    /// `challengeRemaining` is the number the client sees ticking down while deciding
    /// whether to object. It must be the truth at every point of the window, and it must
    /// bottom out at zero rather than wrap around once the window has passed.
    function test_ChallengeRemainingCountsDownTruthfully() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);

        uint64 openUntil = e.releasableAt(0);
        assertEq(openUntil, uint64(block.timestamp) + WINDOW, "window closes one window after the pass");
        assertEq(e.challengeRemaining(0), WINDOW, "full window the moment it is attested");

        vm.warp(block.timestamp + WINDOW / 2);
        assertEq(e.challengeRemaining(0), WINDOW / 2, "half spent, half left");
        assertEq(e.releasableAt(0), openUntil, "the deadline itself never moves");

        vm.warp(uint256(openUntil) - 1);
        assertEq(e.challengeRemaining(0), 1, "one second left");

        vm.warp(openUntil);
        assertEq(e.challengeRemaining(0), 0, "zero exactly at expiry");

        vm.warp(uint256(openUntil) + 7 days);
        assertEq(e.challengeRemaining(0), 0, "still zero long after, never wraps");
        assertEq(e.releasableAt(0), openUntil, "the deadline is still reported after expiry");
    }

    /// These two views are what the UI countdown reads, so a non-zero answer for a
    /// milestone that is not Attested would put a fake timer on screen — and for a
    /// Released or Disputed milestone it would invite a click that the chain rejects.
    ///
    /// @dev Released and Disputed are reached *mid-window* on purpose. If they were reached
    ///      after the window had already run out, `attestedAt + challengeWindow` would be in
    ///      the past and both views would return 0 by arithmetic even with their state guard
    ///      deleted — the assertions would prove nothing.
    function test_CountdownViewsAreZeroWhenNotAttested() public {
        Escrow e = _acceptedEscrow();

        // Pending — never touched.
        assertEq(uint256(_state(e, 2)), uint256(Escrow.MState.Pending), "milestone 2 is pending");
        assertEq(e.releasableAt(2), 0, "pending has no release time");
        assertEq(e.challengeRemaining(2), 0, "pending has no countdown");

        // Submitted — waiting on an attestation, no clock yet.
        vm.prank(freelancer);
        e.submit(1, EVIDENCE);
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Submitted), "milestone 1 is submitted");
        assertEq(e.releasableAt(1), 0, "submitted has no release time");
        assertEq(e.challengeRemaining(1), 0, "submitted has no countdown");

        // Released — approved by the client half way through, so the window it will never
        // need would still have been open. The clock must read spent, not still ticking.
        _submitAndPass(e, 0);
        vm.warp(block.timestamp + WINDOW / 2);
        assertGt(e.releasableAt(0), block.timestamp, "milestone 0's window is still open");
        vm.prank(client);
        e.approve(0);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "milestone 0 is released");
        assertEq(e.releasableAt(0), 0, "released has no release time");
        assertEq(e.challengeRemaining(0), 0, "released has no countdown");

        // Disputed — frozen for the arbiter mid-window. No clock can run it out from here.
        _pass(e, 1);
        assertGt(e.releasableAt(1), block.timestamp, "milestone 1's window is open before the objection");
        vm.prank(client);
        e.dispute(1);
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Disputed), "milestone 1 is disputed");
        assertEq(e.releasableAt(1), 0, "disputed has no release time");
        assertEq(e.challengeRemaining(1), 0, "disputed has no countdown");
    }

    /*//////////////////////////////////////////////////////////////
                          RELEASE PRECONDITIONS
    //////////////////////////////////////////////////////////////*/

    /// Only an attestation opens the door. Without one there is no window to elapse, so
    /// waiting forever must never turn unproven work into a payout.
    function test_RevertWhen_ReleasingAMilestoneNeverAttested() public {
        Escrow e = _acceptedEscrow();

        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Pending));
        e.release(0);

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Submitted));
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Submitted), "state unmoved");
        assertEq(e.owed(freelancer), 0, "nothing credited");
        assertEq(e.releasedAmount(), 0, "nothing released");
    }

    /// Release is permissionless, so it will be called by bots and by anyone watching the
    /// clock. Calling it twice must credit the freelancer once, not drain a second
    /// milestone's worth of the client's money.
    function test_RevertWhen_ReleasingTwice() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);
        vm.warp(block.timestamp + WINDOW);

        vm.prank(stranger);
        e.release(0);
        assertEq(e.releasedAmount(), M0, "paid once");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Released));
        e.release(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "still just released");
        assertEq(e.releasedAmount(), M0, "still paid exactly once");
        assertEq(e.owed(freelancer), M0, "no double credit");
        assertEq(address(e).balance, TOTAL, "escrow still holds the rest of the job");
    }

    /// The window is a floor on the client's patience, not a ceiling. A happy client can
    /// approve during it and pay immediately, without waiting out a clock that only exists
    /// to protect them.
    function test_ClientCanApproveDuringTheChallengeWindow() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);

        vm.warp(block.timestamp + WINDOW / 2);
        assertEq(e.challengeRemaining(0), WINDOW / 2, "still well inside the window");

        vm.expectEmit(true, false, false, true, address(e));
        emit Escrow.Released(0, M0, "client approved");
        vm.prank(client);
        e.approve(0);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Released), "released without waiting");
        assertEq(e.owed(freelancer), M0, "freelancer credited");
        assertEq(e.releasedAmount(), M0, "released total tracks the payout");
        assertEq(e.challengeRemaining(0), 0, "the clock is gone once it is released");
    }

    /// A failing report is not a verdict either — it starts no clock at all. If it did, a
    /// verifier that reported "failed" could still get the milestone paid out by silence.
    function test_FailingAttestationOpensNoWindow() public {
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        Escrow.Milestone memory m = e.milestoneAt(0);
        bytes memory failSig = _signCurrent(e, verifierPk, 0, false);
        e.attest(0, m.submissions, false, REPORT, failSig);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Submitted), "a fail leaves it submitted");
        assertEq(e.milestoneAt(0).attestedAt, 0, "no attestation timestamp recorded");
        assertEq(e.releasableAt(0), 0, "no release time");
        assertEq(e.challengeRemaining(0), 0, "no countdown");

        // Wait out ten windows: there is nothing to run out.
        vm.warp(block.timestamp + uint256(WINDOW) * 10);

        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Submitted));
        e.release(0);

        assertEq(e.owed(freelancer), 0, "a failing report can never pay out by silence");
        assertEq(e.releasedAmount(), 0, "nothing released");
    }

    /// Each milestone carries its own clock. Passing one must not start — or finish — the
    /// window on any other, or a single attestation would unlock the whole job.
    function test_ChallengeWindowIsPerMilestone() public {
        Escrow e = _acceptedEscrow();

        vm.startPrank(freelancer);
        e.submit(0, EVIDENCE);
        e.submit(1, EVIDENCE);
        vm.stopPrank();

        _pass(e, 0);

        assertEq(e.releasableAt(0), uint64(block.timestamp) + WINDOW, "milestone 0 window running");
        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Submitted), "milestone 1 untouched");
        assertEq(e.releasableAt(1), 0, "milestone 1 has no release time");
        assertEq(e.challengeRemaining(1), 0, "milestone 1 has no countdown");

        vm.warp(block.timestamp + WINDOW);

        vm.prank(stranger);
        e.release(0);

        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Submitted));
        e.release(1);

        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Submitted), "milestone 1 still unpaid");
        assertEq(e.owed(freelancer), M0, "only milestone 0 was credited");
        assertEq(e.releasedAmount(), M0, "only milestone 0 counted as released");

        // Milestone 1's own window starts when milestone 1 is attested, not before.
        _pass(e, 1);
        assertEq(e.releasableAt(1), uint64(block.timestamp) + WINDOW, "milestone 1 window starts fresh");
        assertEq(e.challengeRemaining(1), WINDOW, "milestone 1 gets a full window of its own");
    }
}
