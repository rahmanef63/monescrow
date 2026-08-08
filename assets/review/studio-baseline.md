# Studio pre-integration review baseline

Status: static review complete; final S-6/S-7 review still waits for G3.

Reviewed as two readers: a sceptical freelancer and a sceptical client.

Evidence reviewed:

- `README.md`
- `docs/01-INTERFACES.md` C1-C10
- `docs/04-CHATGPT.md`
- all current brand, social, empty-state, deck, and placeholder assets
- current `web/` tree, which contains no reviewable UI files yet

This report records findings only. It does not propose new features or patch code owned by
another worker.

## Findings visible before integration

### S-F01 - Verifier operator is not identified where trust is introduced (high)

The README explains what the verifier does but not who operates it, which address signs its
attestations, or what trust the user is placing in that operator. C8 defines
`NEXT_PUBLIC_VERIFIER_ADDRESS`, but the current user-facing material does not surface it.

Freelancer reading: “Who can withhold a pass?”  
Client reading: “Whose software is judging the submission?”

Final review trigger: inspect the job and verification views where the verifier first
appears.

### S-F02 - Offline verifier behavior is specified internally, not explained to users (high)

C6 correctly distinguishes an unreachable target/service (`502`, retry) from a failed
milestone (`422`). The README and current visual copy do not explain this distinction at the
point where a user would wait for verification. Without it, an outage can look like the
freelancer failed or the funds are stuck for an unexplained reason.

Final review trigger: inspect verification loading, timeout, 422, and 502 states.

### S-F03 - A weak HTTP criterion can accept a blank page (high)

C3 permits an HTTP check with status `200` and an empty `mustContain` list. In that valid
configuration, a blank page can satisfy the mechanical check. The README does not tell a
client that “reachable” is narrower than “work complete,” and the frontend does not yet
exist to show the exact criterion before funding.

This is the scenario A-8 is intended to demonstrate. It is a product-trust finding, not a
contract defect.

Final review trigger: inspect criterion drafting, agreement confirmation, verification
report, and the A-8 adversarial demo.

### S-F04 - Bad-faith dispute cost and authority are not yet legible (high)

C1 lets the client dispute a Submitted or Attested milestone and freezes it for the arbiter.
The arbiter address is still open as D-2. Current material does not yet tell a freelancer who
the arbiter is, what exact amount freezes, or that unrelated/released milestone funds remain
outside this dispute.

Freelancer reading: “Can the client dispute everything and delay every payment?”  
Client reading: “Who decides after I object?”

Final review trigger: inspect agreement confirmation, live challenge window, dispute action,
and disputed state.

### S-F05 - “Released” and “paid” can describe different moments (high)

The contract never pushes money. Release credits `owed[party]`; the recipient must call
`withdraw()`. The deck deliberately shows Released and Paid as separate nodes, but the
required UI state vocabulary ends at `Released`. A user can reasonably read “Released” as
“arrived in my wallet,” which is not necessarily true yet.

Final review trigger: inspect release success, owed balance, withdraw action, and transaction
receipt language.

### S-F06 - “Automatic release” still requires an on-chain caller (medium)

The product promise says silence releases automatically. Mechanically, after the challenge
window anyone may call `release`; time alone does not broadcast a transaction. The deck's
challenge-window slide states “Anyone triggers release,” but the OG copy says “Silence
releases automatically.” At thumbnail level this is a useful simplification; in-product copy
must not imply a scheduled transaction exists if none does.

Final review trigger: inspect the countdown-at-zero state and release CTA/automation copy.

### S-F07 - README status is stale relative to the shared tree (medium)

The repository layout still labels `assets/` as “not started,” while C9 is frozen and all
required assets have been independently verified. The status table also groups “Brand,
assets, review” under Studio without distinguishing delivered assets from reviews waiting on
G3.

Owner note: README belongs to Alfa; Studio reports this and does not patch it.

### S-F08 - Empty-state copy cannot yet be reviewed (blocked)

The two empty-state illustrations intentionally contain no baked-in text. That is correct for
localization and reuse, but the user-facing heading, explanation, and CTA will live in the
frontend, which is not present. The first-run judge experience therefore cannot yet be
approved or rejected.

Final review trigger: inspect `/` with no jobs and an unaccepted escrow.

## Final S-6 copy inventory

When G3 flips, review every visible instance of:

- `Open`
- `Submitted`
- `Verified - <time> left to object`
- `Released`
- `Disputed`
- `Refunded`
- connect, switch network, accept, submit, verify, approve, dispute, release, reclaim, and
  withdraw actions
- transaction rejected, insufficient balance, verifier 422, verifier 502, expired deadline,
  unauthorized viewer, and wrong-state errors
- `no-jobs` and `awaiting-freelancer` headings, body copy, and CTAs

## Final S-7 trust-story test

At the screen where each fact matters, the UI must let a user answer these without opening
the Solidity source:

1. Who runs the verifier, and what if it lies or goes offline?
2. What stops a blank page passing a superficial HTTP check?
3. What happens if the client disputes in bad faith?
4. Where is the money now, and who can move it next?

This baseline does not close S-6 or S-7. Those tasks require the integrated UI and real
browser flow specified by G3.
