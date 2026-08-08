'use client'

/**
 * The challenge-window clock.
 *
 * The whole mechanism of MonEscrow is that **the wait ending is a positive event**. A verifier
 * proposes that a milestone passed; that opens a window in which the client may object; if the
 * client stays silent until the window runs out, anyone at all — the freelancer, a bystander,
 * you — can push the release through. Nobody has to be persuaded and nobody has to be chased.
 *
 * So this component never sits at `00:00:00`. Zero is not the end of a countdown here, it is the
 * moment the escrow changes hands: the digits are replaced by a sentence saying that anyone can
 * release the milestone now. A timer resting on zeroes would read as "expired", which is the
 * opposite of what happened.
 *
 * ## Why the clock starts null
 *
 * `Date.now()` on the server and `Date.now()` in the browser are different numbers, so rendering
 * a remaining time during SSR guarantees a hydration mismatch. Until the first effect runs,
 * `useNow` returns `null` and this renders the *absolute* end time instead — a pure function of
 * the `releasableAt` prop, identical on both sides — then swaps to live digits once mounted.
 */

import { useEffect, useRef, useState } from 'react'

/* ------------------------------------------------------------------ *
 * Pure helpers — exported so a card can label a window without mounting a clock
 * ------------------------------------------------------------------ */

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * `1d 02:03:04` / `02:03:04`. Monospace-friendly and the same width from one second to the next,
 * so the layout does not shiver once a second.
 */
export function formatRemaining(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
  return days > 0 ? `${days}d ${clock}` : clock
}

/**
 * The same duration in words, for screen readers.
 *
 * A live region that re-reads eight digits every second is unusable, so the digits are hidden
 * from assistive technology and this coarse phrase — which only changes every minute or so —
 * carries the meaning instead.
 */
export function coarseRemaining(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total <= 0) return 'no time left'
  if (total < 60) return 'less than a minute left'
  if (total < 3600) {
    const m = Math.round(total / 60)
    return `about ${m} minute${m === 1 ? '' : 's'} left`
  }
  if (total < 86400) {
    const h = Math.round(total / 3600)
    return `about ${h} hour${h === 1 ? '' : 's'} left`
  }
  const d = Math.round(total / 86400)
  return `about ${d} day${d === 1 ? '' : 's'} left`
}

/**
 * `2026-08-08 14:03 UTC`.
 *
 * Deliberately UTC and deliberately hand-formatted: `toLocaleString` reads the runtime's locale
 * and time zone, which differ between the server render and the browser, and the mismatch would
 * show up as a hydration error on the one string that is supposed to be the stable fallback.
 */
export function formatAbsolute(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  if (Number.isNaN(d.getTime())) return 'an unknown time'
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  )
}

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

/**
 * Unix seconds, or `null` before the component has mounted in a browser.
 *
 * Every consumer must handle the `null`: it is what keeps server HTML and the first client render
 * identical. It also happens to be honest — before hydration this page genuinely does not know
 * what time it is where you are.
 */
export function useNow(tickMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    const read = () => setNow(Math.floor(Date.now() / 1000))
    read()
    const id = setInterval(read, tickMs)
    // A backgrounded tab throttles timers, so a phone returning from the lock screen would
    // otherwise show a stale window for a moment.
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) read()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
    }
    return () => {
      clearInterval(id)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }, [tickMs])

  return now
}

export type CountdownProps = {
  /**
   * Unix seconds at which the challenge window closes. `0` means the milestone is not Attested,
   * so there is no window and this renders nothing.
   */
  releasableAt: number
  /** Headline while the window is still running. */
  runningLabel?: string
  /** Headline once it has run out. Says something *happened*, never "expired". */
  elapsedLabel?: string
  /** Sentence under the elapsed headline. */
  elapsedDetail?: string
  /** Sentence under the running digits. */
  runningDetail?: string
  /** Verb for the footnote before the boundary — "Closes", "Ends". */
  boundaryVerb?: string
  /** Verb for the footnote after it — "The window closed", "The deadline passed". */
  boundaryPastPhrase?: string
  /**
   * How the elapsed state should read. A challenge window running out unlocks the money, so it is
   * green; a job deadline running out is merely a fact, so it is not. Colour is an assertion and
   * this component should not make the wrong one.
   */
  elapsedTone?: 'success' | 'neutral'
  /** Fired once, on the tick that crosses zero, so a parent can refetch chain state. */
  onElapsed?: () => void
  className?: string
}

const SHELL = 'rounded-xl border px-3 py-2.5 text-sm leading-relaxed'

export function Countdown({
  releasableAt,
  runningLabel = 'Challenge window',
  elapsedLabel = 'Anyone can release this now',
  elapsedDetail = 'The client did not object before the window closed, so the milestone is ' +
    'unlocked for everybody — the freelancer, a bystander, you. Nobody has to be asked.',
  runningDetail = 'While this runs the client can dispute, and nobody can release. When it ' +
    'reaches zero, anyone can.',
  boundaryVerb = 'Closes',
  boundaryPastPhrase = 'The window closed',
  elapsedTone = 'success',
  onElapsed,
  className,
}: CountdownProps) {
  const now = useNow()
  const firedRef = useRef(false)

  const remaining = now === null ? null : releasableAt - now
  const elapsed = remaining !== null && remaining <= 0

  useEffect(() => {
    if (!elapsed || firedRef.current) return
    firedRef.current = true
    onElapsed?.()
  }, [elapsed, onElapsed])

  // No window to show. An unattested milestone has no clock, and inventing one would suggest
  // the money is on a timer when it is actually waiting on a person.
  if (!releasableAt || releasableAt <= 0) return null

  const wrap = (tone: string, children: React.ReactNode) => (
    <div className={`${SHELL} ${tone} ${className ?? ''}`}>{children}</div>
  )

  // ------------------------------------------------------- pre-hydration: absolute, not live
  if (remaining === null) {
    return wrap(
      'border-zinc-800 bg-zinc-900 text-zinc-400',
      <>
        <p className="text-xs font-semibold tracking-wide text-zinc-300 uppercase">
          {runningLabel}
        </p>
        <p className="mt-1 text-zinc-100">
          {boundaryVerb} <span className="font-medium">{formatAbsolute(releasableAt)}</span>
        </p>
        <p className="mt-1 text-xs text-zinc-400">{runningDetail}</p>
      </>,
    )
  }

  // ------------------------------------------------------------------------- the wait is over
  if (elapsed) {
    const good = elapsedTone === 'success'
    return (
      <div
        className={`${SHELL} ${
          good ? 'border-success/40 bg-success/10' : 'border-zinc-700 bg-zinc-900'
        } ${className ?? ''}`}
        role="status"
        aria-live="polite"
      >
        <p
          className={`flex items-center gap-2 font-semibold ${good ? 'text-success' : 'text-zinc-100'}`}
        >
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${good ? 'bg-success' : 'bg-zinc-500'}`}
          />
          {elapsedLabel}
        </p>
        <p className="mt-1 text-zinc-300">{elapsedDetail}</p>
        <p className="mt-1 text-xs text-zinc-400">
          {boundaryPastPhrase} {formatAbsolute(releasableAt)}.
        </p>
      </div>
    )
  }

  // ---------------------------------------------------------------------------- still running
  return (
    <div className={`${SHELL} border-warning/40 bg-warning/10 ${className ?? ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-semibold tracking-wide text-warning uppercase">
          {runningLabel}
        </p>
        {/* `aria-live="off"`: eight digits changing every second is noise, not information.
            The coarse phrase beside it is what a screen reader actually reads. */}
        <p role="timer" aria-live="off" className="min-w-0">
          <span aria-hidden="true" className="font-mono text-lg tabular-nums text-zinc-100">
            {formatRemaining(remaining)}
          </span>
          <span className="sr-only">{coarseRemaining(remaining)} in the challenge window</span>
        </p>
      </div>
      <p className="mt-1 text-zinc-300">{runningDetail}</p>
      <p className="mt-1 text-xs text-zinc-400">
        {boundaryVerb} {formatAbsolute(releasableAt)}.
      </p>
    </div>
  )
}

export default Countdown
