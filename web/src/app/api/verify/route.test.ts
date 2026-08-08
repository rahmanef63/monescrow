/**
 * Tests for `handleVerify` — the composition, the ordering, and the status mapping.
 *
 * Nothing here tests what a check concludes; that belongs to `checks/*.test.ts`. What is tested
 * here is the set of properties that only exist once the modules are wired together, and every
 * one of them is a way this endpoint could quietly become dangerous:
 *
 *   - a 502 or a 422 must never carry a signature,
 *   - the chain must be consulted before any URL is fetched,
 *   - "we could not reach it" must never be reported as "your work failed",
 *   - a clientApproval milestone must never be signed as a pass.
 *
 * No network and no env: the fetch impl, the milestone reader, the clock and the key are all
 * injected. The key below is the standard Hardhat account #0 test key — public, worthless, and
 * chosen precisely so that nobody is ever tempted to paste a real one in here.
 */

import { describe, expect, it, vi } from 'vitest'
import { recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { handleVerify } from './route'
import type { VerifyDeps } from './route'
import type { MilestoneOnChain } from '../../../lib/verify/bind'
import { hashJson } from '../../../lib/verify/report'
import {
  ATTESTATION_DOMAIN_NAME,
  ATTESTATION_DOMAIN_VERSION,
  ATTESTATION_TYPES,
  DEFAULT_CHAIN_ID,
} from '../../../lib/verify/sign'
import type { Criteria, Evidence, FetchImpl } from '../../../lib/verify/types'

/** Hardhat account #0. A published test key; never a real verifier key. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const VERIFIER_ADDRESS = privateKeyToAccount(TEST_KEY).address

const ESCROW = '0x1111111111111111111111111111111111111111'
const MILESTONE = 2
const SUBMISSION = 3

/** A fixed clock in milliseconds, so `checkedAt` and every elapsed figure are deterministic. */
const NOW_MS = 1_700_000_000_000
const CHECKED_AT = 1_700_000_000

const HTTP_CRITERIA: Criteria = {
  v: 1,
  title: 'Landing page is up',
  check: 'http',
  http: {
    url: 'https://example.com/',
    expectStatus: 200,
    mustContain: ['Sign up'],
    mustNotContain: ['Lorem ipsum'],
    timeoutMs: 10_000,
  },
}

const EVIDENCE: Evidence = {
  v: 1,
  milestone: MILESTONE,
  url: 'https://example.com/',
  note: 'deployed',
  submittedAt: 1_699_000_000,
}

function body(over: Record<string, unknown> = {}): unknown {
  return {
    escrow: ESCROW,
    milestone: MILESTONE,
    submission: SUBMISSION,
    criteria: HTTP_CRITERIA,
    evidence: EVIDENCE,
    ...over,
  }
}

/** The chain's view, derived from the real hasher so a fixture can never drift from it. */
function chainSays(criteria: Criteria = HTTP_CRITERIA, over: Partial<MilestoneOnChain> = {}): MilestoneOnChain {
  return {
    criteriaHash: hashJson(criteria),
    evidenceHash: hashJson(EVIDENCE),
    submissions: SUBMISSION,
    state: 1, // Submitted — the only state `attest` accepts.
    ...over,
  }
}

/** An HTTP response good enough to satisfy HTTP_CRITERIA. */
function pageResponse(html: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => html,
  }
}

const PASSING_HTML = '<html><body><h1>Sign up</h1></body></html>'

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    fetchImpl: vi.fn(async () => pageResponse(PASSING_HTML)) as unknown as FetchImpl,
    readMilestone: vi.fn(async () => chainSays()),
    verifierKey: TEST_KEY,
    now: () => NOW_MS,
    ...over,
  }
}

describe('handleVerify — the happy path', () => {
  // Property: a passing milestone is signed, and the signature recovers to the verifier the
  // contract has on file. A signature that recovers to any other address is indistinguishable
  // from no signature at all on-chain, and nothing anywhere would say why.
  it('returns 200 with a signature that recovers to the verifier address', async () => {
    const result = await handleVerify(body(), deps())

    expect(result.status).toBe(200)
    if (result.status !== 200) return

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: ATTESTATION_DOMAIN_NAME,
        version: ATTESTATION_DOMAIN_VERSION,
        chainId: DEFAULT_CHAIN_ID,
        verifyingContract: ESCROW,
      },
      types: ATTESTATION_TYPES,
      primaryType: 'Attestation',
      message: {
        milestone: BigInt(MILESTONE),
        submission: SUBMISSION,
        passed: true,
        evidenceHash: hashJson(EVIDENCE),
        reportHash: result.body.reportHash,
      },
      signature: result.body.signature,
    })

    expect(recovered).toBe(VERIFIER_ADDRESS)
  })

  // Property: the report is C5 and its hash is the hash of the report that was returned. If the
  // body carried a hash of anything else, the off-chain reader could never reproduce it and the
  // on-chain `reportHash` would point at nothing checkable.
  it('returns a C5 report whose hash matches the report body', async () => {
    const result = await handleVerify(body(), deps())
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`)

    expect(result.body.report).toMatchObject({
      v: 1,
      escrow: ESCROW.toLowerCase(),
      milestone: MILESTONE,
      submission: SUBMISSION,
      evidenceHash: hashJson(EVIDENCE),
      criteriaHash: hashJson(HTTP_CRITERIA),
      passed: true,
      checkedAt: CHECKED_AT,
    })
    expect(hashJson(result.body.report)).toBe(result.body.reportHash)
  })

  // Property: the route supplies `checkedAt` from its injected clock, in whole seconds. A report
  // that read its own clock could not be re-derived, and a millisecond value would not match the
  // unit the rest of the system reads it as.
  it('stamps checkedAt from the injected clock, in unix seconds', async () => {
    const result = await handleVerify(body(), deps({ now: () => 1_712_345_678_999 }))
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`)
    expect(result.body.report.checkedAt).toBe(1_712_345_678)
  })
})

describe('handleVerify — 422, the milestone failed', () => {
  // Property: a check that ran and failed is the freelancer's problem, returned with the report
  // so they can see which line failed — and NOT signed. A failing attestation is a no-op
  // on-chain, so signing one gains nothing and creates a second signed artifact to reason about.
  it('returns 422 with the report and no signature when a check fails', async () => {
    const result = await handleVerify(
      body(),
      deps({
        // The server answered — with the wrong thing. That is an observation about the
        // milestone, not about the network.
        fetchImpl: vi.fn(async () => pageResponse('<html><body>under construction</body></html>')) as unknown as FetchImpl,
      }),
    )

    expect(result.status).toBe(422)
    if (result.status !== 422) return

    expect(result.body.report.passed).toBe(false)
    expect(result.body.report.checks.some((c) => !c.passed)).toBe(true)
    expect(result.body).not.toHaveProperty('signature')
    expect(result.body).not.toHaveProperty('digest')
  })

  // Property: "the site returned 500" is a failing milestone, not an unreachable target. This is
  // the exact line C6 draws, and getting it backwards would turn every broken deploy into an
  // infinite retry instead of a result the freelancer can act on.
  it('treats a 500 from the target as a failure, not as unreachable', async () => {
    const result = await handleVerify(
      body(),
      deps({ fetchImpl: vi.fn(async () => pageResponse('server error', 500)) as unknown as FetchImpl }),
    )

    expect(result.status).toBe(422)
  })
})

describe('handleVerify — clientApproval', () => {
  const CLIENT_APPROVAL: Criteria = {
    v: 1,
    title: 'Client signs off on the brand guide',
    check: 'clientApproval',
  }

  // Property: a milestone released by the client's own hand is never attested as a pass. There
  // is nothing to verify, so a passing signature here would be the verifier claiming authority
  // it does not have — the one thing this whole design exists to prevent.
  it('returns 422 with an unsigned report and never signs', async () => {
    const result = await handleVerify(
      body({ criteria: CLIENT_APPROVAL }),
      deps({ readMilestone: vi.fn(async () => chainSays(CLIENT_APPROVAL)) }),
    )

    expect(result.status).toBe(422)
    if (result.status !== 422) return

    expect(result.body.report.passed).toBe(false)
    expect(result.body.report.checks).toHaveLength(1)
    expect(result.body.report.checks[0].id).toBe('clientApproval')
    expect(result.body).not.toHaveProperty('signature')
  })

  // Property: no automated check means no request. A clientApproval milestone that fetched
  // anything would be doing work nobody asked for against a URL nobody agreed to.
  it('runs no check at all', async () => {
    const fetchImpl = vi.fn(async () => pageResponse(PASSING_HTML))
    await handleVerify(
      body({ criteria: CLIENT_APPROVAL }),
      deps({
        fetchImpl: fetchImpl as unknown as FetchImpl,
        readMilestone: vi.fn(async () => chainSays(CLIENT_APPROVAL)),
      }),
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('handleVerify — 400, malformed input', () => {
  // Property: every malformed shape is a 400, not a 500 and not a 422. A malformed body is not
  // evidence that anyone's work is incomplete, and a crash would be a 500 that C6 does not allow.
  it.each([
    ['not an object', 'a string'],
    ['a missing escrow', { ...(body() as object), escrow: undefined }],
    ['a non-address escrow', { ...(body() as object), escrow: 'nonsense' }],
    ['a negative milestone', { ...(body() as object), milestone: -1 }],
    ['a fractional milestone', { ...(body() as object), milestone: 1.5 }],
    ['a submission past uint32', { ...(body() as object), submission: 4_294_967_296 }],
    ['a missing criteria block', { ...(body() as object), criteria: undefined }],
    ['an unknown check kind', { ...(body() as object), criteria: { v: 1, title: 't', check: 'vibes' } }],
    [
      'an http criteria with no http block',
      { ...(body() as object), criteria: { v: 1, title: 't', check: 'http' } },
    ],
    [
      'a non-positive timeout',
      {
        ...(body() as object),
        criteria: { ...HTTP_CRITERIA, http: { ...HTTP_CRITERIA.http!, timeoutMs: 0 } },
      },
    ],
    ['a missing evidence block', { ...(body() as object), evidence: undefined }],
    ['evidence at the wrong version', { ...(body() as object), evidence: { ...EVIDENCE, v: 2 } }],
  ])('returns 400 for %s', async (_label, malformed) => {
    const result = await handleVerify(malformed, deps())
    expect(result.status).toBe(400)
    expect(result.body).not.toHaveProperty('signature')
  })

  // Property: a malformed body is rejected before the chain is read and before anything is
  // fetched. Validation that runs after the side effects is not validation.
  it('rejects a malformed body without reading the chain or fetching anything', async () => {
    const fetchImpl = vi.fn(async () => pageResponse(PASSING_HTML))
    const readMilestone = vi.fn(async () => chainSays())

    await handleVerify({ escrow: 'nonsense' }, deps({ fetchImpl: fetchImpl as unknown as FetchImpl, readMilestone }))

    expect(readMilestone).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('handleVerify — 400, the request does not match the chain', () => {
  const ATTACKER_CRITERIA: Criteria = {
    v: 1,
    title: 'Landing page is up',
    check: 'http',
    http: {
      url: 'https://attacker.example/always-200',
      expectStatus: 200,
      mustContain: [],
      mustNotContain: [],
      timeoutMs: 1_000,
    },
  }

  // Property: THE one. Criteria that are not the ones committed on-chain are rejected, and the
  // attacker's URL is never fetched. Without this the endpoint hands out valid verifier
  // signatures to anyone who asks, and doubles as an unauthenticated request proxy pointed at
  // anything on the internet — including whatever is reachable from inside our own network.
  it('rejects substituted criteria with 400 and never fetches the substituted URL', async () => {
    const fetchImpl = vi.fn(async () => pageResponse(PASSING_HTML))

    const result = await handleVerify(
      body({ criteria: ATTACKER_CRITERIA }),
      // The chain still says the agreed criteria. Only the request was swapped.
      deps({ fetchImpl: fetchImpl as unknown as FetchImpl, readMilestone: vi.fn(async () => chainSays()) }),
    )

    expect(result.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.body).not.toHaveProperty('signature')
  })

  // Property: the binding gate runs before the check, in this order, always. Asserting the
  // call order directly stops a future refactor from "optimising" the fetch to start first.
  it('reads the chain before it fetches anything', async () => {
    const order: string[] = []
    const readMilestone = vi.fn(async () => {
      order.push('chain')
      return chainSays()
    })
    const fetchImpl = vi.fn(async () => {
      order.push('fetch')
      return pageResponse(PASSING_HTML)
    })

    await handleVerify(body(), deps({ fetchImpl: fetchImpl as unknown as FetchImpl, readMilestone }))

    expect(order).toEqual(['chain', 'fetch'])
  })

  // Property: a stale submission is a 400, not a 422. Retrying will not help and the work is
  // not what failed — the freelancer has simply resubmitted since the request was built.
  it('rejects a stale submission with 400', async () => {
    const result = await handleVerify(
      body(),
      deps({ readMilestone: vi.fn(async () => chainSays(HTTP_CRITERIA, { submissions: SUBMISSION + 1 })) }),
    )
    expect(result.status).toBe(400)
  })

  // Property: a milestone that is not Submitted cannot be attested. Signing anyway would
  // produce a perfectly valid signature that the contract reverts on, with nothing saying why.
  it('rejects a milestone that is not in state Submitted with 400', async () => {
    const result = await handleVerify(
      body(),
      deps({ readMilestone: vi.fn(async () => chainSays(HTTP_CRITERIA, { state: 3 /* Released */ })) }),
    )
    expect(result.status).toBe(400)
  })
})

describe('handleVerify — 502, ours not theirs', () => {
  // Property: a target we could not reach is a retry, never a milestone result, and never
  // signed. This is the single worst bug this service can have if it goes the other way.
  it('returns 502 with no signature and no report when the target is unreachable', async () => {
    const result = await handleVerify(
      body(),
      deps({
        fetchImpl: vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND example.com')
        }) as unknown as FetchImpl,
      }),
    )

    expect(result.status).toBe(502)
    if (result.status !== 502) return

    expect(result.body).not.toHaveProperty('signature')
    expect(result.body).not.toHaveProperty('report')
    expect(typeof result.body.error).toBe('string')
  })

  // Property: a timeout is ours. Our own clock running out says nothing about whether the work
  // was done, so it must not be recorded on-chain as somebody's milestone being incomplete.
  it('returns 502 when our own timeout fires', async () => {
    const result = await handleVerify(
      body({ criteria: { ...HTTP_CRITERIA, http: { ...HTTP_CRITERIA.http!, timeoutMs: 5 } } }),
      deps({
        // Bind against the criteria as actually sent, so the timeout — not a mismatch — is
        // what this test observes.
        readMilestone: vi.fn(async () =>
          chainSays({ ...HTTP_CRITERIA, http: { ...HTTP_CRITERIA.http!, timeoutMs: 5 } }),
        ),
        fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
          })) as unknown as FetchImpl,
      }),
    )

    expect(result.status).toBe(502)
  })

  // Property: a chain read failure is ours too. A node that is down, rate-limited or answering
  // garbage tells us nothing about the freelancer, so it must never become a 422.
  it('returns 502 when the milestone cannot be read from chain', async () => {
    const fetchImpl = vi.fn(async () => pageResponse(PASSING_HTML))

    const result = await handleVerify(
      body(),
      deps({
        fetchImpl: fetchImpl as unknown as FetchImpl,
        readMilestone: vi.fn(async () => {
          throw new Error('HTTP request failed: 429 Too Many Requests')
        }),
      }),
    )

    expect(result.status).toBe(502)
    expect(result.body).not.toHaveProperty('signature')
    // And it never got as far as touching the target.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Property: a reader that returns a shape we cannot trust is also a 502. Comparing our hash
  // against garbage and calling the difference a criteria mismatch would blame the caller for
  // our own broken decoding.
  it('returns 502 when the reader returns a malformed milestone', async () => {
    const result = await handleVerify(
      body(),
      deps({
        readMilestone: vi.fn(async () => ({ ...chainSays(), criteriaHash: '0xdeadbeef' as `0x${string}` })),
      }),
    )
    expect(result.status).toBe(502)
  })

  // Property: our signing key being missing or malformed is our configuration problem, so it is
  // a 502 — and the error must not name or echo the key. A key that reaches a log is burned.
  it('returns 502 without leaking key material when the key is unusable', async () => {
    const result = await handleVerify(body(), deps({ verifierKey: 'not-a-key-at-all' }))

    expect(result.status).toBe(502)
    if (result.status !== 502) return

    expect(result.body.error).not.toContain('not-a-key-at-all')
    expect(result.body.error).not.toContain('VERIFIER_PRIVATE_KEY')
    expect(result.body).not.toHaveProperty('signature')
  })
})

describe('handleVerify — the github path', () => {
  const GH_CRITERIA: Criteria = {
    v: 1,
    title: 'Tagged release is on GitHub',
    check: 'github',
    github: {
      repo: 'acme/widget',
      ref: 'v1.0.0',
      requireCommit: true,
      requireCheckRun: null,
      minStars: null,
    },
  }

  function ghDeps(response: ReturnType<typeof pageResponse>): VerifyDeps {
    return deps({
      fetchImpl: vi.fn(async () => response) as unknown as FetchImpl,
      readMilestone: vi.fn(async () => chainSays(GH_CRITERIA)),
    })
  }

  // Property: the github kind is dispatched to the github module and a pass is signed like any
  // other. The dispatch is the only thing under test — what a commit lookup proves is
  // github.test.ts's business.
  it('signs a passing github check', async () => {
    const result = await handleVerify(body({ criteria: GH_CRITERIA }), ghDeps(pageResponse('{"sha":"abc"}')))
    expect(result.status).toBe(200)
  })

  // Property: a rate limit on OUR API token is a 502. It is our budget running out, and
  // recording it as the freelancer's milestone being incomplete would be a lie with money on it.
  it('returns 502 when GitHub rate-limits our own token', async () => {
    const throttled = {
      ok: false,
      status: 403,
      headers: {
        get: (name: string) => (name === 'x-ratelimit-remaining' ? '0' : null),
      },
      text: async () => '{"message":"API rate limit exceeded"}',
    }

    const result = await handleVerify(
      body({ criteria: GH_CRITERIA }),
      ghDeps(throttled as unknown as ReturnType<typeof pageResponse>),
    )

    expect(result.status).toBe(502)
    expect(result.body).not.toHaveProperty('signature')
  })
})
