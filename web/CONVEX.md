# Convex readiness — the plan, not the wiring

Status: **plan only.** No dependency added, no file changed. `NEXT_PUBLIC_CONVEX_URL` is empty
in `web/.env.example`, the deployment does not exist, and the house rule is not to add a
dependency or invent an abstraction before there is a concrete consumer to shape it. The shape
is worked out here; the code lands when the URLs do.

Scope is fixed by the C8 Convex amendment in `docs/01-INTERFACES.md`: Convex holds the three
documents C3, C4 and C5 commit to by hash, and nothing else. **It is explicitly not for listing
escrows.** With the deployment paused, every job must still list and every milestone must still
be releasable; only the human-readable text degrades.

---

## 1. What is missing today

One milestone, start to finish, naming every point a document is created, needed, or lost.

### Creation — the criteria (C3)

`web/src/app/new/page.tsx` builds each milestone's `criteria` object in React state (edited in
`web/src/components/MilestoneEditor.tsx`). At line 387 it computes

```ts
criteriaHash: hashJson(m.criteria)     // new/page.tsx:387
```

into the `createEscrow` args, and at line 391 folds the title, the brief and every criterion
into a `termsHash`. The transaction carries **only** those hashes. When the tab is closed the
criteria JSON is gone.

- Who has it: the client's browser, for the length of one form session.
- Where it goes: nowhere. Not to the freelancer, not to the verifier, not to the arbiter.
- The `brief` is worse: it is committed inside `termsHash` and has no preimage anywhere at all.

### Submission — the evidence (C4)

`Escrow.submit(uint256 i, bytes32 evidenceHash)` (`web/src/lib/abis.ts:626`) is the on-chain
half. The off-chain half does not exist:

- `MilestoneCard`'s `specsFor('submit')` returns `request: null` with an `unbuildable` sentence
  pointing at "the assistant or the submit flow" (`web/src/components/MilestoneCard.tsx:285`).
- `ChatSheet`'s `callForCard('submit')` returns `needs:` pointing back at the job page —
  "that screen hashes your evidence" (`web/src/components/ChatSheet.tsx:134`).

Those two point at each other. **There is no submit form in the tree**, so evidence is missing
twice over: nothing creates it and nothing stores it. This is out of scope for the Convex work —
see "Found on the way through" at the bottom — but it means the evidence write has no hook to
attach to yet, and the plan below says where it goes when one appears.

### The check — the report (C5)

`POST /api/verify` (`web/src/app/api/verify/route.ts`) receives `{ escrow, milestone,
submission, criteria, evidence }` in the request body. `assertBound` re-hashes the two documents
and compares them to `milestoneAt(i)` (`web/src/lib/verify/bind.ts:81`); `buildReport` folds the
observations into `{ report, reportHash }` (`web/src/lib/verify/report.ts:52`); the handler
returns them to the caller (route.ts:188 for a pass, route.ts:165 for a 422).

**Nothing persists any of the three.** The criteria and evidence arrive in a request body and
are dropped when it ends. The report is handed to one HTTP caller once. The 422 report — the one
the freelancer most needs to read, because it names the failing line — is dropped identically.

And nothing in `web/src` calls `/api/verify` at all: there is no fetch to it anywhere in the
tree. So today even the caller that would receive the report is missing.

### Display — the job page

`fromChain()` in `web/src/app/job/[address]/page.tsx:511` maps the chain read onto `MilestoneRow`
and hard-codes the three:

```ts
// Off-chain, and this page has no store for them yet. The card says so rather than
// rendering a confident blank.
criteria: null,     // page.tsx:524
evidence: null,
report: null,
```

`MilestoneCard` already renders both branches for all three sections — text when present
(lines 559–577, 579–640, 642–714), and an honest "the chain stores only a hash" paragraph plus
the hash itself when absent. The sample job (`sampleJob`, lines 133–451) fills all three, so
what the page looks like *with* a store wired up is already built and already reviewed.

### Summary

| Document | Created where | Held by | Committed on-chain as | Where it goes today |
|---|---|---|---|---|
| Criteria (C3) | `/new` form state | client's browser tab | `criteriaHash` in `createEscrow` args, and inside `termsHash` | discarded on navigation |
| Brief | `/new` textarea | client's browser tab | inside `termsHash` | discarded; no preimage exists anywhere |
| Evidence (C4) | **nowhere — no submit form** | nobody | `evidenceHash` arg of `Escrow.submit` | n/a |
| Report (C5) | `buildReport` inside `/api/verify` | one HTTP response | `reportHash` inside the C2 attestation payload (and the `AttestationPassed` / `AttestationFailed` events) | returned, then dropped |

---

## 2. The smallest seam

One interface, injected, with an implementation that answers "absent" honestly — the same shape
as `CredentialStore` in `web/src/lib/models/store.ts`.

### `web/src/lib/documents/store.ts`

```ts
export type DocKind = 'criteria' | 'evidence' | 'report'

/**
 * Four outcomes, and they are four different facts. Collapsing any two into `null` is the
 * single mistake that makes §3 unimplementable.
 */
export type Fetched<T> =
  | { status: 'found'; value: T }
  /** The store answered and holds nothing under this hash. Nobody ever stored it. */
  | { status: 'absent' }
  /** The store did not answer: paused, unreachable, timed out. Ours, and retryable. */
  | { status: 'unavailable'; detail: string }
  /** No store is configured at all. Nothing was asked. */
  | { status: 'unconfigured' }
  /** Something came back and it does not hash to the on-chain commitment. See §4. */
  | { status: 'mismatch'; expected: string; actual: string }

export type DocumentStore = {
  /** Never throws — every failure is one of the statuses above. */
  get<T>(kind: DocKind, hash: string): Promise<Fetched<T>>
  /** Best-effort. A failed write is never allowed to fail the caller's flow. */
  put(kind: DocKind, hash: string, value: unknown): Promise<{ stored: boolean }>
}
```

Three implementations, mirroring `store.ts`'s two:

| Function | Behaviour |
|---|---|
| `convexDocumentStore(url)` | the real one; returns `unconfigured` for itself if `url` is empty |
| `absentDocumentStore()` | always `{ status: 'unconfigured' }` — today's behaviour, exactly |
| `memoryDocumentStore(docs)` | tests; nothing reads env, nothing opens a socket |

**Documents are addressed by their own hash, not by `(escrow, milestone)`.** That single choice
does most of the security work: a lookup asks for the hash the chain committed, so a superseded
document is simply not found rather than silently returned in place of the current one, and
"store a different criteria for milestone 2" is not an operation the key space can express.
`escrow` and `milestone` go in the row as metadata for debugging, never as the key.

### Where it plugs in — three points, each small

**(a) Read, on the job page.** `fromChain()` (`page.tsx:511`) stops hard-coding three nulls and
takes them from a new hook, `useMilestoneDocuments(escrow, milestones)`, in
`web/src/lib/documents/useDocuments.ts`. `MilestoneRow`'s three fields widen from `T | null` to
`Fetched<T>`, and `MilestoneCard`'s props widen the same way; the existing "absent" prose becomes
one branch of four.

The document query is a **second, independent** query. It never joins the `useReadContracts` call
at `page.tsx:660` and is never `Promise.all`-ed with it. The page renders completely — parties,
amounts, countdown, every button — before the documents resolve or fail. That independence *is*
the C8 guarantee; it is not an optimisation.

**(b) Write at creation.** `useTxFlow` already exposes `onSuccess(hash)`
(`web/src/lib/useTxFlow.ts:460`), surfaced as a `TxButton` prop
(`web/src/components/TxButton.tsx:49`). After the `createEscrow` receipt lands, `put('criteria',
hashJson(m.criteria), m.criteria)` for each milestone, plus the terms document under `termsHash`.
Wrapped in a swallowing `try` — the escrow exists and is funded; a store that refused the text is
a degraded read later, not a broken job now, and must never surface as a failed transaction.

Because documents are hash-keyed, this write does **not** need the new escrow address and so does
not need to decode `EscrowCreated` from the receipt logs. The address is metadata; write it if
it is to hand, skip it if not.

**(c) Write after a check.** Add one optional field to `VerifyDeps`
(`web/src/app/api/verify/route.ts:71`):

```ts
/** Optional. Absent means today's behaviour exactly: the report is returned and not kept. */
docStore?: DocumentStore
```

and one best-effort call after `buildReport` (route.ts:153), **for both the 200 and the 422**:
the failing report is the one worth reading. It runs after the report is built and never before
signing, it is inside a `try {} catch {}`, and it cannot change the status code. `POST` composes
the real store from `process.env.NEXT_PUBLIC_CONVEX_URL` the same way it already composes
`rpcUrl` (route.ts:230) — inside the handler, never at module scope.

Every existing verify test passes unchanged (`docStore` undefined = current behaviour); one new
test uses `memoryDocumentStore` and asserts that a store which throws still yields a 200.

**Evidence writes** have nothing to attach to until a submit form exists. When it does: the same
`TxButton onSuccess`, `put('evidence', hashJson(evidence), evidence)`, same swallowing try.

### Why no `/api/documents` route

A Next route in front of reads would put our own server back on the read path — the exact thing
C8 says the product cannot depend on. The browser talks to Convex directly with the public URL.
The one server-side touch is a *write* inside `/api/verify`, and the app is unaffected when it
fails.

---

## 3. When Convex is absent or paused

This is a requirement, not a degradation to apologise for. Four states, and **"nothing was
stored" and "the store is unreachable" must never render as the same sentence.**

| State | How it is reached | "What was agreed" | "What the freelancer submitted" | "What the verifier reported" |
|---|---|---|---|---|
| `unconfigured` | `NEXT_PUBLIC_CONVEX_URL` empty | the existing paragraph, kept verbatim: "…this page has no store wired up to fetch it." + `criteriaHash` | the existing paragraph + `evidenceHash` | the existing Submitted-state paragraph |
| loading | query pending | "Looking up the agreed wording…" + hash | "Looking up the submission…" + hash | leaves the state paragraph in place |
| `absent` | store answered, no row | "Nobody stored the wording of these criteria. What is on-chain is still binding — the hash is what both parties signed — but the text itself was never handed to the store." + hash | "The submission's hash is on-chain; the description behind it was never stored." + hash | "No report was stored for this attestation." |
| `unavailable` | paused, DNS failure, timeout | "The off-chain store did not answer, so the wording cannot be shown right now. This is our lookup failing, not a missing agreement — reload to try again." + hash | same wording, for the submission | same wording, for the report |
| `mismatch` | hash check failed | see §4 — tampered or superseded, and the text is **not** rendered | ditto | ditto |

A pending query never blocks the hash line: the commitment is available from the chain read and
should be on screen from the first paint.

### What must keep working with the deployment paused

- **`/` — the job list.** `readMyJobs` (`web/src/components/JobCard.tsx:937`) reads `escrowsOf`,
  `summary`, `milestones` and `releasableAt`, and nothing else. **No file on the listing path may
  import from `lib/documents/`.**
- **`/job/0x…` above the milestones** — title, parties, amounts, deadline, challenge-window
  countdown — all from `useReadContracts` at `page.tsx:660`.
- **Every action button.** `permits()` (`web/src/lib/chat/permissions.ts`) takes an
  `ActionContext` of role, milestone state, clock, deadline, `releasableAt` and `owed`. No
  document is an input to it and none may become one. In particular a stranger releasing an
  attested milestone after its window still works with the store down — that is the product's
  central claim.
- **`/api/verify`** still returns 200 with a signature; the store write is best-effort.

### The C8 test, spelled out

Pause the Convex deployment, then check three things:

1. `/` lists every job for the connected wallet.
2. An Attested milestone past its challenge window releases from a wallet that is not a party.
3. Each milestone card shows the "did not answer" sentence **and** its on-chain hash — not the
   "nobody stored it" sentence, and not a blank.

Item 3 is the one that will silently regress. A `catch` that returns `absent` on error is the bug
that would make this whole design lie about what it knows.

---

## 4. Integrity

The hash is on-chain. A fetched document is re-hashed with `canonicalJson` and compared before
anything is displayed. A document that does not match is shown as **tampered or superseded** and
is never rendered as if it were the agreement.

### Where the check lives

`web/src/lib/documents/verify.ts`, one function, called **inside the store's `get`** before it
returns — not by the component, and not by the hook.

```ts
export function checkAgainstHash<T>(value: unknown, expected: string): Fetched<T>
```

implemented as `hashJson(value)` from `web/src/lib/verify/report.ts`
(`keccak256(stringToBytes(canonicalJson(value)))`) compared case-insensitively, exactly like
`hexEq` in `web/src/lib/verify/bind.ts:178`. Putting it in `get` means every consumer receives a
checked value: a check a caller can forget is a check that will be forgotten.

Note where this runs: **in the reader's browser**, because the browser fetches from Convex
directly. Our server never sits between the document and the person checking it. That is what
makes the check worth anything.

### Which hash, per kind

- **criteria** → `milestoneAt(i).criteriaHash`, already surfaced as `MilestoneRow.criteriaHash`
  (`page.tsx:520`) and already filtered by `meaningfulHash` so an all-zero commitment reads as
  `null` rather than as sixty-four zeroes.
- **evidence** → `milestoneAt(i).evidenceHash` (`page.tsx:521`).
- **report** → **not in the `Milestone` struct.** Check `lib/abis.ts`: the struct is `amount`,
  `check`, `state`, `submissions`, `attestedAt`, `criteriaHash`, `evidenceHash` (the same list
  `bind.ts:234` transcribes). `reportHash` appears only in the `attest` inputs (abis.ts:180), in
  `attestationDigest` (abis.ts:213), and in the `AttestationPassed` / `AttestationFailed` events
  (abis.ts:833, 858). **There is no `eth_call` that returns it.** The implementer must resolve
  this; the options are:

  1. **One `eth_getLogs` scoped to this escrow address**, filtered to the two attestation topics,
     on the job page only. This is a single-address log query on a contract we already know the
     address of — not an indexer, not a scan of the chain — and it stays within "plain RPC". It
     must never appear on the listing path. Recommended.
  2. Cross-check the report's own fields against the chain — `report.escrow`, `report.milestone`,
     `report.submission`, `report.evidenceHash`, `report.criteriaHash` — which is cheap and needs
     no log. **But it proves relevance, not authenticity**: a differently-worded report carrying
     the same hashes would pass. Use it as a pre-filter, never as the check.
  3. Display the report unverified. Not acceptable under this section.

  If the log query fails, the report cannot be verified, so it is not rendered as the verifier's
  report — it takes the `unavailable` branch.

  A useful trick: the store row may carry the attestation **transaction hash** as a hint for
  locating the log. That hint is untrusted and is used only to find the log; the log itself is
  what proves the hash. An untrusted pointer to a trusted verification is fine.

### Rendering a mismatch

Never the document. Show:

> The stored text does not match the hash committed on-chain. It has either been altered in the
> store or replaced by a later version. Only the commitment can be trusted here.

plus both hashes — the on-chain one and the one the fetched text produced — so the discrepancy is
inspectable rather than merely asserted.

Two adjacent cases already handled, and they should stay separate from `mismatch`:

- **A superseded report** for an older submission is already caught structurally:
  `milestone.submissions > report.submission` produces "the freelancer has submitted again since"
  (`MilestoneCard.tsx:701`). Hash-addressed lookup means we would not fetch it in the first place;
  keep the sentence for the case where we do.
- **No commitment at all** — `meaningfulHash` returns `null` for an all-zero hash. There is
  nothing to check a document against, so a document must not be displayed even if one somehow
  comes back. No hash, no render.

---

## 5. What could go wrong

**The deploy key.** `CONVEX_DEPLOY_KEY` is server/CI only and `.env.example` already says so at
length. The failure mode to watch for at implementation: somebody adds it to a client component
to "make the writes from `/new` work". The creation write goes browser → Convex over the public
URL and a public mutation; if it appears to need the deploy key, the authorisation design is
wrong, not the key placement. Next.js inlines every `NEXT_PUBLIC_*` at build time and a published
key cannot be un-published from builds that already shipped.

**Write authorisation — who may store a document for an escrow they are not party to.** Convex
mutations are public endpoints; anyone with the URL can call one. Three defences, cheapest first:

1. **Content-addressed, content-checked writes.** The mutation recomputes
   `keccak256(canonicalJson(doc))` server-side and stores under *that* key, rejecting any write
   whose claimed hash disagrees. Forgery becomes pointless: an attacker can only ever store a
   document under the hash it actually has, and a reader only ever asks for the hash the chain
   committed. Make it **insert-only** — if the key exists, no-op — so overwrite and deletion are
   not operations either. Recommended for v1.
2. Have the mutation read `milestoneAt(i)` over RPC and refuse a hash the chain does not carry.
   Strictly stronger (it stops junk rows entirely) but it puts an RPC call in the write path and
   an RPC URL in Convex's env. Probably not v1.
3. A wallet signature over the document. Overkill — (1) already makes forgery useless, and this
   would put a signing prompt in the middle of job creation.

  Caveat on (1): it needs keccak inside a Convex function. Convex runs V8 and viem's keccak
  (`@noble/hashes`) should work there with no native dependency — **verify this before committing
  to the design**, because the whole authorisation argument rests on it.

**Two implementations of `canonicalJson`.** The Convex-side hash check must use the same
algorithm as `web/src/lib/canonicalJson.ts`, which sorts keys lexicographically — a documented,
deliberate deviation from C3's stated key order (see the header comment, lines 8–15). A copy in
`convex/` is a second implementation that can drift, which is precisely the failure that file
exists to prevent. Share the module if the Convex directory can reach it; if it genuinely cannot,
copy it *with* a test that asserts both produce byte-identical output over a fixture set.

**Size limits.** Convex caps a document at roughly 1 MiB and function arguments rather higher —
**check the current numbers against the docs rather than trusting these.** C3/C4/C5 are all tiny:
criteria is a few hundred bytes, a report is one line per check. Cap writes well below the
platform limit (32 KiB is generous) and reject at **write** time, so a document that cannot be
stored is discovered when it is created rather than when somebody tries to read it. Do not let
an evidence `note` be unbounded — `lib/chat/tools.ts:713` already caps counterparty free text per
field for the prompt path, and the store should not become the way around that.

**Junk rows.** Anyone can fill the table with unreferenced documents. It is survivable: an
unreferenced row is unreadable, because nobody knows a hash to ask for that is not already on the
chain. Cap the size, rate-limit the mutation, and accept it.

**Untrusted text arriving from a new direction.** Fetched documents are counterparty-written.
`MilestoneCard` already labels an evidence note "their words, not ours" (line 620), and anything
reaching the model must pass `fenceUntrusted` (`lib/chat/tools.ts:809`). `createChainReader` in
`app/api/chat/route.ts:811` sets `untrusted: { title: s.title, notes: [] }` with a comment saying
a store attaches here when one appears (route.ts:738) — that is the *only* place fetched evidence
notes may enter the chat path.

**Can any of this end up on the listing path by accident?** Yes, three ways, all preventable:

1. `readMyJobs` (`components/JobCard.tsx:937`) gaining a document fetch so cards can show real
   milestone titles instead of "Milestone 1". Tempting, and it would put a Convex round-trip in
   front of the job list. If titles on cards are wanted, they fill in *after* the card renders
   and never gate it.
2. A shared `useJob` hook that awaits chain and documents together. Keep the document query
   separate, with its own loading state.
3. `app/page.tsx`'s empty-state branching (`no-factory` and friends, page.tsx:228) growing a
   document-availability case.

  **This is already enforced.** `web/src/lib/architecture.test.ts` is a fitness test over the
  module graph: nothing reachable from the listing entry points may import Convex or read
  `NEXT_PUBLIC_CONVEX_*`, those entry points must still reach the chain, and none of them may
  fetch one of our own API routes for their data. Read its header before wiring anything — it
  says what to do when it goes red, and the answer is never to relax it. The practical
  consequence for this plan: `useMilestoneDocuments` must live behind a module the listing path
  does not statically import.

**Paused vs. deleted.** A paused deployment errors on query; a deleted one fails DNS. Both are
`unavailable`, never `absent`. Stated again here because it is the same bug as §3 item 3 and it
is the one that would quietly break the honesty of the whole thing.

---

## Found on the way through — not fixed, not in scope

- **No submit flow exists.** `MilestoneCard.tsx:285` sends the reader to "the assistant or the
  submit flow"; `ChatSheet.tsx:134` sends them back to the job page. Neither screen collects
  evidence, so a freelancer cannot call `Escrow.submit` from this app at all. Convex cannot store
  evidence that is never created.
- **Nothing calls `/api/verify`.** There is no fetch to it anywhere in `web/src`, so the "Run
  check" step of the demo has no button. `ATTEST_REFUSAL` in `lib/chat/tools.ts` tells the user to
  "run the checker from the milestone page", and that screen has no checker either.
- **`termsHash` commits to the brief, which is stored nowhere.** Even with Convex wired for
  C3/C4/C5, `termsHash` stays unverifiable unless the terms document is stored too. Cheap to add
  at the same seam — plan (b) above includes it — but worth deciding deliberately rather than by
  omission.
