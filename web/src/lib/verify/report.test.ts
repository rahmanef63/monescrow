import { describe, expect, it } from 'vitest'
import { keccak256, stringToBytes } from 'viem'
import { buildReport, hashJson, type BuildReportInput } from './report'
import type { CheckResult } from './types'

const pass = (id: string): CheckResult => ({
  id,
  label: `check ${id}`,
  // Honest about what a pass is worth: this fixture only records that some check reported
  // `passed`, not that any work was observed to exist.
  passed: true,
  detail: 'observed',
})

const fail = (id: string): CheckResult => ({
  id,
  label: `check ${id}`,
  passed: false,
  detail: 'not observed',
})

const base: BuildReportInput = {
  escrow: '0x1111111111111111111111111111111111111111',
  milestone: 2,
  submission: 1,
  evidenceHash: `0x${'ab'.repeat(32)}`,
  criteriaHash: `0x${'cd'.repeat(32)}`,
  checks: [pass('http.status'), pass('http.contains')],
  checkedAt: 1_770_000_000,
}

describe('hashJson', () => {
  // Property: the hash is over canonical bytes, so key insertion order is irrelevant.
  // Without this, two services building the same report in different field orders would
  // commit to different `reportHash` values and neither could verify the other.
  it('is stable across key insertion order', () => {
    const a = { alpha: 1, beta: { x: 'x', y: 'y' }, gamma: [1, 2] }
    const b = { gamma: [1, 2], beta: { y: 'y', x: 'x' }, alpha: 1 }
    expect(hashJson(a)).toBe(hashJson(b))
  })

  // Property: it really is keccak256 over the utf8 bytes of canonicalJson — the exact
  // construction C5 names. A drift here (hex-encoding first, hashing the JS object, etc.)
  // would produce a hash nobody else in the system can reproduce.
  it('is keccak256 of the utf8 bytes of the canonical form', () => {
    const value = { b: 2, a: 1 }
    expect(hashJson(value)).toBe(keccak256(stringToBytes('{"a":1,"b":2}')))
  })

  // Property: array order is content, not formatting. Reordering checks must change the hash,
  // otherwise a report could be reshuffled after signing without breaking the commitment.
  it('distinguishes arrays that differ only in order', () => {
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]))
  })
})

describe('buildReport — passed', () => {
  // Property: `passed` is a conjunction. One failing check fails the milestone, no partial
  // credit — the contract has no representation for a partial pass.
  it('is false when any single check failed', () => {
    const { report } = buildReport({
      ...base,
      checks: [pass('a'), fail('b'), pass('c')],
    })
    expect(report.passed).toBe(false)
  })

  // Property: all-passing checks do produce a pass, so the conjunction is not trivially false.
  it('is true only when every check passed', () => {
    const { report } = buildReport({ ...base, checks: [pass('a'), pass('b')] })
    expect(report.passed).toBe(true)
  })

  // Property: THE inversion guard. `[].every()` is vacuously true; if that leaked through,
  // "we verified nothing" would be signed as "everything passed" and money would release on
  // zero observations. An empty check list must never pass.
  it('is false for an empty check list', () => {
    const { report } = buildReport({ ...base, checks: [] })
    expect(report.passed).toBe(false)
  })
})

describe('buildReport — reproducibility', () => {
  // Property: the report is a pure function of its inputs. If anything ambient leaked in
  // (a clock, a counter, a random nonce), the signer's hash could never be re-derived by the
  // person checking the attestation later.
  it('produces the same hash for the same inputs', () => {
    const first = buildReport(base)
    const second = buildReport({ ...base, checks: [...base.checks] })
    expect(second.reportHash).toBe(first.reportHash)
    expect(second.report).toEqual(first.report)
  })

  // Property: the report the caller gets back is the exact object that was hashed, so the
  // 422 body and the on-chain hash describe the same thing.
  it('returns a report whose own hash matches the returned reportHash', () => {
    const { report, reportHash } = buildReport(base)
    expect(hashJson(report)).toBe(reportHash)
  })

  // Property: the returned report is insulated from later mutation of the caller's array.
  // A hash handed out and then invalidated by an unrelated mutation is unverifiable.
  it('does not alias the caller check array', () => {
    const checks = [pass('a')]
    const { report, reportHash } = buildReport({ ...base, checks })
    checks.push(fail('b'))
    expect(report.checks).toHaveLength(1)
    expect(hashJson(report)).toBe(reportHash)
  })

  // Property: `checkedAt` comes from the caller verbatim. Proves no clock is read inside.
  it('records checkedAt exactly as passed in', () => {
    const { report } = buildReport({ ...base, checkedAt: 1 })
    expect(report.checkedAt).toBe(1)
  })
})

describe('buildReport — every field is committed to', () => {
  const baseline = buildReport(base).reportHash

  // Property: each C5 field is inside the hash preimage. A field that could change without
  // moving the hash would be a field the signature does not actually cover — the signer could
  // be shown one report and have signed the commitment of another.
  const mutations: Array<[string, BuildReportInput]> = [
    ['escrow', { ...base, escrow: '0x2222222222222222222222222222222222222222' }],
    ['milestone', { ...base, milestone: 3 }],
    ['submission', { ...base, submission: 2 }],
    ['evidenceHash', { ...base, evidenceHash: `0x${'ef'.repeat(32)}` }],
    ['criteriaHash', { ...base, criteriaHash: `0x${'01'.repeat(32)}` }],
    ['checkedAt', { ...base, checkedAt: base.checkedAt + 1 }],
    ["a check's passed flag", { ...base, checks: [pass('http.status'), fail('http.contains')] }],
  ]

  for (const [field, input] of mutations) {
    it(`changes the hash when ${field} changes`, () => {
      expect(buildReport(input).reportHash).not.toBe(baseline)
    })
  }

  // Property: the check's prose is committed to as well, not just its boolean. The detail is
  // what a human reads when deciding whether to challenge, so it must not be swappable.
  it('changes the hash when a check detail changes', () => {
    const checks = [{ ...pass('http.status'), detail: 'something else' }, pass('http.contains')]
    expect(buildReport({ ...base, checks }).reportHash).not.toBe(baseline)
  })
})

describe('buildReport — escrow normalisation', () => {
  // Property: address casing is presentation, not content. The hash commits to exact bytes, so
  // a checksummed address and a lowercase one must not yield two hashes for one report — the
  // reader normalises the same way the signer did or verification silently fails.
  it('hashes mixed-case and lowercase escrow addresses alike', () => {
    const lower = buildReport({
      ...base,
      escrow: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    })
    const mixed = buildReport({
      ...base,
      escrow: '0xAbCdEfABCDEFabcdefABCDEFabcdefABCDEFabCD',
    })
    expect(mixed.reportHash).toBe(lower.reportHash)
    expect(mixed.report.escrow).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
  })

  // Property: normalisation is case-only. Two genuinely different addresses must still differ,
  // so the guard above cannot be satisfied by flattening the field away.
  it('still distinguishes genuinely different escrows', () => {
    const a = buildReport({ ...base, escrow: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa' })
    const b = buildReport({ ...base, escrow: '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb' })
    expect(a.reportHash).not.toBe(b.reportHash)
  })
})

describe('buildReport — shape', () => {
  // Property: the report carries exactly the C5 fields, no more. An extra field would change
  // the preimage for every consumer that did not know to add it.
  it('emits exactly the C5 field set with v = 1', () => {
    const { report } = buildReport(base)
    expect(Object.keys(report).sort()).toEqual(
      [
        'checkedAt',
        'checks',
        'criteriaHash',
        'escrow',
        'evidenceHash',
        'milestone',
        'passed',
        'submission',
        'v',
      ].sort(),
    )
    expect(report.v).toBe(1)
  })
})
