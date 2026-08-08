// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {EscrowHandler} from "./handlers/EscrowHandler.sol";

/// @notice Stateful invariants. The unit tests each check one transition in isolation;
///         this suite turns the fuzzer loose on arbitrary legal orderings of every
///         action and asserts the things that must hold after *any* of them.
///
///         The properties are all about the money and the state machine: an escrow can
///         never owe more than it holds, never hold more or less than it was funded
///         minus what has been paid out, and never walk a milestone back out of a
///         terminal state once the money for it has been booked. Every one of them is
///         asserted per escrow, so a cross-contract leak — one escrow paying out of
///         another's balance — cannot hide inside a cohort-wide total.
///
/// @dev The fuzzer may only call the handler — `targetContract` plus `targetSelector`
///      keep it off the escrows, so every sequence is a sequence a real user could
///      produce. `fail-on-revert = false` is belt-and-braces: the handler already
///      try/catches, so a rejected call is a genuine "the chain said no" data point
///      rather than a dead sequence.
///
/// @dev Budget: `runs` is halved and `depth` tripled against the previous 128x256. Total
///      calls only rise 1.5x, but the shape matters more than the count here. Reaching
///      "the challenge window elapsed and anyone released the milestone" takes a *chain*
///      of five successful calls — accept, submit, attest, warp, release — and with
///      twelve actions chosen uniformly a chain that long needs a long sequence to have
///      any chance of completing. Short runs mostly die halfway up the chain; the extra
///      runs bought nothing that the extra depth does not buy better.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 768
/// forge-config: default.invariant.fail-on-revert = false
/// forge-config: default.invariant.show-metrics = true
contract InvariantTest is BaseTest {
    EscrowHandler internal handler;

    /// The cohort under test, and what each was funded with.
    Escrow[] internal escrows;
    uint256[] internal deposits;

    /// Everyone who could conceivably hold a credit. `owed` is only ever written for the
    /// client and the freelancer, so the extras are here to catch a credit landing
    /// somewhere it should not.
    address[] internal accounts;

    uint256 internal clientStartBalance;
    uint256 internal freelancerStartBalance;

    /// Three escrows of sixteen, eighteen and twenty milestones rather than one escrow of
    /// twelve. The size is forced by arithmetic: `approve`, `release`, `resolveDispute`
    /// and `reclaim` each consume a milestone permanently, so the milestone count is a
    /// hard ceiling on how often those four can collectively succeed in a run. Twelve
    /// milestones is a budget of twelve closures split four ways, which is why `release`
    /// measured 0 and `reclaim` 1 — a ceiling no amount of selection tuning can lift.
    /// Fifty-four gives every closing path room to fire tens of times.
    ///
    /// The three counts differ so that no two escrows in the cohort are the same shape:
    /// the deposits come out at 26, 31.5 and 35 ether, so a balance or ledger read that
    /// went to the wrong escrow cannot come out even. Twenty is MAX_MILESTONES.
    uint256 internal constant K = 3;

    function _milestoneCount(uint256 e) private pure returns (uint256) {
        return 16 + 2 * e;
    }

    function setUp() public override {
        super.setUp();

        Escrow[] memory cohort = new Escrow[](K);
        for (uint256 e = 0; e < K; ++e) {
            Escrow.MilestoneInit[] memory ms = _cohortMilestones(e);
            uint256 deposit = _sum(ms);

            Escrow esc = _createEscrow(client, _stagedParams(e), ms, deposit);
            escrows.push(esc);
            deposits.push(deposit);
            cohort[e] = esc;
            vm.label(address(esc), string.concat("escrow", vm.toString(e)));
        }

        handler = new EscrowHandler(cohort, client, freelancer, arbiter, verifierPk);
        vm.label(address(handler), "handler");

        clientStartBalance = client.balance;
        freelancerStartBalance = freelancer.balance;

        accounts.push(client);
        accounts.push(freelancer);
        accounts.push(arbiter);
        accounts.push(stranger);
        accounts.push(verifier);
        accounts.push(impostor);
        accounts.push(address(handler));
        accounts.push(address(this));
        accounts.push(address(factory));
        accounts.push(address(0));

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = EscrowHandler.accept.selector;
        selectors[1] = EscrowHandler.submit.selector;
        selectors[2] = EscrowHandler.attestPass.selector;
        selectors[3] = EscrowHandler.attestFail.selector;
        selectors[4] = EscrowHandler.approve.selector;
        selectors[5] = EscrowHandler.release.selector;
        selectors[6] = EscrowHandler.dispute.selector;
        selectors[7] = EscrowHandler.resolveDispute.selector;
        selectors[8] = EscrowHandler.reclaim.selector;
        selectors[9] = EscrowHandler.withdraw.selector;
        selectors[10] = EscrowHandler.warp.selector;
        selectors[11] = EscrowHandler.pokeClosedMilestone.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Deadlines are staggered on purpose, and it is the single change that makes
    ///      `reclaim` and `release` both reachable in one run. They pull in opposite
    ///      directions: nothing can be reclaimed until a deadline passes, and nothing new
    ///      can be submitted — hence attested, hence released — after one does. A single
    ///      shared deadline splits a run into a release half and a reclaim half and
    ///      starves whichever one the clock happens to shortchange. Three deadlines
    ///      spread across the run mean the oldest escrow is being reclaimed from while
    ///      the youngest is still minting attestations for `release`.
    /// @dev Spaced against the clock the handler's `warp` actually produces: 60 to 70
    ///      hops at a mean near 1.4 days, so a run finishes somewhere around day 90 and
    ///      these land near its 30%, 55% and 85% marks.
    ///
    ///      Both ends of that spacing are load-bearing, and the suite is more sensitive
    ///      to it than to anything else here. Set the deadlines too late and the last
    ///      escrow never expires, so it contributes nothing to `reclaim` — measured at
    ///      35/75/120, `reclaim` fell to 7. Set them too early and milestones get
    ///      reclaimed before anyone can work them, so `release` starves instead — at
    ///      26/48/70, `release` fell to 11 while `reclaim` rose to 18. Retune these if
    ///      `depth` or the `warp` bound ever changes.
    function _stage(uint256 e) private pure returns (uint64) {
        if (e == 0) return 28 days;
        if (e == 1) return 52 days;
        return 76 days;
    }

    function _stagedParams(uint256 e) private view returns (Escrow.Params memory) {
        return Escrow.Params({
            freelancer: freelancer,
            verifier: verifier,
            arbiter: arbiter,
            deadline: uint64(block.timestamp) + _stage(e),
            challengeWindow: WINDOW,
            termsHash: keccak256(abi.encode(TERMS, e)),
            title: string.concat("Cohort escrow ", vm.toString(e))
        });
    }

    /// @dev Milestones cycling through all three check kinds, with six distinct amounts
    ///      and no two adjacent ones equal — so no invariant can pass by accident on
    ///      uniform milestones, and a released milestone can never be confused with a
    ///      refunded one of the same size. Both cycles are rotated per escrow so the
    ///      cohort does not repeat itself.
    ///
    ///      The check kinds are not decoration. `ClientApproval` means the parties agreed
    ///      there is no automated check at all, and the handler routes the client's
    ///      hand-approval at exactly those; the Http and Github milestones are the ones
    ///      that go through attestation and the challenge window. An even third of each
    ///      is what keeps both routes fed.
    function _cohortMilestones(uint256 e) private pure returns (Escrow.MilestoneInit[] memory ms) {
        uint128[6] memory amounts =
            [uint128(0.5 ether), uint128(1 ether), uint128(1.5 ether), uint128(2 ether), uint128(2.5 ether), 3 ether];

        uint256 n = _milestoneCount(e);
        ms = new Escrow.MilestoneInit[](n);
        for (uint256 i = 0; i < n; ++i) {
            ms[i] = Escrow.MilestoneInit({
                amount: amounts[(i + e) % 6],
                check: Escrow.Check((i + e) % 3),
                criteriaHash: keccak256(abi.encode("criteria", e, i))
            });
        }
    }

    /// @dev Coverage readout, one block per invariant run. The metrics table Foundry
    ///      prints counts calls that *reached the handler*; because the handler
    ///      try/catches, that number says nothing about whether an action actually
    ///      changed an escrow. These are the counts that matter: an action whose success
    ///      total is 0 proved nothing. Visible with `forge test -vv`.
    function afterInvariant() public view {
        uint256 n = handler.actionCount();
        for (uint256 i = 0; i < n; ++i) {
            string memory name = handler.actionAt(i);
            console.log("COVER", name, handler.attemptsOf(name), handler.successesOf(name));
        }
    }

    /*//////////////////////////////////////////////////////////////
                               INVARIANTS
    //////////////////////////////////////////////////////////////*/

    /// Money is never created. The two ledgers together can only ever account for what
    /// was escrowed at construction — if any path double-booked a milestone (released it
    /// and then refunded it, say) this is the counter that would overflow the deposit.
    function invariant_LedgersNeverExceedTheDeposit() public view {
        for (uint256 e = 0; e < escrows.length; ++e) {
            Escrow esc = escrows[e];
            assertLe(
                esc.releasedAmount() + esc.refundedAmount(),
                esc.totalAmount(),
                "released + refunded must never exceed what was funded"
            );
        }
    }

    /// Money is never destroyed or stranded. An escrow has no receive function and pays
    /// out only through `withdraw`, so its balance must equal its deposit minus exactly
    /// the wei the handler saw leave *that* escrow.
    function invariant_BalanceEqualsDepositMinusWithdrawals() public view {
        for (uint256 e = 0; e < escrows.length; ++e) {
            Escrow esc = escrows[e];
            assertEq(
                address(esc).balance,
                esc.totalAmount() - handler.withdrawnFrom(e),
                "escrow balance must be the deposit less every successful withdrawal"
            );
        }
    }

    /// The contract can always honour what it has promised: pull-based credits are a
    /// promise to pay, and the sum of every outstanding promise must be covered by the
    /// balance actually sitting in the contract.
    function invariant_BalanceCoversEveryOutstandingCredit() public view {
        for (uint256 e = 0; e < escrows.length; ++e) {
            Escrow esc = escrows[e];

            uint256 promised;
            for (uint256 a = 0; a < accounts.length; ++a) {
                promised += esc.owed(accounts[a]);
            }
            assertGe(address(esc).balance, promised, "escrow must hold at least everything it owes");
        }
    }

    /// Released money belongs to the freelancer and refunded money belongs to the
    /// client, and neither can be redirected. Every wei booked as released is either
    /// still credited to the freelancer or already in their pocket, and likewise for the
    /// client's refunds — so a milestone whose payout was credited to the wrong party
    /// shows up here even though `owed` would look perfectly consistent with itself.
    function invariant_CreditsBelongToTheRightSide() public view {
        for (uint256 e = 0; e < escrows.length; ++e) {
            Escrow esc = escrows[e];
            assertEq(
                esc.owed(freelancer) + handler.withdrawnFromBy(e, freelancer),
                esc.releasedAmount(),
                "every released wei is owed to, or already paid to, the freelancer"
            );
            assertEq(
                esc.owed(client) + handler.withdrawnFromBy(e, client),
                esc.refundedAmount(),
                "every refunded wei is owed to, or already paid to, the client"
            );
        }
    }

    /// Payouts land with the right party. A withdrawal must move exactly the credited
    /// amount to exactly the account that was credited — nobody else's balance moves,
    /// and no escrow of the cohort can pay on another's behalf.
    function invariant_WithdrawalsLandWithTheCreditedParty() public view {
        assertEq(
            client.balance,
            clientStartBalance + handler.withdrawnBy(client),
            "client received exactly what the client withdrew"
        );
        assertEq(
            freelancer.balance,
            freelancerStartBalance + handler.withdrawnBy(freelancer),
            "freelancer received exactly what the freelancer withdrew"
        );
        assertEq(arbiter.balance, 0, "the arbiter rules on disputes and is never paid by the escrow");
        assertEq(stranger.balance, 10 ether, "a bystander can trigger actions but never receives funds");
    }

    /// Every milestone sits in exactly one valid state, and the per-milestone states are
    /// the single source of truth for the two ledgers: the amounts of the Released
    /// milestones must be precisely `releasedAmount`, and likewise for Refunded. A
    /// ledger that drifted from the state machine would mean money booked for work whose
    /// milestone never actually closed.
    function invariant_StatesReconcileWithTheLedgers() public view {
        for (uint256 e = 0; e < escrows.length; ++e) {
            Escrow esc = escrows[e];
            Escrow.Milestone[] memory ms = esc.milestones();

            uint256 releasedSum;
            uint256 refundedSum;
            for (uint256 i = 0; i < ms.length; ++i) {
                assertLe(uint8(ms[i].state), uint8(Escrow.MState.Refunded), "milestone state is a valid enum member");
                if (ms[i].state == Escrow.MState.Released) releasedSum += ms[i].amount;
                if (ms[i].state == Escrow.MState.Refunded) refundedSum += ms[i].amount;
            }

            assertEq(releasedSum, esc.releasedAmount(), "Released milestones account for releasedAmount exactly");
            assertEq(refundedSum, esc.refundedAmount(), "Refunded milestones account for refundedAmount exactly");
            assertEq(
                releasedSum + refundedSum,
                esc.releasedAmount() + esc.refundedAmount(),
                "closed milestones account for every booked wei"
            );
        }
    }

    /// Released and Refunded are terminal. Once a milestone's money has been booked to
    /// somebody, no later call may move that milestone again — otherwise the same wei
    /// could be booked twice, to two different people. The handler records the first
    /// terminal state each milestone reached after every single action, so a flip at any
    /// point in the sequence is caught here.
    function invariant_TerminalMilestonesNeverMoveAgain() public view {
        for (uint256 e = 0; e < escrows.length; ++e) {
            Escrow.Milestone[] memory ms = escrows[e].milestones();

            for (uint256 i = 0; i < ms.length; ++i) {
                if (!handler.terminalSeen(e, i)) continue;
                assertEq(
                    uint256(ms[i].state),
                    uint256(handler.firstTerminal(e, i)),
                    "a milestone that reached Released or Refunded never changed state again"
                );
            }
        }
    }

    /// The milestone amounts are immutable and always add up to the deposit. Nothing in
    /// the lifecycle may resize a milestone, so no sequence can make the parts stop
    /// summing to the whole.
    function invariant_MilestoneAmountsAlwaysSumToTotal() public view {
        for (uint256 e = 0; e < escrows.length; ++e) {
            Escrow esc = escrows[e];
            Escrow.Milestone[] memory ms = esc.milestones();
            assertEq(ms.length, _milestoneCount(e), "milestone count is fixed at construction");

            uint256 sum;
            for (uint256 i = 0; i < ms.length; ++i) {
                sum += ms[i].amount;
            }
            assertEq(sum, esc.totalAmount(), "milestone amounts sum to totalAmount");
            assertEq(sum, deposits[e], "and to the amount the client actually sent");
        }
    }
}
