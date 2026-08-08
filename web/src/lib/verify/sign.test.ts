/**
 * Tests for C2 signing.
 *
 * Two families of property live here:
 *
 *   - **The encoding is exactly C2.** EIP-712 fails silently: a wrong domain field or a swapped
 *     pair of struct members yields a valid signature that recovers to the wrong address. So one
 *     test rebuilds the digest from the verbatim C2 strings with raw abi encoding + keccak, and
 *     the mutation tests confirm every field actually moves the signature.
 *   - **The key never escapes.** Anything thrown from this module is asserted not to contain the
 *     key, because an error message is the easiest place in a codebase for a secret to end up.
 *
 * No network, no `process.env`: `loadVerifierKey` takes an env bag and signing is local ECDSA.
 */

import { describe, expect, it } from 'vitest'
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  recoverTypedDataAddress,
  stringToHex,
  verifyTypedData,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  ATTESTATION_TYPES,
  DEFAULT_CHAIN_ID,
  loadVerifierKey,
  signAttestation,
  type AttestationParams,
} from './sign'

// A throwaway key. Never used anywhere but this file; the point of the hygiene tests is that
// even a value this worthless is not allowed into an error string.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const ACCOUNT = privateKeyToAccount(KEY)

const ESCROW = '0x1111111111111111111111111111111111111111' as const
const EVIDENCE_HASH = `0x${'11'.repeat(32)}` as const
const REPORT_HASH = `0x${'22'.repeat(32)}` as const

const BASE: AttestationParams = {
  escrow: ESCROW,
  milestone: 3,
  submission: 7,
  passed: true,
  evidenceHash: EVIDENCE_HASH,
  reportHash: REPORT_HASH,
}

/** The typed-data object a verifier of this signature would reconstruct — i.e. what the contract knows. */
function typedDataFor(p: AttestationParams) {
  return {
    domain: {
      name: 'MonEscrow',
      version: '1',
      chainId: p.chainId ?? DEFAULT_CHAIN_ID,
      verifyingContract: p.escrow,
    },
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation',
    message: {
      milestone: BigInt(p.milestone),
      submission: p.submission,
      passed: p.passed,
      evidenceHash: p.evidenceHash,
      reportHash: p.reportHash,
    },
  } as const
}

describe('signAttestation — the payload is C2 to the byte', () => {
  it('produces the digest an independent EIP-712 implementation derives from the verbatim C2 strings', async () => {
    // Property: the domain and the type string match C2 exactly. This is deliberately NOT built
    // with viem's hashTypedData — it is hand-rolled from the literal text in the spec, so a typo
    // in name/version/chainId or a reordering of the struct members fails here rather than
    // surfacing months later as "the contract says the signature is not from the verifier".
    const attestationTypeHash = keccak256(
      stringToHex(
        'Attestation(uint256 milestone,uint32 submission,bool passed,bytes32 evidenceHash,bytes32 reportHash)',
      ),
    )
    const structHash = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32, uint256, uint32, bool, bytes32, bytes32'), [
        attestationTypeHash,
        3n,
        7,
        true,
        EVIDENCE_HASH,
        REPORT_HASH,
      ]),
    )

    const domainTypeHash = keccak256(
      stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    )
    const domainSeparator = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [
        domainTypeHash,
        keccak256(stringToHex('MonEscrow')),
        keccak256(stringToHex('1')),
        BigInt(DEFAULT_CHAIN_ID),
        ESCROW,
      ]),
    )

    const expected = keccak256(concatHex(['0x1901', domainSeparator, structHash]))

    const { digest } = await signAttestation(BASE, KEY)
    expect(digest).toBe(expected)
  })

  it('defaults chainId to Monad testnet 10143', async () => {
    // Property: callers that omit chainId get the chain C2 names, not whatever viem infers.
    const implicit = await signAttestation(BASE, KEY)
    const explicit = await signAttestation({ ...BASE, chainId: 10143 }, KEY)
    expect(implicit.digest).toBe(explicit.digest)
    expect(DEFAULT_CHAIN_ID).toBe(10143)
  })

  it('accepts milestone as a bigint identically to a number', async () => {
    // Property: uint256 on the wire; the caller's JS representation must not change the digest.
    const asNumber = await signAttestation({ ...BASE, milestone: 3 }, KEY)
    const asBigint = await signAttestation({ ...BASE, milestone: 3n }, KEY)
    expect(asBigint.digest).toBe(asNumber.digest)
    expect(asBigint.signature).toBe(asNumber.signature)
  })

  it('is deterministic for the same input', async () => {
    // Property: RFC 6979 deterministic ECDSA. Two runs of the same verification must not produce
    // two different signatures, or a retry would look like a second, conflicting attestation.
    const a = await signAttestation(BASE, KEY)
    const b = await signAttestation(BASE, KEY)
    expect(a.signature).toBe(b.signature)
  })
})

describe('signAttestation — recovery', () => {
  it('recovers to the signing account', async () => {
    // Property: the thing the contract will do — recover the signer from the digest — yields the
    // verifier address. Without this, everything else is signing into the void.
    const { signature } = await signAttestation(BASE, KEY)
    const recovered = await recoverTypedDataAddress({ ...typedDataFor(BASE), signature })
    expect(recovered).toBe(ACCOUNT.address)
    await expect(
      verifyTypedData({ ...typedDataFor(BASE), address: ACCOUNT.address, signature }),
    ).resolves.toBe(true)
  })
})

describe('signAttestation — every field is bound into the signature', () => {
  // Property: replay protection. Each case signs a MUTATED payload and then recovers it against
  // the ORIGINAL payload — exactly what happens when a contract holding state X is handed a
  // signature made over state Y. Recovering to anything other than the verifier is the contract
  // rejecting it. A field missing from the type array would silently pass recovery here.
  const mutations: Array<[string, AttestationParams]> = [
    ['passed flipped', { ...BASE, passed: false }],
    ['submission bumped (the freelancer resubmitted)', { ...BASE, submission: 8 }],
    ['different milestone', { ...BASE, milestone: 4 }],
    ['different evidenceHash', { ...BASE, evidenceHash: `0x${'33'.repeat(32)}` }],
    ['different reportHash', { ...BASE, reportHash: `0x${'44'.repeat(32)}` }],
    ['different chainId', { ...BASE, chainId: 1 }],
    ['different escrow', { ...BASE, escrow: '0x2222222222222222222222222222222222222222' }],
  ]

  for (const [name, mutated] of mutations) {
    it(`a signature over a payload with ${name} does not recover to the signer`, async () => {
      const { signature } = await signAttestation(mutated, KEY)

      const original = await signAttestation(BASE, KEY)
      expect(signature).not.toBe(original.signature)

      const recovered = await recoverTypedDataAddress({ ...typedDataFor(BASE), signature })
      expect(recovered).not.toBe(ACCOUNT.address)
      await expect(
        verifyTypedData({ ...typedDataFor(BASE), address: ACCOUNT.address, signature }),
      ).resolves.toBe(false)
    })
  }
})

describe('signAttestation — malformed input is refused, not signed', () => {
  // Property: a signature is irreversible once it reaches the chain, so anything ambiguous must
  // fail loudly here instead of being encoded into an attestation nobody can retract.
  it('rejects a non-address escrow', async () => {
    await expect(signAttestation({ ...BASE, escrow: '0xnope' as never }, KEY)).rejects.toThrow(
      /not a valid address/,
    )
  })

  it('rejects hashes that are not 32 bytes', async () => {
    await expect(signAttestation({ ...BASE, evidenceHash: '0xdead' as never }, KEY)).rejects.toThrow(
      /evidenceHash/,
    )
    await expect(signAttestation({ ...BASE, reportHash: '0xdead' as never }, KEY)).rejects.toThrow(
      /reportHash/,
    )
  })

  it('rejects a submission outside uint32', async () => {
    await expect(signAttestation({ ...BASE, submission: -1 }, KEY)).rejects.toThrow(/uint32/)
    await expect(signAttestation({ ...BASE, submission: 2 ** 32 }, KEY)).rejects.toThrow(/uint32/)
    await expect(signAttestation({ ...BASE, submission: 1.5 }, KEY)).rejects.toThrow(/uint32/)
  })

  it('rejects a fractional or unsafe milestone rather than rounding it', async () => {
    await expect(signAttestation({ ...BASE, milestone: 3.5 }, KEY)).rejects.toThrow(/milestone/)
    await expect(signAttestation({ ...BASE, milestone: -1 }, KEY)).rejects.toThrow(/milestone/)
    await expect(signAttestation({ ...BASE, milestone: 2 ** 60 }, KEY)).rejects.toThrow(/milestone/)
  })

  it('rejects a non-boolean passed', async () => {
    await expect(signAttestation({ ...BASE, passed: 'yes' as never }, KEY)).rejects.toThrow(/boolean/)
  })
})

describe('the key is radioactive', () => {
  // Property: the key never appears in anything this module emits. Error strings get logged, sent
  // to error trackers, and pasted into issues; a key that reaches one of those is compromised, and
  // whoever holds it can sign passing attestations for every escrow this verifier is trusted on.
  const MALFORMED = '0xdeadbeef'
  const WRONG_LENGTH = `0x${'ab'.repeat(31)}`
  // Structurally valid hex, but zero is not a valid secp256k1 scalar — this is the path where the
  // rejection comes from viem/noble rather than from our own regex.
  const OFF_CURVE = `0x${'00'.repeat(32)}`

  it('loadVerifierKey returns the key when it is well formed', () => {
    expect(loadVerifierKey({ VERIFIER_PRIVATE_KEY: KEY })).toBe(KEY)
  })

  it('loadVerifierKey tolerates surrounding whitespace from .env files and CI secrets', () => {
    expect(loadVerifierKey({ VERIFIER_PRIVATE_KEY: `  ${KEY}\n` })).toBe(KEY)
  })

  it('loadVerifierKey says the variable is missing when it is unset or empty', () => {
    expect(() => loadVerifierKey({})).toThrow(/VERIFIER_PRIVATE_KEY is not set/)
    expect(() => loadVerifierKey({ VERIFIER_PRIVATE_KEY: '' })).toThrow(/VERIFIER_PRIVATE_KEY is not set/)
    expect(() => loadVerifierKey({ VERIFIER_PRIVATE_KEY: undefined })).toThrow(/is not set/)
  })

  it('loadVerifierKey says the variable is malformed without echoing the value', () => {
    for (const bad of [MALFORMED, WRONG_LENGTH, 'not-hex-at-all', KEY.slice(2)]) {
      let message = ''
      try {
        loadVerifierKey({ VERIFIER_PRIVATE_KEY: bad })
        throw new Error('expected loadVerifierKey to throw')
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toMatch(/VERIFIER_PRIVATE_KEY is malformed/)
      expect(message).not.toContain(bad)
    }
  })

  it('loadVerifierKey never echoes a real key, even one it accepts nowhere', () => {
    // The key here is well-formed hex but with an appended character, so it takes the malformed
    // branch while still containing the full secret as a substring.
    const nearMiss = `${KEY}f`
    let message = ''
    try {
      loadVerifierKey({ VERIFIER_PRIVATE_KEY: nearMiss })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toContain(KEY)
    expect(message).not.toContain(KEY.slice(2))
  })

  it('signAttestation does not leak the key when viem rejects it', async () => {
    for (const bad of [MALFORMED, OFF_CURVE, 'garbage']) {
      let caught: unknown
      try {
        await signAttestation(BASE, bad)
        throw new Error('expected signAttestation to throw')
      } catch (err) {
        caught = err
      }
      const err = caught as Error
      expect(err.message).toMatch(/verifier private key|signing failed/)
      expect(err.message).not.toContain(bad)
      // `cause` is checked too: loggers serialise cause chains, and viem's own hex errors quote
      // the value they rejected.
      expect(err.cause).toBeUndefined()
      expect(JSON.stringify({ message: err.message, cause: err.cause, stack: err.stack })).not.toContain(
        bad.slice(2),
      )
    }
  })

  it('signAttestation does not put a valid key into its input-validation errors either', async () => {
    let message = ''
    try {
      await signAttestation({ ...BASE, escrow: '0xnope' as never }, KEY)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toContain(KEY)
    expect(message).not.toContain(KEY.slice(2))
  })

  it('the returned value carries the signature and digest and nothing else', async () => {
    // Property: no accidental passthrough of the key or the account object on the result.
    const result = await signAttestation(BASE, KEY)
    expect(Object.keys(result).sort()).toEqual(['digest', 'signature'])
    expect(JSON.stringify(result)).not.toContain(KEY.slice(2))
  })
})
