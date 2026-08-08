// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";

/// @notice Construction is the only moment the shape of the agreement can be set, and the
///         client's money is already inside the contract while it happens. Every shape
///         rejected here is one that could otherwise strand funds, pay nobody, or bind a
///         party to terms they never agreed to.
///
///         Everything is driven through the factory because that is the only way an escrow
///         is ever really created: the factory forwards `msg.value` and passes `msg.sender`
///         as the client, so the client can never be spoofed from calldata.
contract ConstructionTest is BaseTest {
    /*//////////////////////////////////////////////////////////////
                              HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    /// Everything both parties agreed to off-chain has to survive into storage unchanged —
    /// the escrow is the record of the deal, so a field silently dropped or swapped at
    /// construction is a deal nobody signed.
    function test_ConstructionStoresEveryField() public {
        Escrow e = _newEscrow();

        assertEq(e.client(), client, "client is the factory caller, not a calldata argument");
        assertEq(e.freelancer(), freelancer, "freelancer as named in the params");
        assertEq(e.verifier(), verifier, "verifier key that may propose passes");
        assertEq(e.arbiter(), arbiter, "arbiter who rules on disputes");
        assertEq(uint256(e.deadline()), block.timestamp + DURATION, "deadline");
        assertEq(uint256(e.challengeWindow()), uint256(WINDOW), "challenge window");
        assertEq(e.termsHash(), TERMS, "hash of the agreement text both sides read");
        assertEq(e.title(), "Build SaaS landing page", "title");
        assertEq(e.totalAmount(), TOTAL, "total equals the sum of the milestones");
        assertEq(e.milestoneCount(), 3, "three milestones");

        assertEq(uint256(e.acceptedAt()), 0, "nobody has accepted yet");
        assertFalse(e.cancelled(), "not cancelled");
        assertEq(e.releasedAmount(), 0, "nothing released at birth");
        assertEq(e.refundedAmount(), 0, "nothing refunded at birth");
        assertEq(e.owed(client), 0, "client is owed nothing yet");
        assertEq(e.owed(freelancer), 0, "freelancer is owed nothing yet");

        assertEq(e.MAX_MILESTONES(), 20, "milestone cap");
        assertEq(e.MAX_TITLE_BYTES(), 120, "title byte cap");

        Escrow.MilestoneInit[] memory expected = _defaultMilestones();
        Escrow.Milestone[] memory got = e.milestones();
        assertEq(got.length, expected.length, "milestone array length");

        for (uint256 i = 0; i < got.length; ++i) {
            assertEq(uint256(got[i].amount), uint256(expected[i].amount), "milestone amount");
            assertEq(uint256(got[i].check), uint256(expected[i].check), "milestone check type");
            assertEq(got[i].criteriaHash, expected[i].criteriaHash, "milestone criteria hash");
            assertEq(uint256(got[i].state), uint256(Escrow.MState.Pending), "milestone starts Pending");
            assertEq(uint256(got[i].submissions), 0, "no submissions yet");
            assertEq(uint256(got[i].attestedAt), 0, "never attested");
            assertEq(got[i].evidenceHash, bytes32(0), "no evidence yet");
        }
    }

    /// The whole job is funded up front, so the contract must physically hold every wei it
    /// promises before the freelancer is ever asked to accept. A freelancer who accepts is
    /// accepting against money that is already there.
    function test_EscrowHoldsTheFullFundingAfterConstruction() public {
        uint256 clientBefore = client.balance;

        Escrow e = _newEscrow();

        assertEq(address(e).balance, TOTAL, "escrow holds exactly the escrowed total");
        assertEq(address(e).balance, e.totalAmount(), "balance and accounting agree");
        assertEq(client.balance, clientBefore - TOTAL, "the money came out of the client's wallet");
        assertEq(address(factory).balance, 0, "the factory keeps nothing on the way through");
    }

    /*//////////////////////////////////////////////////////////////
                                PARTIES
    //////////////////////////////////////////////////////////////*/

    /// A milestone released to address(0) is money burned, so an escrow with no freelancer
    /// must never exist in the first place.
    function test_RevertWhen_FreelancerIsZeroAddress() public {
        Escrow.Params memory p = _params();
        p.freelancer = address(0);
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.ZeroAddress.selector);
        _createEscrow(client, p, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// The arbiter is the only way out of a dispute. Without one, a single objection from
    /// the client would freeze that milestone's funds permanently.
    function test_RevertWhen_ArbiterIsZeroAddress() public {
        Escrow.Params memory p = _params();
        p.arbiter = address(0);
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.ZeroAddress.selector);
        _createEscrow(client, p, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// Client and freelancer are adversarial roles — approve, dispute and reclaim all
    /// assume two different people. One address holding both sides is not an escrow, it is
    /// a wallet with extra steps.
    function test_RevertWhen_ClientIsAlsoTheFreelancer() public {
        Escrow.Params memory p = _params();
        p.freelancer = client;
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.ClientIsFreelancer.selector);
        _createEscrow(client, p, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /*//////////////////////////////////////////////////////////////
                                 TIMING
    //////////////////////////////////////////////////////////////*/

    /// A deadline already behind us means no work can ever be submitted, and the client
    /// could reclaim everything the instant the freelancer accepted. That is a trap, so it
    /// cannot be built.
    function test_RevertWhen_DeadlineIsInThePast() public {
        Escrow.Params memory p = _params();
        p.deadline = uint64(block.timestamp) - 1;
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.DeadlineInPast.selector);
        _createEscrow(client, p, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// The boundary is exclusive: `accept()` and `submit()` both reject `block.timestamp >=
    /// deadline`, so a deadline equal to now is exactly as dead as one in the past.
    function test_RevertWhen_DeadlineIsExactlyNow() public {
        Escrow.Params memory p = _params();
        p.deadline = uint64(block.timestamp);
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.DeadlineInPast.selector);
        _createEscrow(client, p, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /*//////////////////////////////////////////////////////////////
                            CHALLENGE WINDOW (D-7)
    //////////////////////////////////////////////////////////////*/

    /// @dev The two ends fail for different reasons and both are load-bearing. Below the
    ///      floor the verifier can attest and release in one transaction, so the client
    ///      never gets to object and the off-chain checker becomes a unilateral authority
    ///      over their funds. Above the ceiling an Attested milestone can neither be
    ///      reclaimed after the deadline nor released until the window elapses, so the money
    ///      sits with no exit. These pin all four boundary seconds — an off-by-one at either
    ///      end reopens one of those holes.
    function test_ChallengeWindowBoundsAreInclusiveAtBothEnds() public {
        uint32 min = Escrow(payable(address(_newEscrow()))).MIN_CHALLENGE_WINDOW();
        uint32 max = Escrow(payable(address(_newEscrow()))).MAX_CHALLENGE_WINDOW();

        assertEq(uint256(_escrowWithWindow(min).challengeWindow()), uint256(min), "the floor itself is legal");
        assertEq(uint256(_escrowWithWindow(max).challengeWindow()), uint256(max), "the ceiling itself is legal");

        _expectWindowRejected(min - 1, min, max);
        _expectWindowRejected(max + 1, min, max);
        _expectWindowRejected(0, min, max);
    }

    /// @dev Build an escrow at a given window. Reverts propagate to the caller.
    function _escrowWithWindow(uint32 window) private returns (Escrow) {
        Escrow.Params memory p = _params();
        p.challengeWindow = window;
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        return _createEscrow(client, p, ms, TOTAL);
    }

    /// @dev Every value is computed before the `expectRevert` line, never inline — the
    ///      expectation arms the next call and a helper's view call would swallow it.
    function _expectWindowRejected(uint32 window, uint32 min, uint32 max) private {
        Escrow.Params memory p = _params();
        p.challengeWindow = window;
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();
        bytes memory expected = abi.encodeWithSelector(Escrow.ChallengeWindowOutOfRange.selector, window, min, max);

        vm.expectRevert(expected);
        _createEscrow(client, p, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /*//////////////////////////////////////////////////////////////
                              MILESTONES
    //////////////////////////////////////////////////////////////*/

    /// An escrow with no milestones has no way to ever pay out or refund, so any ether sent
    /// with it would be locked forever.
    function test_RevertWhen_ThereAreNoMilestones() public {
        Escrow.Params memory p = _params();
        Escrow.MilestoneInit[] memory none = new Escrow.MilestoneInit[](0);
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.NoMilestones.selector);
        _createEscrow(client, p, none, 0);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// The cap is inclusive: exactly MAX_MILESTONES is a legitimate job, and every one of
    /// them must be stored and funded.
    function test_MaxMilestonesIsAllowed() public {
        Escrow.MilestoneInit[] memory ms = _manyMilestones(20);
        uint256 value = _sum(ms);

        Escrow e = _createEscrow(client, _params(), ms, value);

        assertEq(e.MAX_MILESTONES(), 20, "cap is 20");
        assertEq(e.milestoneCount(), 20, "all 20 milestones stored");
        assertEq(e.totalAmount(), value, "total is the sum of all 20");
        assertEq(address(e).balance, value, "all 20 are funded");
        assertEq(uint256(e.milestoneAt(19).state), uint256(Escrow.MState.Pending), "the last one is a real milestone");
        assertEq(e.milestoneAt(19).criteriaHash, keccak256(abi.encode("criteria", uint256(19))), "and keeps its terms");
    }

    /// One past the cap is refused. The cap exists because `cancel()` loops over every
    /// milestone — an unbounded list is an escrow the client could never cancel.
    function test_RevertWhen_OneMilestoneTooMany() public {
        Escrow.MilestoneInit[] memory ms = _manyMilestones(21);
        Escrow.Params memory p = _params();
        uint256 value = _sum(ms);
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.TooManyMilestones.selector);
        _createEscrow(client, p, ms, value);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// Every milestone must be worth something. A zero-amount milestone would show up in
    /// the UI as a deliverable that "pays out" while moving no money — a promise with
    /// nothing behind it.
    function test_RevertWhen_AMilestoneHasZeroAmount() public {
        Escrow.MilestoneInit[] memory ms = new Escrow.MilestoneInit[](2);
        ms[0] = Escrow.MilestoneInit({amount: M0, check: Escrow.Check.Http, criteriaHash: keccak256("http")});
        ms[1] = Escrow.MilestoneInit({amount: 0, check: Escrow.Check.ClientApproval, criteriaHash: keccak256("free")});

        Escrow.Params memory p = _params();
        // Funded to the exact sum, so the only thing wrong with this escrow is the empty
        // milestone itself.
        uint256 value = _sum(ms);
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.ZeroMilestoneAmount.selector);
        _createEscrow(client, p, ms, value);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /*//////////////////////////////////////////////////////////////
                                FUNDING
    //////////////////////////////////////////////////////////////*/

    /// Underfunding by even one wei must be rejected: the escrow promises the freelancer
    /// the full milestone amounts, and it can only keep that promise if the money is all
    /// there before anyone accepts.
    function test_RevertWhen_UnderfundedByOneWei() public {
        Escrow.Params memory p = _params();
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 sent = TOTAL - 1;
        uint256 clientBefore = client.balance;
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(abi.encodeWithSelector(Escrow.FundingMismatch.selector, TOTAL, sent));
        _createEscrow(client, p, ms, sent);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
        assertEq(client.balance, clientBefore, "the client's ether never left their wallet");
    }

    /// Overfunding is rejected too, and that is the less obvious half: the surplus would be
    /// unaccounted for by every milestone, so no release, refund or reclaim could ever
    /// return it. The escrow refuses to hold money it cannot pay out.
    function test_RevertWhen_OverfundedByOneWei() public {
        Escrow.Params memory p = _params();
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 sent = TOTAL + 1;
        uint256 clientBefore = client.balance;
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(abi.encodeWithSelector(Escrow.FundingMismatch.selector, TOTAL, sent));
        _createEscrow(client, p, ms, sent);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
        assertEq(client.balance, clientBefore, "the client's ether never left their wallet");
    }

    /*//////////////////////////////////////////////////////////////
                                 TITLE
    //////////////////////////////////////////////////////////////*/

    /// The title is how a human tells one escrow from another in a list of them. A nameless
    /// escrow is one a client cannot identify before approving a payment from it.
    function test_RevertWhen_TitleIsEmpty() public {
        Escrow.Params memory p = _params();
        p.title = "";
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.TitleEmpty.selector);
        _createEscrow(client, p, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// The cap is inclusive: a title of exactly MAX_TITLE_BYTES is legitimate and is stored
    /// whole, not silently truncated.
    function test_TitleOfExactlyMaxBytesIsAllowed() public {
        string memory exact = _repeat("a", 120);
        Escrow.Params memory p = _params();
        p.title = exact;

        Escrow e = _createEscrow(client, p, _defaultMilestones(), TOTAL);

        assertEq(e.MAX_TITLE_BYTES(), 120, "cap is 120 bytes");
        assertEq(bytes(e.title()).length, 120, "a 120-byte title is kept at full length");
        assertEq(e.title(), exact, "and kept verbatim");
    }

    /// One byte over is refused. The title is stored on-chain and read back by every
    /// frontend that lists escrows, so it is bounded rather than unbounded.
    function test_RevertWhen_TitleIsOneByteTooLong() public {
        Escrow.Params memory p = _params();
        p.title = _repeat("a", 121);
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.TitleTooLong.selector);
        _createEscrow(client, p, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// The limit counts BYTES, not characters. 61 accented characters are nowhere near 120
    /// characters but they are 122 bytes, and the chain measures what it actually stores —
    /// so a non-English title is bounded by exactly the same rule.
    function test_TitleLimitCountsBytesNotCharacters() public {
        // hex"c3a9" is the UTF-8 encoding of "é" (U+00E9): one character, two bytes.
        Escrow.Params memory p = _params();
        p.title = _repeat(hex"c3a9", 60); // 60 characters, 120 bytes — exactly at the cap

        Escrow e = _createEscrow(client, p, _defaultMilestones(), TOTAL);
        assertEq(bytes(e.title()).length, 120, "60 accented characters are 120 bytes and fit");

        Escrow.Params memory tooLong = _params();
        tooLong.title = _repeat(hex"c3a9", 61); // 61 characters, 122 bytes — over the cap
        Escrow.MilestoneInit[] memory ms = _defaultMilestones();
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.TitleTooLong.selector);
        _createEscrow(client, tooLong, ms, TOTAL);

        assertEq(factory.escrowCount(), countBefore, "the 61-character title deployed nothing");
    }

    /*//////////////////////////////////////////////////////////////
                          VERIFIER REQUIREMENT
    //////////////////////////////////////////////////////////////*/

    /// An Http milestone can only reach Attested through a verifier signature. With no
    /// verifier there is no key that can ever sign one, so the milestone would be
    /// unreleasable and the funds stranded until the deadline.
    function test_RevertWhen_HttpMilestoneHasNoVerifier() public {
        Escrow.Params memory p = _params();
        p.verifier = address(0);
        Escrow.MilestoneInit[] memory ms = _oneMilestone(M0, Escrow.Check.Http);
        uint256 value = _sum(ms);
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.VerifierRequired.selector);
        _createEscrow(client, p, ms, value);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// The rule is per-milestone, not per-escrow: one Github milestone in an otherwise
    /// manual job is enough to require a verifier, because that one milestone is the one
    /// that would strand.
    function test_RevertWhen_GithubMilestoneHasNoVerifier() public {
        Escrow.MilestoneInit[] memory ms = new Escrow.MilestoneInit[](2);
        ms[0] =
            Escrow.MilestoneInit({amount: M0, check: Escrow.Check.ClientApproval, criteriaHash: keccak256("manual")});
        ms[1] = Escrow.MilestoneInit({amount: M1, check: Escrow.Check.Github, criteriaHash: keccak256("gh")});

        Escrow.Params memory p = _params();
        p.verifier = address(0);
        uint256 value = _sum(ms);
        uint256 countBefore = factory.escrowCount();

        vm.expectRevert(Escrow.VerifierRequired.selector);
        _createEscrow(client, p, ms, value);

        assertEq(factory.escrowCount(), countBefore, "no escrow was deployed");
    }

    /// The mirror image, and the case that proves the rule is targeted rather than blanket:
    /// a job where the client approves everything by hand needs no verifier at all. Two
    /// people can use this escrow with no third party watching them.
    function test_ClientApprovalOnlyEscrowNeedsNoVerifier() public {
        Escrow.MilestoneInit[] memory ms = new Escrow.MilestoneInit[](2);
        ms[0] =
            Escrow.MilestoneInit({amount: M0, check: Escrow.Check.ClientApproval, criteriaHash: keccak256("design")});
        ms[1] = Escrow.MilestoneInit({amount: M1, check: Escrow.Check.ClientApproval, criteriaHash: keccak256("copy")});

        Escrow.Params memory p = _params();
        p.verifier = address(0);
        uint256 value = _sum(ms);

        Escrow e = _createEscrow(client, p, ms, value);

        assertEq(e.verifier(), address(0), "no verifier, and none needed");
        assertEq(e.milestoneCount(), 2, "both milestones stored");
        assertEq(e.totalAmount(), value, "fully funded");
        assertEq(address(e).balance, value, "and holding the money");
        assertEq(uint256(e.milestoneAt(0).check), uint256(Escrow.Check.ClientApproval), "milestone 0 is manual");
        assertEq(uint256(e.milestoneAt(1).check), uint256(Escrow.Check.ClientApproval), "milestone 1 is manual");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev `n` identical 1-ether Http milestones, each with its own criteria hash.
    function _manyMilestones(uint256 n) private pure returns (Escrow.MilestoneInit[] memory ms) {
        ms = new Escrow.MilestoneInit[](n);
        for (uint256 i = 0; i < n; ++i) {
            ms[i] = Escrow.MilestoneInit({
                amount: 1 ether, check: Escrow.Check.Http, criteriaHash: keccak256(abi.encode("criteria", i))
            });
        }
    }

    /// @dev `times` copies of `unit` as a string, so title lengths can be stated in bytes.
    function _repeat(bytes memory unit, uint256 times) private pure returns (string memory) {
        bytes memory out = new bytes(unit.length * times);
        uint256 k;
        for (uint256 i = 0; i < times; ++i) {
            for (uint256 j = 0; j < unit.length; ++j) {
                out[k] = unit[j];
                ++k;
            }
        }
        return string(out);
    }
}
