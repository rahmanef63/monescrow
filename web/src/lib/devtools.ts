/**
 * The presenter's autofill fixtures, and the latch that reveals them.
 *
 * # What the password is, and — more importantly — what it is not
 *
 * `rahmann` is a **latch**. Its whole job is to stop the panel springing open when somebody
 * brushes the corner of the screen mid-demo. It is **not authentication and must never be
 * described as security**: the string is compiled into a public client bundle and anyone who
 * opens devtools, or reads the JavaScript this page serves, can have it in ten seconds. Writing
 * it here is not a leak, because there is nothing to leak — it guards no secret.
 *
 * That is acceptable for exactly one reason, and the reason is a constraint on every future
 * edit to this file:
 *
 *   **The panel grants no capability the user does not already have.** It types text into forms
 *   that are already on their screen, and copies addresses that are already public. Nothing
 *   more.
 *
 * So, in those terms, and please keep them true:
 *
 *   - it **never signs** anything, and holds no key of any kind;
 *   - it **never bypasses a wallet** — every write in MonEscrow stays the ordinary
 *     simulate → estimate → human click → send flow, signed by whoever holds the wallet;
 *   - it **never calls an API route**, with elevated anything or otherwise;
 *   - it **never touches a server**. This module imports types and nothing else: no `fetch`, no
 *     `process.env`, no clock, no randomness. `src/lib/devtools.test.ts` asserts that by
 *     reading this file's own source, so the property is checked and not merely promised.
 *
 * If a future task seems to need this panel to *do* something — send a transaction, mint a
 * demo escrow, impersonate a party — that is a different feature with a different threat model,
 * and a password baked into a public bundle is not the gate for it. Stop and say so.
 *
 * # Why the fixtures are frozen constants
 *
 * Same brief, same split, same evidence, every single time. A demo that differs between
 * rehearsal and stage is not a rehearsal — there is no clock read here and no random anything,
 * so the tenth run looks exactly like the first.
 */

import type { CheckKind, Criteria, Evidence } from '@/lib/verify/types'

/* ================================================================== the latch */

/**
 * The latch string. Public by construction — see the file header.
 *
 * Exported so the test can prove `unlock` accepts it and nothing else, rather than the test
 * hard-coding a second copy that could drift from this one.
 */
export const DEVTOOLS_PASSPHRASE = 'rahmann'

/** `sessionStorage`, so the latch dies with the tab rather than following someone home. */
const STORAGE_KEY = 'monescrow.devtools.unlocked'

/** Any truthy marker would do; a fixed one keeps the stored value boring to look at. */
const UNLOCKED_MARKER = 'open'

/**
 * The slice of `Storage` this module actually uses.
 *
 * Narrower than the DOM `Storage` type on purpose: a test can stand in a plain object without
 * having to reimplement `length`, `key` and the `[name: string]: any` index signature, and
 * this file cannot quietly grow a dependency on the rest of the API.
 */
type SessionLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * `sessionStorage`, or null where there isn't one.
 *
 * Two ways it can be absent, both expected rather than exceptional: this module is imported on
 * the server during a Next build (no `window`), and some browsers throw on the property access
 * itself when storage is disabled for the origin. Neither is an error to report — the honest
 * consequence is simply that the panel stays latched, which is the safe direction.
 */
function session(): SessionLike | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

/**
 * Length-independent string equality.
 *
 * It changes nothing here — the value it compares is printed in the source file directly above
 * — but comparing a secret-shaped value with `===` is a habit, and the habit is the point. `===`
 * on strings returns the moment the lengths differ or the first byte disagrees, which in a
 * context that *did* hold a secret leaks its length and a prefix. This reads both strings to
 * the end every time and folds the differences into one accumulator.
 */
export function slowEquals(a: string, b: string): boolean {
  const span = Math.max(a.length, b.length)
  // Seeded with the length difference so "same prefix, different length" cannot come out zero.
  let difference = a.length ^ b.length
  for (let i = 0; i < span; i++) {
    // `charCodeAt` past the end is NaN, which is falsy — read as 0 rather than poisoning the fold.
    const left = a.charCodeAt(i) || 0
    const right = b.charCodeAt(i) || 0
    difference |= left ^ right
  }
  return difference === 0
}

/**
 * Try to open the latch. Returns whether it opened.
 *
 * Deliberately exact: no trimming, no case folding. A latch that quietly accepts `" Rahmann "`
 * is a latch whose rule nobody can state, and this one has to be statable in a sentence.
 */
export function unlock(input: string): boolean {
  if (!slowEquals(input, DEVTOOLS_PASSPHRASE)) return false
  session()?.setItem(STORAGE_KEY, UNLOCKED_MARKER)
  return true
}

/** Whether the latch is open for this tab. False wherever there is no session storage. */
export function isUnlocked(): boolean {
  return session()?.getItem(STORAGE_KEY) === UNLOCKED_MARKER
}

/** Close the latch. Closing the tab does the same thing. */
export function lock(): void {
  session()?.removeItem(STORAGE_KEY)
}

/* ================================================================== the fixtures */

/**
 * The demo parties.
 *
 * Anvil's first four deterministic accounts, which is what makes them safe to print: every
 * developer on earth already has these keys, so they hold nothing anybody would miss. They are
 * here so nobody types forty-two hex characters on stage.
 */
export type DemoParty = {
  /** Which side of the escrow this address plays. */
  role: string
  address: `0x${string}`
  /** Where the address comes from, so nobody mistakes it for a real wallet. */
  note: string
}

export const DEMO_ADDRESSES: readonly DemoParty[] = [
  {
    role: 'Client',
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    note: 'anvil account #0 — the wallet that funds the escrow',
  },
  {
    role: 'Freelancer',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    note: 'anvil account #1 — accepts the job and submits the work',
  },
  {
    role: 'Arbiter',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    note: 'anvil account #2 — only ever involved in a dispute',
  },
  {
    role: 'Verifier',
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    note: 'anvil account #3 — proposes that a milestone passed, never decides',
  },
]

export const DEMO_TITLE = 'Coffee roastery marketing site'

export const DEMO_BRIEF =
  'Build a marketing site for a small coffee roastery. I need a landing page, a shop page ' +
  'listing about a dozen beans, a checkout that hands off to Stripe, and the whole thing ' +
  'deployed on a domain I already own. Copy and photos come from me. I want to see something ' +
  'working every couple of weeks rather than one big reveal at the end.'

/** What the presenter types into the job total field, in MON. */
export const DEMO_TOTAL_MON = '6'

/** The same figure in wei. `DEMO_MILESTONES` sums to exactly this — the test says so. */
export const DEMO_TOTAL_WEI = '6000000000000000000'

/**
 * A C3 criteria object for each of the three check kinds.
 *
 * Exactly one block per object and nothing left over: `criteriaHash` is
 * `keccak256(canonicalJson(criteria))`, so an http criteria set still carrying a stale `github`
 * block hashes differently from the identical one built fresh, and the verifier refuses it.
 */
export const DEMO_CRITERIA: Readonly<Record<CheckKind, Criteria>> = {
  clientApproval: {
    v: 1,
    title: 'The client agrees the site is live on their own domain',
    check: 'clientApproval',
  },
  http: {
    v: 1,
    title: 'The staging landing page answers and names the roastery',
    check: 'http',
    http: {
      url: 'https://roastery-demo.example.com',
      expectStatus: 200,
      mustContain: ['Ridgeline Roasters', 'Shop the beans'],
      mustNotContain: ['Application error', 'This page could not be found'],
      timeoutMs: 10_000,
    },
  },
  github: {
    v: 1,
    title: 'The catalogue work is on main and the build check passed',
    check: 'github',
    github: {
      repo: 'ridgeline/roastery-site',
      ref: 'main',
      requireCommit: true,
      requireCheckRun: 'build',
      minStars: null,
    },
  },
}

/**
 * One row of the demo split.
 *
 * Money is carried twice on purpose. `amountMon` is what a human types into the amount field;
 * `amountWei` is what the chain will see. Two representations can drift, so the test asserts
 * they agree through the app's own `parseMon` — and that the wei column sums to `DEMO_TOTAL_WEI`
 * exactly, because `Escrow`'s constructor reverts `FundingMismatch` on a one-wei difference,
 * after the presenter has signed and paid for the gas. On stage.
 */
export type DemoMilestone = {
  title: string
  /** MON, as typed. */
  amountMon: string
  /** wei, as a decimal string. */
  amountWei: string
  check: CheckKind
  criteria: Criteria
  /** Why the split falls this way. Advisory, shown to both parties, never sent on-chain. */
  rationale: string
}

function criteriaFor(check: CheckKind, title: string): Criteria {
  return { ...DEMO_CRITERIA[check], title }
}

export const DEMO_MILESTONES: readonly DemoMilestone[] = [
  {
    title: 'Design direction and landing page',
    amountMon: '1.5',
    amountWei: '1500000000000000000',
    check: 'http',
    criteria: criteriaFor('http', 'The landing page is deployed and names the roastery'),
    rationale:
      'A quarter of the money for the first thing the client can actually look at. Front-loading ' +
      'less than this leaves the freelancer working for weeks on nothing.',
  },
  {
    title: 'Shop page and the bean catalogue',
    amountMon: '2.25',
    amountWei: '2250000000000000000',
    check: 'github',
    criteria: criteriaFor('github', 'The catalogue is on main and the build check passed'),
    rationale:
      'The largest slice, because a dozen products with real copy and photography is the bulk of ' +
      'the build.',
  },
  {
    title: 'Stripe checkout hand-off',
    amountMon: '1.5',
    amountWei: '1500000000000000000',
    check: 'http',
    criteria: criteriaFor('http', 'The checkout route answers and reaches Stripe'),
    rationale:
      'Payments are the risky part and the client wants to see them work before the site is ' +
      'pointed at their domain.',
  },
  {
    title: 'Live on the client’s domain',
    amountMon: '0.75',
    amountWei: '750000000000000000',
    check: 'clientApproval',
    criteria: criteriaFor('clientApproval', 'The client agrees the site is live on their domain'),
    rationale:
      'DNS is the client’s to change, so no automated check can honestly prove this one. A person ' +
      'signs it off.',
  },
]

/**
 * A C4 evidence object for the first milestone.
 *
 * `submittedAt` is a frozen constant rather than `Date.now()` — the hash of this object is what
 * goes on chain, so a fixture that changes every second is a fixture whose hash nobody can
 * quote in a rehearsal.
 */
export const DEMO_EVIDENCE: Evidence = {
  v: 1,
  milestone: 0,
  url: 'https://roastery-demo.example.com',
  repo: 'ridgeline/roastery-site',
  commit: '9f2c1d4e8b7a6053f1c2d3e4b5a69788c0d1e2f3',
  note: 'Landing page deployed, hero copy and the roastery name are live.',
  submittedAt: 1_760_000_000,
}

/* ================================================================== small pure helpers */

/** `/job/0x…` and nothing else. The job route is the only screen with an escrow in its path. */
const ESCROW_IN_PATH = /^\/job\/(0x[0-9a-fA-F]{40})(?:\/.*)?$/

/**
 * The escrow this screen is about, read from the path.
 *
 * Pure, so it can be tested without a router: the component hands it `usePathname()`.
 */
export function escrowFromPath(pathname: string): `0x${string}` | null {
  const match = ESCROW_IN_PATH.exec(pathname)
  if (match === null) return null
  // Rebuilt as a template rather than cast: the pattern already guarantees the `0x` prefix, and
  // re-stating it here is what earns the `0x${string}` type honestly instead of asserting it.
  return `0x${match[1].slice(2)}`
}
