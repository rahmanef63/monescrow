/**
 * C6 — `POST /api/verify`. The composition layer, and nothing more.
 *
 * Everything with an opinion lives in `src/lib/verify/`: `bind.ts` decides whether the request
 * refers to what is actually on-chain, `checks/*` decide what was observed, `report.ts` folds
 * observations into `passed`, `sign.ts` turns that into an EIP-712 signature. This file parses,
 * orders those calls, and maps their results onto the four status codes C6 allows. It adds no
 * judgement of its own — a route that starts deciding things is a route that can widen what a
 * verifier signature means, and the whole design rests on that meaning staying narrow.
 *
 * What a 200 from here means, stated honestly: *at `checkedAt`, the criteria committed on-chain
 * were run against the evidence committed on-chain, and every observation they produced passed.*
 * The observations are weak on purpose — an HTTP 200 is satisfied by a blank page, and a green
 * check run is satisfied by a workflow that runs `exit 0`. That is why the signature only opens
 * a challenge window: the client still gets to look and object, and if they do, the milestone
 * freezes for an arbiter. This endpoint proposes. It never decides.
 *
 * Three invariants this file exists to hold:
 *
 *  1. **Bind before fetch.** `assertBound` runs before any check, so a caller whose criteria are
 *     not the ones on-chain gets a 400 and we never open a socket to their URL. Skipping this
 *     would make a public verifier double as an unauthenticated request proxy aimed at anything
 *     on the internet — including whatever is reachable from inside our own network.
 *
 *  2. **422 is the freelancer's, 502 is ours.** A check that ran and failed is signed-off as a
 *     failing milestone (well — returned as one; see below). A target we could not reach is a
 *     retry, never a milestone result. Recording our own DNS trouble on-chain as somebody's work
 *     being incomplete is the single worst bug this service can have, so every path that is not
 *     definitely an observation resolves to 502.
 *
 *  3. **Nothing but a pass is ever signed.** 400, 422 and 502 responses carry no signature at
 *     all. A failing attestation is a no-op on-chain, so signing one buys nothing and creates a
 *     second signed artifact to reason about.
 *
 * No transaction is ever broadcast from here. The caller gets a signature and pays their own gas,
 * which is what lets an honest freelancer post their own passing result without asking us.
 *
 * BYOK: the request body is never logged, the verifier key is never logged, never returned, and
 * never quoted in an error — not even by name-and-value in a "misconfigured" message.
 */

import { isAddress } from 'viem'
import { runGithubCheck } from '../../../lib/verify/checks/github'
import { runHttpCheck } from '../../../lib/verify/checks/http'
import { assertBound, bindFailureStatus, describeBindFailure } from '../../../lib/verify/bind'
import type { MilestoneReader } from '../../../lib/verify/bind'
import { makeRpcMilestoneReader } from '../../../lib/verify/bind'
import { buildReport, hashJson } from '../../../lib/verify/report'
import { loadVerifierKey, signAttestation } from '../../../lib/verify/sign'
import type {
  CheckKind,
  CheckOutcome,
  CheckResult,
  Criteria,
  Evidence,
  FetchImpl,
  Report,
} from '../../../lib/verify/types'

/** viem's `privateKeyToAccount` needs node crypto; also nothing here belongs on a cached edge. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Everything the handler is allowed to touch from the outside world.
 *
 * A parameter bag rather than module-level config so that (a) nothing reads `process.env` or
 * captures a key at import time, and (b) the tests exercise the real decision logic with fakes
 * instead of a mocked-out module. `POST` is the only place that builds the real ones.
 */
export type VerifyDeps = {
  /** Injected so no check ever reaches the network under test. */
  fetchImpl: FetchImpl
  /** Reads the four on-chain facts `assertBound` compares against. */
  readMilestone: MilestoneReader
  /** The verifier's secp256k1 key. Passed in, never read from env in here, never logged. */
  verifierKey: string
  /** Milliseconds, `Date.now`-shaped. One clock serves both `checkedAt` and check timings. */
  now: () => number
  /** Optional GitHub credential. Raises what a github check can see; never enters a report. */
  githubToken?: string
  /** Defaults inside `sign.ts` to Monad testnet. Explicit only so a test can pin it. */
  chainId?: number
}

export type VerifyResult =
  | {
      status: 200
      body: {
        report: Report
        reportHash: `0x${string}`
        signature: `0x${string}`
        digest: `0x${string}`
      }
    }
  /** Checks ran, milestone failed. The report is returned so the freelancer can see which line. */
  | { status: 422; body: { error: string; report: Report } }
  /** Malformed input, or a request that does not match the chain. No retry will help. */
  | { status: 400; body: { error: string } }
  /** A target was unreachable, or we could not sign. Ours. Retry. Never a milestone result. */
  | { status: 502; body: { error: string } }

/**
 * The whole route as a pure-ish function of `(body, deps)`.
 *
 * Exported separately from `POST` because every property worth protecting here is about the
 * *order* and the *status mapping*, and both are invisible if the only entry point needs an
 * HTTP request, an RPC endpoint and a real private key to run.
 */
export async function handleVerify(body: unknown, deps: VerifyDeps): Promise<VerifyResult> {
  // ---- 1. Shape ------------------------------------------------------------------------
  const parsed = parseBody(body)
  if (!parsed.ok) return badRequest(parsed.error)
  const { escrow, milestone, submission, criteria, evidence } = parsed.value

  // ---- 2. Bind to the chain, BEFORE anything is fetched ---------------------------------
  // This ordering is the security property, not a performance choice. `criteria.http.url` is
  // attacker-controlled until this passes, and a check that ran first would have already made
  // the request by the time we discovered the criteria were invented.
  const bound = await assertBound({ escrow, milestone, submission, criteria, evidence }, deps.readMilestone)
  if (!bound.ok) {
    const status = bindFailureStatus(bound.failure)
    const error = describeBindFailure(bound.failure)
    // `chain-unreachable` is the only 502 in that set: we could not get a trustworthy answer
    // out of the node, which says nothing whatsoever about the freelancer's work.
    return status === 502 ? unreachable(error) : badRequest(error)
  }

  // ---- 3. Dispatch ----------------------------------------------------------------------
  let outcome: CheckOutcome
  try {
    outcome = await runCheck(criteria, deps)
  } catch (err) {
    // A check module throwing is a bug on our side of the wall (the shape guard above should
    // have made it impossible). It is emphatically not an observation about the milestone, so
    // it takes the 502 door. "When in doubt it is unreachable."
    return unreachable(`the ${criteria.check} check could not be completed: ${describe(err)}`)
  }

  // ---- 4. Unreachable -> 502, and nothing is signed --------------------------------------
  if (outcome.kind === 'unreachable') {
    return unreachable(outcome.reason)
  }

  // ---- 5. Assemble C5 --------------------------------------------------------------------
  // `checkedAt` is supplied by the route and passed in, because a report has to be
  // reproducible from its inputs: a builder that read its own clock would hash differently on
  // every call and nobody could re-derive the `reportHash` that was signed.
  const checkedAt = Math.floor(deps.now() / 1000)
  const evidenceHash = hashJson(evidence)
  const criteriaHash = hashJson(criteria)

  const { report, reportHash } = buildReport({
    escrow,
    milestone,
    submission,
    evidenceHash,
    criteriaHash,
    checks: outcome.checks,
    checkedAt,
  })

  // ---- 6. Failed -> 422 with the report, unsigned ----------------------------------------
  if (!report.passed) {
    return {
      status: 422,
      body: {
        error: failureSummary(report.checks),
        report,
      },
    }
  }

  // ---- 7. Passed -> sign -----------------------------------------------------------------
  try {
    const { signature, digest } = await signAttestation(
      {
        escrow: escrow as `0x${string}`,
        milestone,
        submission,
        passed: true,
        evidenceHash,
        reportHash,
        chainId: deps.chainId,
      },
      deps.verifierKey,
    )
    return { status: 200, body: { report, reportHash, signature, digest } }
  } catch {
    // Deliberately swallows the underlying message. `signAttestation` already withholds key
    // material, but a missing-or-malformed-key error names the env var, and error strings
    // travel further than anyone plans for. The caller learns only that we could not produce
    // the signature — which is true, is ours, and is retryable once we fix our config.
    return unreachable('the verifier could not sign this attestation; this is our configuration, not your work')
  }
}

/**
 * The real wiring. Config is read here, per request, and immediately handed to `handleVerify`.
 *
 * Reading env inside the handler rather than at module scope means a deploy with a missing key
 * fails one request with a 502 instead of failing to boot with the key's name in a build log.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    // The parse error is not echoed: it can quote the body, and the body is never logged or
    // reflected. "Not JSON" is the entire actionable content anyway.
    return json(400, { error: 'request body is not valid JSON' })
  }

  let verifierKey: string
  try {
    verifierKey = loadVerifierKey(process.env)
  } catch {
    // Same reasoning as the signing catch: the thrown message names the variable. Ours, 502.
    return json(502, { error: 'the verifier signing key is not available; this is our configuration' })
  }

  const rpcUrl = process.env.MONAD_RPC_URL
  if (!rpcUrl) {
    return json(502, { error: 'the verifier has no RPC endpoint configured; this is our configuration' })
  }

  const result = await handleVerify(body, {
    // The global fetch, narrowed to the injectable seam. The cast is over the *response* shape
    // only — `Response` structurally satisfies `FetchImpl`'s return type.
    fetchImpl: globalThis.fetch as unknown as FetchImpl,
    readMilestone: makeRpcMilestoneReader(rpcUrl),
    verifierKey,
    now: Date.now,
    githubToken: process.env.GITHUB_TOKEN,
  })

  return json(result.status, result.body)
}

/* ------------------------------------------------------------------ dispatch */

async function runCheck(criteria: Criteria, deps: VerifyDeps): Promise<CheckOutcome> {
  switch (criteria.check) {
    case 'http':
      return runHttpCheck(criteria, deps.fetchImpl, deps.now)

    case 'github':
      return runGithubCheck(criteria, deps.fetchImpl, deps.githubToken)

    case 'clientApproval':
      // There is nothing to verify and there never will be: this milestone releases by the
      // client's own hand. Returning a *passing* report here would be the verifier signing off
      // on work it did not look at, which is precisely the authority this service must not have.
      // So it becomes one honest, failing check line — a 422 that tells the freelancer to go ask
      // the client, not a 502 that invites them to retry forever.
      return {
        kind: 'ran',
        checks: [
          {
            id: 'clientApproval',
            label: 'Client approval',
            passed: false,
            detail:
              'This milestone is released by the client approving it directly. There is no ' +
              'automated check to run, so the verifier has observed nothing and will not ' +
              'attest that it passed. Ask the client to approve the milestone on-chain.',
          },
        ],
      }
  }
}

/** One line for the 422 `error` field. Names the failing checks; the report carries the detail. */
function failureSummary(checks: CheckResult[]): string {
  const failed = checks.filter((c) => !c.passed)
  if (failed.length === 0) {
    // Reachable only via `buildReport`'s empty-list rule, which refuses to call "we observed
    // nothing" a pass. Worth saying out loud rather than emitting a summary of zero failures.
    return 'the criteria produced no observations at all, so nothing could be attested'
  }
  return `milestone did not pass: ${failed.map((c) => c.id).join(', ')}`
}

/* ------------------------------------------------------------------ body validation */

type ParsedBody = {
  escrow: string
  milestone: number
  submission: number
  criteria: Criteria
  evidence: Evidence
}

type Parse<T> = { ok: true; value: T } | { ok: false; error: string }

const UINT32_MAX = 4_294_967_295
const CHECK_KINDS: readonly CheckKind[] = ['http', 'github', 'clientApproval']

/**
 * Hand-rolled, by design: adding a schema library would mean a second description of C3/C4 that
 * can drift from `types.ts`, and this is the money path.
 *
 * Two rules govern everything below.
 *
 *  - **Validate, never normalise.** `criteria` and `evidence` are handed to `assertBound`
 *    exactly as they arrived, because their hashes are compared against what the chain
 *    committed. Coercing a field, filling a default or dropping an unknown key here would
 *    change the hash and turn an honest request into a criteria mismatch.
 *  - **No values in error messages.** Field paths and expected types only. The body is never
 *    logged and never reflected.
 */
function parseBody(body: unknown): Parse<ParsedBody> {
  const root = asRecord(body)
  if (root === null) return bad('body must be a JSON object')

  const escrow = root['escrow']
  if (typeof escrow !== 'string' || !isAddress(escrow)) {
    return bad('escrow must be a 0x-prefixed 20-byte address')
  }

  const milestone = root['milestone']
  if (!Number.isSafeInteger(milestone) || (milestone as number) < 0) {
    return bad('milestone must be a non-negative integer')
  }

  const submission = root['submission']
  if (!Number.isInteger(submission) || (submission as number) < 0 || (submission as number) > UINT32_MAX) {
    // uint32 in the C2 payload. A value that does not fit would be rejected at signing time,
    // after we had already fetched the target — cheaper and safer to refuse it here.
    return bad('submission must be an integer that fits uint32')
  }

  const criteria = parseCriteria(root['criteria'])
  if (!criteria.ok) return criteria

  const evidence = parseEvidence(root['evidence'])
  if (!evidence.ok) return evidence

  return {
    ok: true,
    value: {
      escrow,
      milestone: milestone as number,
      submission: submission as number,
      criteria: criteria.value,
      evidence: evidence.value,
    },
  }
}

/**
 * C3. The block matching `check` is required *here* rather than inside the check module: a
 * missing `criteria.http` makes `runHttpCheck` throw and makes `runGithubCheck` answer
 * `unreachable`, and neither a 500 nor a 502 is the right answer for a body we can see is
 * malformed before we do anything at all.
 */
function parseCriteria(value: unknown): Parse<Criteria> {
  const c = asRecord(value)
  if (c === null) return bad('criteria must be an object')
  if (c['v'] !== 1) return bad('criteria.v must be 1')
  if (typeof c['title'] !== 'string') return bad('criteria.title must be a string')

  const check = c['check']
  if (typeof check !== 'string' || !CHECK_KINDS.includes(check as CheckKind)) {
    return bad(`criteria.check must be one of ${CHECK_KINDS.join(', ')}`)
  }

  if (check === 'http') {
    const h = asRecord(c['http'])
    if (h === null) return bad('criteria.http is required when criteria.check is "http"')
    if (typeof h['url'] !== 'string' || h['url'] === '') return bad('criteria.http.url must be a non-empty string')
    if (!Number.isInteger(h['expectStatus'])) return bad('criteria.http.expectStatus must be an integer')
    if (!isStringArray(h['mustContain'])) return bad('criteria.http.mustContain must be an array of strings')
    if (!isStringArray(h['mustNotContain'])) return bad('criteria.http.mustNotContain must be an array of strings')
    if (!Number.isInteger(h['timeoutMs']) || (h['timeoutMs'] as number) <= 0) {
      // A zero or negative timeout aborts before the request can start, which would surface as
      // "unreachable" forever — an infinite retry loop dressed up as our own fault.
      return bad('criteria.http.timeoutMs must be a positive integer')
    }
  }

  if (check === 'github') {
    const g = asRecord(c['github'])
    if (g === null) return bad('criteria.github is required when criteria.check is "github"')
    if (typeof g['repo'] !== 'string') return bad('criteria.github.repo must be a string')
    if (typeof g['ref'] !== 'string') return bad('criteria.github.ref must be a string')
    if (typeof g['requireCommit'] !== 'boolean') return bad('criteria.github.requireCommit must be a boolean')
    if (g['requireCheckRun'] !== null && typeof g['requireCheckRun'] !== 'string') {
      return bad('criteria.github.requireCheckRun must be a string or null')
    }
    if (g['minStars'] !== null && !Number.isFinite(g['minStars'])) {
      return bad('criteria.github.minStars must be a finite number or null')
    }
  }

  // Returned as-is, not rebuilt: the object that gets hashed must be byte-identical to what the
  // caller sent, or it cannot match the `criteriaHash` sitting on-chain.
  return { ok: true, value: value as Criteria }
}

/** C4. Deliberately loose on the optional fields — the chain, not this function, says which
 *  evidence is the right evidence, and inventing extra requirements here would reject honest
 *  submissions whose hash matches perfectly. */
function parseEvidence(value: unknown): Parse<Evidence> {
  const e = asRecord(value)
  if (e === null) return bad('evidence must be an object')
  if (e['v'] !== 1) return bad('evidence.v must be 1')
  if (!Number.isSafeInteger(e['milestone']) || (e['milestone'] as number) < 0) {
    return bad('evidence.milestone must be a non-negative integer')
  }
  if (!Number.isFinite(e['submittedAt'])) return bad('evidence.submittedAt must be a number')

  for (const key of ['url', 'repo', 'commit', 'note'] as const) {
    if (e[key] !== undefined && typeof e[key] !== 'string') {
      return bad(`evidence.${key} must be a string when present`)
    }
  }

  return { ok: true, value: value as Evidence }
}

/* ------------------------------------------------------------------ small helpers */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function badRequest(error: string): VerifyResult {
  return { status: 400, body: { error } }
}

function unreachable(error: string): VerifyResult {
  return { status: 502, body: { error } }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
