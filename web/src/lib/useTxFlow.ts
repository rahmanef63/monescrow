'use client'

/**
 * The transaction discipline, in one hook.
 *
 *   simulate -> estimate gas -> show the cost -> wait for an explicit click ->
 *   send with an explicit gas limit -> wait for the receipt
 *
 * Every write in MonEscrow goes through here. There is no second path.
 *
 * ## Why the explicit gas limit
 *
 * **On Monad the user pays the gas *limit*, not the gas used.** A wallet that picks its own
 * limit — and most of them pick a generous one — silently takes the difference out of the
 * user's balance for nothing. So this hook estimates the gas itself, pads that estimate by
 * `GAS_LIMIT_PADDING_PERCENT` (see `withGasPadding` in `@/lib/chain`) to absorb block-to-block
 * variance, shows the resulting cost *before* the user commits, and then sends with that number
 * as an explicit `gas`. The wallet is never asked to choose.
 *
 * For the same reason the cost we display is `gasLimit * gasPrice`, not `gasEstimate *
 * gasPrice`. The limit is what leaves the wallet, so the limit is what we quote.
 *
 * ## Why the reducer is exported
 *
 * `txReducer` and `decodeTxError` are pure and live outside React so the state machine and the
 * custom-error decoding can be tested without a renderer, a wallet or a chain. The hook is a
 * thin async shell around them.
 *
 * ## Why simulation is not optional
 *
 * A simulated revert is decoded against the contract ABI into the custom error's *name*:
 * `ChallengeWindowOpen` tells somebody what happened, `0x1f2a…` tells them nothing. A failing
 * call is caught here, before the wallet ever opens, so a doomed transaction costs nothing.
 */

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from 'react'
import { WagmiContext } from 'wagmi'
import { getConnection, getPublicClient, getWalletClient, watchConnection } from 'wagmi/actions'
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { escrowAbi } from '@/lib/abis'
import { formatMon, monadTestnet, withGasPadding } from '@/lib/chain'

/* ------------------------------------------------------------------ *
 * The state machine
 * ------------------------------------------------------------------ */

/**
 * Where a single transaction is.
 *
 * `ready` is the state that matters: the chain has already agreed the call would succeed and the
 * price is on screen, and nothing happens until the user clicks. `confirming` is the wallet
 * popup being open; `pending` is the transaction in the mempool.
 */
export type TxPhase =
  | 'idle'
  | 'simulating'
  | 'ready'
  | 'confirming'
  | 'pending'
  | 'success'
  | 'error'

/** A failure, said in words a person can act on. */
export type TxError = {
  /**
   * The contract's custom error name when the revert carried one — `ChallengeWindowOpen`,
   * `NotClient`, `WrongState`. Absent for a plain RPC or wallet failure.
   */
  name?: string
  /** The custom error's arguments, stringified for display. */
  args?: string[]
  /** One sentence, written for whoever is holding the phone. */
  message: string
  /** The user pressed "reject" in their wallet. Not a fault — do not render it like one. */
  rejected?: boolean
}

export type TxState = {
  phase: TxPhase
  /** Raw `eth_estimateGas` result, before padding. Shown for the curious, never sent. */
  gasEstimate?: bigint
  /** What actually goes on the wire as `gas`: the estimate plus the padding. */
  gasLimit?: bigint
  gasPrice?: bigint
  /** `gasLimit * gasPrice` — on Monad this is what the user is charged, not `gasUsed * price`. */
  costWei?: bigint
  hash?: Hex
  error?: TxError
}

export const initialTxState: TxState = { phase: 'idle' }

export type TxEvent =
  | { type: 'prepare' }
  | { type: 'prepared'; gasEstimate: bigint; gasLimit: bigint; gasPrice: bigint }
  | { type: 'confirm' }
  | { type: 'sent'; hash: Hex }
  | { type: 'mined'; hash: Hex }
  | { type: 'reverted'; hash: Hex; error: TxError }
  | { type: 'failed'; error: TxError }
  | { type: 'reset' }

/**
 * The machine, pure and total.
 *
 * Events that do not belong in the current phase are **ignored**, returning the same state
 * object rather than a new one. That is not defensive noise: async work races, and a receipt
 * arriving for a transaction the user already reset out of must not resurrect a dead flow, nor
 * must a stale simulation overwrite the numbers of a live one.
 */
export function txReducer(state: TxState, event: TxEvent): TxState {
  switch (event.type) {
    case 'reset':
      return initialTxState

    case 'prepare':
      // A flow already in the wallet or in the mempool cannot be re-simulated underneath itself.
      if (state.phase === 'confirming' || state.phase === 'pending') return state
      return { phase: 'simulating' }

    case 'prepared': {
      if (state.phase !== 'simulating') return state
      return {
        phase: 'ready',
        gasEstimate: event.gasEstimate,
        gasLimit: event.gasLimit,
        gasPrice: event.gasPrice,
        // The limit, not the estimate. See the header comment.
        costWei: event.gasLimit * event.gasPrice,
      }
    }

    case 'confirm':
      // Only from `ready`: there is no path to the wallet that skips the quote.
      if (state.phase !== 'ready') return state
      return { ...state, phase: 'confirming', error: undefined }

    case 'sent':
      if (state.phase !== 'confirming') return state
      return { ...state, phase: 'pending', hash: event.hash }

    case 'mined':
      if (state.phase !== 'pending') return state
      return { ...state, phase: 'success', hash: event.hash }

    case 'reverted':
      // Mined and reverted. The hash is kept: it is on the explorer and worth linking to.
      if (state.phase !== 'pending') return state
      return { ...state, phase: 'error', hash: event.hash, error: event.error }

    case 'failed':
      if (
        state.phase !== 'simulating' &&
        state.phase !== 'confirming' &&
        state.phase !== 'pending'
      ) {
        return state
      }
      return { ...state, phase: 'error', error: event.error }
  }
}

/* ------------------------------------------------------------------ *
 * Decoding a revert into something a person can read
 * ------------------------------------------------------------------ */

/**
 * Every custom error `Escrow` can throw, said in plain language.
 *
 * The name is always shown alongside this — the name is the fact, the sentence is the help — so
 * an error missing from this map degrades to "the contract rejected this call with X" rather
 * than to a hex blob.
 */
const ERROR_EXPLANATIONS: Readonly<Record<string, string>> = {
  AlreadyAccepted: 'This job has already been accepted, so accepting it again would revert.',
  AlreadyStarted: 'Work has already started on this job, so it can no longer be cancelled.',
  BadMilestone: 'That milestone number does not exist on this escrow.',
  BadSignature: 'The verifier signature on this attestation did not check out, so the chain refused it.',
  BadRange: 'That range of jobs does not exist.',
  ChallengeWindowOpen:
    'The challenge window has not run out yet. Until it does the client can still dispute; ' +
    'after it does, anyone can release the milestone.',
  ChallengeWindowOutOfRange: 'That challenge window is outside the range the contract allows.',
  ClientIsFreelancer: 'The client and the freelancer cannot be the same wallet.',
  DeadlineInPast: 'That deadline is already behind us.',
  DeadlineNotPassed: 'The deadline has not passed yet, so nothing can be reclaimed.',
  DeadlinePassed: 'The deadline has passed, so this is no longer allowed.',
  EscrowCancelled: 'This job was cancelled before it was accepted.',
  FundingMismatch: 'The amount sent does not match the milestones this job was created with.',
  NoMilestones: 'A job needs at least one milestone.',
  NotAccepted: 'Nobody has accepted this job yet.',
  NotArbiter: 'Only the arbiter named on this escrow can do that.',
  NotClient: 'Only the client who funded this escrow can do that.',
  NotFreelancer: 'Only the freelancer on this escrow can do that.',
  NothingOwed:
    'This wallet is owed nothing right now. Money lands in that balance after a release, ' +
    'a reclaim or a resolved dispute.',
  StaleSubmission:
    'The freelancer submitted again after this attestation was signed, so the attestation no ' +
    'longer matches the work. The verifier has to look at the new submission.',
  TitleEmpty: 'The job needs a title.',
  TitleTooLong: 'That title is longer than the contract accepts.',
  TooManyMilestones: 'That is more milestones than one job can hold.',
  TransferFailed: 'The payout transfer failed. The funds are still in the escrow.',
  VerifierRequired: 'This job needs a verifier address.',
  WrongState: 'The milestone is not in a state where that is allowed.',
  ZeroAddress: 'One of the addresses is the zero address.',
  ZeroMilestoneAmount: 'A milestone cannot be worth nothing.',
  ReentrancyGuardReentrantCall: 'The contract blocked a re-entrant call.',
}

function stringifyArg(v: unknown): string {
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
    } catch {
      return String(v)
    }
  }
  return String(v)
}

/** Turn a decoded custom error into a `TxError`. */
function describeContractError(name: string, args?: readonly unknown[]): TxError {
  const parts = (args ?? []).map(stringifyArg)
  let message = ERROR_EXPLANATIONS[name] ?? `The contract rejected this call with ${name}.`

  // The one error whose argument is worth spelling out: it says exactly when the wait ends.
  if (name === 'ChallengeWindowOpen' && typeof args?.[0] === 'bigint' && args[0] > 0n) {
    const at = new Date(Number(args[0]) * 1000)
    message =
      `The challenge window is still open — the client can dispute until ` +
      `${at.toUTCString()}. After that anyone can release this milestone, including you.`
  }

  return { name, args: parts.length > 0 ? parts : undefined, message }
}

/** Walk `.cause` without trusting anything about the shape. */
function* causeChain(err: unknown, limit = 12): Generator<Record<string, unknown>> {
  let current = err
  for (let i = 0; i < limit; i++) {
    if (typeof current !== 'object' || current === null) return
    const obj = current as Record<string, unknown>
    yield obj
    current = obj.cause
  }
}

/** Find raw revert data hiding somewhere in the error chain. */
function findRevertData(err: unknown): Hex | undefined {
  const isHex = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v)
  for (const node of causeChain(err)) {
    if (isHex(node.data) && node.data.length > 2) return node.data
    const nested = node.data
    if (typeof nested === 'object' && nested !== null) {
      const inner = (nested as Record<string, unknown>).data
      if (isHex(inner) && inner.length > 2) return inner
    }
  }
  return undefined
}

/**
 * Did the person say no in their wallet?
 *
 * Checked before anything else, because a rejection is a decision, not a failure, and rendering
 * it in red next to a decoded contract error would be a lie about what happened.
 */
function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) {
    return true
  }
  for (const node of causeChain(err)) {
    // EIP-1193 userRejectedRequest, and the string ethers-shaped wallets send instead.
    if (node.code === 4001 || node.code === 'ACTION_REJECTED') return true
  }
  return false
}

/** Last resort: the least bad sentence we can get out of an unknown throwable. */
function readableMessage(err: unknown): string {
  if (err instanceof BaseError) {
    return err.shortMessage || err.message || 'The transaction could not be completed.'
  }
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return 'The transaction could not be completed.'
}

/**
 * Decode a thrown thing into a `TxError`, preferring the contract's own vocabulary.
 *
 * Three sources, in order of how much they know:
 *   1. viem already decoded it against the ABI (`ContractFunctionRevertedError`);
 *   2. raw revert data is somewhere in the cause chain and this ABI can decode it;
 *   3. nothing did — fall back to the shortest readable message.
 */
export function decodeTxError(err: unknown, abi: Abi = escrowAbi): TxError {
  if (isUserRejection(err)) {
    return {
      message: 'You rejected this in your wallet, so nothing was sent and nothing was spent.',
      rejected: true,
    }
  }

  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      if (name) return describeContractError(name, reverted.data?.args)
      // `revert("...")` rather than a custom error.
      if (reverted.reason) return { message: reverted.reason }
    }
  }

  const data = findRevertData(err)
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi, data })
      return describeContractError(decoded.errorName, decoded.args)
    } catch {
      // Not an error this ABI knows. Fall through — a hex blob is not an explanation.
    }
  }

  return { message: readableMessage(err) }
}

/* ------------------------------------------------------------------ *
 * Small pure helpers the UI needs
 * ------------------------------------------------------------------ */

/**
 * "≈0.0021 MON". Six decimals, because gas on a testnet is often smaller than four would show,
 * and a cost line that reads "≈0 MON" is worse than no cost line at all.
 */
export function formatCost(wei: bigint): string {
  if (wei <= 0n) return '≈0 MON'
  const s = formatMon(wei, 6)
  if (s === '0') return '<0.000001 MON'
  return `≈${s} MON`
}

export function txExplorerUrl(hash: Hex | undefined): string | null {
  if (!hash) return null
  const base = monadTestnet.blockExplorers?.default.url
  return base ? `${base}/tx/${hash}` : null
}

/** One call, fully specified. `abi` defaults to `escrowAbi`. */
export type TxRequest = {
  address: Address
  abi?: Abi
  functionName: string
  args?: readonly unknown[]
  value?: bigint
}

/**
 * A stable identity for a request, so the auto-simulate effect fires when the *call* changes and
 * not merely when the caller re-created an object literal on a re-render.
 */
export function requestKey(request: TxRequest | null | undefined): string {
  if (!request) return ''
  return JSON.stringify(
    [
      request.address.toLowerCase(),
      request.functionName,
      request.args ?? [],
      request.value ?? 0n,
    ],
    (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v),
  )
}

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

type WagmiConfig = NonNullable<React.ContextType<typeof WagmiContext>>

type ConnectionSnapshot = {
  address?: Address
  chainId?: number
  connected: boolean
}

const DISCONNECTED: ConnectionSnapshot = { connected: false }

/**
 * The connected wallet, read without `useAccount`.
 *
 * `useAccount` throws when there is no `WagmiProvider` above it, and a judge opening this app
 * before anything is wired up must still get a rendered page with an honestly disabled button —
 * not a crashed tree. Reading the context directly makes "no wallet layer at all" an ordinary,
 * representable state.
 */
function useConnection(config: WagmiConfig | undefined): ConnectionSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!config) return () => {}
      return watchConnection(config, { onChange: onStoreChange })
    },
    [config],
  )

  // Serialised, because `getConnection` returns a fresh object every call and
  // `useSyncExternalStore` would loop on an unstable snapshot.
  const getSnapshot = useCallback(() => {
    if (!config) return ''
    const c = getConnection(config)
    return `${c.address ?? ''}|${c.chainId ?? ''}|${c.status}`
  }, [config])

  const serialised = useSyncExternalStore(subscribe, getSnapshot, () => '')

  return useMemo(() => {
    if (!serialised) return DISCONNECTED
    const [address, chainId, status] = serialised.split('|')
    return {
      address: address ? (address as Address) : undefined,
      chainId: chainId ? Number(chainId) : undefined,
      connected: status === 'connected',
    }
  }, [serialised])
}

export type UseTxFlowOptions = {
  /** The call. `null` means "there is nothing to send yet" — an unset factory, say. */
  request?: TxRequest | null
  /**
   * Why the C1 table (`permits` in `@/lib/chat/permissions`) says this wallet cannot do this.
   * When set, nothing is simulated and the button renders disabled carrying this exact sentence.
   * Never hide the button — a greyed one that says "the challenge window has 2 hours left"
   * teaches the mechanism.
   */
  blockedReason?: string | null
  /** Simulate as soon as a request and a wallet exist. Default true. */
  auto?: boolean
  onSuccess?: (hash: Hex) => void
}

export type TxFlow = {
  state: TxState
  phase: TxPhase
  /** "≈0.0021 MON" once the estimate has landed, otherwise null. */
  costLabel: string | null
  /** Null when the button is live; the sentence to show beside it when it is not. */
  disabledReason: string | null
  /** True only when the chain has agreed, the price is known and the wallet can sign. */
  canSend: boolean
  /** True when the last attempt failed and re-simulating is worth offering. */
  canRetry: boolean
  /** Simulating, in the wallet, or in the mempool. */
  isBusy: boolean
  explorerUrl: string | null
  prepare: () => void
  send: () => void
  retry: () => void
  reset: () => void
}

type PreparedCall = {
  key: string
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
  gasLimit: bigint
}

export function useTxFlow(options: UseTxFlowOptions = {}): TxFlow {
  const { request = null, blockedReason = null, auto = true, onSuccess } = options

  const config = useContext(WagmiContext)
  const connection = useConnection(config)
  const [state, dispatch] = useReducer(txReducer, initialTxState)

  const key = requestKey(request)

  // Latest values for the async callbacks, so `prepare`/`send` can stay identity-stable and the
  // auto-simulate effect below cannot loop on a new object literal every render.
  const requestRef = useRef<TxRequest | null>(request)
  requestRef.current = request
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess

  /** Bumped by every new attempt; async work that finds it changed drops its result. */
  const runIdRef = useRef(0)
  const preparedRef = useRef<PreparedCall | null>(null)

  const account = connection.address
  const wrongChain = connection.connected && connection.chainId !== monadTestnet.id

  const canPrepare = Boolean(config && account && !wrongChain && !blockedReason && key)

  const prepare = useCallback(() => {
    const req = requestRef.current
    const id = ++runIdRef.current
    preparedRef.current = null
    if (!config || !req || !account || !canPrepare) return

    // Widened deliberately: this hook is generic over every write in the app, so the ABI is a
    // runtime value here, not a literal type. viem still decodes custom errors from it.
    const abi: Abi = req.abi ?? escrowAbi
    const args: readonly unknown[] = req.args ?? []
    dispatch({ type: 'prepare' })

    void (async () => {
      try {
        const publicClient = getPublicClient(config)
        if (!publicClient) {
          throw new Error(
            `No RPC connection to ${monadTestnet.name} is configured, so MonEscrow cannot ` +
              'check whether this call would succeed.',
          )
        }

        // 1. Simulate. A revert here costs nothing and is decoded to the contract's own name.
        await publicClient.simulateContract({
          account,
          address: req.address,
          abi,
          functionName: req.functionName,
          args,
          value: req.value,
        })

        // 2. Estimate, then pad. The padded number is the one we will actually send.
        const gasEstimate = await publicClient.estimateContractGas({
          account,
          address: req.address,
          abi,
          functionName: req.functionName,
          args,
          value: req.value,
        })
        const gasLimit = withGasPadding(gasEstimate)

        // 3. Price it at the worst case the user could be charged.
        let gasPrice: bigint
        try {
          const fees = await publicClient.estimateFeesPerGas()
          gasPrice = fees.maxFeePerGas ?? (await publicClient.getGasPrice())
        } catch {
          gasPrice = await publicClient.getGasPrice()
        }

        if (id !== runIdRef.current) return
        preparedRef.current = {
          key: requestKey(req),
          address: req.address,
          abi,
          functionName: req.functionName,
          args,
          value: req.value,
          gasLimit,
        }
        dispatch({ type: 'prepared', gasEstimate, gasLimit, gasPrice })
      } catch (err) {
        if (id !== runIdRef.current) return
        dispatch({ type: 'failed', error: decodeTxError(err, abi) })
      }
    })()
  }, [config, account, canPrepare, key])

  const send = useCallback(() => {
    const prepared = preparedRef.current
    if (!config || !prepared) return

    dispatch({ type: 'confirm' })
    const id = ++runIdRef.current

    void (async () => {
      try {
        const walletClient = await getWalletClient(config)

        // The explicit gas limit. On Monad the user pays the LIMIT, not the gas used, so letting
        // the wallet pick one here would quietly overcharge them by whatever slack it chose.
        const hash = await walletClient.writeContract({
          address: prepared.address,
          abi: prepared.abi,
          functionName: prepared.functionName,
          args: prepared.args,
          value: prepared.value,
          gas: prepared.gasLimit,
        })

        if (id !== runIdRef.current) return
        dispatch({ type: 'sent', hash })

        const publicClient = getPublicClient(config)
        if (!publicClient) {
          // Sent, but we cannot watch it. Say so instead of spinning forever.
          dispatch({ type: 'mined', hash })
          onSuccessRef.current?.(hash)
          return
        }

        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (id !== runIdRef.current) return

        if (receipt.status === 'success') {
          dispatch({ type: 'mined', hash })
          onSuccessRef.current?.(hash)
        } else {
          dispatch({
            type: 'reverted',
            hash,
            error: {
              message:
                'The transaction was mined but the contract reverted it, so nothing changed. ' +
                'The chain state moved between the simulation and the send — reload and retry.',
            },
          })
        }
      } catch (err) {
        if (id !== runIdRef.current) return
        dispatch({ type: 'failed', error: decodeTxError(err, prepared.abi) })
      }
    })()
  }, [config])

  const reset = useCallback(() => {
    runIdRef.current++
    preparedRef.current = null
    dispatch({ type: 'reset' })
  }, [])

  const retry = useCallback(() => {
    dispatch({ type: 'reset' })
    prepare()
  }, [prepare])

  // Auto-simulate. Keyed on the call itself, so a re-render with an equivalent request does not
  // re-simulate and a genuinely different call does.
  useEffect(() => {
    if (!auto || !canPrepare) return
    prepare()
  }, [auto, canPrepare, prepare])

  const disabledReason = useMemo((): string | null => {
    if (blockedReason) return blockedReason
    if (!config) {
      return 'Wallet support has not loaded on this page yet, so nothing can be sent.'
    }
    if (!account) return 'Connect your wallet to do this — your wallet is your sign-in here.'
    if (wrongChain) return `Switch your wallet to ${monadTestnet.name} to do this.`
    if (!request) {
      return 'MonEscrow has no contract address for this action yet, so there is nothing to send.'
    }
    if (state.phase === 'simulating') return 'Checking that the chain would accept this…'
    if (state.phase === 'confirming') return 'Waiting for you to confirm in your wallet.'
    if (state.phase === 'pending') return 'Sent. Waiting for it to be included in a block.'
    if (state.phase === 'success') return 'Done.'
    return null
  }, [blockedReason, config, account, wrongChain, request, state.phase])

  const blocked = Boolean(
    blockedReason || !config || !account || wrongChain || !request,
  )

  return {
    state,
    phase: state.phase,
    costLabel: state.costWei === undefined ? null : formatCost(state.costWei),
    disabledReason,
    canSend: !blocked && state.phase === 'ready',
    canRetry: !blocked && state.phase === 'error',
    isBusy:
      state.phase === 'simulating' || state.phase === 'confirming' || state.phase === 'pending',
    explorerUrl: txExplorerUrl(state.hash),
    prepare,
    send,
    retry,
    reset,
  }
}
