/**
 * The pure half of the transaction discipline.
 *
 * Everything under test here runs without React, without a wallet and without a chain: the state
 * machine that decides what may follow what, and the decoder that turns a revert into the
 * contract's own vocabulary. Those are the two places a mistake would be invisible in a demo and
 * expensive in production — a machine that accepts a stale receipt, or an error surfaced as
 * `0x1f2a…` to somebody who just wanted to know why the button did nothing.
 */

import { describe, expect, it } from 'vitest'
import { ContractFunctionRevertedError, RawContractError, encodeErrorResult } from 'viem'
import { escrowAbi } from '@/lib/abis'
import { GAS_LIMIT_PADDING_PERCENT, withGasPadding } from '@/lib/chain'
import {
  decodeTxError,
  formatCost,
  initialTxState,
  requestKey,
  txExplorerUrl,
  txReducer,
  type TxEvent,
  type TxState,
} from '@/lib/useTxFlow'

/** Feed the machine a script and hand back where it ended up. */
function run(events: TxEvent[], from: TxState = initialTxState): TxState {
  return events.reduce(txReducer, from)
}

const GAS_ESTIMATE = 90_000n
const GAS_LIMIT = withGasPadding(GAS_ESTIMATE)
const GAS_PRICE = 52_000_000_000n // 52 gwei
const HASH = `0x${'ab'.repeat(32)}` as const

const PREPARED: TxEvent = {
  type: 'prepared',
  gasEstimate: GAS_ESTIMATE,
  gasLimit: GAS_LIMIT,
  gasPrice: GAS_PRICE,
}

describe('txReducer — the happy path', () => {
  it('walks idle -> simulating -> ready -> confirming -> pending -> success', () => {
    let s = initialTxState
    expect(s.phase).toBe('idle')

    s = txReducer(s, { type: 'prepare' })
    expect(s.phase).toBe('simulating')

    s = txReducer(s, PREPARED)
    expect(s.phase).toBe('ready')

    s = txReducer(s, { type: 'confirm' })
    expect(s.phase).toBe('confirming')

    s = txReducer(s, { type: 'sent', hash: HASH })
    expect(s.phase).toBe('pending')
    expect(s.hash).toBe(HASH)

    s = txReducer(s, { type: 'mined', hash: HASH })
    expect(s.phase).toBe('success')
    expect(s.hash).toBe(HASH)
  })

  it('keeps the quoted cost visible all the way through the send', () => {
    const s = run([{ type: 'prepare' }, PREPARED, { type: 'confirm' }, { type: 'sent', hash: HASH }])
    expect(s.gasLimit).toBe(GAS_LIMIT)
    expect(s.gasPrice).toBe(GAS_PRICE)
    expect(s.costWei).toBe(GAS_LIMIT * GAS_PRICE)
  })
})

describe('txReducer — the cost is the limit, not the estimate', () => {
  it('quotes gasLimit * gasPrice, because Monad charges the limit', () => {
    const s = run([{ type: 'prepare' }, PREPARED])
    expect(s.costWei).toBe(GAS_LIMIT * GAS_PRICE)
    // The estimate would under-quote, which is exactly the mistake this app must not make.
    expect(s.costWei).toBeGreaterThan(GAS_ESTIMATE * GAS_PRICE)
  })

  it('the limit is the padded estimate', () => {
    const s = run([{ type: 'prepare' }, PREPARED])
    expect(s.gasEstimate).toBe(GAS_ESTIMATE)
    expect(s.gasLimit).toBe((GAS_ESTIMATE * (100n + GAS_LIMIT_PADDING_PERCENT)) / 100n)
  })
})

describe('txReducer — events that arrive out of order are ignored', () => {
  it('will not accept a hash it never sent', () => {
    const before = run([{ type: 'prepare' }])
    const after = txReducer(before, { type: 'sent', hash: HASH })
    expect(after).toBe(before) // same object: nothing happened at all
  })

  it('will not go straight from ready to pending without a confirm', () => {
    const before = run([{ type: 'prepare' }, PREPARED])
    expect(txReducer(before, { type: 'sent', hash: HASH })).toBe(before)
  })

  it('will not reach the wallet without a quote on screen first', () => {
    // `confirm` from idle, from simulating and from error are all refused.
    expect(txReducer(initialTxState, { type: 'confirm' })).toBe(initialTxState)
    const simulating = run([{ type: 'prepare' }])
    expect(txReducer(simulating, { type: 'confirm' })).toBe(simulating)
  })

  it('will not re-simulate underneath a transaction already in the wallet or the mempool', () => {
    const confirming = run([{ type: 'prepare' }, PREPARED, { type: 'confirm' }])
    expect(txReducer(confirming, { type: 'prepare' })).toBe(confirming)

    const pending = txReducer(confirming, { type: 'sent', hash: HASH })
    expect(txReducer(pending, { type: 'prepare' })).toBe(pending)
  })

  it('drops a late receipt for a flow that already finished', () => {
    const done = run([
      { type: 'prepare' },
      PREPARED,
      { type: 'confirm' },
      { type: 'sent', hash: HASH },
      { type: 'mined', hash: HASH },
    ])
    expect(txReducer(done, { type: 'mined', hash: HASH })).toBe(done)
    expect(
      txReducer(done, { type: 'failed', error: { message: 'too late' } }),
    ).toBe(done)
  })

  it('drops a stale simulation result that lands after a reset', () => {
    const reset = run([{ type: 'prepare' }, { type: 'reset' }])
    expect(reset).toEqual(initialTxState)
    expect(txReducer(reset, PREPARED)).toBe(reset)
  })
})

describe('txReducer — failure', () => {
  it('a simulation revert lands in error carrying the decoded reason', () => {
    const s = run([
      { type: 'prepare' },
      { type: 'failed', error: { name: 'ChallengeWindowOpen', message: 'still open' } },
    ])
    expect(s.phase).toBe('error')
    expect(s.error?.name).toBe('ChallengeWindowOpen')
    expect(s.hash).toBeUndefined()
  })

  it('a mined-but-reverted transaction keeps its hash so it can be linked', () => {
    const s = run([
      { type: 'prepare' },
      PREPARED,
      { type: 'confirm' },
      { type: 'sent', hash: HASH },
      { type: 'reverted', hash: HASH, error: { message: 'reverted on chain' } },
    ])
    expect(s.phase).toBe('error')
    expect(s.hash).toBe(HASH)
  })

  it('a rejection in the wallet is an error phase but flagged as the user’s choice', () => {
    const s = run([
      { type: 'prepare' },
      PREPARED,
      { type: 'confirm' },
      { type: 'failed', error: { message: 'you rejected it', rejected: true } },
    ])
    expect(s.phase).toBe('error')
    expect(s.error?.rejected).toBe(true)
    // The quote survives, so retrying does not have to start from nothing on screen.
    expect(s.costWei).toBe(GAS_LIMIT * GAS_PRICE)
  })

  it('reset clears everything, from any phase', () => {
    const failed = run([{ type: 'prepare' }, { type: 'failed', error: { message: 'nope' } }])
    expect(txReducer(failed, { type: 'reset' })).toEqual(initialTxState)

    const done = run([
      { type: 'prepare' },
      PREPARED,
      { type: 'confirm' },
      { type: 'sent', hash: HASH },
      { type: 'mined', hash: HASH },
    ])
    expect(txReducer(done, { type: 'reset' })).toEqual(initialTxState)
  })

  it('re-preparing after an error starts from a clean slate', () => {
    const s = run([
      { type: 'prepare' },
      PREPARED,
      { type: 'confirm' },
      { type: 'failed', error: { message: 'rpc died' } },
      { type: 'prepare' },
    ])
    expect(s).toEqual({ phase: 'simulating' })
    expect(s.error).toBeUndefined()
    expect(s.costWei).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */

/** A revert exactly as an RPC node hands it back: a selector plus its arguments, in hex. */
function revertData(errorName: string, args?: readonly unknown[]) {
  return encodeErrorResult({
    abi: escrowAbi,
    // The generated ABI is `as const`, so encodeErrorResult wants the literal union. The names
    // below are real entries in it; the cast only relaxes the literal check.
    errorName,
    args,
  } as Parameters<typeof encodeErrorResult>[0])
}

describe('decodeTxError — custom errors reach the user by name', () => {
  it('decodes ChallengeWindowOpen out of a raw viem contract error', () => {
    const releasableAt = 1_800_000_000n
    const err = new RawContractError({
      data: revertData('ChallengeWindowOpen', [releasableAt]),
    })

    const decoded = decodeTxError(err)
    expect(decoded.name).toBe('ChallengeWindowOpen')
    expect(decoded.args).toEqual([releasableAt.toString()])
    expect(decoded.message).toContain('challenge window')
    // Never the hex. The point of the exercise.
    expect(decoded.message).not.toContain('0x')
  })

  it('decodes an error viem already resolved against the ABI', () => {
    const err = new ContractFunctionRevertedError({
      abi: escrowAbi,
      data: revertData('NotClient'),
      functionName: 'dispute',
    })

    const decoded = decodeTxError(err)
    expect(decoded.name).toBe('NotClient')
    expect(decoded.message).toContain('client')
    expect(decoded.args).toBeUndefined()
  })

  it('decodes an error argument that is an enum ordinal', () => {
    const decoded = decodeTxError(new RawContractError({ data: revertData('WrongState', [3]) }))
    expect(decoded.name).toBe('WrongState')
    expect(decoded.args).toEqual(['3'])
  })

  it('finds revert data nested behind a chain of causes', () => {
    const inner = new RawContractError({ data: revertData('NothingOwed') })
    const outer = new Error('Execution reverted', { cause: new Error('rpc', { cause: inner }) })

    const decoded = decodeTxError(outer)
    expect(decoded.name).toBe('NothingOwed')
    expect(decoded.message).toContain('owed nothing')
  })

  it('finds revert data wrapped as { data: { data } }, the shape some nodes use', () => {
    const err = { data: { data: revertData('StaleSubmission', [2, 3]) } }
    const decoded = decodeTxError(err)
    expect(decoded.name).toBe('StaleSubmission')
    expect(decoded.args).toEqual(['2', '3'])
  })

  it('names an error it has no sentence for rather than dropping it', () => {
    // TitleTooLong has an explanation; pick one and delete it from the lookup path by using an
    // error the map does not describe — InvalidShortString is in the ABI, not in the map.
    const decoded = decodeTxError(new RawContractError({ data: revertData('InvalidShortString') }))
    expect(decoded.name).toBe('InvalidShortString')
    expect(decoded.message).toContain('InvalidShortString')
  })
})

describe('decodeTxError — everything else', () => {
  it('treats an EIP-1193 rejection as a decision, not a fault', () => {
    const decoded = decodeTxError({ code: 4001, message: 'User rejected the request.' })
    expect(decoded.rejected).toBe(true)
    expect(decoded.name).toBeUndefined()
    expect(decoded.message).toContain('rejected')
  })

  it('treats an ethers-style ACTION_REJECTED the same way', () => {
    expect(decodeTxError({ code: 'ACTION_REJECTED' }).rejected).toBe(true)
  })

  it('does not invent a name for a selector this ABI does not know', () => {
    const decoded = decodeTxError(
      new RawContractError({ data: '0xdeadbeef', message: 'execution reverted' }),
    )
    expect(decoded.name).toBeUndefined()
    expect(decoded.message.length).toBeGreaterThan(0)
  })

  it('survives a plain Error, a string and a null', () => {
    expect(decodeTxError(new Error('rpc timeout')).message).toBe('rpc timeout')
    expect(decodeTxError('boom').message).toBe('boom')
    expect(decodeTxError(null).message.length).toBeGreaterThan(0)
    expect(decodeTxError(undefined).name).toBeUndefined()
  })

  it('does not loop forever on a self-referential cause chain', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' }
    a.cause = a
    expect(() => decodeTxError(a)).not.toThrow()
  })
})

describe('formatCost', () => {
  it('quotes MON to six decimals with the ≈ that says "at most"', () => {
    expect(formatCost(2_100_000_000_000_000n)).toBe('≈0.0021 MON')
    expect(formatCost(10n ** 18n)).toBe('≈1 MON')
  })

  it('never renders a real cost as "≈0 MON"', () => {
    expect(formatCost(1n)).toBe('<0.000001 MON')
  })

  it('says zero when it really is zero', () => {
    expect(formatCost(0n)).toBe('≈0 MON')
  })
})

describe('requestKey', () => {
  it('is stable across re-created object literals', () => {
    const a = { address: '0xAbC0000000000000000000000000000000000001' as const, functionName: 'release', args: [1n] }
    const b = { address: '0xabc0000000000000000000000000000000000001' as const, functionName: 'release', args: [1n] }
    expect(requestKey(a)).toBe(requestKey(b))
  })

  it('changes when the call changes', () => {
    const base = { address: '0xAbC0000000000000000000000000000000000001' as const, functionName: 'release', args: [1n] }
    expect(requestKey({ ...base, args: [2n] })).not.toBe(requestKey(base))
    expect(requestKey({ ...base, functionName: 'approve' })).not.toBe(requestKey(base))
    expect(requestKey({ ...base, value: 5n })).not.toBe(requestKey(base))
  })

  it('is empty for "nothing to send"', () => {
    expect(requestKey(null)).toBe('')
    expect(requestKey(undefined)).toBe('')
  })
})

describe('txExplorerUrl', () => {
  it('points at MonadVision', () => {
    expect(txExplorerUrl(HASH)).toBe(`https://testnet.monadexplorer.com/tx/${HASH}`)
  })

  it('is null with no hash', () => {
    expect(txExplorerUrl(undefined)).toBeNull()
  })
})
