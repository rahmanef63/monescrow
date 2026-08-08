/**
 * Guards the one cast in the chain reader that TypeScript cannot check.
 *
 * `createChainReader` reads `summary(address)` and `milestones()` and casts the results
 * through `unknown` into locally declared row types, because inferring them from the full
 * generated ABI is slow and brittle. That cast is a promise the compiler does not verify: if
 * a struct field in `Escrow.sol` is renamed, reordered or retyped, the reader keeps compiling
 * and starts reading `undefined` at runtime — on a page whose whole job is telling somebody
 * whether their money moved.
 *
 * These tests read the generated ABI and assert the promise still holds. They need no network
 * and no chain: `abis.ts` is regenerated from the compiled artifacts by `npm run gen:abi`, so
 * a contract change reaches this file the moment the ABI is regenerated.
 */
import { describe, expect, it } from 'vitest'
import { escrowAbi, escrowFactoryAbi } from '@/lib/abis'

type AbiParam = { name: string; type: string; components?: readonly AbiParam[] }
type AbiEntry = {
  type: string
  name?: string
  inputs?: readonly AbiParam[]
  outputs?: readonly AbiParam[]
}

const entries = escrowAbi as readonly AbiEntry[]

const fn = (name: string): AbiEntry => {
  const found = entries.find((e) => e.type === 'function' && e.name === name)
  if (!found) throw new Error(`Escrow ABI has no function ${name}`)
  return found
}

/** `[name, solidityType]` for each field of a struct return, in declaration order. */
const structFields = (name: string, outputIndex = 0): [string, string][] => {
  const out = fn(name).outputs?.[outputIndex]
  if (!out?.components) throw new Error(`${name} output ${outputIndex} is not a struct`)
  return out.components.map((c) => [c.name, c.type])
}

describe('the chain reader casts match the generated ABI', () => {
  /**
   * Mirrors `ChainSummary` in route.ts, field for field. viem returns named struct fields, so
   * a rename breaks the reader silently and a reorder does not — but both are recorded here,
   * because a reorder that accompanies a rename is exactly how this drifts unnoticed.
   */
  it('summary() returns the fields ChainSummary declares', () => {
    expect(structFields('summary')).toEqual([
      ['escrow', 'address'],
      ['client', 'address'],
      ['freelancer', 'address'],
      ['verifier', 'address'],
      ['arbiter', 'address'],
      ['totalAmount', 'uint256'],
      ['releasedAmount', 'uint256'],
      ['refundedAmount', 'uint256'],
      ['deadline', 'uint64'],
      ['challengeWindow', 'uint32'],
      ['acceptedAt', 'uint64'],
      ['cancelled', 'bool'],
      ['termsHash', 'bytes32'],
      ['title', 'string'],
      ['accountOwed', 'uint256'],
    ])
  })

  /** Mirrors `ChainMilestone`. */
  it('milestones() returns the fields ChainMilestone declares', () => {
    expect(structFields('milestones')).toEqual([
      ['amount', 'uint128'],
      ['check', 'uint8'],
      ['state', 'uint8'],
      ['submissions', 'uint32'],
      ['attestedAt', 'uint64'],
      ['criteriaHash', 'bytes32'],
      ['evidenceHash', 'bytes32'],
    ])
  })

  /**
   * Width matters as much as name. viem hands back `bigint` for anything wider than 48 bits
   * and `number` below it, so a uint32 widened to uint64 turns a `number` field into a
   * `bigint` and every arithmetic comparison against it starts throwing at runtime.
   */
  it('keeps the widths that decide bigint versus number', () => {
    const summary = Object.fromEntries(structFields('summary'))
    expect(summary.challengeWindow).toBe('uint32') // read as number
    expect(summary.deadline).toBe('uint64') // read as bigint
    expect(summary.acceptedAt).toBe('uint64')

    const milestone = Object.fromEntries(structFields('milestones'))
    expect(milestone.submissions).toBe('uint32') // number
    expect(milestone.amount).toBe('uint128') // bigint
    expect(milestone.attestedAt).toBe('uint64') // bigint
  })

  // The countdown reads this directly; a widening here would break every timer in the UI.
  it('releasableAt() still returns a single uint64', () => {
    expect(fn('releasableAt').outputs?.map((o) => o.type)).toEqual(['uint64'])
    expect(fn('challengeRemaining').outputs?.map((o) => o.type)).toEqual(['uint256'])
  })

  /**
   * The C1 external surface. Not exhaustive coverage of the ABI — a list of the entry points
   * the frontend actually encodes, so one being renamed fails here rather than at the moment
   * somebody presses a button with a funded escrow behind it.
   */
  it('still exposes every action the UI encodes', () => {
    const names = entries.filter((e) => e.type === 'function').map((e) => e.name)
    for (const required of [
      'accept',
      'cancel',
      'submit',
      'attest',
      'approve',
      'release',
      'dispute',
      'resolveDispute',
      'reclaim',
      'withdraw',
      'milestoneAt',
      'milestoneCount',
      'attestationDigest',
      'owed',
      'MIN_CHALLENGE_WINDOW',
      'MAX_CHALLENGE_WINDOW',
    ]) {
      expect(names, `Escrow.${required} is gone from the ABI`).toContain(required)
    }
  })

  it('the factory still exposes the index the dashboard reads', () => {
    const names = (escrowFactoryAbi as readonly AbiEntry[])
      .filter((e) => e.type === 'function')
      .map((e) => e.name)
    for (const required of ['createEscrow', 'escrowsOf', 'escrowCountOf', 'getEscrows', 'isEscrow']) {
      expect(names, `EscrowFactory.${required} is gone from the ABI`).toContain(required)
    }
  })

  /**
   * The bounds the /new preset list must respect. D-7 rejects anything outside them at
   * construction, so a preset outside this range is a create transaction that reverts after
   * the user has already paid gas.
   */
  it('records the challenge-window bounds the presets must sit inside', () => {
    const bounded = entries.filter(
      (e) => e.type === 'function' && (e.name === 'MIN_CHALLENGE_WINDOW' || e.name === 'MAX_CHALLENGE_WINDOW'),
    )
    expect(bounded).toHaveLength(2)
    for (const b of bounded) expect(b.outputs?.[0].type).toBe('uint32')
  })
})
