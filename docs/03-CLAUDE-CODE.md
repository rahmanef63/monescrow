# Brief — Taskforce (Claude Code + subagents)

Paste this into Claude Code at the repo root. Read `docs/01-INTERFACES.md` first; the
numbered contracts C1–C10 are binding.

**Why you have this work.** Everything below is independent and verifiable by a local
command — `forge test`, `vitest`, `tsc`, `next build`. That is the only shape where fanning
out to many agents actually beats one agent working carefully. Nothing here needs a
browser, a wallet signature, or the live chain; if you find yourself wanting one, it is not
your task — hand it to Alfa.

**Do not touch** `contracts/src/**`, `deploy/**`, `assets/**`, `docs/**`, `README.md`.

---

## Wave 1 — contract tests (8 files, fully parallel)

`contracts/test/Attestation.t.sol` already exists with 12 passing tests covering signature
forgery and replay. Use it as the style reference: `test_RevertWhen_*` naming, custom-error
assertions with `abi.encodeWithSelector`, a comment on every test saying what property it
protects.

One agent per file. They share only `test/Base.t.sol`, which is already written — extend it
only by adding helpers, never by changing existing ones.

| File | Must prove |
|---|---|
| `Construction.t.sol` | zero addresses, client==freelancer, past deadline, zero/too many milestones, zero amount, `FundingMismatch` when `msg.value` ≠ sum, empty/oversized title, `VerifierRequired` when an auto-check milestone has no verifier |
| `Acceptance.t.sol` | only freelancer accepts; not twice; not after deadline; not when cancelled; client cancels only before acceptance and gets everything back; cancel is not available afterwards |
| `Submission.t.sol` | only freelancer; requires acceptance; blocked at and after the deadline; counter increments; cannot submit over Attested/Disputed/Released |
| `ChallengeWindow.t.sol` | **the headline**: client silence ⇒ anyone releases after the window; release one second early reverts with the exact `releasableAt`; **`challengeWindow == 0` is now rejected at construction (D-7) — assert the revert, not an immediate release**; `challengeRemaining` counts down truthfully |
| `Dispute.t.sol` | client freezes from Submitted and from Attested; `release` reverts while frozen; only arbiter resolves; both outcomes credit the right party; cannot dispute after release |
| `Reclaim.t.sol` | after deadline client reclaims Pending/Submitted; **cannot reclaim a milestone inside its challenge window** (work proven in time survives the deadline); not before the deadline; not twice |
| `Withdraw.t.sol` | pull-based both sides; double withdraw reverts `NothingOwed`; **reentrancy into `withdraw` blocked** (use `ReentrantFreelancer` in `test/helpers/`); rejecting receiver reverts `TransferFailed` and rolls back the balance |
| `Factory.t.sol` | array and `isEscrow`; `escrowsOf` indexes **both** parties; pagination incl. `offset == length` and `BadRange`; factory holds no MON; value forwarded exactly; escrows independent |

Plus `Invariant.t.sol` — the property that matters most:

> For any sequence of legal calls, `releasedAmount + refundedAmount ≤ totalAmount`, every
> milestone ends in exactly one terminal state, and the contract's balance always equals
> `totalAmount − (sum of successful withdrawals)`. Money is never created or destroyed.

Use a stateful invariant handler. This is the one test that catches what the unit tests miss.

**Trap that already bit once:** `vm.expectRevert` arms the *next* call, including view calls
inside a helper. Compute signatures and read state **before** the `expectRevert` line, never
inline as an argument. Four tests silently passed-as-failed on this.

Gate: `forge test` green, `forge build --sizes` under the limit, `forge fmt --check` clean.

---

## Wave 2 — verifier service

`web/src/lib/verify/` + `web/src/app/api/verify/route.ts`. Implements C5 and C6.

Split it so the logic is testable with no network at all:

- `checks/http.ts` — `runHttpCheck(criteria, fetchImpl)`. Status, then rendered-text
  contains/not-contains. Timeout. Injected `fetchImpl` so tests never touch the network.
- `checks/github.ts` — `runGithubCheck(criteria, fetchImpl)`. Commit exists; check-run
  conclusion is `success`. Handle 403 rate-limit **as 502, not as a failure**.
- `report.ts` — assemble C5, `canonicalJson`, hash.
- `sign.ts` — EIP-712 sign per C2 with `VERIFIER_PRIVATE_KEY`.
- `route.ts` — thin: parse, dispatch, 200/422/400/502 per C6.

Unit-test every check with a fake `fetchImpl`: pass, fail, timeout, malformed body, rate
limit. Then one test asserting a produced signature recovers to the expected address —
`viem`'s `recoverTypedDataAddress` against the same struct the contract uses.

**Be honest in the code comments about what these checks are worth.** `HTTP 200` and
`Lighthouse > 80` are satisfied by a blank page. That is exactly why the contract treats a
pass as a proposal and not a decision. Do not write comments implying the checks prove the
work is done.

---

## Wave 3 — AI brief parser (BYOK)

`web/src/lib/ai/` + `web/src/app/api/ai/milestones/route.ts`. Implements C7.

- `provider.ts` — the interface plus credential resolution in the C7 order.
- `anthropic.ts` — structured output against the `MilestoneDraft` schema.
- `template.ts` — deterministic fallback, keyword-driven. **Must produce a sane 4–5
  milestone split with no credentials whatsoever.** Test this one hardest; it is what runs
  on the judge's machine.
- Validate the LLM's output against the schema and re-check that amounts sum to the total.
  Never trust the model's arithmetic.

Never log, persist, or return the user's key.

---

## Wave 4 — frontend

`web/` — Next.js 16 App Router, wagmi v3, viem, Tailwind v4. Bump `tsconfig` target to
ES2020 immediately after scaffolding or BigInt literals will not compile.

Build against **local anvil**, not testnet. Alfa swaps in the real address at integration.

```
/                      my jobs — from factory.escrowsOf(me), client and freelancer tabs
/new                   brief → AI/template draft → edit amounts and criteria → fund + create
/job/[address]         the shareable link; renders per viewer role
```

`/job/[address]` is the whole product. It must render correctly for four different viewers —
client, freelancer, arbiter, stranger — and only ever offer actions the chain would accept
(the table in C1 is the spec). Milestone card shows state, amount, criteria in plain
language, evidence, the verifier report, and a live challenge-window countdown.

Reuse the transaction discipline from the MonFund build: **simulate → estimate gas → show
the cost → wait for an explicit click → send with an explicit gas limit.** On Monad the user
pays the gas *limit*, not the gas used, so never let a wallet pick the limit.

Gate: `npm run typecheck`, `npm run build`, and every screen renders from mock data with no
chain connected.
