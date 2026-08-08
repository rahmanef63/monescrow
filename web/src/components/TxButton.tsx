'use client'

/**
 * The one button that sends a transaction.
 *
 * It renders the whole `useTxFlow` discipline — simulate, estimate, quote, explicit click, send
 * with an explicit gas limit, wait for the receipt — so that no screen in the app has to
 * re-implement any part of it, and so that every write in MonEscrow looks and behaves the same.
 *
 * Two things it refuses to do:
 *
 *   1. **Hide itself when the action is not allowed.** A blocked action renders as a disabled
 *      button carrying the reason from the C1 table. "The challenge window has 2 hours left"
 *      teaches somebody how the escrow works; a missing button teaches them nothing and leaves
 *      them wondering whether the app is broken.
 *   2. **Quote the gas used.** On Monad the wallet is charged the gas *limit*, so the cost line
 *      shows `limit × price` — the real, exact maximum — and not a smaller number that would be
 *      a lie by the time the block lands.
 */

import { useId } from 'react'
import type { Hex } from 'viem'
import { useTxFlow, type TxRequest } from '@/lib/useTxFlow'

export type TxButtonVariant = 'primary' | 'secondary' | 'danger'

export type TxButtonProps = {
  /** What the button does, in the imperative: "Release milestone 2", "Withdraw 0.4 MON". */
  label: string
  /** The call. `null` when there is nothing to send yet — an unset factory, for instance. */
  request?: TxRequest | null
  /**
   * Why this wallet cannot do this, straight from `permits` in `@/lib/chat/permissions`.
   * Setting it disables the button and shows this sentence. It never removes the button.
   */
  blockedReason?: string | null
  /** Why this is being offered at all. Shown under the button, before anything is sent. */
  hint?: string
  /**
   * Shown once the receipt lands. Use it for the thing people get wrong — a released milestone
   * credits an internal balance, it does not move money to a wallet.
   */
  successNote?: string
  /** Replaces "Done" on success. */
  successLabel?: string
  /** Simulate as soon as the button mounts. Default true. */
  auto?: boolean
  variant?: TxButtonVariant
  onSuccess?: (hash: Hex) => void
  className?: string
}

const BASE =
  'flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 py-2.5 ' +
  'text-[0.9375rem] font-semibold leading-tight transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#836EF9] ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[#09090b]'

/**
 * Dark text on the accent, not white.
 *
 * #f4f4f5 on #836EF9 is about 3.4:1 and fails AA for body text; #09090b on the same purple is
 * about 5.3:1 and passes. The Monad purple stays, the label just stops being hard to read.
 */
const VARIANT: Record<TxButtonVariant, string> = {
  primary: 'bg-[#836EF9] text-[#09090b] hover:bg-[#9784fa] active:bg-[#7358f7]',
  secondary:
    'border border-[#27272a] bg-[#18181b] text-[#f4f4f5] hover:border-[#3f3f46] ' +
    'hover:bg-[#1f1f23]',
  danger: 'border border-[#7f1d1d] bg-[#18181b] text-[#fca5a5] hover:bg-[#231416]',
}

const DISABLED = 'border border-[#27272a] bg-[#18181b] text-[#a1a1aa] cursor-not-allowed'
const SUCCESS = 'border border-[#166534] bg-[#18181b] text-[#4ade80]'

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  )
}

export function TxButton({
  label,
  request = null,
  blockedReason = null,
  hint,
  successNote,
  successLabel,
  auto = true,
  variant = 'primary',
  onSuccess,
  className,
}: TxButtonProps) {
  const flow = useTxFlow({ request, blockedReason, auto, onSuccess })
  const statusId = useId()

  const { phase, state, costLabel, disabledReason, canSend, canRetry, isBusy, explorerUrl } = flow

  const clickable = canSend || canRetry
  const error = state.error

  const text =
    phase === 'success'
      ? (successLabel ?? 'Done')
      : phase === 'error'
        ? 'Try again'
        : phase === 'simulating'
          ? 'Checking…'
          : phase === 'confirming'
            ? 'Confirm in your wallet'
            : phase === 'pending'
              ? 'Sending…'
              : label

  const skin =
    phase === 'success' ? SUCCESS : clickable ? VARIANT[variant] : DISABLED

  return (
    <div className={`w-full min-w-0 ${className ?? ''}`}>
      <button
        type="button"
        onClick={canRetry ? flow.retry : flow.send}
        disabled={!clickable}
        aria-busy={isBusy || undefined}
        aria-describedby={statusId}
        className={`${BASE} ${skin}`}
      >
        {isBusy ? <Spinner /> : null}
        <span className="min-w-0 truncate">{text}</span>
      </button>

      {/* One live region for everything the button wants to say. Screen readers hear the cost,
          the block reason and the outcome without the button label churning underneath them. */}
      <div id={statusId} aria-live="polite" className="mt-2 flex flex-col gap-1 text-xs leading-relaxed">
        {phase === 'ready' && costLabel ? (
          <p className="text-[#f4f4f5]">
            <span className="font-semibold tabular-nums">{costLabel}</span>
            <span className="text-[#a1a1aa]">
              {' '}
              — the exact maximum. Monad charges the gas <em className="not-italic font-medium text-[#f4f4f5]">limit</em>,
              not the gas used, so MonEscrow sets the limit itself rather than letting your wallet
              pick a generous one.
            </span>
          </p>
        ) : null}

        {(phase === 'confirming' || phase === 'pending') && costLabel ? (
          <p className="text-[#a1a1aa] tabular-nums">Costing up to {costLabel}.</p>
        ) : null}

        {phase !== 'error' && phase !== 'ready' && disabledReason ? (
          <p className="text-[#a1a1aa]">{disabledReason}</p>
        ) : null}

        {phase === 'error' && error ? (
          <div
            className={
              error.rejected
                ? 'text-[#a1a1aa]'
                : 'rounded-lg border border-[#7f1d1d] bg-[#1a1113] px-3 py-2 text-[#fca5a5]'
            }
          >
            {error.name ? (
              <p className="mb-1 break-words font-mono text-[0.6875rem] tracking-wide text-[#f87171]">
                {error.name}
                {error.args?.length ? `(${error.args.join(', ')})` : ''}
              </p>
            ) : null}
            <p className="break-words">{error.message}</p>
          </div>
        ) : null}

        {phase === 'success' ? (
          <>
            {successNote ? <p className="text-[#f4f4f5]">{successNote}</p> : null}
            {explorerUrl ? (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-h-[44px] items-center self-start rounded text-[#836EF9] underline underline-offset-4 hover:text-[#a394fb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#836EF9] focus-visible:ring-offset-2 focus-visible:ring-offset-[#09090b]"
              >
                View the transaction on MonadVision
              </a>
            ) : null}
          </>
        ) : null}

        {hint && phase !== 'success' && phase !== 'error' ? (
          <p className="text-[#a1a1aa]">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}

export default TxButton
