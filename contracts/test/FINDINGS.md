# Contract findings from the Wave-1 test authors

Produced while writing `contracts/test/**` (T-1..T-9). **Nothing here has been fixed** —
`contracts/src/**` belongs to Alfa per C10, so these are reported, not patched. No test was
weakened to accommodate any of them; where current behaviour is defensible the test asserts
the current behaviour and the finding says so.

Nine agents worked in isolation and could not read each other's output, so where several
landed on the same thing independently that is convergent evidence, not repetition. The
count is noted below.

---

## Worth a decision before deployment

**F-A · `getEscrows(offset, limit)` panics instead of clamping.** *(found twice, one
empirical repro)* `EscrowFactory.sol:68` computes `uint256 end = offset + limit;` under
checked arithmetic, so a caller passing a large `limit` — `type(uint256).max` is the obvious
"give me everything from here" sentinel — reverts with arithmetic `Panic(0x11)` rather than
`BadRange()` or a clamped page. `BadRange()` only fires for `offset > total`. This is the one
finding in the list that is unambiguously a bug rather than a judgement call, it is a
one-line fix, and it will hit the frontend in Wave 4 the first time a list view asks for
everything. Verified empirically in an isolated copy.

**F-B · `challengeWindow` is unvalidated at both ends.** *(found three times)* Neither a
minimum nor a maximum. The two ends fail differently:

- `challengeWindow == 0` means `release()` computes `openUntil == attestedAt == block.timestamp`,
  so whoever holds the verifier key can `attest(passed=true)` and `release()` in a single
  transaction with the client having no opportunity to `dispute()`. That is the verifier
  acting as a unilateral authority over the client's funds, which is the exact thing this
  project's design note says must never happen. It is also a documented capability —
  `docs/03-CLAUDE-CODE.md` requires T-4 to prove window 0 releases immediately, and
  `ChallengeWindow.t.sol` does prove it. So this is not a contradiction to fix silently: it
  is a decision about whether zero should be reachable at all, and if it stays, whether the
  UI may ever offer it.
- No upper bound (`uint32`, ~136 years). An `Attested` milestone cannot be reclaimed after
  the deadline (`reclaim` takes only Pending/Submitted) and cannot be released until the
  window elapses, so a large window strands the money with no exit but `approve()` or
  `dispute()`. A cap costs one comparison.

**F-C · A `Disputed` milestone has no timeout and no escape hatch.** *(found twice)*
`resolveDispute()` is the only transition out of `Disputed`, it is arbiter-only, and it has
no deadline. `reclaim()` explicitly refuses `Disputed`. An arbiter who goes unresponsive or
loses their key freezes that milestone permanently. Probably out of scope for a hackathon
build, but the pitch is a trust story, and "what if the arbiter disappears" is the fourth
question a sceptic asks.

**F-D · After the deadline, `reclaim` and `attest` race for a `Submitted` milestone.**
*(found twice)* `submit()` is deadline-gated but `attest()` is not, and `reclaim()` accepts
`Submitted`. A freelancer who submitted at `deadline - 1` and holds a valid pass signature
can front-run the client's `reclaim` and put the milestone permanently out of reclaim's
reach. This is arguably the intended behaviour — the `reclaim` docstring says work proven in
time survives the deadline — but as written it resolves by transaction ordering rather than
by rule, and neither party is told that.

**F-E · Error identity depends on the clock and the caller, not on what is actually wrong.**
*(found three times)* Guard ordering differs between functions: `dispute`, `approve`,
`resolveDispute` and `reclaim` check the role before `_milestone(i)`'s range check, while
`attest` checks the range first. So `client.reclaim(999)` before the deadline reverts
`DeadlineNotPassed`, not `BadMilestone`; `stranger.dispute(99)` reverts `NotClient`, not
`BadMilestone`; a cancelled escrow past its deadline reverts `EscrowCancelled` and never
`DeadlinePassed`. Harmless on-chain. It matters because Wave 4 was going to derive the "why
can't I do this" message from the revert selector, and that will sometimes show the user the
wrong reason. Taskforce will handle this in the UI rather than asking for a contract change.

## Noted, no action proposed

- **Constructor stores before it validates** (`Escrow.sol:214-234`): all 20 milestone pushes
  happen before the `VerifierRequired` and `FundingMismatch` checks. Correct — the whole
  create reverts — but a rejected creation burns SSTORE-heavy work for nothing, and on Monad
  the user pays the gas *limit*.
- **No minimum deadline**: `deadline == block.timestamp + 1` is legal, producing an escrow
  that can be created but never accepted. A UI concern.
- **`termsHash` / `criteriaHash` may be zero**, so an escrow can exist with no agreement text
  behind it, while `accept()` is documented as agreeing to "the exact terms hashed at
  construction".
- **Dead branch in `cancel()`** *(found three times)*: `if (m.state == MState.Pending)` can
  never be false, because `cancel()` requires `acceptedAt == 0` and nothing leaves `Pending`
  before acceptance. Harmless, but it reads as though a partial refund were possible, which
  hides the real invariant from the next person to edit it.
- **`EscrowCreated.totalAmount` emits `msg.value`**, not the escrow's own `totalAmount()`.
  Equal only because the constructor enforces it; wrong the moment a fee or a partial-funding
  path is ever added.
- **`escrowsOf` is unbounded and unpaginated**, and anyone may name any address as
  `p.freelancer`. An address can be padded with unwanted offers (each one funded by the
  spammer) until the view is too large for a frontend `eth_call`.
- **`resolveDispute` emits `DisputeResolved` before `Released`/`Refunded`** — outcome event
  ahead of money event. Unusual ordering for an indexer.
- **`submit` accepts `evidenceHash == 0`**, so a submitted milestone is indistinguishable
  from an unsubmitted one for any UI reading `evidenceHash` alone.
- **Resubmitting identical evidence still bumps the counter**, letting a freelancer invalidate
  an honest in-flight attestation at will. Self-harming only.
- **`withdraw()` pays only `msg.sender`** — no `withdrawTo`, no rescue path — so a payee that
  cannot receive ether strands its credit permanently. The rejecting-receiver test asserts
  the current behaviour is at least safe: the balance rolls back rather than zeroing.
- **`withdraw()` is protected twice**: the transient `nonReentrant` guard *and* correct CEI
  ordering. Mutation-tested — removing the modifier alone does not open the hole.

---

## Every finding, verbatim, grouped by the file whose author reported it

### `Acceptance.t.sol`

- src/Escrow.sol:277 — dead branch in cancel(): `if (m.state == MState.Pending)` can never be false. cancel() requires acceptedAt == 0, and nothing can leave Pending before acceptance (submit() reverts NotAccepted). So `amount` is always exactly totalAmount and cancel() is always a full refund. Not a bug, but the code reads as if a partial refund were possible, which hides the real invariant and invites a future edit that relaxes the AlreadyStarted guard without noticing what breaks.

- src/Escrow.sol:202 vs 259 — no minimum notice between construction and the deadline. The constructor only requires `p.deadline > block.timestamp`, while accept() rejects at `block.timestamp >= deadline`. An escrow created with `deadline = block.timestamp + 1` is therefore born already impossible to accept in practice; the funds are only recoverable by the client calling reclaim() on each milestone after the deadline. A UI must not offer such a deadline, and the chain will not stop it.

- src/Escrow.sol:256-259 — error precedence in accept() is cancelled -> AlreadyAccepted -> DeadlinePassed, so a cancelled escrow whose deadline has also passed reports EscrowCancelled() and never DeadlinePassed(). Correct behaviour, but a UI that explains 'why can't I accept' from the revert selector alone will only ever surface the first blocking reason, not all of them.

- src/EscrowFactory.sol:49-50 — anyone may name any address as `p.freelancer`, and the factory unconditionally pushes the new escrow into `_byParty[p.freelancer]`. A freelancer's on-chain inbox can therefore be padded with unwanted offers (bounded only by the spammer having to fund each one), and unlike `getEscrows` there is no paginated variant of `escrowsOf` — it returns the whole unbounded array, so a heavily-listed address can eventually make that view too large for a frontend eth_call.

### `ChallengeWindow.t.sol`

- NOT A DEFECT, but a UI contract note for whoever builds the countdown: when challengeWindow==0 and a milestone is Attested, releasableAt(i) returns a NON-ZERO timestamp (== attestedAt == the current block) while challengeRemaining(i) returns 0. A frontend that infers "a countdown is running" from releasableAt(i) != 0 alone will render a timer for an escrow that is already releasable. The correct read is challengeRemaining(i) > 0. Verified in test_ZeroChallengeWindowReleasesInTheAttestationBlock. src/Escrow.sol:438-451.

- NO defects found in src/. Escrow.release, Escrow.releasableAt and Escrow.challengeRemaining behaved correctly on every property tested, including the inclusive >= boundary, the zero-window case, per-milestone isolation, and the state guards on both views. I additionally ran a mutation audit in a throwaway copy (never touching the sandbox src/): deleting the timing check, flipping < to <=, deleting release()'s Attested guard, deleting either view's Attested guard, deleting challengeRemaining's zero-clamp, and making a failing attestation set Attested — all six mutants were killed by this file.

### `Construction.t.sol`

- src/Escrow.sol constructor does NOT validate challengeWindow, and challengeWindow == 0 breaks the contract's headline invariant that 'the verifier proposes, it does not decide'. With a zero window, release() computes openUntil = attestedAt + 0 == block.timestamp, and `block.timestamp < openUntil` is false immediately — so whoever holds the verifier key can attest(i, ..., passed=true) and release(i) in the SAME transaction, paying the freelancer with the client having zero opportunity to dispute(). An escrow created with challengeWindow 0 makes the off-chain verifier a unilateral authority over the client's funds. Suggest requiring a nonzero (ideally a sane minimum) challengeWindow at construction. I did not test this in Construction.t.sol because no such check exists; reporting instead of writing a failing test, and flagging it for whoever owns the release/challenge-window tests.

- src/Escrow.sol has no upper bound on challengeWindow either (uint32, up to ~136 years). Because reclaim() only accepts Pending/Submitted, an Attested milestone with an absurd window cannot be reclaimed after the deadline and cannot be released until the window elapses — the funds are stranded with no path out except the client calling approve() or dispute(). A cap (e.g. <= 30 days) would close it.

- src/Escrow.sol:214-234 — the constructor pushes every milestone into storage BEFORE the VerifierRequired (line 234) and FundingMismatch (line 235) checks. Correctness is fine (the whole create reverts), but a rejected create burns 20 SSTORE-heavy pushes for nothing, which matters on Monad where the user pays the gas limit. Hoisting the sum/needsVerifier loop above the pushes, or moving the two checks before the loop, would make failures cheap.

- Minor: deadline has no minimum duration — deadline == block.timestamp + 1 is legal. Combined with reclaim(), a client can create an escrow that is dead one second after creation; if a freelancer accepts it they can never submit and the client reclaims everything. Visible in the params so it is a UI-warning issue rather than a hole, but a minimum duration would be safer.

- Minor: termsHash and criteriaHash are never checked non-zero, so an escrow can be created with no agreement text and no acceptance criteria behind it. Probably deliberate, but worth confirming — accept() is documented as the freelancer agreeing to 'the exact terms hashed at construction', which is meaningless when that hash is 0.

### `Dispute.t.sol`

- src/Escrow.sol dispute()/resolveDispute()/reclaim() — a Disputed milestone has exactly ONE exit and it is arbiter-only. resolveDispute() is the sole transition out of MState.Disputed, reclaim() explicitly excludes Disputed (it accepts only Pending/Submitted), and `arbiter` is immutable with no replacement path and no timeout. If the arbiter is unreachable or loses the key, that milestone's funds are locked in the contract permanently — no deadline, no fallback, no expiry. Everything else in this contract is carefully designed so no single party can strand funds; the dispute path is the one place where a single unresponsive address can. Worth a DECIDE: an 'after deadline + N, an unresolved dispute refunds the client' escape, or at least documenting it in the UI before a client freezes anything.

- src/Escrow.sol dispute() has no deadline guard, so the client can dispute a Submitted milestone AFTER the deadline and thereby convert a milestone they could have reclaim()'d into one only the arbiter can free (reclaim then reverts WrongState(Disputed)). It is the client's own money, so it is self-harming rather than exploitable, but it is a one-way trap the UI must never offer post-deadline — after the deadline, 'reclaim' should be the only action shown for a Submitted milestone, never 'dispute'.

- src/Escrow.sol resolveDispute() emits DisputeResolved(i, toFreelancer) BEFORE the Released/Refunded event that _release/_refund emits. Not a bug, but it is unusual ordering (the outcome event precedes the money event) and any indexer or UI that assumes Released/Refunded comes first will mis-sequence the dispute timeline. My tests lock this order in, so reordering it will turn them red.

- src/Escrow.sol — in dispute(), approve(), resolveDispute() and reclaim() the role check runs BEFORE _milestone(i)'s range check, so e.g. dispute(99) from a stranger reverts NotClient() rather than BadMilestone(). attest() has the opposite order (range first). Harmless on-chain but it makes error-to-message mapping in the UI inconsistent between actions.

- src/EscrowFactory.sol getEscrows(offset, limit) line 68 — `uint256 end = offset + limit;` reverts with an arithmetic Panic (0x11) rather than BadRange() when a caller passes a large limit (e.g. type(uint256).max as an 'everything from here' sentinel). BadRange() only fires for offset > total. Consider clamping instead of adding, so the paginator has one documented error.

### `Factory.t.sol`

- LOW — src/EscrowFactory.sol:68, getEscrows(uint256 offset, uint256 limit): `uint256 end = offset + limit;` is checked arithmetic, so a large `limit` panics (0x11 arithmetic overflow) instead of clamping. Verified empirically in an isolated copy: getEscrows(0, type(uint256).max) correctly returns the full list, but getEscrows(1, type(uint256).max) reverts with panic 0x11. A frontend that uses a max-uint sentinel to mean "everything from here" gets an unhelpful panic rather than the clamp the function otherwise promises — and the factory is the only index the UI has. Fix: clamp before adding, e.g. `uint256 end = limit > total - offset ? total : offset + limit;` (safe because `offset <= total` is already enforced by the BadRange guard on the line above). Not fixed and not tested for, per the read-only rule on src/; my test uses type(uint128).max, which is a realistic sentinel and does clamp correctly.

- INFO — src/EscrowFactory.sol:52: EscrowCreated's `totalAmount` field is emitted as `msg.value`, not as the escrow's own `totalAmount()`. They are equal only because Escrow's constructor enforces `sum == msg.value` (src/Escrow.sol:235). Correct today; it becomes wrong the moment the factory ever forwards anything other than the full msg.value. My event test cross-checks the logged value against `Escrow(created).totalAmount()` so the coupling is pinned.

- INFO — src/EscrowFactory.sol:49-50: if `msg.sender == p.freelancer` the escrow would be pushed into the same party list twice, producing a duplicate row on that dashboard. Unreachable in practice because Escrow's constructor reverts with ClientIsFreelancer (src/Escrow.sol:200), so this is a note about the invariant the factory silently depends on, not a live bug.

- NONE — the read-only files I depended on (test/Base.t.sol, test/Attestation.t.sol) look correct; I found nothing wrong in them. src/ was never edited: `sum != msg.value` at Escrow.sol:235 and `new Escrow{value: msg.value}` at EscrowFactory.sol:44 are verified unchanged after all mutation work.

### `Invariant.t.sol`

- LIVENESS, not a conservation bug: a Disputed milestone has no escape hatch other than the arbiter. reclaim only accepts Pending/Submitted and resolveDispute is arbiter-only with no timeout, so if the arbiter never acts the milestone's funds sit in the contract forever - past the deadline, with nobody able to reclaim them. My invariants stay green through this (nothing is owed, so balance >= owed still holds; the money is simply inert), which is exactly why it is worth flagging separately. src/Escrow.sol:377-402.

- MINOR / dead branch: cancel() guards on acceptedAt != 0 (AlreadyStarted), so at that point every milestone is necessarily still Pending - nothing can have been submitted, attested, disputed or released. The `if (m.state == MState.Pending)` filter inside its loop can therefore never be false. Harmless and defensible as defence-in-depth, but it reads as if cancel handles a mixed-state escrow when it cannot. src/Escrow.sol:277.

- UNVALIDATED PARAMETER: challengeWindow is taken from Params with no bounds check. Zero makes a passing attestation instantly releasable by anyone (arguably fine, and another Wave-1 file may cover it), but a large value makes release unreachable for ~136 years while leaving approve and dispute working - an escrow that silently loses its permissionless-release property. The constructor validates deadline, title, amounts and milestone count but not this. src/Escrow.sol:198-246.

- OBSERVATION, believed intentional: attest has no deadline check, so a milestone Submitted just before the deadline can be attested and released well after it. This matches the stated intent in the reclaim docstring ("that work was proven in time"), but note the race it creates in the other direction: the client can reclaim a Submitted milestone the instant the deadline passes even when the verifier has already signed a pass that simply has not been relayed yet. First writer wins. src/Escrow.sol:316-337 vs 394-402.

### `Reclaim.t.sol`

- NOT A DEFECT, but a design gap in the money-after-deadline story: MState.Disputed has no timeout and no escape hatch. reclaim() refuses Disputed forever (correctly, per spec) and resolveDispute() is arbiter-only with no deadline, so if the arbiter is unresponsive or loses their key, that milestone's funds are stranded permanently — the deadline does not help. Every other terminal path (Pending/Submitted -> reclaim, Attested -> permissionless release) is reachable without a specific live party. src/Escrow.sol:377-402. Flagged, not tested, since a fix is a product decision.

- Guard ordering in reclaim() means the error a caller sees for a bad index depends on the clock: src/Escrow.sol:394-399 checks NotClient, then DeadlineNotPassed, then _milestone(i)'s BadMilestone. So client.reclaim(999) before the deadline reverts DeadlineNotPassed, not BadMilestone. Harmless on-chain, but a UI that maps error -> message will mislabel an out-of-range index as 'too early'. My out-of-range test warps past the deadline to reach the real BadMilestone branch.

- Note for the record, no action needed: src/ was verified formatter-clean (forge fmt --check src exits 0 on forge 1.7.1 / 4072e487) and byte-identical before and after my run. I did not edit anything outside test/Reclaim.t.sol.

### `Submission.t.sol`

- RACE (real, worth a design decision): after the deadline a milestone left in Submitted is reachable by BOTH `reclaim` (client -> Refunded) and `attest` (anyone -> Attested). `submit` is deadline-gated but `attest` is not, and `reclaim` only accepts Pending/Submitted. So a freelancer who submitted at deadline-1 and holds a valid pass signature can front-run the client's reclaim: once the milestone reaches Attested it is permanently out of reclaim's reach and releases after the challenge window. First-come-first-served with no grace period. Not exercised by my file (out of scope), but src/Escrow.sol:316 vs :394 is where it lives.

- ORDERING NOTE (not a bug, but it makes one state unreachable through submit): in `submit` the DeadlinePassed check (src/Escrow.sol:299) runs before `_milestone(i)` and before the state check. Consequence: a milestone Refunded via `reclaim` can never produce WrongState(Refunded) from submit - reclaim requires the deadline to have passed, so submit always reports DeadlinePassed first. I had to reach Refunded via dispute + resolveDispute(false) to test that branch at all. Same ordering means a bad index submitted after the deadline reports DeadlinePassed, not BadMilestone; if the UI relies on error identity to tell the user what went wrong, it will show the wrong message.

- MINOR: `submit` does not reject evidenceHash == bytes32(0). A submitted milestone with a zero evidence hash is indistinguishable from a never-submitted one for any UI that reads `evidenceHash` alone - only `state`/`submissions` disambiguate. Worth either rejecting zero or documenting that evidenceHash is not a submission sentinel.

- MINOR (griefing, self-harming only): resubmitting the *same* evidenceHash from Submitted is allowed and still bumps the counter, so a freelancer can invalidate an honest in-flight attestation at will by re-submitting identical evidence. Only hurts the freelancer, but it does mean a relayer's attest can be made to fail with StaleSubmission by the counterparty at any moment.

- COSMETIC: `cancel` filters on `m.state == MState.Pending` (src/Escrow.sol:277), but cancel requires acceptedAt == 0 and nothing can leave Pending before acceptance, so that branch can never be false. Harmless defensive code - just noting it is unreachable so nobody writes a test expecting a partial cancel refund.

### `Withdraw.t.sol`

- DESIGN GAP (not a bug, and my test asserts the CURRENT behaviour is correct): a payee that cannot receive ether strands its credit forever. src/Escrow.sol withdraw() (line 409) only ever pays msg.sender -- there is no withdrawTo(address), no arbiter override on owed[], and no rescue path. test_RevertWhen_RecipientRejectsTheTransfer proves the credit is correctly rolled back rather than destroyed, which is right, but for a freelancer contract whose receive() always reverts that credit is permanently uncollectible and the ether is locked in the escrow with no exit for anyone. Product consequence: the UI must refuse to name a contract address as freelancer unless it can accept a plain value transfer, because the chain offers no remedy afterwards. Flagging, not fixing.

- OBSERVATION on defence-in-depth, worth knowing when reading the reentrancy test: withdraw() is protected twice over -- the nonReentrant transient guard AND correct CEI ordering (owed zeroed at line 413, before the call at line 415). I mutation-tested this. Removing nonReentrant alone leaves the contract safe (CEI holds), and violating CEI alone leaves it safe (the guard holds); only removing BOTH makes it genuinely drainable. So no behavioural test can show either mechanism is individually necessary. test_ReentrantWithdrawIsBlockedAndPaysOnce is calibrated to go red exactly on that both-removed mutant and stay green on the two single-removal mutants. Nothing to fix -- this is the contract being correct twice.

