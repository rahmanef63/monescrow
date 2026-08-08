/**
 * C5 — the report, and the hash the signer commits to.
 *
 * The report is the human-readable half of an attestation. Only `reportHash` travels on-chain
 * (C2: `bytes32 reportHash`), so the report itself must be reconstructible byte-for-byte by
 * anyone holding the same inputs, or the hash proves nothing to the person checking it later.
 *
 * Nothing in here decides anything. `passed` is a mechanical fold over check results that some
 * other module produced; this module never widens what a passing check means, and a passing
 * report is a proposal that opens a challenge window, not a verdict that work was done.
 */

import { keccak256, stringToBytes } from 'viem'
import { canonicalJson } from '../canonicalJson'
import type { CheckResult, Report } from './types'

/**
 * `keccak256(utf8(canonicalJson(value)))` — the one hashing path in this system.
 *
 * Serialisation goes through `canonicalJson` and not `JSON.stringify` because the hash commits
 * to exact bytes: two encoders that disagree about key order or whitespace produce two hashes
 * for the same logical object, and the off-chain reader would be unable to reproduce the one
 * the signer used.
 */
export function hashJson(value: unknown): `0x${string}` {
  return keccak256(stringToBytes(canonicalJson(value)))
}

/** Everything the report is assembled from. No ambient state, no clock, no network. */
export type BuildReportInput = {
  escrow: string
  milestone: number
  submission: number
  evidenceHash: string
  criteriaHash: string
  /** What a check produced. `unreachable` outcomes never get this far — they are a 502. */
  checks: CheckResult[]
  /**
   * Unix seconds, passed IN by the caller. Never read the clock in here: a report has to be
   * reproducible from its inputs, and a function that consults `Date.now()` produces a
   * different `reportHash` on every call, so nobody could ever re-derive the signed hash.
   */
  checkedAt: number
}

/**
 * Assemble C5 and hash it.
 *
 * `passed` is the conjunction of every check — no partial credit, because the contract has no
 * representation for "94% done"; a milestone either releases or it does not.
 */
export function buildReport(input: BuildReportInput): {
  report: Report
  reportHash: `0x${string}`
} {
  // Copy the array so a caller mutating its own list afterwards cannot change a report whose
  // hash has already been handed out (and, downstream, already signed).
  const checks: CheckResult[] = [...input.checks]

  // An empty check list means nothing was verified. `[].every(...)` is `true` by the vacuous
  // truth rule, which would silently turn "we checked nothing" into "everything passed" — the
  // exact inversion this whole design exists to prevent, and on the money path it would
  // release funds on the strength of zero observations. Require at least one passing check.
  const passed = checks.length > 0 && checks.every((c) => c.passed)

  const report: Report = {
    v: 1,
    // Lowercased before it enters the report: the hash commits to the exact bytes, so the
    // EIP-55 checksummed form and the lowercase form of the same address would produce two
    // different `reportHash` values for one report, and a reader who normalised differently
    // from the signer could not reproduce the hash that was signed.
    escrow: input.escrow.toLowerCase(),
    milestone: input.milestone,
    submission: input.submission,
    evidenceHash: input.evidenceHash,
    criteriaHash: input.criteriaHash,
    passed,
    checkedAt: input.checkedAt,
    checks,
  }

  return { report, reportHash: hashJson(report) }
}
