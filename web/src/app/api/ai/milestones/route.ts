/**
 * C7 — `POST /api/ai/milestones`. Brief in, milestone drafts out.
 *
 * Thin on purpose. `provider.ts` owns the credential order, `template.ts` owns the offline
 * split, `anthropic.ts` owns the model call. This file validates the body, hands the pieces to
 * those three, re-checks the one invariant that costs real money, and maps the result onto a
 * status code. It forms no opinion of its own about what a good milestone looks like.
 *
 * Three properties this file exists to hold.
 *
 *  1. **A missing, wrong, expired or rate-limited key is never an error status.** Every one of
 *     those ends at the deterministic template and a 200 saying `source: "template"`. The demo
 *     has to run on a judge's machine with no API key at all; if the no-credential path can
 *     return anything other than 200 + drafts, the product does not work for the person
 *     deciding whether it is good. The only 400 is a body we cannot read.
 *
 *  2. **The sum is re-checked here, whichever provider produced it.** `anthropic.ts` already
 *     validates it and `template.ts` is exact by construction, and this file checks it again
 *     anyway. The drafts feed `/new`, and a split that is one wei off `totalAmount` is a create
 *     transaction that reverts `FundingMismatch` after the user has signed it. Defence in depth
 *     is cheap; trusting a provider's arithmetic is not.
 *
 *  3. **The user's key never leaves memory.** It is read from the `x-llm-key` header, passed to
 *     the provider factory, and referenced nowhere else — not in a response, not in an error
 *     string, not in a log line. Nothing in this file logs at all: there is no `console` call
 *     here, and the request body is never echoed back or written anywhere, because a client's
 *     brief is their private commercial information and the key would ride along in the same
 *     request object. Validation errors name field paths and never quote values.
 */

import { createAnthropicProvider } from '@/lib/ai/anthropic'
import type { LlmFetch } from '@/lib/ai/anthropic'
import { proposeMilestones, resolveCredential } from '@/lib/ai/provider'
import type { EnvLike, HeadersLike, ProviderDeps } from '@/lib/ai/provider'
import { templateProvider } from '@/lib/ai/template'
import type { BriefInput, Credential, MilestoneDraft, MilestonesResult } from '@/lib/ai/types'

/** Reads a per-request header and per-request env; nothing here may be cached or prerendered. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The hard cap on a brief, in characters.
 *
 * Deliberately far above `anthropic.MAX_BRIEF_LENGTH` (20k). Those two caps answer different
 * questions: theirs is "is this worth spending tokens on", ours is "is this a paste accident".
 * A 50 kB brief is not malformed — the LLM provider will refuse it, and the template will
 * happily split it — so rejecting it here with a 400 would break rule 3 for a request the
 * offline path can serve perfectly well.
 */
export const MAX_BRIEF_CHARS = 100_000

/** 2^256 - 1. A total above this cannot be funded on-chain, so it is a malformed request. */
const UINT256_MAX = (1n << 256n) - 1n

/** wei as a decimal string: digits only, no leading zeros, no sign, no exponent. */
const WEI_DECIMAL = /^(0|[1-9][0-9]*)$/

/**
 * Everything the handler touches from the outside world.
 *
 * `ProviderDeps` carries the template provider and the LLM *factory* (a factory, so the
 * credential is passed at call time and no module holds one), and `env` is injected rather than
 * read here so no test has to mutate the real `process.env` and nothing reads it at import.
 */
export type MilestonesDeps = ProviderDeps & { env: EnvLike }

export type MilestonesResponse =
  | { status: 200; body: MilestonesResult }
  /** A body we cannot read. The only client error this endpoint has. */
  | { status: 400; body: { error: string } }
  /**
   * Our own deterministic parser failed or produced a split that does not sum. Unreachable
   * through any credential problem — it means a bug in code we wrote, not a bad request — but
   * silently returning drafts that would revert the create transaction is worse than saying so.
   */
  | { status: 502; body: { error: string } }

/**
 * The whole route as a function of `(body, headers, deps)`.
 *
 * Exported separately from `POST` because everything worth protecting here is a decision —
 * which credential wins, what happens when the model misbehaves, whether the amounts add up —
 * and none of it is testable if the only entry point needs a server and a real API key.
 */
export async function handleMilestones(
  body: unknown,
  headers: HeadersLike,
  deps: MilestonesDeps,
): Promise<MilestonesResponse> {
  // ---- 1. Shape. The only door to a 400. -------------------------------------------------
  const parsed = parseBody(body)
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
  const input = parsed.value
  const total = BigInt(input.totalAmount)

  // ---- 2. Credential order: header, then env, then nothing -------------------------------
  // `{ source: 'none' }` is a normal outcome here, not a failure: it is how the demo runs.
  const resolved = resolveCredential(headers, deps.env)

  // ---- 3. Propose ------------------------------------------------------------------------
  // `proposeMilestones` already turns every LLM failure — bad key, rate limit, timeout, prose
  // instead of JSON — into the template. A throw escaping it means the template itself broke.
  let result: MilestonesResult
  try {
    result = await proposeMilestones(input, resolved, deps)
  } catch {
    // The error is discarded unread. It came from our own code, but the call stack it travelled
    // through held the user's credential, and there is no version of quoting it that is worth
    // the risk of one runtime attaching a request object to its error.
    return ourFault()
  }

  // ---- 4. Re-check the arithmetic, whoever did it ----------------------------------------
  if (sumsExactly(result.milestones, total)) {
    // Rebuilt rather than forwarded, so only the two agreed fields can ever reach the client.
    return { status: 200, body: { milestones: result.milestones, source: result.source } }
  }

  if (result.source === 'template') {
    // The offline parser is the floor of the ladder. If its arithmetic is wrong there is
    // nothing left to fall back to, and shipping the split anyway would hand the user a
    // transaction that reverts after they sign it.
    return ourFault()
  }

  // ---- 5. A provider that cannot add up is not used, ever --------------------------------
  // No rescaling. A split adjusted here is a number neither party read, and both of them are
  // about to sign it. The template answers instead — it is exact by construction.
  let fallback: MilestoneDraft[]
  try {
    fallback = await deps.template.propose(input)
  } catch {
    return ourFault()
  }
  if (!sumsExactly(fallback, total)) return ourFault()

  return { status: 200, body: { milestones: fallback, source: 'template' } }
}

/**
 * The real wiring.
 *
 * Env and the global fetch are read here, per request, and handed straight to
 * `handleMilestones`. Reading env inside the handler rather than at module scope means a deploy
 * without `ANTHROPIC_API_KEY` serves templates instead of failing to boot with the variable's
 * name in a build log.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    // The parse error is not echoed: it quotes the body verbatim, and the body is never
    // reflected. "Not JSON" is the whole actionable content anyway.
    return json(400, { error: 'request body is not valid JSON' })
  }

  const result = await handleMilestones(body, request.headers, {
    env: process.env,
    template: templateProvider,
    // A factory, called only when a credential exists. The key is an argument and a request
    // header inside `anthropic.ts`, and lives nowhere else for the lifetime of the process.
    llm: (credential: Credential) =>
      createAnthropicProvider({
        apiKey: credential.value,
        // The cast narrows the global fetch onto the POST-with-body seam `anthropic.ts` declares.
        fetchImpl: globalThis.fetch as unknown as LlmFetch,
      }),
    // No `onFallback` hook is wired up. It is safe by construction — a closed set of reason
    // codes — but this endpoint writes nothing anywhere, and the simplest way to keep that true
    // is to have no sink at all.
  })

  return json(result.status, result.body)
}

/* ------------------------------------------------------------------ arithmetic */

/**
 * Do these drafts add to exactly `total` wei?
 *
 * Every step is `BigInt`. 6 MON is `6000000000000000000`, which is past
 * `Number.MAX_SAFE_INTEGER`, so a single round trip through `number` silently changes the
 * amount the user is asked to fund.
 *
 * Also rejects a zero amount, which is not a rounding problem but a revert: `create` refuses a
 * zero-amount milestone with `ZeroMilestoneAmount`, so a split containing one is unusable even
 * though it sums correctly.
 *
 * Only the amounts are re-checked here. The rest of the draft shape is guarded in `provider.ts`
 * for the LLM path and is structural for the template; duplicating it would mean two
 * descriptions of `MilestoneDraft` that can drift. The sum is singled out because it is the one
 * that costs money.
 */
function sumsExactly(drafts: unknown, total: bigint): drafts is MilestoneDraft[] {
  if (!Array.isArray(drafts) || drafts.length === 0) return false

  let sum = 0n
  for (const draft of drafts) {
    if (typeof draft !== 'object' || draft === null) return false
    const amount = (draft as { amount?: unknown }).amount
    // A JSON number here would already have lost the low digits before we could look at it.
    if (typeof amount !== 'string' || !WEI_DECIMAL.test(amount)) return false
    const wei = BigInt(amount)
    if (wei <= 0n) return false
    sum += wei
  }
  return sum === total
}

/* ------------------------------------------------------------------ body validation */

type Parse<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Hand-rolled, and every message names a field path and never a value.
 *
 * The body carries the client's brief, and the request that carried it carries the user's key.
 * An error string that quotes either one ends up in a browser console, a proxy log and a bug
 * report, so nothing from the request is ever reflected — not even to be helpful about why it
 * was rejected.
 */
function parseBody(body: unknown): Parse<BriefInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return bad('body must be a JSON object')
  }
  const root = body as Record<string, unknown>

  const brief = root['brief']
  if (typeof brief !== 'string') return bad('brief must be a string')
  // An empty brief is legal and deliberately so: the template produces a generic five-phase
  // split from nothing at all, which is a better starting point for editing than a blank form.
  if (brief.length > MAX_BRIEF_CHARS) {
    return bad(`brief must be at most ${MAX_BRIEF_CHARS} characters`)
  }

  const totalAmount = root['totalAmount']
  if (typeof totalAmount !== 'string') {
    // Never a number. `6000000000000000000` does not survive JSON's float parse, and accepting
    // one would mean funding an amount the user never typed.
    return bad('totalAmount must be a decimal string of wei')
  }
  if (!WEI_DECIMAL.test(totalAmount)) {
    // Rejects `0x…`, `6e18`, `6.0`, `-1`, `+1`, `6_000`, `" 6"` and `"06"`. Leading zeros are
    // rejected because the string is what gets stored and displayed, and `"06"` and `"6"` would
    // hash differently while meaning the same number.
    return bad('totalAmount must be decimal digits with no leading zeros, sign or exponent')
  }
  const total = BigInt(totalAmount)
  if (total <= 0n) {
    // Zero cannot be split into any number of non-zero milestones. There is no honest split.
    return bad('totalAmount must be at least 1 wei')
  }
  if (total > UINT256_MAX) return bad('totalAmount must fit in uint256')

  if (root['currency'] !== 'MON') return bad('currency must be "MON"')

  // Rebuilt, not passed through: unknown keys on the request must not reach a provider or a
  // prompt. `currency` is narrowed by the check above.
  return { ok: true, value: { brief, totalAmount, currency: 'MON' } }
}

/* ------------------------------------------------------------------ small helpers */

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function ourFault(): MilestonesResponse {
  return {
    status: 502,
    body: {
      // Says nothing about the request, because the request is not what went wrong.
      error: 'the milestone parser could not produce a valid split; this is our bug, not your brief',
    },
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
