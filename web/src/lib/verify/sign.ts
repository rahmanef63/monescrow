/**
 * C2 — the EIP-712 attestation the verifier signs.
 *
 * What a signature from here means, exactly: *at `checkedAt`, running the criteria the client
 * published produced these observations, and every one of them passed.* Nothing more. The
 * checks themselves are weak on purpose — an HTTP 200 is satisfied by a blank page — so this
 * signature is a **proposal** that opens the challenge window, never a verdict that the work
 * was done. The contract, the client's right to object, and the arbiter are what turn a
 * proposal into money moving. Do not add anything to this payload that would widen it.
 *
 * Two things in this file are load-bearing to the byte:
 *
 *  1. The domain and the type string must match C2 exactly. EIP-712 has no negotiation and no
 *     error channel — a wrong `version`, a wrong chainId, or two fields swapped in the `types`
 *     array all produce a perfectly well-formed signature that recovers to a *different*
 *     address. The contract then rejects it as "not the verifier" with nothing anywhere saying
 *     why. `sign.test.ts` rebuilds the digest by hand from the verbatim C2 strings to catch it.
 *
 *  2. The private key is radioactive. It is never logged, never returned, never interpolated
 *     into an error message, and never attached as an error `cause` — viem's own hex/curve
 *     errors can quote the value they rejected, so every call that touches the key is wrapped
 *     and rethrown with a message this file wrote.
 */

import { hashTypedData, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** Monad testnet. Part of the domain, so a signature made here cannot be replayed on another chain. */
export const DEFAULT_CHAIN_ID = 10143

export const ATTESTATION_DOMAIN_NAME = 'MonEscrow'
export const ATTESTATION_DOMAIN_VERSION = '1'

/**
 * C2 verbatim:
 *
 *     Attestation(uint256 milestone,uint32 submission,bool passed,bytes32 evidenceHash,bytes32 reportHash)
 *
 * The order of this array *is* the type string viem derives, which *is* what gets hashed.
 * Reordering it is a silent signature break, not a formatting change.
 */
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'milestone', type: 'uint256' },
    { name: 'submission', type: 'uint32' },
    { name: 'passed', type: 'bool' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'reportHash', type: 'bytes32' },
  ],
} as const

export type Bytes32 = `0x${string}`
export type Address = `0x${string}`

export type AttestationParams = {
  /** The escrow contract. Pinned into the domain, so the signature is useless against any other escrow. */
  escrow: Address
  /** Milestone index. `uint256` on the wire; accepted as number or bigint. */
  milestone: number | bigint
  /**
   * Which submission this attestation is about. Together with `evidenceHash` this is the
   * anti-replay pair: when a freelancer resubmits, the submission counter moves and every
   * previously signed pass stops matching what the contract computes.
   */
  submission: number
  /** True only when every check in the report passed. This module does not decide that; `report.ts` does. */
  passed: boolean
  evidenceHash: Bytes32
  reportHash: Bytes32
  /** Defaults to Monad testnet. Explicit only so tests can prove the chain is really pinned. */
  chainId?: number
}

const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/
const UINT32_MAX = 4_294_967_295

/**
 * Read and shape-check `VERIFIER_PRIVATE_KEY` out of an injected env bag.
 *
 * `env` is a parameter rather than a read of `process.env` so that nothing captures a key at
 * import time and so tests can exercise the malformed paths without ever putting a real key in
 * the process. The thrown messages describe the *shape* that was expected and never quote the
 * value — a key that leaks into a log line or an error tracker is compromised, and error
 * strings travel much further than anyone plans for.
 */
export function loadVerifierKey(env: Record<string, string | undefined>): `0x${string}` {
  const raw = env.VERIFIER_PRIVATE_KEY

  if (raw === undefined || raw === '') {
    throw new Error('VERIFIER_PRIVATE_KEY is not set')
  }

  // Keys arriving via .env files and CI secrets routinely carry a trailing newline. Trimming is
  // the difference between "works" and an unexplained malformed-key crash on deploy.
  const key = raw.trim()

  if (!HEX_32_BYTES.test(key)) {
    throw new Error(
      'VERIFIER_PRIVATE_KEY is malformed: expected a 0x-prefixed 32-byte hex string ' +
        `(66 characters, got ${key.length})`,
    )
  }

  return key as `0x${string}`
}

/**
 * Sign one attestation and return both the signature and the digest it was made over.
 *
 * The digest is returned rather than recomputed by the caller because the caller would have to
 * restate the domain and the types to do it, and a second copy of C2 is a second thing that can
 * drift. It is the same value the contract derives before `ecrecover`, so a caller can check a
 * signature against it without trusting this function's arithmetic.
 */
export async function signAttestation(
  params: AttestationParams,
  privateKey: string,
): Promise<{ signature: `0x${string}`; digest: `0x${string}` }> {
  const { escrow, submission, passed, evidenceHash, reportHash } = params
  const chainId = params.chainId ?? DEFAULT_CHAIN_ID

  // Validate before signing. A signature over a malformed field is worse than an error: viem
  // would happily encode a mis-sized "bytes32" or a lowercase-but-invalid address in some cases,
  // and the result is an on-chain rejection with no local trace of the cause.
  if (!isAddress(escrow)) {
    throw new Error(`signAttestation: escrow is not a valid address: ${String(escrow)}`)
  }
  if (!HEX_32_BYTES.test(evidenceHash)) {
    throw new Error('signAttestation: evidenceHash must be a 0x-prefixed 32-byte hex string')
  }
  if (!HEX_32_BYTES.test(reportHash)) {
    throw new Error('signAttestation: reportHash must be a 0x-prefixed 32-byte hex string')
  }
  if (!Number.isInteger(submission) || submission < 0 || submission > UINT32_MAX) {
    throw new Error(`signAttestation: submission must fit uint32, got ${String(submission)}`)
  }
  if (typeof passed !== 'boolean') {
    throw new Error('signAttestation: passed must be a boolean')
  }

  const milestone = toMilestone(params.milestone)

  const domain = {
    name: ATTESTATION_DOMAIN_NAME,
    version: ATTESTATION_DOMAIN_VERSION,
    chainId,
    verifyingContract: escrow,
  } as const

  const message = { milestone, submission, passed, evidenceHash, reportHash } as const

  const typedData = {
    domain,
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation',
    message,
  } as const

  // Wrapped because viem/noble reject a bad key by throwing an error that can contain the key.
  // No `cause` is attached for the same reason: `cause` chains get serialised by loggers.
  let account: ReturnType<typeof privateKeyToAccount>
  try {
    account = privateKeyToAccount(privateKey as `0x${string}`)
  } catch {
    throw new Error(
      'signAttestation: the verifier private key was rejected ' +
        '(expected a 0x-prefixed 32-byte hex secp256k1 key); value withheld',
    )
  }

  let signature: `0x${string}`
  try {
    signature = await account.signTypedData(typedData)
  } catch {
    // Signing itself is arithmetic over the key, so its failures can quote key material too.
    throw new Error('signAttestation: signing failed; details withheld to avoid leaking key material')
  }

  return { signature, digest: hashTypedData(typedData) }
}

/**
 * `uint256` on the wire, but callers hold milestone indices as plain numbers (C5's report does).
 * A non-integer or unsafe number is refused rather than rounded: silently signing milestone 3
 * when the caller meant 3.5 — or when they meant a value past 2^53 — attests to the wrong
 * milestone, and the signature is valid, so nothing downstream would notice.
 */
function toMilestone(value: number | bigint): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('signAttestation: milestone must not be negative')
    return value
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`signAttestation: milestone must be a non-negative safe integer, got ${String(value)}`)
  }
  return BigInt(value)
}
