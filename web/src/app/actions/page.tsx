'use client'

/**
 * `/actions` — everything currently awaiting me.
 *
 * The screen that makes the app feel alive: instead of opening six jobs to find the one that
 * needs a tap, every job's open ends are collected in one list, grouped by how urgent they are.
 *
 * ## Every row comes out of the C1 table
 *
 * Nothing here decides what is allowed. `awaitingFor` runs `availableActions` — the C1 table as
 * code — over each job and each milestone, and this page renders the verdicts. So the list cannot
 * drift from what the chain would accept, and a row can never offer a call that would revert.
 *
 * ## Blocked rows are shown, disabled, with the reason
 *
 * The "on a clock" group exists for exactly this. A greyed *Release milestone 2* that says the
 * challenge window has 1h 54m left teaches somebody how MonEscrow works. Hiding the button until
 * the window closes teaches them nothing and reads as a bug.
 *
 * ## What it is careful never to imply
 *
 *   - the verifier **proposes**; a submitted milestone waiting on it is not waiting on an
 *     authority, and the client can approve without it;
 *   - a released milestone credits a balance **inside the escrow**. Withdrawing is a separate
 *     transaction, and the "money to collect" group says so in as many words.
 */

import Link from 'next/link'
import { useMemo } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { TxButton } from '@/components/TxButton'
import {
  AWAITING_GROUPS,
  Countdown,
  actionLabel,
  actionRationale,
  actionSuccessNote,
  awaitingFor,
  jobHref,
  useMyJobs,
  type Awaiting,
  type AwaitingGroup,
  type JobsSource,
} from '@/components/JobCard'
import { formatMon, shortAddress } from '@/lib/chain'
import type { TxRequest } from '@/lib/useTxFlow'

/* ------------------------------------------------------------------ *
 * Group presentation
 * ------------------------------------------------------------------ */

type GroupSkin = { title: string; blurb: string; rule: string; pill: string }

const GROUP: Record<AwaitingGroup, GroupSkin> = {
  frozen: {
    title: 'Frozen for the arbiter',
    blurb:
      'The client objected, so this milestone stopped instead of releasing. Its funds do not move again until the arbiter sends them one way or the other.',
    rule: 'border-danger/40',
    pill: 'bg-danger/15 text-danger',
  },
  you: {
    title: 'Waiting on you',
    blurb:
      'The chain would accept each of these from your address right now. Every one shows its exact maximum cost before it sends anything.',
    rule: 'border-accent/40',
    pill: 'bg-accent/20 text-accent-soft',
  },
  anyone: {
    title: 'Anyone can finish these',
    blurb:
      'The challenge window ran out with nobody objecting, so the payment no longer needs the client to act. Whichever wallet sends it pays the gas — that is the point of the design.',
    rule: 'border-accent/40',
    pill: 'bg-accent/20 text-accent-soft',
  },
  money: {
    title: 'Money to collect',
    blurb:
      'A released or refunded milestone credits a balance inside its escrow. It is not in anyone’s wallet until a withdraw moves it.',
    rule: 'border-success/40',
    pill: 'bg-success/15 text-success',
  },
  clock: {
    title: 'On a clock',
    blurb:
      'Nothing to do yet. These are shown disabled with the reason the chain would give, and a countdown to the moment that reason stops being true.',
    rule: 'border-warning/40',
    pill: 'bg-warning/15 text-warning',
  },
  verifier: {
    title: 'With the verifier',
    blurb:
      'The off-chain verifier reads the evidence and proposes a result. It never decides one, it cannot be forced, and the client can approve the milestone without waiting for it.',
    rule: 'border-zinc-700',
    pill: 'bg-zinc-800 text-zinc-300',
  },
}

/* ------------------------------------------------------------------ *
 * Which rows are one click, and which need the job page
 * ------------------------------------------------------------------ */

/**
 * The call behind a row, or `null` when there is nothing safe to send.
 *
 * `null` for sample data — a sample escrow has no code at that address, so simulating against it
 * would produce a confusing RPC error instead of an honest "this is not real". `null` too for
 * the three actions that need more than a click: `submit` carries an evidence hash, `attest`
 * carries a verifier signature nobody on this screen holds, and `resolveDispute` carries a
 * decision the arbiter has to actually make. Those rows link to the job instead.
 */
function requestFor(a: Awaiting, source: JobsSource): TxRequest | null {
  if (source !== 'chain' || !a.permission.allowed) return null
  const i = a.milestone === null ? null : BigInt(a.milestone)
  switch (a.action) {
    case 'accept':
      return { address: a.job.escrow, functionName: 'accept' }
    case 'cancel':
      return { address: a.job.escrow, functionName: 'cancel' }
    case 'withdraw':
      return { address: a.job.escrow, functionName: 'withdraw' }
    case 'approve':
      return i === null ? null : { address: a.job.escrow, functionName: 'approve', args: [i] }
    case 'release':
      return i === null ? null : { address: a.job.escrow, functionName: 'release', args: [i] }
    case 'reclaim':
      return i === null ? null : { address: a.job.escrow, functionName: 'reclaim', args: [i] }
    default:
      return null
  }
}

/** Rows that are a decision or a document, not a click. They route to the job page. */
const NEEDS_THE_JOB_PAGE: readonly Awaiting['action'][] = ['submit', 'resolveDispute', 'attest']

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function ActionsPage() {
  const state = useMyJobs()
  const { now, source, status, renderViewer } = state

  const rows = useMemo(
    () => state.jobs.flatMap((job) => awaitingFor(job, renderViewer, now)),
    [state.jobs, renderViewer, now],
  )

  const grouped = useMemo(
    () =>
      AWAITING_GROUPS.map((group) => ({
        group,
        rows: rows.filter((r) => r.group === group),
      })).filter((g) => g.rows.length > 0),
    [rows],
  )

  const actionable = rows.filter(
    (r) => r.permission.allowed && (r.group === 'you' || r.group === 'anyone' || r.group === 'money' || r.group === 'frozen'),
  ).length

  return (
    <div className="min-w-0">
      <header className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Actions</h1>
        <p className="mt-1 text-sm leading-relaxed text-zinc-400">
          Everything currently awaiting{' '}
          <span className="font-mono text-zinc-300">{shortAddress(renderViewer)}</span>, across
          every job. The list is generated from the same permission table the contract enforces,
          so nothing here can offer a call the chain would reject.
        </p>
        {status !== 'booting' && status !== 'loading' ? (
          <p className="mt-2 text-sm text-zinc-100">
            <span className="font-semibold tabular-nums">{actionable}</span>{' '}
            {actionable === 1 ? 'thing' : 'things'} you can do right now
            {rows.length > actionable ? (
              <span className="text-zinc-400">
                {' '}
                · {rows.length - actionable} waiting on a clock or on the verifier
              </span>
            ) : null}
          </p>
        ) : null}
      </header>

      {source === 'sample' && status !== 'booting' ? (
        <EmptyState
          className="mt-4"
          tone={status === 'no-factory' ? 'warning' : 'accent'}
          title={
            status === 'no-factory'
              ? 'These are sample actions — no escrow factory is configured'
              : 'These are sample actions — no wallet is connected'
          }
          body={
            status === 'no-factory' ? (
              <p>
                Nothing has been read from Monad, so this is not a claim that you have these jobs.
                Every button below is disabled: there is no contract at these addresses to send
                anything to.
              </p>
            ) : (
              <p>
                Your address is the sign-in, and without one there is nothing to look up. The rows
                below are a walkthrough of what this screen shows once you connect, and every
                button on them is disabled.
              </p>
            )
          }
          action={status === 'no-factory' ? undefined : { href: '/wallet', label: 'Connect a wallet' }}
        />
      ) : null}

      {status === 'booting' || status === 'loading' ? (
        <Skeleton />
      ) : status === 'error' ? (
        <EmptyState
          className="mt-4"
          tone="warning"
          title="Monad testnet did not answer"
          body={
            <>
              <p>
                Your jobs could not be read, so this list is unknown rather than empty. Do not
                take it as &ldquo;nothing is waiting on you&rdquo;.
              </p>
              <p className="font-mono text-xs break-words text-zinc-400">{state.error}</p>
            </>
          }
        >
          <button
            type="button"
            onClick={state.refetch}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-medium text-zinc-100 hover:bg-zinc-800"
          >
            Try the read again
          </button>
        </EmptyState>
      ) : grouped.length === 0 ? (
        <EmptyState
          className="mt-4"
          tone="neutral"
          title={`Nothing is awaiting ${shortAddress(renderViewer)}`}
          body={
            state.jobs.length === 0 ? (
              <p>
                This address is not party to any escrow yet, so there is nothing that could be
                waiting on it.
              </p>
            ) : (
              <p>
                All {state.jobs.length} of your jobs are settled, in progress, or waiting on
                somebody else. Nothing needs a transaction from you.
              </p>
            )
          }
          action={{ href: '/', label: 'Back to my jobs' }}
        />
      ) : (
        <div className="mt-5 flex flex-col gap-6">
          {grouped.map(({ group, rows: groupRows }) => (
            <Group key={group} group={group} rows={groupRows} now={now} source={source} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function Group({
  group,
  rows,
  now,
  source,
}: {
  group: AwaitingGroup
  rows: readonly Awaiting[]
  now: number
  source: JobsSource
}) {
  const skin = GROUP[group]
  return (
    <section className={`min-w-0 border-l-2 pl-3 sm:pl-4 ${skin.rule}`}>
      <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-zinc-100">
        {skin.title}
        <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums ${skin.pill}`}>
          {rows.length}
        </span>
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{skin.blurb}</p>

      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((row) => (
          <Row key={row.key} row={row} now={now} source={source} />
        ))}
      </ul>
    </section>
  )
}

function Row({ row, now, source }: { row: Awaiting; now: number; source: JobsSource }) {
  const request = requestFor(row, source)
  const needsJobPage = NEEDS_THE_JOB_PAGE.includes(row.action)

  const blockedReason = !row.permission.allowed
    ? row.permission.reason
    : source !== 'chain'
      ? 'This is sample data. There is no contract at this address, so MonEscrow will not pretend it can send anything.'
      : null

  return (
    <li className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      {/* -------------------------------------------------------------- which job */}
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Link
          href={jobHref(row.job)}
          className="min-w-0 text-xs font-medium break-words text-zinc-400 underline-offset-4 hover:text-zinc-100 hover:underline"
        >
          {row.job.untrusted.title || 'Untitled job'}
        </Link>
        <span className="shrink-0 font-mono text-[0.6875rem] text-zinc-400">
          {shortAddress(row.job.escrow)}
        </span>
      </div>

      {/* -------------------------------------------------------------- what and why */}
      <h3 className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[0.9375rem] font-semibold break-words text-zinc-100">
        {actionLabel(row)}
        {row.waitingUntil !== null && now > 0 ? (
          <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
            <Countdown to={row.waitingUntil} now={now} /> left
          </span>
        ) : null}
      </h3>
      <p className="mt-1 text-xs leading-relaxed break-words text-zinc-400">
        {actionRationale(row)}
      </p>

      {/* -------------------------------------------------------------- the control */}
      <div className="mt-3 min-w-0">
        {row.action === 'attest' ? (
          <Link
            href={jobHref(row.job)}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950 px-4 text-sm font-medium text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
          >
            See the submission
          </Link>
        ) : needsJobPage ? (
          <Link
            href={jobHref(row.job)}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-zinc-950 hover:bg-accent/90"
          >
            {row.action === 'submit' ? 'Open the job to submit' : 'Open the job to resolve it'}
          </Link>
        ) : (
          <TxButton
            label={actionLabel(row)}
            request={request}
            blockedReason={blockedReason}
            successNote={actionSuccessNote(row)}
            variant={row.group === 'money' ? 'primary' : row.group === 'you' ? 'primary' : 'secondary'}
          />
        )}
      </div>

      {/* -------------------------------------------------------------- the client's other option */}
      {row.group === 'clock' && row.role === 'client' ? (
        <p className="mt-2 text-xs leading-relaxed text-zinc-400">
          You do not have to wait. Until the window closes you can approve milestone{' '}
          {(row.milestone ?? 0) + 1} to pay it out now, or dispute it to freeze it for the arbiter
          — both live on{' '}
          <Link href={jobHref(row.job)} className="text-accent-soft underline underline-offset-4">
            the job page
          </Link>
          .
        </p>
      ) : null}

      {row.action === 'withdraw' ? (
        <p className="mt-2 text-xs leading-relaxed text-zinc-400">
          {formatMon(row.job.owed)} MON is credited to you inside this escrow. This is the
          transaction that actually moves it into your wallet.
        </p>
      ) : null}
    </li>
  )
}

function Skeleton() {
  return (
    <div className="mt-5 flex flex-col gap-3" aria-busy="true">
      <p className="sr-only" role="status">
        Working out what is waiting on you.
      </p>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-40 animate-pulse rounded-2xl border border-zinc-800 bg-zinc-900"
        />
      ))}
    </div>
  )
}
