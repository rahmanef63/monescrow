/**
 * Tests for the on-chain binding gate.
 *
 * Every test names the property it protects. The one that matters most is
 * "criteria substitution is rejected" — if that ever goes green-to-red unnoticed, this
 * endpoint becomes a machine that hands out verifier signatures to anyone who asks.
 *
 * No network here, and no mock of `hashJson` either: the whole point is that the hash the
 * gate computes is the *same* hash the rest of the system computes, so the real one is used
 * and the fixtures derive their on-chain values from it.
 */

import { describe, expect, it, vi } from 'vitest'
import { assertBound, bindFailureStatus, describeBindFailure } from './bind'
import type { BindParams, MilestoneOnChain, MilestoneReader } from './bind'
import { hashJson } from './report'
import type { Criteria, Evidence } from './types'

const ESCROW = '0x1111111111111111111111111111111111111111'

const AGREED_CRITERIA: Criteria = {
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

const SUBMITTED_EVIDENCE: Evidence = {
  v: 1,
  milestone: 2,
  url: 'https://example.com/',
  note: 'deployed',
  submittedAt: 1_700_000_000,
}

/** What an honest client sends. Individual tests bend exactly one field. */
function goodParams(over: Partial<BindParams> = {}): BindParams {
  return {
    escrow: ESCROW,
    milestone: 2,
    submission: 3,
    criteria: AGREED_CRITERIA,
    evidence: SUBMITTED_EVIDENCE,
    ...over,
  }
}

/** The chain's view, derived from the real hasher so a fixture can never drift from it. */
function chainSaysMilestone(over: Partial<MilestoneOnChain> = {}): MilestoneOnChain {
  return {
    criteriaHash: hashJson(AGREED_CRITERIA),
    evidenceHash: hashJson(SUBMITTED_EVIDENCE),
    submissions: 3,
    state: 1, // Submitted
    ...over,
  }
}

function readerFor(m: MilestoneOnChain): MilestoneReader {
  return async () => m
}

describe('assertBound', () => {
  it('accepts a request whose criteria, evidence, submission and state all match the chain', async () => {
    // Property: the gate is a gate, not a wall — the legitimate path still gets through.
    const read = vi.fn(readerFor(chainSaysMilestone()))
    const result = await assertBound(goodParams(), read)

    expect(result.ok).toBe(true)
    // Property: the gate reads the milestone the request names, not some other one.
    expect(read).toHaveBeenCalledWith(ESCROW, 2)
  })

  it('returns the on-chain record on success so the caller need not read it twice', async () => {
    // Property: no second RPC round-trip, and no chance of the caller reading a *different*
    // state than the one this decision was made against.
    const onChain = chainSaysMilestone()
    const result = await assertBound(goodParams(), readerFor(onChain))

    expect(result).toEqual({ ok: true, onChain })
  })

  it('rejects criteria the caller invented, even with correct evidence and submission', async () => {
    // Property: THE attack. Without this the endpoint signs real attestations for real
    // escrows against a check the caller wrote to pass — an http probe of a URL they own.
    // Everything except the criteria is impeccable here; that is what makes it dangerous.
    const attackerCriteria: Criteria = {
      v: 1,
      title: 'Landing page is up',
      check: 'http',
      http: {
        url: 'https://attacker.example/always-200',
        expectStatus: 200,
        mustContain: [],
        mustNotContain: [],
        timeoutMs: 10_000,
      },
    }

    const result = await assertBound(
      goodParams({ criteria: attackerCriteria }),
      readerFor(chainSaysMilestone()),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.reason).toBe('criteria-mismatch')
    // Property: a substituted criteria set is the caller's error, never a retryable 502.
    expect(bindFailureStatus(result.failure)).toBe(400)
  })

  it('rejects a single-character tweak to the agreed criteria', async () => {
    // Property: binding is by hash, not by resemblance. Loosening `mustContain` by one word
    // is a different agreement and must not slip through as "basically the same criteria".
    const tweaked: Criteria = {
      ...AGREED_CRITERIA,
      http: { ...AGREED_CRITERIA.http!, mustContain: [] },
    }

    const result = await assertBound(goodParams({ criteria: tweaked }), readerFor(chainSaysMilestone()))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.reason).toBe('criteria-mismatch')
  })

  it('accepts criteria that differ only in key order', async () => {
    // Property: rejection is about content, not about JSON key order. If this failed, an
    // honest client that built the same criteria with its fields in another order would be
    // told it was substituting criteria — and we would train people to ignore the error.
    const reordered = {
      check: AGREED_CRITERIA.check,
      http: AGREED_CRITERIA.http,
      title: AGREED_CRITERIA.title,
      v: AGREED_CRITERIA.v,
    } as Criteria

    const result = await assertBound(goodParams({ criteria: reordered }), readerFor(chainSaysMilestone()))

    expect(result.ok).toBe(true)
  })

  it('rejects evidence that is not what was submitted on-chain', async () => {
    // Property: `evidenceHash` is inside the C2 payload, so signing over evidence the chain
    // never saw produces an attestation pointing at a document nobody submitted.
    const swapped: Evidence = { ...SUBMITTED_EVIDENCE, url: 'https://attacker.example/' }

    const result = await assertBound(goodParams({ evidence: swapped }), readerFor(chainSaysMilestone()))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.reason).toBe('evidence-mismatch')
    expect(bindFailureStatus(result.failure)).toBe(400)
  })

  it('rejects a stale attempt when the freelancer has resubmitted', async () => {
    // Property: `submission` is signed over. Attesting to attempt 3 after attempt 4 landed
    // either reverts on-chain or blesses work that has already been replaced.
    const result = await assertBound(
      goodParams({ submission: 3 }),
      readerFor(chainSaysMilestone({ submissions: 4 })),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toEqual({ reason: 'stale-submission', expected: 4, actual: 3 })
    expect(bindFailureStatus(result.failure)).toBe(400)
  })

  it('rejects a submission number ahead of the chain as well as behind it', async () => {
    // Property: the comparison is equality, not "at least". A caller guessing a future
    // submission index must not be able to pre-sign an attempt that has not happened.
    const result = await assertBound(
      goodParams({ submission: 9 }),
      readerFor(chainSaysMilestone({ submissions: 3 })),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.reason).toBe('stale-submission')
  })

  it.each([
    [0, 'Pending'],
    [2, 'Attested'],
    [3, 'Released'],
    [4, 'Disputed'],
    [5, 'Refunded'],
  ])('rejects milestone state %i (%s) — only Submitted can be attested', async (state) => {
    // Property: `attest` accepts state 1 only, so a signature for any other state is dead on
    // arrival. Worth refusing here rather than emitting a signature that cannot be used —
    // and refusing on Attested/Disputed in particular avoids re-attesting over a live
    // challenge window or an arbiter's dispute.
    const result = await assertBound(goodParams(), readerFor(chainSaysMilestone({ state })))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toEqual({ reason: 'wrong-state', expected: 1, actual: state })
    expect(bindFailureStatus(result.failure)).toBe(400)
  })

  it('maps a chain read that throws to chain-unreachable, not to a failure', async () => {
    // Property: THE OTHER line that must not blur. An RPC timeout is our problem. If it were
    // reported as a mismatch the route would answer 400/422 and somebody's completed work
    // would be recorded as not done because our node was slow.
    const read: MilestoneReader = async () => {
      throw new Error('fetch failed: ETIMEDOUT')
    }

    const result = await assertBound(goodParams(), read)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.reason).toBe('chain-unreachable')
    expect(bindFailureStatus(result.failure)).toBe(502)
    expect(describeBindFailure(result.failure)).toContain('ETIMEDOUT')
  })

  it('maps a non-Error rejection from the reader to chain-unreachable too', async () => {
    // Property: error handling does not depend on the reader being well-behaved. A library
    // that rejects with a string must not escape the try/catch shape and become a 500.
    // Rejecting with a bare string, as some transports do.
    const read: MilestoneReader = () => Promise.reject('rate limited')

    const result = await assertBound(goodParams(), read)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure).toEqual({ reason: 'chain-unreachable', detail: 'rate limited' })
  })

  it('treats a malformed answer from the reader as unreachable, not as a mismatch', async () => {
    // Property: "when in doubt it is unreachable". A truncated hash means our decoding is
    // broken, not that the caller substituted criteria — and comparing against garbage would
    // otherwise produce a confident, wrong criteria-mismatch.
    const read = readerFor(chainSaysMilestone({ criteriaHash: '0xdeadbeef' as `0x${string}` }))

    const result = await assertBound(goodParams(), read)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.reason).toBe('chain-unreachable')
    expect(bindFailureStatus(result.failure)).toBe(502)
  })

  it('rejects input that cannot be canonicalised as the caller’s error, not ours', async () => {
    // Property: `canonicalJson` refuses NaN. That is a malformed body (400), not a chain
    // fault (502) — a caller must not be told to retry something that will never hash.
    const broken = { ...SUBMITTED_EVIDENCE, submittedAt: Number.NaN }
    const read = vi.fn(readerFor(chainSaysMilestone()))

    const result = await assertBound(goodParams({ evidence: broken }), read)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.reason).toBe('unhashable-input')
    expect(bindFailureStatus(result.failure)).toBe(400)
    // Property: unhashable input costs no RPC call — it is rejected before we touch the chain.
    expect(read).not.toHaveBeenCalled()
  })

  it('compares hashes case-insensitively', async () => {
    // Property: a reader that returns uppercase hex is not an attacker. Case is not content,
    // and treating it as a substitution would reject honest requests on some RPC clients.
    const shouting = chainSaysMilestone()
    const read = readerFor({
      ...shouting,
      criteriaHash: shouting.criteriaHash.toUpperCase().replace('0X', '0x') as `0x${string}`,
    })

    const result = await assertBound(goodParams(), read)

    expect(result.ok).toBe(true)
  })

  it('reports the criteria mismatch first when several things are wrong at once', async () => {
    // Property: the reason is deterministic, and the security-relevant one wins. An operator
    // reading logs should see "criteria did not match" rather than a state complaint that
    // hides an attempted substitution.
    const attacker: Criteria = { ...AGREED_CRITERIA, title: 'anything at all' }
    const result = await assertBound(
      goodParams({ criteria: attacker, submission: 99 }),
      readerFor(chainSaysMilestone({ state: 4, submissions: 7 })),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.reason).toBe('criteria-mismatch')
  })
})

describe('bindFailureStatus', () => {
  it('sends exactly one reason to 502 and everything else to 400', async () => {
    // Property: the 400/502 split is the whole reason these reasons are tagged. Only an
    // unreachable chain is retryable; a hash that does not match the chain never will be.
    const reasons = [
      { reason: 'criteria-mismatch', expected: '0x0', actual: '0x1' },
      { reason: 'evidence-mismatch', expected: '0x0', actual: '0x1' },
      { reason: 'stale-submission', expected: 1, actual: 0 },
      { reason: 'wrong-state', expected: 1, actual: 2 },
      { reason: 'unhashable-input', field: 'criteria', detail: 'NaN' },
      { reason: 'chain-unreachable', detail: 'ECONNREFUSED' },
    ] as const

    const statuses = reasons.map((r) => [r.reason, bindFailureStatus(r)] as const)

    expect(statuses).toEqual([
      ['criteria-mismatch', 400],
      ['evidence-mismatch', 400],
      ['stale-submission', 400],
      ['wrong-state', 400],
      ['unhashable-input', 400],
      ['chain-unreachable', 502],
    ])
    // Property: every reason produces a human-readable line, so the route never answers
    // with "undefined" in the error field.
    for (const r of reasons) expect(describeBindFailure(r)).not.toBe('')
  })
})
