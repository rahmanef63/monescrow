# Demo parameters

What the demo escrows are created with, and why. Alfa owns this file; the frontend reads
the same values as presets.

## D-3 — challenge window

**Product default: 3 days (259,200 s). Demo preset: 90 s.**

Two numbers, not one, and the split is the whole decision.

A 90-second challenge window is the only way to show the mechanism working on camera —
the countdown has to visibly run out inside a recording, and A-8 needs the client to
*object* inside the window while someone is watching. But 90 seconds is an absurd amount
of time to review real work, and shipping it as the default would quietly undermine the
pitch: a judge who sees "challenge window: 90 seconds" reads it as a toy, and they would
be right. The realistic default is what makes the short one legible as a demo setting
rather than the actual design.

So `/new` offers:

| Preset | Seconds | Use |
|---|---|---|
| Demo | 90 | live walkthrough and the recording |
| 24 hours | 86,400 | fast-moving work, client is attentive |
| **3 days** | **259,200** | **default** |
| 7 days | 604,800 | larger milestones, slower clients |

90 rather than 60: the client has to notice the attestation, open a wallet, and confirm.
A wallet popup can eat 20 seconds on its own, and A-7 has to dispute *inside* the window
on the first take. 60 leaves no margin; 90 costs nine extra seconds of narration.

The contract does not constrain this — `challengeWindow` is a plain `uint32` with no
minimum, and `0` is legal and means "releasable immediately" (which is T-4's job to test).
So this is UI policy, not a contract rule, and nothing here changes C1.

## Deadline

Demo escrows: **7 days out**. Long enough that no demo escrow expires mid-recording, short
enough that A-7's deadline-reclaim path can be reached by warping a local fork rather than
waiting.

## Milestones

Three, so the list reads as a sequence rather than a special case:

| # | Check | Why this one |
|---|---|---|
| 1 | `http` | the automated path, and the one the adversarial demo attacks |
| 2 | `github` | shows a second check type exists without needing a third UI |
| 3 | `clientApproval` | proves the escrow works with no verifier involvement at all |

Milestone 1 being `http` is deliberate: A-8 points it at a **deliberately blank page**,
which passes an HTTP-200 check honestly. That is the demo's argument — the check is weak,
the verifier knows it is weak, and the challenge window is what protects the client. A
milestone that could not be gamed would prove nothing.

## Addresses

| Role | Address | Decision |
|---|---|---|
| Verifier | `0x87B9AfEafA109e96c41504E0ce84e08c055D5eaf` | A-1, generated 2026-08-08 |
| Arbiter | *pending* | D-2 — same EOA as the second Safe owner |
| Safe (deployer) | *pending* | A-2, blocked on D-1 |

The verifier address is public on purpose: the UI shows it so anyone can check that the
signature on a milestone came from the expected key, and `Escrow.attestationDigest(...)`
lets them reproduce the digest byte-for-byte.

No human wallet address appears in this file or any other committed file. Contract and
Safe addresses are necessary and fine; a personal address ties a GitHub identity to onchain
history permanently, and EVM addresses are identical on testnet and mainnet.
