/**
 * C7 — the LLM provider. A `MilestoneProvider` named `'llm'` over the Anthropic Messages API.
 *
 * Two rules shape every line below.
 *
 * **The key lives in exactly one place: the `x-api-key` header.** It is never logged, never
 * placed in the body or the URL, never attached to a thrown error, and never returned. The
 * only way a caller can observe it is by reading the header off the request it handed us a
 * `fetchImpl` for — which is the caller's own key coming back to the caller.
 *
 * **The model is a suggestion, not a source of truth.** Everything that comes back is
 * validated: the envelope, the JSON payload, the draft count, every string length, every
 * check kind, every C3 block, every amount, and — the one that actually costs money — the
 * sum. If the amounts do not add to `totalAmount` to the wei, we reject. We do **not**
 * rescale: a silently adjusted split is a number neither party ever agreed to, and the
 * create transaction would be signed against it. Rejecting hands the caller back to the
 * deterministic template, which is the design: the LLM is the nice path, never the
 * load-bearing one.
 */

import type { BriefInput, MilestoneDraft, MilestoneProvider } from '@/lib/ai/types'
import type { CheckKind, Criteria } from '@/lib/verify/types'

/** The Messages API endpoint. Overridable so a self-hoster can point at a proxy. */
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

/** Pinned wire version. Anthropic requires this header on every request. */
export const ANTHROPIC_VERSION = '2023-06-01'

/** Current Claude model. */
export const DEFAULT_MODEL = 'claude-opus-5'

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_TOKENS = 8_000

/** A brief this long is a paste accident, not a brief. Rejected before we spend a token. */
export const MAX_BRIEF_LENGTH = 20_000

export const MIN_DRAFTS = 3
export const MAX_DRAFTS = 8

/**
 * Length caps on every model-authored string. These exist because the drafts are rendered
 * straight into the review page: a runaway generation must be rejected at the seam rather
 * than shipped to a browser. Rejecting rather than truncating is deliberate — a truncated
 * criterion is a different criterion, and the parties would be signing something the model
 * did not write.
 */
export const MAX_TITLE_LENGTH = 200
export const MAX_RATIONALE_LENGTH = 1_000
export const MAX_URL_LENGTH = 2_048
export const MAX_PHRASE_LENGTH = 200
export const MAX_PHRASES = 20
export const MAX_HTTP_TIMEOUT_MS = 60_000

const LEGAL_CHECKS: readonly CheckKind[] = ['http', 'github', 'clientApproval']

/**
 * The response shape this module needs from `fetch`.
 *
 * Not `verify/types.FetchImpl` — that one is a GET-only reader with no body, because the
 * verifier only ever reads. This is a POST with a JSON body. Widening the shared seam so two
 * unrelated call sites could share one alias would make the verifier's contract vaguer than
 * it is, so the LLM's fetch is declared here, next to the only code that uses it.
 */
export type LlmFetchResponse = {
  ok: boolean
  status: number
  text(): Promise<string>
}

/** Injected so no test touches the network and no key is read at import. */
export type LlmFetch = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<LlmFetchResponse>

export type AnthropicProviderOptions = {
  /** The user's key. Held in memory for this one request; never persisted or echoed. */
  apiKey: string
  fetchImpl: LlmFetch
  model?: string
  baseUrl?: string
  timeoutMs?: number
  maxTokens?: number
}

/**
 * Every failure from this module. `status` carries the HTTP code when there was one so the
 * route can distinguish "bad key" from "Anthropic is down" without parsing prose.
 *
 * There is deliberately no field for the credential, the request, or the raw body: an error
 * object gets logged, serialised into a response, and attached to a trace, and any of those
 * would carry a key that must never leave this process.
 */
export class LlmProviderError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'LlmProviderError'
    this.status = status
  }
}

function fail(message: string, status: number | null = null): never {
  throw new LlmProviderError(message, status)
}

/**
 * The structured-output schema. Constrains the response to `MilestoneDraft[]`, wrapped in an
 * object because that is the shape structured outputs are specified for.
 *
 * Note what is *not* here: lengths, counts, and the sum. Structured outputs do not enforce
 * `minLength`/`maxItems`/`minimum`, and could not enforce a BigInt sum at all. The schema
 * buys us shape; it buys us nothing about truth. Every constraint that matters is re-checked
 * below against the parsed payload.
 */
const CRITERIA_SCHEMA = {
  type: 'object',
  properties: {
    v: { type: 'integer', enum: [1] },
    title: { type: 'string', description: 'What this criterion checks, in plain English.' },
    check: { type: 'string', enum: ['http', 'github', 'clientApproval'] },
    http: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        expectStatus: { type: 'integer' },
        mustContain: { type: 'array', items: { type: 'string' } },
        mustNotContain: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'integer' },
      },
      required: ['url', 'expectStatus', 'mustContain', 'mustNotContain', 'timeoutMs'],
      additionalProperties: false,
    },
    github: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        ref: { type: 'string' },
        requireCommit: { type: 'boolean' },
        requireCheckRun: { type: ['string', 'null'] },
        minStars: { type: ['integer', 'null'] },
      },
      required: ['repo', 'ref', 'requireCommit', 'requireCheckRun', 'minStars'],
      additionalProperties: false,
    },
  },
  required: ['v', 'title', 'check'],
  additionalProperties: false,
} as const

const MILESTONES_SCHEMA = {
  type: 'object',
  properties: {
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          amount: {
            type: 'string',
            description: 'wei, decimal digits only. No 0x, no exponent, no decimal point.',
          },
          check: { type: 'string', enum: ['http', 'github', 'clientApproval'] },
          criteria: CRITERIA_SCHEMA,
          rationale: { type: 'string' },
        },
        required: ['title', 'amount', 'check', 'criteria', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['milestones'],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = [
  'You split a freelance brief into milestones for an on-chain escrow.',
  '',
  `Return between ${MIN_DRAFTS} and ${MAX_DRAFTS} milestones, in delivery order.`,
  '',
  'Amounts are wei, as decimal strings of digits only — no 0x, no exponent, no decimal',
  'point, no sign, no separators, no leading zeros. They must sum to exactly the stated',
  'total, to the wei. Do the arithmetic carefully: the total is larger than 2^53.',
  '',
  'Each milestone carries one machine-checkable acceptance criterion:',
  '  http           — a URL that must answer, optionally containing or omitting phrases.',
  '  github         — a repo/ref that must carry a commit, optionally a passing check run.',
  '  clientApproval — a human decision, for work no machine can grade.',
  'The criteria object must repeat the milestone\'s check kind and carry only the matching',
  'block. Prefer clientApproval over inventing a URL or repo the brief never mentioned.',
  '',
  'Both parties read the title and rationale before they sign, so keep them short, concrete',
  'and free of hedging. Say what will be delivered, not what might be.',
].join('\n')

function buildUserPrompt(brief: string, totalAmount: string, currency: string): string {
  return [
    `Total escrow amount: ${totalAmount} wei (${currency}).`,
    'The milestone amounts must sum to exactly that number.',
    '',
    'Brief:',
    brief,
  ].join('\n')
}

/**
 * Build the provider.
 *
 * Nothing here reads the environment: the key arrives as an argument, resolved by the caller
 * in the order the header/env/template contract specifies. That is what lets a test run this
 * module with a fake key and no `process.env` at all.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): MilestoneProvider {
  const {
    apiKey,
    fetchImpl,
    model = DEFAULT_MODEL,
    baseUrl = ANTHROPIC_MESSAGES_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = options

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    // No credential means this provider must not exist; the caller resolves to the template.
    throw new LlmProviderError('llm provider: a credential is required to construct it')
  }

  return {
    name: 'llm',

    async propose(input: BriefInput): Promise<MilestoneDraft[]> {
      // The total is validated before the call, not after: a malformed total makes the whole
      // response unusable, and there is no reason to spend a request discovering that.
      const total = parseWei(input?.totalAmount, 'totalAmount')

      const brief = typeof input?.brief === 'string' ? input.brief.trim() : ''
      if (brief === '') fail('llm provider: brief is empty')
      if (brief.length > MAX_BRIEF_LENGTH) {
        fail(`llm provider: brief exceeds ${MAX_BRIEF_LENGTH} characters`)
      }

      const payload = await callAnthropic({
        apiKey,
        fetchImpl,
        model,
        baseUrl,
        timeoutMs,
        maxTokens,
        brief,
        totalAmount: input.totalAmount,
        currency: input.currency,
      })

      return validateDrafts(payload, total)
    },
  }
}

type CallArgs = {
  apiKey: string
  fetchImpl: LlmFetch
  model: string
  baseUrl: string
  timeoutMs: number
  maxTokens: number
  brief: string
  totalAmount: string
  currency: string
}

/** One request. Returns the parsed JSON payload the model produced, still untrusted. */
async function callAnthropic(args: CallArgs): Promise<unknown> {
  const body = JSON.stringify({
    model: args.model,
    max_tokens: args.maxTokens,
    system: SYSTEM_PROMPT,
    // Adaptive thinking, medium effort: the arithmetic here is the part a model gets wrong,
    // and we would rather it reason than guess. We still never trust the result.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: MILESTONES_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(args.brief, args.totalAmount, args.currency),
      },
    ],
  })

  // Our own controller, because the timeout is a property of this call and the code that
  // fires it has to be the code that can tell "we gave up" from "they said no".
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, args.timeoutMs)

  try {
    let response: LlmFetchResponse
    try {
      response = await args.fetchImpl(args.baseUrl, {
        method: 'POST',
        headers: {
          // The one and only place the credential appears.
          'x-api-key': args.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: controller.signal,
      })
    } catch {
      // The thrown value is deliberately not interpolated. It comes from the caller's own
      // fetch, which in some runtimes attaches the request — and therefore the header — to
      // the error it rejects with. Describing it would be the one leak this module allows.
      if (timedOut) fail(`llm provider: request timed out after ${args.timeoutMs}ms`)
      fail('llm provider: request to the model API failed before a response arrived')
    }

    if (!response.ok) {
      // Deliberately no body echo: an upstream error page is attacker- or vendor-controlled
      // text that would end up rendered or logged verbatim.
      if (response.status === 401 || response.status === 403) {
        fail('llm provider: the model API rejected the credential', response.status)
      }
      if (response.status === 429) {
        fail('llm provider: the model API rate limited this request', response.status)
      }
      fail(`llm provider: the model API answered ${response.status}`, response.status)
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      fail('llm provider: could not read the response body')
    }

    let envelope: unknown
    try {
      envelope = JSON.parse(text)
    } catch {
      fail('llm provider: the response body was not JSON')
    }

    return extractPayload(envelope)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pull the model's JSON out of the Messages envelope.
 *
 * A refusal, a stop at `max_tokens`, a missing text block and a prose answer all land here
 * and all throw. They are separate messages because they mean different things to whoever
 * reads the log: a refusal is a prompt problem, a truncation is a `max_tokens` problem, and
 * prose where structured output was requested is a model problem.
 */
function extractPayload(envelope: unknown): unknown {
  if (!isRecord(envelope)) fail('llm provider: the response was not a JSON object')

  const stopReason = envelope.stop_reason
  if (stopReason === 'refusal') {
    fail('llm provider: the model declined to answer this brief')
  }
  if (stopReason === 'max_tokens') {
    fail('llm provider: the model response was truncated before it finished')
  }

  const content = envelope.content
  if (!Array.isArray(content)) {
    fail('llm provider: the response envelope had no content array')
  }

  // Thinking blocks precede the answer, so take the first *text* block rather than [0].
  const textBlock = content.find(
    (block): block is { type: 'text'; text: string } =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string',
  )
  if (!textBlock || textBlock.text.trim() === '') {
    fail('llm provider: the response carried no text block')
  }

  try {
    return JSON.parse(textBlock.text)
  } catch {
    fail('llm provider: the model answered with prose where structured output was requested')
  }
}

/**
 * Validate the payload into drafts, or throw.
 *
 * @param total the escrow total in wei. The drafts must sum to exactly this.
 */
function validateDrafts(payload: unknown, total: bigint): MilestoneDraft[] {
  // Accept the wrapped object we asked for, and a bare array, because a model that returns
  // the array directly has still answered the question correctly.
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.milestones)
      ? payload.milestones
      : null

  if (list === null) fail('llm provider: the payload was not an array of milestones')

  if (list.length < MIN_DRAFTS || list.length > MAX_DRAFTS) {
    fail(
      `llm provider: expected ${MIN_DRAFTS}-${MAX_DRAFTS} milestones, received ${list.length}`,
    )
  }

  const drafts: MilestoneDraft[] = []
  let sum = 0n

  for (let i = 0; i < list.length; i++) {
    const raw = list[i]
    const at = `milestone ${i}`
    if (!isRecord(raw)) fail(`llm provider: ${at} was not an object`)

    const title = requireBoundedString(raw.title, MAX_TITLE_LENGTH, `${at} title`)
    const rationale = requireBoundedString(raw.rationale, MAX_RATIONALE_LENGTH, `${at} rationale`)
    const check = requireCheckKind(raw.check, at)
    const amountWei = parseWei(raw.amount, `${at} amount`)
    const criteria = validateCriteria(raw.criteria, check, at)

    sum += amountWei

    // A fresh object, so nothing the model invented alongside the known fields survives into
    // the page or the create transaction.
    drafts.push({ title, amount: raw.amount as string, check, criteria, rationale })
  }

  if (sum !== total) {
    // No rescaling, however close it is. A split adjusted here is a split neither party saw;
    // the caller falls back to the template, which is arithmetically exact by construction.
    fail(
      `llm provider: milestone amounts sum to ${sum} wei, expected exactly ${total} wei`,
    )
  }

  return drafts
}

/**
 * Validate one C3 object.
 *
 * Stricter than the rest of this file on purpose: `criteria` is what `criteriaHash` commits
 * to on-chain, so an unrecognised field here would be hashed into an agreement nobody can
 * read back. Unknown keys are rejected rather than dropped.
 */
function validateCriteria(raw: unknown, check: CheckKind, at: string): Criteria {
  if (!isRecord(raw)) fail(`llm provider: ${at} criteria was not an object`)

  assertNoUnknownKeys(raw, ['v', 'title', 'check', 'http', 'github'], `${at} criteria`)

  if (raw.v !== 1) fail(`llm provider: ${at} criteria.v must be 1`)

  const title = requireBoundedString(raw.title, MAX_TITLE_LENGTH, `${at} criteria.title`)

  const criteriaCheck = requireCheckKind(raw.check, `${at} criteria`)
  if (criteriaCheck !== check) {
    // The verifier will later be asked to run exactly this object. If it disagrees with the
    // draft the parties read, the two sides are agreeing to different things.
    fail(
      `llm provider: ${at} criteria.check is ${criteriaCheck} but the milestone check is ${check}`,
    )
  }

  const hasHttp = 'http' in raw
  const hasGithub = 'github' in raw

  if (check === 'http') {
    if (hasGithub) fail(`llm provider: ${at} criteria carries a github block for an http check`)
    if (!hasHttp) fail(`llm provider: ${at} criteria is missing its http block`)
    return { v: 1, title, check, http: validateHttpBlock(raw.http, at) }
  }

  if (check === 'github') {
    if (hasHttp) fail(`llm provider: ${at} criteria carries an http block for a github check`)
    if (!hasGithub) fail(`llm provider: ${at} criteria is missing its github block`)
    return { v: 1, title, check, github: validateGithubBlock(raw.github, at) }
  }

  if (hasHttp || hasGithub) {
    fail(`llm provider: ${at} criteria carries a check block for a clientApproval check`)
  }
  return { v: 1, title, check }
}

function validateHttpBlock(raw: unknown, at: string): NonNullable<Criteria['http']> {
  if (!isRecord(raw)) fail(`llm provider: ${at} criteria.http was not an object`)
  assertNoUnknownKeys(
    raw,
    ['url', 'expectStatus', 'mustContain', 'mustNotContain', 'timeoutMs'],
    `${at} criteria.http`,
  )

  const url = requireBoundedString(raw.url, MAX_URL_LENGTH, `${at} criteria.http.url`)
  if (!/^https?:\/\/\S/.test(url)) {
    // Anything else is a scheme the verifier will not fetch — file:, data:, or a bare host.
    fail(`llm provider: ${at} criteria.http.url must be an http(s) URL`)
  }

  const expectStatus = raw.expectStatus
  if (!Number.isInteger(expectStatus) || (expectStatus as number) < 100 || (expectStatus as number) > 599) {
    fail(`llm provider: ${at} criteria.http.expectStatus must be an HTTP status code`)
  }

  const timeoutMs = raw.timeoutMs
  if (
    !Number.isInteger(timeoutMs) ||
    (timeoutMs as number) < 1 ||
    (timeoutMs as number) > MAX_HTTP_TIMEOUT_MS
  ) {
    fail(
      `llm provider: ${at} criteria.http.timeoutMs must be 1-${MAX_HTTP_TIMEOUT_MS}`,
    )
  }

  return {
    url,
    expectStatus: expectStatus as number,
    mustContain: requirePhrases(raw.mustContain, `${at} criteria.http.mustContain`),
    mustNotContain: requirePhrases(raw.mustNotContain, `${at} criteria.http.mustNotContain`),
    timeoutMs: timeoutMs as number,
  }
}

function validateGithubBlock(raw: unknown, at: string): NonNullable<Criteria['github']> {
  if (!isRecord(raw)) fail(`llm provider: ${at} criteria.github was not an object`)
  assertNoUnknownKeys(
    raw,
    ['repo', 'ref', 'requireCommit', 'requireCheckRun', 'minStars'],
    `${at} criteria.github`,
  )

  const repo = requireBoundedString(raw.repo, MAX_PHRASE_LENGTH, `${at} criteria.github.repo`)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    fail(`llm provider: ${at} criteria.github.repo must be owner/name`)
  }

  const ref = requireBoundedString(raw.ref, MAX_PHRASE_LENGTH, `${at} criteria.github.ref`)

  if (typeof raw.requireCommit !== 'boolean') {
    fail(`llm provider: ${at} criteria.github.requireCommit must be a boolean`)
  }

  const requireCheckRun =
    raw.requireCheckRun === null
      ? null
      : requireBoundedString(
          raw.requireCheckRun,
          MAX_PHRASE_LENGTH,
          `${at} criteria.github.requireCheckRun`,
        )

  const minStars = raw.minStars
  if (minStars !== null && (!Number.isInteger(minStars) || (minStars as number) < 0)) {
    fail(`llm provider: ${at} criteria.github.minStars must be a non-negative integer or null`)
  }

  return {
    repo,
    ref,
    requireCommit: raw.requireCommit,
    requireCheckRun,
    minStars: minStars as number | null,
  }
}

function requirePhrases(raw: unknown, at: string): string[] {
  if (!Array.isArray(raw)) fail(`llm provider: ${at} must be an array`)
  if (raw.length > MAX_PHRASES) fail(`llm provider: ${at} has more than ${MAX_PHRASES} entries`)
  return raw.map((phrase, i) =>
    requireBoundedString(phrase, MAX_PHRASE_LENGTH, `${at}[${i}]`),
  )
}

function requireCheckKind(raw: unknown, at: string): CheckKind {
  if (typeof raw !== 'string' || !LEGAL_CHECKS.includes(raw as CheckKind)) {
    fail(`llm provider: ${at} check must be one of ${LEGAL_CHECKS.join(', ')}`)
  }
  return raw as CheckKind
}

/** Non-empty after trimming, and no longer than `max`. Returned trimmed. */
function requireBoundedString(raw: unknown, max: number, at: string): string {
  if (typeof raw !== 'string') fail(`llm provider: ${at} must be a string`)
  const trimmed = raw.trim()
  if (trimmed === '') fail(`llm provider: ${at} must not be empty`)
  if (trimmed.length > max) fail(`llm provider: ${at} exceeds ${max} characters`)
  return trimmed
}

/**
 * A wei amount: decimal digits only, greater than zero.
 *
 * Everything a model might reasonably emit instead is rejected here — `0x1c6bf5...`, `6e18`,
 * `6.0`, `-1`, `+1`, `6_000`, `" 6"`, `6000000000000000000n`. The parse goes straight to
 * `BigInt` and never through `number`, because 6 MON is 6e18 and `Number` loses the low
 * digits — a split that is one wei off reverts the create transaction with FundingMismatch.
 *
 * Leading zeros are rejected too: `"06"` and `"6"` are the same integer but different
 * strings, and the string is what gets stored and displayed.
 */
function parseWei(raw: unknown, at: string): bigint {
  if (typeof raw !== 'string') fail(`llm provider: ${at} must be a decimal string`)
  if (!/^[0-9]+$/.test(raw)) {
    fail(`llm provider: ${at} must be decimal digits only, received ${JSON.stringify(raw)}`)
  }
  if (raw.length > 1 && raw.startsWith('0')) {
    fail(`llm provider: ${at} must not have leading zeros`)
  }
  const value = BigInt(raw)
  if (value <= 0n) fail(`llm provider: ${at} must be greater than zero`)
  return value
}

function assertNoUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`llm provider: ${at} carries an unknown field ${JSON.stringify(key)}`)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
