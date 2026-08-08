/**
 * Binding the request to the chain — the reason this endpoint is not a rubber stamp.
 *
 * The route is handed `criteria` and `evidence` in the POST body. If it just ran those and
 * signed, anyone who can reach the endpoint could supply criteria they know will pass — an
 * http check against a URL they control — and walk away with a valid verifier signature for
 * a real escrow and a real milestone. The signature would recover on-chain, because the C2
 * payload binds only `milestone`, `submission`, `passed`, `evidenceHash` and `reportHash`:
 * **the contract never sees the criteria at all.** The milestone would move to Attested and
 * the challenge window would open on work nobody agreed was checked.
 *
 * The client's challenge window still protects the money — that is the design working, not a
 * reason to relax here. But the attestation itself would mean nothing, and a hosted endpoint
 * would hand out meaningless attestations to whoever asked. So before any check runs, the
 * criteria and evidence in the body must be shown to be *the ones already committed on-chain*.
 *
 * What this module is honest about: it proves the request refers to the agreed criteria and
 * the submitted evidence. It proves nothing about whether the work was done. That question
 * belongs to the checks, and even they only ever produce a proposal.
 */

import { hashJson } from './report'
import type { Criteria, Evidence } from './types'

/**
 * The four on-chain facts a milestone must present before we are willing to check it.
 *
 * Deliberately a plain value, not a viem contract handle: the tested surface is `assertBound`
 * with this injected, so unit tests never open a socket.
 */
export type MilestoneOnChain = {
  criteriaHash: `0x${string}`
  evidenceHash: `0x${string}`
  submissions: number
  /** 0 Pending, 1 Submitted, 2 Attested, 3 Released, 4 Disputed, 5 Refunded. */
  state: number
}

export type MilestoneReader = (escrow: string, milestone: number) => Promise<MilestoneOnChain>

/** The milestone state `attest` accepts. Signing for anything else produces a dead signature. */
export const STATE_SUBMITTED = 1

export type BindParams = {
  escrow: string
  milestone: number
  submission: number
  criteria: Criteria
  evidence: Evidence
}

/**
 * Why each rejection carries its own tag rather than a string: the route has to map two very
 * different failures onto two very different HTTP codes, and a caller that retries a 400
 * forever, or gives up on a 502, is a bug we would rather make impossible than document.
 */
export type BindFailure =
  /** The caller sent criteria that are not the ones committed on-chain. The headline attack. */
  | { reason: 'criteria-mismatch'; expected: string; actual: string }
  /** The caller sent evidence that is not what was submitted for this milestone. */
  | { reason: 'evidence-mismatch'; expected: string; actual: string }
  /** A stale attempt: the freelancer has resubmitted since this request was built. */
  | { reason: 'stale-submission'; expected: number; actual: number }
  /** Not Submitted, so `attest` would revert even with a perfectly good signature. */
  | { reason: 'wrong-state'; expected: number; actual: number }
  /** The body cannot even be canonicalised (NaN, bigint, a cycle). Caller's problem, not ours. */
  | { reason: 'unhashable-input'; field: 'criteria' | 'evidence'; detail: string }
  /** We could not get a trustworthy answer out of the chain. **Ours**, never the freelancer's. */
  | { reason: 'chain-unreachable'; detail: string }

export type BindResult = { ok: true; onChain: MilestoneOnChain } | { ok: false; failure: BindFailure }

/**
 * A Result rather than a thrown error, despite the `assert` name.
 *
 * A throw would travel to the route as an exception indistinguishable from a genuine crash,
 * and the default handling of an unexpected exception is a 500 — which is neither of the two
 * answers C6 allows here. Making every rejection a value forces the route to decide, per
 * reason, between "the caller is wrong" (400) and "we are broken" (502).
 */
export async function assertBound(params: BindParams, read: MilestoneReader): Promise<BindResult> {
  // Hash first: it is pure and cheap, so unserialisable input is rejected without spending an
  // RPC call on it. It also keeps a `canonicalJson` throw from being mistaken for a chain fault.
  let criteriaHash: `0x${string}`
  try {
    criteriaHash = hashJson(params.criteria)
  } catch (err) {
    return fail({ reason: 'unhashable-input', field: 'criteria', detail: describe(err) })
  }

  let evidenceHash: `0x${string}`
  try {
    evidenceHash = hashJson(params.evidence)
  } catch (err) {
    return fail({ reason: 'unhashable-input', field: 'evidence', detail: describe(err) })
  }

  let onChain: MilestoneOnChain
  try {
    onChain = normaliseMilestone(await read(params.escrow, params.milestone))
  } catch (err) {
    // Every way this can go wrong — DNS, timeout, a rate-limited RPC key, a node that answers
    // with something we cannot parse — is our side of the line. Recording any of it as a
    // milestone failure would put "your work is incomplete" on-chain because our node blinked.
    return fail({ reason: 'chain-unreachable', detail: describe(err) })
  }

  // Address-style hex is compared case-insensitively. keccak256 emits lowercase and so does
  // viem's decoder, but a reader built over a different RPC client or a fixture may hand back
  // checksummed or uppercase hex, and a case difference is not a criteria substitution.
  if (!hexEq(criteriaHash, onChain.criteriaHash)) {
    // The substitution attack lands exactly here: correct evidence, correct submission, and
    // criteria the caller invented. Nothing downstream gets to see them.
    return fail({
      reason: 'criteria-mismatch',
      expected: onChain.criteriaHash.toLowerCase(),
      actual: criteriaHash.toLowerCase(),
    })
  }

  if (!hexEq(evidenceHash, onChain.evidenceHash)) {
    return fail({
      reason: 'evidence-mismatch',
      expected: onChain.evidenceHash.toLowerCase(),
      actual: evidenceHash.toLowerCase(),
    })
  }

  if (params.submission !== onChain.submissions) {
    // A signature for an older attempt is not harmless: `submission` is inside the C2 payload,
    // so it would either be rejected on-chain or attest to a submission that has been replaced.
    return fail({
      reason: 'stale-submission',
      expected: onChain.submissions,
      actual: params.submission,
    })
  }

  if (onChain.state !== STATE_SUBMITTED) {
    return fail({ reason: 'wrong-state', expected: STATE_SUBMITTED, actual: onChain.state })
  }

  return { ok: true, onChain }
}

/**
 * The route's mapping, kept next to the reasons so the two cannot drift apart.
 *
 * Only `chain-unreachable` is a 502. Everything else is the caller presenting something that
 * does not match the chain, which no amount of retrying will fix.
 */
export function bindFailureStatus(failure: BindFailure): 400 | 502 {
  return failure.reason === 'chain-unreachable' ? 502 : 400
}

/** A one-line reason for the `error` field of the 400/502 body. No secrets, no stack traces. */
export function describeBindFailure(failure: BindFailure): string {
  switch (failure.reason) {
    case 'criteria-mismatch':
      return `criteria do not match the criteriaHash committed on-chain (on-chain ${failure.expected}, submitted ${failure.actual})`
    case 'evidence-mismatch':
      return `evidence does not match the evidenceHash committed on-chain (on-chain ${failure.expected}, submitted ${failure.actual})`
    case 'stale-submission':
      return `stale submission: on-chain submission count is ${failure.expected}, request is for ${failure.actual}`
    case 'wrong-state':
      return `milestone is in state ${failure.actual}; only state ${failure.expected} (Submitted) can be attested`
    case 'unhashable-input':
      return `${failure.field} cannot be canonicalised: ${failure.detail}`
    case 'chain-unreachable':
      return `could not read the milestone from chain: ${failure.detail}`
  }
}

function fail(failure: BindFailure): BindResult {
  return { ok: false, failure }
}

function hexEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/**
 * Refuse to work from an answer we cannot trust.
 *
 * A reader that returns a short hash, a negative count or a non-finite number has not told us
 * what is on-chain — it has told us its own decoding is broken. Throwing here routes that into
 * `chain-unreachable`, i.e. a 502, because the alternative is comparing our hash against
 * garbage and calling the difference a criteria mismatch. "When in doubt it is unreachable."
 */
function normaliseMilestone(m: MilestoneOnChain): MilestoneOnChain {
  if (!BYTES32.test(m.criteriaHash)) throw new Error('reader returned a malformed criteriaHash')
  if (!BYTES32.test(m.evidenceHash)) throw new Error('reader returned a malformed evidenceHash')
  if (!Number.isInteger(m.submissions) || m.submissions < 0) {
    throw new Error('reader returned a malformed submissions count')
  }
  if (!Number.isInteger(m.state) || m.state < 0) {
    throw new Error('reader returned a malformed state')
  }
  return m
}

// ---------------------------------------------------------------------------------------------
// The RPC-backed reader.
//
// This is deliberately the one thing in this module with no unit test. Testing it would mean
// either hitting a live node — which makes the suite depend on Monad testnet being up, and a
// flaky suite is a suite people learn to ignore — or mocking viem so thoroughly that the test
// would only assert that the mock was called, proving nothing about ABI decoding. The property
// worth protecting is the *decision*, and that lives entirely in `assertBound`, which is tested
// against an injected reader. What is left here is wiring: keep it thin enough to read.
// ---------------------------------------------------------------------------------------------

/**
 * `milestoneAt(uint256)`, transcribed from `contracts/out/Escrow.sol/Escrow.json`.
 *
 * Only this one function, not the whole artifact: nothing here needs to write, and a reader
 * carrying `attest`/`release` in its ABI is a larger surface than the job requires.
 *
 * `amount`, `check` and `attestedAt` are decoded and dropped. They are part of the struct and
 * must stay listed or the tuple decodes at the wrong offsets, but this module has no business
 * with them — and `check` in particular is already covered, since the criteria hashed into
 * `criteriaHash` carry their own `check` field.
 *
 * `escrowAbi` stays overridable so a redeployed escrow with a changed struct can be supplied
 * without editing this file, but the default is now the real thing rather than a guess.
 */
const DEFAULT_ESCROW_ABI = [
  {
    type: 'function',
    name: 'milestoneAt',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'amount', type: 'uint128' },
          { name: 'check', type: 'uint8' },
          { name: 'state', type: 'uint8' },
          { name: 'submissions', type: 'uint32' },
          { name: 'attestedAt', type: 'uint64' },
          { name: 'criteriaHash', type: 'bytes32' },
          { name: 'evidenceHash', type: 'bytes32' },
        ],
      },
    ],
  },
] as const

type AbiLike = readonly unknown[]

/**
 * A `MilestoneReader` over a real node.
 *
 * `rpcUrl` is a parameter rather than a `process.env` read so nothing resolves at import time;
 * the route composes this once from its own config.
 *
 * Read errors are left to propagate. `assertBound` catches them and turns them into
 * `chain-unreachable`, which is the only place that classification should be made.
 */
export function makeRpcMilestoneReader(rpcUrl: string, escrowAbi: AbiLike = DEFAULT_ESCROW_ABI): MilestoneReader {
  return async (escrow, milestone) => {
    // Imported lazily so a route that never reaches the chain — and every unit test — pays
    // neither the module cost nor the risk of viem touching globals at import time.
    const { createPublicClient, http } = await import('viem')
    const client = createPublicClient({ transport: http(rpcUrl) })

    const raw: unknown = await client.readContract({
      address: escrow as `0x${string}`,
      // The ABI is opaque to us by design (callers may pass their own artifact), so viem's
      // inference cannot help; the shape is re-checked by `normaliseMilestone` either way.
      abi: escrowAbi as never,
      functionName: 'milestoneAt',
      args: [BigInt(milestone)],
    })

    return decodeMilestone(raw)
  }
}

/**
 * Fields are read by name, never by position.
 *
 * `Milestone` is a named struct, so viem hands back an object. Reading positionally would have
 * been quietly catastrophic here: index 0 of that struct is `amount`, not `criteriaHash`, so a
 * positional decode would compare a criteria hash against a wei value and report every honest
 * request as a criteria substitution.
 *
 * `Number()` is safe for these two and only these two: `submissions` is a uint32 and `state` a
 * uint8, both far inside the safe-integer range. `amount` is a uint128 and is not touched.
 * Anything that decodes to a non-number is caught by `normaliseMilestone` and becomes a 502.
 */
function decodeMilestone(raw: unknown): MilestoneOnChain {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`milestoneAt returned ${raw === null ? 'null' : typeof raw}, expected a struct`)
  }
  const m = raw as Record<string, unknown>

  return {
    criteriaHash: String(m.criteriaHash) as `0x${string}`,
    evidenceHash: String(m.evidenceHash) as `0x${string}`,
    submissions: Number(m.submissions),
    state: Number(m.state),
  }
}
