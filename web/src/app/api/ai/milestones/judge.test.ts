/**
 * The judge's-machine tests: does `/new` work for somebody with no API key, and can it ever
 * hand back a split that would revert the create transaction?
 *
 * Written separately from `route.test.ts`, against the REAL template provider rather than a
 * fake, because the property under test is precisely that the real one is good enough to ship
 * alone. A fake template would pass every test here and prove nothing.
 *
 * Two contract reverts are what make this money-critical rather than cosmetic:
 *   FundingMismatch(expected, sent)  — the amounts must sum to the total, to the wei
 *   ZeroMilestoneAmount()            — no milestone may be zero
 * A split violating either is a transaction that fails in front of whoever is watching.
 */
import { describe, expect, it } from 'vitest'
import { handleMilestones } from './route'
import { templateProvider } from '@/lib/ai/template'
import type { MilestoneProvider } from '@/lib/ai/types'

/** Nothing is configured: no header, no env. The judge's laptop. */
const NO_HEADERS = { get: () => null }
const NO_ENV: Record<string, string | undefined> = {}

/** The LLM factory must never be reached with no credential; if it is, fail loudly. */
const noLlm = (): MilestoneProvider => {
  throw new Error('the LLM provider must not be constructed without a credential')
}

const deps = (over: Partial<Parameters<typeof handleMilestones>[2]> = {}) => ({
  template: templateProvider,
  llm: noLlm,
  env: NO_ENV,
  ...over,
})

const body = (brief: string, totalAmount: string) => ({ brief, totalAmount, currency: 'MON' as const })

/** Every invariant the create transaction will enforce, asserted in one place. */
function assertSpendable(milestones: { amount: string }[], total: string, label: string) {
  expect(milestones.length, `${label}: at least one milestone`).toBeGreaterThan(0)
  expect(milestones.length, `${label}: MAX_MILESTONES is 20`).toBeLessThanOrEqual(20)

  let sum = 0n
  for (const m of milestones) {
    expect(m.amount, `${label}: amount is a canonical decimal string`).toMatch(/^[1-9][0-9]*$/)
    const v = BigInt(m.amount)
    expect(v > 0n, `${label}: ZeroMilestoneAmount would revert`).toBe(true)
    sum += v
  }
  expect(sum.toString(), `${label}: FundingMismatch would revert`).toBe(total)
}

describe('the /new endpoint on a machine with no API key', () => {
  it('answers 200 from the template, never an error', async () => {
    const res = await handleMilestones(body('Build a SaaS landing page and deploy it', '6000000000000000000'), NO_HEADERS, deps())

    expect(res.status).toBe(200)
    if (res.status !== 200) return
    expect(res.body.source).toBe('template')
    expect(res.body.milestones.length).toBeGreaterThanOrEqual(4)
    expect(res.body.milestones.length).toBeLessThanOrEqual(5)
  })

  // An empty brief is what you get from someone clicking through to see what the page does.
  // It must still produce something they can edit, not an error and not an empty list.
  it('still produces a usable split from an empty brief', async () => {
    const res = await handleMilestones(body('', '1000000000000000000'), NO_HEADERS, deps())

    expect(res.status).toBe(200)
    if (res.status !== 200) return
    assertSpendable(res.body.milestones, '1000000000000000000', 'empty brief')
  })

  /**
   * The property that actually protects the demo. Many shapes of brief and many totals,
   * including the pathological small ones, all asserted against both contract reverts.
   * Deterministic inputs — no randomness, so a failure here is always reproducible.
   */
  it.each([
    ['1', 'one wei, fewer milestones than phases'],
    ['2', 'two wei'],
    ['3', 'three wei'],
    ['4', 'four wei'],
    ['5', 'exactly one wei per phase'],
    ['7', 'a prime that cannot divide evenly'],
    ['11', 'another awkward prime'],
    ['100', 'small but divisible'],
    ['333', 'repeating division'],
    ['1000000000000000000', 'one MON'],
    ['6000000000000000000', 'the fixture total'],
    ['123456789012345678901234567890', 'far past 2^53'],
  ])('sums to exactly %s wei (%s)', async (total) => {
    const briefs = [
      '',
      'landing page',
      'Build and deploy a marketing site at https://demo.example.com',
      'Ship the API in github.com/acme/widgets with CI green',
      'Design review, brand copy and a research memo',
      'Full stack: repo, tests, deployed site, and a design pass',
      '🚀 emoji only 🎯',
      '!!! ???',
    ]

    for (const brief of briefs) {
      const res = await handleMilestones(body(brief, total), NO_HEADERS, deps())
      expect(res.status, `brief ${JSON.stringify(brief)} at ${total}`).toBe(200)
      if (res.status !== 200) continue
      assertSpendable(res.body.milestones, total, `${JSON.stringify(brief)} @ ${total}`)
    }
  })

  // Same brief in, same split out. A parser that drifts between two page loads would show the
  // two parties different agreements depending on who refreshed.
  it('is deterministic', async () => {
    const once = await handleMilestones(body('Deploy the site and ship the repo', '9999999999999999999'), NO_HEADERS, deps())
    const twice = await handleMilestones(body('Deploy the site and ship the repo', '9999999999999999999'), NO_HEADERS, deps())
    expect(once).toEqual(twice)
  })

  // Placeholders must be visibly placeholders. A plausible-looking wrong URL is worse than a
  // blank, because a client skimming the draft will sign it.
  it('never invents a real-looking target', async () => {
    const res = await handleMilestones(body('build me something', '5000000000000000000'), NO_HEADERS, deps())
    if (res.status !== 200) throw new Error('expected 200')

    for (const m of res.body.milestones) {
      const url = m.criteria.http?.url
      if (url) expect(url).toMatch(/\.invalid|replace-me/i)
      const repo = m.criteria.github?.repo
      if (repo) expect(repo).toMatch(/REPLACE-ME/i)
    }
  })
})

describe('a model that returns a bad split never reaches the caller', () => {
  const CREDENTIALLED = { get: (n: string) => (n.toLowerCase() === 'x-llm-key' ? 'sk-ant-fake-key-value' : null) }

  /** An LLM provider whose arithmetic is wrong — the exact thing C7 says never to trust. */
  const llmWithSum = (amounts: string[]): MilestoneProvider => ({
    name: 'llm',
    async propose() {
      return amounts.map((amount, i) => ({
        title: `Milestone ${i + 1}`,
        amount,
        check: 'clientApproval' as const,
        criteria: { v: 1 as const, title: `Milestone ${i + 1}`, check: 'clientApproval' as const },
        rationale: 'plausible prose',
      }))
    },
  })

  // One wei short is a create transaction that reverts FundingMismatch. The numbers look
  // right to a human skimming them, which is exactly why a machine has to check.
  it('falls back to the template when the sum is one wei short', async () => {
    const total = '6000000000000000000'
    const res = await handleMilestones(
      body('anything', total),
      CREDENTIALLED,
      deps({ llm: () => llmWithSum(['2000000000000000000', '3999999999999999999']) }),
    )

    expect(res.status).toBe(200)
    if (res.status !== 200) return
    expect(res.body.source).toBe('template')
    assertSpendable(res.body.milestones, total, 'one wei short')
  })

  it('falls back when the sum is one wei over', async () => {
    const total = '6000000000000000000'
    const res = await handleMilestones(
      body('anything', total),
      CREDENTIALLED,
      deps({ llm: () => llmWithSum(['2000000000000000000', '4000000000000000001']) }),
    )

    if (res.status !== 200) throw new Error('expected 200')
    expect(res.body.source).toBe('template')
    assertSpendable(res.body.milestones, total, 'one wei over')
  })

  // A zero-amount milestone reverts ZeroMilestoneAmount even when the total is right.
  it('falls back when a milestone is zero even though the sum is correct', async () => {
    const total = '6000000000000000000'
    const res = await handleMilestones(
      body('anything', total),
      CREDENTIALLED,
      deps({ llm: () => llmWithSum(['0', '6000000000000000000']) }),
    )

    if (res.status !== 200) throw new Error('expected 200')
    assertSpendable(res.body.milestones, total, 'zero milestone')
  })

  // A dead key, a rate limit, an outage: none of them may take the page down.
  it('falls back to the template when the model call throws', async () => {
    const total = '6000000000000000000'
    const res = await handleMilestones(
      body('anything', total),
      CREDENTIALLED,
      deps({
        llm: () => ({
          name: 'llm',
          async propose(): Promise<never> {
            throw new Error('401 unauthorized')
          },
        }),
      }),
    )

    if (res.status !== 200) throw new Error('expected 200')
    expect(res.body.source).toBe('template')
    assertSpendable(res.body.milestones, total, 'llm threw')
  })

  // The key is the user's, held for one request. It must not come back out.
  it('never echoes the key in any response', async () => {
    const key = 'sk-ant-fake-key-value'
    const headers = { get: (n: string) => (n.toLowerCase() === 'x-llm-key' ? key : null) }

    for (const b of [body('x', '100'), body('x', 'not-a-number'), { junk: true }]) {
      const res = await handleMilestones(
        b,
        headers,
        deps({ llm: () => ({ name: 'llm', async propose(): Promise<never> { throw new Error(`upstream said ${key}`) } }) }),
      )
      expect(JSON.stringify(res)).not.toContain(key)
    }
  })
})
