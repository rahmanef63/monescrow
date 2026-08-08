# Task board

Single source of truth for who is doing what. **Edit only your own section.** Two agents
editing one section is the merge conflict that eats an evening.

Read this together with [`CHANGELOG.md`](CHANGELOG.md) — this file is the *plan*, that one
is the *record*. When a task changes state, tick it here **and** append an entry there.

Owners: **A** = Alfa (Claude Desktop) · **T** = Taskforce (Claude Code) · **S** = Studio (ChatGPT)

---

## Gates

A gate is not "we think we're ready", it is a command whose output anyone can reproduce.

| Gate | Condition | Status | Flipped by |
|---|---|---|---|
| **G0** interfaces frozen | `docs/01-INTERFACES.md` merged, three workers briefed | ✅ done | A · 2026-08-08 |
| **G1** contracts proven | `forge test` green · `forge build --sizes` under limit · `forge fmt --check` clean | ✅ done | T · 2026-08-08 |
| **G2** deployed | Factory + one Escrow verified on MonadVision **and** Monadscan, addresses in `deploy/` | ⬜ blocked by G1 | A |
| **G3** integrated | full happy path **and** dispute path clicked through in a real browser against testnet | ⬜ blocked by G2 | A |
| **G4** submittable | README with rendered diagrams · demo recording · clean-clone run instructions | ⬜ blocked by G3 | A |

**Now:** G1 is the only thing on the critical path. Everything else that can proceed in
parallel is listed below as unblocked.

---

## A — Alfa (Claude Desktop)

| ID | Task | State | Blocked by |
|---|---|---|---|
| A-0 | Freeze interfaces C1–C10, write escrow contracts, attestation security suite | ✅ done | — |
| A-1 | Generate verifier keypair; publish address only as `NEXT_PUBLIC_VERIFIER_ADDRESS` | ✅ done | — |
| A-2 | Deploy a fresh 2-of-2 Safe with two keys the human controls | 🟡 staged — deployer agent generated, both keystores on disk; **needs funding + one broadcast** | human |
| A-3 | Deploy `EscrowFactory` via monskills `propose.sh` | ⬜ | G1, A-2 |
| A-4 | Verify Factory + one Escrow on all explorers | ⬜ | A-3 |
| A-5 | Swap real address into `web/.env.local`, confirm the list loads | ⬜ | A-4, T-15 |
| A-6 | E2E two wallets: create → accept → submit → verify → countdown → release → withdraw | ⬜ | A-5 |
| A-7 | E2E failure paths: dispute in window, arbiter both ways, deadline reclaim | ⬜ | A-5 |
| A-8 | **Adversarial demo**: blank page passes the HTTP check, challenge window saves the client | ⬜ | A-5 |
| A-9 | README with four rendered Mermaid diagrams | ✅ done — 4/4 parse | — |
| A-10 | `DEMO.md` clean-clone walkthrough | ✅ done | — |
| A-11 | Demo recording — happy path + dispute path | ⬜ | G3 |
| A-12 | Reproducible-build proof: clean checkout hashes to the deployed runtime bytecode | 🟡 method proven from a pristine tree; needs `cast code` after A-4 | A-4 |
| A-13 | MONSKILLS installed incl. `wallet/` (installer drops it — see changelog) | ✅ done | — |
| A-14 | Foundry + solc running in-sandbox so A can verify G1 independently, not on report | ✅ done | — |
| A-15 | Verify Studio's C9 delivery against the manifest before T imports by path | ✅ done | — |
| A-16 | Build the `propose.mjs` fetch relay — sandbox cannot reach RPC, Safe or explorers | ✅ done | — |
| A-17 | `contracts/script/Deploy.s.sol` — `initCode()` for the Safe, `runtimeHash()` for A-12 | ✅ done | — |
| A-18 | `web/.env.example` implementing C8 in full | ✅ done | — |
| A-19 | `deploy/DEMO-PARAMS.md` — D-3 windows, demo escrow shape, role addresses | ✅ done | — |
| A-20 | Vendor deps or document `forge install` so a clean clone builds | ✅ done — `make setup && make gate` proven from a tree with no `lib/` | — |
| A-21 | `tools/check-mermaid.mjs` — parse diagrams with mermaid's own grammar | ✅ done | — |
| A-22 | Delete duplicate `agent/` tree and the half-init `.git/` (needs Windows) | 🟡 `agent/` gone; `node_modules` symlink still to delete | human |
| A-23 | `site/` holding page + `vercel.json` + `deploy/VERCEL.md` (D-4 reversal) | ✅ done | — |
| A-24 | F-A fix in `EscrowFactory.getEscrows` — clamp before adding | ✅ done | — |
| A-25 | F-B / D-7 contract change: bound `challengeWindow` | ✅ done — 60 s … 30 days | — |
| A-26 | Push `main` — **delegated to T**, A's mount cannot run git | ⬜ | T |

**T's queue from A:** invert `ChallengeWindow.t.sol`'s zero-window test (it now reverts
`ChallengeWindowOutOfRange(0, 60, 2592000)`), then commit and push everything unpushed. See
the 06:25Z `HANDOFF`. Delete `.git/index.lock` and the `node_modules` symlink first.

| A-27 | `deploy/RUNBOOK.md` — eight ordered steps, labelled by who runs each | ✅ done | — |
| A-28 | Deployer agent wallet, keystore on disk not in a sandbox | ✅ done — unfunded | — |

**G1 is green and D-1/D-2 are resolved, so the only thing left is two commands nobody but a
human can run:** fund `0x5e6F6C87604373d80A7688788C18A7e5AABeD7eA` with ~2 MON, then broadcast
the Safe deployment (`deploy/RUNBOOK.md` steps 1–2). Everything downstream — propose, sign,
read the `ContractCreation` log, verify on both explorers, repro-hash, wire the address into
the app — is staged and rehearsed. Alfa cannot sign and cannot reach the chain; that is the
whole reason those two steps are yours.

**Lane note for T:** Alfa is not touching `vercel.json`, `web/vercel.json` or `web/**` again.
The one exception is `web/.env.local` (gitignored) at runbook step 8, when the factory address
exists.

**A's gate note.** `forge fmt --check` is clean across the tree and `forge build --sizes` is
under limit, so **every G1 condition that depends on an A-owned file is satisfied**. G1 now
rests entirely on T-1..T-9. A will re-run `forge test` against its own working tree when T
posts the `GATE` entry, and will say so before proposing any deployment.

## T — Taskforce (Claude Code)

**Wave 1 — contract tests.** Nine independent files, fan out one subagent each. Together
they flip G1.

| ID | Task | State |
|---|---|---|
| T-1 | `Construction.t.sol` — every constructor revert path | ✅ |
| T-2 | `Acceptance.t.sol` — accept once, cancel only before acceptance | ✅ |
| T-3 | `Submission.t.sol` — role, acceptance, deadline, counter, illegal source states | ✅ |
| T-4 | `ChallengeWindow.t.sol` — **headline**: silence releases; one second early reverts; window 0 | ✅ |
| T-5 | `Dispute.t.sol` — freeze from both states, arbiter-only resolve, both outcomes | ✅ |
| T-6 | `Reclaim.t.sol` — **`Attested` survives the deadline**; not early; not twice | ✅ |
| T-7 | `Withdraw.t.sol` — pull-based, double withdraw, **reentrancy blocked**, rejecting receiver | ✅ |
| T-8 | `Factory.t.sol` — array, `escrowsOf` both parties, pagination, holds no MON | ✅ |
| T-9 | `Invariant.t.sol` — money never created or destroyed, one terminal state per milestone | ✅ |
| — | *(already done by A: `Attestation.t.sol`, 12 passing — use as style reference)* | ✅ |

**Wave 2 — verifier service.** Unblocked now; does not wait for Wave 1.

| ID | Task | State |
|---|---|---|
| T-10 | `checks/http.ts` + unit tests with injected `fetchImpl` | ✅ |
| T-11 | `checks/github.ts` — 403 rate-limit is **502, not a failure** | ✅ |
| T-12 | `report.ts` + `canonicalJson` + hashing (C5) | ✅ |
| T-13 | `sign.ts` EIP-712 (C2) + a test that the signature recovers to the expected address | ✅ |
| T-14 | `api/verify/route.ts` — 200/422/400/502 per C6 | ✅ |

**Wave 3 — AI parser (BYOK).**

| ID | Task | State |
|---|---|---|
| T-15 | `provider.ts` — credential order: header → env → template | ✅ |
| T-16 | `template.ts` — **must work with zero credentials**; test hardest | ✅ |
| T-17 | `anthropic.ts` — structured output, validate schema and re-check the sum | ✅ |

**Wave 4 — frontend.** Build against local anvil; Alfa swaps the address at A-5.

| ID | Task | State |
|---|---|---|
| T-18 | Scaffold Next.js 16 + wagmi v3 + Tailwind; bump tsconfig target to ES2020 | ✅ |
| T-19 | `useTxFlow` — simulate → estimate → show cost → explicit click → send with gas limit | ✅ |
| T-20 | `/` my jobs from `escrowsOf(me)`, client and freelancer tabs | ✅ |
| T-21 | `/new` brief → draft → edit amounts and criteria → fund and create | ✅ |
| T-22 | `/job/[address]` — four viewer roles, milestone cards, live countdown | ✅ |

## S — Studio (ChatGPT)

| ID | Task | State | Blocked by |
|---|---|---|---|
| S-1 | Three-timeline **challenge window** diagram — the pitch carrier | ✅ done | — |
| S-2 | Logo + mark (must survive 16px) | ✅ done | — |
| S-3 | `favicon.png` 512² + `og.png` 1200×630 | ✅ done | S-2 |
| S-4 | Empty states `no-jobs`, `awaiting-freelancer` (800×600, transparent on `#09090b`) | ✅ done | S-2 |
| S-5 | Deck slides 1920×1080 | ✅ done | S-1 |
| S-6 | Copy review — every label, error, empty state | 🟡 baseline ready; final waits G3 | G3 |
| S-7 | Trust-story review — the four sceptic questions | 🟡 baseline ready; final waits G3 | G3 |
| S-8 | Demo review — first 90 seconds | ⬜ | A-11 |
| S-9 | Public try-it placeholder + transparent PNG/WebP motion handoff | ✅ done | S-2 |
| S-10 | Pitch speaker notes + A-11 recording shot-list handoff | ✅ done | S-5, D-3 |

---

## Open decisions

Things nobody should silently assume. Raise in `CHANGELOG.md` as a `DECIDE` entry.

| # | Question | Owner | Status |
|---|---|---|---|
| D-1 | Second human wallet for the 2-of-2 Safe — which address? | human | ✅ **resolved** — funded EOA supplied, held in gitignored `deploy/keys/owners.local.json` |
| D-2 | Arbiter address for the demo escrows | human | ✅ **resolved** — same EOA, single signature keeps A-7 fast on camera |
| D-3 | Default challenge window for the demo (short enough to show live) | A | ✅ **resolved** — product default 3 d, demo preset 90 s; see `deploy/DEMO-PARAMS.md` |
| D-4 | Is a hosted deployment in scope, or clean-clone instructions only? | human | ✅ **reversed 05:58Z** — hosted **and** clean-clone. See `deploy/VERCEL.md`; `NEXT_PUBLIC_` scoping now matters |
| D-7 | `challengeWindow == 0` lets the verifier key attest+release in one block | A | ✅ **resolved** — bounded 60 s … 30 days at construction; `ChallengeWindowOutOfRange` |
| D-5 | Pin one `forge` version for all three workers | A | ✅ **resolved** — 1.7.1 @ `4072e487`, pinned in `contracts/foundry.toml`; upgrading is now a `DECIDE` |
| D-6 | Where is the repository of record? No `.git` in this tree | human | 🟡 decided: **this directory** — but Alfa's mount denies `unlink`, so `git init` must be run natively on Windows. Exact commands in the 03:41Z changelog entry. |
