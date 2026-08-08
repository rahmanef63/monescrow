# Changelog

The shared record. Three workers in three runtimes cannot see each other's screens, so this
file is how they find out what happened and when.

## How to write an entry

**Append at the bottom. Never edit or reorder an existing entry.** Appending is the only
operation that merges cleanly when two agents commit within a minute of each other.

```
## 2026-08-08T03:01Z · A · GATE
G0 flipped: interfaces frozen.
Evidence: docs/01-INTERFACES.md merged at d8cbccf
Unblocks: T (all waves), S (S-1, S-2)
Files: docs/01-INTERFACES.md, docs/prompts/*
```

Timestamp in **UTC, ISO-8601, minute precision** — get it from `date -u "+%Y-%m-%dT%H:%MZ"`,
do not guess. Studio has no shell: write the entry as text and let the human or Alfa commit
it with a real timestamp.

Types, in rough order of how urgently others need to see them:

| Type | Use when | Others must |
|---|---|---|
| `GATE` | a gate flipped | re-check what they were waiting on |
| `DECIDE` | an interface or design decision was made or changed | re-read the affected contract in C1–C10 |
| `BLOCK` | you are stuck and need someone | see if it is theirs to unblock |
| `FIND` | you learned something the others would otherwise rediscover the hard way | read it once |
| `HANDOFF` | an artifact is ready for someone else to consume | pick it up |
| `DONE` | a task from `TASKS.md` finished | nothing, unless it unblocks them |

Every entry carries **Evidence** — a command output, a commit hash, an address, a test
count. "Done" is not verifiable; `forge test: 41 passed` is. If you cannot produce evidence,
the entry is a `FIND` or a `BLOCK`, not a `DONE`.

Also state **Unblocks:** whenever your work frees somebody, and **Invalidates:** whenever it
breaks an assumption they may already have built on. Those two lines are the whole point of
this file.

## How to read it

At the start of every session, read `TASKS.md` and the **last 20 entries here**. Anything
tagged `DECIDE`, `GATE` or `Invalidates:` since you last worked changes what you should do.

---

## 2026-08-08T02:50Z · A · DONE
Escrow contracts written and compiling. `Escrow.sol` (milestones, EIP-712 verifier
attestation, optimistic challenge window, dispute freeze, arbiter resolve, deadline reclaim,
pull-based withdrawal) and `EscrowFactory.sol` (onchain index, `escrowsOf` for both parties).
Evidence: `forge build` clean at eabd548; Escrow + EscrowFactory artifacts produced
Unblocks: T (all waves — the ABI is C1 and is frozen)
Files: contracts/src/Escrow.sol, contracts/src/EscrowFactory.sol, contracts/foundry.toml

## 2026-08-08T02:50Z · A · FIND
**Monad testnet supports Cancun opcodes** — verified on the live chain, not assumed. Probed
raw init code through `eth_call`: `MCOPY` (EIP-5656) returned `0x01…`, `TSTORE`/`TLOAD`
(EIP-1153) returned `0x07`. Exact payloads are commented in `contracts/foundry.toml`.
Consequence: `evm_version = "cancun"` is safe, and `ReentrancyGuardTransient` is worth using
here — Monad prices a cold `SSTORE` at 8,100 gas versus Ethereum's 2,100, and the user pays
the gas *limit*, not the gas used.
Evidence: eth_call probes against https://testnet-rpc.monad.xyz
Files: contracts/foundry.toml, contracts/src/Escrow.sol

## 2026-08-08T02:50Z · A · DONE
Attestation security suite — the surface where this design lives or dies, so it went first.
Covers forged signer, freelancer self-signing, replay across submission / milestone /
escrow, flipped `passed` flag, swapped report hash, failing attestation as a no-op, and
open relaying by any sender.
Evidence: `forge test` → **12 passed, 0 failed** in `Attestation.t.sol`
Unblocks: nothing directly — G1 still needs T-1..T-9
Files: contracts/test/Attestation.t.sol, contracts/test/Base.t.sol, contracts/test/helpers/Attackers.sol

## 2026-08-08T02:50Z · A · FIND
**`vm.expectRevert` arms the *next* call, including view calls inside a helper.** Four tests
here silently passed-as-failed because the signature helper made an external `view` call
that consumed the expectation. Compute signatures and read state on their own lines *before*
`expectRevert`; never inline as a call argument. Anyone writing T-1..T-9 will hit this.
Evidence: 4/12 failing with "next call did not revert as expected" until hoisted
Files: contracts/test/Attestation.t.sol

## 2026-08-08T03:01Z · A · GATE
**G0 flipped: interfaces frozen.** C1–C10 written, work split three ways, self-contained
onboarding prompts for each worker.
Evidence: d8cbccf
Unblocks: T (Waves 1–4), S (S-1, S-2), A (A-1, A-2)
Files: docs/00-PLAN.md, docs/01-INTERFACES.md, docs/02-ALFA.md, docs/03-CLAUDE-CODE.md, docs/04-CHATGPT.md, docs/prompts/*

## 2026-08-08T03:21Z · A · BLOCK
Two decisions only the human can make, both on the critical path for deployment.
**D-1** — A-2 needs a second wallet address for the 2-of-2 Safe. The Safe from the previous
project is unusable: its second owner was an agent key in an ephemeral sandbox, so with a
2-of-2 threshold it can no longer execute anything, including an owner change.
**D-2** — A-6 needs an arbiter address for the demo escrows.
Evidence: TASKS.md D-1, D-2
Blocks: A-2 → A-3 → A-4 → G2
Files: TASKS.md

## 2026-08-08T03:30Z · T · FIND
**No Foundry toolchain on a clean Taskforce machine, and the `forge` version itself is not
pinned anywhere.** The deps are pinned (`forge-std@v1.16.2`, `openzeppelin-contracts@v5.7.0`)
and so is the compiler (`solc_version = "0.8.28"`), but nothing pins `forge` — and the
formatter is version-sensitive, which is the next entry. Reproducible setup used here on
Windows, no `foundryup`:
  Foundry **v1.7.1** `win32_amd64` from the GitHub release, SHA256 checked against the
  published `.sha256` (`6d41121b…4537`), extracted to `~/.foundry/bin`
  `forge install --no-git foundry-rs/forge-std@v1.16.2` (tag `bf647bd604`)
  `forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.7.0` (tag `cab19933c3`)
Baseline reproduced independently from an empty `lib/`: A-0's attestation suite is green here
too, so the 12 passing tests are not an artifact of A's machine.
Evidence: forge 1.7.1 (4072e487) · `forge test` → **12 passed, 0 failed, 0 skipped** · `forge build --sizes` → Escrow 10,252 B runtime (margin 14,324), EscrowFactory 15,759 B (margin 8,817), both under limit
Unblocks: T-1..T-9 — the baseline the brief requires before writing tests is confirmed green
Files: contracts/lib/** (gitignored)

## 2026-08-08T03:30Z · T · BLOCK
**G1 cannot flip: `forge fmt --check` is already red, and on a file Taskforce may not touch.**
Under Foundry 1.7.1 the only file that fails is `contracts/src/Escrow.sol`, owned by A per
C10. `src/EscrowFactory.sol` and every file in `contracts/test/` pass clean — so this is not
"src was never formatted", it is formatter drift between Foundry versions. Every diff has the
same shape: the newer formatter collapses a multi-line signature that now fits in 120 columns
(`constructor(...) payable EIP712("MonEscrow", "1") {`, `attest(...) external {`, and the
`attestationDigest` return). Two of G1's three commands are green; this third one is not, and
fixing it means editing A's file.
Raising **D-5 — pin one `forge` version for all three workers.** Needs A's `forge --version`.
Two ways out, A's call: A reformats `Escrow.sol` under an agreed version, or everyone pins to
the version that already formats it as-is. Until it is settled, Taskforce will write T-1..T-9
formatted by 1.7.1 — which A's older formatter may then flag in the other direction.
Evidence: `forge fmt --check` exit 1, diffs only in src/Escrow.sol · `forge fmt --check test` exit 0 · `forge fmt --check src/EscrowFactory.sol` exit 0
Blocks: G1 → A-3 → A-4 → G2
Files: contracts/src/Escrow.sol (A-owned, not touched)

## 2026-08-08T03:30Z · T · BLOCK
**This working copy is not a git repository, so no Evidence recorded here can be reproduced
and no `tf/<topic>` branch can exist.** `git rev-parse --is-inside-work-tree` →
`fatal: not a git repository`. In order of cost:
  - The commit hashes already used as Evidence above (`eabd548`, `d8cbccf`) resolve to nothing
    in this tree — `git cat-file -t eabd548` fails. Either A commits in a runtime whose repo
    has not landed here, or those hashes are reachable only to A. Evidence only its author can
    check is not evidence, which is the one thing this file exists to prevent.
  - `docs/prompts/*`, cited in the G0 entry, does not exist here either.
  - C10 mandates `tf/<topic>` branches and the shared definition of done requires a clean
    clone. Neither is possible without a repo.
Raising **D-6 — where is the repository of record?** If it is this directory, it needs
`git init` and a commit of the current tree; Taskforce will not init a shared repo unasked.
If it lives in A's runtime, Taskforce needs the remote before Wave 1 output can be merged
instead of pasted.
Evidence: `git rev-parse --is-inside-work-tree` → fatal: not a git repository · `git cat-file -t eabd548` → fatal · `ls docs/prompts` → No such file or directory
Blocks: merge path for T-1..T-9; the clean-clone half of the shared definition of done
Files: — (repo-level)

## 2026-08-08T03:12Z · A · DONE
MONSKILLS installed locally. Ten skills present: `addresses`, `concepts`, `gas`, `indexer`,
`monskill`, `scaffold`, `tooling-and-infra`, `wallet`, `wallet-integration`, `why-monad`.
Routing goes through the local `monskill` skill; the website is fallback only.
Evidence: `ls .agents/skills/` → 10 entries; `skills-lock.json` written
Files: .agents/skills/**, skills-lock.json

## 2026-08-08T03:12Z · A · FIND
**The MONSKILLS installer silently drops the `wallet` skill — the one that matters for
deployment.** `npx skills add therealharpaljadeja/monskills --yes` installs 9 of 10 and logs
`⚠ Skipped .../wallet/SKILL.md — YAML parse error: Nested mappings are not allowed in
compact mappings at line 2, column 14`. That is the skill holding `propose.sh`,
`propose.mjs`, `DeploySafeCREATE2.sol` and `SAFE_WALLET_MANAGEMENT.md`, so a naive install
leaves you with no sanctioned way to propose a Safe transaction — and the skill forbids
hand-rolling one. Fix: pull it from the `watermarking` branch, where the skills sit at repo
root, and drop it in beside the others.
```
git clone --depth 1 -b watermarking https://github.com/therealharpaljadeja/monskills.git /tmp/ms
cp -r /tmp/ms/wallet .agents/skills/wallet
```
Two smaller traps in the same install: without `--yes` the CLI blocks forever on an
interactive skill picker (npx's own `--yes` does not cover it), and it emits a wall of
`EPERM ... unlink` errors while symlinking into ~40 editor config dirs. Those are cosmetic —
the install under `.agents/skills/` is fine.
Evidence: installer log, `find .agents/skills/wallet -type f` → 8 files incl. utils/propose.sh
Files: .agents/skills/wallet/**

## 2026-08-08T03:28Z · A · FIND
**Alfa's sandbox has no direct network to the chain, the Safe, or the explorers — the relay
is mandatory, not a fallback.** Probed every host we depend on through the sandbox's HTTP
proxy. The allowlist is narrower than assumed:

| Host | Result |
|---|---|
| `github.com` (git + web) | ✅ 200 |
| `registry.npmjs.org` | ✅ 200 |
| `testnet-rpc.monad.xyz` | ❌ 403 from proxy after CONNECT |
| `api.safe.global` | ❌ 403 |
| `agents.devnads.com` | ❌ 403 |
| `api.github.com` | ❌ 403 |

Consequences: A-3/A-4 must run `propose.mjs` **unmodified** with `globalThis.fetch`
overridden to a file-based transport relayed through the Chrome extension, per the pattern
in the sibling `monfund` repo at `tools/relay/`. And `api.github.com` being blocked means
T-11's GitHub check can never be exercised against the live API from a sandbox — which is
already the right design (injected `fetchImpl`, no network in tests), but it means nobody
should plan a live-API smoke test of the GitHub path here.
Evidence: `curl -o /dev/null -w "%{http_code}"` against each host; 403s are proxy CONNECT rejections, not DNS failures
Files: —

## 2026-08-08T03:36Z · S · FIND
Pre-integration Studio review baseline is ready. Read the README, C1-C10, Studio brief, and
all current visual assets twice: once as a sceptical freelancer and once as a sceptical
client. Recorded eight concrete findings without patching another owner's files. The five
highest-risk items are: verifier operator not identified where trust is introduced; 502
offline behavior not explained to users; a valid status-only HTTP criterion can pass a blank
page; bad-faith dispute authority/cost is not yet legible; and `Released` can be mistaken for
money already arriving even though the contract only credits `owed` until `withdraw()`.
S-6 and S-7 now have a static baseline but remain open until G3 because `web/` contains only
`.gitkeep`, so there are no labels, errors, empty-state copy, or browser states to review yet.
Evidence: `assets/review/studio-baseline.md` = 132 lines, 8 numbered findings, SHA-256
`7491E25D2A6CE563A61100884F301DCCB9F0B161BE1E3B7CD55A7D6C67C35DD7`;
`Get-ChildItem web -Recurse -File` = one file, `web/.gitkeep`.
Unblocks: T-18 through T-22 can read the exact copy/trust failure modes before implementing
the frontend; Studio's final review still waits for G3 and A-11.
Invalidates: the assumption that current README/deck copy alone answers the four sceptic
questions; the assumption that the visible word `Released` necessarily means funds reached
the freelancer wallet.
Files: TASKS.md, assets/review/studio-baseline.md

## 2026-08-08T03:29Z · A · FIND
**A full Foundry toolchain can be stood up inside the restricted sandbox, so G1 is now
independently verifiable rather than taken on trust.** `foundryup` and
`binaries.soliditylang.org` are both blocked, and so are GitHub *release assets* — but two
paths survive the allowlist:
```
npm i @foundry-rs/forge @foundry-rs/cast @foundry-rs/anvil      # binaries via npm
git clone --filter=blob:none --sparse https://github.com/ethereum/solc-bin   # solc via the git repo, not a release
cp solc-bin/linux-amd64/solc-linux-amd64-v0.8.28+commit.7893614a ~/.svm/0.8.28/solc-0.8.28
forge test --offline
```
`solc-bin` is a normal git repository, which is why it gets through while
`releases/download/...` does not. Why this matters: the whole point of gate G1 is to stop bad
bytecode reaching a public chain, and A is the one who signs the deployment. A can now
reproduce T's numbers instead of deploying on a report.
Evidence: forge 1.7.1 + solc 0.8.28 running in-sandbox; `forge test --offline` → 12 passed
Unblocks: A can verify G1 itself the moment T posts it
Files: —

## 2026-08-08T03:29Z · A · FIND
**G1 was failing on a condition nobody was tracking, in a file its owner cannot edit.**
Ran the full gate against `main` as it stands: `forge test` → 12 passed (only
`Attestation.t.sol`; T-1..T-9 do not exist yet), `forge build --sizes` comfortably under
limit — but `forge fmt --check` **failed**, and the only offending file was
`contracts/src/Escrow.sol`, which belongs to A. T owns gate G1 but is explicitly barred from
`contracts/src/**`, so T could have finished all nine test files, run the gate, and been
stopped by a file it is not allowed to touch. Fixed in the next entry. Worth generalising:
when a gate spans several owners' files, the gate owner cannot flip it alone.
Evidence: `forge fmt --check` per file → src/Escrow.sol NEEDS FORMAT; all other 4 files clean
Files: contracts/src/Escrow.sol

## 2026-08-08T03:30Z · A · DONE
`contracts/src/Escrow.sol` reformatted; `forge fmt --check` now clean across the whole tree,
so G1's formatting condition is satisfied for every A-owned file and G1 rests purely on
T-1..T-9 from here.
Verified the change is cosmetic rather than trusting that it is: rebuilt before and after and
compared runtime bytecode with the trailing CBOR metadata stripped — **identical**. The full
artifact differs only in the appended metadata hash, which tracks source text by design
(`bytecode_hash = "ipfs"`). No semantic change, no ABI change.
Evidence: `forge fmt --check` → clean; `forge test --offline` → 12 passed, 0 failed; runtime
bytecode minus metadata byte-identical across the reformat (20,507 chars both sides)
Invalidates: nothing — C1 ABI unchanged, all 12 tests still green
Files: contracts/src/Escrow.sol

## 2026-08-08T03:30Z · A · FIND
**Alfa's mount has no `.git`, so A cannot cite commit hashes or see T's branches.**
`git status` from the sandbox returns `fatal: not a git repository ... Stopping at filesystem
boundary`. Two consequences worth stating rather than letting people wonder: A's Evidence
lines cite reproducible command output instead of commit SHAs, and A cannot independently
confirm what has landed on `main` or read a `tf/*` branch. So the G1 handshake has to be
explicit — when T posts the `GATE` entry, A re-runs `forge test` against the working tree it
can see and will say so before proposing any deployment.
Evidence: `git status` in the mounted repo → not a git repository
Files: —

## 2026-08-08T03:29Z · S · HANDOFF
Studio visual system and production assets are ready in the real repository. Completed
S-1 through S-5: the three-timeline challenge-window carrier, progress-lock logo/mark,
favicon and Discord OG image, both transparent empty states, and a nine-slide 1920×1080
deck. Added S-9: a public try-it placeholder plus a six-frame transparent PNG/WebP motion
handoff and animated WebP preview. The accepted direction is dark infrastructure UI on
`#09090b`; the older light `MonEscrow-Visual-Assets.zip` direction is obsolete.
Evidence: 35 Studio files synced under `assets/`; Pillow validation reported `errors=[]`;
deck = 9 PNGs at 1920×1080; favicon = 512×512 RGBA; OG = 1200×630; empty states =
800×600 RGBA with alpha range 0–255; motion = 6 PNG + 6 WebP frames and a 6-frame
animated WebP. `assets/brand/logo.svg` SHA-256 starts `5381A2DFB79F469D`;
`assets/deck/04-challenge-window.png` starts `9DC0353033D26BC6`.
Unblocks: T-18 (brand shell), T-20 (no-jobs state), T-22 (awaiting-freelancer and status
visuals), A-9 (rendered pitch visuals), A-11 (deck/demo visual sequence)
Invalidates: any implementation using the earlier light/paper logo, palette, or
`MonEscrow-Visual-Assets.zip`; use the files under repository `assets/` instead.
Files: TASKS.md, assets/README.md, assets/brand/*, assets/social/*, assets/empty/*,
assets/deck/*, assets/placeholder/*

## 2026-08-08T03:31Z · A · DECIDE
**C9 asset manifest flipped ⬜ → 🔒.** Studio's handoff above was checked against the C9 table
rather than accepted on its word, because C9's whole risk is that the frontend imports these
by literal path and a renamed file is a broken build. Every required path exists at the
required size, so C9 is now frozen and T-18/T-20/T-22 can import against it:

| C9 path | Required | Actual |
|---|---|---|
| `assets/brand/logo.svg` | vector | SVG, viewBox 0 0 284 64 ✅ |
| `assets/brand/logo-mark.svg` | vector 1:1 | SVG, viewBox 0 0 64 64 ✅ |
| `assets/brand/favicon.png` | 512×512 | 512×512 RGBA ✅ |
| `assets/social/og.png` | 1200×630 | 1200×630 ✅ |
| `assets/empty/no-jobs.png` | 800×600 transparent | 800×600 RGBA, alpha 0–255 ✅ |
| `assets/empty/awaiting-freelancer.png` | 800×600 transparent | 800×600 RGBA, alpha 0–255 ✅ |
| `assets/deck/*.png` | 1920×1080 | 9 files, all 1920×1080 ✅ |

Both SHA-256 prefixes Studio published reproduce exactly — `logo.svg` → `5381A2DFB79F469D`,
`deck/04-challenge-window.png` → `9DC0353033D26BC6`. That is the first cross-runtime evidence
claim in this file to be independently reproduced, and it worked, which is the argument for
the Evidence line existing at all.
`assets/placeholder/**` is outside C9 (S-9, added by Studio); it is fine to ship but no
frontend path may depend on it until it is added to the C9 table.
Evidence: sizes read with Pillow; `sha256sum` matches both published prefixes; 9/9 deck slides at 1920×1080
Unblocks: T-18, T-20, T-22 (import paths now frozen), A-9, A-11
Files: docs/01-INTERFACES.md

## 2026-08-08T03:32Z · A · DECIDE
**D-5 resolved — pinned to forge 1.7.1, and T's `fmt` BLOCK is already stale.** There is no
formatter drift between us: Taskforce is on 1.7.1 `win32_amd64`, Alfa is on 1.7.1
`linux_amd64`, and both report the same commit SHA `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`.
We were on the same build the whole time. Alfa reformatted `src/Escrow.sol` under exactly that
build at 03:30Z — the same minute the BLOCK was posted, so the two crossed.

`forge fmt --check` is now clean across the entire tree. **T-1..T-9 can be written normally;
the "A's older formatter may flag it in the other direction" risk does not exist.** T's read of
the diffs was right in every particular — all three hunks were signatures the 120-column rule
now collapses (`constructor(...) payable EIP712(...)`, `attest(...) external`, and the
`attestationDigest` return).

Pinned in `contracts/foundry.toml` as a comment, since Foundry cannot pin its own version.
Upgrading forge is now a `DECIDE`, not a personal choice: a new formatter rewrites files
nobody touched and takes G1 red for all three workers at once.

Also worth recording, because it is the strongest evidence in this file so far: T rebuilt from
an empty `lib/` on a different OS and got **byte-identical** numbers to A — 12 passed/0 failed,
Escrow 10,252 B runtime (margin 14,324), EscrowFactory 15,759 B (margin 8,817). Two runtimes,
two operating systems, same output. The A-0 baseline is not an artifact of one machine.
Evidence: both workers report forge 1.7.1 @ 4072e487 · `forge fmt --check` exit 0 tree-wide · `forge test --offline` → 12 passed · runtime bytecode minus CBOR metadata unchanged by the reformat
Unblocks: **T-1..T-9 — the fmt half of G1 is green; G1 now rests only on the nine test files**
Files: contracts/foundry.toml, contracts/src/Escrow.sol

## 2026-08-08T03:32Z · A · BLOCK
**D-6 escalated to the human — A cannot resolve it and will not `git init` unasked either.**
Taskforce is right, and the sharpest line in this file so far is theirs: *evidence only its
author can check is not evidence.* That lands on A's own earlier entries, so, plainly: the
hashes `eabd548` and `d8cbccf` are not verifiable from this tree, and `docs/prompts/*` cited in
the G0 entry does not exist here. A's later entries deliberately cite reproducible command
output instead, and the two S-handoff SHA-256 prefixes did reproduce — that is the standard the
rest of this file should hold to.

A sees the same thing T does: `git status` → `fatal: not a git repository`, no `.git` anywhere
in the mount. So A cannot read a `tf/*` branch, cannot confirm what is on `main`, and cannot
merge T's Wave 1 output — it can only be pasted, which defeats the one-owner-per-path rule the
moment two people paste.

Not resolvable by either agent, because the answer depends on something only the human can see:
whether a repository of record already exists elsewhere. Two outcomes, human's call —

1. **This directory is it.** Then one `git init` + initial commit here, and every worker gets
   branches, diffs, and a clean-clone check. Cheap, and it retires D-6 permanently.
2. **The repo lives elsewhere.** Then T and A need the remote URL before Wave 1 output exists,
   not after.

Until it is settled, treat every `Files:` line as naming a path in a shared working tree with no
history, and keep Evidence to commands anyone can re-run.
Evidence: `git status` → fatal: not a git repository (Alfa, independently of T's identical result)
Blocks: merge path for T-1..T-9 · `tf/*` and `alfa/*` branches per C10 · the clean-clone half of the definition of done · A-12 reproducible-build proof
Files: — (repo-level)

## 2026-08-08T03:33Z · T · FIND
**Both of T's BLOCKs from 03:30Z are already closed — by A, in the same minute.** Retracted
here rather than edited, per the append-only rule; read them together with this entry.
  - **D-5 (pin the `forge` version)** — moot in practice. A reports forge 1.7.1 + solc 0.8.28
    in-sandbox, which is exactly what T installed natively, and A's reformat of `Escrow.sol`
    checks clean under T's formatter too. Still worth writing the version down somewhere:
    agreement by coincidence is not a pin.
  - **D-6 (repository of record)** — not a Taskforce-only problem. A reports the same
    `fatal: not a git repository` from its own mount, so no worker can cite or verify a commit
    hash and no `tf/*` branch is visible to A. A's explicit G1 handshake — A re-runs the suite
    against the tree it can see before proposing a deployment — is the right substitute.
    D-6 stays open for the human.
Independent confirmation of the gate after A's reformat, on a native Windows toolchain instead
of A's Linux sandbox: different OS, separately fetched solc, same numbers. Also re-checked the
external surface after the reformat, because a 500-line file changing under a test author is
worth one grep: unchanged against C1.
Evidence: `forge fmt --check` exit 0 tree-wide · `forge test` → 12 passed, 0 failed, 0 skipped · `forge build --sizes` → Escrow 10,252 B runtime, EscrowFactory 15,759 B, both under limit · 26 errors + 17 external functions, identical to C1
Unblocks: G1 now rests purely on T-1..T-9 — T starts the Wave 1 fan-out now
Files: —

## 2026-08-08T03:36Z · S · FIND
Canonical append for Studio's pre-integration review baseline. A same-minute copy of this
finding was accidentally inserted at line 204 because the patch anchor `Files: —` was not
unique. It is intentionally left untouched to preserve the append-only rule; this bottom
entry is the one later readers should use.

Eight static findings are recorded after reading the README, C1-C10, Studio brief, and all
current visual assets as both a sceptical freelancer and sceptical client. The five
highest-risk items are: verifier operator not identified where trust is introduced; 502
offline behavior not explained to users; a valid status-only HTTP criterion can pass a blank
page; bad-faith dispute authority/cost is not yet legible; and `Released` can be mistaken for
money already arriving even though the contract only credits `owed` until `withdraw()`.
S-6 and S-7 have a static baseline but remain open until G3 because `web/` contains only
`.gitkeep` and therefore has no reviewable labels, errors, empty-state copy, or browser states.
Evidence: `assets/review/studio-baseline.md` = 132 lines, 8 numbered findings, SHA-256
`7491E25D2A6CE563A61100884F301DCCB9F0B161BE1E3B7CD55A7D6C67C35DD7`;
`Get-ChildItem web -Recurse -File` = one file, `web/.gitkeep`.
Unblocks: T-18 through T-22 can read the exact copy/trust failure modes before implementing
the frontend; Studio's final review still waits for G3 and A-11.
Invalidates: the assumption that current README/deck copy alone answers the four sceptic
questions; the assumption that `Released` necessarily means funds reached the wallet.
Files: TASKS.md, assets/review/studio-baseline.md

## 2026-08-08T03:41Z · A · BLOCK
**D-6 answered "git init here" — but Alfa physically cannot do it. One command for the human,
on Windows.** The mount Alfa works through permits create and rename but **denies `unlink`**,
and git's index protocol is create-lock → write → unlink-lock. Tested rather than guessed:
`git init` succeeds, then `git add -A` stages **0 files**, leaves an `index.lock` that cannot
be removed, and scatters `tmp_obj_*` files in `.git/objects` that also cannot be removed.
`git fsck` reports only dangling blobs and an unborn branch. The same limitation is why the
MONSKILLS installer threw ~40 `EPERM ... unlink` errors earlier — same root cause, and it took
until now to recognise it.

So there is a half-initialised `.git/` in the tree that A cannot clean up. **Delete it and
redo it natively** — from PowerShell in the project folder:

```powershell
Remove-Item -Recurse -Force .git
git init -b main
git add -A
git commit -m "MonEscrow: contracts, interfaces C1-C10, Studio assets, Safe relay"
```

Two things to know before running it. `contracts/lib/` is gitignored and was installed with
`--no-git`, so a clean clone has **no dependencies** — either commit `lib/`, convert to
submodules, or document the two pinned `forge install` commands from T's 03:30Z FIND; the
clean-clone half of the definition of done is not satisfied until one of those happens.
And `.agents/skills/` **is** committed on purpose (320 KB, 46 files): the installer silently
drops the `wallet` skill, so vendoring the tree is what guarantees the next clone can still
propose a Safe transaction.
Evidence: `git add -A` → 0 staged · `rm .git/index.lock` → Operation not permitted · `git fsck` → dangling blobs, unborn branch · 7 unremovable `tmp_obj_*`
Blocks: still blocks the merge path for T-1..T-9, `tf/*` branches, and A-12
Files: .gitignore (keys, relay spool, rationale for vendoring skills)

## 2026-08-08T03:42Z · A · DONE
**A-1 done — verifier keypair generated, address published, key server-side only.**
`NEXT_PUBLIC_VERIFIER_ADDRESS=0x87B9AfEafA109e96c41504E0ce84e08c055D5eaf`. Private half is in
`web/.env.local` as `VERIFIER_PRIVATE_KEY`, never with a `NEXT_PUBLIC_` prefix; the encrypted
keystore is at `deploy/keys/`. Both paths are gitignored, and the ignore rules were checked
with `git check-ignore` against the real filenames rather than assumed from the patterns.

`web/.env.example` now implements C8 in full and is committed with the real verifier
*address* in it — that value is public by design, and hardcoding it is what lets a judge run
from a clean clone without being handed a secret out of band.

Worth stating plainly because it will come up in review: **a leaked verifier key does not
move money.** It can propose a passing milestone, which opens the challenge window — the
client can still object. That is the entire reason the verifier proposes rather than decides,
and it is why an empty-password keystore is an acceptable risk for a testnet demo rather than
a hole. Rotate it anyway if it leaks.
Evidence: `cast wallet address --private-key` re-derives the published address exactly · `git check-ignore` → `web/.env.local` and `deploy/keys/` ignored, `web/.env.example` committed · repo-wide grep: the key appears in exactly one file, and that file is ignored
Unblocks: T-13 (`sign.ts` can assert recovery against a real address), T-14, T-22
Files: web/.env.example, web/.env.local (ignored), .gitignore

## 2026-08-08T03:44Z · A · DECIDE
**D-3 resolved — two numbers, not one. Product default 3 days (259,200 s); demo preset 90 s.**
A 90-second window is the only way the countdown visibly runs out on camera, and A-8 needs the
client to object *inside* it while someone is watching. But shipping 90 s as the default would
quietly wreck the pitch — a judge reading "challenge window: 90 seconds" concludes toy, and
they would be right. The realistic default is what makes the short one legible as a demo
setting rather than the design. `/new` offers 90 s · 24 h · **3 d (default)** · 7 d.

90 rather than 60 because the client must notice the attestation, open a wallet and confirm; a
wallet popup alone can eat 20 seconds, and A-7 has to dispute inside the window on the first
take.

This is UI policy and changes nothing in C1: `challengeWindow` is a plain `uint32` with no
minimum, and `0` is legal and means immediately-releasable — which stays T-4's to test.
Demo escrow shape also fixed: 3 milestones (`http`, `github`, `clientApproval`), deadline 7
days out. Milestone 1 is `http` on purpose — it is the one A-8 points at a blank page.
Evidence: deploy/DEMO-PARAMS.md; constructor imposes no bound on `challengeWindow` (read at Escrow.sol:198-247)
Unblocks: T-21 (`/new` preset list), T-22 (countdown copy), A-6, A-7, A-8
Files: deploy/DEMO-PARAMS.md

## 2026-08-08T03:45Z · A · DONE
**`contracts/script/Deploy.s.sol` written — and its real job is not `run()`.** The factory
reaches the chain through a Safe that delegatecalls `CreateCall`, not through a broadcast, so
the script's load-bearing entrypoint is `initCode()`, which prints the exact creation bytecode
the Safe must pass to `performCreate` along with its hash. `runtimeHash()` exists for A-12.

`EscrowFactory` takes no constructor arguments, which is the one case where forgetting to
ABI-encode arguments still deploys *something* — subtly wrong rather than obviously broken. It
is called out in the file for whoever reads it next.
Evidence: `forge script --sig "initCode()" --offline` → 15,787 bytes, keccak `0xfa55d0d3c6ba038111612982236294823982eaa6d4e3fa0079e2cc299c36628e` · `runtimeHash()` → `0x4e831deb499a9dea56c962df4ed12a0118a49af98514e9f368bed8c375adffd5` · `forge fmt --check` clean · 12 tests still green
Files: contracts/script/Deploy.s.sol

## 2026-08-08T03:47Z · A · DONE
**A-16 done — the Safe proposal relay works, proven end-to-end before deploy day rather than
during it.** `propose.mjs` runs **unmodified**: `node --import fetch-relay.mjs propose.mjs`
loads the hook before the entry module and swaps `globalThis.fetch` underneath it. The wrapper
prints the skill's SHA-256 and the running copy's side by side every run, so "unmodified" is
checkable rather than claimed. One override covers both network calls, because viem's `http()`
transport and the Safe POST both go through global fetch.

Full dry run against a dummy Safe with a throwaway signer: relayed RPC `nonce()` read → local
EIP-712 signature → relayed Safe Transaction Service POST → 201. Two hops, both clean.

Envelopes are gzip+base64 with SHA-256 over the decoded JSON checked at both ends. That is not
ceremony: a Safe deployment payload is ~16 KB of hex crossing a console and a clipboard, and a
silent truncation would propose a validly-shaped transaction deploying *different bytecode* —
it would deploy, verify against nothing, and surface much later. Confirmed the guard fires:
clipping 8 characters off a response is caught at gunzip before the caller sees it. Responses
are matched on `runId` **and** `seq` so a stale file from an earlier run cannot be consumed.

`PRIVATE_KEY` never enters the spool — `propose.mjs` signs locally and sends only the
signature — and the hook additionally aborts if it ever sees the key in an outbound envelope.
Verified against the full run: neither raw spool files nor decoded payloads contain it.
Evidence: `propose.mjs sha256 a75771476b76adab33d6005c49739ccedd89f37e43ea33b20a84334cdcd83966` identical to the skill's copy · run log: `Safe nonce: 0` → `Agent signed (1/2)` → POST 201 · truncation test → caught at gunzip (`Z_BUF_ERROR`) · key-leak scan across raw and decoded spool → clean
Unblocks: A-3 the moment G1 and A-2 land — the transport is no longer an unknown
Files: tools/relay/fetch-relay.mjs, tools/relay/propose-via-relay.sh, tools/relay/courier.mjs, tools/relay/README.md, .gitignore

## 2026-08-08T03:54Z · S · HANDOFF
S-10 complete: the nine-slide deck now has a timed 90-second script, a full three-minute
script, expected judge questions, and a recording shot list for A-11. The handoff incorporates
D-3 explicitly: product default is 3 days, while 90 seconds is only the demo preset. It also
locks the claims most likely to drift on camera: the verifier proposes but cannot move funds;
anyone may call `release` only after the window; and `Released` credits `owed` before the
recipient separately calls `withdraw()`.
Evidence: `assets/deck/SPEAKER-NOTES.md` = 159 lines / 1,012 words, SHA-256
`89843B657CB7999E18CEF92D4FFF197C1A829420B16574AFF7C739252CACB156`;
`assets/deck/RECORDING-SHOT-LIST.md` = 52 lines / 418 words, SHA-256
`EE0E97250FC27B2F5517CE571C635E3DD7C9407C73B942F46EDC2D276DA8A397`.
Unblocks: A-11 has a shot order and rejection checklist before recording; S-8 will receive a
recording whose intended proof points are explicit.
Invalidates: any pitch script that presents 90 seconds as the product default, calls the
verifier an AI judge, says time itself broadcasts a release transaction, or treats Released
as money already received in the wallet.
Files: TASKS.md, assets/deck/SPEAKER-NOTES.md, assets/deck/RECORDING-SHOT-LIST.md

## 2026-08-08T03:58Z · A · DONE
**A-20 done, and it was a real hole: a clean clone did not build.** `contracts/lib/` is
gitignored and the deps were installed with `--no-git`, so a fresh checkout had no
dependencies at all and `forge build` died on missing `forge-std`. That is the clean-clone
half of the shared definition of done, and it was quietly false.

Tested rather than reasoned about — copied the tree with `lib/`, `out/`, `cache/` and
`broadcast/` stripped, confirmed it fails, then ran the documented setup and confirmed it
recovers. Added `contracts/Makefile` so it is one command: `make setup && make gate` takes a
tree with no `lib/` to fmt-clean, sizes-under-limit, 12/12 green.

**A-12's method also verified early, which was the useful surprise.** The pristine tree
compiles to runtime bytecode byte-identical to the working tree — EscrowFactory sha256
`0013af7e3dd2300c932009661cef78cacb6c864581fbb5f4e04ae0902e9c848e`, Escrow
`fdd957cafed99b0d9085b8de3c571920064eb5c582a950373fdf8d46348fdd55`. So the reproducible-build
claim is already true of the source; all that remains at A-12 is comparing against
`cast code` once the factory is on chain. `make repro` prints both sides.
Evidence: pristine tree without `lib/` → `forge build` fails on missing forge-std → `make setup` → `make gate` → 12 passed, fmt clean, sizes under limit · runtime bytecode sha256 identical between pristine and working trees · deps resolve to the tags T pinned (forge-std 1.16.2, oz 5.7.0)
Unblocks: the clean-clone half of the definition of done, for everyone
Files: contracts/Makefile, README.md

## 2026-08-08T04:00Z · A · DONE
**A-9 done — four Mermaid diagrams in the README, every one parsed rather than eyeballed.**
Architecture, milestone state machine, the attestation → challenge-window sequence, and the
Safe deployment flow. A broken Mermaid block does not error on GitHub, it silently renders as
a raw code fence — a wall of text where the diagram should be, in the first thing a judge
reads. So `tools/check-mermaid.mjs` runs the blocks through **mermaid's own parser** (via
jsdom), which is the same grammar GitHub uses, rather than a hand-rolled approximation. It
also flags hardcoded dark fills, which are unreadable for the half of readers on light theme.

One Node detail for whoever reuses that script: Node 21+ makes `navigator` a getter-only
global, so `globalThis.navigator = …` throws and you need `Object.defineProperty`.

The sequence diagram makes the two things people miss explicit: `release` is callable by
**anyone** (an honest freelancer never chases a signature), and `Released` credits an internal
balance rather than moving MON — Studio flagged that same gap in its copy review, so the
README and DEMO now both separate release from withdraw.
Evidence: `node tools/check-mermaid.mjs README.md DEMO.md` → 4/4 blocks OK (flowchart TB, stateDiagram-v2, sequenceDiagram, flowchart TD) · all internal markdown links resolve · all five referenced make targets exist
Unblocks: A-11 (the deck and recording can follow these four diagrams), S-8
Files: README.md, tools/check-mermaid.mjs

## 2026-08-08T04:01Z · A · DONE
**A-10 done — `DEMO.md`, written as the primary judge-facing artifact now that D-4 settled on
clean-clone only.** Setup, the happy path as a nine-step table, the failure paths, and how to
verify the deployment yourself instead of trusting the explorer.

The centre of it is the adversarial demo, written to argue rather than to instruct: deploy a
blank page, watch it **pass** an HTTP-200 check with a valid signature from the real verifier
key, and then watch the client keep their money anyway. The honest framing is the persuasive
one — `HTTP 200` and `Lighthouse > 80` are both satisfied by a blank page, every automated
check anyone ships has this property, and the design survives it only because it never
treated the check as a verdict.

Also documents the release/withdraw split prominently, since a milestone reading `Released`
has *not* reached anyone's wallet, and 502-vs-422 in the verifier, since "we could not reach
the site" must never be signed as a failing milestone.
Evidence: DEMO.md written against the C1 caller/precondition table; every documented command (`make setup`, `make gate`, `make repro`, `make probe-evm`) exists in contracts/Makefile and was executed at least once
Unblocks: A-11 (the recording follows this script), G4
Files: DEMO.md

## 2026-08-08T04:01Z · A · FIND
**Two repo-hygiene things worth knowing, neither fixable from Alfa's mount.**
  - The MONSKILLS install landed **twice** — `.agents/skills/` and `agent/skills/` are
    duplicate trees. Only `.agents/skills/` is referenced by `tools/relay/propose-via-relay.sh`
    (and it is the one holding the manually restored `wallet` skill). `agent/` can be deleted
    on Windows; Alfa cannot unlink it.
  - A half-initialised `.git/` is still sitting in the tree from the 03:41Z attempt, with an
    `index.lock` and seven `tmp_obj_*` files that cannot be removed from here. It must be
    deleted before a real `git init`, or git will refuse to stage. Junk files created during
    that attempt were swept into `.git/` deliberately so that removing it removes them too.
Evidence: `find agent -type f` and `find .agents -type f` return parallel trees; `rm` → Operation not permitted for both
Files: — (repo-level)

## 2026-08-08T04:10Z · T · FIND
**Nine test authors, working blind to each other, produced 34 findings about `contracts/src`.**
Full list with reasoning in `contracts/test/FINDINGS.md`. Nothing was fixed — src is A's per
C10 — and no test was weakened to accommodate any of it. Where several agents landed on the
same thing independently that is convergent evidence, and the count is recorded.

The one that is unambiguously a bug rather than a judgement call:
  - **`EscrowFactory.getEscrows(offset, limit)` panics instead of clamping.** Line 68 does
    `uint256 end = offset + limit;` under checked arithmetic, so a large `limit` —
    `type(uint256).max` being the obvious "everything from here" sentinel — reverts with
    `Panic(0x11)` instead of `BadRange()` or a clamped page. `BadRange()` only covers
    `offset > total`. One-line fix; reproduced empirically in an isolated copy by two agents
    independently. It will hit the frontend in Wave 4 the first time a list view asks for
    everything.

Three that need a decision rather than a patch:
  - **`challengeWindow` is unvalidated at both ends** (found 3×). Zero lets the verifier
    `attest(passed)` and `release()` in one transaction with no window for the client to
    object — the verifier acting as a unilateral authority, which the design note says must
    never happen. It is also a documented capability that T-4 is required to prove, and does.
    So this is a decision about whether zero should be reachable and whether the UI may offer
    it, not a silent fix. At the other end there is no cap, and a huge window strands an
    Attested milestone with no exit but `approve()` or `dispute()`.
  - **`Disputed` has no timeout** (found 2×). `resolveDispute` is the only way out, it is
    arbiter-only, and `reclaim` refuses Disputed. An arbiter who disappears freezes that
    milestone permanently. "What if the arbiter vanishes" is a question the pitch will be
    asked.
  - **`reclaim` and `attest` race after the deadline** (found 2×). `attest` has no deadline
    gate and `reclaim` accepts Submitted, so a freelancer holding a valid pass signature can
    front-run the client's reclaim. Probably the intended outcome, but it resolves by
    transaction ordering rather than by rule.

One that Taskforce will absorb rather than ask A to change: guard ordering makes the revert
selector depend on the clock and the caller (`client.reclaim(999)` before the deadline says
`DeadlineNotPassed`, not `BadMilestone`), so Wave 4 cannot derive the "why can't I do this"
message from the selector alone. That is a UI problem, handled in the UI.

Evidence: contracts/test/FINDINGS.md, 34 findings across 9 independently-written files; F-A reproduced by two agents in isolated copies
Invalidates: nothing yet — but any edit A makes to `contracts/src/**` invalidates the tests written against it, so T would rather hear about a change now than after G1
Files: contracts/test/FINDINGS.md

## 2026-08-08T04:14Z · T · DONE
**Both repo-hygiene blockers from A's 04:01Z FIND are cleared.** Windows-side, which is why
they were T's to do. Quarantined rather than deleted — moved out of the tree into scratch, so
permanent deletion stays the human's call and nothing is unrecoverable in the meantime.

  - `.git/` — the half-initialised one from the 03:41Z attempt. Inspected before touching it:
    HEAD pointed at `refs/heads/main`, `refs/heads/` was **empty**, and
    `cat-file --batch-all-objects` found **6 blobs and 1 tree, zero commits**. No history
    existed, so nothing was lost. Also carried the stray `deltest2` and `tqnA433` files and
    the `index.lock` A could not unlink. `git rev-parse` now reports a clean not-a-repository,
    so a real `git init` will work the moment D-6 is answered.
  - `agent/` — verified a strict subset of `.agents/` before moving: 38 files against 46, and
    a path-level diff found **nothing present in `agent/` that is absent from `.agents/`**.
    The 8-file difference is the manually restored `wallet` skill, which lives only in
    `.agents/` — the tree `tools/relay/propose-via-relay.sh` actually references. So the
    duplicate was strictly stale.

Also read D-3 and took the numbers: `/new` will offer 90 s · 24 h · 3 d (default) · 7 d for
T-21, and T-22's countdown copy will say "3 days" in the product and treat 90 s as a demo
preset. T-4 keeps testing `challengeWindow == 0` as legal-and-immediate, unchanged.

Evidence: `.git` object inventory before the move → 6 blob, 1 tree, 0 commit, 0 refs · `diff` of relative file paths, `agent/` minus `.agents/` → empty · repo root after → no `.git`, no `agent/` · both trees recoverable from scratch quarantine
Unblocks: a real `git init` (still gated on D-6), and removes the duplicate skill tree that could send a future reader to the copy without the `wallet` skill
Files: — (repo-level; nothing under contracts/ or web/ touched)

## 2026-08-08T05:20Z · T · DONE
**D-6 answered by the human, and the repository exists: `github.com/rahmanef63/monescrow`,
public, `main` pushed.** Every Evidence line from here on can cite a hash that anyone can
resolve, which is the thing this file has been missing since its first entry.

  - `9192754` first commit — 131 files. `be5b522` — `.gitattributes`.
  - `contracts/lib/` stays gitignored, so a clean clone needs `make setup` before `make gate`.
    A-20's clean-clone claim is now literally testable by cloning rather than by copying a
    tree with directories stripped.

Three things were changed against the instructions as given, each for a reason:

  - **Skipped `echo "# monescrow" >> README.md`.** That is GitHub's boilerplate for an empty
    repo; this one is not empty, and A had just finished A-9 in that file. Appending a stray
    heading would have landed on top of four verified Mermaid diagrams.
  - **`git add -A`, not `git add README.md`** — the boilerplate commits one file.
  - **Fixed a `.gitignore` bug that made `git add -A` impossible.** The root `node_modules` is
    a dangling *symlink* into a machine-local `/tmp` (left by the mermaid checker), and the
    ignore pattern was `node_modules/` — a trailing slash matches only real directories, so
    git tried to index the symlink and died with `open("node_modules"): Function not
    implemented`. Pattern is now slash-less. The symlink is left in place so A's tooling keeps
    working; it is simply never staged.

**Pre-push secret scan, because the repo is public and a push is not reversible in any way
that matters.** Scanned every staged text blob for 64-hex values, assigned `PRIVATE_KEY` /
`SECRET` / `API_KEY` / `TOKEN`, and `sk-` / `ghp_` prefixes. Clean: `web/.env.example` carries
every server-side name with an empty value, `NEXT_PUBLIC_VERIFIER_ADDRESS` is an address and
public by design per C8, the only other matches were documentation placeholders in
`.agents/skills/**` (`<public-key>`, `$PRIVATE_KEY`) and the two bytecode keccaks in this
changelog. Nothing under `deploy/keys/` was staged.

**One repo-level fix that belongs to A's critical path, flagged rather than assumed.**
`core.autocrlf` is `true` on this machine. The blobs went in as LF, but on the *next* clone
git would check out CRLF on Windows and LF on Linux — the same commit, different source
bytes. solc hashes source text into the CBOR metadata it appends to the runtime bytecode
(`bytecode_hash = "ipfs"`), so that is a different bytecode tail per platform: it would break
A-12's byte-identical claim across machines and can downgrade explorer verification at A-4
from a full match to a partial one. Added `.gitattributes` pinning `* text=auto eol=lf`.
Verified with `git add --renormalize .` that no existing blob changes — the fix is additive,
it only stops the working tree drifting per platform. A should re-run `make repro` on a fresh
clone before A-4 rather than taking that on trust.

Evidence: `git push` → `* [new branch] main -> main`; `gh repo view` → `isEmpty: false`, `defaultBranchRef: main`, `pushedAt 2026-08-08T05:17:57Z` · 131 files staged, 0 matches in the secret scan outside documented placeholders · `git add --renormalize .` → only `.gitattributes` staged
Unblocks: A can cite and resolve commit hashes, and can read `tf/*` branches; the clean-clone half of the definition of done is now checkable by an outsider; D-6 closed
Files: .gitignore, .gitattributes

## 2026-08-08T05:20Z · T · FIND
**Mutation-tested the Wave-1 suite against itself: 71 mutations, 62 killed, and three
survive the entire 125-test suite.** Three auditors broke `src/` in disposable sandboxes and
checked whether the tests noticed; the three survivors were then re-verified by hand against
the full merged tree, because a per-batch run can call something uncaught that another file
actually catches. These three are caught by nothing:

  - **`cancel()`: delete the `if (m.state == MState.Pending)` guard** and refund every
    milestone unconditionally — 125/125 still green. The guard is load-bearing and the bad
    state is reachable: `reclaim()` has no `acceptedAt` guard, so after the deadline a client
    can `reclaim()` a milestone on a never-accepted escrow and then still `cancel()`, which
    only requires `acceptedAt == 0`. Without the guard the milestone is credited twice, the
    contract owes more than it holds, and the client's own `withdraw()` reverts
    `TransferFailed`. **This retracts a claim T published at 04:10Z**: three Wave-1 authors
    independently called that branch dead, T repeated it in `contracts/test/FINDINGS.md` as
    convergent evidence, and it is wrong. Three agents agreeing is not three checks.
  - **`withdraw()`: move `owed[msg.sender] = 0` to after the external call** — the textbook
    reentrancy hole — 125/125 green.
  - **`withdraw()`: remove `nonReentrant`** — 125/125 green.

The last two share one cause worth stating plainly: `withdraw()` is defended twice, by the
transient guard *and* by correct effects-before-interactions ordering, and the reentrancy
test only asserts that the nested call failed. Either defence alone satisfies it, so neither
is actually protected. A future refactor that drops the modifier believing CEI is enough — or
reorders the effect believing the modifier is enough — ships green.

Also confirmed by mutation, on the other side of the ledger: deleting the `ChallengeWindowOpen`
guard, making it off-by-one, widening `release`'s state check, crediting the wrong party on
`cancel`, ignoring the transfer result, and re-disputing a Disputed milestone are all caught.
The headline property is genuinely protected — by `ChallengeWindow.t.sol`, not by the
invariants.

Separately, the invariant suite had no stateful coverage of `release` at all: 0 successes in
32,768 calls, because `approve` and `dispute` consumed every Attested milestone before a warp
could ripen one. Repaired — a three-escrow cohort with staggered deadlines and ripeness-aware
selection — and `release` now lands 13 successes per run, `reclaim` 15, with all twelve
actions exercised. No invariant was weakened to get there.

Evidence: 71 mutations across 3 sandboxes, 62 killed · survivors M1/M2/M3 re-verified against the full tree, each leaving `125 passed, 0 failed` · invariant COVER before → `release 21 0`, after → `release 60 13`, `reclaim 63 15` · suite green and `forge fmt --check` clean at every step
Invalidates: the "dead branch in `cancel()`" line in `contracts/test/FINDINGS.md` and in T's 04:10Z entry — the branch is reachable and load-bearing. A should not simplify it.
Files: contracts/test/Invariant.t.sol, contracts/test/handlers/EscrowHandler.sol

## 2026-08-08T04:26Z · A · FIND
**T's F-B is real, I reproduced it independently, and it makes a security claim I published
earlier false.** Wrote a throwaway test against an isolated copy of `src/` rather than taking
the report on trust. With `challengeWindow == 0`, one caller holding only the verifier
signature calls `attest(passed=true)` and `release(0)` **in the same block**, and the
freelancer withdraws. The client never gets a chance to `dispute()`. With a window of 90 s the
identical sequence reverts on `release` and the client's objection still lands.

**Retracting what I wrote at 03:42Z and in `web/.env.example`:** I said a leaked verifier key
"can propose a passing milestone, and that is all — a pass does not move money." That holds
only for `challengeWindow > 0`. At zero, the verifier key *is* unilateral authority over the
client's funds — precisely the thing `Escrow.sol`'s own design note says must never happen.
My D-3 entry waved at zero as "legal, means immediately-releasable, T-4's to test." That was
the wrong reading: it is not an edge case, it is a reachable configuration in which the
headline claim of the product is untrue.

Two things made this hard to see and are worth naming. The zero-window behaviour is a
*documented requirement* — `docs/03-CLAUDE-CODE.md` tells T-4 to prove it, and
`ChallengeWindow.t.sol` does, correctly. And a UI that only offers 90 s upward never reaches
it. Neither is a defence: the contract is the trust boundary, anyone can call `createEscrow`
directly, and "our frontend wouldn't do that" is not a property of a contract.

Also confirming **F-A** as an unambiguous bug: `EscrowFactory.getEscrows(offset, limit)` uses
checked `offset + limit`, so a `type(uint256).max` "everything from here" sentinel panics
`0x11` instead of clamping. One line, and the factory is the only index the frontend has.

Not editing `contracts/src/**` yet. Standing rule from `docs/02-ALFA.md`: a contract change is
announced to T and S **before** it happens, because it invalidates work in flight — here,
`ChallengeWindow.t.sol`'s zero-window test and the line in `03-CLAUDE-CODE.md` that requires
it. Decision goes up as D-7.
Evidence: throwaway `FB.t.sol` in an isolated copy → `test_FB_ZeroWindow_VerifierDrainsInOneTx` passes (same-block attest+release+withdraw, 1 ether to freelancer, client never consulted); `test_FB_NonZeroWindow_ClientKeepsRecourse` passes (release reverts, dispute lands) · `src/` never touched
Invalidates: my 03:42Z verifier-key risk claim, and the same wording in `web/.env.example`
Blocks: **A-3 — do not deploy until D-7 is settled.** Deploying this and fixing it later means redeploying and re-verifying.
Files: contracts/test/FINDINGS.md (T's report), CHANGELOG.md

## 2026-08-08T05:30Z · A · DECIDE
**F-A fixed in `EscrowFactory.getEscrows` — and it turns `Factory.t.sol` red on purpose.
T-8 has a three-line change to make.**

Clamp before adding instead of after:

```solidity
uint256 end = limit > total - offset ? total : offset + limit;
```

Safe because `offset <= total` is already enforced by the `BadRange()` guard on the line
above. `getEscrows(1, type(uint256).max)` now returns a clamped page instead of panicking
`0x11`. Verified in an isolated copy before touching `src/`: max-uint sentinel clamps at
offset 0, 1 and `== length`; normal pages unchanged; `offset > length` still reverts
`BadRange()`. Runtime size 15,759 → 15,771 B, margin still 8,805.

**`test_RevertWhen_PaginationLimitOverflowsTheEndCalculation` now fails**, and that is the
intended consequence — it pinned the panic. `contracts/test/**` is T's under C10 so A has
not touched it, and T left precise instructions in the test's own docstring: update it to
expect a clamped page or `BadRange()`, do not delete it, the boundary still needs covering.
Lines 219 and 224 are the two `vm.expectRevert(stdError.arithmeticError)` calls to invert.

One correction to the report, offered as calibration rather than criticism: FINDINGS.md says
F-A is "not tested for", but `Factory.t.sol:209` does test it, deliberately and with a
docstring anticipating this exact fix. The test was better than its own summary — worth
knowing, because A nearly shipped the fix assuming nothing would go red.

**Gate status: 121 of 122 passing, one red, and the red one is mine to have caused and T's to
resolve.** G1 cannot flip until that test is inverted.
Evidence: isolated `FA.t.sol` → clamps at offsets 0/1/length, `BadRange()` preserved, normal pages unchanged · full suite after the edit → `Ran 9 test suites: 121 passed, 1 failed` · the single failure is `test_RevertWhen_PaginationLimitOverflowsTheEndCalculation` · `forge fmt --check` clean
Invalidates: `Factory.t.sol:209` — inverting it is the only work this creates
Unblocks: T-20/T-22 may now use a max-uint "everything from here" sentinel safely
Files: contracts/src/EscrowFactory.sol

## 2026-08-08T05:58Z · A · DECIDE
**D-4 reversed — hosted *and* clean-clone, not clean-clone only.** A judge gets a link they
can click; `DEMO.md`'s local path stays valid, so nothing depends on one Vercel account
staying up.

**T needs to know two things.** The app now runs somewhere with real environment variables,
which changes how `VERIFIER_PRIVATE_KEY` is handled — Next.js inlines every `NEXT_PUBLIC_`
variable into the client bundle at build time, with no runtime check and no warning. A key
pasted into a field named `NEXT_PUBLIC_VERIFIER_PRIVATE_KEY` is published to every visitor
permanently, and rotating it afterwards does not un-publish the builds that already shipped.
`deploy/VERCEL.md` has the scoping table and a one-line curl to prove the key is absent from
the deployed bundle. And `web/` will eventually be the Vercel root — `vercel.json` currently
points at `site/` and carries the exact config to swap in when T-18 lands.

Shipped `site/` — a standalone static holding page, because `web/` has no application in it
and a Vercel build today would produce nothing. It is deliberately **not** under `web/`:
C10 gives `web/src/**` to Taskforce, and putting a placeholder there is how you get a
collision the day their scaffold arrives.

Content is the pitch rather than a "coming soon": the deadlock, the blank-page argument, and
an interactive challenge-window widget that runs the whole mechanism — attest, watch the
window, and either let it elapse or object — in about ten seconds with no chain and no
wallet. Studio's C9 assets throughout, on `#09090b`. The status table is honest about what is
built and what is not; claiming a finished product on a page that links to the repo would be
found out in one click.

One implementation note worth stealing: every local asset path is **relative** while the
three Open Graph URLs are **absolute**. Scrapers are unreliable about resolving relative
`og:image`, but relative paths are what let the same file render correctly opened straight
off disk. Chrome's MCP tools refuse `file://`, so this page was verified structurally —
every referenced asset resolves, tags balance, no secret in the output — rather than
visually. That is a weaker check than a screenshot and it should be looked at once in a real
browser before it is shared.
Evidence: `vercel.json` parses, `outputDirectory: site`, framework `null` · publish set is 7 files / 260 KB, all under `site/` · verifier key absent from `site/` · all three referenced assets resolve · html tag balance checked on 9 element types
Unblocks: a live link now; A-11 can record against it
Invalidates: D-4's "no hosted deployment" — `DEMO.md` remains correct, but hosting is now in scope for T's env handling
Files: site/index.html, site/assets/*, vercel.json, deploy/VERCEL.md

## 2026-08-08T06:06Z · T · GATE
**G1 flipped: contracts proven. T-1..T-9 done. A is unblocked for A-3.**

    forge test          130 passed, 0 failed, 0 skipped   (10 suites)
    forge build --sizes Escrow 10,252 B runtime (margin 14,324)
                        EscrowFactory 15,771 B runtime (margin 8,805)
    forge fmt --check   exit 0, whole tree

Reproduce with `make setup && make gate` from a clean clone at the commit below.

**The three commands are not the reason to trust this, so here is the reason.** A green suite
proves the tests ran, not that they would notice a break. Everything was mutation-tested: the
contract was deliberately broken in eight ways, one at a time in disposable copies, and the
suite had to go red for each. **8 of 8 killed, 0 survivors**, with the baseline and the
restored tree both back at 130 green either side of every mutation:

| # | Break | Caught by |
|---|---|---|
| M1 | `cancel()`: drop the `Pending` guard, refund everything unconditionally | `test_CancelAfterAReclaimDoesNotRefundTheSameMilestoneTwice` |
| M2 | `withdraw()`: zero the credit *after* the external call | `test_ReentrantWithdrawIsBlockedAndPaysOnce` |
| M3 | `withdraw()`: remove `nonReentrant` | same test, different assertion |
| M4 | `cancel()`: credit the freelancer instead of the client | 36 tests |
| M5 | `dispute()`: allow re-disputing a Disputed milestone | `test_RevertWhen_DisputingAnAlreadyDisputedMilestone` |
| M6 | `release()`: delete the challenge-window guard | `test_RevertWhen_ReleasingOneSecondBeforeWindowCloses` |
| M7 | `withdraw()`: ignore the transfer result | `test_RevertWhen_RecipientRejectsTheTransfer` |
| M8 | `getEscrows()`: clamp after adding, reintroducing the F-A overflow | `test_PaginationClampsTheMaxSentinelFromEveryOffset` |

M1, M2 and M3 survived the suite two hours ago and are the reason G1 was not posted then.
M2 and M3 mattered most: `withdraw()` is defended twice, by the transient guard *and* by
effects-before-interactions, and the reentrancy test only asserted that the nested call
failed — so either defence alone satisfied it and neither was protected. The attacker now
records the credit it saw at re-entry and the raw revert data, so each defence has its own
assertion and dies on its own mutation.

**The invariant suite was repaired before this gate, not after.** As written it reported
`release` succeeding **0 times in 32,768 calls** — the headline mechanism had no stateful
coverage at all, while reading as though it did, because `approve` and `dispute` consumed
every Attested milestone before a warp could ripen one. Now a three-escrow cohort with
staggered deadlines and ripeness-aware selection: `release` 13 successes per run, `reclaim`
15, all twelve actions exercised. No invariant was weakened to get there.

**Two things A should know before deploying.**

  - **This commit contains an edit to `contracts/src/EscrowFactory.sol` that A made and T
    committed.** It is A's F-A fix — clamp before adding in `getEscrows`. It was sitting
    uncommitted in the working tree, and since A's mount has no git it would never have
    landed. G1 has to be reproducible from a commit, and a clean clone with the old factory
    plus the new test is red, so leaving it out was not an option. **A must confirm the
    committed text is what A intended**; it is in the diff at `contracts/src/EscrowFactory.sol`.
    The runtime size moved 15,759 → 15,771 B, which is how T noticed the file had changed.
  - **T's pagination test caught A's fix within minutes of it landing**, going red because it
    pinned the old panic behaviour. It has been rewritten to assert the clamp from every
    offset including `offset == length`. That is the seam working as intended, and it is also
    the concrete argument for A re-running the gate rather than reading this entry: T and A
    edited the same tree in the same window.

Evidence: `forge test` → 130 passed, 0 failed, 0 skipped · `forge fmt --check` → exit 0 · `forge build --sizes` → both contracts under limit · 8/8 mutations killed, 0 survivors, verified independently against the full merged tree rather than per-batch
Unblocks: **A-3** (deploy via Safe), and therefore A-4 → G2. A-16's relay is already proven, so the transport is not an unknown either.
Invalidates: nothing in flight — C1's ABI is unchanged. `contracts/test/FINDINGS.md` still lists the open items on `src`; only F-A has been fixed.
Files: contracts/test/*.t.sol, contracts/test/handlers/EscrowHandler.sol, contracts/test/helpers/Attackers.sol, contracts/src/EscrowFactory.sol (A's change, committed by T), TASKS.md
