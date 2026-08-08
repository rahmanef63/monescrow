# The ten contracts

These are the seams between workers. Everything else is private to whoever owns the file.

**Rule.** Nobody edits a contract in this file alone. A change here invalidates work already
in flight in two other runtimes, so it costs a message to all three workers and a version
bump. If you think one is wrong, say so before you start, not after.

Status legend: 🔒 frozen · 🟡 draft, first implementer decides · ⬜ not yet specified

---

## C1 🔒 Solidity ABI

Source of truth: `contracts/src/Escrow.sol`, `contracts/src/EscrowFactory.sol`.
Generated types: `web/src/lib/abis.ts` via `npm run gen:abi` (never hand-edited).

External surface anyone may depend on:

```
EscrowFactory
  createEscrow(Escrow.Params p, Escrow.MilestoneInit[] ms) payable returns (address)
  escrows(uint256) / escrowCount() / getEscrows() / getEscrows(offset,limit)
  escrowsOf(address) / escrowCountOf(address) / isEscrow(address)
  event EscrowCreated(address indexed escrow, address indexed client,
                      address indexed freelancer, uint256 totalAmount,
                      uint256 milestoneCount, uint256 index)

Escrow
  accept() / cancel()
  submit(uint256 i, bytes32 evidenceHash)
  attest(uint256 i, uint32 submission, bool passed, bytes32 reportHash, bytes signature)
  approve(uint256 i) / release(uint256 i) / dispute(uint256 i)
  resolveDispute(uint256 i, bool toFreelancer) / reclaim(uint256 i)
  withdraw()
  milestones() / milestoneAt(uint256) / milestoneCount()
  releasableAt(uint256) / challengeRemaining(uint256)
  summary(address account) returns (Summary)
  attestationDigest(uint256,uint32,bool,bytes32,bytes32) returns (bytes32)
```

State machine per milestone: `Pending → Submitted → Attested → Released`, with
`Disputed` reachable from Submitted/Attested and `Refunded` from Disputed/deadline-reclaim.

**Who may call what** — the UI must not offer an action the chain would reject:

| Action | Caller | Precondition |
|---|---|---|
| `accept` | freelancer | not accepted, not cancelled, before deadline |
| `cancel` | client | not yet accepted |
| `submit` | freelancer | accepted, before deadline, state Pending/Submitted |
| `attest` | anyone | state Submitted, `submission` matches, valid verifier signature |
| `approve` | client | state Submitted or Attested |
| `release` | anyone | state Attested and challenge window elapsed |
| `dispute` | client | state Submitted or Attested |
| `resolveDispute` | arbiter | state Disputed |
| `reclaim` | client | after deadline, state Pending or Submitted |
| `withdraw` | anyone owed | `owed[msg.sender] > 0` |

---

## C2 🔒 Attestation payload (EIP-712)

Shared by the contract, the verifier, and the frontend. Get one character wrong and
signatures silently fail to recover.

```
domain = { name: "MonEscrow", version: "1", chainId: 10143, verifyingContract: <escrow> }

Attestation(uint256 milestone,uint32 submission,bool passed,bytes32 evidenceHash,bytes32 reportHash)
```

The domain pins the chain and the specific escrow, so an attestation cannot be replayed
onto another job or another network. `submission` and `evidenceHash` pin it to one exact
submission, so a stale pass dies the moment the freelancer resubmits.

Anyone may relay a signed attestation — the signature is the authority, not `msg.sender`.
Verify against `Escrow.attestationDigest(...)`, which exists precisely so the off-chain
signer and any reviewer can reproduce the digest byte-for-byte.

---

## C3 🔒 Criteria JSON — what `criteriaHash` commits to

Written by the frontend at creation, read by the verifier, hashed into the contract. Both
parties see it before signing; neither can change it afterwards.

```jsonc
{
  "v": 1,
  "title": "Deployed and reachable",
  "check": "http",                    // "http" | "github" | "clientApproval"
  "http": {
    "url": "https://demo.example.com",
    "expectStatus": 200,
    "mustContain": ["Sign in with Google"],   // matched against rendered text
    "mustNotContain": [],
    "timeoutMs": 15000
  },
  "github": {
    "repo": "owner/name",
    "ref": "main",
    "requireCommit": true,
    "requireCheckRun": "build",       // check-run name that must conclude "success"
    "minStars": null
  }
}
```

`criteriaHash = keccak256(utf8(JSON.stringify(criteria)))` with **keys in the order above**
and no whitespace. Use the shared `canonicalJson()` helper — do not hand-roll it, key order
changes the hash.

Only the block matching `check` is required; omit the other.

---

## C4 🔒 Evidence JSON — what `evidenceHash` commits to

Submitted by the freelancer.

```jsonc
{
  "v": 1,
  "milestone": 0,
  "url": "https://demo.example.com",
  "repo": "owner/name",
  "commit": "abc123...",
  "note": "Deployed to Vercel, OAuth configured",
  "submittedAt": 1800000000
}
```

`evidenceHash = keccak256(utf8(canonicalJson(evidence)))`.

---

## C5 🔒 Report JSON — what `reportHash` commits to

Produced by the verifier. Stored off-chain; only its hash goes on-chain, so the report is
tamper-evident without paying to store it.

```jsonc
{
  "v": 1,
  "escrow": "0x...",
  "milestone": 0,
  "submission": 1,
  "evidenceHash": "0x...",
  "criteriaHash": "0x...",
  "passed": true,
  "checkedAt": 1800000123,
  "checks": [
    { "id": "http.status",   "label": "HTTP 200",              "passed": true,  "detail": "200 in 412ms" },
    { "id": "http.contains", "label": "Sign in with Google",   "passed": true,  "detail": "found" },
    { "id": "gh.commit",     "label": "Commit exists",         "passed": false, "detail": "404" }
  ]
}
```

`passed` is true only if **every** check passed. No partial credit — a 94% score is not a
thing the contract understands.

---

## C6 🟡 Verifier HTTP API

```
POST /api/verify
  body  { escrow, milestone, submission, criteria, evidence }
  200   { report, reportHash, signature, digest }
  422   { error, report }        // checks ran, milestone failed
  400   { error }                // malformed input
  502   { error }                // a target was unreachable; not a fail, a retry
```

**422 and 502 must not be conflated.** "The site returned 500" is a failing milestone;
"we could not reach the site" is our problem, not the freelancer's, and must not be signed
as a failure.

The signature is over C2 using `VERIFIER_PRIVATE_KEY`. The route never broadcasts a
transaction — it returns the signature and lets the caller pay the gas.

---

## C7 🟡 AI brief → milestones (BYOK)

```
POST /api/ai/milestones
  headers  x-llm-key: <user API key>       // optional; memory only, never persisted
  body     { brief: string, totalAmount: string, currency: "MON" }
  200      { milestones: MilestoneDraft[], source: "llm" | "template" }
```

```ts
type MilestoneDraft = {
  title: string
  amount: string              // wei, as a decimal string
  check: "http" | "github" | "clientApproval"
  criteria: Criteria          // C3 shape, minus the hash
  rationale: string           // shown to both parties before they sign
}
```

Credential resolution order, and this order is the contract:

1. `x-llm-key` header supplied by the user for this one request — held in memory, never
   written to disk, never logged, never echoed back
2. `ANTHROPIC_API_KEY` from server env, for self-hosting
3. deterministic template parser — **must always work with no credentials at all**

Rule 3 is not a nicety. The demo has to run on a judge's machine with no key.

OAuth is an extension point, not a v1 feature: `getCredential()` returns
`{ kind: "api-key" | "oauth", value }` so a provider that offers OAuth can slot in without
touching call sites. Do not stub a fake OAuth flow.

Amounts returned by the LLM are **advisory**. The UI must let both parties edit every
amount and every criterion before anything is signed, and the sum is re-checked client-side
against the total.

---

## C8 🔒 Environment variables

| Name | Scope | Owner | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_FACTORY_ADDRESS` | client | Alfa | set at integration |
| `NEXT_PUBLIC_MONAD_TESTNET_RPC` | client | Alfa | defaults to the public RPC |
| `NEXT_PUBLIC_VERIFIER_ADDRESS` | client | Alfa | UI shows who signed |
| `NEXT_PUBLIC_PARA_API_KEY` | client | Alfa | empty ⇒ injected-wallet fallback |
| `VERIFIER_PRIVATE_KEY` | **server only** | Alfa | never `NEXT_PUBLIC_`, never committed |
| `MONAD_RPC_URL` | **server only** | Alfa | the verify route's own RPC — *added 2026-08-08* |
| `NEXT_PUBLIC_SITE_URL` | client | Alfa | this app's public origin; now explicit for Convex — *added 2026-08-08* |
| `NEXT_PUBLIC_CONVEX_URL` | client | Alfa | Convex deployment, `*.convex.cloud` — *added 2026-08-08* |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | client | Alfa | Convex HTTP actions, `*.convex.site` — *added 2026-08-08* |
| `CONVEX_DEPLOY_KEY` | **server only** | user | never `NEXT_PUBLIC_`, never committed — *added 2026-08-08* |
| `GITHUB_TOKEN` | server only | Taskforce | optional; raises the rate limit |
| `ANTHROPIC_API_KEY` | server only | user | optional; BYOK header wins |

**Amendment, 2026-08-08.** The two rows marked *added* were found in the code during a Vercel
env audit and were not in this table. `MONAD_RPC_URL` is the more interesting one:
`/api/verify` needs an RPC to run its onchain binding check, and C8 originally offered only
`NEXT_PUBLIC_MONAD_TESTNET_RPC`. Taskforce used a server-side variable instead, which is
right — the verifier's endpoint is not the browser's, and a server route should never read a
`NEXT_PUBLIC_` value. C8 is amended to match the code rather than the code bent back to C8.
Missing either one is not a build failure: env is read inside the handler, so the route
returns a named **502** and the rest of the app is unaffected.

**Convex amendment, 2026-08-08.** C3, C4 and C5 all say their documents live off-chain with
only a keccak hash on-chain — and until now *nothing actually stored them*. Convex fills that
hole, and that is the whole of its remit.

**What Convex is explicitly not for: listing escrows.** `EscrowFactory` maintains its own
onchain index (`escrows`, `escrowsOf`, `getEscrows`) for the stated reason that a frontend
should enumerate jobs with plain `eth_call`s — no indexer, no backend. If the job list ever
starts reading from Convex, the product has acquired a backend it cannot justify and the
"turn our servers off and your escrow still works" claim stops being true. A useful test: with
the Convex deployment paused, every job must still list and every milestone must still be
releasable. Only the human-readable criteria/evidence/report text should degrade.

Anything without `NEXT_PUBLIC_` must never be read from a client component. `.env.example`
is committed; `.env.local` never is.

---

## C9 🔒 Asset manifest

Studio delivers exactly these paths, names and sizes. The frontend imports them by path —
a renamed file is a broken build.

| Path | Size | Format | Use |
|---|---|---|---|
| `assets/brand/logo.svg` | vector | SVG | header |
| `assets/brand/logo-mark.svg` | vector, 1:1 | SVG | favicon source |
| `assets/brand/favicon.png` | 512×512 | PNG | `web/src/app/icon.png` |
| `assets/social/og.png` | 1200×630 | PNG | Open Graph |
| `assets/empty/no-jobs.png` | 800×600 | PNG, transparent | empty campaign list |
| `assets/empty/awaiting-freelancer.png` | 800×600 | PNG, transparent | unaccepted escrow |
| `assets/deck/*.png` | 1920×1080 | PNG | pitch deck |

Palette and type live in `docs/04-CHATGPT.md`. Dark background is the default surface —
every transparent asset must read on `#09090b`.

---

## C10 🔒 Working agreement

**One owner per path.** Two agents editing one file is the failure mode that costs a whole
evening.

| Path | Owner |
|---|---|
| `contracts/src/**` | Alfa (frozen — changes go through Alfa) |
| `contracts/test/**` | Taskforce |
| `web/src/lib/**`, `web/src/app/api/**` | Taskforce |
| `web/src/components/**`, `web/src/app/**` (pages) | Taskforce |
| `assets/**` | Studio |
| `deploy/**`, `docs/**`, `README.md` | Alfa |

Branches: `tf/<topic>` for Taskforce, `alfa/<topic>` for Alfa, `studio/assets` for Studio.
Merge into `main` only with the relevant gate green.

**Definition of done**, same for everyone: it builds, it is covered by something that fails
when it breaks, and the next person can run it from a clean clone with only `.env.example`.
