// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";

/// @notice Shared fixture: a funded 3-milestone escrow plus helpers for producing
///         verifier attestations the way the real off-chain service would.
abstract contract BaseTest is Test {
    EscrowFactory internal factory;

    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");

    address internal verifier;
    uint256 internal verifierPk;
    address internal impostor;
    uint256 internal impostorPk;

    uint128 internal constant M0 = 1 ether; // Http check
    uint128 internal constant M1 = 2 ether; // Github check
    uint128 internal constant M2 = 3 ether; // ClientApproval
    uint256 internal constant TOTAL = 6 ether;

    uint32 internal constant WINDOW = 1 days;
    uint64 internal constant DURATION = 30 days;

    bytes32 internal constant TERMS = keccak256("terms v1");
    bytes32 internal constant EVIDENCE = keccak256("https://demo.example/ + commit abc");
    bytes32 internal constant REPORT = keccak256("verifier report json");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        (verifier, verifierPk) = makeAddrAndKey("verifier");
        (impostor, impostorPk) = makeAddrAndKey("impostor");

        factory = new EscrowFactory();
        vm.deal(client, 100 ether);
        vm.deal(freelancer, 10 ether);
        vm.deal(stranger, 10 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                FIXTURES
    //////////////////////////////////////////////////////////////*/

    function _defaultMilestones() internal pure returns (Escrow.MilestoneInit[] memory ms) {
        ms = new Escrow.MilestoneInit[](3);
        ms[0] = Escrow.MilestoneInit({amount: M0, check: Escrow.Check.Http, criteriaHash: keccak256("http")});
        ms[1] = Escrow.MilestoneInit({amount: M1, check: Escrow.Check.Github, criteriaHash: keccak256("gh")});
        ms[2] =
            Escrow.MilestoneInit({amount: M2, check: Escrow.Check.ClientApproval, criteriaHash: keccak256("manual")});
    }

    function _params() internal view returns (Escrow.Params memory) {
        return Escrow.Params({
            freelancer: freelancer,
            verifier: verifier,
            arbiter: arbiter,
            deadline: uint64(block.timestamp) + DURATION,
            challengeWindow: WINDOW,
            termsHash: TERMS,
            title: "Build SaaS landing page"
        });
    }

    function _newEscrow() internal returns (Escrow) {
        vm.prank(client);
        return Escrow(factory.createEscrow{value: TOTAL}(_params(), _defaultMilestones()));
    }

    /// @dev Escrow that has been accepted by the freelancer — the usual starting point.
    function _acceptedEscrow() internal returns (Escrow e) {
        e = _newEscrow();
        vm.prank(freelancer);
        e.accept();
    }

    /*//////////////////////////////////////////////////////////////
                              ATTESTATIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Reproduces exactly what the off-chain verifier signs.
    function _sign(Escrow e, uint256 pk, uint256 i, uint32 submission, bool passed, bytes32 evidence, bytes32 report)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = e.attestationDigest(i, submission, passed, evidence, report);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Sign for the milestone's *current* submission and evidence, as the real
    ///      verifier would after reading the chain.
    function _signCurrent(Escrow e, uint256 pk, uint256 i, bool passed) internal view returns (bytes memory) {
        Escrow.Milestone memory m = e.milestoneAt(i);
        return _sign(e, pk, i, m.submissions, passed, m.evidenceHash, REPORT);
    }

    /// @dev Freelancer submits, verifier passes it. Leaves the milestone in Attested with
    ///      the challenge window running.
    function _submitAndPass(Escrow e, uint256 i) internal {
        vm.prank(freelancer);
        e.submit(i, EVIDENCE);
        Escrow.Milestone memory m = e.milestoneAt(i);
        e.attest(i, m.submissions, true, REPORT, _signCurrent(e, verifierPk, i, true));
    }

    function _state(Escrow e, uint256 i) internal view returns (Escrow.MState) {
        return e.milestoneAt(i).state;
    }

    /*//////////////////////////////////////////////////////////////
                            CUSTOM FIXTURES
    //////////////////////////////////////////////////////////////*/

    /// @dev Build an escrow from arbitrary params and milestones. Every Wave-1 shape the
    ///      default fixture cannot express goes through here — a zero challenge window, a
    ///      contract as the freelancer, a deliberately wrong `msg.value`.
    function _createEscrow(address funder, Escrow.Params memory p, Escrow.MilestoneInit[] memory ms, uint256 value)
        internal
        returns (Escrow)
    {
        vm.prank(funder);
        return Escrow(factory.createEscrow{value: value}(p, ms));
    }

    /// @dev Single-milestone fixture, for tests where three milestones are only noise.
    function _oneMilestone(uint128 amount, Escrow.Check check)
        internal
        pure
        returns (Escrow.MilestoneInit[] memory ms)
    {
        ms = new Escrow.MilestoneInit[](1);
        ms[0] = Escrow.MilestoneInit({amount: amount, check: check, criteriaHash: keccak256("criteria")});
    }

    function _sum(Escrow.MilestoneInit[] memory ms) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < ms.length; ++i) {
            total += ms[i].amount;
        }
    }
}
