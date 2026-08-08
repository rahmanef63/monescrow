/**
 * C7 route tests.
 *
 * Every test here protects one of the three promises the route makes: the credential order is
 * the contract, no credential problem is ever an error status, and the amounts add up to the
 * wei. Nothing touches the network — the LLM provider is always a fake, because the point of
 * these tests is the route's decisions, not Anthropic's.
 */

import { describe, expect, it } from 'vitest'
import { MAX_BRIEF_CHARS, POST, handleMilestones } from '@/app/api/ai/milestones/route'
import type { MilestonesDeps } from '@/app/api/ai/milestones/route'
import { templateProvider } from '@/lib/ai/template'
import type { Credential, MilestoneDraft, MilestoneProvider } from '@/lib/ai/types'
import type { HeadersLike } from '@/lib/ai/provider'

/** 6 MON. Past Number.MAX_SAFE_INTEGER, which is the entire reason amounts are strings. */
const SIX_MON = '6000000000000000000'

/** The user's key. Appears in a header and in test assertions, and must appear nowhere else. */
const USER_KEY = 'sk-ant-user-SUPERSECRET-do-not-leak-0123456789'
const ENV_KEY = 'sk-ant-env-SELFHOSTED-also-secret-9876543210'

function headers(init: Record<string, string> = {}): HeadersLike {
  return new Headers(init)
}

function body(over: Record<string, unknown> = {}): unknown {
  return { brief: 'Build a landing page.', totalAmount: SIX_MON, currency: 'MON', ...over }
}

/** A structurally valid draft. Only the amount matters to the route. */
function draft(title: string, amount: string): MilestoneDraft {
  return {
    title,
    amount,
    check: 'clientApproval',
    criteria: { v: 1, title, check: 'clientApproval' },
    rationale: 'because the test says so',
  }
}

/** An LLM provider that returns exactly these drafts. */
function llmProvider(drafts: MilestoneDraft[]): MilestoneProvider {
  return { name: 'llm', async propose(): Promise<MilestoneDraft[]> { return drafts } }
}

/** The same, as the factory shape `ProviderDeps.llm` expects. */
function llmReturning(drafts: MilestoneDraft[]): (credential: Credential) => MilestoneProvider {
  return () => llmProvider(drafts)
}

function deps(over: Partial<MilestonesDeps> = {}): MilestonesDeps {
  return {
    env: {},
    template: templateProvider,
    llm: () => ({
      name: 'llm',
      async propose(): Promise<MilestoneDraft[]> {
        throw new Error('the test did not expect the llm path to run')
      },
    }),
    ...over,
  }
}

function sumOf(drafts: MilestoneDraft[]): bigint {
  return drafts.reduce((acc, d) => acc + BigInt(d.amount), 0n)
}

/* ------------------------------------------------------------------ credential order */

describe('credential resolution', () => {
  it('uses the x-llm-key header when the user supplies one, and reports source "llm"', async () => {
    // Property: rung 1 of the ladder. A key the user pasted for this one request is used for
    // this one request, and the response says which path actually ran.
    const seen: string[] = []
    const res = await handleMilestones(
      body(),
      headers({ 'x-llm-key': USER_KEY }),
      deps({
        llm: (credential: Credential) => {
          seen.push(credential.value)
          return llmProvider([draft('a', '2000000000000000000'), draft('b', '4000000000000000000')])
        },
      }),
    )

    expect(seen).toEqual([USER_KEY])
    expect(res.status).toBe(200)
    if (res.status !== 200) return
    expect(res.body.source).toBe('llm')
    expect(sumOf(res.body.milestones)).toBe(BigInt(SIX_MON))
  })

  it('matches the header case-insensitively, because HTTP header names are not case-sensitive', async () => {
    // Property: a client that sends `X-LLM-Key` is not silently downgraded to the template.
    const seen: string[] = []
    const res = await handleMilestones(
      body(),
      headers({ 'X-LLM-Key': USER_KEY }),
      deps({
        llm: (credential: Credential) => {
          seen.push(credential.value)
          return llmProvider([draft('only', SIX_MON)])
        },
      }),
    )
    expect(seen).toEqual([USER_KEY])
    expect(res.status).toBe(200)
    if (res.status === 200) expect(res.body.source).toBe('llm')
  })

  it('falls back to ANTHROPIC_API_KEY from env when no header is supplied', async () => {
    // Property: rung 2. Self-hosting works without every visitor pasting a key.
    const seen: string[] = []
    const res = await handleMilestones(
      body(),
      headers(),
      deps({
        env: { ANTHROPIC_API_KEY: ENV_KEY },
        llm: (credential: Credential) => {
          seen.push(credential.value)
          return llmProvider([draft('only', SIX_MON)])
        },
      }),
    )
    expect(seen).toEqual([ENV_KEY])
    expect(res.status).toBe(200)
    if (res.status === 200) expect(res.body.source).toBe('llm')
  })

  it('prefers the header over env when both are present', async () => {
    // Property: the order is header, then env — the user's own key wins on their own request.
    const seen: string[] = []
    await handleMilestones(
      body(),
      headers({ 'x-llm-key': USER_KEY }),
      deps({
        env: { ANTHROPIC_API_KEY: ENV_KEY },
        llm: (credential: Credential) => {
          seen.push(credential.value)
          return llmProvider([draft('only', SIX_MON)])
        },
      }),
    )
    expect(seen).toEqual([USER_KEY])
  })

  it('uses the template when there is no credential anywhere', async () => {
    // Property: rung 3, and the one that decides whether the demo works at all. No key, no env,
    // no network — still 200, still drafts.
    const res = await handleMilestones(body(), headers(), deps())

    expect(res.status).toBe(200)
    if (res.status !== 200) return
    expect(res.body.source).toBe('template')
    expect(res.body.milestones.length).toBeGreaterThan(0)
    expect(sumOf(res.body.milestones)).toBe(BigInt(SIX_MON))
  })

  it('treats a blank x-llm-key header as no credential rather than a bad one', async () => {
    // Property: a user who opened the key field and cleared it gets the template, not an error.
    const res = await handleMilestones(body(), headers({ 'x-llm-key': '   ' }), deps())
    expect(res.status).toBe(200)
    if (res.status === 200) expect(res.body.source).toBe('template')
  })
})

/* ------------------------------------------------------------------ never fails on a key */

describe('a credential problem is never an error status', () => {
  const brokenLlms: ReadonlyArray<readonly [string, () => MilestoneProvider]> = [
    [
      'the key is rejected (401)',
      () => ({
        name: 'llm',
        async propose(): Promise<MilestoneDraft[]> {
          throw new Error('llm provider: the model API rejected the credential')
        },
      }),
    ],
    [
      'the request is rate limited (429)',
      () => ({
        name: 'llm',
        async propose(): Promise<MilestoneDraft[]> {
          throw new Error('llm provider: the model API rate limited this request')
        },
      }),
    ],
    [
      'the call times out',
      () => ({
        name: 'llm',
        async propose(): Promise<MilestoneDraft[]> {
          throw new Error('llm provider: request timed out after 60000ms')
        },
      }),
    ],
    [
      'the model answers prose instead of JSON',
      () => ({
        name: 'llm',
        // Prose is not a draft array; `provider.ts` rejects the shape without throwing.
        async propose(): Promise<MilestoneDraft[]> {
          return 'here are your milestones!' as unknown as MilestoneDraft[]
        },
      }),
    ],
    [
      'the provider factory itself throws',
      () => {
        throw new Error('llm provider: a credential is required to construct it')
      },
    ],
  ]

  for (const [label, llm] of brokenLlms) {
    it(`still returns 200 from the template when ${label}`, async () => {
      // Property: the whole point of rule 3. Every way the LLM path can go wrong is a degraded
      // result, never an error page — the client still gets an editable split.
      const res = await handleMilestones(
        body(),
        headers({ 'x-llm-key': USER_KEY }),
        deps({ llm }),
      )

      expect(res.status).toBe(200)
      if (res.status !== 200) return
      expect(res.body.source).toBe('template')
      expect(sumOf(res.body.milestones)).toBe(BigInt(SIX_MON))
    })
  }
})

/* ------------------------------------------------------------------ body validation */

describe('body validation is the only 400', () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['a body that is not an object', 'brief'],
    ['a body that is an array', [{ brief: '', totalAmount: SIX_MON, currency: 'MON' }]],
    ['a null body', null],
    ['brief missing', { totalAmount: SIX_MON, currency: 'MON' }],
    ['brief as a number', body({ brief: 42 })],
    ['brief as null', body({ brief: null })],
    ['brief past the cap', body({ brief: 'x'.repeat(MAX_BRIEF_CHARS + 1) })],
    ['totalAmount missing', { brief: '', currency: 'MON' }],
    // A JSON number has already lost the low digits of 6e18 by the time we see it.
    ['totalAmount as a number', body({ totalAmount: 6e18 })],
    ['totalAmount in hex', body({ totalAmount: '0x53444835ec580000' })],
    ['totalAmount in exponent form', body({ totalAmount: '6e18' })],
    ['totalAmount with a decimal point', body({ totalAmount: '6.0' })],
    ['totalAmount negative', body({ totalAmount: '-1' })],
    ['totalAmount with leading zeros', body({ totalAmount: '06' })],
    ['totalAmount with surrounding space', body({ totalAmount: ' 6 ' })],
    ['totalAmount zero', body({ totalAmount: '0' })],
    ['totalAmount above uint256', body({ totalAmount: (2n ** 256n).toString() })],
    ['currency missing', { brief: '', totalAmount: SIX_MON }],
    ['currency of the wrong case', body({ currency: 'mon' })],
    ['currency of another token', body({ currency: 'ETH' })],
    ['currency as a number', body({ currency: 1 })],
  ]

  for (const [label, bad] of malformed) {
    it(`rejects ${label} with 400`, async () => {
      // Property: a body we cannot read is the one and only client error this endpoint has.
      const res = await handleMilestones(bad, headers(), deps())
      expect(res.status).toBe(400)
      if (res.status !== 400) return
      expect(typeof res.body.error).toBe('string')
      expect(res.body.error.length).toBeGreaterThan(0)
    })
  }

  it('accepts an empty brief and returns 4-5 milestones summing exactly', async () => {
    // Property: an empty brief is legal, not malformed. The template turns nothing at all into
    // a usable starting point, and the arithmetic is still exact to the wei.
    const res = await handleMilestones(
      { brief: '', totalAmount: SIX_MON, currency: 'MON' },
      headers(),
      deps(),
    )

    expect(res.status).toBe(200)
    if (res.status !== 200) return
    expect(res.body.source).toBe('template')
    expect(res.body.milestones.length).toBeGreaterThanOrEqual(4)
    expect(res.body.milestones.length).toBeLessThanOrEqual(5)
    expect(sumOf(res.body.milestones)).toBe(BigInt(SIX_MON))
    // Every amount is fundable: a zero-amount milestone reverts `ZeroMilestoneAmount`.
    for (const m of res.body.milestones) expect(BigInt(m.amount) > 0n).toBe(true)
  })

  it('does not quote the request back in a validation error', async () => {
    // Property: error strings travel — into consoles, proxies and bug reports. The brief is the
    // client's private commercial information and is never reflected, not even to be helpful.
    const secretBrief = 'MERGER-CODENAME-ORANGE: acquire the competitor by Q3'
    const res = await handleMilestones(
      { brief: secretBrief, totalAmount: '6.0', currency: 'MON' },
      headers({ 'x-llm-key': USER_KEY }),
      deps(),
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(res)).not.toContain('MERGER-CODENAME-ORANGE')
  })
})

/* ------------------------------------------------------------------ the sum */

describe('the sum is re-checked at the route', () => {
  it('rejects an LLM split that is one wei short and answers from the template', async () => {
    // Property: defence in depth. `anthropic.ts` validates the sum and the route does not take
    // that on trust — a split one wei off is a create transaction that reverts FundingMismatch
    // after the user has already signed it.
    const short = [draft('a', '2000000000000000000'), draft('b', '3999999999999999999')]
    const res = await handleMilestones(
      body(),
      headers({ 'x-llm-key': USER_KEY }),
      deps({ llm: llmReturning(short) }),
    )

    expect(res.status).toBe(200)
    if (res.status !== 200) return
    expect(res.body.source).toBe('template')
    expect(sumOf(res.body.milestones)).toBe(BigInt(SIX_MON))
    expect(res.body.milestones).not.toEqual(short)
  })

  it('rejects an LLM split that is one wei over', async () => {
    // Property: over is as bad as under. The contract is exact equality, not "close enough".
    const over = [draft('a', '2000000000000000000'), draft('b', '4000000000000000001')]
    const res = await handleMilestones(
      body(),
      headers({ 'x-llm-key': USER_KEY }),
      deps({ llm: llmReturning(over) }),
    )
    expect(res.status).toBe(200)
    if (res.status === 200) expect(res.body.source).toBe('template')
  })

  it('rejects an LLM split containing a zero amount even though it sums correctly', async () => {
    // Property: a zero-amount milestone reverts `ZeroMilestoneAmount`, so a correct sum is not
    // sufficient. The split has to be fundable, not merely arithmetically tidy.
    const withZero = [draft('a', SIX_MON), draft('b', '0')]
    const res = await handleMilestones(
      body(),
      headers({ 'x-llm-key': USER_KEY }),
      deps({ llm: llmReturning(withZero) }),
    )
    expect(res.status).toBe(200)
    if (res.status === 200) expect(res.body.source).toBe('template')
  })

  it('does not lose precision on a total past Number.MAX_SAFE_INTEGER', async () => {
    // Property: the check is BigInt end to end. These two amounts differ from the total by one
    // wei, a difference a float comparison cannot see at 1e18.
    const total = '9007199254740993000000000000'
    const nearly = [draft('a', '9007199254740993000000000000'), draft('b', '1')]
    const res = await handleMilestones(
      body({ totalAmount: total }),
      headers({ 'x-llm-key': USER_KEY }),
      deps({ llm: llmReturning(nearly) }),
    )
    expect(res.status).toBe(200)
    if (res.status !== 200) return
    expect(res.body.source).toBe('template')
    expect(sumOf(res.body.milestones)).toBe(BigInt(total))
  })

  it('accepts an exact LLM split unchanged', async () => {
    // Property: the route validates, it does not rewrite. A provider that adds up correctly has
    // its drafts passed through verbatim.
    const exact = [draft('a', '1'), draft('b', '5999999999999999999')]
    const res = await handleMilestones(
      body(),
      headers({ 'x-llm-key': USER_KEY }),
      deps({ llm: llmReturning(exact) }),
    )
    expect(res.status).toBe(200)
    if (res.status !== 200) return
    expect(res.body.milestones).toEqual(exact)
    expect(res.body.source).toBe('llm')
  })

  it('returns 502 rather than an unfundable split when our own template is the broken one', async () => {
    // Property: the floor of the ladder has no fallback beneath it. If the deterministic parser
    // is wrong, that is our bug — and shipping drafts that would revert the create transaction
    // is worse than admitting it. Unreachable through any credential problem.
    const res = await handleMilestones(
      body(),
      headers(),
      deps({
        template: {
          name: 'template',
          async propose(): Promise<MilestoneDraft[]> {
            return [draft('wrong', '1')]
          },
        },
      }),
    )
    expect(res.status).toBe(502)
  })

  it('returns 502 when the template throws, instead of a 200 with nothing in it', async () => {
    // Property: a broken offline parser must be visible, not silently rendered as an empty list.
    const res = await handleMilestones(
      body(),
      headers(),
      deps({
        template: {
          name: 'template',
          async propose(): Promise<MilestoneDraft[]> {
            throw new Error('template exploded')
          },
        },
      }),
    )
    expect(res.status).toBe(502)
  })
})

/* ------------------------------------------------------------------ the key never escapes */

describe('the user key never appears in a response', () => {
  it('is absent from every serialised response, on every path', async () => {
    // Property: the single hardest rule in C7. The key is held in memory for one request and
    // never persisted, logged or echoed — so it must not survive `JSON.stringify` of any
    // response the endpoint can produce, including the error ones.
    const withKey = headers({ 'x-llm-key': USER_KEY })

    // An SDK error that quotes the request headers it just sent. This is the realistic leak:
    // the key rides inside the error message, and any handler that reports the error reports
    // the key with it.
    const leakyLlm = () => ({
      name: 'llm' as const,
      async propose(): Promise<MilestoneDraft[]> {
        throw new Error(`request failed: POST /v1/messages headers={"x-api-key":"${USER_KEY}"}`)
      },
    })

    const responses = await Promise.all([
      // 200 from the template, with a key present.
      handleMilestones(body(), withKey, deps({ llm: leakyLlm })),
      // 200 from the LLM.
      handleMilestones(body(), withKey, deps({ llm: llmReturning([draft('one', SIX_MON)]) })),
      // 200 after a rejected sum.
      handleMilestones(body(), withKey, deps({ llm: llmReturning([draft('one', '1')]) })),
      // 400, malformed body, key present.
      handleMilestones(body({ currency: 'ETH' }), withKey, deps({ llm: leakyLlm })),
      // 400, with the key also pasted into the body by a confused client.
      handleMilestones(
        { brief: `here is my key ${USER_KEY}`, totalAmount: '6.0', currency: 'MON' },
        withKey,
        deps({ llm: leakyLlm }),
      ),
      // 502, our own template broken, key present.
      handleMilestones(
        body(),
        withKey,
        deps({
          llm: leakyLlm,
          template: {
            name: 'template',
            async propose(): Promise<MilestoneDraft[]> {
              throw new Error('template exploded')
            },
          },
        }),
      ),
      // Env-supplied key, LLM leaking it in an error.
      handleMilestones(
        body(),
        headers(),
        deps({ env: { ANTHROPIC_API_KEY: ENV_KEY }, llm: leakyLlm }),
      ),
    ])

    for (const res of responses) {
      const serialised = JSON.stringify(res)
      expect(serialised).not.toContain(USER_KEY)
      expect(serialised).not.toContain(ENV_KEY)
      // Not even a fragment: a "sk-ant-…" prefix in a response is a leak in progress.
      expect(serialised).not.toContain('sk-ant-')
    }
  })

  it('is absent from the body of a real Response produced by POST', async () => {
    // Property: the same guarantee at the HTTP seam, not just at the pure function. This path
    // never reaches a provider — the body is not JSON — so it runs with no network and no env.
    const request = new Request('https://example.invalid/api/ai/milestones', {
      method: 'POST',
      headers: { 'x-llm-key': USER_KEY, 'content-type': 'application/json' },
      body: 'not json at all',
    })

    const res = await POST(request)
    const text = await res.text()

    expect(res.status).toBe(400)
    expect(text).not.toContain(USER_KEY)
    expect(text).not.toContain('sk-ant-')
    expect(JSON.parse(text)).toEqual({ error: 'request body is not valid JSON' })
  })

  it('does not echo the key in the milestones themselves', async () => {
    // Property: the drafts are rendered straight into the review page. A provider that folded
    // the credential into a rationale would leak it through a 200, which no error-path guard
    // would catch — so the assertion is over the whole successful response too.
    const res = await handleMilestones(
      body({ brief: 'Ship the API. Repo is acme/widgets.' }),
      headers({ 'x-llm-key': USER_KEY }),
      deps(),
    )
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain(USER_KEY)
  })
})
