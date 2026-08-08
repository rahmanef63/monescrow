/**
 * The "there is nothing here" panel — and, more importantly, the panel that says *which* nothing.
 *
 * MonEscrow has three different emptinesses on the job list and they are three different facts:
 *
 *   no wallet connected   we cannot know what you own, because the address is the login
 *   no jobs               we asked the chain for this address and it has none
 *   no factory configured we never asked anything, because there is no contract to ask
 *
 * Collapsing them into one grey "No jobs yet" is how somebody spends an afternoon wondering where
 * their escrow went. So this component takes a `tone` and a `title` and refuses to supply a
 * default for either — the caller has to decide what it is actually saying.
 *
 * It is presentational and has no state, so it stays a server component. `action` is a link
 * rather than a callback for the same reason.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'

export type EmptyStateTone = 'neutral' | 'warning' | 'accent'

export type EmptyStateProps = {
  /** One line, stating the fact. Not "Nothing here" — say which nothing. */
  title: string
  /** The explanation, and what to do about it. Plain words. */
  body: ReactNode
  tone?: EmptyStateTone
  /** The one obvious next step, when there is one. */
  action?: { href: string; label: string }
  /** A quieter second route out. */
  secondaryAction?: { href: string; label: string }
  /** Small print under the buttons — a config key to set, a caveat. */
  footnote?: ReactNode
  /** Anything extra the caller wants inside the panel. */
  children?: ReactNode
  className?: string
}

const TONE: Record<EmptyStateTone, { box: string; dot: string }> = {
  neutral: { box: 'border-zinc-800 bg-zinc-900', dot: 'bg-zinc-500' },
  warning: { box: 'border-warning/40 bg-warning/10', dot: 'bg-warning' },
  accent: { box: 'border-accent/40 bg-accent/10', dot: 'bg-accent' },
}

const PRIMARY =
  'inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-accent px-4 ' +
  'text-sm font-semibold text-zinc-950 transition-colors hover:bg-accent/90 sm:w-auto'

const SECONDARY =
  'inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-zinc-800 ' +
  'bg-zinc-900 px-4 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-700 ' +
  'hover:bg-zinc-800 sm:w-auto'

export function EmptyState({
  title,
  body,
  tone = 'neutral',
  action,
  secondaryAction,
  footnote,
  children,
  className,
}: EmptyStateProps) {
  const skin = TONE[tone]

  return (
    <section
      // Announced, because on this app an empty list is usually the answer to a question the
      // user just asked by connecting a wallet.
      role="status"
      className={`min-w-0 rounded-2xl border ${skin.box} p-4 sm:p-5 ${className ?? ''}`}
    >
      <h2 className="flex items-start gap-2.5 text-base font-semibold text-zinc-100">
        <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${skin.dot}`} />
        <span className="min-w-0 break-words">{title}</span>
      </h2>

      <div className="mt-2 space-y-2 pl-[1.125rem] text-sm leading-relaxed break-words text-zinc-400">
        {body}
      </div>

      {children ? <div className="mt-3 pl-[1.125rem]">{children}</div> : null}

      {action || secondaryAction ? (
        <div className="mt-4 flex flex-col gap-2 pl-[1.125rem] sm:flex-row sm:flex-wrap">
          {action ? (
            <Link href={action.href} className={PRIMARY}>
              {action.label}
            </Link>
          ) : null}
          {secondaryAction ? (
            <Link href={secondaryAction.href} className={SECONDARY}>
              {secondaryAction.label}
            </Link>
          ) : null}
        </div>
      ) : null}

      {footnote ? (
        <p className="mt-3 pl-[1.125rem] text-xs leading-relaxed break-words text-zinc-400">
          {footnote}
        </p>
      ) : null}
    </section>
  )
}

export default EmptyState
