/**
 * C7 — the LLM provider.
 *
 * Every test here protects one of two properties: the user's key never escapes the one
 * header it belongs in, and nothing the model says is believed without being checked. The
 * fetch is always a fake, so no test touches the network and no key is read from the
 * environment.
 */

import { describe, expect, it } from 'vitest'

import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  DEFAULT_MODEL,
  MAX_RATIONALE_LENGTH,
  MAX_TITLE_LENGTH,
  createAnthropicProvider,
  type LlmFetch,
  type LlmFetchResponse,
} from '@/lib/ai/anthropic'
import type { BriefInput } from '@/lib/ai/types'
import type { Criteria } from '@/lib/verify/types'

/**
 * A key with no dictionary content, so a substring scan cannot false-positive on ordinary
 * words like "anthropic" appearing in an error message.
 */
const API_KEY = 'sk-ant-api03-9f4c2e8b7a1d6053'

const TOTAL = '6000000000000000000' // 6 MON in wei — larger than Number.MAX_SAFE_INTEGER
const THIRD = '2000000000000000000'

const BRIEF: BriefInput = {
  brief: 'Build a marketing site with a pricing page and ship the repo.',
  totalAmount: TOTAL,
  currency: 'MON',
}

// --- fixtures ---------------------------------------------------------------------------

function httpCriteria(): Criteria {
  return {
    v: 1,
    title: 'Pricing page is live',
    check: 'http',
    http: {
      url: 'https://example.com/pricing',
      expectStatus: 200,
      mustContain: ['Pricing'],
      mustNotContain: ['Coming soon'],
      timeoutMs: 10_000,
    },
  }
}

function githubCriteria(): Criteria {
  return {
    v: 1,
    title: 'Source is pushed',
    check: 'github',
    github: {
      repo: 'acme/site',
      ref: 'main',
      requireCommit: true,
      requireCheckRun: 'build',
      minStars: null,
    },
  }
}

function approvalCriteria(): Criteria {
  return { v: 1, title: 'Client signs off on the copy', check: 'clientApproval' }
}

type RawDraft = Record<string, unknown>

function baseDrafts(): RawDraft[] {
  return [
    {
      title: 'Design approved',
      amount: THIRD,
      check: 'clientApproval',
      criteria: approvalCriteria(),
      rationale: 'Taste is not machine-checkable, so the client decides.',
    },
    {
      title: 'Site deployed',
      amount: THIRD,
      check: 'http',
      criteria: httpCriteria(),
      rationale: 'The page must answer 200 and show the pricing copy.',
    },
    {
      title: 'Repo handed over',
      amount: THIRD,
      check: 'github',
      criteria: githubCriteria(),
      rationale: 'The commit must exist and the build must pass.',
    },
  ]
}

// --- fake transport ---------------------------------------------------------------------

type Call = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

type Fake = { fetchImpl: LlmFetch; calls: Call[] }

function fakeFetch(responder: (call: Call) => Promise<LlmFetchResponse>): Fake {
  const calls: Call[] = []
  const fetchImpl: LlmFetch = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    }
    calls.push(call)
    return responder(call)
  }
  return { fetchImpl, calls }
}

function response(status: number, body: string): LlmFetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

/** A well-formed Messages envelope carrying `payload` as the model's structured answer. */
function envelope(payload: unknown, overrides: Record<string, unknown> = {}): LlmFetchResponse {
  return response(
    200,
    JSON.stringify({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: DEFAULT_MODEL,
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: JSON.stringify(payload) },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 200 },
      ...overrides,
    }),
  )
}

function providerReturning(payload: unknown): { propose: () => Promise<unknown>; calls: Call[] } {
  const { fetchImpl, calls } = fakeFetch(async () => envelope(payload))
  const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
  return { propose: () => provider.propose(BRIEF), calls }
}

/** Drafts with `patch` merged into the milestone at `index`. */
function draftsWith(index: number, patch: RawDraft): RawDraft[] {
  const drafts = baseDrafts()
  drafts[index] = { ...drafts[index], ...patch }
  return drafts
}

async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (err: unknown) {
    return err as Error
  }
  throw new Error('expected the provider to throw, but it resolved')
}

// --- happy path -------------------------------------------------------------------------

describe('createAnthropicProvider — happy path', () => {
  it('is a MilestoneProvider named llm', () => {
    const { fetchImpl } = fakeFetch(async () => envelope({ milestones: baseDrafts() }))
    expect(createAnthropicProvider({ apiKey: API_KEY, fetchImpl }).name).toBe('llm')
  })

  it('returns the drafts verbatim when the payload is well-formed and sums exactly', async () => {
    const { propose, calls } = providerReturning({ milestones: baseDrafts() })
    const drafts = await propose()

    expect(calls).toHaveLength(1)
    expect(drafts).toEqual([
      {
        title: 'Design approved',
        amount: THIRD,
        check: 'clientApproval',
        criteria: approvalCriteria(),
        rationale: 'Taste is not machine-checkable, so the client decides.',
      },
      {
        title: 'Site deployed',
        amount: THIRD,
        check: 'http',
        criteria: httpCriteria(),
        rationale: 'The page must answer 200 and show the pricing copy.',
      },
      {
        title: 'Repo handed over',
        amount: THIRD,
        check: 'github',
        criteria: githubCriteria(),
        rationale: 'The commit must exist and the build must pass.',
      },
    ])
  })

  it('accepts a bare array payload as well as the wrapped object', async () => {
    const { propose } = providerReturning(baseDrafts())
    await expect(propose()).resolves.toHaveLength(3)
  })

  it('accepts the count boundaries, 3 and 8', async () => {
    // Eight drafts of 750000000000000000 wei sum to exactly 6e18.
    const eighth = '750000000000000000'
    const eight = Array.from({ length: 8 }, (_, i) => ({
      ...baseDrafts()[0],
      title: `Milestone ${i + 1}`,
      amount: eighth,
    }))
    await expect(providerReturning({ milestones: eight }).propose()).resolves.toHaveLength(8)
    await expect(providerReturning({ milestones: baseDrafts() }).propose()).resolves.toHaveLength(3)
  })

  it('sums in BigInt, so a total above Number.MAX_SAFE_INTEGER is exact', async () => {
    // These three cannot be summed through `number` without losing the low digits.
    const total = '10000000000000000001'
    const drafts = baseDrafts()
    drafts[0].amount = '3333333333333333333'
    drafts[1].amount = '3333333333333333334'
    drafts[2].amount = '3333333333333333334'

    const { fetchImpl } = fakeFetch(async () => envelope({ milestones: drafts }))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })

    const result = await provider.propose({ ...BRIEF, totalAmount: total })
    const sum = result.reduce((acc, d) => acc + BigInt(d.amount), 0n)
    expect(sum).toBe(BigInt(total))
  })
})

// --- the request ------------------------------------------------------------------------

describe('the request', () => {
  it('carries x-api-key and anthropic-version, and the key is in no other field', async () => {
    const { propose, calls } = providerReturning({ milestones: baseDrafts() })
    await propose()

    const call = calls[0]
    expect(call.url).toBe(ANTHROPIC_MESSAGES_URL)
    expect(call.method).toBe('POST')
    expect(call.headers['x-api-key']).toBe(API_KEY)
    expect(call.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)

    // The key appears exactly once across the entire request, and that once is the header.
    const serialised = JSON.stringify({
      url: call.url,
      method: call.method,
      headers: call.headers,
      body: call.body,
    })
    expect(serialised.split(API_KEY).length - 1).toBe(1)
    expect(call.url).not.toContain(API_KEY)
    expect(call.body).not.toContain(API_KEY)
    for (const [name, value] of Object.entries(call.headers)) {
      if (name !== 'x-api-key') expect(value).not.toContain(API_KEY)
    }
  })

  it('asks for structured output shaped to MilestoneDraft[] on a current model', async () => {
    const { propose, calls } = providerReturning({ milestones: baseDrafts() })
    await propose()

    const body = JSON.parse(calls[0].body)
    expect(body.model).toBe(DEFAULT_MODEL)
    expect(body.output_config.format.type).toBe('json_schema')

    const item = body.output_config.format.schema.properties.milestones.items
    expect(Object.keys(item.properties).sort()).toEqual([
      'amount',
      'check',
      'criteria',
      'rationale',
      'title',
    ])
    expect(item.properties.criteria.properties.check.enum).toEqual([
      'http',
      'github',
      'clientApproval',
    ])
    // The total the amounts must sum to has to reach the model, or it cannot even try.
    expect(body.messages[0].content).toContain(TOTAL)
  })
})

// --- transport failures -------------------------------------------------------------------

describe('API call failures', () => {
  it('throws on a non-200 and carries the status', async () => {
    const { fetchImpl } = fakeFetch(async () => response(500, 'upstream exploded'))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    const err = await rejection(() => provider.propose(BRIEF))
    expect(err.message).toMatch(/answered 500/)
    // The upstream body is vendor-controlled text; it must not be echoed onward.
    expect(err.message).not.toContain('upstream exploded')
  })

  it('throws on 401 from a bad key without naming the key', async () => {
    const { fetchImpl } = fakeFetch(async () =>
      response(401, JSON.stringify({ error: { message: `invalid key ${API_KEY}` } })),
    )
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    const err = await rejection(() => provider.propose(BRIEF))
    expect(err.message).toMatch(/rejected the credential/)
    expect(err.message).not.toContain(API_KEY)
  })

  it('throws on 429', async () => {
    const { fetchImpl } = fakeFetch(async () => response(429, ''))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/rate limited/)
  })

  it('aborts via AbortController and reports the timeout', async () => {
    const { fetchImpl, calls } = fakeFetch(
      (call) =>
        new Promise<LlmFetchResponse>((_resolve, reject) => {
          call.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl, timeoutMs: 10 })

    const err = await rejection(() => provider.propose(BRIEF))
    expect(err.message).toMatch(/timed out after 10ms/)
    expect(calls[0].signal.aborted).toBe(true)
  })

  it('throws when fetch rejects, without repeating the underlying error', async () => {
    // Some runtimes attach the outgoing request — and therefore the header — to the error
    // they reject with. Interpolating it would leak the key into a log line.
    const { fetchImpl } = fakeFetch(async () => {
      throw new Error(`socket hang up while sending x-api-key: ${API_KEY}`)
    })
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    const err = await rejection(() => provider.propose(BRIEF))
    expect(err.message).toMatch(/failed before a response arrived/)
    expect(err.message).not.toContain(API_KEY)
  })

  it('throws when the body is not JSON', async () => {
    const { fetchImpl } = fakeFetch(async () => response(200, '<html>gateway</html>'))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/was not JSON/)
  })

  it('throws when the body cannot be read at all', async () => {
    const { fetchImpl } = fakeFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('stream closed')
      },
    }))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/could not read the response body/)
  })
})

// --- envelope failures --------------------------------------------------------------------

describe('response envelope', () => {
  it('throws on a refusal', async () => {
    const { fetchImpl } = fakeFetch(async () =>
      envelope(null, { content: [], stop_reason: 'refusal' }),
    )
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/declined to answer/)
  })

  it('throws when the answer was truncated at max_tokens', async () => {
    const { fetchImpl } = fakeFetch(async () =>
      envelope({ milestones: baseDrafts() }, { stop_reason: 'max_tokens' }),
    )
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/truncated/)
  })

  it('throws when the envelope is not an object', async () => {
    const { fetchImpl } = fakeFetch(async () => response(200, '"just a string"'))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/not a JSON object/)
  })

  it('throws when there is no content array', async () => {
    const { fetchImpl } = fakeFetch(async () => response(200, JSON.stringify({ id: 'msg_01' })))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/no content array/)
  })

  it('throws when no text block is present', async () => {
    const { fetchImpl } = fakeFetch(async () =>
      envelope(null, { content: [{ type: 'thinking', thinking: '' }] }),
    )
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/no text block/)
  })

  it('throws on a prose answer where structured output was requested', async () => {
    const { fetchImpl } = fakeFetch(async () =>
      response(
        200,
        JSON.stringify({
          content: [{ type: 'text', text: "Sure! Here's how I'd split the work: first..." }],
          stop_reason: 'end_turn',
        }),
      ),
    )
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose(BRIEF)).rejects.toThrow(/prose where structured output/)
  })
})

// --- payload shape ------------------------------------------------------------------------

describe('payload shape', () => {
  it('throws when the payload is not a list of milestones', async () => {
    await expect(providerReturning({ result: 'ok' }).propose()).rejects.toThrow(
      /not an array of milestones/,
    )
  })

  const countCases: Array<[string, number]> = [
    ['too few', 2],
    ['too many', 9],
  ]

  it.each(countCases)('throws when there are %s drafts', async (_label, count) => {
    const drafts = Array.from({ length: count }, () => ({ ...baseDrafts()[0], amount: '1' }))
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /expected 3-8 milestones/,
    )
  })

  it('throws when a milestone is not an object', async () => {
    await expect(
      providerReturning({ milestones: ['a milestone', ...baseDrafts()] }).propose(),
    ).rejects.toThrow(/milestone 0 was not an object/)
  })
})

// --- strings ------------------------------------------------------------------------------

describe('titles and rationales', () => {
  const stringCases: Array<[string, RawDraft, RegExp]> = [
    ['a missing title', { title: undefined }, /title must be a string/],
    ['a non-string title', { title: 42 }, /title must be a string/],
    ['an empty title', { title: '   ' }, /title must not be empty/],
    ['a runaway title', { title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }, /title exceeds/],
    ['an empty rationale', { rationale: '' }, /rationale must not be empty/],
    [
      'a runaway rationale',
      { rationale: 'y'.repeat(MAX_RATIONALE_LENGTH + 1) },
      /rationale exceeds/,
    ],
  ]

  it.each(stringCases)('rejects %s', async (_label, patch, matcher) => {
    await expect(
      providerReturning({ milestones: draftsWith(1, patch) }).propose(),
    ).rejects.toThrow(matcher)
  })

  it('accepts a title exactly at the cap', async () => {
    const title = 'z'.repeat(MAX_TITLE_LENGTH)
    const drafts = draftsWith(0, { title })
    const result = (await providerReturning({ milestones: drafts }).propose()) as Array<{
      title: string
    }>
    expect(result[0].title).toBe(title)
  })
})

// --- check kinds and criteria ---------------------------------------------------------------

describe('check kinds and C3 criteria', () => {
  it('rejects a check kind that is not one of the three legal ones', async () => {
    const drafts = draftsWith(0, { check: 'manualReview', criteria: approvalCriteria() })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /check must be one of http, github, clientApproval/,
    )
  })

  it("rejects criteria whose check disagrees with the draft's", async () => {
    // The verifier will be asked to run exactly this object. Disagreement means the two
    // parties are agreeing to different things.
    const drafts = draftsWith(1, { check: 'http', criteria: githubCriteria() })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /criteria.check is github but the milestone check is http/,
    )
  })

  it('rejects criteria that is not an object', async () => {
    await expect(
      providerReturning({ milestones: draftsWith(1, { criteria: 'looks good' }) }).propose(),
    ).rejects.toThrow(/criteria was not an object/)
  })

  it('rejects criteria with the wrong version', async () => {
    const drafts = draftsWith(1, { criteria: { ...httpCriteria(), v: 2 } })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /criteria.v must be 1/,
    )
  })

  it('rejects an unknown field on criteria, because criteriaHash commits to it', async () => {
    const drafts = draftsWith(1, { criteria: { ...httpCriteria(), severity: 'high' } })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /unknown field "severity"/,
    )
  })

  it('rejects criteria carrying both blocks', async () => {
    const drafts = draftsWith(1, {
      criteria: { ...httpCriteria(), github: githubCriteria().github },
    })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /carries a github block for an http check/,
    )
  })

  it('rejects criteria missing its matching block', async () => {
    const drafts = draftsWith(1, {
      criteria: { v: 1, title: 'Live', check: 'http' },
    })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /missing its http block/,
    )
  })

  it('rejects a clientApproval criteria that smuggles in a check block', async () => {
    const drafts = draftsWith(0, {
      criteria: { ...approvalCriteria(), http: httpCriteria().http },
    })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /check block for a clientApproval check/,
    )
  })

  const httpCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a non-http url', { url: 'file:///etc/passwd' }, /must be an http\(s\) URL/],
    ['an empty url', { url: '' }, /url must not be empty/],
    ['a nonsense status', { expectStatus: 42 }, /expectStatus must be an HTTP status code/],
    ['a fractional status', { expectStatus: 200.5 }, /expectStatus must be an HTTP status code/],
    ['a zero timeout', { timeoutMs: 0 }, /timeoutMs must be 1-60000/],
    ['an absurd timeout', { timeoutMs: 600_000 }, /timeoutMs must be 1-60000/],
    ['mustContain not an array', { mustContain: 'Pricing' }, /mustContain must be an array/],
    ['a non-string phrase', { mustContain: [7] }, /mustContain\[0\] must be a string/],
    ['an unknown http field', { followRedirects: true }, /unknown field "followRedirects"/],
  ]

  it.each(httpCases)('rejects an http block with %s', async (_label, patch, matcher) => {
    const criteria = httpCriteria()
    const drafts = draftsWith(1, {
      criteria: { ...criteria, http: { ...criteria.http, ...patch } },
    })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(matcher)
  })

  const githubCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a repo that is not owner/name', { repo: 'site' }, /repo must be owner\/name/],
    ['an empty ref', { ref: '' }, /ref must not be empty/],
    ['a non-boolean requireCommit', { requireCommit: 'yes' }, /requireCommit must be a boolean/],
    ['a negative minStars', { minStars: -1 }, /minStars must be a non-negative integer or null/],
    [
      'a non-integer minStars',
      { minStars: 1.5 },
      /minStars must be a non-negative integer or null/,
    ],
    ['an unknown github field', { org: 'acme' }, /unknown field "org"/],
  ]

  it.each(githubCases)('rejects a github block with %s', async (_label, patch, matcher) => {
    const criteria = githubCriteria()
    const drafts = draftsWith(2, {
      criteria: { ...criteria, github: { ...criteria.github, ...patch } },
    })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(matcher)
  })

  it('accepts a github block with the nullable fields null', async () => {
    const drafts = draftsWith(2, {
      criteria: {
        ...githubCriteria(),
        github: {
          repo: 'acme/site',
          ref: 'main',
          requireCommit: true,
          requireCheckRun: null,
          minStars: null,
        },
      },
    })
    const result = (await providerReturning({ milestones: drafts }).propose()) as Array<{
      criteria: Criteria
    }>
    expect(result[2].criteria.github).toEqual({
      repo: 'acme/site',
      ref: 'main',
      requireCommit: true,
      requireCheckRun: null,
      minStars: null,
    })
  })
})

// --- money ----------------------------------------------------------------------------------

describe('amounts', () => {
  const badAmounts: Array<[string, string]> = [
    ['hex', '0x1bc16d674ec80000'],
    ['exponent notation', '2e18'],
    ['a decimal point', '2000000000000000000.0'],
    ['a minus sign', '-2000000000000000000'],
    ['a leading plus', '+2000000000000000000'],
    ['whitespace', ' 2000000000000000000'],
    ['separators', '2_000_000_000_000_000_000'],
    ['a bigint literal suffix', '2000000000000000000n'],
    ['an empty string', ''],
    ['a leading zero', '02000000000000000000'],
  ]

  it.each(badAmounts)('rejects an amount written as %s', async (_label, amount) => {
    const drafts = draftsWith(0, { amount })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /amount must (be decimal digits only|not have leading zeros|not be empty)/,
    )
  })

  it('rejects a non-string amount', async () => {
    const drafts = draftsWith(0, { amount: 2e18 })
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /amount must be a decimal string/,
    )
  })

  it('rejects a zero amount', async () => {
    // Two drafts of 3e18 and one of 0 still sums to the total; zero is rejected on its own
    // terms, because a milestone worth nothing is not a milestone.
    const drafts = baseDrafts()
    drafts[0].amount = '0'
    drafts[1].amount = '3000000000000000000'
    drafts[2].amount = '3000000000000000000'
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /amount must be greater than zero/,
    )
  })

  it('rejects a total the caller passed in a bad shape, before spending a request', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => envelope({ milestones: baseDrafts() }))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose({ ...BRIEF, totalAmount: '6.0' })).rejects.toThrow(
      /totalAmount must be decimal digits only/,
    )
    expect(calls).toHaveLength(0)
  })

  const offByOne: Array<[string, string]> = [
    ['one wei over', '2000000000000000001'],
    ['one wei under', '1999999999999999999'],
  ]

  it.each(offByOne)('rejects a split that is %s, rather than rescaling it', async (_label, third) => {
    const drafts = draftsWith(2, { amount: third })
    const { propose, calls } = providerReturning({ milestones: drafts })

    const err = await rejection(propose)
    // A split adjusted here is a number neither party saw, and the create transaction would
    // revert with FundingMismatch. Reject, and let the caller fall back to the template.
    expect(err.message).toMatch(/sum to \d+ wei, expected exactly 6000000000000000000 wei/)
    expect(calls).toHaveLength(1)
  })

  it('rejects a wildly wrong sum with the same refusal, not a best effort', async () => {
    const drafts = baseDrafts().map((d) => ({ ...d, amount: '1' }))
    await expect(providerReturning({ milestones: drafts }).propose()).rejects.toThrow(
      /sum to 3 wei, expected exactly 6000000000000000000 wei/,
    )
  })
})

// --- brief input -------------------------------------------------------------------------

describe('brief input', () => {
  it('refuses to construct a provider with no credential', () => {
    const { fetchImpl } = fakeFetch(async () => envelope({ milestones: baseDrafts() }))
    expect(() => createAnthropicProvider({ apiKey: '', fetchImpl })).toThrow(
      /a credential is required/,
    )
  })

  it('rejects an empty brief without calling the API', async () => {
    const { fetchImpl, calls } = fakeFetch(async () => envelope({ milestones: baseDrafts() }))
    const provider = createAnthropicProvider({ apiKey: API_KEY, fetchImpl })
    await expect(provider.propose({ ...BRIEF, brief: '   ' })).rejects.toThrow(/brief is empty/)
    expect(calls).toHaveLength(0)
  })
})

// --- the key never escapes ------------------------------------------------------------------

describe('the credential never appears in a thrown error', () => {
  it('holds across every failure mode, in the message and in the serialised form', async () => {
    const failures: Array<() => Promise<unknown>> = [
      // Transport rejection whose own message embeds the key.
      () => {
        const { fetchImpl } = fakeFetch(async () => {
          throw new Error(`ECONNRESET (x-api-key: ${API_KEY})`)
        })
        return createAnthropicProvider({ apiKey: API_KEY, fetchImpl }).propose(BRIEF)
      },
      // Upstream error page echoing the key back.
      () => {
        const { fetchImpl } = fakeFetch(async () => response(401, `bad key: ${API_KEY}`))
        return createAnthropicProvider({ apiKey: API_KEY, fetchImpl }).propose(BRIEF)
      },
      () => {
        const { fetchImpl } = fakeFetch(async () => response(500, `trace ${API_KEY}`))
        return createAnthropicProvider({ apiKey: API_KEY, fetchImpl }).propose(BRIEF)
      },
      // Non-JSON body containing the key.
      () => {
        const { fetchImpl } = fakeFetch(async () => response(200, `<html>${API_KEY}</html>`))
        return createAnthropicProvider({ apiKey: API_KEY, fetchImpl }).propose(BRIEF)
      },
      // A model that parroted the key back into a field we validate.
      () => providerReturning({ milestones: draftsWith(0, { title: API_KEY, amount: '1' }) })
        .propose(),
      // Timeout.
      () => {
        const { fetchImpl } = fakeFetch(
          (call) =>
            new Promise<LlmFetchResponse>((_r, reject) => {
              call.signal.addEventListener('abort', () => reject(new Error(API_KEY)))
            }),
        )
        return createAnthropicProvider({ apiKey: API_KEY, fetchImpl, timeoutMs: 5 }).propose(BRIEF)
      },
      // Sum mismatch.
      () => providerReturning({ milestones: draftsWith(0, { amount: '1' }) }).propose(),
    ]

    // Every 8-character window of the key, so a partial leak fails too.
    const shards: string[] = []
    for (let i = 0; i + 8 <= API_KEY.length; i++) shards.push(API_KEY.slice(i, i + 8))

    for (const run of failures) {
      const err = await rejection(run)
      const surfaces = [
        err.message,
        String(err),
        err.stack ?? '',
        JSON.stringify(err),
        JSON.stringify(err, Object.getOwnPropertyNames(err)),
      ].join('\n')

      expect(surfaces).not.toContain(API_KEY)
      for (const shard of shards) expect(surfaces).not.toContain(shard)
    }
  })
})
