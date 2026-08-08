/**
 * The shapes the verifier reads and writes. C3 (criteria), C4 (evidence), C5 (report).
 *
 * Shared seam: every file under `verify/` imports from here and nothing redeclares a shape.
 */

export type CheckKind = 'http' | 'github' | 'clientApproval'

/** C3 — what `criteriaHash` commits to. Only the block matching `check` is required. */
export type Criteria = {
  v: 1
  title: string
  check: CheckKind
  http?: {
    url: string
    expectStatus: number
    mustContain: string[]
    mustNotContain: string[]
    timeoutMs: number
  }
  github?: {
    repo: string
    ref: string
    requireCommit: boolean
    requireCheckRun: string | null
    minStars: number | null
  }
}

/** C4 — what `evidenceHash` commits to. Submitted by the freelancer. */
export type Evidence = {
  v: 1
  milestone: number
  url?: string
  repo?: string
  commit?: string
  note?: string
  submittedAt: number
}

/** One line in the report. `id` is stable so the UI can label it without parsing prose. */
export type CheckResult = {
  id: string
  label: string
  passed: boolean
  detail: string
}

/** C5 — what `reportHash` commits to. Stored off-chain; only its hash goes on-chain. */
export type Report = {
  v: 1
  escrow: string
  milestone: number
  submission: number
  evidenceHash: string
  criteriaHash: string
  passed: boolean
  checkedAt: number
  checks: CheckResult[]
}

/**
 * What a single check returns before it becomes a report.
 *
 * `unreachable` is the reason this is not just `CheckResult[]`. C6 draws a hard line between
 * a milestone that failed and a target we could not reach: "the site returned 500" is the
 * freelancer's problem and gets signed as a failure; "we could not reach the site" is ours
 * and must surface as 502 so the caller retries. Collapsing the two would let our own
 * network trouble be recorded on-chain as somebody's work being incomplete.
 */
export type CheckOutcome =
  | { kind: 'ran'; checks: CheckResult[] }
  | { kind: 'unreachable'; reason: string }

/** Injected so tests never touch the network. Same signature as global `fetch`. */
export type FetchImpl = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>
