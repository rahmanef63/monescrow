// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";

/// @notice The verifier is the only off-chain input that can move a milestone forward, so
///         these are the tests that matter most. Every way of faking, replaying or
///         misdirecting an attestation gets its own case.
contract AttestationTest is BaseTest {
    function test_ValidAttestationStartsChallengeWindow() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Submitted), "submitted");

        e.attest(0, 1, true, REPORT, _signCurrent(e, verifierPk, 0, true));

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "attested");
        assertEq(e.releasableAt(0), uint64(block.timestamp) + WINDOW, "window start");
        assertEq(e.challengeRemaining(0), WINDOW, "full window left");
    }

    /// A forged signature from any other key must not move the milestone.
    function test_RevertWhen_SignerIsNotTheVerifier() public {
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        // Build the signature first: expectRevert arms the *next* call, and the helper
        // makes external view calls of its own.
        bytes memory forged = _signCurrent(e, impostorPk, 0, true);

        vm.expectRevert(Escrow.BadSignature.selector);
        e.attest(0, 1, true, REPORT, forged);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Submitted), "unchanged");
    }

    /// The freelancer holds their own key and cannot self-attest.
    function test_RevertWhen_FreelancerSignsItsOwnPass() public {
        (, uint256 freelancerPk) = makeAddrAndKey("freelancer");
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        bytes memory selfSigned = _signCurrent(e, freelancerPk, 0, true);

        vm.expectRevert(Escrow.BadSignature.selector);
        e.attest(0, 1, true, REPORT, selfSigned);
    }

    /// A pass signed for submission #1 must not survive a resubmit.
    function test_RevertWhen_ReplayingAttestationAfterResubmit() public {
        Escrow e = _acceptedEscrow();

        vm.prank(freelancer);
        e.submit(0, EVIDENCE);
        bytes memory oldSig = _signCurrent(e, verifierPk, 0, true);

        // Verifier rejects it; freelancer changes the deliverable and submits again.
        e.attest(0, 1, false, REPORT, _signCurrent(e, verifierPk, 0, false));
        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Submitted), "failing attestation is a no-op");

        vm.prank(freelancer);
        e.submit(0, keccak256("different deliverable"));
        assertEq(e.milestoneAt(0).submissions, 2, "counter bumped");

        // The old signature is now worthless, by counter and by evidence hash.
        vm.expectRevert(abi.encodeWithSelector(Escrow.StaleSubmission.selector, uint32(2), uint32(1)));
        e.attest(0, 1, true, REPORT, oldSig);

        vm.expectRevert(Escrow.BadSignature.selector);
        e.attest(0, 2, true, REPORT, oldSig);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Submitted), "still unpaid");
    }

    /// An attestation for milestone 0 must not release milestone 1.
    function test_RevertWhen_ReplayingAttestationOnAnotherMilestone() public {
        Escrow e = _acceptedEscrow();

        vm.startPrank(freelancer);
        e.submit(0, EVIDENCE);
        e.submit(1, EVIDENCE);
        vm.stopPrank();

        bytes memory sigForZero = _sign(e, verifierPk, 0, 1, true, EVIDENCE, REPORT);

        vm.expectRevert(Escrow.BadSignature.selector);
        e.attest(1, 1, true, REPORT, sigForZero);

        assertEq(uint256(_state(e, 1)), uint256(Escrow.MState.Submitted), "milestone 1 untouched");
    }

    /// The EIP-712 domain pins `verifyingContract`, so a pass for one job cannot be
    /// pointed at another job with identical parameters.
    function test_RevertWhen_ReplayingAttestationOnAnotherEscrow() public {
        Escrow a = _acceptedEscrow();
        Escrow b = _acceptedEscrow();
        assertTrue(address(a) != address(b), "two distinct escrows");

        vm.startPrank(freelancer);
        a.submit(0, EVIDENCE);
        b.submit(0, EVIDENCE);
        vm.stopPrank();

        bytes memory sigForA = _sign(a, verifierPk, 0, 1, true, EVIDENCE, REPORT);

        vm.expectRevert(Escrow.BadSignature.selector);
        b.attest(0, 1, true, REPORT, sigForA);
    }

    /// Flipping `passed` invalidates the signature — a rejection cannot be upgraded.
    function test_RevertWhen_FlippingPassedFlag() public {
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        bytes memory failSig = _signCurrent(e, verifierPk, 0, false);

        vm.expectRevert(Escrow.BadSignature.selector);
        e.attest(0, 1, true, REPORT, failSig);
    }

    /// Swapping the report hash invalidates it too — the evidence trail cannot be edited.
    function test_RevertWhen_ReportHashIsSwapped() public {
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        bytes memory sig = _signCurrent(e, verifierPk, 0, true);

        vm.expectRevert(Escrow.BadSignature.selector);
        e.attest(0, 1, true, keccak256("a nicer report"), sig);
    }

    /// Anybody may relay a valid attestation — the signature is the authority, not the
    /// sender. This is what lets the freelancer pay the gas to get themselves paid.
    function test_AnyoneCanRelayAValidAttestation() public {
        Escrow e = _acceptedEscrow();
        vm.prank(freelancer);
        e.submit(0, EVIDENCE);

        bytes memory sig = _signCurrent(e, verifierPk, 0, true);
        vm.prank(stranger);
        e.attest(0, 1, true, REPORT, sig);

        assertEq(uint256(_state(e, 0)), uint256(Escrow.MState.Attested), "relayed fine");
    }

    function test_RevertWhen_AttestingSomethingNotSubmitted() public {
        Escrow e = _acceptedEscrow();

        bytes memory sig = _sign(e, verifierPk, 0, 0, true, bytes32(0), REPORT);

        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Pending));
        e.attest(0, 0, true, REPORT, sig);
    }

    function test_RevertWhen_AttestingAlreadyAttested() public {
        Escrow e = _acceptedEscrow();
        _submitAndPass(e, 0);

        bytes memory sig = _sign(e, verifierPk, 0, 1, true, EVIDENCE, REPORT);

        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, Escrow.MState.Attested));
        e.attest(0, 1, true, REPORT, sig);
    }

    function test_RevertWhen_MilestoneIndexOutOfRange() public {
        Escrow e = _acceptedEscrow();
        vm.expectRevert(Escrow.BadMilestone.selector);
        e.attest(99, 1, true, REPORT, hex"00");
    }
}
