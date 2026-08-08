// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../../src/Escrow.sol";

/// @notice Drives a *cohort* of escrows through arbitrary legal call sequences on behalf
///         of the fuzzer. Every action pranks the role the chain would actually accept,
///         picks a real (escrow, milestone) pair, and wraps the call in try/catch so a
///         sequence is never cut short by a call that happened to arrive in the wrong
///         state.
///
/// @dev Why a cohort and not one escrow. Every closing action — `approve`, `release`,
///      `resolveDispute`, `reclaim` — consumes a milestone permanently, so the milestone
///      count is a hard ceiling on how many times those four can *collectively* succeed
///      in a run. With a single 12-milestone escrow that ceiling is 12 shared four ways,
///      which is why `release` measured 0 and `reclaim` 1: no amount of selection tuning
///      lifts a count above a budget that small. Three escrows with staggered deadlines
///      raise the budget and, more importantly, keep both halves of the lifecycle live at
///      once — while the oldest escrow is past its deadline and reclaimable, the youngest
///      is still accepting submissions and minting the Attested milestones `release`
///      needs.
///
/// @dev Ghost state lives here rather than in the invariant contract because Foundry
///      reverts the invariant contract's own storage between runs but keeps the handler's
///      for the duration of a run. Two families matter:
///        - `withdrawnFrom` / `withdrawnFromBy` / `withdrawnBy`: every wei that actually
///          left an escrow, credited both to the escrow it left and to the account that
///          received it.
///        - `firstTerminal` / `terminalSeen`: the first Released-or-Refunded state each
///          milestone ever reached, recorded after *every* action, so a later flip is
///          visible to the invariant even though the intermediate step is long gone.
contract EscrowHandler is Test {
    address public immutable client;
    address public immutable freelancer;
    address public immutable arbiter;

    /// @dev The verifier's key. The handler signs with it so attestations are genuine;
    ///      the point of the suite is legal sequences, not forgery (Attestation.t.sol
    ///      owns forgery).
    uint256 private immutable _verifierPk;

    bytes32 private constant REPORT_H = keccak256("invariant verifier report");

    Escrow[] private _escrows;
    uint256[] private _milestoneCounts;

    /*//////////////////////////////////////////////////////////////
                                 GHOSTS
    //////////////////////////////////////////////////////////////*/

    /// Wei that has left each escrow, and who received it.
    mapping(uint256 escrowIdx => uint256 amount) public withdrawnFrom;
    mapping(uint256 escrowIdx => mapping(address account => uint256 amount)) public withdrawnFromBy;

    /// The same wei aggregated across the whole cohort, per account.
    mapping(address account => uint256 amount) public withdrawnBy;

    mapping(uint256 escrowIdx => mapping(uint256 milestone => bool seen)) public terminalSeen;
    mapping(uint256 escrowIdx => mapping(uint256 milestone => Escrow.MState state)) public firstTerminal;

    /// How many of each escrow's milestones have already been recorded terminal. Purely a
    /// short-circuit for `_recordTerminalStates`, which runs after every single action.
    mapping(uint256 escrowIdx => uint256 count) private _terminalCount;

    /// @dev Which escrow the action in flight aimed at, or `_NONE` if it found no target.
    ///      Every action touches at most one escrow, so the terminal-state sweep only has
    ///      to look at that one — and can skip entirely when a call was a no-op.
    uint256 private constant _NONE = type(uint256).max;
    uint256 private _touched = _NONE;

    string[] private _actions;
    mapping(bytes32 action => uint256 count) private _attempts;
    mapping(bytes32 action => uint256 count) private _successes;

    constructor(Escrow[] memory escrows_, address client_, address freelancer_, address arbiter_, uint256 verifierPk_) {
        client = client_;
        freelancer = freelancer_;
        arbiter = arbiter_;
        _verifierPk = verifierPk_;

        for (uint256 e = 0; e < escrows_.length; ++e) {
            _escrows.push(escrows_[e]);
            _milestoneCounts.push(escrows_[e].milestoneCount());
        }

        _actions.push("accept");
        _actions.push("submit");
        _actions.push("attestPass");
        _actions.push("attestFail");
        _actions.push("approve");
        _actions.push("release");
        _actions.push("dispute");
        _actions.push("resolveDispute");
        _actions.push("reclaim");
        _actions.push("withdraw");
        _actions.push("warp");
        _actions.push("pokeClosedMilestone");
    }

    modifier act(string memory name) {
        _attempts[keccak256(bytes(name))] += 1;
        _touched = _NONE;
        _;
        if (_touched != _NONE) _recordTerminalStates(_touched);
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Caps out at one success per escrow per run, by construction.
    function accept(uint256 seed) external act("accept") {
        uint256 nE = _escrows.length;
        uint256 start = _spread(seed, "accept") % nE;

        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (start + x) % nE;
            Escrow esc = _escrows[e];
            if (esc.acceptedAt() != 0 || esc.cancelled()) continue;

            _touched = e;
            vm.prank(freelancer);
            try esc.accept() {
                _ok("accept");
            } catch {}
            return;
        }
    }

    function submit(uint256 seed, uint256 evidenceSeed) external act("submit") {
        (uint256 e, uint256 i, bool found) = _pickSubmittable(seed);
        if (!found) return;

        _touched = e;
        vm.prank(freelancer);
        try _escrows[e].submit(i, keccak256(abi.encode("evidence", e, evidenceSeed))) {
            _ok("submit");
        } catch {}
    }

    /// @dev Relayed by the handler itself — `attest` is permissionless, only the
    ///      signature counts. Pass and fail are separate selectors rather than one
    ///      fuzzed bool: with a bool the fuzzer only reaches Attested half as often, and
    ///      Attested is the gateway to the whole challenge-window half of the machine.
    function attestPass(uint256 seed) external act("attestPass") {
        if (_attest(seed, true)) _ok("attestPass");
    }

    /// @dev A failing attestation is a deliberate no-op — the freelancer iterates and
    ///      submits again. It must never be able to strand or close a milestone.
    function attestFail(uint256 seed) external act("attestFail") {
        if (_attest(seed, false)) _ok("attestFail");
    }

    function _attest(uint256 seed, bool passed) private returns (bool) {
        (uint256 e, uint256 i, bool found) = _pick(seed, Escrow.MState.Submitted, Escrow.MState.Submitted);
        if (!found) return false;

        _touched = e;
        Escrow esc = _escrows[e];
        Escrow.Milestone memory m = esc.milestoneAt(i);

        bytes32 digest = esc.attestationDigest(i, m.submissions, passed, m.evidenceHash, REPORT_H);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_verifierPk, digest);

        try esc.attest(i, m.submissions, passed, REPORT_H, abi.encodePacked(r, s, v)) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev The client signs off by hand where signing off by hand is the whole plan:
    ///      see `_pickManualApproval` for why this action stays off the milestones the
    ///      verifier is supposed to handle.
    function approve(uint256 seed) external act("approve") {
        (uint256 e, uint256 i, bool found) = _pickManualApproval(seed);
        if (!found) return;

        _touched = e;
        vm.prank(client);
        try _escrows[e].approve(i) {
            _ok("approve");
        } catch {}
    }

    /// @dev No prank: `release` is permissionless, and the handler standing in for
    ///      "anyone" is exactly the point of the mechanism.
    function release(uint256 seed) external act("release") {
        (uint256 e, uint256 i, bool found) = _pickReleasable(seed);
        if (!found) return;

        _touched = e;
        try _escrows[e].release(i) {
            _ok("release");
        } catch {}
    }

    function dispute(uint256 seed) external act("dispute") {
        (uint256 e, uint256 i, bool found) = _pickObjection(seed);
        if (!found) return;

        _touched = e;
        vm.prank(client);
        try _escrows[e].dispute(i) {
            _ok("dispute");
        } catch {}
    }

    function resolveDispute(uint256 seed, bool toFreelancer) external act("resolveDispute") {
        (uint256 e, uint256 i, bool found) = _pick(seed, Escrow.MState.Disputed, Escrow.MState.Disputed);
        if (!found) return;

        _touched = e;
        vm.prank(arbiter);
        try _escrows[e].resolveDispute(i, toFreelancer) {
            _ok("resolveDispute");
        } catch {}
    }

    function reclaim(uint256 seed) external act("reclaim") {
        (uint256 e, uint256 i, bool found) = _pickReclaimable(seed);
        if (!found) return;

        _touched = e;
        vm.prank(client);
        try _escrows[e].reclaim(i) {
            _ok("reclaim");
        } catch {}
    }

    /// @dev The only action that moves ether out of an escrow, so it is the only place
    ///      the balance ghosts are allowed to change. The credit is read *before* the
    ///      call and only booked if the call actually succeeded.
    function withdraw(uint256 seed, bool asClient) external act("withdraw") {
        address who = asClient ? client : freelancer;
        uint256 nE = _escrows.length;
        uint256 start = _spread(seed, "withdraw") % nE;

        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (start + x) % nE;
            uint256 amount = _escrows[e].owed(who);
            if (amount == 0) continue;

            _touched = e;
            vm.prank(who);
            try _escrows[e].withdraw() {
                withdrawnFromBy[e][who] += amount;
                withdrawnFrom[e] += amount;
                withdrawnBy[who] += amount;
                _ok("withdraw");
            } catch {}
            return;
        }
    }

    /// @dev The clock is the scarcest resource in this suite and both ends of the bound
    ///      are tuned, not arbitrary.
    ///
    ///      The floor is the challenge window itself. Every hop must ripen a milestone
    ///      attested before it, or `release` is left waiting on a coincidence of two
    ///      fuzzed choices — the previous 1 hour floor put the mean hop at 1.7 days but
    ///      left plenty of individual hops too short to matter.
    ///
    ///      The ceiling is narrow for a subtler reason: it is what keeps the *total*
    ///      clock predictable. A run makes 60 to 90 hops depending on how the fuzzer
    ///      spends its turns, so a wide per-hop range compounds into a wildly variable
    ///      finish date — at 1-4 days runs landed anywhere from day 130 to day 200, and
    ///      the deadlines below could not be placed anywhere sensible against that. At
    ///      1-2 days a run finishes near day 100 either way, which is what makes the
    ///      staggered deadlines in Invariant.t.sol land where they are meant to.
    ///
    ///      A hop can never vault the whole cohort past its last deadline in one go
    ///      either, which would shut `submit` off and starve the Submitted -> Attested ->
    ///      Released path for the rest of the run.
    function warp(uint256 secondsSeed) external act("warp") {
        vm.warp(block.timestamp + bound(secondsSeed, 1 days, 2 days));
        _ok("warp");
    }

    /// @notice Fires a mutating call at a milestone that has ALREADY closed, from the
    ///         role that would be allowed to make that call if the milestone were still
    ///         open.
    /// @dev Every other action deliberately picks a milestone the call is legal on,
    ///      which is what keeps sequences productive — but it also means the contract's
    ///      own state guards are almost never asked to say no, and "Released and
    ///      Refunded are final" can only be violated by a call the guards let through.
    ///      This action is the adversary: all seven of these must bounce, and if any one
    ///      of them lands the terminal-state and ledger invariants catch it.
    function pokeClosedMilestone(uint256 seed, uint256 whichSeed, bool flag) external act("pokeClosedMilestone") {
        (uint256 e, uint256 i, bool found) = _pick(seed, Escrow.MState.Released, Escrow.MState.Refunded);
        if (!found) return;

        _touched = e;
        Escrow esc = _escrows[e];
        uint256 which = bound(whichSeed, 0, 6);

        if (which == 0) {
            vm.prank(freelancer);
            try esc.submit(i, keccak256("poke")) {} catch {}
        } else if (which == 1) {
            vm.prank(client);
            try esc.approve(i) {} catch {}
        } else if (which == 2) {
            try esc.release(i) {} catch {}
        } else if (which == 3) {
            vm.prank(client);
            try esc.dispute(i) {} catch {}
        } else if (which == 4) {
            vm.prank(arbiter);
            try esc.resolveDispute(i, flag) {} catch {}
        } else if (which == 5) {
            vm.prank(client);
            try esc.reclaim(i) {} catch {}
        } else {
            Escrow.Milestone memory m = esc.milestoneAt(i);
            bytes32 digest = esc.attestationDigest(i, m.submissions, true, m.evidenceHash, REPORT_H);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(_verifierPk, digest);
            try esc.attest(i, m.submissions, true, REPORT_H, abi.encodePacked(r, s, v)) {} catch {}
        }

        _ok("pokeClosedMilestone");
    }

    /*//////////////////////////////////////////////////////////////
                            SELECTION HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Decorrelated offsets from one fuzzed word. The raw seed is consumed by
    ///      several helpers within the same call, so hashing with a per-use tag stops the
    ///      escrow index, the milestone index and the tier coin moving in lockstep.
    function _spread(uint256 seed, string memory tag) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, tag)));
    }

    /// @dev Find a milestone the caller's action is legal on, preferring state `want`
    ///      over `alt`. Each tier sweeps the whole cohort before the next is tried, so
    ///      the preference is global rather than per-escrow.
    ///
    /// @dev Why scan at all: without it the index is diluted across every milestone and
    ///      most calls degrade into no-ops. Selecting an actionable milestone narrows
    ///      *which* milestone gets hit, never *which action* is tried, so the fuzzer
    ///      still explores every ordering.
    function _pick(uint256 seed, Escrow.MState want, Escrow.MState alt) private view returns (uint256, uint256, bool) {
        uint256 h = _spread(seed, "pick");

        (uint256 e, uint256 i, bool hit) = _sweep(h, want);
        if (hit || want == alt) return (e, i, hit);
        return _sweep(h, alt);
    }

    /// @dev One tier of `_pick`: the cohort loop.
    ///
    /// @dev Escrows nobody has accepted yet are skipped. Apart from `reclaim` — which has
    ///      its own picker and deliberately does not skip them — no action is legal on
    ///      one, so scanning them only burns calls in the few steps before `accept` lands.
    function _sweep(uint256 h, Escrow.MState want) private view returns (uint256, uint256, bool) {
        uint256 nE = _escrows.length;
        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (h + x) % nE;
            if (_escrows[e].acceptedAt() == 0) continue;

            (uint256 i, bool hit) = _stateIn(_escrows[e], h >> 128, want);
            if (hit) return (e, i, true);
        }
        return (0, 0, false);
    }

    /// @dev One escrow's milestones, scanned cyclically from a fuzzed offset.
    function _stateIn(Escrow esc, uint256 i0, Escrow.MState want) private view returns (uint256, bool) {
        Escrow.Milestone[] memory ms = esc.milestones();
        uint256 n = ms.length;

        for (uint256 y = 0; y < n; ++y) {
            uint256 i = (i0 + y) % n;
            if (ms[i].state == want) return (i, true);
        }
        return (0, false);
    }

    /// @dev Where the client's hand-approval goes. `approve` and `dispute` are the only
    ///      other actions that can take a Submitted or Attested milestone, and between
    ///      them they fire at twice the rate of `attestPass` and `release`, so pointed at
    ///      the same pool they strip it bare: measured, `approve` alone closed 24 of the
    ///      48 available milestones and `attestPass` was left with 10.
    ///
    ///      The escrow already draws the line for us. A milestone's `check` records how
    ///      the parties agreed it would be judged, and `ClientApproval` means exactly
    ///      "no automated check, the client releases by hand" — those are the ones a
    ///      client actually has to approve. On an Http or Github milestone the client
    ///      hired a verifier to say yes, so their realistic move is to let the
    ///      attestation and the challenge window run, and their remaining lever is the
    ///      objection in `dispute`. So: manual milestones first, and the only other thing
    ///      this action will take is an attestation still inside its window — the
    ///      documented short-circuit. It never touches a window that has already elapsed,
    ///      because at that point the client's silence has already authorised `release`.
    function _pickManualApproval(uint256 seed) private view returns (uint256, uint256, bool) {
        uint256 h = _spread(seed, "approve");

        (uint256 e, uint256 i, bool hit) = _sweepManual(h, Escrow.MState.Submitted);
        if (hit) return (e, i, true);

        (e, i, hit) = _sweepManual(h, Escrow.MState.Attested);
        if (hit) return (e, i, true);

        return _sweepOpenAttested(h);
    }

    /// @dev Where the client's objection goes. A client with a reason to object has one
    ///      of exactly two reasons, and both are legible on-chain:
    ///        - the verifier passed work they do not accept — an Attested milestone still
    ///          inside its challenge window, which is the product's central adversarial
    ///          path and, conveniently, free of contention because `release` cannot have
    ///          that milestone until the window elapses anyway;
    ///        - the work has already bounced — a Submitted milestone with more than one
    ///          submission behind it, meaning a verifier check has already failed once.
    ///
    ///      Deliberately nothing else. Pointed at *any* Submitted milestone this action
    ///      strips the pool `attestPass` feeds on: measured that way it closed 19 of the
    ///      48 available milestones and left `attestPass` 13 and `release` 5. Untouched
    ///      first submissions are the raw material of the whole attest-and-release path.
    ///
    ///      An elapsed window is left alone too. By then the client has had their say and
    ///      said nothing, which is precisely the silence `release` is built on.
    ///
    ///      The one-in-three coin on the first reason is the other half of the fix. The
    ///      fuzzer gives `dispute` as many turns as `release`, and an attestation is
    ///      contestable from the instant it lands whereas it is only releasable a day
    ///      later — so a client who objects at every opportunity wins that race almost
    ///      every time and the challenge window never gets to expire on anything.
    ///      Measured without the coin: `dispute` took 18 of the 35 attestations in a run
    ///      and `release` got 7. A client who objects to one attestation in three is both
    ///      the more realistic actor and the one that leaves the mechanism observable.
    function _pickObjection(uint256 seed) private view returns (uint256, uint256, bool) {
        uint256 h = _spread(seed, "dispute");

        if (h % 4 == 0) {
            (uint256 e, uint256 i, bool hit) = _sweepOpenAttested(h);
            if (hit) return (e, i, true);
        }

        return _sweepResubmitted(h);
    }

    /// @dev Cohort sweep for a Submitted milestone the freelancer has already had to
    ///      submit more than once.
    function _sweepResubmitted(uint256 h) private view returns (uint256, uint256, bool) {
        uint256 nE = _escrows.length;
        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (h + x) % nE;
            if (_escrows[e].acceptedAt() == 0) continue;

            (uint256 i, bool hit) = _resubmittedIn(_escrows[e], h >> 128);
            if (hit) return (e, i, true);
        }
        return (0, 0, false);
    }

    function _resubmittedIn(Escrow esc, uint256 i0) private view returns (uint256, bool) {
        Escrow.Milestone[] memory ms = esc.milestones();
        uint256 n = ms.length;

        for (uint256 y = 0; y < n; ++y) {
            uint256 i = (i0 + y) % n;
            if (ms[i].state == Escrow.MState.Submitted && ms[i].submissions > 1) return (i, true);
        }
        return (0, false);
    }

    /// @dev Cohort sweep for a milestone in state `want` whose agreed check is
    ///      `ClientApproval`.
    function _sweepManual(uint256 h, Escrow.MState want) private view returns (uint256, uint256, bool) {
        uint256 nE = _escrows.length;
        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (h + x) % nE;
            if (_escrows[e].acceptedAt() == 0) continue;

            (uint256 i, bool hit) = _manualIn(_escrows[e], h >> 128, want);
            if (hit) return (e, i, true);
        }
        return (0, 0, false);
    }

    function _manualIn(Escrow esc, uint256 i0, Escrow.MState want) private view returns (uint256, bool) {
        Escrow.Milestone[] memory ms = esc.milestones();
        uint256 n = ms.length;

        for (uint256 y = 0; y < n; ++y) {
            uint256 i = (i0 + y) % n;
            if (ms[i].state == want && ms[i].check == Escrow.Check.ClientApproval) return (i, true);
        }
        return (0, false);
    }

    /// @dev Cohort sweep for an Attested milestone whose challenge window is still open.
    function _sweepOpenAttested(uint256 h) private view returns (uint256, uint256, bool) {
        uint256 nE = _escrows.length;
        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (h + x) % nE;

            (uint256 i, bool hit) = _openAttestedIn(_escrows[e], h >> 128);
            if (hit) return (e, i, true);
        }
        return (0, 0, false);
    }

    function _openAttestedIn(Escrow esc, uint256 i0) private view returns (uint256, bool) {
        Escrow.Milestone[] memory ms = esc.milestones();
        uint256 n = ms.length;
        uint256 window = esc.challengeWindow();

        for (uint256 y = 0; y < n; ++y) {
            uint256 i = (i0 + y) % n;
            if (ms[i].state != Escrow.MState.Attested) continue;
            if (block.timestamp < uint256(ms[i].attestedAt) + window) return (i, true);
        }
        return (0, false);
    }

    /// @dev Attested *and* out of its challenge window, else any Attested at all — so the
    ///      release path is reached often and `ChallengeWindowOpen` is still exercised.
    function _pickReleasable(uint256 seed) private view returns (uint256, uint256, bool) {
        uint256 h = _spread(seed, "releasable");
        uint256 nE = _escrows.length;

        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (h + x) % nE;
            (uint256 i, bool hit) = _attestedIn(_escrows[e], h >> 128, true);
            if (hit) return (e, i, true);
        }
        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (h + x) % nE;
            (uint256 i, bool hit) = _attestedIn(_escrows[e], h >> 128, false);
            if (hit) return (e, i, true);
        }
        return (0, 0, false);
    }

    /// @param ripeOnly Restrict the match to milestones whose challenge window has run
    ///        out. False accepts any Attested milestone.
    function _attestedIn(Escrow esc, uint256 i0, bool ripeOnly) private view returns (uint256, bool) {
        Escrow.Milestone[] memory ms = esc.milestones();
        uint256 n = ms.length;
        uint256 window = esc.challengeWindow();

        for (uint256 y = 0; y < n; ++y) {
            uint256 i = (i0 + y) % n;
            if (ms[i].state != Escrow.MState.Attested) continue;
            if (!ripeOnly || block.timestamp >= uint256(ms[i].attestedAt) + window) return (i, true);
        }
        return (0, false);
    }

    /// @dev What the client reclaims once a deadline has gone by, in the order a client
    ///      would actually reach for it:
    ///        1. a Pending milestone in an expired escrow — never even attempted, the
    ///           textbook "deadline passed unearned";
    ///        2. a Submitted one in an expired escrow — legal, and a real race, since
    ///           `attest` and `release` have no deadline check and the freelancer can
    ///           still get paid for late-but-proven work;
    ///        3. anything unearned at all, so `DeadlineNotPassed` still gets exercised.
    ///
    ///      Taking Pending before Submitted matters more than it looks. Reaching for
    ///      whichever came first, this action drained the pipeline the moment the first
    ///      deadline passed — measured that way it closed 19 of the 48 milestones,
    ///      largely by snatching submitted work out from under `attestPass`, and
    ///      `release` was left with 6. Unstarted milestones are the ones with no other
    ///      claimant.
    ///
    ///      Unlike `_sweep` this does not skip unaccepted escrows: an offer the
    ///      freelancer never took up is precisely the money a client may reclaim.
    function _pickReclaimable(uint256 seed) private view returns (uint256, uint256, bool) {
        uint256 h = _spread(seed, "reclaimable");

        (uint256 e, uint256 i, bool hit) = _sweepExpired(h, Escrow.MState.Pending);
        if (hit) return (e, i, true);

        (e, i, hit) = _sweepExpired(h, Escrow.MState.Submitted);
        if (hit) return (e, i, true);

        uint256 nE = _escrows.length;
        for (uint256 x = 0; x < nE; ++x) {
            uint256 f = (h + x) % nE;
            (uint256 j, bool got) = _stateIn(_escrows[f], h >> 128, Escrow.MState.Pending);
            if (got) return (f, j, true);
        }
        return (0, 0, false);
    }

    /// @dev Cohort sweep restricted to escrows whose deadline has already passed.
    function _sweepExpired(uint256 h, Escrow.MState want) private view returns (uint256, uint256, bool) {
        uint256 nE = _escrows.length;
        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (h + x) % nE;
            if (block.timestamp < _escrows[e].deadline()) continue;

            (uint256 i, bool hit) = _stateIn(_escrows[e], h >> 128, want);
            if (hit) return (e, i, true);
        }
        return (0, 0, false);
    }

    /// @dev What the freelancer submits against. Live escrows first — `submit` is the one
    ///      action the deadline shuts off completely, so aiming at an expired escrow just
    ///      burns the call. The last tier deliberately aims at one anyway, so
    ///      `DeadlinePassed` is still exercised.
    ///
    ///      One call in three revisits a milestone that is already Submitted rather than
    ///      starting a fresh one. That is the "iterate after a failing attestation" flow
    ///      the contract is explicitly built for, and it is the only thing that drives the
    ///      submission counter above 1 — which is what invalidates a stale attestation,
    ///      and what tells `_pickObjection` the work has already bounced. Always
    ///      preferring Pending left `submissions > 1` almost unreachable and that whole
    ///      branch untested.
    function _pickSubmittable(uint256 seed) private view returns (uint256, uint256, bool) {
        uint256 h = _spread(seed, "submittable");

        if (h % 3 == 0) {
            (uint256 e, uint256 i, bool hit) = _sweepLive(h, Escrow.MState.Submitted);
            if (hit) return (e, i, true);
        }

        (uint256 e2, uint256 i2, bool hit2) = _sweepLive(h, Escrow.MState.Pending);
        if (hit2) return (e2, i2, true);

        (e2, i2, hit2) = _sweepLive(h, Escrow.MState.Submitted);
        if (hit2) return (e2, i2, true);

        return _sweep(h, Escrow.MState.Pending);
    }

    /// @dev Cohort sweep restricted to accepted escrows still inside their deadline.
    function _sweepLive(uint256 h, Escrow.MState want) private view returns (uint256, uint256, bool) {
        uint256 nE = _escrows.length;
        for (uint256 x = 0; x < nE; ++x) {
            uint256 e = (h + x) % nE;
            if (_escrows[e].acceptedAt() == 0) continue;
            if (block.timestamp >= _escrows[e].deadline()) continue;

            (uint256 i, bool hit) = _stateIn(_escrows[e], h >> 128, want);
            if (hit) return (e, i, true);
        }
        return (0, 0, false);
    }

    /*//////////////////////////////////////////////////////////////
                            GHOST BOOKKEEPING
    //////////////////////////////////////////////////////////////*/

    function _recordTerminalStates(uint256 e) private {
        if (_terminalCount[e] == _milestoneCounts[e]) return;

        Escrow.Milestone[] memory ms = _escrows[e].milestones();
        for (uint256 i = 0; i < ms.length; ++i) {
            Escrow.MState st = ms[i].state;
            if (st != Escrow.MState.Released && st != Escrow.MState.Refunded) continue;
            if (terminalSeen[e][i]) continue;
            terminalSeen[e][i] = true;
            firstTerminal[e][i] = st;
            _terminalCount[e] += 1;
        }
    }

    function _ok(string memory name) private {
        _successes[keccak256(bytes(name))] += 1;
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    function escrowCount() external view returns (uint256) {
        return _escrows.length;
    }

    function escrowAt(uint256 e) external view returns (Escrow) {
        return _escrows[e];
    }

    /*//////////////////////////////////////////////////////////////
                            COVERAGE READOUT
    //////////////////////////////////////////////////////////////*/

    function actionCount() external view returns (uint256) {
        return _actions.length;
    }

    function actionAt(uint256 i) external view returns (string memory) {
        return _actions[i];
    }

    function attemptsOf(string memory name) external view returns (uint256) {
        return _attempts[keccak256(bytes(name))];
    }

    function successesOf(string memory name) external view returns (uint256) {
        return _successes[keccak256(bytes(name))];
    }
}
