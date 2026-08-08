# Running MonEscrow from a clean clone

There is no hosted deployment. Everything below runs on your machine against Monad
testnet, and the only file you need to create is `web/.env.local` — copied from the
committed `.env.example`, with nothing filled in.

> If you have 90 seconds and no patience for setup, skip to
> [**The one thing worth watching**](#the-one-thing-worth-watching) and read the argument
> without running anything.

---

## What you need

| | | |
|---|---|---|
| Foundry | **1.7.1** exactly | `forge fmt` shifts between versions; a different one takes the gate red |
| Node | 20+ | 22 is what this was built on |
| A wallet | MetaMask, Rabby, anything injected | two accounts, so you can play both sides |
| Testnet MON | a faucet's worth | the client account funds the escrow up front |

No API keys. The AI milestone parser falls back to a deterministic template with no
credentials at all — that path is tested hardest precisely because it is the one that runs
on your machine.

## Setup

```bash
git clone <repo> monescrow && cd monescrow

cd contracts
make setup          # pinned: forge-std v1.16.2, openzeppelin-contracts v5.7.0
make gate           # fmt + sizes + the full test suite
cd ..

cd web
cp .env.example .env.local
npm install
npm run dev
```

`make setup` is not optional and it is not a convenience wrapper. `contracts/lib/` is
gitignored, so a fresh clone has no dependencies and `forge build` fails with a wall of
"No such file or directory". One command fixes it.

`.env.example` already contains the deployed factory address and the verifier's public
address, so a fresh clone talks to the same contracts everyone else does. The only blank
entries are optional: a GitHub token to raise a rate limit, and an LLM key if you want the
AI parser instead of the template.

---

## The happy path

Two browser profiles, or two accounts in one wallet. Call them **Client** and
**Freelancer**.

| # | Who | Does | What you should see |
|---|---|---|---|
| 1 | Client | `/new` — paste a brief, edit the milestones, fund | one transaction, the full amount escrowed up front |
| 2 | Client | copy the `/job/0x…` link | this is the whole product: a link you paste into Discord |
| 3 | Freelancer | open the link, **Accept** | the job unlocks; nothing could be submitted before this |
| 4 | Freelancer | **Submit** milestone 1 with a URL | state `Pending → Submitted` |
| 5 | Freelancer | **Run check** | the verifier fetches the URL, signs, and hands back a signature — it does not send a transaction |
| 6 | Freelancer | **Attest** | `Submitted → Attested`, the countdown starts |
| 7 | — | wait out the window (90 s on the demo preset) | the countdown is real; `release` reverts until it hits zero |
| 8 | **Anyone** | **Release** | `Attested → Released`. Try it from a third account — it works |
| 9 | Freelancer | **Withdraw** | *now* the MON moves |

Steps 8 and 9 are two separate things and the distinction matters. `Released` credits an
internal balance; it does not push money. Money is never pushed in this contract — release
and refund both credit `owed[party]`, and the party pulls. One reentrancy surface instead
of six. So a milestone showing `Released` has **not** yet reached anybody's wallet, and the
UI says so.

Step 8 is the design in one click: the client did nothing, and the freelancer still got
paid, and *any* address could have triggered it.

---

## The one thing worth watching

Everything above works. Here is the demo that argues for the design, and it works by
**failing** the check in the most embarrassing way available.

1. Deploy a completely blank page — an empty `index.html`, no content, nothing.
2. Create a milestone whose criteria are `check: "http"`, `expectStatus: 200`.
3. Submit the blank page as the deliverable and run the check.

**It passes.** HTTP 200, no required content configured, green tick, valid signature from
the real verifier key.

That is not a bug being demoed as a feature. It is the honest state of every automated
check anybody ships: `HTTP 200` and `Lighthouse > 80` are both satisfied by a blank page,
and any system that treats a check like that as a *verdict* is one blank page away from
paying out for nothing.

So watch what the contract does with the pass:

4. Nothing moves. The pass opened a challenge window.
5. As the Client, hit **Dispute** while the countdown runs.
6. The milestone freezes. `release` now reverts for everyone, including the freelancer.
7. The arbiter resolves it, either way.

**The check was wrong and the client still kept their money.** That is the product. The
verifier is a proposal with a deadline, not a judge — and the reason the design survives a
weak check is that it never depended on the check being strong.

Run it the other way too, because the symmetry is the point: leave the dispute unclicked
and the same blank page pays out. The client's attention is the security model, and the
window is how much attention it asks for.

---

## The failure paths

Worth clicking if you want to convince yourself the edges hold.

| Path | How | Expected |
|---|---|---|
| Release one second early | hit **Release** with the countdown still running | reverts with the exact `releasableAt` timestamp |
| Dispute from `Submitted` | dispute before any attestation | freezes just as well — the client does not have to wait for a verifier |
| Arbiter for the client | `resolveDispute(i, false)` | `Disputed → Refunded`, credited to the client |
| Replay a stale pass | attest, resubmit, then replay the first signature | rejected — the signature is pinned to `submission` |
| Deadline reclaim | let the deadline pass on an untouched milestone | client reclaims |
| Attested survives the deadline | attest, then let the deadline pass mid-window | **not** reclaimable — work proven in time is earned |

That last row is the one that took the most care to get right. A milestone inside its
challenge window is excluded from `reclaim` on purpose: the freelancer delivered before the
deadline, and the objection period running past it is the contract's own doing, not theirs.

---

## Verifying the deployment yourself

Do not take "verified on the explorer" on faith — the source shown there only means
something if it compiles to the code that is actually running.

```bash
cd contracts
make repro                                   # runtime bytecode hash from this checkout
cast code <FACTORY> --rpc-url https://testnet-rpc.monad.xyz | sha256sum
```

They should match. If they differ only in the trailing bytes, that is the CBOR metadata
hash, which tracks source text — meaning the deployed source is not byte-identical to
yours, and it is worth finding out why.

You can also re-run the check that decided this project's EVM target rather than trusting
the comment in `foundry.toml`:

```bash
make probe-evm     # MCOPY must return 0x01…, TSTORE/TLOAD must return 0x07
```

---

## If something breaks

| Symptom | Cause |
|---|---|
| `No such file or directory: lib/forge-std/...` | `make setup` not run |
| `forge fmt --check` fails on a file you never opened | wrong Foundry version — pin 1.7.1, commit `4072e487` |
| Verifier returns 502 | a target was unreachable. That is our problem, not the freelancer's, and is deliberately **not** signed as a failure |
| Verifier returns 422 | the checks ran and the milestone genuinely failed |
| Transaction estimates absurd gas | on Monad you pay the gas *limit*, not the gas used. Never let a wallet pick the limit |
