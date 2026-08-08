/**
 * Adversarial tests for the verify route, written separately from the module's own suite.
 *
 * The point of a second suite is that it was not written by whoever wrote the code, and it
 * asks a different question. `route.test.ts` asks "does each branch return the documented
 * status". This asks "can somebody who reaches this endpoint get a signature they should not
 * have", which is the question that matters once the route is hosted with a real key.
 */
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import { handleVerify, type VerifyDeps } from './route'
import { hashJson } from '@/lib/verify/report'
import { STATE_SUBMITTED, type MilestoneOnChain } from '@/lib/verify/bind'
import type { Criteria, Evidence } from '@/lib/verify/types'

// A throwaway key. Never a real one, and nothing here reads the environment.
const VERIFIER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const VERIFIER = privateKeyToAccount(VERIFIER_KEY).address
const ESCROW = '0x1111111111111111111111111111111111111111'
const CHAIN_ID = 10143

/** What the parties actually agreed to and committed on-chain. */
const AGREED: Criteria = {
  v: 1,
  title: 'Deployed and reachable',
  check: 'http',
  http: {
    url: 'https://demo.example.com',
    expectStatus: 200,
    mustContain: ['Sign in with Google'],
    mustNotContain: [],
    timeoutMs: 15000,
  },
}

/**
 * What an attacker substitutes: same shape, but pointed at something they control and
 * asking for nothing. This passes trivially — which is the entire point.
 */
const INVENTED: Criteria = {
  v: 1,
  title: 'Deployed and reachable',
  check: 'http',
  http: {
    url: 'https://attacker.example/always-200',
    expectStatus: 200,
    mustContain: [],
    mustNotContain: [],
    timeoutMs: 15000,
  },
}

const EVIDENCE: Evidence = {
  v: 1,
  milestone: 0,
  url: 'https://demo.example.com',
  repo: 'owner/name',
  commit: 'abc123',
  note: 'Deployed to Vercel, OAuth configured',
  submittedAt: 1_800_000_000,
}

/** The chain's view: the agreed criteria, the submitted evidence, one submission, Submitted. */
function onChain(over: Partial<MilestoneOnChain> = {}): MilestoneOnChain {
  return {
    criteriaHash: hashJson(AGREED),
    evidenceHash: hashJson(EVIDENCE),
    submissions: 1,
    state: STATE_SUBMITTED,
    ...over,
  }
}

function deps(over: Partial<VerifyDeps> = {}): { deps: VerifyDeps; fetchImpl: ReturnType<typeof vi.fn> } {
  // Answers 200 with the required phrase, so any check that runs will PASS. If a signature
  // ever comes back when it should not, it is because the route ran this — not because the
  // fake was lenient by accident.
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '<html><body><h1>Sign in with Google</h1></body></html>',
  }))

  return {
    fetchImpl,
    deps: {
      fetchImpl: fetchImpl as unknown as VerifyDeps['fetchImpl'],
      readMilestone: async () => onChain(),
      verifierKey: VERIFIER_KEY,
      now: () => 1_800_000_123_000,
      chainId: CHAIN_ID,
      ...over,
    },
  }
}

const body = (criteria: Criteria, over: Record<string, unknown> = {}) => ({
  escrow: ESCROW,
  milestone: 0,
  submission: 1,
  criteria,
  evidence: EVIDENCE,
  ...over,
})

describe('verify route, adversarially', () => {
  // The baseline. If this ever stops returning a signature the tests below prove nothing,
  // because everything else asserts the ABSENCE of one.
  it('signs the honest request, and the signature recovers to the verifier', async () => {
    const { deps: d } = deps()
    const res = await handleVerify(body(AGREED), d)

    expect(res.status).toBe(200)
    if (res.status !== 200) return

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'MonEscrow', version: '1', chainId: CHAIN_ID, verifyingContract: ESCROW },
      types: {
        Attestation: [
          { name: 'milestone', type: 'uint256' },
          { name: 'submission', type: 'uint32' },
          { name: 'passed', type: 'bool' },
          { name: 'evidenceHash', type: 'bytes32' },
          { name: 'reportHash', type: 'bytes32' },
        ],
      },
      primaryType: 'Attestation',
      message: {
        milestone: 0n,
        submission: 1,
        passed: true,
        evidenceHash: hashJson(EVIDENCE),
        reportHash: res.body.reportHash,
      },
      signature: res.body.signature,
    })

    expect(recovered.toLowerCase()).toBe(VERIFIER.toLowerCase())
  })

  /**
   * THE ATTACK. Everything the chain can see is honest — right escrow, right milestone, right
   * submission, right evidence. Only the criteria are invented, and the contract never sees
   * criteria at all, so nothing on-chain would catch this. Without the binding check the
   * endpoint hands out a valid verifier signature to anyone who asks.
   */
  it('refuses criteria that do not match the on-chain criteriaHash', async () => {
    const { deps: d } = deps()
    const res = await handleVerify(body(INVENTED), d)

    expect(res.status).toBe(400)
    expect(res.body).not.toHaveProperty('signature')
  })

  /**
   * And it refuses BEFORE fetching. This is the property, not a nicety: until the binding
   * passes, `criteria.http.url` is attacker-controlled, so a route that checked first would
   * double as an unauthenticated request proxy aimed at anything reachable from the server —
   * including addresses only the server can reach.
   */
  it('never touches the network when the criteria are invented', async () => {
    const { deps: d, fetchImpl } = deps()
    await handleVerify(body(INVENTED), d)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // A pass signed against a superseded attempt would let a stale success be replayed after
  // the freelancer changed the deliverable. The contract rejects it too, but the signature
  // should never exist in the first place.
  it('refuses a stale submission number', async () => {
    const { deps: d, fetchImpl } = deps({ readMilestone: async () => onChain({ submissions: 2 }) })
    const res = await handleVerify(body(AGREED), d)

    expect(res.status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Evidence is what the signature actually commits to on-chain, so a mismatch here would
  // produce a signature the contract rejects — worthless, but still worth never emitting.
  it('refuses evidence that does not match the on-chain evidenceHash', async () => {
    const { deps: d } = deps()
    const res = await handleVerify(body(AGREED, { evidence: { ...EVIDENCE, note: 'edited' } }), d)
    expect(res.status).toBe(400)
  })

  // `attest` only accepts Submitted. Signing for any other state produces something the chain
  // will refuse, and for Attested it would be a second pass on a milestone already counting down.
  it.each([
    ['Pending', 0],
    ['Attested', 2],
    ['Released', 3],
    ['Disputed', 4],
    ['Refunded', 5],
  ])('refuses to sign for a milestone in state %s', async (_label, state) => {
    const { deps: d } = deps({ readMilestone: async () => onChain({ state }) })
    const res = await handleVerify(body(AGREED), d)
    expect(res.status).toBe(400)
  })

  // Our own RPC being down says nothing about the freelancer's work. If this ever became a
  // 422 the report would record our outage as their milestone failing.
  it('maps an unreachable chain to 502 and signs nothing', async () => {
    const { deps: d } = deps({
      readMilestone: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const res = await handleVerify(body(AGREED), d)

    expect(res.status).toBe(502)
    expect(res.body).not.toHaveProperty('signature')
    expect(res.body).not.toHaveProperty('report')
  })

  // Same rule one layer out: the target being unreachable is ours, not theirs.
  it('maps an unreachable target to 502 and signs nothing', async () => {
    const { deps: d } = deps({
      fetchImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND demo.example.com')
      }) as unknown as VerifyDeps['fetchImpl'],
    })
    const res = await handleVerify(body(AGREED), d)

    expect(res.status).toBe(502)
    expect(res.body).not.toHaveProperty('signature')
  })

  // A real failure: the site answered, and answered wrong. This one IS the freelancer's, and
  // it must come back as 422 with the report so they can see which line failed.
  it('returns 422 with an unsigned report when the site answers wrongly', async () => {
    const { deps: d } = deps({
      fetchImpl: (async () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => 'boom',
      })) as unknown as VerifyDeps['fetchImpl'],
    })
    const res = await handleVerify(body(AGREED), d)

    expect(res.status).toBe(422)
    if (res.status !== 422) return
    expect(res.body.report.passed).toBe(false)
    expect(res.body).not.toHaveProperty('signature')
  })

  // The key is the one secret this service holds. No path may put it in a response.
  it('never leaks the verifier key in any response', async () => {
    const bare = VERIFIER_KEY.slice(2).toLowerCase()
    const cases = [
      body(AGREED),
      body(INVENTED),
      body(AGREED, { submission: 99 }),
      { garbage: true },
    ]

    for (const b of cases) {
      const { deps: d } = deps()
      const res = await handleVerify(b, d)
      const serialised = JSON.stringify(res).toLowerCase()
      expect(serialised).not.toContain(bare)
      expect(serialised).not.toContain(VERIFIER_KEY.toLowerCase())
    }
  })
})
